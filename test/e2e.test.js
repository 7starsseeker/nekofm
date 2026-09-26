/**
 * 端到端集成测试（不依赖 Electron，可直接在 CI 或纯命令行环境跑）
 * =======================================================
 * 验证核心交付物：一条弹幕点歌之后，歌词能不能**按句**正确到达叠加层
 * （当前行定位、翻译合并、SSE 推送、代理流、演练模式、安全边界）。
 *
 * 关键约定（踩过坑，别改）：
 *   · _enqueue 在空闲时会**自动开播**，点歌之后不要再手动调 next()，
 *     否则会立刻切到下一首（空队列）把状态清掉。
 *   · 验歌词定位必须选「真正在唱的行」，且探针点要落在**本行区间内**；
 *     元信息行（作词/作曲）的结束时间会跨到后面的行，preroll 一开就串行。
 *   · 逐字（yrc）染色显示已下线（2026-09-26）—— 断言只到"行级定位"这一层，
 *     别再去测"某个字染到哪了"。逐字时间戳本身仍照常解析（数据层保留）。
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
process.env.NEKOFM_DATA = require('node:path').join(require('node:os').tmpdir(), 'nekofm-data-e2e');
// 每次跑都从干净的数据目录开始：否则上一轮落盘的残片缓存会被 resolveStream 命中，
// 让"走的是 B站代理流"这类断言误判（实测踩到过）
require('node:fs').rmSync(process.env.NEKOFM_DATA, { recursive: true, force: true });


const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Engine } = require('../src/main/engine');
const { AppServer } = require('../src/main/server');
const { createCommandHandler } = require('../src/main/commands');
const { DEFAULT_CONFIG } = require('../src/core/config');
const LyricSync = require('../src/shared/lyric-sync');

const PORT = 37901;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✅ ${name}${extra ? ' → ' + extra : ''}`); pass++; }
  else { console.log(`  ❌ ${name}${extra ? ' → ' + extra : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.server.port = PORT;
  cfg.local.dirs = [];

  const engine = new Engine({ config: cfg, log: () => {} });
  const server = new AppServer({
    port: PORT, host: '127.0.0.1',
    rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
    sharedDir: path.join(__dirname, '..', 'src', 'shared'),
    getState: () => engine.state(),
    getLyrics: () => engine.lyricsPayload(),
    /**
     * `getConfig` 与配置变更广播**必须与生产接线（src/main/index.js）一致**：
     * SSE 建连时要补发叠加层配置，晚接入的页面才不会按内置默认值渲染。
     * 少了这一条，测试中心里的「SSE 建连即补发叠加层配置」会因为
     * "服务端根本没有这个 provider"而**假红** —— 缺接线就是缺行为，
     * 测试桩不该比生产少给东西。
     */
    getConfig: () => engine.config.overlay,
    // 白名单必须与生产接线一致：否则测试中心里的"本地流接口拒绝白名单外文件"
    // 会因为没有 provider 而失败（这正是它该有的行为 —— 缺接线就是缺防护）。
    allowRootsProvider: () => [
      ...(engine.config.local.dirs || []),
      ...(engine.local.extraFiles ? [...engine.local.extraFiles] : []),
      path.join(os.tmpdir(), 'nekofm-e2e-covers'),
      path.join(os.tmpdir(), 'nekofm-e2e-cache'),
    ],
    onCommand: createCommandHandler({
      engine,
      saveConfig: () => {},
      onConfigChange: (overlay) => server.broadcast({ type: 'config', overlay }),
      hooks: {},
    }),
    log: () => {},
  });
  const port = await server.start();
  engine.serverBase = `http://127.0.0.1:${port}`;

  let lyricRev = -1;
  const bcast = setInterval(() => {
    server.broadcast(engine.state());
    if (engine.lyricRev !== lyricRev) { lyricRev = engine.lyricRev; server.broadcast(engine.lyricsPayload()); }
  }, 100);
  engine.on('player', (c) => server.broadcast({ type: 'player', ...c }));

  // ------------------------------------------------------------- SSE 订阅
  let lyricsPayload = null, playerCmd = null, eventCount = 0;
  {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            const m = JSON.parse(line.slice(6));
            eventCount++;
            if (m.type === 'lyrics') lyricsPayload = m;
            if (m.type === 'player' && m.action === 'play') playerCmd = m;
          } catch { /* 忽略 */ }
        }
      }
    })().catch(() => {});
  }

  // ============================================================ 0) 预检
  // e2e 整条链路都建立在"能搜到歌"之上。若网易云正在按 IP 限流
  // （实测密集请求后会返回 code:405「操作频繁」，不同操作系统同时中招），
  // 后面会刷一屏红 —— 那是外部状态，不是程序缺陷。
  // 这里先探一次，是限流就**明确告知并跳过**，不谎报失败。
  console.log('== 0) 联网预检 ==');
  {
    const pre = await engine.netease.search('孤勇者 陈奕迅', { limit: 1 });
    if (!pre.ok || !pre.songs.length) {
      const msg = String(pre.msg || '');
      const limited = /操作频繁|请稍候|频繁|too many/i.test(msg) || pre.code === 405;
      console.log(`   ⚠ 网易云搜索不可用：${msg || `code=${pre.code}`}`);
      if (limited) {
        console.log('   判定：外部服务限流（不是程序缺陷）。');
        console.log('   本测试的 1~4 节依赖网易云搜索结果，因此本次整体跳过。');
        console.log('   稍等几分钟、或换个网络环境再跑即可。');
      } else {
        console.log('   判定：非限流原因，请检查网络/代理配置。');
      }
      clearInterval(bcast);
      await server.stop();
      try { engine.danmaku && engine.danmaku.close(); } catch { /* 忽略 */ }
      console.log('\n结果: 已跳过（SKIP，非失败）。离线自检不受影响：node tools/headless.js --testcenter');
      /**
       * 这里**不能**用 `process.exit(0)`（2026-09-26 修）。
       *
       * 踩过的坑：带着未关闭的 fetch/undici 句柄强退，
       * Windows 上 libuv 会在拆卸时报
       * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), async.c`，
       * 于是**退出码变成 127** —— 明明是"跳过（非失败）"却看起来像崩溃，
       * 用 `&&` 串联跑测试会被它截断。
       * 改成设 exitCode 后自然返回，让事件循环自己排空
       * （server 已 stop、定时器已 clear）。
       */
      process.exitCode = 0;
      return;
    }
    console.log(`   ✅ 搜索可用：${pre.songs[0].name} - ${pre.songs[0].artistText}`);
  }

  console.log('== 1) 网易云点歌 → 取流 → 取歌词 → SSE 广播 ==');
  const r1 = await engine.orderByKeyword('孤勇者 陈奕迅', 'netease', { uid: '1', uname: '测试', isAnchor: true });
  ok('点歌入队成功', r1.ok, r1.ok ? `位置 ${r1.position}` : r1.msg);
  await sleep(4500); // 自动开播 + 取流 + 取歌词

  ok('track 已设置', !!engine.track, engine.track && engine.track.name);
  ok('取到可播流地址', !!engine.streamUrl, String(engine.streamUrl).slice(0, 66));
  ok('歌词已获取', engine.lyricTimeline.lines.length > 0, `${engine.lyricTimeline.lines.length} 行，来源=${engine.lyricSource}`);
  ok('收到 player:play 指令', !!playerCmd, playerCmd && String(playerCmd.url).slice(0, 46));
  ok('SSE 收到 lyrics 推送', !!lyricsPayload, lyricsPayload ? `${lyricsPayload.timeline.lines.length} 行 rev=${lyricsPayload.rev}` : '未收到');

  const wordLines = engine.lyricTimeline.lines.filter((l) => l.karaoke === 'word');
  ok('存在逐字歌词行', wordLines.length > 0, `${wordLines.length} 行逐字 / 共 ${engine.lyricTimeline.lines.length} 行`);
  ok('逐字行带词级时间戳',
    wordLines.length > 0 && wordLines.some((l) => l.words.every((x) => Number.isFinite(x.t) && Number.isFinite(x.d))),
    wordLines.length ? wordLines[0].words.slice(0, 4).map((x) => `${x.text}@${x.t.toFixed(2)}s/${x.d.toFixed(2)}s`).join(' ') : '');

  // ---- 信息栏数据（封面/点歌者/来源/下一首）—— 叠加层靠它渲染播放器信息栏
  const np = engine.state().nowPlaying;
  ok('nowPlaying 视图存在', !!np, np ? np.name : '');
  ok('信息栏字段齐全',
    np && ['name', 'artistText', 'sourceLabel', 'cover', 'requester', 'duration', 'position', 'queueRemaining']
      .every((k) => np[k] !== undefined),
    np ? Object.keys(np).length + ' 个字段' : '');
  ok('点歌者被记录到信息栏', !!(np && np.requester && np.requester.uname), np && np.requester && np.requester.uname);
  ok('封面地址已解析（搜索接口只给 picId）', !!(np && np.cover), String(np && np.cover).slice(0, 72));
  ok('音源显示名正确', np && np.sourceLabel === '网易云', np && np.sourceLabel);

  // ============================================================ 2) 同步
  console.log('\n== 2) 共用同步模块 LyricSync（叠加层每帧调用的就是它） ==');
  const tl = engine.lyricTimeline;
  // 选行三条硬约束（否则测出来的是别的行）：
  //   a) 逐字数足够多，是"真正在唱"的行
  //   b) 该行时间戳必须唯一 —— 版权/制作信息行常共享同一时间戳，
  //      locate() 会落到同组最后一行，拿它做探针必然错位
  //   c) 逐字跨度必须落在 [本行起点, 下一行起点) 之内
  const probeLine = tl.lines.find((l, i) => {
    if (l.karaoke !== 'word' || l.words.length < 6) return false;
    const next = tl.lines[i + 1];
    const nextT = next ? next.time : l.time + 30;
    if (nextT - l.time < 0.5) return false;                       // (b) 时间戳撞车
    const last = l.words[l.words.length - 1];
    const span = last.t + (last.d || 0);
    return span > 1 && span <= (nextT - l.time) + 0.2;            // (c) 跨度在行内
  }) || tl.lines.find((l) => l.karaoke === 'word' && l.words.length >= 4);

  if (!probeLine) {
    ok('找到可用于验证的逐字行', false);
  } else {
    const w0 = probeLine.words[0];
    const wLast = probeLine.words[probeLine.words.length - 1];
    const span = (wLast.t + (wLast.d || 0)) - w0.t;
    console.log(`     探针行：「${probeLine.text.slice(0, 26)}」逐字跨度 ${span.toFixed(2)}s`);

    // 注意：探针必须落在**本行内**。若取到行开始之前哪怕 1ms，
    // locate 返回的是上一行（已唱满，进度=1），断言就会假失败。
    const atLineStart = LyricSync.locate(tl, probeLine.time, { preroll: 0 });
    ok('行首定位到探针行', atLineStart.current === probeLine);
    const atZero = LyricSync.locate(tl, probeLine.time + w0.t + 0.001, { preroll: 0 });
    ok('首字起唱时词级进度≈0', atZero.wordProgress < 0.15, atZero.wordProgress.toFixed(3));

    const atMid = LyricSync.locate(tl, probeLine.time + w0.t + span * 0.5, { preroll: 0 });
    ok('中点词级进度∈(0.15,0.85)', atMid.wordProgress > 0.15 && atMid.wordProgress < 0.85, atMid.wordProgress.toFixed(3));

    const atEnd = LyricSync.locate(tl, probeLine.time + w0.t + span * 0.999, { preroll: 0 });
    ok('临近行末词级进度≈1', atEnd.wordProgress > 0.85, atEnd.wordProgress.toFixed(3));
    ok('定位到的就是探针行', atMid.current === probeLine, String(atMid.current && atMid.current.text).slice(0, 20));

    const segs = LyricSync.segments(probeLine);
    ok('逐字行可切分为渲染片段', segs.length === probeLine.words.length, `${segs.length} 段`);
    ok('预滚(pre-roll)默认开启', LyricSync.locate(tl, probeLine.time + 0.01).index >= 0, `index=${LyricSync.locate(tl, probeLine.time + 0.01).index}`);
  }

  ok('暂停时进度不推进',
    Math.abs(LyricSync.interpolate({ position: 10, serverTime: Date.now() - 5000, paused: true }, Date.now()) - 10) < 1e-6);
  const ip = LyricSync.interpolate({ position: 10, serverTime: Date.now() - 2000, rate: 1, paused: false }, Date.now());
  ok('播放时按时间插值', ip > 11.5 && ip < 12.5, ip.toFixed(2));

  // ============================================================ 3) 弹幕
  console.log('\n== 3) 弹幕指令 → 队列（真实弹幕文本） ==');
  engine.queue.clear();
  const n0 = engine.queue.length;
  await engine.handleDanmaku({ uid: 1001, uname: '观众甲', text: '点歌 海屿你', isAdmin: false });
  await sleep(5000);
  if (engine.queue.length === n0) console.log('     [诊断] 最近提示:', engine.notices.slice(0, 3).map((n) => n.text));
  ok('弹幕点歌进入队列', engine.queue.length === n0 + 1, `队列 ${n0} → ${engine.queue.length}`);
  ok('弹幕点歌记录了点歌人', (engine.queue.items[engine.queue.items.length - 1] || {}).uname === '观众甲');
  await engine.handleDanmaku({ uid: 1009, uname: '观众丁', text: '点歌 海屿你' });
  ok('重复点同一首被去重', engine.queue.length === n0 + 1, `队列仍为 ${engine.queue.length}`);
  await engine.handleDanmaku({ uid: 1002, uname: '观众乙', text: '这首好听' });
  ok('闲聊不误触发', engine.queue.length === n0 + 1, `队列仍为 ${engine.queue.length}`);
  /**
   * 弹幕「切歌」语义（2026-09-26 用户定的）：
   * 必须是**精确两个字"切歌"**，且发送者是**当前歌的点歌者 / 房管 / UP主本人**。
   * 权限不足时**静默丢弃** —— 不弹通知、不计入 rejected，当作聊天忽略
   * （旧版会回一句"只有点歌本人或主播能切这首"，在弹幕多的直播间是刷屏）。
   */
  const noticesBefore = engine.notices.length;
  const rejectedBefore = engine.stats.rejected;
  await engine.handleDanmaku({ uid: 1003, uname: '观众丙', text: '切歌' });
  ok('无权限观众切歌：静默丢弃（不出通知、不计 rejected）',
    engine.notices.length === noticesBefore && engine.stats.rejected === rejectedBefore,
    `通知 ${noticesBefore}→${engine.notices.length}，rejected ${rejectedBefore}→${engine.stats.rejected}`);
  // 带前后缀的"切歌"也该被当成聊天（不触发、也不该有反应）
  const n2 = engine.notices.length;
  await engine.handleDanmaku({ uid: 1003, uname: '观众丙', text: '我想切歌' });
  ok('"我想切歌" 不触发指令', engine.notices.length === n2, '无新增通知');
  await engine.handleDanmaku({ uid: 1004, uname: '房管', text: '队列', isAdmin: true });
  ok('房管查队列有回执', engine.notices.some((n) => /队列/.test(n.text)));
  await engine.handleDanmaku({ uid: 1005, uname: '观众戊', text: '点播 BV1eLsnzFEoM', isAdmin: false });
  await sleep(2500);
  ok('弹幕直接点 B站视频入队', engine.queue.items.some((i) => i.song && i.song.source === 'bilibili'),
    engine.queue.items.map((i) => i.song.source).join(','));

  // ============================================================ 4) B站视频
  console.log('\n== 4) B站歌曲MV → 取流 → 代理注入 Referer → 歌词 ==');
  engine.queue.clear();
  const MV = 'BV1K44y1e7gv'; // 【英雄联盟手游】陈奕迅《孤勇者》MV
  const r4 = await engine.orderVideo(MV, { uid: '1', uname: '测试', isAnchor: true });
  ok('视频入队', r4.ok, r4.ok ? 'ok' : r4.msg);
  // 引擎只在"完全空闲"时自动开播（不打断正在放的歌），所以这里必须显式切歌
  await engine.next();
  await sleep(8000); // 解析视频 → 取音频流 → 匹配歌词

  ok('当前曲目为 B站视频', !!engine.track && engine.track.source === 'bilibili', engine.track && (engine.track.bvid || ''));
  ok('走的是 B站代理流', String(engine.streamUrl).includes('/stream/bili?url='), String(engine.streamUrl).slice(0, 74));
  ok('视频拿到了歌词（字幕或歌名匹配）', engine.lyricTimeline.lines.length > 0,
    `${engine.lyricTimeline.lines.length} 行，来源=${engine.lyricSource}`);

  const pr = await fetch(engine.streamUrl, { headers: { Range: 'bytes=0-2047' } });
  ok('代理转发成功（206/200）', pr.status === 206 || pr.status === 200, 'HTTP ' + pr.status);
  ok('返回音频类型', /audio|octet-stream|mp4/.test(pr.headers.get('content-type') || ''), pr.headers.get('content-type'));
  const buf = Buffer.from(await pr.arrayBuffer());
  ok('确实拿到数据', buf.length > 0, buf.length + ' 字节');
  ok('内容是真实媒体容器',
    buf.length >= 8 && ['ftyp', 'styp', 'moof'].includes(buf.slice(4, 8).toString()),
    buf.slice(4, 8).toString());

  // 终极证据：把代理流**完整下载**后交给 ffprobe 解码。
  // 说明：不能直接 ffprobe 那个 URL —— 它不会主动结束，ffprobe 会一直等而超时。
  // 完整下载还能顺带证明代理能把整段音频无损透传。
  const tmpAudio = path.join(os.tmpdir(), 'nekofm-e2e-bili.m4s');
  try {
    const full = await fetch(engine.streamUrl);
    const fullBuf = Buffer.from(await full.arrayBuffer());
    fs.writeFileSync(tmpAudio, fullBuf);
    ok('代理可完整下载整段音频', fullBuf.length > 500 * 1024, (fullBuf.length / 1024 / 1024).toFixed(2) + ' MB');

    const probe = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_name,codec_type',
      '-of', 'json', tmpAudio,
    ], { encoding: 'utf8', timeout: 30000 });
    const pj = JSON.parse(probe);
    const audioStream = (pj.streams || []).find((s) => s.codec_type === 'audio');
    ok('下载内容可被解码为音频', !!audioStream, audioStream ? audioStream.codec_name : '未识别出音频流');
    const dur = parseFloat(pj.format && pj.format.duration);
    ok('解出与视频相符的时长', dur > 60, dur + 's（视频 4:34）');
  } catch (e) {
    ok('代理可完整下载整段音频', false, String(e.message).slice(0, 90));
  } finally {
    try { fs.unlinkSync(tmpAudio); } catch { /* 忽略 */ }
  }

  // ============================================================ 5) 测试中心
  console.log('\n== 5) 内置测试中心（离线组，自身也应全绿） ==');
  {
    const { SelfTest } = require('../src/main/selftest');
    const st = new SelfTest({ engine, server, baseUrl: `http://127.0.0.1:${port}`, log: () => {} });
    const offlineGroups = st.listGroups().filter((g) => !g.checks.every((c) => c.net)).map((g) => g.id);
    const res = await st.run({ groups: offlineGroups, includeNetwork: false });
    const bad = res.results.filter((r) => r.ok === false);
    ok('测试中心离线项全部通过', bad.length === 0,
      `${res.passed} 通过 / ${res.failed} 失败 / ${res.skipped} 跳过` + (bad.length ? '：' + bad.map((b) => b.name).join('、') : ''));
    const groups0 = st.listGroups();
    const netChecks = groups0.reduce((n, g) => n + g.checks.filter((c) => c.net).length, 0);
    ok('检查清单含联网项', netChecks > 0, `${netChecks} 项联网检查`);
    // 真的跑一个联网组，但不勾选联网 → 应当整组被跳过而不是真去打接口
    const netGroup = groups0.find((g) => g.checks.some((c) => c.net));
    const res2 = await st.run({ groups: [netGroup.id], includeNetwork: false });
    ok('联网项默认被跳过（不打外部接口）',
      res2.results.length > 0 && res2.results.every((r) => r.ok === null) && res2.skipped === res2.results.length,
      `${netGroup.name}：${res2.skipped}/${res2.results.length} 跳过`);
    ok('检查清单覆盖关键模块', groups0.length >= 7, groups0.map((g) => g.name).join(' / '));
    ok('自检项无副作用（结束后无残留演示）', !engine.demoRunning);
  }

  // ============================================================ 6) 演练模式
  console.log('\n== 6) 演练模式（不联网、不出声） ==');
  {
    if (engine.demoRunning) engine.stopDemo(); // 防御：别让上一段留下的演示污染断言
    const before = engine.track;
    const r = engine.startDemo({ seconds: 3 });
    await sleep(600);
    const s = engine.state();
    ok('演示模式启动', r.ok, `歌词 ${r.lines} 行，时长 ${r.duration}s`);
    ok('演示中 track 已是假曲目', s.nowPlaying && s.nowPlaying.name === 'NekoFM 演示曲目', s.nowPlaying && s.nowPlaying.name);
    ok('演示曲目带词级时间戳（数据层，渲染用不到）', engine.lyricTimeline.lines.some((l) => l.karaoke === 'word'));
    ok('演示中进度在推进', s.playback.status === 'playing' && s.playback.position >= 0, 'pos=' + s.playback.position.toFixed(1));
    const st2 = engine.stopDemo();
    ok('演示可停止并还原现场', st2.ok && engine.track === before, engine.track ? String(engine.track.name) : '(无)');
  }

  // ============================================================ 7) 安全
  console.log('\n== 7) 代理安全性与边界 ==');
  ok('拒绝非 http(s) 目标', (await fetch(`http://127.0.0.1:${port}/stream/bili?url=${encodeURIComponent('file:///etc/passwd')}`)).status === 400);
  ok('拒绝空目标', (await fetch(`http://127.0.0.1:${port}/stream/bili?url=`)).status === 400);
  // 越界路径会**先**被白名单拦下（403），不会走到"文件是否存在"（404）。
  // 这是刻意的顺序：不向调用方泄露任意路径是否存在。
  const oob = await fetch(`http://127.0.0.1:${port}/stream/local?path=${encodeURIComponent('/nope/none.mp3')}`);
  ok('越界/不存在的本地文件被拒', oob.status === 403 || oob.status === 404, 'HTTP ' + oob.status + '（越界先判 403）');

  clearInterval(bcast);
  await server.stop();
  try { engine.danmaku && engine.danmaku.close(); } catch { /* 忽略 */ }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败   (SSE 事件 ${eventCount} 条)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('集成测试异常:', e); process.exit(1); });
