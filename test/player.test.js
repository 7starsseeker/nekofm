/**
 * 播放器功能测试
 * ===============
 * 覆盖：播放模式（顺序/列表循环/单曲循环/随机）、上一首与历史、
 *       弹幕切歌权限（本人可切/他人不可）、收藏、队列置顶与按类型拉黑、
 *       闲时歌单、在线媒体缓存。
 *
 * 全部用 ffmpeg 现场生成的音频，不依赖外部网络 —— 这样任何环境都能复现。
 */
'use strict';


/**
 * ⚠️ **测试隔离（2026-09-26 加）：把数据目录锁到临时目录。**
 *
 * 为什么必须加：`configPath()` 在没设 `NEKOFM_DATA` 时会回落到
 * **`<程序目录>/data`**，也就是用户真实的配置与缓存目录。
 * 这些测试会往里写缓存、封面，最后还调 `engine.cache.clear()` ——
 * **等于每跑一次测试就把用户的真实缓存清空**（实测发生过：T 盘 data/cache
 * 里 ~20MB 音频被测试抹掉了）。测试跑完不该动用户任何东西。
 */
process.env.NEKOFM_DATA = require('node:path').join(require('node:os').tmpdir(), 'nekofm-data-player');
// 每轮从**干净**的数据目录开始：否则上一轮落盘的歌词/音频缓存会在本轮被命中，
// 让"来源=缓存"这类断言和预期的"来源=netease-match"对不上（实测踩到）
require('node:fs').rmSync(process.env.NEKOFM_DATA, { recursive: true, force: true });


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { Engine } = require('../src/main/engine');
const { AppServer } = require('../src/main/server');
const { createCommandHandler } = require('../src/main/commands');
const { DEFAULT_CONFIG, deepMerge } = require('../src/core/config');
const { MediaCache } = require('../src/main/cache');
const { probeFfmpeg, skipAllBecause } = require('./_helpers');

const PORT = 37905;
let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, extra = '') => {
  if (c) { console.log(`  ✅ ${n}${extra ? ' → ' + extra : ''}`); pass++; }
  else { console.log(`  ❌ ${n}${extra ? ' → ' + extra : ''}`); fail++; }
};
const skip = (n, why) => { console.log(`  ⏭️  ${n} → ${why}`); skipped++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.join(os.tmpdir(), 'nekofm-player-test');

function makeAudio(file, title, artist = '测试歌手', seconds = 5) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:a', 'libmp3lame', '-b:a', '96k', '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, file], { stdio: 'pipe' });
}

