/** 测真实情况下：节流 450ms 是不是太小，看放宽到 800ms / 1500ms 表现 */
'use strict';
const { NeteaseClient } = require('../src/core/netease/client');

const TEST_GAPS = [400, 800, 1500, 3000]; // 不同的间隔
const N = 12;  // 每个间隔跑 12 次

(async () => {
  for (const gap of TEST_GAPS) {
    const nc = new NeteaseClient();
    // 临时改 gap（直接读源码不好做，先写一个简化版）
    let hits = 0, limited = 0;
    const keywords = ['孤勇者','晴天','七里香','海阔天空','稻香','青花瓷','夜曲','东风破','以父之名','枫','搁浅','退后'];
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      const wait = nc._lastReqAt ? (nc._lastReqAt + gap - Date.now()) : 0;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      nc._lastReqAt = Date.now();
      const r = await nc._fetch(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(keywords[i])}&type=1&limit=1`);
      if (r.ok) hits++;
      else if (r.code === 405) limited++;
    }
    console.log(`gap=${gap}ms  N=${N}  ✅=${hits}  ❌405=${limited}  触发率=${(limited/N*100).toFixed(0)}%`);
    // 等冷却
    if (nc.coolLeft() > 0) await new Promise(r => setTimeout(r, (nc.coolLeft() + 2) * 1000));
  }
})().catch(e => console.error(e));
