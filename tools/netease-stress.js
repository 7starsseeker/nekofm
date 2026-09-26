/** 压测：连发 N 次 unique 搜索，定位当前 IP 的实际限流阈值 */
'use strict';
const { NeteaseClient } = require('../src/core/netease/client');

(async () => {
  const nc = new NeteaseClient();
  const keywords = ['孤勇者', '晴天', '七里香', '海阔天空', '稻香', '青花瓷', '夜曲', '东风破', '以父之名', '枫', '搁浅', '退后', '黑色幽默', '龙卷风', '蜗牛', '那些年', '蒲公英的约定', '彩虹', '听见下雨的声音', '红尘客栈', '兰亭序', '菊花台', '双截棍', '霍元甲', '千里之外', '本草纲目', '牛仔很忙', '龙战骑士'];
  console.log(`[${new Date().toISOString()}] 准备连发 ${keywords.length} 次 unique 搜索（每词一次，不走缓存）`);
  console.log(`  throttle: 450ms  timeout: 8s\n`);
  const t0 = Date.now();
  let firstHit = -1;
  for (let i = 0; i < keywords.length; i++) {
    const r = await nc.search(keywords[i], { limit: 1 });
    const ms = Date.now() - t0;
    const status = r.ok ? '✅' : (r.code === 405 ? '❌405' : '⚠️');
    if (!r.ok && firstHit < 0) firstHit = i + 1;
    console.log(`  #${String(i + 1).padStart(2)} ${String(ms).padStart(6)}ms  ${status}  code=${String(r.code || '-').padEnd(4)}  hits=${r.songs?.length || 0}  kw="${keywords[i]}"`);
  }
  const total = Date.now() - t0;
  console.log(`\n[${new Date().toISOString()}] 总耗时 ${total}ms`);
  console.log('coolLeft:', nc.coolLeft(), 's | 搜索缓存:', nc.searchCacheStats().size);
  if (firstHit > 0) console.log(`\n🚨 限流出现在第 ${firstHit} 次请求（${total / keywords.length | 0}ms/次平均）`);
  else console.log(`\n✅ ${keywords.length} 次 unique 搜索全部成功，没触发 405`);
})().catch((e) => { console.error(e); process.exit(1); });