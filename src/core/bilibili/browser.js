/**
 * B站登录态通道（Electron 专用）
 * ==============================
 * 定位：**只负责"把人登录进去"，然后交出 cookie**。
 *
 * 为什么需要它（2026-09-26 实测的硬约束）：
 *   `/x/player/v2` 的字幕列表**必须带登录态**。未登录时 B站一律返回
 *   `need_login_subtitle: true` + `subtitles: []` —— 与视频本身有没有字幕无关。
 *   采样 5 个视频（含标题明确写了「双语字幕」的）全部为空。
 *   于是"视频音频的歌词"只能回落到"拿标题去网易云匹配"，冷门曲（游戏/同人 OST）
 *   基本匹配不到 → 用户看到的就是"歌词 0 行"。
 *
 * 关键设计取舍：**登录窗只用来取 cookie，不拿它发 API 请求**。
 *   cookie 拿到后写进 `config.bilibili.cookie`，字幕 / 检索仍走
 *   `BiliApi` 的 Node 直连（`biliFetch` 已经在带 Cookie 头）—— 那条路已实测可用，
 *   于是完全避开了"在页面上下文里跨域打 api.bilibili.com"的风控与 CORS 复杂度。
 *
 *   ⚠️ 弹幕不在这里（曾短暂用这个窗口做过，已废弃）：B站弹幕服务认的是**客户端
 *   实现本身**，Electron 环境一律被拒（握手 101 后立刻 1006，连 B站自家页面的
 *   弹幕连接都不建立）。弹幕改走外部浏览器，见 `browser-channel.js`。
 *
 * 与网易云那套（`src/main/sources/netease-browser.js`）同一模式：独立 persistent
 *   partition（`persist:nekofm-bilibili`），与网易云互不干扰，也不会碰到别的应用数据。
 */
'use strict';

const LOGIN_URL = 'https://passport.bilibili.com/login';
const HOME_URL = 'https://www.bilibili.com/';
/** 应用图标与窗口共用一份素材（src/renderer/assets/icon.png），登录窗也要显示它 */
const APP_ICON = require('node:path').join(__dirname, '..', '..', 'renderer', 'assets', 'icon.png');

class BiliBrowserSession {
  /**
   * @param {{partition?:string, log?:Function}} [opts]
   */
  constructor(opts = {}) {
    this.partition = opts.partition || 'persist:nekofm-bilibili';
    this.log = opts.log || (() => {});
    this.win = null;          // 隐藏的会话窗（预热用）
    this._loginWindow = null; // 可见登录窗
    this._loading = null;
    this._loaded = false;
    this.available = false;
    try {
      // 只做可用性探测，不在这里 require electron（headless 下不存在）
      this.electron = require('electron');
      this.available = !!(this.electron && this.electron.BrowserWindow);
    } catch {
      this.available = false;
    }
  }

  /** Electron 的 session 对象（读 cookie / 清 storage 用） */
  _session() {
    return this.electron.session.fromPartition(this.partition);
  }

  /**
   * 懒加载隐藏窗，页面停在 bilibili.com。
   *
   * 作用有两个：
   *   1) 让 partition 里生成 B站自己的匿名 cookie（`buvid3` / `b_nut` 等）——
   *      这些对 B站接口的风控有意义，光有 SESSDATA 反而不像正常用户；
   *   2) 为将来"真的要在浏览器上下文里发请求"留好同源环境。
   */
  async ensureWindow() {
    if (!this.available) throw new Error('B站会话需要 Electron 运行环境（当前是 headless 模式）');
    if (this.win && !this.win.isDestroyed() && this._loaded) return this.win;
    if (this._loading) { await this._loading; return this.win; }

    const { BrowserWindow } = this.electron;
    this.win = new BrowserWindow({
      width: 1024, height: 720, show: false,
      title: 'NekoFM · B站会话',
      webPreferences: { partition: this.partition, contextIsolation: true, nodeIntegration: false },
    });
    const wc = this.win.webContents;
    wc.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    this._loading = new Promise((resolve, reject) => {
      wc.once('did-finish-load', () => { this._loaded = true; resolve(); });
      wc.once('did-fail-load', (_e, code, desc) => { this._loaded = true; reject(new Error(`B站首页加载失败 code=${code} ${desc}`)); });
      // 兜底：页面没就绪也不该把链路卡住（cookie 生成通常早就完成了）
      setTimeout(() => { this._loaded = true; resolve(); }, 8000);
    });
    this.win.loadURL(HOME_URL);
    try {
      await this._loading;
    } finally {
      this._loading = null;
    }
    return this.win;
  }

