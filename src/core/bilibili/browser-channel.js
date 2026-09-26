/**
 * 真实浏览器弹幕通道（系统 Edge / Chrome + CDP）
 * ==================================================
 * 定位：**把 B站直播间弹幕接进来**，只负责"搬字节"。
 * 解包、指令解析、队列那些仍然留在 Node 侧（`DanmakuClient.feed`），
 * 不把协议实现搬到浏览器里重写一遍。
 *
 * ---------------------------------------------------------------------------
 * 为什么非要借外部浏览器（2026-09-26 一整天排查的结论，别再往回改）：
 *
 *   B站弹幕服务认的是**客户端实现本身**，不是 UA、不是 UA-CH、不是认证包内容。
 *   同一份 token + buvid + queue_uuid 当场对比：
 *     · 真实 Edge（Chromium 153）→ 认证回 `{"code":0}`，弹幕正常到达
 *     · Electron（Chromium 130 与 152 都试过）→ 握手 101 之后立刻 `1006`
 *     · Node 直连（OpenSSL，UA/Referer/Origin 全套伪装）→ 连认证回应都没有
 *
 *   Electron 侧把能改的都改过了，**全部无效**：UA 与 UA-CH 自洽、补上
 *   "Google Chrome" 品牌、UA-CH 请求头、窗口真实可见（挪到屏幕外）、
 *   关闭后台节流、升级 Electron 33 → 44。
 *   最硬的证据是：**B站自家页面在 Electron 里根本不建立弹幕连接** ——
 *   页面 JS 自己就判定这个环境不正常。所以问题不在我们的代码，在环境。
 *
 *   于是改为：spawn 系统 Edge（Windows 自带）开一个屏幕外的窗口，
 *   用 CDP 在直播间页面上下文里跑弹幕客户端，收到的原始帧再回主进程解析。
 *
 * 帧回传用 CDP `Runtime.evaluate` 轮询：远程页面的 CSP `connect-src` 不会允许
 * 打 `127.0.0.1`，轮询则完全绕开 CSP。
 */
'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const { WS_IMPL } = require('./mini-ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 常见安装位置：Edge 优先（Windows 自带），Chrome 兜底 */
const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 让系统分配一个空闲端口（CDP 用），避免固定端口撞车 */
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(0));
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// WS 实现与 B站封包协议统一放在 mini-ws.js（开放平台通道也用同一份）

