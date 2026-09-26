/**
 * 网易云「浏览器急兑」通道（Electron 专用）
 * =========================================
 * 定位：**兜底**，不是主路径。主路径是 src/core/netease/client.js 的 eapi 接口取流。
 *
 * 为什么需要它：
 *   网易云会持续改加密算法（weapi → eapi → xeapi）、加设备指纹（易盾）、
 *   对服务端 IP 做风控（-460 cheating）。接口一旦被掐，还有一条"像正常用户一样"
 *   的路：用真实浏览器的登录态去取播放地址。
 *
 * 关键设计：**借会话取直链，而不是在浏览器里放歌。**
 *   若让浏览器自己播，播放进度就得从页面里刮，歌词同步立刻失去精度；
 *   这里只把「已登录的真实会话」当成取地址的通道，拿到 MP3/M4A 直链后
 *   交回我们自己的播放核心播 —— 于是歌词时基依然是精确的 currentTime。
 *
 * 顺带解决另一件事：**登录**。内置 Electron 登录窗跑一次扫码，
 *   会话落在独立 partition 里持久化，再把 cookie 交给 API 客户端，
 *   于是主路径也能用上 VIP 账号（不用用户手工复制 cookie）。
 */
'use strict';

const { eapi } = require('../../core/netease/weapi');
/**
 * 复用主客户端的封面 URL 构造。
 * **必须用它，别自己拼** —— 网易云图片路径的第一段是 picId 异或 + MD5 出来的 hash
 * （见 client.js 的 encryptedPicId），不是 picId 本身。
 * 2026-09-26 踩过：这里原来朴素拼成 `/<picId>/<picId>.jpg`，
 * 结果**全部 404**（实测 404 vs 正确的 200），而浏览器通道现在是主路径，
 * 于是用户的封面"以前能看、改了之后全裂"。
 */
const { neteasePicUrl, parseJsonExact } = require('../../core/netease/client');

const LOGIN_URL = 'https://music.163.com/#/login';
const MUSIC_URL = 'https://music.163.com/';

class NeteaseBrowserFallback {
  /**
   * @param {{partition?:string, log?:Function}} [opts]
   */
  constructor(opts = {}) {
    this.partition = opts.partition || 'persist:nekofm-netease';
    this.log = opts.log || (() => {});
    this.win = null;          // 隐藏的"借会话"窗口（`ensureWindow` 用）
    this._loginWindow = null; // 2026-09-26：可见的"打开登录窗"窗口（`openLoginWindow` 用），登出时要关掉
    this._loading = null;
    this.available = false;
    try {
      // 只做可用性探测，不在这里 require electron（headless 下不存在）
      this.electron = require('electron');
      this.available = !!(this.electron && this.electron.BrowserWindow);
    } catch {
      this.available = false;
    }
  }

  /** 懒加载一个隐藏窗口，页面停在 music.163.com（同源才能带 cookie 发请求） */
  async ensureWindow() {
    if (!this.available) throw new Error('浏览器急兑需要 Electron 运行环境（当前是 headless 模式）');
    if (this.win && !this.win.isDestroyed() && this._loaded) return this.win;
    if (this._loading) { await this._loading; return this.win; }

    const { BrowserWindow } = this.electron;
    this._loaded = false;
    this.win = new BrowserWindow({
      width: 1024, height: 720, show: false,
      title: 'NekoFM · 网易云会话',
      webPreferences: { partition: this.partition, contextIsolation: true, nodeIntegration: false },
    });
    const wc = this.win.webContents;
    wc.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    this._loading = new Promise((resolve, reject) => {
      wc.once('did-finish-load', () => { this._loaded = true; resolve(); });
      wc.once('did-fail-load', (_e, code, desc) => reject(new Error(`音乐页加载失败 code=${code} ${desc}`)));
      // 兜底：不能因为音乐页没加载完就把整条链路卡住（2026-09-26：20s → 8s）。
      // 页面没就绪也能发请求（同源即可），did-finish-load 只是"可以发了"的信号。
      setTimeout(() => { this._loaded = true; resolve(); }, 8000);
    });
    this.win.loadURL(MUSIC_URL);
    await this._loading;
    this._loading = null;
    this.log('[netease-browser] 会话窗口已就绪');
    return this.win;
  }

