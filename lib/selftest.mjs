import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createIndex } from './search.js';

const dir = path.join(homedir(), '.dsh', 'memory-trigger', 'events');
const idx = createIndex();
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue;
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      idx.add(e);
    } catch {}
  }
}
console.log('index size:', idx.size);

const queries = ['REA Ghidra 配置', '远程访问 8843 配对', '潜兵群 八理世家', 'STM32 呼吸灯 PWM'];
for (const q of queries) {
  console.log('\n== query:', q);
  const t0 = Date.now();
  const res = idx.search(q, { topK: 3, minScore: 1.0 });
  console.log('  took', Date.now() - t0, 'ms, hits', res.length);
  for (const r of res) {
    const d = new Date(r.doc.ts);
    const ts = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    console.log(`  [${r.score.toFixed(2)}] ${ts} ${r.doc.role} seq${r.doc.seq}: ${r.doc.text.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}
