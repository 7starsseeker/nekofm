/**
 * 歌单「取全量」回归测试（不联网，全用桩）
 * ========================================
 * 背景（2026-09-26 实测，用户反馈"导入 100+ 首的歌单，只有 10 首进队列"）：
 *   1) v6 端点的 `n` 是返回曲目数上限，**不传时只给 10 首**；
 *   2) `n=500` 会**硬截断**（617 首的歌单只给 500 首）；
 *   3) `offset` 参数被**服务端忽略**，所以"翻页补齐"是假路子；
 *   4) 普通歌单匿名访问时 `trackCount` 甚至会被谎报成 10，上层完全看不出来被截。
 * 唯一可靠的全量索引是 `trackIds`（不受 n 限制），缺的曲目按 id 走 songDetail 补齐。
 *
 * 这个用例把上面几条钉死：桩里刻意只给 10 首 tracks + 完整 trackIds，
 * 断言 `playlist()` 最终能凑齐、顺序不乱、limit 生效、songDetail 挂了也不崩。
 */
'use strict';

const { NeteaseClient } = require('../src/core/netease/client');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { console.log(`  ✅ ${n}${extra ? ' → ' + extra : ''}`); pass++; }
  else { console.log(`  ❌ ${n}${extra ? ' → ' + extra : ''}`); fail++; }
};

const TOTAL = 205;                       // 歌单真实曲目数（>200，能顺带验证不被旧"200 上限"限制）
const ALL_IDS = Array.from({ length: TOTAL }, (_, i) => 1000000 + i);
const mkSong = (id, name) => ({
  id, name: name || `第${id}首`, artists: ['歌手'], artistText: '歌手',
  album: '专辑', duration: 200, cover: '', source: 'netease',
});
// v6 形状（ar/al/dt）与老接口形状（artists/album/duration）混着给，顺带验证 _normSong 兼容
const v6Song = (id) => ({
  id, name: `第${id}首`, ar: [{ name: '歌手' }], al: { name: '专辑', picUrl: '' },
  dt: 200000, fee: 0,
});

/** 造一个客户端：直连桩返回"匿名 v6"那种残缺响应，songDetail 桩按 id 补齐 */
function makeClient({ tracksGiven = 10, detailFails = false, failAfterBatches = Infinity } = {}) {
  const nc = new NeteaseClient({ log: () => {} });
  const calls = { songDetail: 0, detailIdCount: 0 };
  nc.browser = null;                       // 走直连分支，避免依赖 Electron
  nc._fetch = async (url) => {
    if (/\/api\/playlist\/detail/.test(url)) {
      return {
        ok: true,
        data: {
          result: {
            id: 999, name: '桩歌单', coverImgUrl: '',
            // 陷阱：服务端把 trackCount 也谎报小了（真实场景匿名访问确实如此）
            trackCount: tracksGiven,
            tracks: ALL_IDS.slice(0, tracksGiven).map(v6Song),
            trackIds: ALL_IDS.map((id) => ({ id })),
          },
        },
      };
    }
    throw new Error('不该走到这里：' + url);
  };
  nc.songDetail = async (ids) => {
    calls.songDetail++;
    calls.detailIdCount += ids.length;
    if (detailFails) return { ok: false, songs: [] };
    if (calls.songDetail > failAfterBatches) return { ok: false, songs: [] };
    return { ok: true, songs: ids.map((id) => mkSong(id)) };
  };
  return { nc, calls };
}