  /**
   * 通用借浏览器 fetch（2026-09-26 升级：覆盖搜索/歌词/详情/歌单/账号）。
   *
   * 在 music.163.com 的页面上下文里跑 fetch，自动带上：
   *   · 真 session cookie（用户扫码登录后的 MUSIC_U/__csrf 等）
   *   · deviceId / WebGL 指纹（页面加载时 deviceid.js 自动跑过一次）
   *   · 易盾 watchman / acstatic-dun 这些客户端验证脚本也会自然执行
   *
   * 这是老点歌机（danmu-music / CefSharp）不被限流的根本原因——服务端把它当
   * 正常用户在处理。直连 fetch 再怎么伪装也撑不过 5-6 次 unique 请求。
   *
   * @param {string} url 绝对路径（`/api/...`）或完整 URL；同源走 cookie
   * @param {object} [opts] { method, headers, body }
   * @returns {Promise<{ok:boolean, status?:number, json?:object, text?:string, error?:string}>}
   */
  async browserFetch(url, opts = {}) {
    const win = await this.ensureWindow();
    const script = `(async () => {
      try {
        const init = { credentials: 'include' };
        ${opts.method ? `init.method = ${JSON.stringify(opts.method)};` : ''}
        ${opts.headers ? `init.headers = ${JSON.stringify(opts.headers)};` : ''}
        ${opts.body ? `init.body = ${JSON.stringify(opts.body)};` : ''}
        // 页面侧也给自己的 fetch 加超时：网络卡住时不能让 executeJavaScript 永远不返回
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), ${opts.timeoutMs || 8000});
        init.signal = ac.signal;
        const r = await fetch(${JSON.stringify(url)}, init);
        clearTimeout(timer);
        const t = await r.text();
        // **页面里不要 JSON.parse**（2026-09-26 修）：picId 这类值约 1.1e17，
        // 超过 Number.MAX_SAFE_INTEGER，在页面里一解析就被舍入（…694 → …700），
        // 而封面 URL 是拿 picId 算 MD5 的 —— 于是封面直接 HTTP 400（实测「耀斑」）。
        // 原文交回主进程，由 client.parseJsonExact 用 ctx.source 保住原始数字。
        return { ok: true, status: r.status, jsonText: t };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    })()`;
    /**
     * 主进程侧再兜一层超时（2026-09-26 加）。
     *
     * 为什么必须兜：`executeJavaScript` 的 Promise 只有在页面脚本跑完才 resolve。
     * 如果渲染进程正忙于加载 music.163.com 的 SPA、或页面被弹窗/死循环卡住，
     * 这个 Promise 会**一直挂着**，调用方（点歌/歌词/取流）就跟着等 ——
     * 用户感受就是"点了按钮没反应，几十秒后才突然一连串动作"。
     * 超时后立即返回失败，让上层走直连兜底，不拖住整个引擎。
     */
    const timeoutMs = opts.executeTimeoutMs || 10000;
    let res;
    try {
      res = await Promise.race([
        win.webContents.executeJavaScript(script, true),
        new Promise((resolve) => setTimeout(
          () => resolve({ ok: false, error: `页面通道超时（${timeoutMs}ms 未返回）` }), timeoutMs)),
      ]);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    /**
     * 页面只回原始文本，**在这里**按"精确大整数"解析（见 parseJsonExact 的说明）。
     * 保持 `r.json` 这个既有契约不变，上层调用方不用改。
     */
    if (res && res.ok && typeof res.jsonText === 'string') {
      const t = res.jsonText;
      delete res.jsonText;          // 大 payload 别一直挂在返回对象上
      res.json = null;
      try { res.json = parseJsonExact(t); } catch { res.text = t.slice(0, 500); }
    }
    return res;
  }

  /**
   * 借浏览器取播放地址（保留 eapi 加密版，与原 getSongUrl 同语义，
   * 内部改走 browserFetch 共用通道）。
   */
  async getSongUrl(id, { level = 'exhigh', encodeType = 'aac' } = {}) {
    const body = new URLSearchParams(eapi('/api/song/enhance/player/url/v1', {
      ids: `[${id}]`, level, encodeType, imme: 'true',
    })).toString();

    const r = await this.browserFetch('/eapi/song/enhance/player/url/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r || !r.ok) return { ok: false, msg: '页面取流失败：' + (r && r.error) };
    const d = r.json && r.json.data && r.json.data[0];
    if (!d || !d.url) {
      return {
        ok: false,
        msg: r.json ? `页面取流无地址（code=${r.json.code}${r.json.message ? ' ' + r.json.message : ''}，可能需要登录）` : '页面返回非 JSON：' + r.text,
      };
    }
    return {
      ok: true, url: d.url,
      trial: !!d.freeTrialInfo, trialEnd: d.freeTrialInfo ? d.freeTrialInfo.end : null,
      br: d.br || 0, size: d.size || 0, fee: d.fee, level: d.level || null, path: 'browser',
    };
  }

  /**
   * 借浏览器搜索（GET /api/search/get/web，**不需要登录**，但登录后结果更准）。
   * 返回值结构与 NeteaseClient.search 完全一致（ok/songs/total）。
   */
  async search(keyword, { type = 1, limit = 20, offset = 0 } = {}) {
    const q = new URLSearchParams({ s: keyword, type: String(type), limit: String(limit), offset: String(offset) }).toString();
    const r = await this.browserFetch(`/api/search/get/web?${q}`);
    if (!r || !r.ok) return { ok: false, code: -1, msg: '页面搜索失败：' + (r && r.error), songs: [] };
    if (!r.json) return { ok: false, code: -1, msg: '页面返回非 JSON：' + (r.text || '').slice(0, 200), songs: [] };
    if (r.json.code === 405 || r.status === 429) return { ok: false, code: 405, msg: '页面也限流了', songs: [] };
    const res0 = r.json.result || {};
    return {
      ok: true, code: r.json.code,
      songs: (res0.songs || []).map(this._normSong).filter(Boolean),
      total: res0.songCount || 0,
    };
  }

  /** 借浏览器取歌词（v1 端点带 yv/ytv/yrv，逐字必须走这条） */
  async lyric(id) {
    const q = new URLSearchParams({ id: String(id), lv: '-1', kv: '-1', tv: '-1', rv: '-1', yv: '-1', ytv: '-1', yrv: '-1' }).toString();
    const r = await this.browserFetch(`/api/song/lyric/v1?${q}`);
    if (!r || !r.ok) return { ok: false, code: -1, msg: '页面取歌词失败：' + (r && r.error), lrc: '', tlyric: '', romalrc: '', yrc: '' };
    if (!r.json) return { ok: false, code: -1, msg: '页面返回非 JSON：' + (r.text || '').slice(0, 200), lrc: '', tlyric: '', romalrc: '', yrc: '' };
    const g = (k) => (r.json[k] && r.json[k].lyric) || '';
    return { ok: true, code: r.json.code, lrc: g('lrc'), tlyric: g('tlyric'), romalrc: g('romalrc'), yrc: g('yrc') };
  }

  /** 借浏览器取歌曲详情 */
  async songDetail(ids) {
    const idArr = Array.isArray(ids) ? ids : [ids];
    const r = await this.browserFetch(`/api/song/detail?ids=${encodeURIComponent(JSON.stringify(idArr))}`);
    if (!r || !r.ok) return { ok: false, code: -1, msg: '页面取详情失败：' + (r && r.error), songs: [] };
    if (!r.json) return { ok: false, code: -1, msg: '页面返回非 JSON', songs: [] };
    return {
      ok: true, code: r.json.code,
      songs: (r.json.songs || []).map(this._normSong).filter(Boolean),
    };
  }

  /** 借浏览器取歌单详情 */
  async playlist(id, { limit = 200 } = {}) {
    const q = new URLSearchParams({ id: String(id), n: String(Math.min(500, limit || 500)), s: '8' }).toString();
    const r = await this.browserFetch(`/api/v6/playlist/detail?${q}`);
    if (!r || !r.ok) return { ok: false, code: -1, msg: '页面取歌单失败：' + (r && r.error), tracks: [] };
    if (!r.json) return { ok: false, code: -1, msg: '页面返回非 JSON', tracks: [] };
    const pl = (r.json.playlist || {});
    return {
      ok: true, code: r.json.code, id: pl.id, name: pl.name,
      cover: pl.coverImgUrl, trackCount: pl.trackCount,
      tracks: (pl.tracks || []).map(this._normSong).filter(Boolean),
    };
  }

  /** 借浏览器取账号信息（昵称 / VIP / UID） */
  async account() {
    const r = await this.browserFetch('/api/nuser/account/get');
    if (!r || !r.ok) return { ok: false, msg: '页面取账号失败：' + (r && r.error) };
    if (!r.json) return { ok: false, msg: '页面返回非 JSON' };
    if (r.json.code !== 200) return { ok: false, code: r.json.code, msg: r.json.message || '未登录或 cookie 失效' };
    return { ok: true, profile: r.json.profile, account: r.json.account };
  }

  /**
   * 把 netease 搜索结果里的歌曲项标准化成 NeteaseClient 同款 shape，
   * 这样上层拿到的歌单对象不管从哪条路来都一致。
   */
  _normSong(s) {
    if (!s) return null;
    const artists = (s.artists || s.ar || []).map((a) => (a && a.name) || '').filter(Boolean);
    const album = s.album || s.al || {};
    const cover = album.picUrl || (s.al && s.al.picUrl) || neteasePicUrl(album.picId, 200) || '';
    return {
      id: s.id, name: s.name, artists, artistText: artists.join(' / '),
      album: album.name || '', duration: (s.duration || s.dt || 0) / 1000,
      fee: s.fee, cover, source: 'netease',
    };
  }

  /** 读出 music.163.com 域的 cookie，拼成请求头，喂给主路径的 API 客户端 */
  async cookieString() {
    if (!this.available) return '';
    const { session } = this.electron;
    const ses = session.fromPartition(this.partition);
    const list = await ses.cookies.get({ domain: 'music.163.com' });
    return list.filter((c) => /MUSIC_U|__csrf|NMTID|__remember_me|MUSIC_A/.test(c.name))
      .map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /**
   * 清空当前浏览器会话的所有 storage（cookies + localStorage + IndexedDB），
   * 下次再打开登录窗就是登出状态。
   *
   * 为什么不清白名单 cookie（只清 MUSIC_U 等）：实测 music.163.com 还会把登录
   * 态写到 localStorage / IndexedDB，**只清 cookie 不够**，下次打开登录窗仍会
   * 自动恢复登录。所以整个 partition 一次性清干净。
   *
   * 关键（2026-09-26 修）：还要把**还开着的窗口关掉**。之前漏了关 `_loginWindow`，
   * 用户登出后那个可见的登录窗还在跑（页面 JS 还认得老 session），控制台看起来
   * "已登出"但窗口还在骗人；窗口里的请求还会因为 cookie 没了而 SSL 失败。
   *
   * partition 是 nekofm 私有的（`persist:nekofm-netease`），不会误伤别的应用数据。
   */
  async clearSession() {
    if (!this.available) return { ok: false, msg: '需要 Electron 运行环境' };
    const { session } = this.electron;
    const ses = session.fromPartition(this.partition);
    try {
      await ses.clearStorageData();
      // 关掉可见登录窗（用户之前点「打开登录窗」打开的那个）
      if (this._loginWindow && !this._loginWindow.isDestroyed()) {
        try { this._loginWindow.close(); } catch { /* 忽略 */ }
        this._loginWindow = null;
      }
      // 关掉隐藏的 session 窗（如果有）
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

  /** 弹出一个可见的登录窗，登录完成后自动把 cookie 收走 */
  async openLoginWindow({ timeoutMs = 180000 } = {}) {
    if (!this.available) throw new Error('登录窗需要 Electron 运行环境');
    // 如果上一次留着的登录窗还开着，先关掉（避免叠多个）
    if (this._loginWindow && !this._loginWindow.isDestroyed()) {
      try { this._loginWindow.close(); } catch { /* 忽略 */ }
    }
    const { BrowserWindow } = this.electron;
    const win = new BrowserWindow({
      width: 1000, height: 720, show: true,
      title: '登录网易云（扫码或账号密码）',
      webPreferences: { partition: this.partition, contextIsolation: true, nodeIntegration: false },
    });
    this._loginWindow = win;   // 2026-09-26：保存引用，登出时要关
    await win.loadURL(LOGIN_URL);

    const started = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(async () => {
        const cookie = await this.cookieString();
        if (/MUSIC_U=/.test(cookie)) {
          clearInterval(timer);
          this.log('[netease-browser] 检测到登录成功');
          try { if (!win.isDestroyed()) win.close(); } catch { /* 忽略 */ }
          resolve({ ok: true, cookie });
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve({ ok: false, msg: '等待登录超时' });
        }
      }, 2000);
      win.on('closed', () => {
        clearInterval(timer);
        this.cookieString().then((cookie) => resolve(/MUSIC_U=/.test(cookie) ? { ok: true, cookie } : { ok: false, msg: '窗口已关闭，未检测到登录态' }));
      });
    });
  }

  close() {
    try { if (this.win && !this.win.isDestroyed()) this.win.close(); } catch { /* 忽略 */ }
    this.win = null;
    this._loaded = false;
  }
}

module.exports = { NeteaseBrowserFallback };
