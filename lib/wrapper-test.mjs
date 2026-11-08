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
apply(ctx, { minScore: 0.5, topK: 3 });
await new Promise((r) => setTimeout(r, 800));

const emit = async (n, ...a) => {
  for (const f of handlers.get(n) ?? []) {
    const o = await f(...a);
    if (o !== undefined) return o;
  }
};

const agent = { id: '3237013a-31dc-fb31-901c-c7159fad5ade', session: { id: '3237013a-31dc-fb31-901c-c7159fad5ade' } };
const cases = [
  '<user_message qq="993253118" nickname="G4bri3l"> 我去看看 </user_message>',
  '<user_message qq="993253118" nickname="G4bri3l"> REA 的 Ghidra 配置搞定了吗 </user_message>',
];
for (const text of cases) {
  await emit('agent/inbox/claimed', { agent, message: { content: [{ type: 'text', text }] } });
  const d = await emit('agent/pre-step', { agent }, async () => ({ kind: 'enter', messages: [] }));
  console.log('---', text.slice(0, 45), '->', d.messages.length ? '注入' : '未触发');
  for (const m of d.messages) for (const c of m.content ?? []) if (c.type === 'text') console.log(c.text.split('\n')[0]);
}
