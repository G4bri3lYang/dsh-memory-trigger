/**
 * dsh-memory-trigger — 记忆触发插件
 *
 * 目的：上下文压缩后，较早的对话会从模型「眼前」消失，但会话事件日志一直都在。
 * 当用户消息看起来在引用旧记忆时，本插件自己检索日志，把带时间戳的原文片段
 * 注入本轮上下文，模型直接拿着原文回答，不必再"没印象"。
 *
 * 触发（纯程序判断，不依赖模型）：
 *   1. 回忆关键词：「你忘了 / 我说过 / 之前提过 / 还记得吗 / 你答应过 …」
 *   2. 指代：「那个 / 那次 / 上次 / 这事 / 前几天 …」
 *   3. 实体缺失：消息里的专有名词 / 英文词 / 引号词 / 路径，在当前上下文里没出现，
 *      但历史索引里搜得到 → 判定为引用旧记忆
 *
 * 注入：agent/pre-step 时追加一条 user 角色消息（带时间戳与 seq），
 * 每轮最多一次、最多 topK 条、总字数受 maxChars 限制。
 */
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as dshSession from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import { createIndex } from './search.js';

export const name = 'memory-trigger';

/** 宿主会话格式版本：v4 起注入消息只接受「生产者自己的 kind」。 */
const SESSION_FORMAT = typeof dshSession.SESSION_FORMAT_VERSION === 'number' ? dshSession.SESSION_FORMAT_VERSION : 0;

const DEFAULT_KEYWORDS = [
  '你忘', '忘了', '我说过', '你说过', '之前说过', '之前提过', '提过', '记得吗', '还记得',
  '你答应过', '上次说的', '上次那个', '之前那个', '前面说的', '刚才说的', '回忆一下',
];
const DEFAULT_ANAPHORA = [
  '那个', '那次', '这事', '这个事', '那件事', '上次', '之前', '前几天', '那天', '当时',
  '你说的', '我说过的', '接着说', '继续那个',
];
/**
 * 时间指代（正则）：命中后解析成时间窗，只检索该窗口内的事件。
 * 例：3天前 / 11月3日 / 星期三 / 昨天 / 上周 / 上个月 / 3点 / 下午3点
 */
const DEFAULT_TIME_PATTERNS = [
  '大前天', '前天', '昨天', '昨日', '今天', '今日',
  '\\d{1,3}\\s*天前', '[一二两三四五六七八九十]{1,3}\\s*天前',
  '\\d{1,2}\\s*周前', '[一二两三四五六七八九十]{1,2}\\s*周前',
  '\\d{1,3}\\s*个月前', '[一二两三四五六七八九十]{1,3}\\s*个月前',
  '最近\\s*\\d{1,2}\\s*天', '前\\s*\\d{1,2}\\s*天',
  '上周', '上星期', '上个?月', '去年', '今年', '本月', '这个月',
  '星期[一二三四五六日天1-7]', '礼拜[一二三四五六日天1-7]', '周[一二三四五六日天1-7]',
  '\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]',
  '(?:上午|下午|晚上|早上|中午)?\\s*\\d{1,2}\\s*[点时](?:\\s*半|\\s*\\d{1,2}\\s*分)?',
];
const NOISE_PREFIXES = ['Current runtime context', '[dsh-heart]', '眼前的对话快放不下'];

