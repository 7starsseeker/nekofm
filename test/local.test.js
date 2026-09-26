/**
 * 本地音乐链路测试（用 ffmpeg 现场生成真实音频，不用现成素材）
 * =============================================================
 * 覆盖：
 *   1) 目录递归扫描 + ffprobe 读标题/艺术家/时长
 *   2) 歌词三来源：同名 .lrc → 翻译 .trans.lrc → 内嵌 lyrics 标签
 *   3) 引擎解析本地曲目 → /stream/local?path= → Range 拖动 206
 *   4) 本地曲目没歌词时，按歌名去网易云匹配
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
process.env.NEKOFM_DATA = require('node:path').join(require('node:os').tmpdir(), 'nekofm-data-local');
// 每轮从**干净**的数据目录开始：否则上一轮落盘的歌词/音频缓存会在本轮被命中，
// 让"来源=缓存"这类断言和预期的"来源=netease-match"对不上（实测踩到）
require('node:fs').rmSync(process.env.NEKOFM_DATA, { recursive: true, force: true });


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { LocalLibrary } = require('../src/main/sources/local');
const { Engine } = require('../src/main/engine');
const { AppServer } = require('../src/main/server');
const { createCommandHandler } = require('../src/main/commands');
const { DEFAULT_CONFIG } = require('../src/core/config');
const { probeFfmpeg, skipAllBecause } = require('./_helpers');

const PORT = 37902;
const DIR = path.join(os.tmpdir(), 'nekofm-localtest');
let pass = 0, fail = 0, skipped = 0;
const ok = (n, c, extra = '') => {
  if (c) { console.log(`  ✅ ${n}${extra ? ' → ' + extra : ''}`); pass++; }
  else { console.log(`  ❌ ${n}${extra ? ' → ' + extra : ''}`); fail++; }
};
/** 外部服务限流等原因导致的"本轮无法判定"——不该算失败 */
const skip = (n, why) => { console.log(`  ⏭️  ${n} → ${why}（跳过，非失败）`); skipped++; };
const isLimited = (t) => /操作频繁|请稍候|频繁|too many/i.test(String(t || ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LRC = '[ti:测试歌曲]\n[ar:测试歌手]\n[00:01.00]第一句测试歌词\n[00:03.50]第二句测试歌词\n[00:06.00]第三句测试歌词';

function makeAudio(file, { seconds = 8, meta = {} } = {}) {
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:a', 'libmp3lame', '-b:a', '128k'];
  for (const [k, v] of Object.entries(meta)) args.push('-metadata', `${k}=${v}`);
  args.push(file);
  execFileSync('ffmpeg', args, { stdio: 'pipe' });
}

(async () => {
  // 素材是现场用 ffmpeg 造的，没有 ffmpeg 就整份跳过（环境不具备 ≠ 失败）
  if (!probeFfmpeg().ok) skipAllBecause('本地音乐链路测试', '未找到 ffmpeg / ffprobe（素材需要现场生成）');

  // ---------------------------------------------------------- 准备素材
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'sub'), { recursive: true });

  const f1 = path.join(DIR, '带侧车歌词.mp3');
  const f2 = path.join(DIR, 'sub', '内嵌歌词.mp3');
  const f3 = path.join(DIR, '孤勇者.mp3'); // 无歌词 → 应回落到网易云匹配
  makeAudio(f1, { meta: { title: '带侧车歌词', artist: '测试歌手' } });
  makeAudio(f2, { meta: { title: '内嵌歌词', artist: '测试歌手', lyrics: '内嵌第一句\n内嵌第二句' } });
  makeAudio(f3, { meta: { title: '孤勇者', artist: '陈奕迅' } });
  fs.writeFileSync(path.join(DIR, '带侧车歌词.lrc'), LRC, 'utf8');
  fs.writeFileSync(path.join(DIR, '带侧车歌词.trans.lrc'), '[00:01.00]First line\n[00:03.50]Second line', 'utf8');

  console.log('== 1) 扫描与元数据 ==');
  const lib = new LocalLibrary({ dirs: [DIR], log: () => {} });
  const tracks = await lib.scan();
  ok('递归扫到 3 个音频（含子目录）', tracks.length === 3, `${tracks.length} 首`);
  const t1 = tracks.find((t) => t.name === '带侧车歌词');
  ok('读到 ffprobe 标题/艺术家', !!t1 && t1.artistText === '测试歌手', t1 && t1.artistText);
  ok('读到时长', !!t1 && t1.duration > 7 && t1.duration < 9, t1 && t1.duration.toFixed(2) + 's');
  ok('关键词搜索可用', lib.search('侧车').length === 1, lib.search('侧车').map((x) => x.name).join(','));
  ok('子目录文件也能搜到', lib.search('内嵌').length === 1);

  console.log('\n== 2) 歌词三来源 ==');
  const ly1 = await lib.lyrics(path.join(DIR, '带侧车歌词.mp3'));
  ok('同名 .lrc 优先', ly1.ok && ly1.source === 'sidecar' && ly1.lrc.includes('第一句测试歌词'), '来源=' + ly1.source);
  ok('翻译侧车 .trans.lrc 也能读', ly1.tlyric.includes('First line'), ly1.tlyric.split('\n')[0]);
  const ly2 = await lib.lyrics(path.join(DIR, 'sub', '内嵌歌词.mp3'));
  ok('内嵌 lyrics 标签可读', ly2.ok && ly2.source === 'embedded' && ly2.lrc.includes('内嵌第一句'), '来源=' + ly2.source + ' 内容=' + JSON.stringify(ly2.lrc.slice(0, 20)));
  const ly3 = await lib.lyrics(path.join(DIR, '孤勇者.mp3'));
  ok('无歌词时如实返回 none', !ly3.ok && ly3.source === 'none');

  console.log('\n== 3) 引擎：本地曲目 → 流 → 歌词 → 拖动 ==');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.server.port = PORT;
  cfg.local.dirs = [DIR];
  const engine = new Engine({ config: cfg, log: () => {} });
  const server = new AppServer({
    port: PORT, host: '127.0.0.1',
    rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
    sharedDir: path.join(__dirname, '..', 'src', 'shared'),
    getState: () => engine.state(),
    getLyrics: () => engine.lyricsPayload(),
    // 白名单：曲库目录 + 显式打开的文件 + 封面缓存 —— 与生产接线保持一致，
    // 否则这个测试里的安全校验会因为白名单为空而被跳过（等于没测）
    allowRootsProvider: () => [
      ...(engine.config.local.dirs || []),
      ...(engine.local.extraFiles ? [...engine.local.extraFiles] : []),
      path.join(os.tmpdir(), 'nekofm-covers-test'),
      path.join(os.tmpdir(), 'nekofm-cache-test'),
    ],
    onCommand: createCommandHandler({ engine, saveConfig: () => {}, hooks: {} }),
    log: () => {},
  });
  const port = await server.start();
  engine.serverBase = `http://127.0.0.1:${port}`;
  await engine.init();
  ok('引擎启动时自动索引本地曲库', engine.local.tracks.length === 3, `${engine.local.tracks.length} 首`);

  const r = await engine.orderByKeyword('侧车', 'local', { uid: '1', uname: '测试', isAnchor: true });
  ok('点本地歌入队', r.ok, r.ok ? 'ok' : r.msg);
  await sleep(1200);
  ok('曲目来源为 local', engine.track && engine.track.source === 'local', engine.track && engine.track.source);
  ok('流地址走 /stream/local', String(engine.streamUrl).includes('/stream/local?path='), String(engine.streamUrl).slice(0, 60));
  ok('歌词来自侧车', engine.lyricSource === 'sidecar' && engine.lyricTimeline.lines.length === 3,
    `${engine.lyricTimeline.lines.length} 行，来源=${engine.lyricSource}`);
  ok('翻译已合并进时间轴', (engine.lyricTimeline.lines[0] || {}).trans === 'First line',
    (engine.lyricTimeline.lines[0] || {}).trans);

  // 全量请求
  const full = await fetch(engine.streamUrl);
  ok('全量请求 200 且带 Accept-Ranges', full.status === 200 && full.headers.get('accept-ranges') === 'bytes',
    `HTTP ${full.status} ranges=${full.headers.get('accept-ranges')}`);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  ok('拿到完整音频字节', fullBuf.length > 10000, fullBuf.length + ' 字节');

  // Range 请求（拖动进度靠它）
  const ranged = await fetch(engine.streamUrl, { headers: { Range: 'bytes=1000-1999' } });
  const rbuf = Buffer.from(await ranged.arrayBuffer());
  ok('Range 请求返回 206', ranged.status === 206, 'HTTP ' + ranged.status);
  ok('Content-Range 正确', /bytes 1000-1999\/\d+/.test(ranged.headers.get('content-range') || ''),
    ranged.headers.get('content-range'));
  ok('Range 切片长度正确', rbuf.length === 1000, rbuf.length + ' 字节');
  ok('Content-Type 为音频', /audio\/mpeg/.test(ranged.headers.get('content-type') || ''), ranged.headers.get('content-type'));

  console.log('\n== 4) 本地无歌词 → 网易云按歌名匹配 ==');
  engine.queue.clear();
  const r4 = await engine.orderByKeyword('孤勇者', 'local', { uid: '1', uname: '测试', isAnchor: true });
  ok('本地《孤勇者》入队', r4.ok);
  await engine.next();
  await sleep(4000);
  const matched = engine.lyricSource === 'netease-match' && engine.lyricTimeline.lines.length > 0;
  if (matched) {
    ok('歌词回落到网易云匹配', true, `${engine.lyricTimeline.lines.length} 行`);
  } else if (engine.lastLyricDiag && engine.lastLyricDiag.reason) {
    // 引擎给出了失败原因 → 外部状态（限流/无结果/网络），不是本程序的缺陷。
    // 反过来，"静默失败"才是真 bug，必须判失败。
    skip('歌词回落到网易云匹配', engine.lastLyricDiag.reason);
  } else {
    ok('歌词回落到网易云匹配', false, `${engine.lyricTimeline.lines.length} 行，来源=${engine.lyricSource}`);
  }

  console.log('\n== 5) 打开本地音乐（原生选择器 → 播放） ==');
  {
    // 造一个"曲库目录之外"的文件，模拟用户用「打开文件」随手选的一首
    const outside = path.join(os.tmpdir(), 'nekofm-outside-song.mp3');
    makeAudio(outside, { seconds: 6, meta: { title: '散装打开的歌', artist: '外部歌手' } });

    // 5.1 未打开前：白名单外，流接口必须拒绝
    const before = await fetch(`http://127.0.0.1:${port}/stream/local?path=${encodeURIComponent(outside)}`);
    ok('白名单外的文件被流接口拒绝（403）', before.status === 403, 'HTTP ' + before.status);

    // 5.2 打开它
    const r = await engine.openLocalFiles([outside], { enqueue: true, play: true });
    ok('打开文件成功', r.ok, r.ok ? `${r.added.length} 个，入队 ${r.queued}` : r.msg);
    ok('曲目进入队列', engine.queue.items.some((i) => i.song.file === outside) || (engine.track && engine.track.file === outside));
    ok('标记为临时打开（与目录曲库区分）', engine.local.tracks.find((t) => t.file === outside).openedAdhoc === true);

    // 5.3 打开后：白名单放行，可以正常播放
    const after = await fetch(`http://127.0.0.1:${port}/stream/local?path=${encodeURIComponent(outside)}`);
    ok('打开后流接口放行（200）', after.status === 200, 'HTTP ' + after.status);
    const buf = Buffer.from(await after.arrayBuffer());
    ok('能取到音频字节', buf.length > 5000, buf.length + ' 字节');

    // 5.4 播放流转：它会成为当前曲目
    await sleep(300);
    if (engine.track && engine.track.file !== outside) await engine.next();
    await sleep(1200);
    ok('本地文件成为当前播放曲目', engine.track && engine.track.file === outside, engine.track && engine.track.name);
    // 歌词来源：侧车/内嵌 → 否则回落网易云匹配；前者成功即算通过。
    // （网易云限流时为 none，属外部状态，不判失败）
    const lyricOk = ['sidecar', 'embedded', 'netease-match'].includes(engine.lyricSource);
    if (lyricOk) ok('本地曲目歌词解析成功', true, '来源=' + engine.lyricSource);
    else if (engine.lastLyricDiag && engine.lastLyricDiag.reason) skip('本地曲目歌词解析', engine.lastLyricDiag.reason);
    else ok('本地曲目歌词解析成功', false, '静默失败：来源=' + engine.lyricSource + '，且引擎未给出原因');

    // 5.5 重扫目录不会冲掉临时打开的文件
    await engine.local.scan({ force: true });
    ok('重新扫描后临时文件仍在', engine.local.tracks.some((t) => t.file === outside));

    // 5.6 找不到的文件不应让流程炸掉
    const bad = await engine.openLocalFiles([path.join(os.tmpdir(), '不存在.mp3')]);
    ok('不存在的文件被优雅拒绝', !bad.ok && /识别|选择/.test(bad.msg), bad.msg);

    // 5.7 列表接口
    const listed = engine.listLocal('');
    ok('列出曲库', listed.ok && listed.total >= 3, `${listed.total} 首，含临时 ${listed.adhoc} 个`);
    const filtered = engine.listLocal('散装');
    ok('按关键词过滤', filtered.ok && filtered.total === 1, `匹配 ${filtered.total} 首`);

    // 5.8 目录接口
    const extraDir = path.join(DIR, 'sub2');
    fs.mkdirSync(extraDir, { recursive: true });
    makeAudio(path.join(extraDir, '新目录里的歌.mp3'), { seconds: 4 });
    const od = await engine.openLocalFolder(extraDir);
    ok('打开文件夹加入曲库', od.ok && od.total >= 4, `共 ${od.total} 首`);
    ok('目录写进了配置（可持久化）', (engine.config.local.dirs || []).includes(extraDir));
    const rm = engine.removeLocalFolder(extraDir);
    ok('可移除曲库目录', rm.ok && !(engine.config.local.dirs || []).includes(extraDir));

    // 5.9 收尾：删掉外部文件后，重新打开应被拒
    try { fs.unlinkSync(outside); } catch { /* 忽略 */ }
    const gone = await engine.openLocalFiles([outside]);
    ok('文件已删除后打开被拒', !gone.ok, gone.msg);
  }

  console.log('\n== 6) 本地歌词匹配的相似度闸（防配错歌词） ==');
  {
    // 实测过：本地文件叫「示例曲目2」时，网易云模糊搜索也能返回一首不相干的歌
    // 外加 55 行歌词 —— 配错歌词比没有歌词更糟，所以要有这道闸。
    const { titleSimilarity: sim, TITLE_MATCH_MIN: MIN } = require('../src/main/engine');
    ok('同名 → 1.0', sim('孤勇者', '孤勇者') === 1, String(sim('孤勇者', '孤勇者')));
    ok('带后缀版本仍接受', sim('孤勇者 (Live)', '孤勇者') >= MIN, sim('孤勇者 (Live)', '孤勇者').toFixed(2));
    ok('大小写/空格不敏感', sim('Lemon', 'l e m o n') >= MIN, sim('Lemon', 'l e m o n').toFixed(2));
    ok('完全无关 → 拒绝', sim('示例曲目2', '孤勇者') < MIN, sim('示例曲目2', '孤勇者').toFixed(2));
    ok('无关中文长名 → 拒绝', sim('某某测试音频', '晴天') < MIN, sim('某某测试音频', '晴天').toFixed(2));
    ok('英文翻唱后缀接受', sim('Shape of You', 'Shape of You (Cover)') >= MIN, sim('Shape of You', 'Shape of You (Cover)').toFixed(2));
    ok('空标题 → 0', sim('', '孤勇者') === 0 && sim('孤勇者', '') === 0);
  }

  console.log('\n== 7) 匹配到的歌词落到歌曲旁边（旁车文件） ==');
  {
    const { buildTimeline, timelineToLrc, parseLrc } = require('../src/core/lyrics/lrc');
    const box = path.join(DIR, 'sidecar');
    fs.mkdirSync(box, { recursive: true });
    const audio = path.join(box, '带歌词的歌.mp3');
    makeAudio(audio, { seconds: 4, meta: { title: '带歌词的歌', artist: '测试' } });

    const tl = buildTimeline({
      lrc: '[00:01.00]第一行\n[00:03.00]第二行\n',
      tlyric: '[00:01.00]First\n[00:03.00]Second\n',
      yrc: '[1000,2000](0,400,0)第(400,400,0)一(800,400,0)行',
    });
    const r = lib.saveLyrics(audio, tl);
    ok('保存旁车歌词成功', r.ok, (r.written || []).map((f) => path.basename(f)).join('、'));
    ok('写出标准 .lrc（兼容其它播放器）', fs.existsSync(path.join(box, '带歌词的歌.lrc')));
    /**
     * 2026-09-26：**不再写 `.karaoke.lrc`**（逐字染色显示已下线，没人再读它）。
     * 少写一个文件 —— 目录更干净，也少一次磁盘写入。老的 .karaoke.lrc 仍照常读取。
     */
    ok('不再写 .karaoke.lrc（逐字版已下线）', !fs.existsSync(path.join(box, '带歌词的歌.karaoke.lrc')));
    ok('写出 .trans.lrc（翻译）', fs.existsSync(path.join(box, '带歌词的歌.trans.lrc')));
    ok('只写 2 个文件（.lrc + .trans.lrc）', (r.written || []).length === 2,
      (r.written || []).map((f) => path.basename(f)).join('、'));

    // 再次读取：从标准 .lrc + .trans.lrc 读回（不再依赖逐字文件）
    const got = await lib.lyrics(audio);
    ok('能从旁车读回歌词', got.ok && got.source === 'sidecar', got.source);
    const back = buildTimeline({ lrc: got.lrc, tlyric: got.tlyric });
    ok('读回后正文完整', back.lines.length >= 2 && /第一行/.test(back.lines[0].text),
      back.lines.map((l) => l.text).join('/'));
    ok('读回后翻译保留', back.lines.filter((l) => l.trans).length >= 2, back.lines.map((l) => l.trans || '-').join('/'));

    // 向后兼容：只有老的 .karaoke.lrc（没有标准 .lrc）时也要能读
    const legacyDir = path.join(DIR, 'legacy-sidecar');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyAudio = path.join(legacyDir, '老文件.mp3');
    makeAudio(legacyAudio, { seconds: 3, meta: { title: '老文件' } });
    fs.writeFileSync(path.join(legacyDir, '老文件.karaoke.lrc'), ['[00:01.00]<00:01.00>老<00:01.50>格<00:02.00>式', ''].join(String.fromCharCode(10)));
    const legacyGot = await lib.lyrics(legacyAudio);
    // 注意：增强 LRC 里"老/格/式"被行内时间标签隔开，原始文本里没有连续子串，
    // 所以要断言**解析后**的正文（第一版就是直接正则匹配原文，误报失败）
    const legacyTl = buildTimeline({ lrc: legacyGot.lrc, tlyric: legacyGot.tlyric });
    ok('旧 .karaoke.lrc 仍能读（向后兼容）',
      legacyGot.ok && legacyGot.source === 'sidecar' && legacyTl.lines[0].text === '老格式',
      `来源=${legacyGot.source} 正文=${legacyTl.lines[0] && legacyTl.lines[0].text}`);

    // **绝不覆盖用户自己放的歌词**
    const userLrc = path.join(box, '用户自己写的.lrc');
    fs.writeFileSync(userLrc, '[00:01.00]用户自己的歌词\n');
    const userAudio = path.join(box, '用户自己写的.mp3');
    makeAudio(userAudio, { seconds: 3, meta: { title: '用户自己写的' } });
    const r2 = lib.saveLyrics(userAudio, tl);
    ok('已有歌词不被覆盖', r2.ok && !r2.written.some((f) => f.endsWith('用户自己写的.lrc'))
      && fs.readFileSync(userLrc, 'utf8').includes('用户自己的歌词'), 'skipped=' + (r2.skipped || []).length);

    // 关掉开关就完全不写
    const off = lib.saveLyrics(audio, tl, { enabled: false });
    ok('开关可关闭自动保存', off.ok && off.msg === 'disabled');

    // 目录不可写时要优雅失败（不能抛）
    const ro = lib.saveLyrics(path.join(box, '不存在的目录', 'x.mp3'), tl);
    ok('目录异常时优雅失败', ro.ok === false && !!ro.msg, ro.msg && ro.msg.slice(0, 40));
  }

  await server.stop();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败${skipped?` / ${skipped} 跳过`:''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('本地链路测试异常:', e); process.exit(1); });
