/** 网易云客户端 + 歌词引擎 真实链路联调（只读，不修改任何账号状态） */
'use strict';
const { NeteaseClient } = require('../src/core/netease/client');
const { buildTimeline, locate } = require('../src/core/lyrics/lrc');

(async () => {
  const nc = new NeteaseClient();
  console.log('== 1) 搜索 ==');
  const s = await nc.search('孤勇者 陈奕迅', { limit: 3 });
  console.log('   ok=', s.ok, '命中', s.songs.length, '首');
  s.songs.forEach((x) => console.log(`   - ${x.name} / ${x.artistText} (id=${x.id})`));
  if (!s.ok || !s.songs.length) return;

  const song = s.songs[0];
  console.log('\n== 2) 歌词（v1 端点，带 yv/ytv/yrv） ==');
  const ly = await nc.lyric(song.id);
  console.log('   ok=', ly.ok,
    '| lrc行=', ly.lrc.split('\n').length,
    '| tlyric行=', ly.tlyric.split('\n').length,
    '| romalrc行=', ly.romalrc.split('\n').length,
    '| yrc行=', ly.yrc.split('\n').length);

  console.log('\n== 3) 建时间轴 + 逐字能力统计 ==');
  const tl = buildTimeline(ly);
  const stat = tl.lines.reduce((a, l) => (a[l.karaoke] = (a[l.karaoke] || 0) + 1, a), {});
  console.log('   总行数=', tl.lines.length, '| 能力分布=', stat);
  const k = tl.lines.find((l) => l.karaoke === 'word');
  if (k) {
    console.log(`   逐字样例行: "${k.text}"  共${k.words.length}字`);
    console.log('   前 4 字:', k.words.slice(0, 4).map((w) => `${w.text}@${w.t.toFixed(3)}s(${w.d.toFixed(3)}s)`).join(' '));
  } else {
    console.log('   （该曲无逐字数据，词级进度不可算）');
  }

  console.log('\n== 4) 定位函数在各时间点的输出（模拟渲染层） ==');
  const probeTimes = [0, 3, 20, 45, 70];
  for (const t of probeTimes) {
    const r = locate(tl, t);
    if (!r.current) continue;
    console.log(`   t=${String(t).padStart(3)}s 行#${String(r.index).padStart(3)} ` +
      `prog=${r.progressInLine.toFixed(2)} word=${r.wordProgress.toFixed(2)} ` +
      `k=${r.current.karaoke.padEnd(5)} "${r.current.text.slice(0, 24)}"${r.current.trans ? '  译:' + r.current.trans.slice(0, 16) : ''}`);
  }

  console.log('\n== 5) 播放直链（验证免登录/登录差异） ==');
  const u = await nc.songUrl(song.id);
  console.log('   ok=', u.ok, '| fee=', u.fee, '| br=', u.br, '| path=', u.path);
  console.log('   msg=', u.msg || '(有地址)');
  console.log('   url=', (u.url || '').slice(0, 90));

  console.log('\n== 6) 歌单（用热歌榜验证批量取曲） ==');
  const pl = await nc.playlist('3778678', { limit: 5 });
  console.log('   ok=', pl.ok, '| 歌单:', pl.name, '| 总数:', pl.trackCount, '| 本次取:', pl.tracks.length);
  pl.tracks.slice(0, 3).forEach((t) => console.log(`   - ${t.name} / ${t.artistText}`));

  console.log('\n== 7) 登录态 ==');
  console.log('   isLoggedIn=', nc.isLoggedIn, '| cookie 长度=', nc.cookie.length);
  const acc = await nc.account();
  console.log('   account code=', acc && acc.code, '| 昵称=', acc && acc.profile ? acc.profile.nickname : '(未登录)');
})().catch((e) => { console.error('联调失败:', e); process.exit(1); });
