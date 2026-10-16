/**
 * 「歌词配错」= 删掉这份词 + 禁止这首歌再自动匹配（2026-10-16）
 * =================================================================
 * 需求来源（用户原话）：自动匹配的歌词配错了（"前半段没问题，后半段文本
 * 对不上"），**不要求强行找对的**，只要"直接删掉相应的歌词，并且禁止每次
 * 自动匹配"。
 *
 * 本文件只验**引擎层的行为**，不连网（网易云两个接口都换成桩）：
 *   1) 正常情况：按歌名匹配能拿到词，并且落进磁盘缓存
 *   2) `lyricAutoBan` 之后：磁盘缓存的歌词没了；本地曲的旁车 .lrc / .trans.lrc 被删；
 *      **一个自动来源都不再被查询**（桩计数为 0）；显示为空且有诊断原因
 *   3) 名单落盘：重新按 config.json 起一个引擎（模拟重启），禁令仍在
 *   4) `lyricAutoUnban` / `lyricAutoBanClear` 之后：又能匹配到词了
 *   5) 边界：B站/网易云曲目按"缓存键"记名；本地曲按**文件路径**记名
 *      （同名不同文件是两首歌，拉黑一个不该牵连另一个）
 *
 * ⚠️ 测试隔离：数据目录锁到临时目录（`NEKOFM_DATA`）。不这么做的话
 * `configPath()` 会回落到用户的真实 `data/`，等于拿用户的歌库当试验田。
 */
'use strict';

process.env.NEKOFM_DATA = require('node:path').join(require('node:os').tmpdir(), 'nekofm-data-lyricban');
require('node:fs').rmSync(process.env.NEKOFM_DATA, { recursive: true, force: true });

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Engine } = require('../src/main/engine');
const { AppServer } = require('../src/main/server');
const { createCommandHandler } = require('../src/main/commands');
const { DEFAULT_CONFIG, deepMerge, configPath } = require('../src/core/config');

let pass = 0; let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { console.log(`  ✅ ${n}${extra ? ' → ' + extra : ''}`); pass++; }
  else { console.log(`  ❌ ${n}${extra ? ' → ' + extra : ''}`); fail++; }
};

const DIR = path.join(os.tmpdir(), 'nekofm-lyricban-src');
/**
 * ⚠️ 磁盘缓存目录也要每次清干净：不清的话上一轮跑出来的 `match-测试歌`
 * 会被当成"缓存命中"，第 1 节那条"走网易云同名匹配"就变成 `source=缓存` 而假红
 * （实测踩到过：第一次跑绿、第二次跑红，差别只是缓存里有没有东西）。
 */
const CACHE_DIR = path.join(os.tmpdir(), 'nekofm-lyricban-cache');
const cfgFor = () => deepMerge(DEFAULT_CONFIG, { local: { dirs: [], enabled: false }, cache: { dir: CACHE_DIR } });

/**
 * 造引擎 + 把网易云两个接口换成桩。
 * 桩计数 `calls` 就是"自动来源有没有被查"的证据 —— 拉黑之前必须有，
 * 拉黑之后必须一个都没有。
 */
function makeEngine() {
  const engine = new Engine({ config: cfgFor(), log: () => {} });
  const calls = [];
  engine.netease.search = async (kw) => {
    calls.push({ api: 'search', kw });
    return { ok: true, songs: [{ id: 4242, name: '测试歌', artists: ['桩歌手'] }] };
  };
  engine.netease.lyric = async (id) => {
    calls.push({ api: 'lyric', id });
    return { ok: true, lrc: '[00:01.00]第一句\n[00:03.00]第二句\n', tlyric: '', romalrc: '', yrc: '' };
  };
  engine.calls = calls;
  return engine;
}

