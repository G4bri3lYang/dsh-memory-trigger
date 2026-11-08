/**
 * 一次性回填：把会话历史（zstd 压缩的 JSONL）解压成明文事件索引。
 *
 * 用法（需要支持 zstd 的 Node，>= 22.15 或 24 系列）：
 *   node lib/backfill.mjs
 *   node lib/backfill.mjs --store C:\path\to\store
 *
 * 产物：<store>/events/<sessionId>.jsonl，一行一条 {session,seq,ts,role,text}
 * 只抽取 user/message 与 assistant/message 的正文；系统注入的噪音（心跳摘要、
 * 运行时上下文）和插件消息会被跳过。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

const args = process.argv.slice(2);
function argOf(name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const sessionsDir = join(dshHome, 'sessions');
const storeDir = argOf('--store', join(dshHome, 'memory-trigger'));
const eventsDir = join(storeDir, 'events');

const NOISE_PREFIXES = ['Current runtime context', '[dsh-heart]', '眼前的对话快放不下'];

function isNoise(text) {
  const t = text.trimStart();
  return NOISE_PREFIXES.some((p) => t.startsWith(p));
}

function toText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) if (p && p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
  return parts.join('\n');
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p);
  }
  return out;
}

mkdirSync(eventsDir, { recursive: true });
const files = walk(sessionsDir);
let total = 0;
const summary = [];

for (const f of files) {
  let lines;
  try {
    lines = zstdDecompressSync(readFileSync(f)).toString('utf8').split('\n');
  } catch (error) {
    summary.push(`${f}: 解压失败 ${String(error)}`);
    continue;
  }
  const sessionId = f.split(/[\\/]/).slice(-2, -1)[0] || 'unknown';
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'user/message') {
      const text = toText(ev.data?.content);
      const srcKind = ev.data?.source?.kind;
      if (text && (srcKind === undefined || srcKind === 'user') && !isNoise(text))
        out.push({ session: sessionId, seq: ev.seq, ts: ev.time, role: 'user', text });
    } else if (ev.type === 'assistant/message') {
      const text = toText(ev.data?.message?.content) || String(ev.data?.text ?? '');
      if (text) out.push({ session: sessionId, seq: ev.seq, ts: ev.time, role: 'assistant', text });
    } else if (ev.type === 'tool/result') {
      const text = toText(ev.data?.message?.content).slice(0, 4000);
      if (text) out.push({ session: sessionId, seq: ev.seq, ts: ev.time, role: 'tool', text });
    }
  }
  if (out.length === 0) continue;
  writeFileSync(join(eventsDir, `${sessionId}.jsonl`), out.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  total += out.length;
  summary.push(`${sessionId}: ${out.length} 条（${(statSync(f).size / 1048576).toFixed(1)} MB 源文件）`);
}

console.log(`回填完成：${files.length} 个会话文件，${total} 条事件 → ${eventsDir}`);
for (const s of summary) console.log('  ' + s);
