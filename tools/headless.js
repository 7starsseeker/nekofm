#!/usr/bin/env node
/**
 * headless 运行 / 自测台（不依赖 Electron）
 * ==========================================
 * 用途一：开发与验证。在没有图形环境的机器（或纯命令行环境）也能把
 *         「点歌 → 取流 → 取歌词 → SSE 广播 → 叠加层页面」全链路跑起来。
 * 用途二：降级运行。若不想装 Electron，用本脚本起服务，
 *         叠加层照样给直播姬浏览器源用；只是没有内置播放器窗口，
 *         此时可以用任意浏览器打开 /player 来当播放核心。
 *
 * 用法：
 *   node tools/headless.js                       # 起服务
 *   node tools/headless.js --port 37821
 *   node tools/headless.js --order "孤勇者"       # 启动后自动点一首
 *   node tools/headless.js --simulate             # 模拟播放进度（用于验证歌词同步）
 *   node tools/headless.js --selftest             # 起服务 + 自动断言 + 退出
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { Engine } = require('../src/main/engine');
const { AppServer } = require('../src/main/server');
const { createCommandHandler } = require('../src/main/commands');
const { DEFAULT_CONFIG, deepMerge, configPath } = require('../src/core/config');

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const has = (name) => argv.includes('--' + name);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const { dir, file } = configPath();
  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) config = deepMerge(config, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) { log('[config] 读取失败，用默认值:', e.message); }

  const port = Number(flag('port', config.server.port)) || 37821;
  config.server.port = port;

  const engine = new Engine({ config, log });
  const saveConfig = (cfg) => { try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch { /* 忽略 */ } };

  const handleCommand = createCommandHandler({
    engine,
    saveConfig,
    onConfigChange: (overlay) => server.broadcast({ type: 'config', overlay }),
    hooks: {},
  });

  const server = new AppServer({
    port,
    host: config.server.host,
    rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
    sharedDir: path.join(__dirname, '..', 'src', 'shared'),
    getState: () => engine.state(),
    getLyrics: () => engine.lyricsPayload(),
    getConfig: () => engine.config.overlay,
    allowRootsProvider: () => [
      ...(engine.config.local.dirs || []),
      ...(engine.local.extraFiles ? [...engine.local.extraFiles] : []),
      path.join(dir, 'covers'),
      engine.cache.cacheDir,
    ],
    onCommand: handleCommand,
    log,
  });

  const bound = await server.start();
  engine.serverBase = `http://${config.server.host}:${bound}`;

  // 内置测试中心（与 Electron 模式共用同一份检查清单）
  const { SelfTest } = require('../src/main/selftest');
  engine.selftest = new SelfTest({ engine, server, baseUrl: engine.serverBase, log });

  let lyricRev = -1;
  setInterval(() => {
    server.broadcast(engine.state());
    if (engine.lyricRev !== lyricRev) {
      lyricRev = engine.lyricRev;
      server.broadcast(engine.lyricsPayload());
    }
  }, 100);

  engine.on('player', (c) => server.broadcast({ type: 'player', ...c }));
  // 注意：Engine.notify() 内部已经调用 log 打过一次，这里不要再打，
  // 否则每条提示都会重复输出两遍。

  await engine.init();

  log('==================================================');
  log(`控制台        ${server.baseUrl}/`);
  log(`播放核心      ${server.baseUrl}/player`);
  log(`歌词叠加层    ${server.baseUrl}/overlay   ← 填进直播姬浏览器源`);
  log('==================================================');

  const room = flag('room');
  if (room) {
    try { await engine.connectDanmaku(room); log(`弹幕已连接房间 ${room}`); }
    catch (e) { log('弹幕连接失败:', e.message); }
  }

  const order = flag('order');
  if (order) {
    const r = await engine.orderByKeyword(String(order), flag('source') || null, { uid: 'cli', uname: 'CLI', isAnchor: true });
    log('点歌结果:', JSON.stringify(r && { ok: r.ok, reason: r.reason, position: r.position, msg: r.msg }));
  }

  // 打开本地音乐（headless 下没有原生对话框，直接给路径）
  const localFile = flag('local-file');
  if (localFile) {
    const r = await engine.openLocalFiles([String(localFile)], { enqueue: true, play: true });
    log('打开本地文件:', JSON.stringify({ ok: r.ok, added: (r.added || []).map((x) => x.name), queued: r.queued, msg: r.msg }));
  }
  const localDir = flag('local-dir');
  if (localDir) {
    const r = await engine.openLocalFolder(String(localDir));
    log('加入曲库目录:', JSON.stringify({ ok: r.ok, dir: r.dir, total: r.total, msg: r.msg }));
  }

  // 模拟播放进度：验证歌词同步链路（真实播放由 /player 页面上报）
  if (has('simulate')) {
    let pos = Number(flag('simulate', 0)) || 0;
    setInterval(() => {
      // 只有真的加载了曲目才推进/置为 playing。
      // 否则会把状态一直顶成 playing，害得"空闲才自动开播"的判断永远不成立（踩过）。
      if (!engine.track) return;
      pos += 0.1;
      engine.onPlayerEvent({ type: 'position', position: pos, duration: engine.playback.duration || 240 });
      if (engine.playback.status !== 'playing') engine.onPlayerEvent({ type: 'status', status: 'playing' });
    }, 100);
    log('已开启播放进度模拟');
  }

  // 测试中心：跑完整检查清单（`--net` 时包含联网项），打印报告后退出
  if (has('testcenter')) {
    const includeNetwork = has('net');
    const groupsArg = flag('groups');
    const groups = typeof groupsArg === 'string' ? groupsArg.split(',') : null;
    console.log(`\n内置测试中心：${includeNetwork ? '包含联网项' : '仅离线项（加 --net 可跑联网项）'}\n`);
    const res = await engine.selftest.run({
      groups,
      includeNetwork,
      onResult: (r) => {
        const mark = r.ok === true ? '✅' : r.ok === null ? '⏭️ ' : '❌';
        console.log(`  ${mark} [${r.groupName}] ${r.name}${r.detail ? ' → ' + r.detail : ''}${r.ms ? ` (${r.ms}ms)` : ''}`);
      },
    });
    console.log(`\n结果: 通过 ${res.passed} / 失败 ${res.failed} / 跳过 ${res.skipped}（共 ${res.total}，耗时 ${res.ms}ms）`);
    await server.stop();
    process.exit(res.failed ? 1 : 0);
  }

  // 自测：起服务 → 验证关键端点 → 退出
  if (has('selftest')) {
    const base = server.baseUrl;
    const check = async (name, fn) => {
      try { const v = await fn(); log(`  ${v ? '✅' : '❌'} ${name}${v === true ? '' : ' → ' + JSON.stringify(v)}`); return !!v; }
      catch (e) { log(`  ❌ ${name} → ${e.message}`); return false; }
    };
    let ok = 0; let total = 0;
    const T = async (n, f) => { total++; if (await check(n, f)) ok++; };

    await T('GET / 返回控制台 HTML', async () => (await (await fetch(base + '/')).text()).includes('<!DOCTYPE html>'));
    await T('GET /overlay 可访问', async () => (await fetch(base + '/overlay')).ok);
    await T('GET /player 可访问', async () => (await fetch(base + '/player')).ok);
    await T('GET /shared/lyric-sync.js 可访问', async () => (await fetch(base + '/shared/lyric-sync.js')).ok);
    await T('GET /api/state 返回 JSON', async () => (await (await fetch(base + '/api/state')).json()).type === 'state');
    await T('POST /api/command getConfig', async () => (await (await fetch(base + '/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'getConfig' }),
    })).json()).ok);
    await T('SSE /events 有推送', async () => {
      // 注意：SSE 首包可能只有 "retry: 1000"，不能只读一次就判定失败。
      // 这里连续读直到出现 data: 行为止（带超时）。
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      try {
        const res = await fetch(base + '/events', { signal: ac.signal });
        const reader = res.body.getReader();
        let acc = '';
        for (let i = 0; i < 10; i++) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += Buffer.from(value).toString();
          if (acc.includes('"type":"state"')) { try { reader.cancel(); } catch { /* 忽略 */ } return true; }
        }
        try { reader.cancel(); } catch { /* 忽略 */ }
        return false;
      } finally { clearTimeout(timer); }
    });
    await T('SSE 建连即补发当前歌词', async () => {
      const res = await fetch(base + '/events');
      const reader = res.body.getReader();
      let acc = '';
      for (let i = 0; i < 10; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += Buffer.from(value).toString();
        if (acc.includes('"type":"lyrics"')) { try { reader.cancel(); } catch { /* 忽略 */ } return true; }
      }
      try { reader.cancel(); } catch { /* 忽略 */ }
      return false;
    });
    await T('GET /api/lyrics 可用', async () => {
      const j = await (await fetch(base + '/api/lyrics')).json();
      return j.type === 'lyrics' && !!j.timeline;
    });
    await T('未知指令应报错', async () => {
      const r = await (await fetch(base + '/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'nope' }),
      })).json();
      return r.ok === false;
    });
    if (order) {
      await T('点歌后 track 已设置', async () => !!(await (await fetch(base + '/api/state')).json()).track);
    }

    log(`\n自测结果: ${ok}/${total} 通过`);
    await server.stop();
    process.exit(ok === total ? 0 : 1);
  }

  process.on('SIGINT', async () => { log('退出中…'); await server.stop(); process.exit(0); });
})().catch((e) => { console.error('启动失败:', e); process.exit(1); });
