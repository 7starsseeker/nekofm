/** 验证冷却恢复：等 35s 后再发 5 次搜索看会不会又限流 */
'use strict';
const { NeteaseClient } = require('../src/core/netease/client');
(async () => {
  const nc = new NeteaseClient({ cookie: process.env.NETEASE_COOKIE });
  const kws = ['夜曲', '东风破', '以父之名'];
  console.log(`[${new Date().toISOString()}] 当前 cooldown: ${nc.coolLeft()}s`);
  console.log('直接探测（不传 cookie 也试一下匿名是否能用）:');
  const r0 = await nc.search('孤勇者', { limit: 1 });
  console.log(`  匿名孤勇者: ok=${r0.ok} code=${r0.code}`);
  console.log('\n如果你方便扫码登录了，把 MUSIC_U 加到 NETEASE_COOKIE 环境变量里再跑');
  console.log('现在就裸跑匿名场景，看阈值:');
  const t0 = Date.now();
  for (let i = 0; i < kws.length; i++) {
    const r = await nc.search(kws[i], { limit: 1 });
    console.log(`  ${i+1}. ${kws[i]}: ok=${r.ok} code=${r.code}`);
  }
  console.log(`cooldown: ${nc.coolLeft()}s`);
})().catch((e) => console.error(e));
