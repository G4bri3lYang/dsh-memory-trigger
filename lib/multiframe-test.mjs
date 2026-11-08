// 多帧 zstd 回填回归测试：DSH 会话文件是追加写入的多帧，单帧解压会得到 0 条事件。
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const base = join(os.tmpdir(), 'mt-multiframe-test');
rmSync(base, { recursive: true, force: true });
const sessions = join(base, 'sessions', 'sess-1');
mkdirSync(sessions, { recursive: true });

const header = JSON.stringify({ type: 'session', version: 4, id: 'sess-1', cwd: 'C:\\demo\\proj', createdAt: Date.now() }) + '\n';
const ev1 = JSON.stringify({ type: 'user/message', seq: 1, time: Date.now() - 5000, data: { content: [{ type: 'text', text: '你好，测试多帧解压' }], source: { kind: 'user' } } }) + '\n';
const ev2 = JSON.stringify({ type: 'assistant/message', seq: 2, time: Date.now() - 4000, data: { message: { content: [{ type: 'text', text: '收到了，多帧能解出来' }] } } }) + '\n';

// 三个独立帧拼在一起，模拟追加写入
const multi = Buffer.concat([zstdCompressSync(Buffer.from(header)), zstdCompressSync(Buffer.from(ev1)), zstdCompressSync(Buffer.from(ev2))]);
writeFileSync(join(sessions, 'session.v4.jsonl.zstd'), multi);

const store = join(base, 'store');
const r = spawnSync(process.execPath, [join(import.meta.dirname, 'backfill.mjs'), '--store', store], {
  env: { ...process.env, DSH_HOME: base },
  encoding: 'utf8',
});
console.log(r.stdout || r.stderr);
const out = join(store, 'events', 'sess-1.jsonl');
if (!existsSync(out)) {
  console.log('FAIL: 没有生成事件文件');
  process.exit(1);
}
const lines = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean);
console.log('事件条数:', lines.length);
for (const l of lines) {
  const e = JSON.parse(l);
  console.log(' -', e.role, e.project, e.text);
}
if (lines.length < 2) {
  console.log('FAIL: 多帧解压失败');
  process.exit(1);
}
console.log('PASS');