function isNoise(text) {
  const t = text.trimStart();
  return NOISE_PREFIXES.some((p) => t.startsWith(p));
}

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关。'),
  keywords: z.array(z.string()).default(DEFAULT_KEYWORDS).description('回忆关键词（子串匹配）。'),
  anaphora: z.array(z.string()).default(DEFAULT_ANAPHORA).description('指代词（子串匹配）。'),
  timeAnaphora: z.array(z.string()).default(DEFAULT_TIME_PATTERNS).description('时间指代正则：命中后解析成时间窗，只搜该窗口内的事件。'),
  entityTrigger: z.boolean().default(true).description('实体缺失触发：消息里的专有名词/英文词在历史里有、当前上下文没有时触发。'),
  includeToolResults: z.boolean().default(true).description('把 tool/result 也纳入索引（只留前 4000 字）。'),
  topK: z.number().step(1).min(1).max(8).default(3).description('每次注入的最大片段数。'),
  maxChars: z.number().step(1).min(200).max(4000).default(1200).description('注入内容总字数上限。'),
  minScore: z.number().min(0).default(1.2).description('BM25 最低分，低于此不注入。'),
  scope: z.union([z.const('session'), z.const('all')]).default('all').description('检索范围：all = 全部历史会话（默认）；session = 只搜当前会话。'),
  groupByProject: z.boolean().default(true).description('跨项目检索时按项目分组展示。'),
  storeDir: z.string().default('').description('索引目录；留空 = <DSH_HOME>/memory-trigger。'),
  logTriggers: z.boolean().default(true).description('把每次触发写入 trigger.log.jsonl。'),
});

function toText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) if (p && p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
  return parts.join('\n');
}

