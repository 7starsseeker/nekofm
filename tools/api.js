#!/usr/bin/env node
/**
 * NekoFM 命令行客户端
 * ====================
 * 给已经运行中的实例发一条指令，或读一次状态。用来排查问题、脚本化操作。
 *
 * 用法：
 *   node tools/api.js state
 *   node tools/api.js state playback.duration
 *   node tools/api.js cmd '{"action":"seek","position":30}'
 *   node tools/api.js seek 30
 *   node tools/api.js order "孤勇者"
 *   node tools/api.js devices
 *   node tools/api.js diag            # 打印一份排障快照
 *
 * 可选 --port 指定端口（默认读 config.json，再退回 37821）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readPort(argv) {
  const i = argv.indexOf('--port');
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]);
  try {
    const cfgFile = path.join(ROOT, 'data', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (cfg && cfg.server && cfg.server.port) return cfg.server.port;
  } catch { /* 忽略 */ }
  return 37821;
}

/** 读配置里的 host（默认 127.0.0.1）。**必须跟随**：换成 127.0.0.2 与 AdGuard 共存时，
 *  写死 127.0.0.1 就一个命令都发不出去（那台地址上根本没服务）。 */
function readHost() {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    if (cfg && cfg.server && cfg.server.host) return cfg.server.host;
  } catch { /* 忽略 */ }
  return '127.0.0.1';
}

const argv = process.argv.slice(2);
const port = readPort(argv);
const host = (() => {
  const i = argv.findIndex((a) => a === '--host');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : readHost();
})();
const base = `http://${host}:${port}`;
const cmd = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || 'state';
/**
 * 参数解析要小心：**不能把纯数字参数一律过滤掉**（原来那版就是这样），
 * 否则 `seek 40` 会被解析成 `seek 0` —— 我第一版栽在这，
 * 结果对着服务端查了半天，其实是自己的工具把 40 吃掉了。
 * 正确做法：先摘掉 `--port <值>`，剩下的第一个当子命令，其余原样作为参数。
 */
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') { i++; continue; }
  if (argv[i].startsWith('--')) continue;
  positional.push(argv[i]);
}
const cmdName = positional[0] || 'state';
const rest = positional.slice(1);

const post = async (body) => {
  const r = await fetch(base + '/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};
const getState = async () => (await fetch(base + '/api/state')).json();

/** 按点号路径取值，便于脚本里取单个字段 */
const pick = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

(async () => {
  let out;
  switch (cmdName) {
    case 'state': {
      const s = await getState();
      out = rest.length ? pick(s, rest[0]) : s;
      break;
    }
    case 'cmd': {
      out = await post(JSON.parse(rest[0] || '{}'));
      break;
    }
    case 'seek': out = await post({ action: 'seek', position: Number(rest[0] || 0) }); break;
    case 'order': out = await post({ action: 'order', keyword: rest.join(' '), source: null }); break;
    // 路径里常有空格，shell 会把它拆成多个参数 —— 这里按空格拼回一条路径，
    // 免得 "D:/Music/My Song.flac" 被当成三个文件。
    case 'open': out = await post({ action: 'localOpenFiles', paths: [rest.join(' ')] }); break;
    case 'folder': out = await post({ action: 'localOpenFolder', dirs: [rest.join(' ')] }); break;
    case 'mode': out = await post({ action: 'setPlayMode', mode: rest[0] }); break;
    case 'device': out = await post({ action: 'setDevice', deviceId: rest[0] || '' }); break;
    case 'volume': out = await post({ action: 'setVolume', volume: Number(rest[0]) }); break;
    // 窗口控制（这些原本要手写 JSON，在 cmd 里转义很容易出错）
    case 'showplayer': out = await post({ action: 'showPlayerWindow' }); break;
    case 'hideoverlay': out = await post({ action: 'hideOverlayWindow' }); break;
    case 'showoverlay': out = await post({ action: 'showOverlayWindow' }); break;
    case 'showcontrol': out = await post({ action: 'showControlWindow' }); break;
    // 预览：preview both|lyrics|info|all|hide [lyrics|info|both]
    case 'preview': {
      const m = rest[0] || 'both';
      out = m === 'hide'
        ? await post({ action: 'hideOverlayWindow', mode: rest[1] || 'both' })
        : await post({ action: 'showOverlayWindow', mode: m });
      break;
    }
    case 'pdiag': out = await post({ action: 'playerDiag' }); break;
    case 'wdiag': out = await post({ action: 'windowsDiag' }); break;
    case 'pause': out = await post({ action: 'pause' }); break;
    case 'resume': out = await post({ action: 'resume' }); break;
    case 'next': out = await post({ action: 'skip' }); break;
    case 'devices': {
      const s = await getState();
      out = { playerDevices: s.playerDevices, configured: s.player && s.player.deviceId };
      break;
    }
    case 'diag': {
      const s = await getState();
      out = {
        port, track: s.track && s.track.name, source: s.track && s.track.source,
        status: s.playback && s.playback.status,
        position: s.playback && Number(s.playback.position.toFixed(2)),
        duration: s.playback && Number((s.playback.duration || 0).toFixed(2)),
        streamUrl: s.streamUrl,
        playerDevice: s.player && s.player.deviceId,
        playerDevices: s.playerDevices,
        lyricLines: s.lyric && s.lyric.count, lyricSource: s.lyric && s.lyric.source,
        queue: s.queue && s.queue.total, notices: s.notices,
      };
      break;
    }
    default:
      console.error('未知子命令：' + cmdName);
      console.error('可用：state [路径] / cmd <json> / seek <秒> / order <关键词> [源] / open <文件…> / folder <目录…> / mode <模式> / device <id> / pause / resume / next / devices / diag');
      process.exit(2);
  }
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error('请求失败：' + e.message);
  console.error(`（确认程序在跑、端口是 ${port}；用 --port 可指定其它端口）`);
  process.exit(1);
});
