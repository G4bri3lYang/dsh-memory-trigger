/**
 * 轻量全文检索：中文 bigram + 英文词，BM25 打分，纯 JS、零依赖。
 * 文档模型：{ session, seq, ts, role, text }
 */

const CJK = /[\u3400-\u9fff]/;

/** 分词：英文/数字按词，中文按单字 + 双字 bigram。 */
export function tokenize(text) {
  const out = [];
  const lower = String(text ?? '').toLowerCase();
  const latin = lower.match(/[a-z0-9_][a-z0-9_.\-]{1,}/g) ?? [];
  for (const w of latin) out.push(w);
  const cjkRuns = lower.match(/[\u3400-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length; i += 1) {
      out.push(run[i]);
      if (i + 1 < run.length) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

export function createIndex() {
  /** @type {Array<{session:string,seq:number,ts:number,role:string,text:string,tokens:string[],len:number}>} */
  const docs = [];
  /** @type {Map<string, number[]>} token -> doc indexes */
  const postings = new Map();
  /** 去重：同一会话同一 seq 只收一次（跨项目目录重复的会话文件） */
  const seen = new Set();
  let totalLen = 0;

  function add(doc) {
    if (!doc || typeof doc.text !== 'string') return;
    const text = doc.text.trim();
    if (!text) return;
    const key = `${doc.session}|${doc.seq}|${doc.role}`;
    if (seen.has(key)) return;
    seen.add(key);
    const tokens = tokenize(text);
    if (tokens.length === 0) return;
    const idx = docs.length;
    docs.push({ ...doc, text, tokens, len: tokens.length });
    totalLen += tokens.length;
    for (const t of tokens) {
      let list = postings.get(t);
      if (!list) postings.set(t, (list = []));
      if (list[list.length - 1] !== idx) list.push(idx);
    }
  }

  function search(query, opts = {}) {
    const topK = opts.topK ?? 5;
    const minScore = opts.minScore ?? 1.2;
    const sessionFilter = opts.sessionId ?? null;
    const since = opts.since ?? null;
    const until = opts.until ?? null;
    const terms = [...new Set(tokenize(query))].filter((t) => t.length > 1 || CJK.test(t));
    if (terms.length === 0 || docs.length === 0) return [];
    const N = docs.length;
    const avgdl = totalLen / N || 1;
    const k1 = 1.2;
    const b = 0.75;
    const scores = new Map();
    for (const term of terms) {
      const list = postings.get(term);
      if (!list) continue;
      const df = list.length;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const idx of list) {
        const doc = docs[idx];
        if (sessionFilter && doc.session !== sessionFilter) continue;
        if (since && doc.ts < since) continue;
        if (until && doc.ts > until) continue;
        let tf = 0;
        for (const t of doc.tokens) if (t === term) tf += 1;
        if (tf === 0) continue;
        const denom = tf + k1 * (1 - b + (b * doc.len) / avgdl);
        scores.set(idx, (scores.get(idx) ?? 0) + idf * ((tf * (k1 + 1)) / denom));
      }
    }
    const ranked = [...scores.entries()]
      .map(([idx, score]) => ({ doc: docs[idx], score }))
      .sort((a, b2) => b2.score - a.score || b2.doc.ts - a.doc.ts);

    // 去重：同会话里内容高度相似（如 tool/result 与 assistant 复述）只留一条，优先 user 原话
    const picked = [];
    for (const item of ranked) {
      if (picked.length >= topK) break;
      if (item.score < minScore) break;
      const dup = picked.some((p) => p.doc.session === item.doc.session && similarity(p.doc.text, item.doc.text) > 0.7);
      if (dup) {
        const i = picked.findIndex((p) => p.doc.session === item.doc.session && similarity(p.doc.text, item.doc.text) > 0.7);
        if (i >= 0 && item.doc.role === 'user' && picked[i].doc.role !== 'user') picked[i] = item;
        continue;
      }
      picked.push(item);
    }
    return picked;
  }

  return { add, search, get size() { return docs.length; }, docs };
}

function similarity(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}