function extractEntities(text) {
  const out = new Set();
  for (const m of text.matchAll(/[「"“]([^「」"”]{2,40})[」"”]/g)) out.add(m[1].trim());
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.\-]{2,}/g)) out.add(m[0]);
  for (const m of text.matchAll(/[A-Za-z]:\\[^\s，。；]+/g)) out.add(m[0]);
  return [...out].filter((s) => s.length >= 2);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.floor((Date.now() - ts) / 86400000);
  const rel = days <= 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`;
  return `${date} ${time}（${rel}）`;
}

const ROLE_LABEL = { user: '你说过', assistant: '我说过', tool: '工具结果' };

/** 会话所属项目（取 cwd 的最后一段）。 */
function projectOf(session) {
  const cwd = session?.header?.cwd ?? session?.cwd ?? '';
  if (!cwd) return '未知项目';
  return basename(String(cwd)) || String(cwd);
}

/**
 * 注入消息的来源标记。
 *
 * 会话格式 v3 起（本机是 v4）只认「生产者自己的 kind」：消息 source 必须是插件自己的名字，
 * 旧的 { kind: 'plugin', plugin } 包装会被直接拒绝
 * （format v4 message requires a producer-owned source kind），整轮运行失败。
 * 所以这里固定用自家 kind，和 dsh-heart（kind: 'dsh-heart'）的做法一致。
 */
function memorySource() {
  // v4 起只接受「生产者自己的 kind」；v3 及更早用旧的 plugin 包装。
  if (SESSION_FORMAT >= 4) return { kind: 'memory-trigger' };
  return { kind: 'plugin', plugin: 'memory-trigger' };
}

export function apply(ctx, config) {
  const conf = config ?? {};
  if (conf.enabled === false) {
    ctx.logger?.info?.('dsh-memory-trigger: disabled');
    return;
  }
  const storeDir = conf.storeDir || dshHomePath('memory-trigger');
  const eventsDir = join(storeDir, 'events');
  const logPath = join(storeDir, 'trigger.log.jsonl');
  const index = createIndex();
  const pending = new Map(); // agentId -> { text, at }
  let loaded = false;

  const logger = {
    info: (m) => ctx.logger?.info?.('dsh-memory-trigger: ' + m),
    warn: (m) => ctx.logger?.warn?.('dsh-memory-trigger: ' + m),
  };

  async function loadStore() {
    try {
      await mkdir(eventsDir, { recursive: true });
      const files = await readdir(eventsDir);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const raw = await readFile(join(eventsDir, f), 'utf8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            index.add({ session: ev.session, project: ev.project, seq: ev.seq, ts: ev.ts, role: ev.role, text: ev.text });
          } catch {
            /* 跳过坏行 */
          }
        }
      }
      loaded = true;
      logger.info(`index ready: ${index.size} events from ${files.length} files`);
    } catch (error) {
      logger.warn(`loadStore failed: ${String(error)}`);
    }
  }

  function appendEvent(sessionId, ev) {
    const line = JSON.stringify(ev) + '\n';
    appendFile(join(eventsDir, `${sessionId}.jsonl`), line, 'utf8').catch(() => {});
  }

  // 实时捕获会话事件，增量补进索引（新消息不必等回填）
  ctx.on('session/event', (session, event) => {
    if (!loaded) return;
    const sid = String(session?.id ?? session?.header?.id ?? 'unknown');
    const project = projectOf(session);
    try {
      if (event?.type === 'user/message') {
        const text = toText(event.data?.content);
        const srcKind = event.data?.source?.kind;
        if (!text || isNoise(text) || (srcKind !== undefined && srcKind !== 'user')) return;
        const ev = { session: sid, project, seq: event.seq, ts: event.time, role: 'user', text };
        index.add(ev);
        appendEvent(sid, ev);
      } else if (event?.type === 'assistant/message') {
        const text = toText(event.data?.message?.content) || String(event.data?.text ?? '');
        if (!text) return;
        const ev = { session: sid, project, seq: event.seq, ts: event.time, role: 'assistant', text };
        index.add(ev);
        appendEvent(sid, ev);
      } else if (event?.type === 'tool/result' && conf.includeToolResults !== false) {
        // 工具输出很长，只留前 4000 字参与索引，避免淹没对话
        const text = toText(event.data?.message?.content).slice(0, 4000);
        if (!text) return;
        const ev = { session: sid, project, seq: event.seq, ts: event.time, role: 'tool', text };
        index.add(ev);
        appendEvent(sid, ev);
      }
    } catch (error) {
      logger.warn(`capture failed: ${String(error)}`);
    }
  });

  // 判定：用户消息是否在引用旧记忆
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (!loaded || !agent?.id) return;
    try {
    const text = toText(message?.content);
    if (!text || text.length < 4) return;
    const sessionId = String(agent?.session?.id ?? agent?.id);
    const hits = triggerReason(text, conf, index, sessionId);
    if (!hits) return;
    const searchOpts = {
      topK: conf.topK ?? 3,
      minScore: conf.minScore ?? 1.2,
      sessionId: (conf.scope ?? 'session') === 'session' ? sessionId : null,
      since: hits.since ?? null,
      until: hits.until ?? null,
    };
    let results = index.search(hits.query || text, searchOpts);
    if (results.length === 0 && searchOpts.sessionId) {
      // 当前会话没搜到：退一步搜全部历史会话（时间窗仍保留）
      results = index.search(hits.query || text, { ...searchOpts, sessionId: null });
    }
    if (results.length === 0 && (searchOpts.since || searchOpts.until)) {
      // 时间窗内没有：放开时间窗再搜一次，避免时间解析误差导致完全没结果
      results = index.search(hits.query || text, { ...searchOpts, sessionId: null, since: null, until: null });
    }
    if (results.length === 0) {
      // 未命中也要记日志，方便事后调词典/阈值
      if (conf.logTriggers !== false) {
        appendFile(
          logPath,
          JSON.stringify({ at: new Date().toISOString(), agent: agent.id, session: sessionId, kind: hits.kind, trigger: hits.trigger, query: hits.query || text, hits: 0, miss: true }) + '\n',
          'utf8',
        ).catch(() => {});
      }
      if (hits.kind !== 'keyword') return; // 指代/实体/时间没搜到就不打扰
      pending.set(agent.id, { text: '[记忆检索] 没找到相关记录。可以换关键词用 session_event_search 再找一次，再回答。', at: Date.now() });
      return;
    }
    pending.set(agent.id, { text: formatBlock(results, hits, conf), at: Date.now() });
    if (conf.logTriggers !== false) {
      appendFile(
        logPath,
        JSON.stringify({ at: new Date().toISOString(), agent: agent.id, session: sessionId, kind: hits.kind, trigger: hits.trigger, query: hits.query || text, hits: results.length }) + '\n',
        'utf8',
      ).catch(() => {});
    }
    } catch (error) {
      // 判定阶段失败只记日志，不影响本轮对话
      logger.warn(`trigger skipped: ${String(error)}`);
    }
  });

  // 注入：进入新一轮时，把回忆片段作为一条 user 消息追加
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      const { agent } = payload;
      if (decision.kind !== 'enter' || !agent?.id) return decision;
      const item = pending.get(agent.id);
      if (!item) return decision;
      pending.delete(agent.id);
      if (Date.now() - item.at > 120000) return decision; // 太久没轮到的丢弃
      const message = createUserMessage({
        content: [{ type: 'text', text: item.text }],
        source: memorySource(),
      });
      return { ...decision, messages: [...decision.messages, message] };
    } catch (error) {
      // 关键：注入失败只跳过，绝不让整轮运行失败
      logger.warn(`inject skipped: ${String(error)}`);
      return decision;
    }
  });

  loadStore();
}

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const CN_WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };

function cnNumber(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  return CN_DIGITS[s] ?? NaN;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfDay(ts) {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayWindow(ts) {
  return { since: startOfDay(ts), until: endOfDay(ts), label: fmtDate(ts) };
}
function shiftDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
function shiftMonths(base, n) {
  const d = new Date(base);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
}

/** 把时间指代解析成 [since, until]；解析不出返回 null。 */
export function parseTimeWindow(text, now = Date.now()) {
  let m;
  if (text.match(/大前天/)) return dayWindow(shiftDays(now, -3));
  if (text.match(/前天/)) return dayWindow(shiftDays(now, -2));
  if (text.match(/昨[天日]/)) return dayWindow(shiftDays(now, -1));
  if (text.match(/今[天日]/)) return dayWindow(now);
  if ((m = text.match(/(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*天前/))) {
    const n = cnNumber(m[1]);
    if (n > 0) return dayWindow(shiftDays(now, -n));
  }
  if ((m = text.match(/(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*周前/))) {
    const n = cnNumber(m[1]);
    if (n > 0) return dayWindow(shiftDays(now, -7 * n));
  }
  if ((m = text.match(/(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*个月前/))) {
    const n = cnNumber(m[1]);
    if (n > 0) return dayWindow(shiftMonths(now, -n));
  }
  if ((m = text.match(/最近\s*(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*天/))) {
    const n = cnNumber(m[1]);
    if (n > 0) return { since: startOfDay(shiftDays(now, -n)), until: now, label: `最近 ${n} 天` };
  }
  if ((m = text.match(/前\s*(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*天/))) {
    const n = cnNumber(m[1]);
    if (n > 0) return dayWindow(shiftDays(now, -n));
  }
  if (text.match(/上周|上星期/)) {
    const d = new Date(now);
    const wd = (d.getDay() + 6) % 7; // 周一=0
    const monday = shiftDays(now, -wd - 7);
    return { since: startOfDay(monday), until: endOfDay(shiftDays(monday, 6)), label: '上周' };
  }
  if (text.match(/上个?月/)) {
    const d = new Date(now);
    return {
      since: new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(),
      until: new Date(d.getFullYear(), d.getMonth(), 0, 23, 59, 59, 999).getTime(),
      label: '上个月',
    };
  }
  if (text.match(/去年/)) {
    const y = new Date(now).getFullYear() - 1;
    return { since: new Date(y, 0, 1).getTime(), until: new Date(y, 11, 31, 23, 59, 59, 999).getTime(), label: `${y} 年` };
  }
  if (text.match(/今年/)) {
    const y = new Date(now).getFullYear();
    return { since: new Date(y, 0, 1).getTime(), until: now, label: `${y} 年至今` };
  }
  if (text.match(/本月|这个月/)) {
    const d = new Date(now);
    return { since: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), until: now, label: '本月' };
  }
  if ((m = text.match(/(?:星期|礼拜|周)\s*([一二三四五六日天1-7])/))) {
    const target = CN_WEEKDAY[m[1]];
    if (target) {
      const d = new Date(now);
      const cur = d.getDay() === 0 ? 7 : d.getDay();
      let back = cur - target;
      if (back < 0) back += 7;
      return dayWindow(shiftDays(now, -back));
    }
  }
  if ((m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/))) {
    const mon = Number(m[1]) - 1;
    const day = Number(m[2]);
    if (mon >= 0 && mon < 12 && day >= 1 && day <= 31) {
      const y = new Date(now).getFullYear();
      let t = new Date(y, mon, day).getTime();
      if (t > now) t = new Date(y - 1, mon, day).getTime();
      return dayWindow(t);
    }
  }
  if ((m = text.match(/(上午|下午|晚上|早上|中午)?\s*(\d{1,2})\s*[点时](?:\s*半|\s*(\d{1,2})\s*分)?/))) {
    let hour = Number(m[2]);
    let minute = 0;
    if (/半/.test(m[0])) minute = 30;
    else if (m[3]) minute = Number(m[3]);
    if (/下午|晚上/.test(m[0]) && hour < 12) hour += 12;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const d = new Date(now);
      d.setHours(hour, minute, 0, 0);
      let t = d.getTime();
      if (t > now + 3600000) t -= 86400000;
      return { since: t - 3600000, until: t + 3600000, label: `${fmtDate(t)} 附近` };
    }
  }
  return null;
}

/** 命中时间指代 → 返回触发信息（含时间窗）。 */
function parseTimeTrigger(text, conf) {
  const patterns = conf.timeAnaphora ?? DEFAULT_TIME_PATTERNS;
  for (const src of patterns) {
    let m = null;
    try {
      m = text.match(new RegExp(src));
    } catch {
      m = null;
    }
    if (!m) continue;
    const win = parseTimeWindow(text);
    if (win) return { trigger: String(m[0]).trim(), ...win };
  }
  return null;
}

/** 判断触发原因，返回 {kind, trigger, query, since?, until?, label?} 或 null */
function triggerReason(text, conf, index, sessionId) {
  const keywords = conf.keywords ?? DEFAULT_KEYWORDS;
  for (const k of keywords) if (text.includes(k)) return { kind: 'keyword', trigger: k, query: text };
  const time = parseTimeTrigger(text, conf);
  if (time) return { kind: 'time', trigger: time.trigger, query: text, since: time.since, until: time.until, label: time.label };
  const anaphora = conf.anaphora ?? DEFAULT_ANAPHORA;
  const anaphoraHit = anaphora.find((a) => text.includes(a));
  if (anaphoraHit) return { kind: 'anaphora', trigger: anaphoraHit, query: text };
  if (conf.entityTrigger !== false) {
    const ents = extractEntities(text);
    const minScore = conf.minScore ?? 1.2;
    const hits = ents.filter((e) => index.search(e, { topK: 1, minScore, sessionId }).length > 0);
    if (hits.length > 0) return { kind: 'entity', trigger: hits[0], query: hits.join(' ') + ' ' + text };
  }
  return null;
}

function formatBlock(results, hits, conf) {
  const maxChars = conf.maxChars ?? 1200;
  const perItem = Math.max(120, Math.floor((maxChars - 300) / Math.max(1, results.length)));
  const lines = [];
  lines.push(`[记忆检索] 用户可能在引用过去的对话（触发：${hits.kind}/${hits.trigger}${hits.label ? `，时间窗：${hits.label}` : ''}）。从会话历史检索到 ${results.length} 条相关片段：`);
  let n = 0;
  const render = (r) => {
    n += 1;
    const body = r.doc.text.replace(/\s+/g, ' ').slice(0, perItem);
    const proj = r.doc.project ? ` · 项目 ${r.doc.project}` : '';
    lines.push(`${n}. ${fmtTime(r.doc.ts)} · ${ROLE_LABEL[r.doc.role] ?? r.doc.role} · seq ${r.doc.seq}${proj}`);
    lines.push(`   「${body}」`);
  };
  if (conf.groupByProject !== false) {
    const groups = new Map();
    for (const r of results) {
      const key = r.doc.project || '未知项目';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    if (groups.size > 1) {
      for (const [proj, list] of groups) {
        lines.push(`【项目：${proj}】`);
        for (const r of list) render(r);
      }
    } else {
      for (const r of results) render(r);
    }
  } else {
    for (const r of results) render(r);
  }
  lines.push('请结合上述原文回答；需要更多细节时可用 session_event_read 读对应 seq，不要笼统说"记不清"。');
  return lines.join('\n').slice(0, maxChars + 400);
}
