/**
 * NekoFM 主进程（Electron 外壳）
 * ===============================
 * 组装：Engine（业务） + AppServer（HTTP/SSE） + 三个窗口
 *
 * 窗口职责划分（不要混）：
 *   control  控制台：登录、连房间、队列、叠加层设置
 *   player   播放核心：持有 <audio>，负责放声与 setSinkId；直播放声的就是它
 *   overlay  叠加层预览：与直播姬浏览器源加载同一个 URL，用于调样式
 *
 * 叠加层给直播姬用时不依赖 Electron：浏览器源直接填
 *   http://127.0.0.1:<port>/overlay
 * 业务逻辑全在 ./engine 与 ./commands，本文件只负责窗口与生命周期。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Tray, Menu, shell, session, clipboard, dialog } = require('electron');

const { Engine } = require('./engine');
const { AppServer } = require('./server');
const { createCommandHandler } = require('./commands');
const { SelfTest } = require('./selftest');
const { NeteaseBrowserFallback } = require('./sources/netease-browser');
const { BiliBrowserSession } = require('../core/bilibili/browser');
const { BrowserDanmakuChannel } = require('../core/bilibili/browser-channel');
const { DEFAULT_CONFIG, deepMerge, configPath } = require('../core/config');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
/**
 * 应用图标：窗口 / 任务栏 / 托盘都用它（一只猫头）。
 * 用 PNG 而不是控制台里那个 🐋 emoji —— emoji 的字形版权在字体厂商手里，
 * 而这个图标同时要作为 B站开放平台的项目图标上架审核，得是原创素材。
 */
const APP_ICON = path.join(RENDERER_DIR, 'assets', 'icon.png');
const SHARED_DIR = path.join(__dirname, '..', 'shared');
/**
 * Windows 上的关键开关：关掉 Chromium 的"原生窗口遮挡计算"。
 *
 * 不关会怎样（实测复现过，而且排查花了不少功夫）：
 *   应用启动时若焦点不在自家窗口上（双击 start.bat 时焦点在控制台窗口），
 *   Chromium 会把主窗口判定为"被遮挡"，于是**直接停止绘制** ——
 *   窗口停在 backgroundColor 上永远不变，看起来就是"白屏/黑屏"。
 *   我们从外部验证过：DOM 就绪、`webContents.capturePage()` 能导出完整界面，
 *   但屏幕上是空的；一旦把窗口激活到前台，界面立刻出现。
 *
 * 所以：**主动禁用遮挡计算**。代价是后台窗口也会继续合成（本应用窗口都很小，
 * 且隐藏的播放核心/叠加层本来就需要持续运行），换来的是不会莫名白屏。
 */
/**
 * 渲染可靠性加固（Windows 实测踩过：启动后窗口一直黑/白，做某个动作后画面才突然刷出来）
 *
 * 三件事一起做，因为它们各自能挡住一类失效：
 *  1) 关掉 Chromium 的"原生窗口遮挡计算"：窗口被判为被遮挡时它会**直接停画**，
 *     于是永远停在 backgroundColor 上。
 *  2) 默认关闭硬件加速：本应用界面是纯 2D 文字/图片，软件渲染足够，
 *     却能绕开多显卡机器上"显存里画好了但没送到屏幕"的整类问题。
 *     想要 GPU 渲染可加 --gpu 或设 NEKOFM_GPU=1。
 *  3) 加载完成后**主动催一次重绘**（1px 尺寸微调 + invalidate）：
 *     这是"必须有人动一下才刷新"的标准解法。
 */
if (process.env.NEKOFM_KEEP_OCCLUSION !== '1') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

/**
 * **关掉 Chromium 自己在后台连的那些服务**（2026-09-26）。
 *
 * 为什么关：启动后命令行会被一堆吓人的 ERROR 刷屏 ——
 *   `[ERROR:ssl_client_socket_impl.cc(878)] handshake failed; returned -1, SSL error code 1, net_error -100`
 *   `[ERROR:debug_utils.cc(14)] Hit debug scenario: 4`
 *
 * 都查清了，**跟本项目无关**：
 *   · 前者是 Chromium 自己去找**组件更新 / 安全浏览**的 Google 端点，而这些域名
 *     在（国内）网络里是连不通的（实测 `clients2.google.com` / `www.google.com` /
 *     `accounts.google.com` 全部超时重置），于是报 SSL 握手失败。
 *     `net_error -100` = `ERR_CONNECTION_CLOSED`，就是"连接被对端关掉"。
 *     我们真正要的 `music.163.com` 实测 HTTP 200 / 109ms，完全正常。
 *   · 后者是 Electron 上游 bug（electron#44368，closed as not planned）：
 *     Chromium 内部 `debug_utils.cc` 在加载 `about:blank` 到 iframe 时打的
 *     一条本该是 INFO 却标了 ERROR 的噪音。
 *
 * 关掉它们有双重好处：控制台干净可读 + 启动时少一堆无谓外连
 * （也符合"整套东西本地可控、不偷偷外连"的定位）。
 *
 * ⚠️ **保留可观测性**：排查白屏之类的问题时需要看到 Chromium 的错误，
 *    所以设 `NEKOFM_VERBOSE=1` 就全部恢复（见 PROGRESS.md 调试开关一节）。
 */
if (process.env.NEKOFM_VERBOSE !== '1') {
  // 只保留 FATAL 级 Chromium 日志；**我们自己的日志走 Node console，不受影响**
  app.commandLine.appendSwitch('log-level', '3');
  // 从源头上不发起那些后台外连（比"只是别打日志"更彻底）
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-background-networking');
}

/**
 * ⭐ **解除"每 host 6 条连接"的上限**（2026-09-26，这是"播放器失去响应"的根治）
 *
 * 问题：Chromium 对同一 host（协议+域名+端口）默认只允许 **6 条并发连接**。
 * 而本应用所有窗口（控制台 / 播放核心 / 每个叠加层预览窗）都跑在
 * `http://127.0.0.1:<port>` 上，每个窗口各占一条 **SSE 长连接**（长期不释放），
 * 播放核心还要 5Hz 上报进度 —— 很容易就把 6 条占满。
 * 一旦占满，**所有**后续请求（暂停、切歌、进度上报）全部排队，
 * 表现出来就是"歌在放，但进度条和按钮都卡住不动，过很久才一起反应"。
 *
 * 解法：Electron 官方支持的开关 `--ignore-connections-limit=domains`
 * （见 https://electronjs.org/docs/latest/api/command-line-switches ），
 * 对列出的域名**不再施加连接数上限**。只对我们的本地服务放行，不碰外网行为。
 *
 * 注意：必须在 `app.whenReady()` 之前调用才生效。
 */
