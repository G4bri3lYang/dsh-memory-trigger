// 离线冒烟：不启动 DSH，用假 ctx 触发一次"你之前说的那个…"，看注入内容
import { apply } from './index.js';

const handlers = new Map();
const ctx = {
  on: (name, fn) => {
    const arr = handlers.get(name) ?? [];
    arr.push(fn);
    handlers.set(name, arr);
  },
  logger: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
};

apply(ctx, { minScore: 0.5, topK: 3, maxChars: 1200 });

await new Promise((r) => setTimeout(r, 800));

const emit = async (name, ...args) => {
  for (const fn of handlers.get(name) ?? []) {
    const out = await fn(...args);
    if (out !== undefined && name === 'agent/pre-step') return out;
  }
};

const agent = { id: '3237013a-31dc-fb31-901c-c7159fad5ade', session: { id: '3237013a-31dc-fb31-901c-c7159fad5ade' } };
const userText = '你之前说的那个远程访问插件，最后是怎么配的？';
await emit('agent/inbox/claimed', { agent, message: { content: [{ type: 'text', text: userText }] } });

const decision = await emit('agent/pre-step', { agent, signal: undefined }, async () => ({ kind: 'enter', messages: [] }));
console.log('\n=== 注入的消息 ===');
for (const m of decision.messages) {
  for (const c of m.content ?? []) if (c.type === 'text') console.log(c.text);
}