(async () => {
  console.log('== 1) 匿名只给 10 首 → 必须自动补齐到全量 ==');
  {
    const { nc, calls } = makeClient({ tracksGiven: 10 });
    const pl = await nc.playlist('999');
    ok('返回 ok', pl.ok === true);
    // 陷阱：trackCount 被谎报成 10 时，应以 trackIds 长度为准（否则会说"已经全了"）
    ok(`曲目数补齐到 ${pl.tracks.length}（trackIds 全量 ${TOTAL}）`, pl.tracks.length === TOTAL,
      `fetched=${pl.fetched} trackCount=${pl.trackCount}`);
    ok('truncated=false（已经补齐，不是残缺）', pl.truncated === false);
    ok('曲目 ID 顺序与 trackIds 完全一致', pl.tracks.map((t) => t.id).join() === ALL_IDS.join());
    ok('补齐走的是 songDetail 批量', calls.songDetail > 0 && calls.detailIdCount === TOTAL - 10,
      `${calls.songDetail} 批 / ${calls.detailIdCount} 首`);
    ok('补回来的曲目带歌手与时长（_normSong 兼容老接口形状）',
      pl.tracks[150].artistText === '歌手' && pl.tracks[150].duration === 200,
      `${pl.tracks[150].name} / ${pl.tracks[150].artistText} / ${pl.tracks[150].duration}s`);
  }

  console.log('\n== 2) n 截断（tracks 500 / trackIds 617）→ 补齐且不重复 ==');
  {
    const { nc } = makeClient({ tracksGiven: 200 });
    const pl = await nc.playlist('999');
    ok('仍取到全量', pl.tracks.length === TOTAL, `${pl.tracks.length}`);
    const uniq = new Set(pl.tracks.map((t) => t.id));
    ok('没有重复项（旧实现的"假翻页"会把开头重复拼进来）', uniq.size === pl.tracks.length, `去重后 ${uniq.size}`);
  }

  console.log('\n== 3) limit 生效，且不会为 limit 之外的曲目白拉数据 ==');
  {
    const { nc, calls } = makeClient({ tracksGiven: 10 });
    const pl = await nc.playlist('999', { limit: 5 });
    ok('只返回 5 首', pl.tracks.length === 5, `${pl.tracks.length}`);
    ok('不额外请求 songDetail', calls.songDetail === 0);
  }
  {
    const { nc, calls } = makeClient({ tracksGiven: 10 });
    const pl = await nc.playlist('999', { limit: 60 });
    ok('limit=60 → 60 首', pl.tracks.length === 60, `${pl.tracks.length}`);
    ok('只为缺的 50 首发请求', calls.detailIdCount === 50, `${calls.detailIdCount} 首`);
  }

  console.log('\n== 4) songDetail 失败 → 返回已拿到的，不崩、不编造 ==');
  {
    const { nc } = makeClient({ tracksGiven: 10, detailFails: true });
    const pl = await nc.playlist('999');
    ok('请求成功返回（不抛异常）', pl.ok === true);
    ok('退回已取到的 10 首', pl.tracks.length === 10, `${pl.tracks.length}`);
    ok('如实标 truncated', pl.truncated === true);
  }
  {
    // 补到一半失败：也要保住前面补到的
    const { nc } = makeClient({ tracksGiven: 10, failAfterBatches: 1 });
    const pl = await nc.playlist('999');
    ok('半途失败保留已补齐的部分', pl.tracks.length === 110, `${pl.tracks.length}`);
    ok('顺序仍然正确（按 trackIds 排过）',
      pl.tracks.map((t) => t.id).join() === ALL_IDS.slice(0, 110).join());
  }

  console.log('\n== 5) 老接口形状（artists/album/duration，无 trackIds）→ 不炸 ==');
  {
    const nc = new NeteaseClient({ log: () => {} });
    nc.browser = null;
    nc._fetch = async () => ({
      ok: true,
      data: { result: { id: 1, name: '老形状', trackCount: 3, tracks: [1, 2, 3].map((i) => mkSong(i)) } },
    });
    nc.songDetail = async () => { throw new Error('不该被调用'); };
    const pl = await nc.playlist('1');
    ok('没有 trackIds 时原样返回', pl.ok && pl.tracks.length === 3, `${pl.tracks.length}`);
    ok('truncated=false（trackCount 也是 3）', pl.truncated === false);
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
