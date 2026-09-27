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
const { app, BrowserWindow, Tray, Menu, shell, session, clipboard, dialog, screen } = require('electron');

const { Engine } = require('./engine');
const { AppServer } = require('./server');
const { createCommandHandler } = require('./commands');
const { SelfTest } = require('./selftest');
const { NeteaseBrowserFallback } = require('./sources/netease-browser');
const { BiliBrowserSession } = require('../core/bilibili/browser');
const { BrowserDanmakuChannel } = require('../core/bilibili/browser-channel');
const { DEFAULT_CONFIG, deepMerge, configPath } = require('../core/config');
const { OVERLAY_EDGES, OVERLAY_MIN, nextBounds } = require('../core/overlay-window');

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

// ------------------------------------------------------------------ 运行日志
/**
 * **尽早装日志总线**：打包成 exe 后没有控制台，启动阶段的日志最容易丢
 * （而"双击后没反应/信息全丢"这类问题恰恰就出在启动阶段）。
 * 装在这里 → 之后所有 console 输出都进环形缓冲 + 落盘 `data/logs.txt`，
 * 由「运行日志 / 状态」窗口实时查看（菜单里打开）。
 */
const { LogBus } = require('./logbus');
const logBus = new LogBus({ file: LogBus.defaultFile(DATA_DIR) });
logBus.install();

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
let winLogs = null;    // 「运行日志 / 状态」窗口（菜单里可开，见 showLogWindow）
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
/**
 * 预览窗的最小尺寸在此统一给（建窗时的 minWidth/minHeight 与拉边时的夹取，
 * 都取 core/overlay-window.js 里那一份）：无边框窗口没有系统标题栏，
 * 拖到极小时连工具条都放不下、也没法再拖回来。
 */
/** mode → BrowserWindow */
const overlayWins = { both: null, lyrics: null, info: null };
/**
 * mode → 该预览窗的「置顶」开关状态（工具条上的按钮改的就是它）。
 * **默认开**：预览窗本来就该压在其他窗口之上 —— 旧行为一直是置顶，
 * 加上这个开关只是把"压不住 / 想让它不挡事"的两种需求都放出来。
 * 内存态：重启回到默认，跟其它窗口级开关一致（不进 config，不该被广播同步）。
 */
const overlayTopOn = { both: true, lyrics: true, info: true };
/**
 * mode → 该预览窗的「点击穿越」开关状态（工具条上的按钮改的就是它）。
 * 开 = 整块窗口不吃鼠标（点击落到下面的程序上），只留顶边一条可点。
 * **默认关**：默认行为跟以前完全一样（窗口该接的点击照接），要"不挡事"的用户自己开。
 */
const overlayClickThrough = { both: false, lyrics: false, info: false };
/**
 * mode → 渲染层上报的"光标在不在顶部那一条里"（只在开了穿越时才有意义）。
 * 为什么这个状态必须由页面给：主进程看不见光标在窗口里的位置，而窗口一旦透传，
 * 页面就只剩 `forward` 转发过来的移动事件能用来判断 —— 那正是它上报的依据。
 */
const overlayTopOver = { both: false, lyrics: false, info: false };
/** 正在进行的拉边改尺寸（一次只可能有一个；见 overlayResize） */
let overlayDrag = null;

/**
 * 创建某个模式的预览窗。
 * 关闭 = 隐藏（可再次打开）；开着「置顶」时失焦 / 显示都重新置顶，避免"点一下沉下去"。
 */
