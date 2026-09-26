#!/usr/bin/env node
/**
 * 启动器（被 start.bat 调用）
 * ==========================
 * 为什么中文提示放在这里而不是 .bat 里：
 *   Windows 的 cmd.exe 按**控制台代码页**（中文系统是 936/GBK）解析批处理文件字节，
 *   而 .bat 通常是 UTF-8 —— 中文必然乱码，严重时某些字节被当成分隔符，
 *   cmd 会把中文当命令去执行（实测会打印一堆"'…' 不是内部或外部命令"）。
 *   所以：.bat 只保留纯 ASCII，所有面向用户的文字由 Node 输出（UTF-8 + chcp 65001）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function line(s = '') { process.stdout.write(s + '\n'); }

line('==============================================');
line('  NekoFM  ·  B站直播音乐与歌词系统');
line('==============================================');
line();

// 1) Node 版本
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
  line(`[错误] Node 版本过低：当前 v${process.versions.node}，需要 22 或更高。`);
  line('       下载地址：https://nodejs.org/');
  process.exit(1);
}
line(`Node  v${process.versions.node}  ✓`);

// 2) 依赖（Electron 二进制）
const electronDir = path.join(ROOT, 'node_modules', 'electron');
const electronBin = process.platform === 'win32'
  ? path.join(electronDir, 'dist', 'electron.exe')
  : path.join(electronDir, 'dist', 'electron');

if (!fs.existsSync(electronBin)) {
  line('未检测到 Electron，正在安装依赖（首次约 100MB，请耐心等待）…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0 || !fs.existsSync(electronBin)) {
    line();
    line('[错误] 依赖安装失败或 Electron 未就位。');
    line('       可以改用降级模式（不装 Electron，用浏览器当播放核心）：');
    line('         node tools\\headless.js');
    line('       然后浏览器打开 http://127.0.0.1:37821/player');
    process.exit(1);
  }
}
line('Electron  ✓');

// 3) 数据目录（跟着程序走，不写系统盘用户目录）
const dataDir = process.env.NEKOFM_DATA || path.join(ROOT, 'data');
line(`数据目录  ${dataDir}`);

// 4) 启动（--check-only 只做环境自检，不拉起 GUI —— 便于自动测试启动器本身）
if (process.argv.includes('--check-only')) {
  line();
  line('环境自检通过（--check-only：不启动界面）。');
  line('  降级模式：node tools\\headless.js');
  line(`  界面模式：${electronBin} .`);
  process.exit(0);
}

// 地址跟随配置（换 host 后提示不能还印着 127.0.0.1，否则用户会照错的抄进直播姬）
const HTTP_BASE = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
    const h = (cfg && cfg.server && cfg.server.host) || '127.0.0.1';
    const pt = (cfg && cfg.server && cfg.server.port) || 37821;
    return 'http://' + h + ':' + pt;
  } catch { return 'http://127.0.0.1:37821'; }
})();

line();
line('正在启动…');
line('  控制台        ' + HTTP_BASE + '/');
line('  播放核心      ' + HTTP_BASE + '/player');
line('  歌词叠加层    ' + HTTP_BASE + '/overlay   ← 填进直播姬浏览器源');
line();

const r = spawnSync(electronBin, ['.'], { cwd: ROOT, stdio: 'inherit' });
if (r.status !== 0) {
  line();
  line(`[提示] Electron 退出码 ${r.status}。若启动失败，可改用降级模式：`);
  line('         node tools\\headless.js');
  line('       然后浏览器打开 http://127.0.0.1:37821/player 当播放核心。');
  process.exit(r.status || 1);
}
