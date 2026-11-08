# dsh-memory-trigger

> 上下文被压缩后，模型会"忘记"较早的对话；但会话事件日志一直都在。
> 这个插件在你说出"你忘了 / 我说过 / 那个 / 之前说的"这类话时，**自己**去翻日志，
> 把带时间戳的原文片段塞回模型眼前——不需要模型想起来，也不需要它主动调工具。

## 它解决什么

DSH 的上下文压缩只影响模型「眼前」的窗口，不删除会话事件日志（`~/.dsh/sessions/` 下的 zstd JSONL）。
所以"忘记"是可见性问题，不是存储问题。本插件把可见性补回来。

## 工作方式

```
用户消息
  → [agent/inbox/claimed] 纯程序判定
      ① 回忆关键词：「你忘了 / 我说过 / 之前提过 / 记得吗 / 你答应过 …」
      ② 指代：「那个 / 那次 / 上次 / 这事 / 前几天 …」
      ③ 实体缺失：消息里的英文词/引号词/路径在当前上下文没有，但历史里有
  → 本地索引检索（BM25 + 中文 bigram，毫秒级，无网络、无 embedding）
  → [agent/pre-step] 追加一条 user 消息，内容是带时间戳的回忆片段
  → 模型拿着原文回答，不再"没印象"
```

注入示例：

```text
[记忆检索] 用户可能在引用过去的对话（触发：keyword/我说过）。从会话历史检索到 2 条相关片段：
1. 2026-11-03 22:30（5 天前）· 我说过 · seq 10650
   「Ghidra 配好了……Ghidra 12.1.4 … REA 只认 12.1.x…」
2. 2026-11-03 22:32（5 天前）· 我说过 · seq 10666
   「REA 的 MCP 配置已就位，下次重启 DSH 后 mcp__rea__* 工具就能用…」
请结合上述原文回答；需要更多细节时可用 session_event_read 读对应 seq，不要笼统说"记不清"。
```

## 注入消息的来源（v4 格式硬要求）

会话格式 v3 起（本机已是 v4）**只认「生产者自己的 kind」**：注入消息的 `source` 不能再用
`{ kind: 'plugin', plugin: 'xxx' }` 这种 v3 包装，否则宿主会在写入 / 校验时直接抛

```
format v4 message requires a producer-owned source kind
```

整轮运行失败（用户侧看到「本轮运行失败 …」）。所以这里固定写自家 kind，与 dsh-heart
（`kind: 'dsh-heart'`）保持一致：

```js
const message = createUserMessage({
  content: [{ type: 'text', text: item.text }],
  source: { kind: 'memory-trigger' },
});
```

注意：`node_modules/dsh-memory-trigger` 是 `file:` 依赖的拷贝，改完 `plugins/` 里的源码要重新
`pnpm add file:./plugins/dsh-memory-trigger`（或直接改拷贝）并重启 DSH 才生效。

## 安装

从 npm 安装（推荐）：

```bash
dsh plugin --profile <你的 profile> add dsh-memory-trigger
# 然后把 "dsh-memory-trigger" 加进该 profile package.json 的 dsh.profile.bundles，并重启 DSH
```

从源码安装：

```bash
cd ~/.dsh/profiles/<你的 profile>
pnpm add file:/path/to/dsh-memory-trigger
# package.json 的 dsh.profile.bundles 里要有 "dsh-memory-trigger"
```

改完重启 DSH 生效（宿主插件在启动时加载）。

### 首次回填历史

实时消息会自动入库；但**插件安装前**的历史需要回填一次：

```bash
node plugins/dsh-memory-trigger/lib/backfill.mjs
```

需要支持 zstd 的 Node（>= 22.15 或 24 系列）。DSH 自带运行时若不含 zstd，用系统 Node 24 执行：

```bash
node plugins/dsh-memory-trigger/lib/backfill.mjs
```

回填产物在 `~/.dsh/memory-trigger/events/<sessionId>.jsonl`，一行一条：

```json
{"session":"…","seq":10650,"ts":1793706600000,"role":"assistant","text":"…"}
```

## 配置（`cordis.patch.yml` 的 `dsh-memory-trigger` 条目）

```yaml
- id: dsh-memory-trigger
  name: 'dsh-memory-trigger'
  config:
    enabled: true
    keywords: ['你忘', '我说过', '之前提过', '还记得', '你答应过']
    anaphora: ['那个', '那次', '上次', '这事', '前几天']
    timeAnaphora:  # 时间指代正则；留空 = 用内置表
      - '\\d{1,3}\\s*天前'
      - '昨天'
      - '\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]'
      - '星期[一二三四五六日天1-7]'
      - '(?:下午|晚上)?\\s*\\d{1,2}\\s*[点时]'
    entityTrigger: true
    includeToolResults: true
    topK: 3             # 每条消息最多注入几条片段
    maxChars: 1200      # 注入总字数上限
    minScore: 1.2       # BM25 阈值，低于此不注入
    scope: all          # all = 全部历史会话（默认）；session = 只搜当前会话
    groupByProject: true  # 跨项目时按项目分组标注
    logTriggers: true
```