/**
 * 本机地址都要放行。**包含 `127.0.0.2`**：那是给"与 AdGuard 共存"预留的备用回环地址
 * （AdGuard 会过滤 127.0.0.1，但它的 IP 排除列表可以只排除 127.0.0.2/32 ——
 * 这样 Clash 走 127.0.0.1 的流量照旧被 AdGuard 过滤，而我们不受影响）。
 * 详见文件尾部的「与 AdGuard 共存」说明。
 *
 * 这里在启动时就把两种回环地址都列上，省得改 host 之后忘了改这里
 * （漏了的话会出现"每 host 6 条连接"的老问题，播放器又卡）。
 */
const localHosts = ['127.0.0.1', '127.0.0.2', 'localhost', '[::1]', '::1'];
app.commandLine.appendSwitch('ignore-connections-limit', localHosts.join(','));
/**
 * 双保险：Chromium 还有 `--max-connections-per-host=N` 这个开关
 * （Electron 社区实测可用）。上面那个是官方文档写明的，这个是底牌 ——
 * 万一某个 Electron 版本不认 `ignore-connections-limit`，这个还能兜住。
 */
app.commandLine.appendSwitch('max-connections-per-host', '64');

const wantGpu = process.argv.includes('--gpu') || process.env.NEKOFM_GPU === '1';
if (!wantGpu) {
  try { app.disableHardwareAcceleration(); } catch { /* 忽略 */ }
}

const { dir: DATA_DIR, file: CONFIG_FILE } = configPath();

// 关键：把 Electron 的 userData（缓存、Cookie、登录会话、GPU 缓存）也挪到
// 程序目录下。否则它会默认写进 %APPDATA%（C 盘）—— 而这套东西是要整个放
// T 盘跑的，不该往系统盘里偷偷落东西。必须在 app ready 之前设置。
try {
  app.setPath('userData', path.join(DATA_DIR, 'electron'));
} catch (e) {
  console.error('[nekofm] 设置 userData 失败（将使用系统默认位置）：', e.message);
}

/**
 * **单实例锁**（2026-09-26 加）。
 *
 * 为什么必须加：重复启动（双击两次 start.bat、或上一个实例还在时又点一次，
 * 或者调试时误传了参数）会起**第二个实例** —— 而端口被占时 server 会自动往上
 * 找空闲端口（37821→37822…），所以**它真的能起来**：两个托盘图标、两套窗口；
 * 主进程一旦抛未捕获异常，Electron 还会弹出
 * "A JavaScript error occurred in the main process" 报错窗，一个接一个
 * （实测踩到：排查时把 `--check`（正确是 `--check-only`）传给了 start.js，
 * 于是拉起了第二个实例）。现在第二次启动只会把已有窗口叫到前面然后退出。
 */
if (!app.requestSingleInstanceLock()) {
  console.log('[nekofm] 已有实例在运行，本次启动直接退出（避免两个实例抢端口 / 叠托盘 / 弹报错窗）');
  app.quit();
  return;   // CommonJS 顶层 return 合法：模块被包在函数里
}
app.on('second-instance', () => {
  // 第二次双击 → 把已有窗口叫到前面，而不是新起一个
  try {
    if (winControl && !winControl.isDestroyed()) {
      if (winControl.isMinimized()) winControl.restore();
      winControl.show();
      winControl.focus();
    }
  } catch { /* 忽略 */ }
});

let winControl = null;
let winPlayer = null;
/**
 * 是否正在退出程序。
 * 播放核心 / 叠加层预览这两个窗口都是"关闭 = 隐藏"，
 * 只有真正退出时才允许销毁 —— 否则用户点一下关闭就把音频宿主拆了（实测踩过）。
 */
let isQuitting = false;
// 三个预览窗的实例在 overlayWins 里（见 createOverlayWindow）
let tray = null;
let engine = null;
let server = null;
let broadcastTimer = null;
/**
 * B站会话窗 / 弹幕通道。**必须声明在模块级**：`app.on('before-quit')` 要收掉它们，
 * 而那个回调在 `main()` 作用域之外 —— 写在 `main()` 里就会在退出时抛
 * `ReferenceError`，把整个退出流程打断（踩过）。
 */
let biliBrowser = null;
let biliChannel = null;

// ------------------------------------------------------------------ 配置
function loadConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return { config: deepMerge(DEFAULT_CONFIG, raw), existed: true };
    }
  } catch (e) {
    console.error('[config] 读取失败，使用默认值：', e.message);
  }
  return { config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), existed: false };
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('[config] 保存失败：', e.message);
  }
}

// ------------------------------------------------------------------ 窗口
// 记录各窗口页面是否真正加载完成（隐藏窗口的 isLoading() 不可靠，不能用来判定）
const loaded = { control: false, player: false, overlay: false };

/**
 * 催一次重绘。
 * "窗口黑着，直到你动一下它才刷出来"的根因是合成器没把首帧送出去，
 * 而一个 1px 的尺寸变化会强制走一遍 WM_SIZE → 重新合成。做完立刻改回去，
 * 用户视觉上察觉不到。
 */
function nudgeRepaint(win, why = '') {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: b.width + 1, height: b.height });
    setTimeout(() => {
      try { if (!win.isDestroyed()) win.setBounds(b); } catch { /* 忽略 */ }
    }, 60);
    if (win.webContents && !win.webContents.isDestroyed()) win.webContents.invalidate();
    if (why) {
      console.log(`[window] 已催重绘(${why})`);
      if (process.env.NEKOFM_TRACE === '1') console.log('[window] 调用栈:', new Error().stack.split('\n').slice(2, 6).join(' | '));
    }
  } catch { /* 忽略 */ }
}

/**
 * 给一个 webContents 挂上"就绪/失败"监听。
 * **必须放在模块作用域**：它要被 createPlayerWindow() 复用（那边负责重建播放核心窗），
 * 而 createPlayerWindow 不在 createWindows 的词法作用域里 ——
 * 我一度把它留在 createWindows 内部，结果重建路径一调用就 ReferenceError，
 * 连带整个 createWindows 中断、播放核心窗根本没被创建（表现是永远 loading）。
 */