  /**
   * 读出 bilibili.com 域的 cookie，拼成 Cookie 头。
   *
   * **不做白名单过滤**（与网易云那边不同）：B站的接口风控同时看
   * `SESSDATA`（登录态）、`buvid3` / `b_nut`（设备标识）、`bili_jct`（CSRF）——
   * 只挑 SESSDATA 反而容易被判为异常。这些 cookie 都是本 partition 自己的，
   * 带上没有副作用。
   */
  async cookieString() {
    if (!this.available) return '';
    try {
      const list = await this._session().cookies.get({ domain: 'bilibili.com' });
      return list.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch (e) {
      this.log('[bili-browser] 读取 cookie 失败:', e.message);
      return '';
    }
  }

  /** 是否已经拿到登录态（用于界面显示"已登录/未登录"） */
  async hasLogin() {
    return /SESSDATA=/.test(await this.cookieString());
  }

  /**
   * 清空 partition 的全部 storage（cookies + localStorage + IndexedDB），
   * 并把还开着的窗口关掉 —— 否则页面 JS 还认得老 session，界面说"已登出"却还在骗人
   * （网易云那边踩过这个坑，注释见 netease-browser.js 的 clearSession）。
   */
  async clearSession() {
    if (!this.available) return { ok: false, msg: '需要 Electron 运行环境' };
    try {
      await this._session().clearStorageData();
      if (this._loginWindow && !this._loginWindow.isDestroyed()) {
        try { this._loginWindow.close(); } catch { /* 忽略 */ }
        this._loginWindow = null;
      }
      if (this.win && !this.win.isDestroyed()) {
        try { this.win.close(); } catch { /* 忽略 */ }
        this.win = null;
        this._loaded = false;
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: e.message };
    }
  }

  /**
   * 弹出可见登录窗（扫码 / 账号密码），登录完成后自动把 cookie 收走。
   *
   * 轮询判定用 `SESSDATA=`：B站登录成功一定会下发它，且它是字幕接口认的那个 cookie。
   *
   * ⚠️ 已知风险：B站对自动化浏览器环境的检测比网易云严，登录页**可能**提示环境异常
   * 或反复要求验证。真被拦了就走控制台那个 SESSDATA 粘贴框（一定可用）。
   */
  async openLoginWindow({ timeoutMs = 180000 } = {}) {
    if (!this.available) return { ok: false, msg: '登录窗需要 Electron 运行环境（headless 模式请用 SESSDATA 粘贴框）' };
    // 上一次留着的登录窗还开着就先关掉，别叠多个
    if (this._loginWindow && !this._loginWindow.isDestroyed()) {
      try { this._loginWindow.close(); } catch { /* 忽略 */ }
    }
    const { BrowserWindow } = this.electron;
    const win = new BrowserWindow({
      width: 1000, height: 760, show: true,
      title: '登录 B站（扫码或账号密码）',
      icon: APP_ICON,
      webPreferences: { partition: this.partition, contextIsolation: true, nodeIntegration: false },
    });
    this._loginWindow = win;
    try {
      await win.loadURL(LOGIN_URL);
    } catch (e) {
      return { ok: false, msg: `登录页加载失败：${e.message}` };
    }

    const started = Date.now();
    return new Promise((resolve) => {
      const finish = (r) => {
        clearInterval(timer);
        if (r.ok) { try { if (!win.isDestroyed()) win.close(); } catch { /* 忽略 */ } }
        resolve(r);
      };
      const timer = setInterval(async () => {
        const cookie = await this.cookieString();
        if (/SESSDATA=/.test(cookie)) {
          this.log('[bili-browser] 检测到登录成功');
          finish({ ok: true, cookie });
          return;
        }
        if (Date.now() - started > timeoutMs) finish({ ok: false, msg: '等待登录超时' });
      }, 2000);
      win.on('closed', async () => {
        if (this._loginWindow === win) this._loginWindow = null;
        const cookie = await this.cookieString();
        finish(/SESSDATA=/.test(cookie)
          ? { ok: true, cookie }
          : { ok: false, msg: '窗口已关闭，未检测到登录态' });
      });
    });
  }

  close() {
    try { if (this.win && !this.win.isDestroyed()) this.win.close(); } catch { /* 忽略 */ }
    this.win = null;
    this._loaded = false;
  }
}

module.exports = { BiliBrowserSession };