class BrowserDanmakuChannel {
  /**
   * @param {{log?:Function, userDataDir?:string}} [opts]
   */
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this.exe = BROWSER_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
    /**
     * 独立 user-data-dir：绝不碰用户日常浏览器的 profile
     * （否则会跟用户正在开的窗口抢锁，也可能动到人家的登录态）。
     */
    this.userDataDir = opts.userDataDir || path.join(os.tmpdir(), 'nekofm-bili-channel');
    this.proc = null;
    this.port = 0;
    this._target = null;      // 当前房间标签页
    this._cdp = null;         // 当前标签页的 CDP 连接
    this._timers = [];
    this._foreignPid = 0;   // 复用来的浏览器进程号（见 _launchBrowser）
    this._startChain = null;  // 启动流程的串行化锁（见 start）
    this._stopped = false;
    this._gen = 0;            // 世代号：见 _bringUp 里的说明
    this._failStreak = 0;
    this._recovering = false;
    this._params = null;
  }

  /** 机器上没有 Edge/Chrome 就退回旧的直连路径（能连上就赚，连不上至少不崩） */
  get available() { return !!this.exe; }

  /** 把 CDP 端口 / 进程号写在 profile 目录里 —— 跨进程复用与清理都靠它 */
  get _stateFile() { return path.join(this.userDataDir, 'nekofm-cdp.json'); }

  _readStateFile() {
    try { return JSON.parse(fs.readFileSync(this._stateFile, 'utf8')); } catch { return null; }
  }

  _writeStateFile() {
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(this._stateFile, JSON.stringify({ port: this.port, pid: this.proc ? this.proc.pid : 0 }));
    } catch { /* 忽略 */ }
  }

  _clearStateFile() {
    try { fs.unlinkSync(this._stateFile); } catch { /* 本来就没有 */ }
  }

  // ---------------------------------------------------------------- 浏览器
  async _launchBrowser() {
    if (this.proc && !this.proc.killed && this.port) return;
    if (!this.available) throw new Error('未找到 Edge / Chrome，无法建立浏览器弹幕通道');

    /**
     * **先看是不是已经有"同一个 profile"的浏览器在跑。**
     *
     * Edge/Chrome 用同一个 `--user-data-dir` 启第二次时，新进程只会把请求转交给
     * 已有实例、然后**自己立刻退出** —— 我们看到的报错就是"浏览器进程提前退出"，
     * 接着一路回落到 Node 直连（界面写"Node 直连"，用户以为通道选错了）。
     * 上一次被强杀（任务管理器、或调试时的 kill）留下的残留实例就会造成这个。
     * 所以先在 profile 目录里读上次记下的端口，还活着就直接复用。
     */
    const prev = this._readStateFile();
    if (prev && prev.port) {
      try {
        const v = await (await fetch(`http://127.0.0.1:${prev.port}/json/version`)).json();
        if (v && v.webSocketDebuggerUrl) {
          this.port = prev.port;
          this.proc = null;                    // 不是本进程 spawn 的……
          this._foreignPid = prev.pid || 0;    // ……但退出时仍由我们负责收掉
          this.log(`[danmaku-ch] 复用已在运行的浏览器（CDP :${prev.port}）`);
          return;
        }
      } catch { /* 已失效，走下面的正常启动 */ }
      this._clearStateFile();
    }

    /**
     * 真正启动浏览器。**带重试**：Edge 偶尔会刚起来就自杀，最常见的元凶是
     * profile 里残留的单例锁（`SingletonLock` 等，上次异常退出留下的）——
     * 新实例看到它就以为"已经有一个在跑"，把请求交出去然后自己退出，
     * 表现就是"浏览器进程提前退出"。所以每次失败重试前先清一遍锁。
     */
    let lastErr = null;
    for (let attempt = 0; attempt < 3 && !this._stopped; attempt++) {
      if (attempt > 0) {
        this.log(`[danmaku-ch] 浏览器启动失败（${lastErr && lastErr.message}），清锁后重试 ${attempt}/2`);
        this._clearSingletonLocks();
        await sleep(1500);
      }
      try {
        await this._spawnOnce();
        return;
      } catch (e) {
        lastErr = e;
        this._killBrowser();
        this.port = 0;
      }
    }
    throw new Error(`浏览器启动失败：${lastErr ? lastErr.message : '未知'}`);
  }

  /**
   * 清掉 profile 里的单例锁。
   * Edge/Chromium 用这几个文件保证"同一 profile 只有一个实例"；进程被强杀
   * （任务管理器、崩溃）时它们会留下来，于是下一个实例**自杀式退出**。
   */
  _clearSingletonLocks() {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(this.userDataDir, f)); } catch { /* 没有就算了 */ }
    }
  }

  /** 启动一次并等 CDP 就绪（不做重试，由 _launchBrowser 负责重试） */
  async _spawnOnce() {
    this.port = await freePort();
    if (!this.port) throw new Error('拿不到可用端口');
    try { fs.mkdirSync(this.userDataDir, { recursive: true }); } catch { /* 已存在 */ }

    this.log(`[danmaku-ch] 启动浏览器 ${path.basename(this.exe)} (CDP :${this.port})`);
    this._foreignPid = 0;
    this.proc = spawn(this.exe, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
      // 窗口挪到屏幕外：既拿到"真实前台窗口"的网络行为，又不打扰用户。
      // （弹幕服务对 headless 与后台页面的态度不同，别改用 --headless。）
      '--window-position=-3200,-3200', '--window-size=1000,760',
      'about:blank',
    ], { stdio: 'ignore' });
    this.proc.on('exit', () => {
      this.proc = null;
      this.port = 0;
      /**
       * 整组进程退出 → 自动重拉。`_stopped` 为真说明这次退出是我们自己要的
       * （换房间 / 退出应用），那种情况不能触发恢复，否则会和新连接互相拆台。
       */
      if (!this._stopped) this._recover('浏览器进程退出');
    });

    // 等 CDP 端口起来（首次启动可能要十几秒）
    for (let i = 0; i < 80; i++) {
      await sleep(400);
      try {
        const v = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
        if (v && v.webSocketDebuggerUrl) {
          this.log(`[danmaku-ch] CDP 就绪：${v.Browser}`);
          this._writeStateFile();      // 记下端口/pid，供下次（含别的进程）复用与清理
          return;
        }
      } catch { /* 还没起来 */ }
      if (!this.proc) throw new Error('浏览器进程提前退出');
    }
    throw new Error('等待 CDP 超时');
  }

  /** 开一个标签页并导航到直播间（Origin 必须是 live.bilibili.com，见文件头说明） */
  async _openRoom(roomId) {
    const url = `https://live.bilibili.com/${Number(roomId)}`;
    const r = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const tab = await r.json();
    if (!tab || !tab.webSocketDebuggerUrl) throw new Error('创建标签页失败');
    this._target = tab;
    this.log(`[danmaku-ch] 已打开直播间标签页 ${url}`);
    return tab;
  }

  /** 极简 CDP 客户端：只用到 Runtime.evaluate / Page.enable */
  async _connectCdp(wsUrl) {
    const ws = new WS_IMPL(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => { pending.delete(mid); reject(new Error(`CDP ${method} 超时`)); }, 20000);
      pending.set(mid, (m) => { clearTimeout(timer); resolve(m); });
      try { ws.send(JSON.stringify({ id: mid, method, params })); } catch (e) { clearTimeout(timer); reject(e); }
    });
    this._cdp = { ws, send };
    return this._cdp;
  }

  /** 在页面上下文里求值（返回 JSON 可序列化的结果） */
  async _eval(expression, { awaitPromise = false } = {}) {
    if (!this._cdp) throw new Error('CDP 未连接');
    const r = await this._cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    /**
     * 注意两层壳：`_cdp.send` 返回的是整条 CDP 报文 `{ id, result: <协议内容> }`，
     * 而求值结果又在协议内容的 `result` 里 —— 少剥一层就会静默拿到 `undefined`，
     * 表现为"页面明明在收弹幕，主进程一帧都读不到"（踩过）。
     */
    const out = r && r.result;
    if (!out) throw new Error('CDP 未返回结果');
    if (out.exceptionDetails) {
      const t = out.exceptionDetails.exception && out.exceptionDetails.exception.description;
      throw new Error(t || out.exceptionDetails.text || '页面求值异常');
    }
    return out.result ? out.result.value : undefined;
  }

  // ---------------------------------------------------------------- 对外
  /**
   * 起一条弹幕连接。
   *
   * @param {{roomId:number, signUrl:string, urlProvider?:(roomId:number)=>Promise<string>,
   *          onFrame:(b:Buffer)=>void, onState?:(s:object)=>void}} opts
   * @returns {Promise<{stop:Function}>}
   */
  async start(opts) {
    /**
     * **串行化启动流程**：用户完全可能连着点「连接 / 断开」好几次，而上一次
     * 的启动还没走完（起浏览器 + 注入要好几秒）。两次交错会互相清定时器与
     * CDP 连接，弄出"启动失败"的假象 —— 让后来的等前面彻底结束再开始。
     */
    const prev = this._startChain || Promise.resolve();
    let release;
    this._startChain = new Promise((r) => { release = r; });
    try { await prev; } catch { /* 前一次失败不该拖累这一次 */ }
    try {
      return await this._startInner(opts);
    } finally { release(); }
  }

  async _startInner({ roomId, signUrl, urlProvider, onFrame, onState }) {
    this.stop();                 // 换房间先收掉上一条
    this._stopped = false;
    /**
     * 记住参数：浏览器可能整组自己退出（实测过 —— 窗口在屏幕外、长时间无交互，
     * 某个时刻 Edge 进程就没了），那时要按同样配置重新走一遍建连流程。
     */
    this._params = { roomId, signUrl, urlProvider, onFrame, onState };
    await this._bringUp();
    return { stop: () => this.stop() };
  }

  /**
   * 拉起浏览器并建连 —— **首次连接与自动重拉共用这一份**，
   * 免得两条路径各写一遍（那样修 bug 时容易只修到其中一条）。
   */
  async _bringUp() {
    const { roomId, signUrl, urlProvider, onFrame, onState } = this._params;
    await this._launchBrowser();
    const tab = await this._openRoom(roomId);
    const cdp = await this._connectCdp(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 等页面把 B站的匿名 cookie（buvid3 等）种下来，再注入
    await sleep(8000);

    const inject = async (url) => {
      await this._eval(`(${PAGE_CLIENT.toString()})()`);
      await this._eval(
        `window.__nekofmDanmaku.start(${JSON.stringify(url)}, ${Number(roomId)})`,
        { awaitPromise: true }
      );
    };
    await inject(signUrl);
    this.log('[danmaku-ch] 弹幕客户端已注入');

    this._failStreak = 0;
    this._recovering = false;
    /**
     * 世代号：自动重拉会把旧的定时器/旧的 in-flight 请求留在半空中，
     * 它们随后超时抛错，如果照样计入失败计数，就会误触发第二轮恢复。
     * 每次 `_bringUp` 递增，回调发现自己属于旧世代就直接退出。
     */
    const gen = ++this._gen;

    let lastState = '';
    this._frameSeen = 0;
    this._pullErr = 0;
    const pull = setInterval(async () => {
      if (this._stopped || this._gen !== gen) return;
      try {
        const frames = await this._eval('window.__nekofmDanmaku.drain()');
        if (this._gen !== gen) return;           // 恢复过程中旧世代的结果作废
        this._failStreak = 0;                    // 能通就把失败计数清零
        if (Array.isArray(frames) && frames.length) {
          // 首帧到过一次就说明链路通了，之后不再打日志（免得刷屏）
          if (this._frameSeen < 1) { this._frameSeen++; this.log('[danmaku-ch] 首帧已到达，链路正常'); }
          for (const b of frames) {
            try { onFrame(Buffer.from(b, 'base64')); } catch (e) { this.log('[danmaku-ch] 帧处理失败:', e.message); }
          }
        }
      } catch (e) {
        if (this._gen !== gen || this._stopped) return;   // 旧世代/已停止：不算失败
        if (this._pullErr < 3) { this._pullErr++; this.log('[danmaku-ch] 取帧失败:', e && e.message); }
        this._onChannelError(e);
      }
    }, 200);

    const poll = setInterval(async () => {
      if (this._stopped || this._gen !== gen) return;
      try {
        const s = await this._eval('window.__nekofmDanmaku.snapshot()');
        if (this._gen !== gen) return;
        if (!s || typeof s !== 'object') return;
        /**
         * 签名 URL 里的 `wts` 有时效（分钟级）。页面侧重试用的是同一串 URL，
         * 过期后就一直拿不到 token —— 它会进入 `need-url` 停下等待，
         * 由这里推一份新签名过去续上。否则长时间挂机一旦掉线就再也回不来。
         */
        if (s.state === 'need-url' && urlProvider) {
          try {
            const fresh = await urlProvider(roomId);
            await this._eval(`window.__nekofmDanmaku.setUrl(${JSON.stringify(fresh)})`, { awaitPromise: true });
            s.state = 'refreshed';
          } catch (e) { this.log('[danmaku-ch] 刷新签名失败:', e.message); }
        }
        if (s.state !== lastState) { lastState = s.state; if (onState) onState(s); }
      } catch (e) {
        if (this._gen !== gen || this._stopped) return;
        this._onChannelError(e);
      }
    }, 1000);

    this._timers = [pull, poll];
  }

  /**
   * 通道出错的累计与判定：连续失败到阈值就认为"浏览器整组没了"，触发自动重拉。
   *
   * 阈值 5 × 200ms ≈ 1 秒 —— 足够滤掉"页面正在跳转"这类瞬时失败，
   * 又不至于让用户对着"已连接"的假象干等。
   */
  _onChannelError(e) {
    if (this._stopped || this._recovering) return;
    this._failStreak = (this._failStreak || 0) + 1;
    if (this._failStreak >= 5) this._recover('CDP 连续失败：' + ((e && e.message) || '未知'));
  }

  /**
   * 浏览器整组没了（或 CDP 彻底失联）时的自动重拉。
   *
   * 为什么必须有它：实测 Edge 会自己退出（窗口在屏幕外、长时间没有交互），
   * 旧实现只会一直刷 `CDP Runtime.evaluate 超时`，弹幕**静默断掉**、界面上却
   * 还显示"已连接" —— 对直播来说这是最糟的失败方式（不说就等于没坏）。
   */
  async _recover(reason) {
    if (this._stopped || this._recovering || !this._params) return;
    this._recovering = true;
    this._gen++;              // 立刻作废旧世代的回调（清定时器挡不住已发出的请求）
    this.log(`[danmaku-ch] 通道异常（${reason}），重新拉起浏览器…`);
    const { onState } = this._params;
    try { if (onState) onState({ state: 'reconnecting', err: reason }); } catch { /* 忽略 */ }

    // 先把残骸收干净，免得旧定时器/旧 CDP 连接继续报错
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    try { if (this._cdp) this._cdp.ws.close(); } catch { /* 忽略 */ }
    this._cdp = null;
    this._target = null;
    this._killBrowser();

    for (let i = 0; i < 3 && !this._stopped; i++) {
      try {
        await this._bringUp();
        this.log('[danmaku-ch] 浏览器通道已恢复');
        return;
      } catch (e) {
        this.log(`[danmaku-ch] 恢复失败（第 ${i + 1}/3 次）：${e && e.message}`);
        this._killBrowser();
        await sleep(5000);
      }
    }
    this._recovering = false;
    if (!this._stopped) {
      this.log('[danmaku-ch] 连续恢复失败，本次放弃（下次切换房间会重试）');
      try { if (onState) onState({ state: 'error', err: '浏览器通道恢复失败' }); } catch { /* 忽略 */ }
    }
  }

  /** 只做进程清理，不碰 _params（恢复流程要用它重来） */
  _killBrowser() {
    try { if (this.proc && !this.proc.killed) this.proc.kill(); } catch { /* 忽略 */ }
    /**
     * 复用来的那个实例不是本进程 spawn 的，但**退出/重连时同样要收掉**：
     * 留着它，下一次启动就会撞上"同 profile 已在运行"，新进程又会立刻退出。
     */
    try { if (this._foreignPid) process.kill(this._foreignPid); } catch { /* 可能已经没了 */ }
    this._foreignPid = 0;
    this._clearStateFile();
    this.proc = null;
    this.port = 0;
  }

  /** 收掉当前连接（浏览器进程留着复用，换房间时省一次冷启动） */
  stop() {
    this._stopped = true;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    try { if (this._cdp) this._cdp.ws.close(); } catch { /* 忽略 */ }
    this._cdp = null;
    if (this._target && this.port) {
      const id = this._target.id;
      this._target = null;
      fetch(`http://127.0.0.1:${this.port}/json/close/${id}`, { method: 'PUT' }).catch(() => {});
    }
  }

  /** 彻底退出：连浏览器进程一起收掉（应用退出时调） */
  dispose() {
    this.stop();
    this._killBrowser();
    this._params = null;      // 明确断念：之后不再自动重拉
  }
}

