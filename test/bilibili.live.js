/** B站模块真实链路联调：弹幕 WS + 视频取流 + 字幕 + 搜索 */
'use strict';
const { DanmakuClient } = require('../src/core/bilibili/danmaku');
const { BiliApi } = require('../src/core/bilibili/api');

const LOG = process.argv.includes('--verbose');
const log = LOG ? (...a) => console.log('   [log]', ...a) : () => {};

(async () => {
  const api = new BiliApi({ logger: log });

  console.log('== 1) 视频信息（免登录取 cid） ==');
  const info = await api.videoInfo('BV1eLsnzFEoM');
  console.log(`   ${info.title}`);
  console.log(`   bvid=${info.bvid} cid=${info.cid} 时长=${info.duration}s up=${info.owner} 分P=${info.pages.length}`);

  console.log('\n== 2) WBI 取流（DASH 音频） ==');
  const p = await api.playurl(info.bvid, info.cid);
  console.log(`   端点=${p.usedEndpoint} | 音频流 ${p.audios.length} 条`);
  p.audios.forEach((a) => console.log(`   - id=${a.id} ${a.label.padEnd(6)} ${a.bandwidth}bps ${a.codecs}`));

  console.log('\n== 3) 防盗链验证（带/不带 Referer） ==');
  const best = p.audios[0];
  const withRef = await api.probeStream(best.url);
  console.log(`   带 Referer -> HTTP ${withRef.status} ${withRef.contentType} ok=${withRef.ok}`);
  try {
    const r = await fetch(best.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    console.log(`   无 Referer -> HTTP ${r.status} ok=${r.status < 400}`);
  } catch (e) { console.log('   无 Referer -> 异常', e.message); }

  console.log('\n== 4) 字幕（视频音频的兜底歌词源） ==');
  const sub = await api.subtitles(info.bvid, info.cid);
  console.log(`   ok=${sub.ok} 字幕轨 ${sub.subtitles.length} 条`, sub.subtitles.map((s) => s.lanDoc));

  console.log('\n== 5) 搜索视频（点歌"B站视频"用） ==');
  const sr = await api.searchVideo('孤勇者 MV', { pageSize: 3 });
  console.log('   ok=', sr.ok, '| 命中', sr.results.length);
  sr.results.forEach((v) => console.log(`   - [${v.bvid}] ${v.title.slice(0, 40)} / ${v.author} ${v.duration}`));

  console.log('\n== 6) 弹幕 WebSocket 端到端（收 20 秒真实弹幕） ==');
  const rec = await (await fetch(
    'https://api.live.bilibili.com/room/v1/room/get_user_recommend?page=1&page_size=10',
    { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://live.bilibili.com/' } }
  )).json();
  const room = rec.data.find((r) => r.roomid);
  console.log(`   目标房间 ${room.roomid}（${String(room.title || '').slice(0, 20)}，在线 ${room.online}）`);

  const dc = new DanmakuClient({ roomId: room.roomid, logger: log });
  const seen = [];
  dc.on('room', (r) => console.log(`   room_init -> 真实房间号 ${r.roomId} 直播中=${r.liveStatus === 1}`));
  dc.on('open', () => console.log('   ✔ WebSocket 已认证，开始接收'));
  dc.on('danmaku', (d) => { seen.push(d); if (seen.length <= 5) console.log(`   💬 [${d.uname}] ${d.text}`); });
  dc.on('gift', (g) => { if (LOG) console.log(`   🎁 ${g.uname} ${g.gift}x${g.num}`); });
  dc.on('popularity', (n) => { if (LOG) console.log('   ♥ 人气', n); });
  dc.on('error', (e) => console.log('   ⚠ error', e && e.message));

  await dc.connect();
  console.log('   等待 20 秒...');
  await new Promise((r) => setTimeout(r, 20000));
  console.log('   统计:', JSON.stringify(dc.stats));
  dc.close();
  console.log(`   ✔ 本轮共收到 ${seen.length} 条弹幕`);
  console.log('\n   >>> 弹幕接收链路:', seen.length > 0 ? 'PASS' : 'FAIL');
})().catch((e) => { console.error('联调失败:', e); process.exit(1); });