所有字段都有默认值，不写也能跑。改了配置重启 DSH 生效。

## 拦截关键词（默认值）

**回忆关键词**（命中必搜）：
`你忘` `忘了` `我说过` `你说过` `之前说过` `之前提过` `提过` `记得吗` `还记得` `你答应过` `上次说的` `上次那个` `之前那个` `前面说的` `刚才说的` `回忆一下`

**指代词**（命中后搜索，分数够才注入）：
`那个` `那次` `这事` `这个事` `那件事` `上次` `之前` `前几天` `那天` `当时` `你说的` `我说过的` `接着说` `继续那个`

**时间指代**（`timeAnaphora`，命中后解析成时间窗）：
`3天前` `三天前` `昨天` `前天` `大前天` `今天` `11月3日` `星期三` `礼拜天` `3点` `下午3点半` `上周` `上个月` `最近7天` `今年` `去年` `本月` …

解析结果会作为检索的 `since/until` 过滤条件，只搜那个时间窗内的事件；注入头部会标注「时间窗：2026-11-03」。
解析失败或窗口内无结果时，会自动放开时间窗重搜一次，不会因为时间误差而完全没结果。

| 说法 | 解析成 |
|---|---|
| 3 天前 / 三天前 | 那一天 00:00–24:00 |
| 昨天 / 前天 / 大前天 | 对应自然日 |
| 11 月 3 日 | 那一天（未来日期自动算去年） |
| 星期三 / 礼拜天 / 周5 | 最近一个该星期几 |
| 3 点 / 下午 3 点半 | 对应时刻 ±1 小时 |
| 上周 / 上个月 / 去年 / 今年 / 本月 | 对应区间 |
| 最近 N 天 | N 天前至今 |

**实体缺失**（`entityTrigger`）：消息里的英文词、引号词、文件路径，在当前上下文没有但历史索引里有时触发。

## 索引内容

| 事件类型 | 是否入索引 | 注入时标注 |
|---|---|---|
| `user/message`（你说的） | ✅ | 你说过 |
| `assistant/message`（我说的） | ✅ | 我说过 |
| `tool/result`（工具输出） | ✅ 默认开启，只留前 4000 字 | 工具结果 |

工具输出很长，默认截断到 4000 字参与索引；不想要可在配置里 `includeToolResults: false` 关掉。

## 数据文件

| 路径 | 内容 |
|---|---|
| `~/.dsh/memory-trigger/events/*.jsonl` | 明文事件索引（回填 + 实时追加） |
| `~/.dsh/memory-trigger/trigger.log.jsonl` | 每次触发的记录（时间、触发词、命中条数） |

## 自测

```bash
node plugins/dsh-memory-trigger/lib/selftest.mjs
```

会在真实历史上跑几条查询，打印命中片段和耗时（当前索引约 2300 条事件，查询 1–10ms）。

## 已知限制

- 触发是**字面匹配**：完全绕开关键词的暗示可能漏；开了 `entityTrigger` 后覆盖大部分情况
- 注入是"给模型看原文"，不保证它一定引用；提示语里已要求"不要笼统说记不清"
- 会话日志格式（`session.v4`）随 DSH 升级可能变；若 `history.` 读不到，插件会 log warn 并退化为"只捕获实时消息"
- 注入片段占上下文预算，默认上限 1200 字；长会话可适当调小 `topK`
- 跨会话检索（`scope: all`）默认开启：结果可能来自别的项目，注入时会按项目分组标注；只想看当前会话就设 `scope: session`

## 日志

`trigger.log.jsonl` 同时记录命中和**未命中**（`hit: 0, miss: true`），可用来调词典和阈值：

```json
{"at":"2026-11-08T06:30:00Z","kind":"keyword","trigger":"我说过","query":"…","hits":3}
{"at":"2026-11-08T06:31:00Z","kind":"anaphora","trigger":"那个","query":"…","hits":0,"miss":true}
```

## 开发注意（血泪教训）

1. **改插件前先读当前 DSH 的最新开发文档 / 源码**（DSH 安装目录下的 `resources/app.asar/dsh/`），不要凭旧版本的记忆写。
2. **会话格式以宿主的 `SESSION_FORMAT_VERSION` 为准**。v4 起注入消息的 `source.kind` 必须是"生产者自己的 kind"；
   旧写法 `{ kind: 'plugin', plugin: 'xxx' }` 会被宿主拒绝并**让整轮运行失败**。
   本插件已用 `dshSession.SESSION_FORMAT_VERSION` 自动选择写法。
3. **插件必须 fail-soft**：注入/判定逻辑全部包在 try/catch 里，出错只记 warn、跳过本次，绝不能让用户的当轮对话失败。
4. **必须在真实宿主里验证**：离线 smoke（`lib/smoke.mjs`）只验证逻辑，不能证明宿主接受这条消息；
   至少要重启一次 DSH，发一条会触发注入的消息，确认能正常往返。

## 后续可做

- 语义召回（embedding）作为 BM25 的补充
- 词典热更新（改配置不用重启）
- 未命中统计与自动调词（按 `trigger.log.jsonl` 分析）
