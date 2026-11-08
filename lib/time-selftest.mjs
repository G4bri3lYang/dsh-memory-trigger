import { parseTimeWindow } from './index.js';

const now = Date.now();
const cases = ['3天前', '三天前', '昨天', '前天', '11月3日', '星期三', '礼拜天', '3点', '下午3点半', '上个月', '上周', '最近7天', '今年', '去年'];
for (const c of cases) {
  const w = parseTimeWindow(c, now);
  if (!w) {
    console.log(JSON.stringify(c), '-> null');
    continue;
  }
  const f = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
  console.log(JSON.stringify(c), `-> [${f(w.since)} ~ ${f(w.until)}] label=${w.label}`);
}