function markLoaded(key) {
  return (wc) => {
    // 就绪信号用 dom-ready 而不是 did-finish-load：
    // 播放核心窗是**隐藏窗**，实测 did-finish-load 有时根本不触发
    // （也没有 did-fail-load），导致"页面加载完成"这项误报失败。
    // dom-ready 在文档解析完就触发，对隐藏窗同样可靠。
    wc.once('dom-ready', () => { loaded[key] = true; });
    wc.once('did-finish-load', () => { loaded[key] = true; });
    wc.on('did-fail-load', (_e, code, desc) => console.error(`[window] ${key} 加载失败 code=${code} ${desc}`));
    if (process.env.NEKOFM_TRACE === '1') {
      wc.on('did-stop-loading', () => console.log(`[window] ${key} 停止加载`));
      wc.once('dom-ready', () => console.log(`[window] ${key} dom-ready`));
    }
  };
}

/**
 * 托盘提示只弹一次：告诉用户"窗口关了但程序还在跑"。
 * 不说的话，用户会以为程序已经退出 —— 然后发现直播姬里的叠加层突然没了。
 */
let trayHintShown = false;
function notifyTrayHintOnce() {
  if (trayHintShown || !tray) return;
  trayHintShown = true;
  try {
    if (process.platform === 'win32' && tray.displayBalloon) {
      tray.displayBalloon({
        title: 'NekoFM 仍在后台运行',
        content: '控制台已收起，音乐与歌词叠加层不受影响。\n双击托盘图标可重新打开控制台；要彻底退出请用托盘菜单的「退出」。',
      });
    }
  } catch { /* 忽略 */ }
}

/**
 * 显示控制台窗口；窗口不存在/已销毁就**重建**。
 * 不重建的话，用户在关闭窗口后再点托盘「显示控制台」会毫无反应。
 */
function showControlWindow() {
  if (!winControl || winControl.isDestroyed()) {
    const port = (server && server.boundPort) || 37821;
    createControlWindow(port);
    return { ok: true, recreated: true };
  }
  try {
    winControl.show();
    winControl.focus();
    nudgeRepaint(winControl, 'show');
  } catch (e) { return { ok: false, msg: e.message }; }
  return { ok: true, recreated: false };
}

/**
 * 创建（或重建）控制台窗口。
 * 抽成独立函数是为了**窗口被销毁后还能重新打开** ——
 * 否则用户在关掉控制台之后，托盘里的「显示控制台」会毫无反应（实测踩到过）。
 */
function createControlWindow(port) {
  const base = server.baseUrl;   // 跟随 config.server.host（便于与 AdGuard 共存，见文件尾部说明）

  winControl = new BrowserWindow({
    width: 1200, height: 840, minWidth: 920, minHeight: 640,
    title: 'NekoFM 控制台',
    icon: APP_ICON,
    backgroundColor: '#0f1319',
    // **必须先隐藏**：创建时就可见的话，窗口先亮出纯背景色，
    // 而 Chromium 在"窗口已可见"状态下提交的首帧可能被丢掉 ——
    // 结果就是一直黑着，直到用户手动动一下窗口。实测用户机器上就是这样：
    // 菜单能点、DOM 正常、capturePage 能出图，但屏幕上只有背景色。
    // 正确做法：ready-to-show（首帧已备好）再 show()。
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // 先挂监听、再 loadURL —— 反过来的话，本地页面加载太快时
  // dom-ready/did-finish-load 会在挂上监听之前就触发，标志位永远设不上（实测竞态）
  markLoaded('control')(winControl.webContents);
  winControl.loadURL(base + '/');
  const presentControl = (why) => {
    if (!winControl || winControl.isDestroyed()) return;
    if (!winControl.isVisible()) winControl.show();
    try { winControl.moveTop(); } catch { /* 忽略 */ }
    if (process.env.NEKOFM_NO_FOCUS !== '1') {
      try { winControl.focus(); } catch { /* 忽略 */ }
    }
    nudgeRepaint(winControl, why);
  };
  winControl.once('ready-to-show', () => presentControl('ready-to-show'));
  // 兜底：文档明确说过 ready-to-show 不保证触发，不能让窗口永远不出现
  setTimeout(() => {
    if (winControl && !winControl.isDestroyed() && !winControl.isVisible()) presentControl('fallback-timer');
  }, 3500);
  winControl.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (winControl && !winControl.isDestroyed() && winControl.isVisible()) nudgeRepaint(winControl, 'did-finish-load');
    }, 500);
  });
  /**
   * 关闭控制台窗口 = **隐藏**，不销毁。
   * 为什么：这个程序是常驻的 —— 直播姬的浏览器源靠它的 HTTP 服务吃饭，
   * 关掉窗口会把整个服务带走，正在直播就直接断了。
   * 何况窗口一销毁，托盘里「显示控制台」就再也调不出界面（实测发生过）。
   */
  winControl.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    winControl.hide();
    notifyTrayHintOnce();
  });
  winControl.on('closed', () => { winControl = null; });
  return winControl;
}

function createWindows(port) {
  const base = server.baseUrl;   // 跟随 config.server.host（便于与 AdGuard 共存，见文件尾部说明）

  createControlWindow(port);

  // ------------------------------------------------------------------
  // 播放核心窗口：**里面的 <audio> 就是播放器本体，绝不能被销毁**
  // ------------------------------------------------------------------
  // 用户实测：手动打开这个窗口再点关闭 → 报错，而且音乐再也放不出来。
  // 原因是窗口一关就真的销毁了，承载音频的渲染进程随之消失；
  // 之后再调 winPlayer.show() 就抛 "Object has been destroyed"。
  // 所以：**关闭一律改成隐藏**（真正退出程序时才放行），
  // 并且万一它还是没了，就重建 + 自动把当前曲目重新推给它。
  createPlayerWindow(port);

  // 三个独立预览窗：歌词 / 信息卡片 / 整体，可以同时开着互不影响。
  // 分别对着 /overlay?only=lyrics、?only=info 和不带参数的完整页 ——
  // 和你在直播姬里放两个浏览器源的配置一一对应，预览即所得。
  for (const mode of OVERLAY_MODES) createOverlayWindow(port, mode);
}