/** 模拟"重启程序"：把 config 写盘，再按 index.js 的 loadConfig 读回来新建引擎 */
function restart(engine) {
  const { dir, file } = configPath();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(engine.config, null, 2), 'utf8');
  const next = makeEngineLazy();
  return next;
}
/** 与 index.js 的 loadConfig 一致：deepMerge(DEFAULT_CONFIG, 磁盘上的配置) */
function makeEngineLazy() {
  const { file } = configPath();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const engine = new Engine({ config: deepMerge(DEFAULT_CONFIG, raw), log: () => {} });
  const calls = [];
  engine.netease.search = async () => { calls.push({ api: 'search' }); return { ok: true, songs: [{ id: 4242, name: '测试歌', artists: ['桩歌手'] }] }; };
  engine.netease.lyric = async () => { calls.push({ api: 'lyric' }); return { ok: true, lrc: '[00:01.00]第一句\n[00:03.00]第二句\n', tlyric: '', romalrc: '', yrc: '' }; };
  engine.calls = calls;
  return engine;
}

(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  // ---------------------------------------------------------------- 1) 基线
  console.log('\n【1】没有拉黑时：按歌名匹配到词，并落进磁盘缓存');
  const engine = makeEngine();
  const localFile = path.join(DIR, '测试歌.mp3');
  fs.writeFileSync(localFile, 'not-a-real-audio-file');
  fs.writeFileSync(path.join(DIR, '测试歌.lrc'), '[00:09.00]这是旁车歌词\n');
  const song = { source: 'local', file: localFile, name: '测试歌', title: '测试歌', artists: ['某人'] };

  // 旁车歌词优先：这一步不该联网
  const sidecar = await engine.resolveLyrics(song);
  ok('本地有旁车 .lrc 时直接用它', !!sidecar && sidecar.source === 'sidecar' && engine.calls.length === 0,
    `source=${sidecar && sidecar.source} calls=${engine.calls.length}`);

  // 把旁车删掉，逼它走"按歌名去网易云匹配"那条路
  fs.unlinkSync(path.join(DIR, '测试歌.lrc'));
  const matched = await engine.resolveLyrics(song);
  const lk = engine.cache.lyricKeyFor(song);
  ok('旁车没有时走网易云同名匹配', !!matched && matched.source === 'netease-match' && engine.calls.length === 2,
    `source=${matched && matched.source} 调用=${engine.calls.map((c) => c.api).join(',')}`);
  ok('匹配到的词写进了磁盘缓存', !!engine.cache.getLyrics(lk), `key=${lk}`);

  // ---------------------------------------------------------------- 2) 拉黑
  console.log('\n【2】「歌词配错 ✕」：删词 + 拉黑 + 之后一个来源都不查');
  fs.writeFileSync(path.join(DIR, '测试歌.lrc'), '[00:09.00]这是旁车歌词\n');
  fs.writeFileSync(path.join(DIR, '测试歌.trans.lrc'), '[00:09.00]translation\n');

  engine.track = song;                      // 当作"这首歌正在播"
  ok('**没被禁**的曲目也要给 banKey（否则按钮画出来却点不动）',
    engine.state().lyric.banKey === 'local:' + localFile.toLowerCase() && engine.state().lyric.banned === false,
    engine.state().lyric.banKey);
  engine.track = null;
  ok('没有在播曲目时 banKey 为空、按钮不可点', engine.state().lyric.banKey === '' && engine.state().lyric.banned === false);
  engine.track = song;
  engine.lyricTimeline = matched.timeline;  // 界面上正挂着一份错的词
  engine.lyricSource = 'netease-match';
  const before = engine.state().lyric.rev;
  const ban = engine.lyricAutoBan();

  ok('返回 ok 且报出歌名', !!ban.ok && ban.name === '测试歌', JSON.stringify({ ok: ban.ok, key: ban.key }));
  ok('本地曲按**文件路径**记名（不是歌名）', ban.key === 'local:' + localFile.toLowerCase(), ban.key);
  ok('磁盘缓存的歌词被删掉', engine.cache.getLyrics(lk) === null);
  ok('旁车 .lrc 被删掉', !fs.existsSync(path.join(DIR, '测试歌.lrc')));
  ok('旁车 .trans.lrc 被删掉', !fs.existsSync(path.join(DIR, '测试歌.trans.lrc')) && ban.files.length === 2, `removed=${ban.files.length}`);
  ok('正在播的那首立刻清空显示 + rev 前进',
    engine.state().lyric.count === 0 && engine.lyricSource === 'none' && engine.state().lyric.rev > before);
  ok('落进 config.lyrics.banned', (engine.config.lyrics.banned || []).length === 1);
  ok('state().lyric 报出"这首被禁了"', engine.state().lyric.banned === true && engine.state().lyric.banKey === ban.key);
  ok('state().lyricBan 名单里能看到它', engine.state().lyricBan.total === 1 && engine.state().lyricBan.list[0].name === '测试歌');

  engine.calls.length = 0;
  const afterBan = await engine.resolveLyrics(song);
  ok('拉黑后拿不到歌词', afterBan === null);
  ok('拉黑后**一个自动来源都没查**', engine.calls.length === 0, `调用数=${engine.calls.length}`);
  ok('给出原因（不是静默的 0 行）', /删掉|禁止/.test((engine.lastLyricDiag || {}).reason || ''), (engine.lastLyricDiag || {}).reason);

  // 缓存键（在线曲目）也要按同一个口径认
  const neteaseSong = { source: 'netease', id: 123, name: '在线曲', title: '在线曲', artists: ['A'] };
  engine.calls.length = 0;
  const online = await engine.resolveLyrics(neteaseSong);
  ok('在线曲目正常取词', !!online && online.source === 'netease', `source=${online && online.source}`);
  const nb = engine.lyricAutoBan(neteaseSong);
  ok('在线曲目按缓存键记名（netease-<id>）', nb.key === 'netease-123', nb.key);
  ok('在线曲目的歌词缓存也被删掉', engine.cache.getLyrics('netease-123') === null);
  engine.calls.length = 0;
  ok('在线曲目拉黑后同样不再取词', (await engine.resolveLyrics(neteaseSong)) === null && engine.calls.length === 0);

  // ---------------------------------------------------------------- 3) 落盘 / 重启
  console.log('\n【3】名单落盘：重启后禁令还在');
  const engine2 = restart(engine);
  ok('重启后名单仍是 2 条', (engine2.config.lyrics.banned || []).length === 2, `count=${(engine2.config.lyrics.banned || []).length}`);
  ok('重启后仍然认识这条禁令（不查任何来源）',
    (await engine2.resolveLyrics(song)) === null && engine2.calls.length === 0);

  // ---------------------------------------------------------------- 4) 恢复
  console.log('\n【4】恢复：取消禁令后又能匹配到词');
  const un = engine2.lyricAutoUnban(ban.key);
  ok('恢复返回 ok', !!un.ok && un.removed.key === ban.key);
  engine2.calls.length = 0;
  const again = await engine2.resolveLyrics(song);
  ok('恢复后又走同名匹配', !!again && again.source === 'netease-match' && engine2.calls.length === 2);
  ok('名单少了一条', (engine2.config.lyrics.banned || []).length === 1);
  ok('重复恢复会如实报错', engine2.lyricAutoUnban(ban.key).ok === false);

  const cleared = engine2.lyricAutoBanClear();
  ok('全部恢复返回条数', cleared.ok === true && cleared.removed === 1, `removed=${cleared.removed}`);
  ok('名单空了', (engine2.config.lyrics.banned || []).length === 0);

  // ---------------------------------------------------------------- 5) 边界
  console.log('\n【5】边界：同名不同文件互不牵连；没法记名就如实报错');
  const fileA = path.join(DIR, 'A', '同名.mp3');
  const fileB = path.join(DIR, 'B', '同名.mp3');
  for (const f of [fileA, fileB]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); }
  const engA = makeEngine();
  fs.writeFileSync(path.join(DIR, 'A', '同名.lrc'), '[00:01.00]A\n');
  fs.writeFileSync(path.join(DIR, 'A', '同名.karaoke.lrc'), '[00:01.00]A 旧版逐字\n');
  const banA = engA.lyricAutoBan({ source: 'local', file: fileA, name: '同名' });
  ok('A 目录的那首被禁', !!engA.lyricBanFor({ source: 'local', file: fileA, name: '同名' }));
  ok('B 目录的同名曲**不受影响**', engA.lyricBanFor({ source: 'local', file: fileB, name: '同名' }) === null);
  ok('旧版 .karaoke.lrc 不删（超出确认范围）',
    fs.existsSync(path.join(DIR, 'A', '同名.karaoke.lrc')) && banA.kept.length === 1 && banA.kept[0].endsWith('同名.karaoke.lrc'));
  ok('没有 id/file 的曲目：如实拒绝而不是假装成功',
    (() => { const r = engA.lyricAutoBan({ source: 'local', name: '没有文件' }); return r.ok === false && /算不出/.test(r.msg); })());
  ok('手动缓存不会绕过禁令',
    await (async () => {
      engA.lyricAutoBan({ source: 'local', file: fileA, name: '同名' });
      const r = await engA.cacheFetch({ source: 'local', file: fileA, name: '同名' });
      return r.lyrics.ok === false && /禁止自动匹配/.test(r.lyrics.msg);
    })());

  // ---------------------------------------------------------------- 6) 真实 HTTP 通道
  console.log('\n【6】命令层（/api/command → 引擎 → /api/state）：界面按钮真正走的那条路');
  {
    const eng = makeEngine();
    const btnSong = { source: 'local', file: fileB, name: '同名', title: '同名', artists: ['某人'] };
    eng.track = btnSong;                       // 按钮不传 song，就是对"正在播的这首"
    let saved = 0;
    const server = new AppServer({
      port: 0, host: '127.0.0.1',
      rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
      sharedDir: path.join(__dirname, '..', 'src', 'shared'),
      getState: () => eng.state(),
      getLyrics: () => eng.lyricsPayload(),
      getConfig: () => eng.config.overlay,
      onCommand: createCommandHandler({ engine: eng, saveConfig: () => { saved++; }, onConfigChange: () => {}, hooks: {} }),
      log: () => {},
    });
    const port = await server.start();
    const cmd = async (body) => (await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    const state = async () => (await fetch(`http://127.0.0.1:${port}/api/state`)).json();

    const r1 = await cmd({ action: 'lyricAutoBan' });   // 不带 song = 当前正在播的那首
    ok('HTTP：lyricAutoBan 成功', !!r1.ok && r1.result.ok === true && r1.result.name === '同名', r1.result && r1.result.key);
    ok('HTTP：名单落盘被调用（否则重启就忘了）', saved === 1);
    const s1 = await state();
    ok('HTTP：state().lyric.banned 让按钮变成「恢复自动匹配」', s1.lyric.banned === true && s1.lyric.banKey === r1.result.key);
    ok('HTTP：state().lyricBan 供清单渲染', s1.lyricBan.total === 1 && s1.lyricBan.list[0].name === '同名');

    const r2 = await cmd({ action: 'lyricAutoUnban', key: r1.result.key });
    ok('HTTP：lyricAutoUnban 成功', !!r2.ok && r2.result.ok === true && r2.result.removed.key === r1.result.key);
    ok('HTTP：恢复也落盘', saved === 2);
    ok('HTTP：state 里禁令已消失', (await state()).lyric.banned === false);

    await cmd({ action: 'lyricAutoBan' });
    const r3 = await cmd({ action: 'lyricAutoBanClear' });
    ok('HTTP：lyricAutoBanClear 成功', !!r3.ok && r3.result.ok === true && r3.result.removed === 1, `removed=${r3.result && r3.result.removed}`);
    ok('HTTP：清空后清单为空', (await state()).lyricBan.total === 0);
    ok('HTTP：非法 key 不会 500', (await cmd({ action: 'lyricAutoUnban', key: 'no-such-key' })).result.ok === false);
    await server.stop();
  }

  // ---------------------------------------------------------------- 7) 不许污染程序默认值
  console.log('\n【7】禁令是"这台机器的数据"，不许写进程序内置默认值');
  ok('DEFAULT_CONFIG.lyrics.banned 仍然是空的（跑完全部用例之后）',
    DEFAULT_CONFIG.lyrics.banned.length === 0, `count=${DEFAULT_CONFIG.lyrics.banned.length}`);
  ok('引擎自己那份名单是**另一个对象**',
    engine.config.lyrics.banned !== DEFAULT_CONFIG.lyrics.banned);

  console.log(`\n歌词禁令测试：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('歌词禁令测试异常:', e); process.exit(1); });