function createOverlayWindow(port, mode = 'both') {
  const base = server.baseUrl;   // 跟随 config.server.host（便于与 AdGuard 共存，见文件尾部说明）
  const size = OVERLAY_SIZE[mode] || OVERLAY_SIZE.both;
  // preview=1 → 页面显示工具条（无边框窗口没有系统关闭按钮）
  // only=...  → 只渲染对应的部分；直播姬的浏览器源不带 preview 所以看不到工具条
  // top/ct/... → 页面上那几个开关的初始状态（页面把它们写回地址栏，重载后不丢）
  const q = new URLSearchParams({
    preview: '1',
    top: overlayTopOn[mode] ? '1' : '0',
    ct: overlayClickThrough[mode] ? '1' : '0',
  });
  if (mode !== 'both') q.set('only', mode);
  const win = new BrowserWindow({
    width: size.width, height: size.height,
    minWidth: OVERLAY_MIN.width, minHeight: OVERLAY_MIN.height,
    transparent: true, frame: false, alwaysOnTop: overlayTopOn[mode],
    resizable: true, hasShadow: false, show: false,
    title: OVERLAY_TITLE[mode] || OVERLAY_TITLE.both,
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setBackgroundColor('#00000000');
  overlayWins[mode] = win;
  // 窗口被销毁重建时，穿越开关要跟着窗口走（懒一点：光标位置等页面报）
  applyOverlayClickThrough(mode);
  // key 用 overlay / overlay-lyrics / overlay-info，冒烟自检与诊断都按这个找
  markLoaded(mode === 'both' ? 'overlay' : 'overlay-' + mode)(win.webContents);
  win.loadURL(base + '/overlay?' + q.toString());
  const keepTop = () => {
    if (isQuitting || !win || win.isDestroyed()) return;
    // 用户把「置顶」关掉了就别再抢层级，否则那个开关等于没关
    if (!overlayTopOn[mode]) return;
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
 * 「置顶」开关（预览工具条上的按钮）。
 * 开着 = 固定压在最上层（show / 失焦都会重新压上去）；关掉 = 普通窗口，
 * 会被别的窗口盖住 —— 把预览窗当桌面挂件用又不想它挡住别的程序时用。
 */
function setOverlayTop(mode, on) {
  const m = OVERLAY_MODES.includes(mode) ? mode : 'both';
  overlayTopOn[m] = !!on;
  const win = overlayWins[m];
  if (win && !win.isDestroyed()) {
    try {
      win.setAlwaysOnTop(overlayTopOn[m], 'screen-saver');
      if (overlayTopOn[m] && win.isVisible()) win.moveTop();
    } catch { /* 忽略 */ }
  }
  return { ok: true, mode: m, on: overlayTopOn[m] };
}

/**
 * 预览窗拉边改尺寸：渲染进程只报「开始 / 正在拖 / 结束」和一个边（n/s/w/e + 四个角），
 * 真正的几何计算在这里做。
 *
 * 为什么不把渲染层的 MouseEvent.screenX 传过来算：混合 DPI 下渲染层的屏幕坐标
 * 与窗口 bounds 不是同一坐标系，缩放显示器上会越拖越偏。这里直接读
 * `screen.getCursorScreenPoint()`（与 getBounds 同为 DIP），从拖拽起点算增量，稳。
 *
 * 拉动的过程中窗口边缘跟着光标走，所以拖动期间指针一直在动、渲染层按帧调这里 ——
 * 没有常驻定时器，松手后不会再有 move，也就不会自己继续变大。
 * "增量 → 新 bounds" 那段是纯函数，在 core/overlay-window.js 里（有单测）。
 */
function overlayResize(mode, edge, phase) {
  const m = OVERLAY_MODES.includes(mode) ? mode : 'both';
  const win = overlayWins[m];
  if (!win || win.isDestroyed()) return { ok: false, msg: '预览窗不存在' };
  if (phase === 'end') { overlayDrag = null; return { ok: true, mode: m }; }
  if (!OVERLAY_EDGES.includes(edge)) return { ok: false, msg: '未知的边：' + edge };

  const cur = screen.getCursorScreenPoint();
  if (phase === 'start') {
    overlayDrag = { mode: m, edge, cursor: cur, bounds: win.getBounds() };
    return { ok: true, mode: m, edge, bounds: overlayDrag.bounds };
  }
  // 'move'：必须配着一个同窗口同边的 start，否则忽略（防串窗口 / 防没有起点的拖动）
  if (!overlayDrag || overlayDrag.mode !== m || overlayDrag.edge !== edge) {
    return { ok: false, msg: '没有正在进行的拖动' };
  }
  const next = nextBounds(
    overlayDrag.bounds, edge, cur.x - overlayDrag.cursor.x, cur.y - overlayDrag.cursor.y);
  try {
    win.setBounds(next);
  } catch (e) {
    return { ok: false, msg: e.message };
  }
  return { ok: true, mode: m, bounds: win.getBounds() };
}

/**
 * 让叠加层预览窗显示并**稳稳压在其它窗口之上**。
 *
 * 为什么不能只靠创建时的 alwaysOnTop:true：
 * 窗口隐藏再显示后，Windows 可能丢掉 topmost 标记；点一下它拿到焦点、
 * 随后又失去焦点时就掉到下层去了（用户反馈"点了自己就跑到下层"）。
 * 所以：显示前先设 topmost，显示后再补一次，并且失焦时自动重新置顶。
 * **但「置顶」被用户关掉时这一整套都不做** —— 那时它就是普通窗口，会正常被盖住。
 */
function presentOverlay(mode = 'both') {
  if (!OVERLAY_MODES.includes(mode)) mode = 'both';
  let win = overlayWins[mode];
  // 被销毁过就重建 —— 用户关掉某个预览窗后再点它，不该毫无反应
  if (!win || win.isDestroyed()) {
    const port = (server && server.boundPort) || 37821;
    win = createOverlayWindow(port, mode);
  }
  const top = overlayTopOn[mode];
  try {
    win.setAlwaysOnTop(top, 'screen-saver');
    if (!win.isVisible()) win.show();
    if (top) win.moveTop();
    // 有些合成器在 show 之后才真正应用层级，补一次更保险
    setTimeout(() => {
      try {
        if (top && win && !win.isDestroyed() && win.isVisible()) {
          win.setAlwaysOnTop(true, 'screen-saver');
          win.moveTop();
        }
      } catch { /* 忽略 */ }
    }, 120);
  } catch (e) {
    return { ok: false, msg: e.message };
  }
  return { ok: true, mode, alwaysOnTop: top };
}

/**
 * 「点击穿越」开关 + 光标位置上报（预览工具条上的按钮 / 页面的 mousemove）。
 *
 * 落点：`setIgnoreMouseEvents(ignore, { forward: true })`。
 * **forward 不能省** —— 透传之后页面收不到普通鼠标事件，只有转发过来的移动事件
 * 能让它知道"光标挪回顶边那一条了"，从而把窗口切回可点；漏了它，用户一旦开了穿越
 * 就再也点不回工具条（只能去控制台关）。这是这个功能唯一的死路，务必留着。
 *
 * 忽略与否 = 开了穿越 **且** 光标不在顶部那条可点带里：
 *   · 光标在那一条里（工具条可见时是它本身，藏起来时是 14px 感应带）→ 保持可点，
 *     用户才能点工具条上的按钮、也才有"点一下把工具条叫回来"这条路；
 *   · 其余时候整块透传，点击落到下面的程序上。
 */
function applyOverlayClickThrough(mode) {
  const win = overlayWins[mode];
  if (!win || win.isDestroyed()) return;
  const ignore = !!overlayClickThrough[mode] && !overlayTopOver[mode];
  try {
    win.setIgnoreMouseEvents(ignore, { forward: ignore });
  } catch (e) {
    // 这个失败**不能静默**：窗口一旦按预期透传，页面就只剩顶边那条能点，
    // 而那条又依赖 forward 转发 —— 出问题要能从日志里看到原因
    console.log('[overlay] 切换点击穿越失败:', e.message);
  }
}

function setOverlayClickThrough(mode, on) {
  const m = OVERLAY_MODES.includes(mode) ? mode : 'both';
  overlayClickThrough[m] = !!on;
  // 刚点完按钮时光标就在工具条上，而"在不在顶部那条里"由页面接着报（见渲染层注释）
  applyOverlayClickThrough(m);
  return { ok: true, mode: m, on: overlayClickThrough[m] };
}

function setOverlayPointerRegion(mode, over) {
  const m = OVERLAY_MODES.includes(mode) ? mode : 'both';
  overlayTopOver[m] = !!over;
  applyOverlayClickThrough(m);
  return { ok: true, mode: m, over: overlayTopOver[m] };
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
 * 显示「运行日志 / 状态」窗口（不存在就建）。
 *
 * 为什么需要它：**打包成 exe 后没有控制台** —— `console.log` 写进虚无，
 * 出现"卡住了 / 点了没反应 / 信息全丢"这类问题时，用户手里一条日志都没有。
 * 这个窗口把主进程日志（环形缓冲 + `data/logs.txt`）和运行状态（播放/队列/弹幕/网易云/缓存）
 * 实时摆出来，菜单里可开。窗口关掉只是隐藏，下次打开还在同一份日志上。
 */
function showLogWindow() {
  if (winLogs && !winLogs.isDestroyed()) {
    winLogs.show();
    winLogs.focus();
    return winLogs;
  }
  const base = server.baseUrl;
  winLogs = new BrowserWindow({
    width: 980, height: 620, show: true,
    title: 'NekoFM 运行日志 / 状态',
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  winLogs.loadURL(base + '/logs');
  winLogs.on('close', (e) => {
    // 与其它窗口一致：程序退出时才真关，平时只是隐藏（日志不丢）
    if (!isQuitting) { e.preventDefault(); winLogs.hide(); }
  });
  winLogs.on('closed', () => { winLogs = null; });
  return winLogs;
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
      // 预览工具条上的开关 / 拉边改尺寸 / 光标位置上报（窗口本身的属性）
      setOverlayTop: (mode, on) => setOverlayTop(mode, on),
      setOverlayClickThrough: (mode, on) => setOverlayClickThrough(mode, on),
      overlayPointerRegion: (mode, over) => setOverlayPointerRegion(mode, over),
      overlayResize: (mode, edge, phase) => overlayResize(mode, edge, phase),
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
          /**
           * 预览窗的两个开关状态（置顶在 alwaysOnTop 里，这里只补穿越 ——
           * Electron 没有"读回 setIgnoreMouseEvents"的接口，所以留一份自己的状态，
           * 排查"开了穿越点不动"这类问题时从这里看）。
           */
          overlayClickThrough: { ...overlayClickThrough },
          overlayTopOver: { ...overlayTopOver },
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
    // 本地音频与封面只允许读「曲库目录 + 用户显式打开的文件 + 它们那几张侧车封面 +
    // 封面缓存」，防止 /stream/local 与 /stream/cover 变成任意文件读取
    allowRootsProvider: () => [
      ...(engine.config.local.dirs || []),
      ...(engine.local.extraFiles ? [...engine.local.extraFiles] : []),
      // 侧车封面（歌名.jpg / folder.jpg）：只放行我们自己认定过的那几张，不是整个目录
      ...(engine.local.extraCovers ? [...engine.local.extraCovers] : []),
      path.join(DATA_DIR, 'covers'),
      engine.cache.cacheDir,   // 媒体缓存也要放行，否则缓存的文件自己播不了
    ],
    onCommand: handleCommand,
    log: (...a) => console.log(...a),
    logBus,   // 让 /logs 窗口能实时收日志（见 logbus.js）
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
        /**
         * 「点击穿越」的救生绳。
         * 正常路径是：光标碰顶边感应带 → 页面（靠主进程 forward 转发过来的移动事件）
         * 上报"光标在顶上" → 窗口切回可点 → 点一下工具条就回来了。
         * 万一这条链子哪一环失灵（比如系统不给转发移动事件），窗口就从用户手里"消失"了 ——
         * 菜单这一条能一键把三个预览窗的穿越全关掉，不用重启程序。
         */
        { label: '取消预览窗的「点击穿越」', click: () => {
          for (const m of OVERLAY_MODES) { overlayClickThrough[m] = false; applyOverlayClickThrough(m); }
          return { ok: true };
        } },
        { type: 'separator' },
        /**
         * 打包后的 exe 没有控制台 —— 这个是唯一的"现场"入口，放在窗口菜单里最顺手。
         */
        { label: '运行日志 / 状态窗口', click: () => showLogWindow() },
        { label: '打开日志文件所在目录', click: () => shell.openPath(DATA_DIR) },
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
        { label: '运行日志 / 状态', click: () => showLogWindow() },
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
        /**
         * 预览工具条：两个开关按钮 + 一圈拉边把手。
         * 无边框窗口只有这条自带入口，它没起来就等于用户关不掉、也拉不动窗口。
         * 顺带**量一次几何**：画布（真正给直播看的内容）必须整块落在工具条下面 ——
         * 绝对定位的信息卡曾经被工具条压住过，这种"看着不对但没人报错"的问题
         * 只有真窗口里的数字能证明。
         */
        const barOk = await ov.webContents.executeJavaScript(
          '(() => {'
          + ' const bar = document.getElementById("previewBar");'
          + ' const cv = document.querySelector(".overlay-canvas");'
          + ' if (!bar || !cv || bar.hidden) return false;'
          + ' if (!document.getElementById("pbTop") || !document.getElementById("pbAuto")) return false;'
          + ' if (document.querySelectorAll(".pb-edge").length !== 8) return false;'
          + ' const b = bar.getBoundingClientRect(), c = cv.getBoundingClientRect();'
          + ' return c.top >= b.bottom - 1;'
          + '})()');
        const geom = await ov.webContents.executeJavaScript(
          '(() => {'
          + ' const bar = document.getElementById("previewBar").getBoundingClientRect();'
          + ' const cv = document.querySelector(".overlay-canvas").getBoundingClientRect();'
          + ' return "工具条 0~" + Math.round(bar.bottom) + "px / 画布从 " + Math.round(cv.top) + "px 起";'
          + '})()');
        overlayDetail = `渲染行数=${n}；工具条开关与把手=${barOk}；${geom}`;
        overlayDomOk = overlayDomOk && barOk;
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

      /**
       * 运行日志窗口：**真的把它打开**再看 DOM。
       * 这是"打包成 exe 后还有没有办法自查"的唯一入口，值得在冒烟里把住 ——
       * 菜单点不点得到没法脚本化，但"窗口能不能起来 + 页面节点在不在"可以。
       */
      let logWinOk = false;
      let logDetail = '';
      try {
        const w = showLogWindow();
        await new Promise((r) => setTimeout(r, 1500));
        logWinOk = await w.webContents.executeJavaScript(
          '!!document.getElementById("lines") && !!document.getElementById("status") && !!document.getElementById("filter")');
        const n = await w.webContents.executeJavaScript('document.querySelectorAll("#lines li").length');
        const conn = await w.webContents.executeJavaScript('document.getElementById("pConn") ? document.getElementById("pConn").textContent : "?"');
        logDetail = `${conn} · 日志行 ${n}`;
      } catch (e) { logDetail = '打开失败：' + e.message; }

      /**
       * 预览窗的几个新交互里，**主进程这半边**是可以脚本验的：
       * 置顶开关真的改到了窗口属性、拉边命令链路通、点击穿越的开关与光标位置状态能翻转。
       * 另外半边（失去焦点时工具条藏起来、按住边缘跟着鼠标改大小、点击真的穿到下层）
       * 在渲染层 + 真实鼠标上，脚本够不到 —— 所以只验到这里为止，别把没验的说成验过了。
       */
      let overlayCtlOk = false;
      let overlayCtlDetail = '';
      try {
        const off = await handleCommand({ action: 'setOverlayTop', mode: 'both', on: false });
        const topOff = !overlayWins.both.isAlwaysOnTop();
        const on = await handleCommand({ action: 'setOverlayTop', mode: 'both', on: true });
        const topOn = overlayWins.both.isAlwaysOnTop();
        const b0 = overlayWins.info.getBounds();
        const r1 = await handleCommand({ action: 'overlayResize', mode: 'info', edge: 'se', phase: 'start' });
        const r2 = await handleCommand({ action: 'overlayResize', mode: 'info', edge: 'se', phase: 'end' });
        // 光标全程没动，尺寸就该一点没变（start 只记起点，move 才动窗口）
        const b1 = overlayWins.info.getBounds();
        const same = b1.width === b0.width && b1.height === b0.height;
        /**
         * 点击穿越：开关有回执、状态能从诊断里读到（Electron 没有"读回
         * setIgnoreMouseEvents"的接口，所以主进程自己记一份）。
         * 光标在不在顶部那条可点带里，也是靠渲染层上报的两个状态位。
         * 验完**关掉** —— 免得后面检查窗口时它还处在透传状态。
         */
        /**
         * 点击穿越：这次**走真实链路**，不从主进程直接调命令 ——
         * 在页面里点「点击穿越」按钮（页面 → postCommand → 主进程），
         * 再往页面派发鼠标移动事件，看"页面按 y 算出在不在顶部那条 → 上报 → 主进程记状态"整条通不通。
         * 为什么用 DOM 事件而不是 sendInputEvent：后者要求窗口**聚焦**（还得真显示出来抢桌面焦点，
         * 冒烟不该干这种事）。而这里要验的只是页面这一半；
         * "透传时操作系统会不会真把移动事件转发过来"是系统行为，冒烟验不到（得真鼠标，见 README 第 26 条）。
         */
        const wBoth = overlayWins.both;
        const clickBtn = (id) => wBoth.webContents.executeJavaScript(
          `document.getElementById('${id}').click(), true`);
        const fireMove = (y) => wBoth.webContents.executeJavaScript(
          `window.dispatchEvent(new MouseEvent('mousemove', { clientY: ${Math.round(y)}, bubbles: true })), true`);
        const diag = async () => handleCommand({ action: 'windowsDiag' });
        const settle = () => new Promise((r) => setTimeout(r, 300));
        await clickBtn('pbCt');
        await settle();
        const ctOnOk = (await diag()).overlayClickThrough.both === true;
        await fireMove(5);          // 顶部那条可点带里（工具条 33px，藏起来时是 14px 感应带）
        await settle();
        const inState = (await diag()).overlayTopOver.both;
        await fireMove(200);        // 挪到内容区 → 应该整块透传
        await settle();
        const outState = (await diag()).overlayTopOver.both;
        const pageSees = await wBoth.webContents.executeJavaScript(
          'document.documentElement.dataset.topOver');
        await clickBtn('pbCt');     // 再点一下关掉，别把窗口留在透传状态
        await settle();
        const ctOffOk = (await diag()).overlayClickThrough.both === false;
        /**
         * 长歌词自动缩字号（用户要求）：真窗口里塞一句超长歌词，看它会不会把字号缩到装得下。
         * 这条只能这么验 —— 它是**布局行为**，Node 单测够不到，只有真布局量得出来。
         * 塞完调一次 fitLyrics()（页面自己也暴露了入口给调试用），再读回字号与是否溢出。
         */
        const fit = await wBoth.webContents.executeJavaScript(`(() => {
          const stage = document.getElementById('stage');
          const lines = document.getElementById('lines');
          const size = () => parseFloat(getComputedStyle(document.body).getPropertyValue('--font-size')) || 0;
          const before = size();
          lines.innerHTML = '<div class="line active">' + '长'.repeat(400) + '</div>';
          window.__nekofm.fitLyrics();
          return {
            before, after: size(), fits: lines.scrollHeight <= stage.clientHeight + 1,
            fit: window.__nekofm.S.fontFit,
          };
        })()`);
        // 字号必须真的变小了，而且缩完真的装得下（留 1px 误差）
        const fitOk = fit.fits && fit.after < fit.before;
        /**
         * 信息卡长文本滚动的**累积回归**：反复重渲染那一行（模拟换歌/状态广播）后，
         * DOM 不许越滚越多。老 bug 是拆包时漏掉接缝副本 `.mq-dup`，
         * 于是每次重渲染内容翻一倍 —— 实测 8 轮后节点 26→3328、`--mq-dur` 涨到 8561 秒，
         * 表现就是"右边信息一直滚不出来"、再往后渲染进程被拖死、整张卡片不再刷新
         * （用户实测报的正是这个）。这里只看"有没有增长"这一条不变量，
         * 所以页面自己的状态广播来插一脚也不会误报（它只会把内容换短、让计数更小）。
         */
        const mq = await overlayWins.info.webContents.executeJavaScript(`(async () => {
          const line2 = document.querySelector('.ib-line2');
          const card = document.getElementById('infoBar');
          if (!line2 || card.hidden) return null;
          const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          let maxNodes = 0, maxDups = 0;
          for (let i = 0; i < 6; i++) {
            // **每轮都换文本**：内容一变，签名就变，拆包重建那条路才真的跑到
            // （只重设同一段文本的话，签名没变会被早退拦住，等于没测到拆包）
            document.getElementById('ibArtist').textContent = '很长的歌手名字'.repeat(6) + '·第' + i + '轮';
            document.getElementById('ibRequester').hidden = false;
            document.getElementById('ibRequester').textContent = '点歌：很长很长的点歌人名字';
            window.__nekofm.applyRolling(line2);
            await frame();
            maxNodes = Math.max(maxNodes, line2.querySelectorAll('*').length);
            maxDups = Math.max(maxDups, line2.querySelectorAll('.mq-dup').length);
          }
          return { maxNodes, maxDups, dur: line2.style.getPropertyValue('--mq-dur') || '(无)' };
        })()`);
        const mqOk = !!mq && mq.maxNodes <= 40 && mq.maxDups <= 1;
        const ctOk = ctOnOk && inState === true && outState === false && ctOffOk;
        overlayCtlOk = !!off.ok && topOff && !!on.ok && topOn && !!r1.ok && !!r2.ok && same
          && ctOk && fitOk && mqOk;
        overlayCtlDetail = `置顶可关=${topOff} / 可开=${topOn}；拉边命令=${!!r1.ok && !!r2.ok}；`
          + `没拖动时尺寸不变=${same}；穿越按钮开关=${ctOnOk}/${ctOffOk}；`
          // 打的是**状态值**（不是断言真假）：进入顶部那条应为 true、挪到内容区应为 false，
          // 括号里是页面自己记的那一份，两边一致才算这条链真的通
          + `顶部可点带：进顶部=${inState} / 挪到内容区=${outState}（页面侧=${pageSees}）；`
          + `长歌词自动缩字号=${fitOk}（${fit.before}→${fit.after}px，装得下=${fit.fits}）；`
          + `信息卡滚动不累积=${mqOk}（6 轮后最多 ${mq ? `${mq.maxNodes} 节点/${mq.maxDups} 副本/${mq.dur}` : '未测'}）`;
      } catch (e) { overlayCtlDetail = '执行失败：' + e.message; }

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
        ['运行日志窗口可打开（页面 + 状态栏 + 过滤框就绪）', logWinOk],
        ['预览窗置顶开关 / 拉边改尺寸（主进程侧）', overlayCtlOk],
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
      console.log(`[smoke] 预览窗交互: ${overlayCtlDetail}`);
      console.log(`[smoke] 运行日志窗口: ${logDetail}`);
      console.log(`[smoke] 播放核心: ${playerDetail}`);
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
