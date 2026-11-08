import { apply } from './index.js';

const handlers = new Map();
const ctx = {
  on: (n, f) => {
    const a = handlers.get(n) ?? [];
    a.push(f);
    handlers.set(n, a);
  },
  logger: { info() {}, warn: (m) => console.log('[warn]', m) },
};
apply(ctx, { minScore: 0.5, topK: 3, maxChars: 1200 });
await new Promise((r) => setTimeout(r, 800));

const emit = async (n, ...args) => {
  for (const f of handlers.get(n) ?? []) {
    const out = await f(...args);
    if (out !== undefined) return out;
  }
};

const agent = { id: '3237013a-31dc-fb31-901c-c7159fad5ade', session: { id: '3237013a-31dc-fb31-901c-c7159fad5ade' } };
await emit('agent/inbox/claimed', { agent, message: { content: [{ type: 'text', text: '11月3日我们讨论的那个 Ghidra 配置怎么样了' }] } });
const d = await emit('agent/pre-step', { agent }, async () => ({ kind: 'enter', messages: [] }));
for (const m of d.messages) for (const c of m.content ?? []) if (c.type === 'text') console.log(c.text);