/** 三种预览模式；'both' 就是原来那个"歌词+信息卡"的整体预览 */
const OVERLAY_MODES = ['both', 'lyrics', 'info'];
const OVERLAY_TITLE = {
  both: 'NekoFM 叠加层预览（整体）',
  lyrics: 'NekoFM 歌词预览',
  info: 'NekoFM 信息卡片预览',
};
/** 信息卡片比歌词窄矮得多，默认尺寸分开给，省得每次手动拖 */
const OVERLAY_SIZE = {
  both: { width: 1280, height: 260 },
  lyrics: { width: 1280, height: 200 },
  info: { width: 460, height: 140 },
};
/** mode → BrowserWindow */
const overlayWins = { both: null, lyrics: null, info: null };

/**
 * 创建某个模式的预览窗。
 * 关闭 = 隐藏（可再次打开）；失焦/显示时都重新置顶，避免"点一下沉下去"。
 */
function createOverlayWindow(port, mode = 'both') {
  const base = server.baseUrl;   // 跟随 config.server.host（便于与 AdGuard 共存，见文件尾部说明）
  const size = OVERLAY_SIZE[mode] || OVERLAY_SIZE.both;
  // preview=1 → 页面显示工具条（无边框窗口没有系统关闭按钮）
  // only=... → 只渲染对应的部分；直播姬的浏览器源不带 preview 所以看不到工具条
  const q = mode === 'both' ? '?preview=1' : `?preview=1&only=${mode}`;
  const win = new BrowserWindow({
    width: size.width, height: size.height,
    transparent: true, frame: false, alwaysOnTop: true,
    resizable: true, hasShadow: false, show: false,
    title: OVERLAY_TITLE[mode] || OVERLAY_TITLE.both,
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setBackgroundColor('#00000000');
  overlayWins[mode] = win;
  // key 用 overlay / overlay-lyrics / overlay-info，冒烟自检与诊断都按这个找
  markLoaded(mode === 'both' ? 'overlay' : 'overlay-' + mode)(win.webContents);
  win.loadURL(base + '/overlay' + q);
  const keepTop = () => {
    if (isQuitting || !win || win.isDestroyed()) return;
    try {
      if (win.isVisible()) { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); }
    } catch { /* 忽略 */ }
  };
  win.on('close', (e) => { if (!isQuitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { if (overlayWins[mode] === win) overlayWins[mode] = null; });
  win.on('blur', keepTop);
  win.on('show', keepTop);
  return win;
}

/**
 * 让叠加层预览窗显示并**稳稳压在其它窗口之上**。
 *
 * 为什么不能只靠创建时的 alwaysOnTop:true：
 * 窗口隐藏再显示后，Windows 可能丢掉 topmost 标记；点一下它拿到焦点、
 * 随后又失去焦点时就掉到下层去了（用户反馈"点了自己就跑到下层"）。
 * 所以：显示前先设 topmost，显示后再补一次，并且失焦时自动重新置顶。
 */
function presentOverlay(mode = 'both') {
  if (!OVERLAY_MODES.includes(mode)) mode = 'both';
  let win = overlayWins[mode];
  // 被销毁过就重建 —— 用户关掉某个预览窗后再点它，不该毫无反应
  if (!win || win.isDestroyed()) {
    const port = (server && server.boundPort) || 37821;
    win = createOverlayWindow(port, mode);
  }
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
    if (!win.isVisible()) win.show();
    win.moveTop();
    // 有些合成器在 show 之后才真正应用层级，补一次更保险
    setTimeout(() => {
      try {
        if (win && !win.isDestroyed() && win.isVisible()) {
          win.setAlwaysOnTop(true, 'screen-saver');
          win.moveTop();
        }
      } catch { /* 忽略 */ }
    }, 120);
  } catch (e) {
    return { ok: false, msg: e.message };
  }
  return { ok: true, mode };
}

/** 一键打开全部三种预览：歌词、信息卡片、整体并排对比 */
function presentAllOverlays() {
  const opened = {};
  for (const m of OVERLAY_MODES) opened[m] = presentOverlay(m).ok;
  return { ok: true, opened };
}

/**
 * 创建（或重建）播放核心窗口。
 * 抽成函数是为了能在窗口意外消失时重建 —— 它是音频宿主，不能缺。
 */
function createPlayerWindow(port) {
  const base = server.baseUrl;   // 跟随 config.server.host（便于与 AdGuard 共存，见文件尾部说明）
  winPlayer = new BrowserWindow({
    width: 560, height: 400, show: false,
    title: 'NekoFM 播放核心',
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  markLoaded('player')(winPlayer.webContents);
  winPlayer.loadURL(base + '/player');
  winPlayer.on('close', (e) => {
    // 程序退出时才真的让它关
    if (!isQuitting) { e.preventDefault(); winPlayer.hide(); }
  });
  winPlayer.on('closed', () => { winPlayer = null; });
  return winPlayer;
}

/**
 * 显示播放核心窗口；不存在/已销毁就重建，并把当前曲目重新推给它。
 * 重建后不重推的话，窗口是空的 —— 用户看到的就是"窗口开了但没声音"。
 */
function showPlayerWindow() {
  let recreated = false;
  if (!winPlayer || winPlayer.isDestroyed()) {
    const port = (server && server.boundPort) || (app._nekofmPort || 37821);
    createPlayerWindow(port);
    recreated = true;
  }
  winPlayer.show();
  winPlayer.focus();
  if (recreated) {
    setTimeout(() => {
      if (!engine || !engine.streamUrl) return;
      server.broadcast({ type: 'player', action: 'play', url: engine.streamUrl, volume: engine.playback.volume });
      const pos = engine.playback.position;
      if (pos > 0.5) {
        setTimeout(() => {
          if (engine && engine.playback.status === 'playing') {
            server.broadcast({ type: 'player', action: 'seek', position: pos });
          }
        }, 700);
      }
    }, 900);
  }
  return { ok: true, recreated };
}

// ------------------------------------------------------------------ 广播
function startBroadcast() {
  let lyricSentRev = -1;
  broadcastTimer = setInterval(() => {
    if (!server || !engine) return;
    server.broadcast(engine.state());
    if (engine.lyricRev !== lyricSentRev) {
      lyricSentRev = engine.lyricRev;
      server.broadcast(engine.lyricsPayload());
    }
  }, 100); // 10Hz
}

// ------------------------------------------------------------------ 启动
app.whenReady().then(async () => {
  const { config, existed } = loadConfig();

  // 网易云「浏览器急兑」通道：借真实浏览器会话取直链（接口被掐时的退路），
  // 同时也是最省事的登录方式 —— 登录窗跑一次，cookie 直接喂给主路径客户端。
  let browserFallback = null;
  try {
    browserFallback = new NeteaseBrowserFallback({ log: (...a) => console.log(...a) });
  } catch (e) {
    console.error('[netease-browser] 初始化失败，将只走接口路径：', e.message);
  }

  /**
   * B站登录态通道（2026-09-26 加）：**字幕接口必须带登录态**，否则恒返回空列表
   * （见 core/bilibili/api.js 的 subtitles 注释）。它只负责把账号登进去换 cookie，
   * 换来的 cookie 写进 config.bilibili.cookie，字幕/检索/弹幕仍走 Node 直连。
   * headless 下 available=false，控制台会提示改用 SESSDATA 粘贴框。
   */
  biliBrowser = null;
  try {
    biliBrowser = new BiliBrowserSession({ log: (...a) => console.log(...a) });
  } catch (e) {
    console.error('[bili-browser] 初始化失败：', e.message);
  }

  /**
   * 弹幕通道 = 外部浏览器（系统 Edge / Chrome）+ CDP。
   * 为什么不用 Electron 自己的窗口：B站弹幕服务认客户端实现，Electron 一律被拒
   * （详见 `src/core/bilibili/browser-channel.js` 文件头的对照数据）。
   * headless（纯 Node）下找不到 Electron 也无妨 —— 它只依赖系统浏览器。
   */
  biliChannel = null;
  try {
    biliChannel = new BrowserDanmakuChannel({ log: (...a) => console.log(...a) });
    if (!biliChannel.available) console.warn('[danmaku-ch] 未找到 Edge / Chrome，弹幕将回落 Node 直连（可能拿不到有效 token）');
  } catch (e) {
    console.error('[danmaku-ch] 初始化失败：', e.message);
  }

  engine = new Engine({
    config,
    log: (...a) => console.log(...a),
    browser: browserFallback,
    biliBrowser,
    biliChannel,
  });

  /**
   * **后台预热网易云会话窗**（2026-09-26 加）。
   *
   * 为什么：浏览器通道现在是取数主路径，而它第一次调用要 `ensureWindow()` ——
   * 即真的加载一遍 `https://music.163.com/`（一个不小的 SPA）。
   * 实测**首次搜索因此要 3.1 秒**，之后降到 0.6s / 0.15s。
   * 而"第一次点歌"往往发生在开播后不久 —— 于是用户觉得"点了半天才响"。
   *
   * 这里在启动后台先把这个窗口热起来（延后几秒，别跟控制台首屏抢资源），
   * 于是那 3 秒发生在**开播之前**，第一次点歌就能直接享受热好的会话。
   * 预热失败无所谓：真正用的时候 `ensureWindow()` 还会再试。
   */
  if (browserFallback && browserFallback.available) {
    setTimeout(() => {
      browserFallback.ensureWindow()
        .then(() => console.log('[netease-browser] 会话窗已预热（首次点歌不用再等它加载）'))
        .catch((e) => console.log('[netease-browser] 预热失败（不影响使用，用时会再试）:', e.message));
    }, 3000);
  }

  const handleCommand = createCommandHandler({
    engine,
    saveConfig,
    onConfigChange: (overlay) => server && server.broadcast({ type: 'config', overlay }),
    hooks: {
      // mode: both | lyrics | info | all（all=三个预览一起开）
      showOverlay: (mode) => (mode === 'all' ? presentAllOverlays() : presentOverlay(mode || 'both')),
      // 关闭后还能重新打开控制台（窗口被销毁时会重建）
      showControl: () => showControlWindow(),
      hideOverlay: (mode = 'both') => {
        const m = OVERLAY_MODES.includes(mode) ? mode : 'both';
        const w = overlayWins[m];
        if (w && !w.isDestroyed()) w.hide();
        return { ok: true, mode: m };
      },
      showPlayer: () => showPlayerWindow(),
      /**
       * 播放核心窗内部的真实媒体状态。
       * "没声音 / 一直 loading"这类问题，从主进程看只能看到引擎状态，
       * 真正的原因（媒体错误码、readyState、setSinkId 是否成功）只有渲染进程知道。
       */
      /**
       * 三个窗口的真实状态（可见性 / 是否置顶 / 位置）。
       * 排查"预览窗跑到下层""窗口不见了"这类问题时，从外面看不到，
       * 只能问 Electron 自己。
       */
      windowsDiag: () => {
        const w = (win) => {
          if (!win || win.isDestroyed()) return null;
          return {
            visible: win.isVisible(),
            alwaysOnTop: win.isAlwaysOnTop(),
            minimized: win.isMinimized(),
            focused: win.isFocused(),
            bounds: win.getBounds(),
          };
        };
        return {
          ok: true, control: w(winControl), player: w(winPlayer),
          overlay: w(overlayWins.both),
          overlayLyrics: w(overlayWins.lyrics),
          overlayInfo: w(overlayWins.info),
        };
      },
      playerDiag: async () => {
        if (!winPlayer || winPlayer.isDestroyed()) return { ok: false, msg: '播放核心窗口不存在' };
        try {
          const r = await winPlayer.webContents.executeJavaScript(`(() => {
            const a = document.querySelector('audio');
            const txt = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
            if (!a) return { noAudio: true };
            return {
              src: a.src, readyState: a.readyState, networkState: a.networkState,
              paused: a.paused, ended: a.ended, currentTime: a.currentTime,
              duration: a.duration, volume: a.volume, sinkId: a.sinkId || '(默认)',
              error: a.error ? { code: a.error.code, message: a.error.message } : null,
              status: txt('status'), kErr: txt('kErr'), kUrl: txt('kUrl'), devLabel: txt('devLabel'),
              deviceOptions: Array.from(document.querySelectorAll('#device option')).length,
              setSinkSupported: typeof a.setSinkId === 'function',
            };
          })()`);
          return { ok: true, player: r };
        } catch (e) { return { ok: false, msg: e.message }; }
      },
      openExternal: (url) => { shell.openExternal(url); return { ok: true }; },
      quit: () => { app.quit(); return { ok: true }; },
      // 网易云：开一个可见登录窗，登录完成后把 cookie 收进配置供主路径使用
      neteaseBrowserLogin: async () => {
        if (!browserFallback || !browserFallback.available) return { ok: false, msg: '浏览器通道不可用' };
        const r = await browserFallback.openLoginWindow();
        if (r.ok && r.cookie) {
          engine.netease.cookie = r.cookie;
          engine.config.netease.cookie = r.cookie;
          saveConfig(engine.config);
          engine.notify('info', '网易云已登录（浏览器会话），会员曲可完整播放');
        }
        return r;
      },
      /**
       * 网易云登出（2026-09-26）：清掉 persistent partition 的全部 storage，
       * 同时把 config 里记录的 cookie 也清掉，避免下次启动仍带着旧账号。
       * 用于"想换号登录"或"清掉过期 cookie"的场景。
       */
      neteaseBrowserLogout: async () => {
        if (!browserFallback || !browserFallback.available) return { ok: false, msg: '浏览器通道不可用' };
        const r = await browserFallback.clearSession();
        if (r.ok) {
          engine.netease.cookie = '';
          engine.config.netease.cookie = '';
          saveConfig(engine.config);
          engine.notify('info', '已登出网易云，下次扫码将登新账号');
        }
        return r;
      },
      /**
       * B站登录（2026-09-26 加）：开一个可见登录窗，登录完成后把 cookie 收进配置。
       *
       * 为什么需要它：B站字幕接口 `/x/player/v2` **必须带登录态** —— 未登录时恒返回
       * `need_login_subtitle: true` + 空列表（与视频有没有字幕无关）。没有登录态，
       * 视频音频的歌词就只能靠"标题去网易云匹配"，冷门曲（游戏/同人 OST）基本匹配不到。
       */
      biliBrowserLogin: async () => {
        if (!biliBrowser || !biliBrowser.available) {
          return { ok: false, msg: '登录窗需要 Electron 运行环境；headless 下请用 SESSDATA 粘贴框' };
        }
        const r = await biliBrowser.openLoginWindow();
        if (r.ok) {
          // 走 engine.biliSetCookie：它同时更新 BiliApi 实例与 config，并核验登录态
          const v = await engine.biliSetCookie(r.cookie);
          saveConfig(engine.config);
          engine.notify('info', v.loggedIn
            ? `B站已登录${v.nick ? '：' + v.nick : ''}（视频 CC/AI 字幕可用）`
            : 'B站已拿到 cookie，但核验未通过（可能需要重新登录）');
          return { ok: true, loggedIn: v.loggedIn, nick: v.nick };
        }
        return r;
      },
      /** B站登出：清 partition 的 storage + 清配置里的 cookie（换号/清过期 cookie 用） */
      biliBrowserLogout: async () => {
        const r = (biliBrowser && biliBrowser.available)
          ? await biliBrowser.clearSession()
          : { ok: true };
        await engine.biliSetCookie('');
        saveConfig(engine.config);
        engine.notify('info', '已登出 B站，视频字幕将回落到网易云匹配');
        return r;
      },
      /** 打开本地音乐文件（原生多选对话框） */
      pickLocalFiles: async () => {
        const r = await dialog.showOpenDialog(winControl || undefined, {
          title: '打开本地音乐',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: '音频文件', extensions: ['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'wma', 'ape'] },
            { name: '全部文件', extensions: ['*'] },
          ],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true, msg: '已取消' };
        return { ok: true, paths: r.filePaths };
      },
      /** 打开本地音乐文件夹（加入曲库并扫描） */
      pickLocalFolder: async () => {
        const r = await dialog.showOpenDialog(winControl || undefined, {
          title: '选择音乐文件夹（加入曲库）',
          properties: ['openDirectory', 'multiSelections'],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true, msg: '已取消' };
        return { ok: true, dirs: r.filePaths };
      },
    },
  });

  server = new AppServer({
    port: config.server.port,
    host: config.server.host,
    rendererDir: RENDERER_DIR,
    sharedDir: SHARED_DIR,
    getState: () => engine.state(),
    getLyrics: () => engine.lyricsPayload(),
    // 新接入的叠加层要立刻拿到当前配置（否则会用内置默认值渲染）
    getConfig: () => engine.config.overlay,
    // 新接入的客户端补发当前播放指令（播放核心晚连上也不会漏掉 play）
    resumeProvider: () => {
      if (!engine || !engine.streamUrl) return null;
      const st = engine.playback.status;
      if (st !== 'playing' && st !== 'loading' && st !== 'paused') return null;
      return {
        action: 'play',
        url: engine.streamUrl,
        volume: engine.playback.volume,
        deviceId: engine.playback.deviceId,
        // 让播放核心能接着上次的进度，而不是从 0 重放
        resumeAt: st === 'playing' ? engine.playback.position : 0,
      };
    },
    // 本地音频与封面只允许读「曲库目录 + 用户显式打开的文件 + 封面缓存」，
    // 防止 /stream/local 与 /stream/cover 变成任意文件读取
    allowRootsProvider: () => [
      ...(engine.config.local.dirs || []),
      ...(engine.local.extraFiles ? [...engine.local.extraFiles] : []),
      path.join(DATA_DIR, 'covers'),
      engine.cache.cacheDir,   // 媒体缓存也要放行，否则缓存的文件自己播不了
    ],
    onCommand: handleCommand,
    log: (...a) => console.log(...a),
  });

  const port = await server.start();
  engine.serverBase = `http://${config.server.host}:${port}`;
  config.server.port = port;
  if (!existed) saveConfig(config);

  // 内置测试中心：控制台里可以逐组点跑，CLI 也能用同一份清单
  engine.selftest = new SelfTest({
    engine,
    server,
    baseUrl: engine.serverBase,
    log: (...a) => console.log(...a),
  });

  // 播放器页需要读设备标签，更重要的是**需要 speaker-selection 才能用 setSinkId**。
  // Chromium 110 起，`audio.setSinkId()` 受 `speaker-selection` 权限门控；
  // 不授权的话它会抛 NotAllowedError，音频就留在默认设备上不动 ——
  // 表现正是用户反馈的"输出设备改成别的，过一会儿又变回系统默认"。
  // 另外：只有拿到权限，enumerateDevices() 才返回**稳定的** deviceId
  // （否则每次枚举都是临时哈希，保存下来的 ID 下次就失效了）。
  const ALLOWED_PERMS = ['media', 'audioCapture', 'speaker-selection'];
  const isLocalOrigin = (u) => {
    // 注意：不能用 u.replace(/\/[^]*$/, '') 去截路径 ——
    // 那会从 `http://` 的第一个斜杠开始截，把 URL 变成 "http:"，
    // 导致判定永远失败、所有权限被拒（我踩过这个坑）。用 URL.origin。
    try {
      const o = new URL(u).origin;
      return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o);
    } catch { return false; }
  };
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(ALLOWED_PERMS.includes(permission) && isLocalOrigin((wc && wc.getURL()) || ''));
  });
  // 有的实现只走 check 通道，两个都放行才不会"看起来授权了但实际被拒"
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return ALLOWED_PERMS.includes(permission) && isLocalOrigin(requestingOrigin);
  });

  createWindows(port);

  // ---------------------------------------------------------------- 诊断模式
  /**
   * `--diag`：把窗口的真实状态与**渲染器自己画出来的画面**导出来。
   * 为什么需要它：窗口"空白"有两大类原因，从外面看一模一样，但处置完全不同 ——
   *   A) 页面没加载（服务器/白名单/端口问题）
   *   B) 页面加载好了但没画到屏幕上（窗口合成/显卡/最小化/被遮挡）
   * `webContents.capturePage()` 是渲染器内部出图，能直接区分 A 和 B。
   * 报告同时给出 isVisible/isMinimized/bounds/URL，便于一眼看出是不是窗口层面的问题。
   */
  if (process.argv.includes('--diag')) {
    setTimeout(async () => {
      const out = { time: new Date().toISOString(), platform: process.platform, windows: [] };
      for (const [key, win] of [
        ['control', winControl], ['player', winPlayer],
        ['overlay', overlayWins.both], ['overlay-lyrics', overlayWins.lyrics], ['overlay-info', overlayWins.info],
      ]) {
        if (!win) { out.windows.push({ key, exists: false }); continue; }
        const wc = win.webContents;
        let domLen = -1;
        let bodyText = '';
        try {
          domLen = await wc.executeJavaScript('document.documentElement.outerHTML.length');
          bodyText = await wc.executeJavaScript('document.body ? document.body.innerText.slice(0,120) : "(no body)"');
        } catch (e) { domLen = -1; bodyText = 'ERR:' + e.message; }
        const info = {
          key, exists: true,
          url: wc.getURL(), loading: wc.isLoading(), crashed: wc.isCrashed(),
          visible: win.isVisible(), minimized: win.isMinimized(), bounds: win.getBounds(),
          domLen, bodyText: String(bodyText).replace(/\s+/g, ' ').slice(0, 120),
        };
        try {
          const img = await wc.capturePage();
          const png = img.toPNG();
          const file = path.join(DATA_DIR, `diag-${key}.png`);
          fs.writeFileSync(file, png);
          info.capture = { file, bytes: png.length };
        } catch (e) { info.capture = { error: e.message }; }
        out.windows.push(info);
      }
      const file = path.join(DATA_DIR, 'diag.json');
      fs.writeFileSync(file, JSON.stringify(out, null, 2));
      console.log('[diag] 已写出', file);
      for (const w of out.windows) {
        console.log(`[diag] ${w.key}: 可见=${w.visible} 最小化=${w.minimized} 加载中=${w.loading} DOM=${w.domLen} 截图=${w.capture ? (w.capture.bytes || w.capture.error) : '-'}`);
        console.log(`[diag]    URL=${w.url}`);
        console.log(`[diag]    正文=${w.bodyText}`);
      }
      app.exit(0);
    }, 6000);
  }

  startBroadcast();
  await engine.init();

  engine.on('player', (cmd) => server.broadcast({ type: 'player', ...cmd }));
  engine.on('change', () => server.broadcast(engine.state()));

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '窗口',
      submenu: [
        { label: '控制台', click: () => showControlWindow() },
        { label: '播放核心', click: () => showPlayerWindow() },
        { label: '歌词叠加层预览', click: () => presentOverlay() },
        { label: '预览：歌词 + 信息卡片（整体）', click: () => presentOverlay('both') },
        { label: '预览：只要歌词', click: () => presentOverlay('lyrics') },
        { label: '预览：只要信息卡片', click: () => presentOverlay('info') },
        { label: '三个预览一起打开', click: () => presentAllOverlays() },
        { label: '关闭全部预览', click: () => { for (const m of OVERLAY_MODES) { const w = overlayWins[m]; if (w && !w.isDestroyed()) w.hide(); } } },
        { type: 'separator' },
        /**
         * 画面卡住时的"硬修复"：hide → show 会强制整窗口重新合成，
         * 比单纯催重绘（改 1px）强得多；再 reload 一次拿到干净的首帧。
         * 用户实测"催重绘"无效，所以这里必须给更强的动作。
         */
        { label: '修复画面（推荐先试这个）', click: () => {
          if (!winControl || winControl.isDestroyed()) return;
          try {
            winControl.hide();
            setTimeout(() => {
              if (!winControl || winControl.isDestroyed()) return;
              winControl.show();
              winControl.focus();
              winControl.moveTop();
              winControl.webContents.reload();
            }, 250);
          } catch { /* 忽略 */ }
        } },
        { label: '强制重绘界面（画面卡住时用）', click: () => { nudgeRepaint(winControl, 'menu'); for (const m of OVERLAY_MODES) nudgeRepaint(overlayWins[m], 'menu'); } },
        { label: '重新加载界面', click: () => { if (winControl) winControl.webContents.reload(); } },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '叠加层',
      submenu: [
        { label: '复制叠加层地址（给直播姬浏览器源）', click: () => clipboard.writeText(server.baseUrl + '/overlay') },
        { label: '在浏览器中打开', click: () => shell.openExternal(server.baseUrl + '/overlay') },
      ],
    },
  ]));

  try {
    /**
     * 托盘图标：优先专用的 `tray.png`（小尺寸清晰），缺了就回落到 `icon.png`。
     *
     * **回落这一层是必须的**：旧代码写的是 `if (fs.existsSync(tray.png))`，
     * 而当时 `tray.png` 根本没进仓库 —— 于是 `existsSync` 为假，
     * 结果不是"图标空白"而是**整个托盘都没被创建**，应用关窗后就成了
     * "还在跑但找不到入口"的幽灵进程（用户报告过）。
     */
    const trayIcon = ['tray.png', 'icon.png']
      .map((f) => path.join(RENDERER_DIR, 'assets', f))
      .find((f) => { try { return fs.existsSync(f); } catch { return false; } });
    if (trayIcon) {
      tray = new Tray(trayIcon);
      tray.setToolTip('NekoFM');
      // 双击托盘 = 打开控制台（托盘程序的标准预期行为）
      tray.on('double-click', () => showControlWindow());
      tray.setToolTip('NekoFM · 双击打开控制台');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '显示控制台', click: () => showControlWindow() },
        { label: '显示叠加层预览', click: () => presentOverlay('both') },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ]));
      console.log('[nekofm] 托盘图标已就绪');
    } else {
      console.warn('[nekofm] 找不到托盘图标（assets/tray.png 或 icon.png），托盘将不可用');
    }
  } catch (e) { console.warn('[nekofm] 托盘创建失败：', e.message); }

  console.log(`[nekofm] 控制台            ${server.baseUrl}/`);
  console.log(`[nekofm] 歌词叠加层(直播姬) ${server.baseUrl}/overlay`);
  console.log(`[nekofm] 播放核心          ${server.baseUrl}/player`);

  // ---------------------------------------------------------------- 冒烟自检
  // `electron . --smoke` ：启动 → 自检窗口/服务 → 打印诊断 → 自动退出。
  // 用于在目标机器上验证"能跑起来"，且不在用户桌面留下常驻窗口。
  if (process.argv.includes('--smoke')) {
    const seconds = 10;
    console.log(`[smoke] ${seconds}s 后自动退出…`);
    // 首帧/首个加载偶发偏慢（尤其是软件渲染下的播放核心页），
    // 所以先等一轮，缺哪个再多等一会儿 —— 免得把偶发当失败报出来。
    const waitForLoads = async (deadlineMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < deadlineMs) {
        if (loaded.control && loaded.player && loaded.overlay) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return loaded.control && loaded.player && loaded.overlay;
    };
    setTimeout(async () => {
      if (!(loaded.control && loaded.player && loaded.overlay)) {
        const okAll = await waitForLoads(8000);
        console.log(`[smoke] 页面加载补齐等待结束：${okAll ? '三页均已就绪' : '仍有未就绪'}`);
      }
      // 直接在渲染进程里查 DOM：这才是"叠加层真能跑"的硬证据
      let overlayDomOk = false;
      let controlDomOk = false;
      let overlayDetail = '';
      try {
        const ov = overlayWins.both;
        overlayDomOk = await ov.webContents.executeJavaScript(
          '!!(window.__nekofm && window.__nekofm.S && document.getElementById("stage"))');
        const n = await ov.webContents.executeJavaScript('document.querySelectorAll(".line").length');
        overlayDetail = `渲染行数=${n}`;
      } catch (e) { overlayDetail = '执行 JS 失败：' + e.message; }
      try {
        controlDomOk = await winControl.webContents.executeJavaScript('!!document.getElementById("queue") && !!document.getElementById("addr")');
      } catch { /* 忽略 */ }
      // 播放核心窗的判据同样用 DOM 查询，而不是加载事件 ——
      // 隐藏窗口的 dom-ready/did-finish-load 偶发不触发，用它当判据会误报
      // （而且"能不能查到 DOM"本身就是更强的证据）。
      let playerDomOk = false;
      let playerDetail = '';
      try {
        playerDomOk = await winPlayer.webContents.executeJavaScript(
          '!!document.querySelector("audio") && !!document.getElementById("device")');
        playerDetail = await winPlayer.webContents.executeJavaScript('document.getElementById("status") ? document.getElementById("status").textContent : "?"');
      } catch (e) { playerDetail = '执行 JS 失败：' + e.message; }

      const checks = [
        ['服务器已监听', !!server.boundPort],
        ['控制台窗口已创建', !!winControl && !winControl.isDestroyed()],
        ['播放核心窗口已创建', !!winPlayer && !winPlayer.isDestroyed()],
        ['叠加层窗口已创建', !!(overlayWins.both && !overlayWins.both.isDestroyed())],
        ['独立预览窗已创建（歌词 / 信息卡片）',
          !!(overlayWins.lyrics && !overlayWins.lyrics.isDestroyed()
            && overlayWins.info && !overlayWins.info.isDestroyed())],
        ['控制台页面加载完成', loaded.control],
        ['播放核心页面就绪（DOM 可查）', playerDomOk],
        ['叠加层页面加载完成', loaded.overlay],
        ['叠加层 JS 已初始化', overlayDomOk],
        ['控制台 DOM 就绪', controlDomOk],
        ['引擎已初始化', !!engine],
        ['网易云浏览器急兑通道可用', !!(browserFallback && browserFallback.available)],
        ['B站会话通道可用（登录后视频字幕可用）', !!(biliBrowser && biliBrowser.available)],
      ];
      let bad = 0;
      for (const [name, okk] of checks) {
        console.log(`[smoke]   ${okk ? '✅' : '❌'} ${name}`);
        if (!okk) bad++;
      }
      console.log(`[smoke] 叠加层: ${overlayDetail}`);
      console.log(`[smoke] 结果: ${checks.length - bad}/${checks.length} 通过`);
      console.log(`[smoke] 引擎状态: track=${engine.track ? engine.track.name : '(无)'} 歌词=${
        engine.lyricTimeline.lines.length} 行 队列=${engine.queue.length}`);
      app.exit(bad ? 1 : 0);
    }, seconds * 1000);
  }
});

app.on('window-all-closed', () => { /* 常驻，不随窗口关闭退出 */ });
app.on('before-quit', async () => {
  // 先置位，播放核心/预览窗的 close 拦截才会放行，程序才能真的退出
  isQuitting = true;
  if (broadcastTimer) clearInterval(broadcastTimer);
  if (engine && engine.danmaku) engine.danmaku.close();
  // 弹幕通道是我们自己拉起来的外部浏览器进程，退出时要一起收掉，
  // 否则会在后台留一个看不见的 Edge 窗口。
  if (biliChannel) biliChannel.dispose();
  if (server) await server.stop();
});