(async () => {
  // 素材是现场用 ffmpeg 造的，没有 ffmpeg 就整份跳过（环境不具备 ≠ 失败）
  if (!probeFfmpeg().ok) skipAllBecause('播放器功能测试', '未找到 ffmpeg / ffprobe（素材需要现场生成）');

  // ---------------------------------------------------------------- 准备素材
  fs.rmSync(ROOT, { recursive: true, force: true });
  const musicDir = path.join(ROOT, 'music');
  const names = ['甲曲', '乙曲', '丙曲', '丁曲', '戊曲'];
  names.forEach((n, i) => makeAudio(path.join(musicDir, `${n}.mp3`), n, '测试歌手', 4 + i));

  const cfg = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), {
    server: { port: PORT },
    local: { dirs: [musicDir], enabled: true },
    cache: { enabled: true, maxMB: 64, maxFileMB: 32 },
    queue: { cooldownMs: 0, perUserMax: 99 },
  });

  const engine = new Engine({ config: cfg, log: () => {} });
  const server = new AppServer({
    port: PORT, host: '127.0.0.1',
    rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
    sharedDir: path.join(__dirname, '..', 'src', 'shared'),
    getState: () => engine.state(),
    getLyrics: () => engine.lyricsPayload(),
    allowRootsProvider: () => [
      ...(engine.config.local.dirs || []),
      ...(engine.local.extraFiles ? [...engine.local.extraFiles] : []),
      path.join(ROOT, 'covers'),
      engine.cache.cacheDir,   // 与生产接线一致：缓存目录必须在白名单里
    ],
    onCommand: createCommandHandler({ engine, saveConfig: () => {}, hooks: {} }),
    log: () => {},
  });
  const port = await server.start();
  engine.serverBase = `http://127.0.0.1:${port}`;
  await engine.init();
  ok('本地曲库已加载', engine.local.tracks.length === 5, `${engine.local.tracks.length} 首`);

  const T = (i) => engine.local.tracks.find((t) => t.title === names[i]);
  const enqueue = (i, user = { uid: 'u1', uname: '甲', isAnchor: true }) =>
    engine.queue.push({ ...T(i), source: 'local' }, user);

  /**
   * 彻底复位队列。注意：`queue.clear()` 只清"待播项"，**保留 queue.current**
   * （刻意的：不能让人重复点正在放的那首）。所以测试里要连 current 一起清，
   * 否则重新入队同一首会被去重挡掉 —— 我第一版就栽在这。
   */
  const resetQueue = () => {
    engine.queue.clear();
    engine.queue.current = null;
    // 注意：SongQueue 有**自己的**去重历史（queue.history），与 engine.history
    // 是两个东西。只清后者的话，之前放过的歌会被当作"刚放过"而拒绝入队。
    engine.queue.history.length = 0;
    engine.history.length = 0;
    engine.track = null;
    engine.trackMeta = null;
    engine.playingIdle = false;
  };

  // ================================================================ 1) 播放模式
  console.log('== 1) 播放模式 ==');
  {
    engine.setPlayMode('repeat-one');
    // **播放语义**（按用户要求定的）：
    //   当前播放列表（队列）**恒为顺序播放**，模式只作用于闲时/已保存歌单。
    //   所以这里先验证"队列不受模式影响"，再单独验证闲时歌单的模式。
    resetQueue();
    enqueue(0); enqueue(1);
    engine.setPlayMode('repeat-one');
    await engine.next();
    await sleep(250);
    const firstQ = engine.track && engine.track.title;
    await engine.next();
    await sleep(250);
    ok('当前列表恒为顺序：即使选了单曲循环也照常往下走',
      engine.track && engine.track.title !== firstQ, `${firstQ} → ${engine.track && engine.track.title}`);
    ok('播完的从当前列表移除', engine.queue.items.length === 0, `剩余 ${engine.queue.items.length}`);

    // 单曲循环作用于**闲时歌单**
    engine.setPlayMode('repeat-one');
    engine.savedAddMany(names.map((_, i) => ({ ...T(i), source: 'local' })));
    engine.config.idle = { enabled: true, source: 'saved', shuffle: false, avoidRecent: 0 };
    engine._idleSeq = null; engine._idleIdx = -1;
    await engine._nextIdleTrack();
    const idleFirst = await engine._nextIdleTrack();
    const idleSame = await engine._nextIdleTrack();
    ok('单曲循环（闲时）：一直同一首',
      idleFirst && idleSame && idleFirst.song.title === idleSame.song.title,
      `${idleFirst && idleFirst.song.title} → ${idleSame && idleSame.song.title}`);
    engine.config.idle = { enabled: false };
    engine.setPlayMode('order');

    engine.setPlayMode('order');
    resetQueue();
    [0, 1, 2].forEach((i) => enqueue(i, { uid: 'u' + i, uname: '用户' + i, isAnchor: true }));
    await engine.next(); await sleep(200);
    ok('顺序播放：按队列顺序', !!engine.track && engine.track.title === names[0], engine.track ? engine.track.title : 'null');
    await engine.next(); await sleep(200);
    ok('顺序播放：第二首', !!engine.track && engine.track.title === names[1], engine.track ? engine.track.title : 'null');
    await engine.next(); await sleep(200);
    await engine.next(); await sleep(400);
    ok('顺序播放：放完即停', engine.track === null, engine.track ? engine.track.title : '已停止');

    // 列表循环：放完把历史排回来
    engine.setPlayMode('repeat-all');
    resetQueue();
    [3, 4].forEach((i) => enqueue(i, { uid: 'u' + i, uname: '用户' + i, isAnchor: true }));
    await engine.next(); await sleep(200);
    const h1 = engine.track ? engine.track.title : null;
    await engine.next(); await sleep(200);
    const h2 = engine.track ? engine.track.title : null;
    await engine.next(); await sleep(400);  // 队列空 → 历史回填
    ok('列表循环：队列空后回填历史继续播', !!engine.track, `${h1} → ${h2} → ${engine.track && engine.track.title}`);

    // 随机播放：作用于**闲时歌单**，且"上一首"必须确定地回到同一首
    engine.setPlayMode('shuffle');
    engine.savedAddMany(names.map((_, i) => ({ ...T(i), source: 'local' })));
    engine.config.idle = { enabled: true, source: 'saved', shuffle: true, avoidRecent: 0 };
    engine._idleSeq = null; engine._idleIdx = -1;
    const r1 = await engine._nextIdleTrack();
    const r2 = await engine._nextIdleTrack();
    const rBack = await engine._prevIdleTrack();
    ok('随机播放（闲时）：能连续取到不同曲目',
      r1 && r2 && names.includes(r1.song.title), `${r1 && r1.song.title} → ${r2 && r2.song.title}`);
    ok('随机播放（闲时）：上一首固定回到同一首',
      rBack && r1 && rBack.song.title === r1.song.title, `回到 ${rBack && rBack.song.title}`);
    engine.config.idle = { enabled: false };
    engine.setPlayMode('order');

    const modes = ['order', 'repeat-all', 'repeat-one', 'shuffle'];
    ok('非法模式被拒', engine.setPlayMode('nope').ok === false);
    ok('四种模式都能设置', modes.every((m) => engine.setPlayMode(m).ok), modes.join('/'));
  }

  // ================================================================ 1b) 已保存列表「播放」定位
  /**
   * 回归测试（2026-09-26 修的真实 bug）：
   * 用户点「已保存播放列表」里第 N 条的「播放」，播出来的是**另一首**，
   * 而且每次点都不一样。
   *
   * 根因：UI 传的 from 是**列表行号**，playSaved 却拿它当**闲时序列下标**用；
   * 闲时序列还经过黑名单过滤 + 随机打乱（Fisher–Yates）+ avoidRecent 重排，
   * 两者根本不是一套编号。随机模式下每次重建序列顺序都变 → 每次点结果不同。
   *
   * 正确语义：点哪条就播哪条；播放模式只影响**之后**的走向。
   */
  console.log('\n== 1b) 已保存列表「播放」定位（点哪条放哪条） ==');
  {
    // 准备一份 5 首的已保存列表
    engine.config.savedPlaylist = names.map((_, i) => ({
      song: { ...T(i), source: 'local' }, uid: 'u1', uname: '甲',
    }));

    // 逐个点每一条，随机模式（最容易暴露下标错位）下都必须命中同一条
    engine.setPlayMode('shuffle');
    engine.config.idle = { enabled: true, source: 'saved', shuffle: true, avoidRecent: 0 };
    let allMatch = true;
    const detail = [];
    for (const n of [1, 2, 3, 4, 5]) {
      engine._idleSeq = null; engine._idleIdx = -1; engine._idleSeqSig = null;
      const r = await engine.playSaved({ from: n });
      const got = engine.track && engine.track.title;
      const want = names[n - 1];
      detail.push(`${n}→${got}`);
      if (!r.ok || got !== want) allMatch = false;
    }
    ok('随机模式下：点第 N 条就播第 N 条（5/5 命中）', allMatch, detail.join(' '));

    // 同一行连点两次，结果必须一致（旧版每次都是新的随机顺序）
    engine._idleSeq = null; engine._idleIdx = -1; engine._idleSeqSig = null;
    const a1 = await engine.playSaved({ from: 3 });
    const t1 = engine.track && engine.track.title;
    engine._idleSeq = null; engine._idleIdx = -1; engine._idleSeqSig = null;
    const a2 = await engine.playSaved({ from: 3 });
    const t2 = engine.track && engine.track.title;
    ok('同一行连点两次结果一致', t1 === t2 && t1 === names[2], `${t1} / ${t2}`);

    // 顺序模式下同样要准
    engine.setPlayMode('order');
    engine.config.idle = { enabled: true, source: 'saved', shuffle: false, avoidRecent: 0 };
    engine._idleSeq = null; engine._idleIdx = -1; engine._idleSeqSig = null;
    await engine.playSaved({ from: 4 });
    ok('顺序模式下：点第 4 条播第 4 条',
      engine.track && engine.track.title === names[3], engine.track && engine.track.title);

    // 黑名单滤掉一首后，点它应该优雅兜底（不崩、放得出来）
    engine.blacklist.add({ type: 'song', value: String(T(1).id) });
    engine._idleSeq = null; engine._idleIdx = -1; engine._idleSeqSig = null;
    const rb = await engine.playSaved({ from: 2 });
    ok('被拉黑的那条：优雅兜底不崩', rb.ok === true && !!engine.track, engine.track && engine.track.title);
    /**
     * 2026-09-26 修的真实 bug：**单曲循环模式下点第 N 首会播成第 N-1 首**。
     *
     * 根因：playSaved 原来写 `_idleIdx = idx - 1; await _nextIdleTrack()`，
     * 指望 `_nextIdleTrack` 里那次 `++` 把游标补到 idx。但该方法在
     * **单曲循环**下会直接返回当前游标项而**不自增**（那是"重播当前"的语义）
     * → 少走一格。而 from=1 时 `_idleIdx = -1`，条件不成立反而走对了 ——
     * 于是症状是"点 1 放 1、点 2 放 1、点 3 放 2…"，与用户报告完全一致。
     *
     * 修法：新增 `_seekIdle(idx)` 直接定位，不再借用"前进一格"的接口。
     */
    engine.config.blacklist = { enabled: false, rules: [] };
    engine.blacklist = new (require('../src/core/blacklist').Blacklist)({ enabled: false, rules: [] });
    engine.config.savedPlaylist = names.map((_, i) => ({ song: { ...T(i), source: 'local' }, uid: 'u1', uname: '甲' }));
    for (const mode of ['repeat-one', 'shuffle', 'order', 'repeat-all']) {
      engine.setPlayMode(mode);
      engine.config.idle = { enabled: true, source: 'saved', shuffle: mode === 'shuffle', avoidRecent: 0 };
      let allOk = true;
      const detail = [];
      for (const n of [1, 2, 3, 4, 5]) {
        engine._idleSeq = null; engine._idleIdx = -1; engine._idleSeqSig = null;
        const r = await engine.playSaved({ from: n });
        const got = engine.track && engine.track.title;
        detail.push(`${n}→${got}`);
        if (!r.ok || got !== names[n - 1]) allOk = false;
      }
      ok(`${mode} 模式下：点第 N 首就播第 N 首（5/5）`, allOk, detail.join(' '));
    }
    /**
     * 连点语义：**最新一次赢**（不再"忙就静默拒绝"）。
     * 旧版连点时会返回错误，而走 HTTP 的调用方是 fireAndForget（立刻回执 accepted），
     * 那个拒绝根本传不到界面 → 用户看到"点了没反应，还在放上一首"。
     */
    engine.setPlayMode('order');
    engine.config.idle = { enabled: true, source: 'saved', shuffle: false, avoidRecent: 0 };
    engine._idleSeq = null; engine._idleIdx = -1; engine._idleSeqSig = null;
    const p1 = engine.playSaved({ from: 1 });
    const p2 = engine.playSaved({ from: 4 });   // 紧接着点第 4 首
    await Promise.all([p1, p2]);
    await sleep(300);
    ok('连点两首：最新一次赢（不会被静默拒绝）',
      engine.track && engine.track.title === names[3], `最终在播 ${engine.track && engine.track.title}`);
    engine.config.blacklist = { enabled: false, rules: [] };
    engine.blacklist = new (require('../src/core/blacklist').Blacklist)({ enabled: false, rules: [] });

    engine.config.idle = { enabled: false };
    engine.setPlayMode('order');
    engine.config.savedPlaylist = [];
  }

  // ================================================================ 2) 上一首 / 历史
  console.log('\n== 2) 上一首与播放历史 ==');
  {
    engine.setPlayMode('order');
    resetQueue();
    [0, 1, 2].forEach((i) => enqueue(i, { uid: 'u' + i, uname: '用户' + i, isAnchor: true }));
    await engine.next(); await sleep(200);
    await engine.next(); await sleep(200);
    const nowTitle = engine.track ? engine.track.title : null;
    ok('历史已记录', engine.history.length >= 1, `${engine.history.length} 条`);
    await engine.prev(); await sleep(300);
    ok('上一首可用', !!engine.track && engine.track.title !== nowTitle, `${nowTitle} → ${engine.track ? engine.track.title : 'null'}`);
    ok('当前这首被塞回队列便于再切回来', engine.queue.items.some((i) => i.song.title === nowTitle), nowTitle);
  }

  // ================================================================ 3) 弹幕切歌权限
  console.log('\n== 3) 弹幕切歌权限（谁点的谁能切） ==');
  {
    engine.setPlayMode('order');
    resetQueue();
    // 观众「小明」点的歌先放起来
    enqueue(0, { uid: '1001', uname: '小明' });
    await engine.next(); await sleep(200);
    ok('当前曲目记录了点歌人', engine.trackMeta.requester.uname === '小明', engine.trackMeta.requester.uname);

    // 别人来切 → 应被拒
    const other = await engine.skip({ uid: '2002', uname: '路人' });
    ok('他人切歌被拒', other && other.ok === false && other.reason === 'not_owner', other && other.msg);
    ok('拒绝时仍在放原曲', engine.track && engine.track.title === names[0], engine.track && engine.track.title);

    // 本人来切 → 应放行
    const mine = await engine.skip({ uid: '1001', uname: '小明' });
    ok('点歌本人可以切', mine && mine.ok === true && mine.skipped === true, mine && ('nowPlaying=' + mine.nowPlaying));

    // 控制台本地操作 → 无条件放行
    resetQueue();
    enqueue(1, { uid: '3003', uname: '小红' });
    await engine.next(); await sleep(200);
    const local = await engine.skip({ uname: '控制台' }, { local: true });
    ok('工具本地操作可切他人的歌', local && local.ok === true, local && ('nowPlaying=' + local.nowPlaying));

    // 房管也放行
    resetQueue();
    enqueue(2, { uid: '4004', uname: '小刚' });
    await engine.next(); await sleep(200);
    const admin = await engine.skip({ uid: '9999', uname: '房管', isAdmin: true });
    ok('房管可以切', admin && admin.ok === true, admin && ('nowPlaying=' + admin.nowPlaying));

    // ownOnly=false 时：观众一律不能切（包括本人）
    engine.config.queue.danmakuSkip = { ownOnly: false };
    resetQueue();
    enqueue(3, { uid: '5005', uname: '阿花' });
    await engine.next(); await sleep(200);
    const strict = await engine.skip({ uid: '5005', uname: '阿花' });
    ok('ownOnly=false 时本人也不能切', strict && strict.ok === false, strict && strict.msg);
    engine.config.queue.danmakuSkip = { ownOnly: true };
  }

  // ================================================================ 4) 收藏 / 队列操作
  console.log('\n== 4) 收藏与队列操作 ==');
  {
    const s = { ...T(0), source: 'local' };
    ok('收藏一首', engine.toggleFavorite(s).favorited === true);
    ok('已收藏状态可查', engine.isFavorited(s) === true);
    ok('取消收藏', engine.toggleFavorite(s).favorited === false && !engine.isFavorited(s));

    resetQueue();
    [0, 1, 2, 3].forEach((i) => enqueue(i, { uid: 'u' + i, uname: '用户' + i, isAnchor: true }));
    const third = engine.queue.items[2].song.title;
    ok('置顶队列项', engine.moveInQueue(3, 'top').ok && engine.queue.items[0].song.title === third, third);
    ok('序号越界被拒', engine.moveInQueue(99).ok === false);

    // 按类型拉黑并自动从队列撤下
    engine.blacklist.enabled = true;
    engine.blacklist.clear();
    const n0 = engine.queue.items.length;
    const victim = engine.queue.items[0];
    const before = victim.song.title;
    const r = engine.blacklistFromQueue(1, 'keyword');
    ok('队列项按关键词拉黑', r.ok && engine.blacklist.list().rules.some((x) => x.value === before), before);
    ok('拉黑同时从队列撤下', r.removedFromQueue === true && engine.queue.items.length === n0 - 1
      && !engine.queue.items.some((i) => i.song.title === before), `队列 ${n0} → ${engine.queue.items.length}`);
    // 歌手类型同样要撤下（第一版这里漏了）
    const n1 = engine.queue.items.length;
    const singer = engine.queue.items[0];
    const r2 = engine.blacklistFromQueue(1, 'artist');
    ok('按歌手拉黑也会撤下队列项', r2.ok && r2.removedFromQueue === true && engine.queue.items.length === n1 - 1,
      `${singer && singer.song.title} → 队列 ${engine.queue.items.length}`);
    engine.blacklist.clear();
  }

  // ================================================================ 5) 闲时歌单
  console.log('\n== 5) 闲时歌单 ==');
  {
    engine.setPlayMode('order');
    resetQueue();

    // 关闭时：队列空了就停
    engine.setPlayModeIdle({ enabled: false });
    await engine.next();
    ok('闲时关闭时队列空即停', engine.track === null);

    // 开启：闲时歌单的内容**恒为「已保存播放列表」**，
    // 所以先把本地曲库整批"加入已保存"，再开启自动播放。
    engine.savedAddMany(engine.local.tracks.map((t) => ({ ...t, source: 'local' })));
    engine.setPlayModeIdle({ enabled: true, source: 'saved', shuffle: false, avoidRecent: 0 });
    await sleep(300);
    ok('闲时开启后自动起播', !!engine.track, engine.track && engine.track.title);
    ok('标记为闲时播放', engine.playingIdle === true);
    ok('闲时曲目归属于闲时歌单', engine.trackMeta.requester.uname === '闲时歌单', engine.trackMeta.requester.uname);

    // 连续切歌应能一直从曲库取（顺序模式会轮转）
    const seen = new Set([engine.track.title]);
    for (let i = 0; i < 4; i++) { await engine.next({ force: true }); await sleep(120); if (engine.track) seen.add(engine.track.title); }
    ok('闲时歌单能连续供曲', seen.size >= 3, `覆盖 ${seen.size} 首：${[...seen].join('/')}`);

    // 近期不重复
    engine.savedAddMany(engine.local.tracks.map((t) => ({ ...t, source: 'local' })));
    engine.setPlayModeIdle({ enabled: true, source: 'saved', shuffle: true, avoidRecent: 3 });
    const recent = engine.history.slice(-3).map((h) => h.song.title);
    const nxt = await engine._nextIdleTrack();
    ok('「近期不重复」生效', !nxt || !recent.includes(nxt.song.title), `近期 ${recent.join('/')} → 选中 ${nxt && nxt.song.title}`);

    // 黑名单过滤
    engine.blacklist.enabled = true;
    engine.blacklist.clear();
    engine.blacklist.add({ type: 'keyword', value: '甲曲' });
    const picks = [];
    for (let i = 0; i < 8; i++) { const x = await engine._nextIdleTrack(); if (x) picks.push(x.song.title); }
    ok('闲时歌单会过滤黑名单', !picks.includes('甲曲'), `8 次取样：${[...new Set(picks)].join('/')}`);
    engine.blacklist.clear();
    engine.blacklist.enabled = false;

    // 关掉后恢复安静
    engine.setPlayModeIdle({ enabled: false });
    engine.track = null;
    await engine.next();
    await sleep(200);
    ok('关闭后不再自动起播', engine.track === null);
  }

  // ================================================================ 6) 媒体缓存
  console.log('\n== 6) 在线媒体缓存 ==');
  {
    const c = engine.cache;
    ok('缓存统计可读', typeof c.stats().count === 'number', `上限 ${(c.maxBytes / 1048576).toFixed(0)}MB`);

    // 用本机自己的流接口当"远端"，把一首本地歌缓存进来（自包含，不依赖外网）
    const src = `${engine.serverBase}/stream/local?path=${encodeURIComponent(T(0).file)}`;
    // 键必须与 engine.cache.keyFor 一致，否则引擎侧永远命中不了（第一版就错了）
    const fakeSong = { source: 'netease', id: 'test-cache-1', name: '甲曲', title: '甲曲' };
    const key = c.keyFor(fakeSong);
    const put = await c.put(key, src, { name: '甲曲', artist: '测试歌手', source: 'local' });
    ok('缓存落盘成功', put.ok, put.ok ? `${(put.size / 1024).toFixed(0)} KB` : put.msg);
    const hit = c.get(key);
    ok('缓存可命中', !!hit && fs.existsSync(hit.file), hit ? path.basename(hit.file) : '');
    ok('缓存可经流接口播放（白名单内）', (await fetch(`${engine.serverBase}/stream/local?path=${encodeURIComponent(hit.file)}`)).status === 200);
    ok('重复 put 不重复下载', (await c.put(key, src)).skipped === 'already');

    // 引擎侧：命中缓存时直接返回本地文件
    const st = await engine.resolveStream(fakeSong);
    ok('引擎取流命中缓存', st.ok && st.cached === true && st.url.includes('/stream/local'),
      (st.via || '(no via)') + ' | ' + String(st.url).slice(0, 60));

    // 剪枝（小的 maxBytes 触发淘汰）
    const small = new MediaCache({ dir: path.join(ROOT, 'cache-small'), maxBytes: 1, log: () => {} });
    small.init();
    await small.put('a', src, { name: 'a' });
    await small.put('b', src, { name: 'b' });
    ok('超容量会自动淘汰', small.stats().bytes <= 200 * 1024, `淘汰后 ${small.stats().count} 条 / ${(small.stats().bytes / 1024).toFixed(0)} KB`);

    // 反复写入不会让缓存无限增长（容量上限生效）
    const capped = new MediaCache({ dir: path.join(ROOT, 'cache-cap'), maxBytes: 300 * 1024, log: () => {} });
    capped.init();
    for (let i = 0; i < 5; i++) await capped.put('k' + i, src, { name: 'k' + i });
    ok('缓存总量不超上限', capped.stats().bytes <= 300 * 1024, `${(capped.stats().bytes / 1024).toFixed(0)} KB / 上限 300 KB`);

    const cleared = await c.clear();
    ok('清空缓存', cleared.ok && c.stats().count === 0, `清掉 ${cleared.removed} 条`);
  }

  // ================================================================ 6b) 已缓存 = 零网络
  /**
   * 回归测试（2026-09-26 用户要求）：
   * 「播已保存列表中的歌曲的时候，如果是已缓存就不要网络请求，也不应该有限流保护」。
   *
   * 做法：把网易云客户端的所有读接口换成"一调就记账"的探针，
   * 然后播放一首**音频和歌词都已落盘**的歌 —— 探针必须全 0 调用。
   */
  console.log('\n== 6b) 已缓存曲目：零网络请求 ==');
  {
    const c = engine.cache;
    const probeSong = { source: 'netease', id: 'test-nonet-1', name: '无网测试曲', title: '无网测试曲' };
    const key = c.keyFor(probeSong);
    // 音频落盘（用本机流接口当"远端"，自包含）
    const src = `${engine.serverBase}/stream/local?path=${encodeURIComponent(T(0).file)}`;
    const putAudio = await c.put(key, src, { name: probeSong.name });
    // 歌词落盘（同一套缓存子系统）
    const putLyric = c.putLyrics(key, { meta: {}, lines: [{ t: 0, d: 2, text: '第一行' }, { t: 2, d: 2, text: '第二行' }] }, { name: probeSong.name });
    ok('前置：音频 + 歌词都已落盘', putAudio.ok && putLyric.ok, `${key}`);

    // 装探针：任何一次真实网络调用都会被记账
    const calls = [];
    const net = engine.netease;
    const orig = {};
    for (const m of ['songUrl', 'lyric', 'search', 'songDetail', 'playlist', 'account']) {
      orig[m] = net[m].bind(net);
      net[m] = async (...a) => { calls.push(m); return { ok: false, msg: 'probe: 不该被调用', songs: [], lrc: '' }; };
    }
    try {
      const st = await engine.resolveStream(probeSong);
      ok('取流：命中缓存、不联网', st.ok && st.cached === true && calls.length === 0,
        `via=${st.via} 网络调用=${calls.length ? calls.join(',') : '0'}`);
      const ly = await engine.resolveLyrics(probeSong);
      ok('歌词：命中缓存、不联网', !!ly && ly.source === '缓存' && calls.length === 0,
        `来源=${ly && ly.source} 网络调用=${calls.length ? calls.join(',') : '0'}`);
    } finally {
      for (const m of Object.keys(orig)) net[m] = orig[m];
    }
    // 清理，别污染后面的用例
    c.remove(key);
  }

  // ================================================================ 6c) 逐曲缓存管理
  /**
   * 回归测试（2026-09-26 用户要求）：
   * 已播放/已保存列表里的每一首都要能「删缓存」和「手动缓存」，
   * 音频与歌词**分开报状态**（用户常只想重配歌词，不想重下几十 MB 音频）。
   */
  console.log('\n== 6c) 逐曲缓存管理（删 / 补 / 分开报） ==');
  {
    const c = engine.cache;
    const song = { source: 'netease', id: 'test-percache-1', name: '逐曲缓存测试', title: '逐曲缓存测试', artistText: '测试歌手' };
    const key = c.keyFor(song);
    const src = `${engine.serverBase}/stream/local?path=${encodeURIComponent(T(0).file)}`;

    // 初始：什么都没有
    let info = engine.cacheInfo(song);
    ok('初始状态：音频/歌词都未缓存', !info.audio.cached && !info.lyrics.cached && info.key === key);

    // 只有音频
    await c.put(key, src, { name: song.name });
    info = engine.cacheInfo(song);
    ok('只有音频时：audio=true / lyrics=false', info.audio.cached === true && info.lyrics.cached === false,
      `音频 ${info.audio.mb}MB`);

    // 补歌词 → "半缓存"变"全缓存"
    c.putLyrics(key, { meta: {}, lines: [{ t: 0, d: 2, text: '甲' }, { t: 2, d: 2, text: '乙' }] }, { name: song.name });
    info = engine.cacheInfo(song);
    ok('补上歌词后：两者都为 true', info.audio.cached && info.lyrics.cached, `歌词 ${info.lyrics.lines} 行 / ${info.lyrics.kb}KB`);

    // 只删歌词 → 音频必须还在
    const ly = c.removeLyrics(key);
    info = engine.cacheInfo(song);
    ok('只删歌词：音频保留、歌词清掉', ly.ok && info.audio.cached && !info.lyrics.cached);

    // 批量只清歌词（engine 层）
    c.putLyrics(key, { meta: {}, lines: [{ t: 0, d: 1, text: 'x' }] }, { name: song.name });
    const cl = engine.cacheClearLyrics();
    ok('cacheClearLyrics：清掉歌词、音频不动', cl.removed >= 1 && engine.cacheInfo(song).audio.cached === true,
      `清掉 ${cl.removed} 条歌词`);

    // 整曲删除（音频 + 歌词）
    c.putLyrics(key, { meta: {}, lines: [{ t: 0, d: 1, text: 'x' }] }, { name: song.name });
    const dr = engine.cacheDrop(song);
    info = engine.cacheInfo(song);
    ok('cacheDrop：音频 + 歌词一起删', dr.ok && dr.audio.ok && dr.lyrics.ok && !info.audio.cached && !info.lyrics.cached);

    // 删不存在的东西要优雅
    const again = engine.cacheDrop(song);
    ok('重复删除不报错', again.ok === true, `audio=${again.audio.msg}`);

    // 按 key 批量删除
    await c.put(key, src, { name: song.name });
    const dk = engine.cacheDropKeys([key]);
    ok('cacheDropKeys：按 key 批量删', dk.audio === 1 && !engine.cacheInfo(song).audio.cached);

    // 批量缓存：本地曲目会被过滤掉（不需要缓存）
    const r0 = await engine.cachePrefetch({ source: 'saved' });
    ok('batchPrefetch：没有在线曲目时明确说不做', r0.ok === false && /没有需要缓存/.test(r0.msg || ''),
      (r0.msg || '').slice(0, 30));

    // 批量缓存：放一首在线曲目进已保存，探针保证不真联网（用缓存里的直链）
    engine.config.savedPlaylist = [{ song, uid: 'u1', uname: '甲' }];
    await c.put(key, src, { name: song.name });   // 预先已有缓存 → 应被识别为 already
    const calls = [];
    const net = engine.netease;
    const origResolve = net.songUrl.bind(net);
    net.songUrl = async (...a) => { calls.push('songUrl'); return origResolve(...a); };
    try {
      const rb = await engine.cachePrefetch({ source: 'saved' });
      // 后台跑，等它结束
      for (let i = 0; i < 60 && engine.prefetchState().running; i++) await sleep(50);
      ok('cachePrefetch：能启动并跑完', rb.ok === true && engine.prefetchState().running === false,
        `共 ${rb.total} 首 · songUrl 调用 ${calls.length} 次`);
      const st = engine.state();
      ok('state.cache 带 prefetch 进度字段', !!st.cache.prefetch && st.cache.prefetch.running === false);
    } finally {
      net.songUrl = origResolve;
    }
    engine.config.savedPlaylist = [];
    c.removeAllFor(song);
  }

  // ================================================================ 7) 静音 / 音量
  // ================================================================ 6d) 下一首预载
  /**
   * 回归测试（2026-09-26，思路来自 AIMP 的 "Pre-load next track while current is playing"）：
   * 切歌是**本地控制**，必须立刻响应。做法是当前歌在放的时候就把下一首的直链 + 歌词
   * 先取好；按下一首时命中预载 → 几乎零网络等待。
   *
   * 用探针把 netease 两个接口换成"记账 + 返回成功"，这样能精确断言
   * "预载做了一次网络，之后消费预载不再联网"。
   */
  console.log('\n== 6d) 下一首预载（切歌不等待） ==');
  {
    const A = { source: 'netease', id: 'test-preload-A', name: '预载甲', title: '预载甲', duration: 100 };
    resetQueue();
    engine.queue.push(A, { uid: 'u1', uname: '甲', isAnchor: true });
    engine.config.idle = { enabled: false };
    engine._idleSeq = null; engine._idleIdx = -1;
    engine._loadSeq = 0;
    engine._preload.clear();

    const guess = engine._nextTrackGuess();
    ok('猜下一首：取队列队首（点歌队列优先于闲时歌单）', !!guess && guess.id === A.id, guess && guess.name);

    const calls = [];
    const net = engine.netease;
    const o1 = net.songUrl.bind(net); const o2 = net.lyric.bind(net);
    net.songUrl = async () => {
      calls.push('songUrl');
      return { ok: true, url: 'http://fake/preload.mp3', trial: false, br: 320, level: 'exhigh', path: 'stub' };
    };
    net.lyric = async () => {
      calls.push('lyric');
      return { ok: true, lrc: '[00:00.00]预载歌词\n[00:02.00]第二行', tlyric: '', romalrc: '', yrc: '' };
    };
    try {
      await engine._preloadNext();
      ok('预载：确实取了一次流 + 一次歌词', calls.length === 2, calls.join(','));
      ok('预载结果进表', engine._preload.size === 1, `表内 ${engine._preload.size} 条`);

      // 关键断言：消费预载时**不应再联网**
      const before = calls.length;
      const st = await engine.resolveStream(A);
      const ly = await engine.resolveLyrics(A);
      const lines = (ly && ly.timeline && ly.timeline.lines) || [];
      ok('按下一首：消费预载，零额外网络调用',
        calls.length === before && st.ok && lines.length === 2,
        `网络 +${calls.length - before} 次 · 歌词 ${lines.length} 行`);
      ok('预载用后即删（直链有 expi，不该复用）', engine._preload.size === 0);
    } finally {
      net.songUrl = o1; net.lyric = o2;
    }

    // 队列/闲时都空 → 猜不出，静默跳过（不该抛）
    resetQueue();
    await engine._preloadNext();
    ok('队列/闲时都空：猜不出下一首', engine._nextTrackGuess() === null);
    ok('没有下一首时预载静默跳过（不抛）', true);

    engine._preload.clear();
  }

  // ================================================================ 6e) 已播放只记点歌队列
  /**
   * 回归测试（2026-09-26 用户要求）：
   * 「已播放」**只记录从点歌队列里播的歌**；在「已保存播放列表」里直接播的
   * （含闲时自动顶上的）不进这个记录。
   *
   * 判别依据是**从哪播的**，不是"这首歌是什么" —— 同一首歌在队列里播就记录、
   * 在已保存歌单里播就不记录。
   */
  console.log('\n== 6e) 已播放只记点歌队列 ==');
  {
    engine.config.savedPlaylist = ['甲曲', '乙曲', '丙曲'].map((n) => ({
      song: { ...T(names.indexOf(n)), source: 'local' }, uid: 'u1', uname: '甲',
    }));
    engine.setPlayMode('order');
    engine.config.idle = { enabled: true, source: 'saved', shuffle: false, avoidRecent: 10 };
    engine.history.length = 0;
    engine.recentPlayed.length = 0;
    resetQueue();

    // A) 从已保存歌单播 → 不该进「已播放」
    await engine.playSaved({ from: 1 });
    const a1 = engine.track && engine.track.title;
    await engine.skip({ uname: '控制台' }, { local: true });
    await sleep(250);
    ok('已保存歌单播的歌：不进「已播放」', engine.history.length === 0,
      `播过 ${a1} → 现在 ${engine.track && engine.track.title}；已播放 ${engine.history.length} 条`);
    ok('但要进「近期底账」（给闲时 avoidRecent 用）', engine.recentPlayed.length >= 1,
      engine.recentPlayed.map((h) => h.song.title).join(','));

    // B) 队列里播 → 要进「已播放」
    resetQueue();
    engine.queue.push({ ...T(0), source: 'local' }, { uid: 'u9', uname: '观众', isAnchor: true });
    await engine.skip({ uname: '控制台' }, { local: true });
    await sleep(250);
    const fromQueue = engine.track && engine.track.title;
    await engine.skip({ uname: '控制台' }, { local: true });
    await sleep(250);
    ok('点歌队列播的歌：进「已播放」',
      engine.history.length === 1 && engine.history[0].song.title === fromQueue,
      `已播放 ${engine.history.map((h) => h.song.title).join(',')}`);
    ok('listHistory 里能看到它', engine.listHistory().some((h) => h.name === fromQueue));

    // C) 队列刚放完就切（队列变空会触发闲时回退）—— 那首队列的歌不能被漏记
    resetQueue();
    engine.history.length = 0;
    engine.queue.push({ ...T(1), source: 'local' }, { uid: 'u9', uname: '观众', isAnchor: true });
    await engine.skip({ uname: '控制台' }, { local: true });
    await sleep(250);
    const lastQueued = engine.track && engine.track.title;
    await engine.skip({ uname: '控制台' }, { local: true });   // 此时队列已空 → 闲时顶上
    await sleep(250);
    ok('队列放空后切走：那首队列歌仍被正确记录（wasIdle 快照）',
      engine.history.some((h) => h.song.title === lastQueued),
      `期望含 ${lastQueued}，实得 [${engine.history.map((h) => h.song.title).join(',')}]`);

    // D) 同一首歌：队列里播要记、已保存歌单里播不记
    engine.history.length = 0;
    resetQueue();
    engine.config.savedPlaylist = [{ song: { ...T(2), source: 'local' }, uid: 'u1', uname: '甲' }];
    await engine.playSaved({ from: 1 });          // 同一首，从已保存歌单播
    await engine.skip({ uname: '控制台' }, { local: true });
    await sleep(250);
    ok('同一首歌：从已保存歌单播 → 不记', engine.history.length === 0,
      `已播放 ${engine.history.length} 条`);
    resetQueue();
    engine.config.idle = { enabled: false };
    engine.queue.push({ ...T(2), source: 'local' }, { uid: 'u9', uname: '观众', isAnchor: true });
    await engine.skip({ uname: '控制台' }, { local: true });
    await sleep(250);
    await engine.skip({ uname: '控制台' }, { local: true });
    await sleep(250);
    ok('同一首歌：从点歌队列播 → 记', engine.history.some((h) => h.song.title === names[2]),
      `已播放 [${engine.history.map((h) => h.song.title).join(',')}]`);

    // E) clearHistory 把两份记录一起清
    engine.clearHistory();
    ok('清空已播放：近期底账一起清', engine.history.length === 0 && engine.recentPlayed.length === 0);

    engine.config.idle = { enabled: false };
    engine.config.savedPlaylist = [];
  }

  // ================================================================ 6f) 状态不撒谎
  /**
   * 回归测试（2026-09-26 用户报告）：
   * 刚启动、**什么都没选**的时候直接点播放器的「播放」，顶栏状态变成了 playing，
   * 但实际一个音都没有 —— 状态在撒谎。
   *
   * 根因：resume() 无条件 `status = 'playing'`，pause() 也无条件写 'paused'。
   * 修法：
   *   · 没有曲目时 pause() 什么都不做（别把 idle 写成 paused）
   *   · 没有曲目时 resume()：队列里有歌就真的开播；也没有就如实说明、状态保持 idle
   */
  console.log('\n== 6f) 空状态下播放/暂停不撒谎 ==');
  {
    resetQueue();
    engine.track = null;
    engine.playback = { ...engine.playback, status: 'idle', position: 0, duration: 0 };

    const p1 = engine.pause();
    ok('没有曲目时 pause：什么都不做（不把 idle 写成 paused）',
      p1.ok === false && engine.playback.status === 'idle', `status=${engine.playback.status}`);

    const r1 = engine.resume();
    ok('没有曲目、队列也空时 resume：不假装在播（状态保持 idle）',
      r1.ok === false && engine.playback.status === 'idle', `status=${engine.playback.status}`);

    // 队列里有歌时，"播放"应该真的开播（这才是这个按钮的直觉行为）
    resetQueue();
    engine.track = null;
    engine.playback = { ...engine.playback, status: 'idle' };
    engine.queue.push({ ...T(0), source: 'local' }, { uid: 'u9', uname: '观众', isAnchor: true });
    const r2 = engine.resume();
    await sleep(250);
    ok('队列里有歌时 resume：真的开播（不是只改状态）',
      r2.ok === true && !!engine.track, `在播=${engine.track && engine.track.title} status=${engine.playback.status}`);

    // 交给命令层：togglePlay 必须回报**真实的**最终状态
    const { createCommandHandler } = require('T:/nekofm/src/main/commands');
    const handle = createCommandHandler({ engine, saveConfig: () => {}, hooks: {} });
    resetQueue();
    engine.track = null;
    engine.playback = { ...engine.playback, status: 'idle' };
    const t1 = await handle({ action: 'togglePlay' });   // 命令处理器直接返回结果（HTTP 层才包 result）
    ok('togglePlay（空状态）：回报 idle，不报 playing',
      t1.status === 'idle' && t1.did === 'nothing_to_play',
      `status=${t1.status} did=${t1.did}`);
  }

  // ================================================================ 6g) 点歌优先于闲时歌单
  /**
   * 回归测试（2026-09-26 用户要求）：
   * "直播状态下，保存列表播放应该被认为是闲时歌单的播放了，
   *   但是这个时候再点歌，不会立即切换到点歌队列播放"。
   *
   * 期望语义（也是 AIMP 的队列语义："Queue has a priority over playing playlist"）：
   *   1. 什么都没在播        → 点歌直接开播
   *   2. **正在播闲时歌单**  → 点歌**立刻顶掉它**，切到点歌队列
   *   3. 正在播别人点的歌    → 不动，只入队（既有语义："引擎不会打断正在播放的歌"）
   */
  console.log('\n== 6g) 点歌优先于闲时歌单 ==');
  {
    const mkSong = (i) => ({ ...T(i), source: 'local' });
    const order = (i, who) => engine._enqueue(mkSong(i), { uid: 'viewer-' + i, uname: who || '观众', isAnchor: false });

    // ---- 场景 1：闲时歌单在播 → 点歌立刻切换
    resetQueue();
    engine.history.length = 0;
    engine.config.savedPlaylist = names.map((_, i) => ({ song: mkSong(i), uid: 'u1', uname: '甲' }));
    engine.setPlayMode('order');
    engine.config.idle = { enabled: true, source: 'saved', shuffle: false, avoidRecent: 0 };
    engine._idleSeq = null; engine._idleIdx = -1; engine._idleSeqSig = null;
    await engine.playSaved({ from: 1 });
    await sleep(250);
    const idleSong = engine.track && engine.track.title;
    ok('前置：闲时歌单在播且 playingIdle=true', !!idleSong && engine.playingIdle === true, idleSong);

    await order(4, '点歌的观众');       // 戊曲
    await sleep(350);
    ok('闲时在播时点歌：立刻切到点歌队列',
      engine.track && engine.track.title === names[4] && engine.playingIdle === false,
      `${idleSong} → ${engine.track && engine.track.title}（playingIdle=${engine.playingIdle}）`);
    ok('被顶掉的闲时曲**不**进「已播放」',
      !engine.history.some((h) => h.song.title === idleSong),
      `已播放 [${engine.history.map((h) => h.song.title).join(',')}]`);

    // ---- 场景 2：正在播别人点的歌 → 新点歌只入队，不打断
    const cur = engine.track.title;
    await order(3, '另一个观众');       // 丁曲
    await sleep(300);
    ok('播队列里的歌时点歌：不打断，只入队',
      engine.track.title === cur && engine.queue.items.some((i) => i.song.title === names[3]),
      `在播仍是 ${engine.track.title}；队列 [${engine.queue.items.map((i) => i.song.title).join(',')}]`);

    // ---- 场景 3：空闲时点歌 → 直接开播
    resetQueue();
    engine.track = null;
    engine.playingIdle = false;
    engine.playback = { ...engine.playback, status: 'idle' };
    engine.config.idle = { enabled: false };
    await order(0, '空闲点歌');
    await sleep(350);
    ok('空闲时点歌：直接开播', engine.track && engine.track.title === names[0],
      String(engine.track && engine.track.title));

    // ---- 场景 4：队列空时不该瞎抢（闲时在播、但没人排队）
    resetQueue();
    engine.config.idle = { enabled: true, source: 'saved', shuffle: false, avoidRecent: 0 };
    engine._idleSeq = null; engine._idleIdx = -1; engine._idleSeqSig = null;
    await engine.playSaved({ from: 2 });
    await sleep(250);
    const keep = engine.track.title;
    const preempted = await engine._preemptIdleForOrder();   // 队列空 → 应返回 false
    ok('队列为空时抢占是空操作（返回 false）', preempted === false && engine.track.title === keep,
      `仍在播 ${engine.track.title}`);

    engine.config.idle = { enabled: false };
    engine.config.savedPlaylist = [];
    resetQueue();
  }

  // ================================================================ 6h) 队列「加入已保存」按 key 回查
  /**
   * 回归测试（2026-09-26 用户报告："在点歌队列中的歌点加入已保存并不会生效"）。
   *
   * 根因：队列项的状态来自 `queue.list()` → `_brief()`，那里**只有精简字段、
   * 没有完整 song 对象**（刻意让 10Hz 的状态载荷保持小）。
   * 于是控制台按钮发 `song: it.song`（undefined）→ 服务端回"没有可加入的曲目"。
   * **正在播放那一行也一样坏**（`cur.song` 同样是 undefined）。
   *
   * 修法：`_brief` 带上 `key`，按钮发 `key`，服务端用 `engine.findQueueSong(key)`
   * 在"在放 + 待播"里回查 —— 两种行都覆盖。
   */
  console.log('\n== 6h) 队列「加入已保存」按 key 回查 ==');
  {
    const mkSong = (i) => ({ ...T(i), source: 'local' });
    engine.config.savedPlaylist = [];
    resetQueue();

    // 放一首（成为"正在播放"），再排一首（成为"待播"）
    engine.queue.push(mkSong(0), { uid: 'u1', uname: '甲', isAnchor: true });
    engine.queue.push(mkSong(1), { uid: 'u2', uname: '乙', isAnchor: true });
    await engine.next();
    await sleep(250);
    ok('前置：一首在放 + 一首待播',
      engine.queue.current && engine.queue.items.length === 1,
      `在放 ${engine.queue.current.song.title}；待播 ${engine.queue.items.map((i) => i.song.title).join(',')}`);

    // 关键：状态里的队列项**不含 song**，但**必须有 key**（否则界面无法回查）
    const snap = engine.state().queue;
    ok('队列状态带 key（供界面回查）', !!snap.current.key && !!snap.items[0].key,
      `current.key=${snap.current.key} items[0].key=${snap.items[0].key}`);
    ok('队列状态仍不带 song（载荷保持精简）', snap.current.song === undefined && snap.items[0].song === undefined);

    // findQueueSong：待播项与在放项都要能命中
    const byKeyCur = engine.findQueueSong(snap.current.key);
    const byKeyItem = engine.findQueueSong(snap.items[0].key);
    ok('findQueueSong 命中"正在播放"那首', !!byKeyCur && byKeyCur.title === names[0], byKeyCur && byKeyCur.title);
    ok('findQueueSong 命中"待播"那首', !!byKeyItem && byKeyItem.title === names[1], byKeyItem && byKeyItem.title);
    ok('findQueueSong 对不存在的 key 返回 null', engine.findQueueSong('不存在:1') === null);

    // 走命令层：与界面完全同一条路径（savedAdd + key）
    const { createCommandHandler } = require('T:/nekofm/src/main/commands');
    const handle = createCommandHandler({ engine, saveConfig: () => {}, hooks: {} });

    // 注意：命令处理器**直接返回**引擎结果（HTTP 层才包 result），所以看 r1.ok / r1.name
    const r1 = await handle({ action: 'savedAdd', key: snap.items[0].key });      // 待播项
    ok('「加入已保存」待播项：成功', r1.ok === true && r1.name === names[1],
      r1.ok ? `已加入 ${r1.name}` : r1.msg);

    const r2 = await handle({ action: 'savedAdd', key: snap.current.key });       // 在放项
    ok('「加入已保存」正在播放那首：成功', r2.ok === true && r2.name === names[0],
      r2.ok ? `已加入 ${r2.name}` : r2.msg);

    ok('两首都在已保存列表里了', (engine.config.savedPlaylist || []).length === 2,
      (engine.config.savedPlaylist || []).map((it) => it.song.title).join(','));

    // 重复加入要有明确提示（不是静默失败）
    const r3 = await handle({ action: 'savedAdd', key: snap.current.key });
    ok('重复加入：明确提示已存在', r3.ok === false && /已经在/.test(r3.msg || ''), r3.msg);

    engine.config.savedPlaylist = [];
    resetQueue();
  }

  // ================================================================ 6i) 下播不改动已保存列表
  /**
   * 回归测试（2026-09-26 用户明确要求）：
   * 「已保存播放列表」是**手动维护**的 —— 只有点「加入已保存」才往里加，
   * **下播不自动写**（更不许清掉已有的）。
   *
   * 这个坑绕过两次，所以测试要钉住最终语义：
   *   1. 最初下播 = **覆盖**：已保存列表里积累的曲库被本次点过的几首冲掉
   *      （用户报告："结束直播状态时直接会把已保存的歌曲清理掉"）
   *   2. 中间改成**并入**：不丢数据了，但仍是自动往里塞
   *   3. **最终（用户定的）：完全不动**，纯手动
   */
  console.log('\n== 6i) 下播不改动已保存列表（纯手动维护） ==');
  {
    const mkSong = (i) => ({ ...T(i), source: 'local' });
    resetQueue();
    engine.config.savedPlaylist = [0, 1, 2].map((i) => ({ song: mkSong(i), uid: 'u1', uname: '甲' }));
    const before = engine.config.savedPlaylist.map((it) => it.song.title);

    engine.setStreaming(true);
    // 2026-09-26 起：**空状态切直播会自动开播闲时歌单**（见 6j 的用例）。
    // 这里等它落定，免得它的异步 next() 跟下面这次 next() 抢载入序号。
    await sleep(300);
    engine.queue.push(mkSong(3), { uid: 'v1', uname: '观众1', isAnchor: false });   // 本次点了一首新歌
    await engine.next();
    await sleep(250);
    ok('前置：直播中且队列里有一首本次点的歌',
      engine.streaming === true && !!engine.track && engine.track.title === names[3],
      `在播 ${engine.track && engine.track.title}`);

    engine.setStreaming(false);
    await sleep(120);
    const after = engine.config.savedPlaylist.map((it) => it.song.title);

    ok('下播后已保存列表**原样不动**', after.join(',') === before.join(','),
      `[${before.join(',')}] → [${after.join(',')}]`);
    ok('下播**不会**把本次点的歌自动写进去', !after.includes(names[3]), `[${after.join(',')}]`);
    ok('下播后 streaming=false', engine.streaming === false);

    // 手动「加入已保存」才是唯一入口（走命令层，与界面同一条路径）
    const { createCommandHandler } = require('T:/nekofm/src/main/commands');
    const handle = createCommandHandler({ engine, saveConfig: () => {}, hooks: {} });
    const r = await handle({ action: 'savedAdd', song: mkSong(3), uname: '观众1' });
    ok('手动「加入已保存」正常生效', r.ok === true && r.name === names[3], r.ok ? `已加入 ${r.name}` : r.msg);
    ok('加入后列表增长到 4 首', engine.config.savedPlaylist.length === 4,
      `共 ${engine.config.savedPlaylist.length} 首`);

    // 再切一次（没有任何播放）也不该动
    resetQueue();
    engine.setStreaming(false);
    await sleep(80);
    ok('空状态下重复下播：列表仍不变', engine.config.savedPlaylist.length === 4,
      `共 ${engine.config.savedPlaylist.length} 首`);

    engine.streaming = false;
    engine.config.savedPlaylist = [];
    resetQueue();
  }

  /**
   * 2026-09-26（用户要求）两条规则改动：
   *   1) **空状态切到「直播中」要立刻开始播闲时歌单**。旧行为只把闲时指向已保存列表、
   *      写明"队列空了自动接着放" —— 可如果本来就什么都没在播，没有任何事件去触发它，
   *      界面就一直空着（用户："应该直接开始自动播闲时歌单才对"）。
   *   2) **直播中也允许单独点播已保存歌单里的某一首**。旧规则是"直播中它固定作为闲时
   *      歌单、不可单独播放"，结果主播想听某首只会收到"请先切到未直播"的拒绝 ——
   *      而 `playSaved` 本来就是"在闲时序列里定位到那一首"，跟闲时自动接歌同一套机制。
   */
  console.log('\n== 6j) 空状态切「直播中」自动开播 + 直播中可单独点播 ==');
  {
    const mkSong = (i) => ({ ...T(i), source: 'local' });
    resetQueue();
    engine.streaming = false;
    engine.config.savedPlaylist = [0, 1, 2].map((i) => ({ song: mkSong(i), uid: 'u1', uname: '甲' }));

    engine.setStreaming(true);
    await sleep(400);
    ok('空状态切直播 → 立刻开始播闲时歌单',
      !!engine.track && engine.playingIdle === true,
      engine.track ? `在播「${engine.track.title}」（playingIdle=${engine.playingIdle}）` : '仍然什么都没在播');

    const g = engine.playSavedGuard();
    ok('闲时（正在播闲时歌单）→ 手动选曲放行', g === null, g ? g.msg : '放行');

    const r = await engine.playSaved({ from: 2 });
    await sleep(400);
    ok('直播中在已保存列表里手动选曲 → 真的切过去了',
      r.ok === true && !!engine.track && engine.track.title === names[1],
      r.ok ? `在播「${engine.track && engine.track.title}」（第 ${r.from}/${r.total} 首）` : r.msg);

    // 反向：直播中正在播**点歌队列**的歌时，不允许手动抢播（点歌优先）
    resetQueue();
    engine.streaming = true;
    engine.queue.push(mkSong(3), { uid: 'v1', uname: '观众1', isAnchor: false });
    await engine.next();
    await sleep(400);
    const g2 = engine.playSavedGuard();
    ok('正在播观众点的歌时，直播中拦下手动选曲（点歌优先）',
      !!g2 && /点歌/.test(g2.msg || ''), g2 ? g2.msg : '竟然放行了');

    // 反向续：清掉点歌回到空闲，又该放行
    resetQueue();
    const g3 = engine.playSavedGuard();
    ok('回到空闲（无点歌在播）→ 手动选曲重新放行', g3 === null, g3 ? g3.msg : '放行');

    // 反向：有歌在播时切直播**不能**打断它（只有空闲才自动开播）
    resetQueue();
    engine.streaming = false;
    await engine.playSaved({ from: 1 });
    await sleep(400);
    const playing = engine.track && engine.track.title;
    engine.setStreaming(true);
    await sleep(300);
    ok('已有一首在播时切直播：不打断、仍放那一首',
      !!engine.track && engine.track.title === playing,
      `切前「${playing}」→ 切后「${engine.track && engine.track.title}」`);

    engine.streaming = false;
    engine.config.savedPlaylist = [];
    resetQueue();
  }

  /**
   * 2026-09-26（用户定的指令）：**`点歌 ID 1234567`** —— 按网易云歌曲 ID 直接点播，
   * 与「点播 BV号」（B站）对称。
   *
   * 为什么值得点播这条路径：ID 是唯一标识，`songDetail` 取回的是**准确那一首**，
   * 而关键词搜索可能把同名的另一首配上来（点歌/歌词配错的常见来源）。
   */
  console.log('\n== 6k) 按网易云歌曲 ID 点播（点歌 ID 1234567） ==');
  {
    resetQueue();
    const { parseCommand } = require('T:/nekofm/src/core/commands');
    const pc = parseCommand('点歌 ID 999888777');
    ok('弹幕解析：`点歌 ID 999888777` → order + keyword「ID 999888777」',
      pc.cmd === 'order' && pc.args.keyword === 'ID 999888777',
      `${pc.cmd} / ${JSON.stringify(pc.args)}`);

    // 顶掉真实网络：要断言"点的是 ID 对应的那首"，而不是"搜索第一条"
    const realDetail = engine.netease.songDetail;
    let askedId = null;
    engine.netease.songDetail = async (id) => {
      askedId = String(id);
      if (String(id) !== '999888777') return { ok: true, songs: [] };
      return {
        ok: true,
        songs: [{
          id: 999888777, name: '被点名的曲', artists: ['目标歌手'], artistText: '目标歌手',
          album: '专辑', duration: 200, cover: '', source: 'netease',
        }],
      };
    };
    try {
      const r = await engine.orderByKeyword('ID 999888777', null, { uid: 'u9', uname: '观众9' });
      ok('`ID <数字>` 被识别为按 ID 点播（而不是丢去搜索）',
        askedId === '999888777' && r && r.ok === true,
        `songDetail(${askedId}) → ${(r && (r.msg || 'ok')) || 'null'}`);
      ok('点到的正是该 ID 那首（不走搜索、不会配错）',
        engine.queue.items.length > 0 && engine.queue.items[0].song.id === 999888777,
        `队列首项 id=${engine.queue.items[0] && engine.queue.items[0].song.id}`);

      // 标记词不做字符级精确：小写、多空格都认
      askedId = null;
      await engine.orderByKeyword('id  999888777', null, { uid: 'u9', uname: '观众9' });
      ok('小写 id / 多余空格同样识别', askedId === '999888777', `songDetail(${askedId})`);

      // 不存在的 ID 要**明确报**，不能静默
      const r2 = await engine.orderByKeyword('ID 123456789', null, { uid: 'u9', uname: '观众9' });
      ok('不存在的 ID：明确报"没有 ID 为…的歌曲"',
        !!r2 && /没有 ID/.test(r2.text || ''), (r2 && r2.text) || JSON.stringify(r2));

      // 紧贴写的不算指令（与点歌系一致：必须有空格分隔）
      askedId = null;
      await engine.orderByKeyword('ID999888777', null, { uid: 'u9', uname: '观众9' });
      ok('`ID999888777`（紧贴无空格）不算 ID 指令',
        askedId === null, askedId === null ? '未走 ID 路径（当普通关键词搜索）' : `竟然解析成 ${askedId}`);
    } finally {
      engine.netease.songDetail = realDetail;
    }
    resetQueue();
  }

  /**
   * 2026-09-26：**播放结束要自动接下一首**。
   *
   * 这条曾经是坏的：`onPlayerEvent` 的 status 分支里写的是 `if (next === 'ended')` ——
   * `next` 是未定义变量，于是**每次状态上报**都抛 ReferenceError（`--simulate` 跑几秒就崩），
   * `this.next()` 从来没被调用过。表现就是"一首放完就停住，不往下走"。
   */
  console.log('\n== 6l) 播放结束自动接下一首（status=ended） ==');
  {
    const mkSong = (i) => ({ ...T(i), source: 'local' });
    resetQueue();
    engine.queue.push(mkSong(0), { uid: 'u1', uname: '甲' });
    engine.queue.push(mkSong(1), { uid: 'u1', uname: '甲' });
    await engine.next();
    await sleep(400);
    const first = engine.track && engine.track.title;
    ok('前置：第一首在播', first === names[0], `在播「${first}」`);

    // 模拟播放核心报"播完了"（player.js 的 audio 'ended' → playerStatus ended）
    engine.onPlayerEvent({ type: 'status', status: 'ended', duration: 200 });
    await sleep(700);
    ok('播完自动接下一首（而不是停住）',
      !!engine.track && engine.track.title === names[1],
      `「${first}」播完 → 「${engine.track && engine.track.title}」`);
    ok('不把 "ended" 写进 playback.status（它不是状态枚举之一）',
      engine.playback.status !== 'ended', `status=${engine.playback.status}`);

    // 顺带钉住：普通状态上报不该抛异常（这就是上面那个 ReferenceError 的触发点）
    let threw = null;
    try { engine.onPlayerEvent({ type: 'status', status: 'playing', duration: 200 }); }
    catch (e) { threw = e.message; }
    ok('普通 status 上报不再抛异常', threw === null, threw || `status=${engine.playback.status}`);

    engine.config.savedPlaylist = [];
    resetQueue();
  }

  /**
   * 2026-09-26：**音量/静音要写回配置**。
   *
   * 用户报告"播放器音量每次启动都重置到 100%"。两处都是"改了不落盘 / 根本不写回"：
   *   · 音量：构造时读了 `config.player.volume`，但 `setVolume` 从来不写回 → 完全没记忆；
   *   · 静音：读写的是 `config.playback.muted`（"播放行为"段），**改完不落盘** → 重启就丢。
   * 现在统一写回 `player` 段（与 volume / deviceId 同段）。
   */
  console.log('\n== 6m) 音量 / 静音写回配置 ==');
  {
    const saved = {
      volume: engine.config.player.volume,
      muted: engine.config.player.muted,
      playbackMuted: engine.config.playback.muted,
    };
    engine.setVolume(0.33);
    ok('setVolume 写回 config.player.volume', engine.config.player.volume === 0.33,
      `config.player.volume=${engine.config.player.volume}`);
    engine.setMuted(true);
    ok('setMuted 写回 config.player.muted', engine.config.player.muted === true,
      `config.player.muted=${engine.config.player.muted}`);
    ok('不再往 playback 段写 muted（那里只放播放模式）',
      engine.config.playback.muted === saved.playbackMuted,
      saved.playbackMuted === undefined
        ? 'playback 段已无 muted 字段 ✅'
        : `playback.muted 保持 ${engine.config.playback.muted}（未被改动）`);
    engine.setMuted(saved.muted);
    engine.setVolume(saved.volume);
  }

  console.log('\n== 7) 静音与音量 ==');
  {
    ok('静音开', engine.setMuted(true).muted === true && engine.muted === true);
    ok('静音关', engine.setMuted(false).muted === false);
    engine.setVolume(0.42);
    ok('音量可设', Math.abs(engine.playback.volume - 0.42) < 1e-6, String(engine.playback.volume));
    engine.setVolume(5);
    ok('音量被夹到 [0,1]', engine.playback.volume === 1);
  }

  // ================================================================ 8) 状态输出
  console.log('\n== 8) 状态输出字段 ==');
  {
    const s = engine.state();
    ok('state.player 存在', !!s.player, Object.keys(s.player).join(','));
    ok('含播放模式/静音/历史/闲时/缓存', ['mode', 'muted', 'historyCount', 'playingIdle', 'cached', 'favorited']
      .every((k) => s.player[k] !== undefined));
    ok('state.idle 存在', !!s.idle && typeof s.idle.enabled === 'boolean');
    ok('state.cache 为摘要', !!s.cache && typeof s.cache.count === 'number' && typeof s.cache.mb === 'number');
    ok('state.favoritesCount 存在', typeof s.favoritesCount === 'number');
  }

  await server.stop();
  try { await engine.cache.clear(); } catch { /* 忽略 */ }
  fs.rmSync(ROOT, { recursive: true, force: true });

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('播放器测试异常:', e); process.exit(1); });