/**
 * 注入到 B站直播间页面上下文里执行的客户端。
 *
 * 会被 `toString()` 序列化后送过去，所以**不能引用外部变量** —— 需要的东西
 * 都从 `start()` 的参数进来，或者页面自己取（cookie 里的 buvid3）。
 */
function PAGE_CLIENT() {
  const KEY = '__nekofmDanmaku';
  if (window[KEY]) return KEY;

  const st = {
    state: 'idle', err: '', frames: [], received: 0,
    ws: null, hb: null, retry: 0, closed: true, signUrl: '', roomId: 0, timer: null,
  };

  /** ArrayBuffer → base64（分块，避免大包把调用栈打爆） */
  const toB64 = (buf) => {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };

  /** B站弹幕协议包：16 字节头 + JSON 体 */
  const packet = (op, body) => {
    const json = body === undefined ? null : new TextEncoder().encode(JSON.stringify(body));
    const len = 16 + (json ? json.length : 0);
    const out = new Uint8Array(len);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, len);
    dv.setUint16(4, 16);
    dv.setUint16(6, 1);
    dv.setUint32(8, op);
    dv.setUint32(12, 1);
    if (json) out.set(json, 16);
    return out.buffer;
  };

  const clearHb = () => { if (st.hb) { clearInterval(st.hb); st.hb = null; } };

  const scheduleRetry = () => {
    if (st.closed) return;
    // 重试要克制：B站对同一身份的高频连接会直接上风控（-352），
    // 1s/2s/4s 这种节奏是"越重连越连不上"。
    if (st.retry >= 4) { st.state = 'need-url'; return; }
    st.retry++;
    st.state = 'retry';
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => { connect(); }, Math.min(60000, 5000 * Math.pow(2, st.retry)));
  };

  const connect = async () => {
    if (st.closed || !st.signUrl) return;
    st.state = 'fetching';
    let body;
    try {
      const r = await fetch(st.signUrl, { credentials: 'include' });
      body = await r.json();
    } catch (e) {
      st.state = 'error'; st.err = 'token 请求异常: ' + (e && e.message);
      return scheduleRetry();
    }
    if (!body || !body.data || !body.data.token) {
      // 签名过期或被风控 —— 停下等主进程推新签名，别拿废 URL 空转
      st.state = 'need-url';
      st.err = 'getDanmuInfo code=' + ((body && body.code) || '?');
      return undefined;
    }
    const token = body.data.token;
    const host = body.data.host_list[0];
    const buvid = (document.cookie.match(/buvid3=([^;]+)/) || [])[1] || '';
    const url = 'wss://' + host.host + ':' + (host.wss_port || 443) + '/sub';
    st.state = 'connecting';

    let ws;
    try { ws = new WebSocket(url); } catch (e) { st.state = 'error'; st.err = 'WS 建立失败'; return scheduleRetry(); }
    ws.binaryType = 'arraybuffer';
    st.ws = ws;

    ws.onopen = () => {
      st.retry = 0;
      st.state = 'open';
      st.err = '';
      ws.send(packet(7, {
        uid: 0, roomid: st.roomId, protover: 3, buvid,
        support_ack: true, queue_uuid: Math.random().toString(36).slice(2, 10),
        scene: 'room', platform: 'web', type: 2, key: token,
      }));
      clearHb();
      st.hb = setInterval(() => { try { ws.send(packet(2)); } catch (e) { /* 忽略 */ } }, 30000);
    };
    ws.onmessage = (ev) => {
      st.received++;
      try { st.frames.push(toB64(ev.data)); } catch (e) { /* 忽略坏帧 */ }
    };
    ws.onerror = () => { st.err = 'websocket error'; };
    ws.onclose = (ev) => {
      clearHb();
      if (st.closed) return;
      st.state = 'closed';
      st.err = 'close code=' + (ev && ev.code);
      scheduleRetry();
    };
    return undefined;
  };

  window[KEY] = {
    start: (signUrl, roomId) => {
      st.closed = false;
      st.roomId = roomId;
      st.signUrl = signUrl;
      st.retry = 0;
      connect();
    },
    setUrl: (signUrl) => {
      st.signUrl = signUrl;
      st.retry = 0;
      st.state = 'connecting';
      if (st.timer) clearTimeout(st.timer);
      connect();
    },
    stop: () => {
      st.closed = true;
      clearHb();
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      try { if (st.ws) st.ws.close(); } catch (e) { /* 忽略 */ }
      st.ws = null;
      st.state = 'stopped';
    },
    drain: () => { const f = st.frames; st.frames = []; return f; },
    snapshot: () => ({ state: st.state, err: st.err, received: st.received }),
  };
  return KEY;
}

module.exports = { BrowserDanmakuChannel };
