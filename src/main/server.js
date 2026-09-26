/**
 * 本地 HTTP 服务：控制台 + 播放器页 + 歌词叠加层 + SSE 状态流 + 流代理
 * =========================================================================
 * 为什么需要流代理（两个都必须）：
 *   1) B站音频 403 防盗链 —— 实测不带 `Referer: https://www.bilibili.com` 直接 403，
 *      代理在这里注入 Referer/UA（Chromium 的 <audio> 无法自定义请求头）。
 *   2) 本地文件 —— 走 http 而非 file://，才能受控支持 Range（拖动进度）。
 *
 * SSE 而非 WebSocket：贴状态是单向高频的，SSE 用原生 http 就能做，**零依赖**。
 * 叠加层拿到 {position, serverTime, rate} 后自行用 rAF 插值，60fps 平滑，
 * 避免把 10Hz 的网络抖动直接抖到歌词上。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 页面 CSP —— **专门用来挡住"劫持式脚本注入"**（2026-09-26 加）。
 *
 * 背景（实测踩到）：装了 AdGuard 之类的过滤软件后，它会往我们页面的 `<head>`
 * 里**注入一个外站 `<script>`**（`//injections.adguard.org?...&type=user-script`）。
 * 那个域名在部分网络下**不可达** —— 而 `<script src>` 是**阻塞解析**的，
 * 于是页面会长时间停在 `readyState: loading`、**连 `<body>` 都建不出来**。
 * 实测阻塞 **20 秒**才超时放行；这期间界面/图片全是坏的，用户只会以为程序坏了。
 *
 * `script-src 'self'` 让浏览器**根本不去请求**那个外站脚本（同时拒绝执行），
 * 解析立刻继续 → 页面秒开。顺带也封掉了其它第三方脚本注入。
 *
 * 各指令都是照着我们实际用的资源开放的，别随手放宽：
 *   · script  'self'              —— 只有 /assets 与 /shared 下自己的脚本
 *   · style   'self' 'unsafe-inline' —— 页面里有 <style> 块和大量 style="..." 属性
 *   · img     'self' data: http: https: —— 本地封面走自身；网易云/B站封面，
 *                                    扫码二维码来自 api.qrserver.com
 *                                    （B站返回的封面可能是 http://，所以 img 也要放行 http）
 *   · media   'self' http: https: blob: —— <audio> 既播自身的 /stream/*，也播网易云直链
 *                                （**网易云音频直链是 http://**，只写 https: 会被浏览器拒播：
 *                                  MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check）
 *   · connect 'self'              —— fetch / SSE 全部同源
 */
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: http: https:",
  "media-src 'self' http: https: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * 把上面这份策略**以 `<meta>` 形式注入页面 `<head>`**（紧跟 `<head>` 之后，
 * 保证出现在所有 `<script>` 之前 —— CSP 只对出现在它之后的内容生效）。
 *
 * 为什么 header 之外还要一份 meta：AdGuard 这类本机过滤软件会**改写我们响应头
 * 里的 CSP**（实测它往每条指令里塞 `injections.adguard.org`），header 那份等于
 * 被废掉；而页面里的 meta 它不改写。
 *
 * 由 CSP_POLICY 生成、而不是在三个 HTML 里各抄一份：这样策略只有一处定义，
 * 不会出现"改了一处忘了另一处"。**实测踩到过**：meta 曾经被手写在 `<title>` 里，
 * 而 `<title>` 是 RCDATA 元素 —— 里面的注释和 `<meta>` 全按纯文本处理，
 * CSP 完全没生效，窗口标题还变成了那一整段注释（1150 个字符）。
 */
function injectCspMeta(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP_POLICY}">`;
  // 写成 /<head(\s[^>]*)?>/ 而不是 /<head([^>]*)>/：后者会把页面里的 `<header>`
  // 也匹配上（多出来的 `er` 被 [^>]* 吃掉），元标签就插到 `<header>` 后面去了。
  return html.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}\n${meta}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wma': 'audio/x-ms-wma',
};

class AppServer {
  /**
   * @param {{port?:number, host?:string, rendererDir:string, getState:Function,
   *          getLyrics?:Function, onCommand:Function, log?:Function}} opts
   */
  constructor(opts) {
    this.port = opts.port ?? 37821;
    this.host = opts.host || '127.0.0.1';
    this.rendererDir = opts.rendererDir;
    this.sharedDir = opts.sharedDir || path.join(opts.rendererDir, '..', 'shared');
    this.getState = opts.getState;
    this.getLyrics = opts.getLyrics || null;
    /**
     * 新客户端接入 SSE 时用来**补发当前叠加层配置**。
     *
     * 为什么必须补（2026-09-26 修，用户报告"改了主题不生效、重启也一样"）：
     * 配置只在**变化时**广播，而直播姬的浏览器源 / 预览窗是**随时接入**的
     * （刷新页面、重开场景、重启程序后再刷新）。不补发的话，新接入的页面
     * 用的是**内置默认值**（theme=scroll、翻译=开），于是
     * "我明明选了卡拉OK，它还是双语"、"重启了还是这样"。
     * 与下面补发歌词 / 播放指令是同一个道理。
     */
    this.getConfig = opts.getConfig || null;
    this.onCommand = opts.onCommand;
    // 封面/静态文件的可读根目录（每次请求时求值，这样用户改本地曲库目录后立即生效）
    this.allowRootsProvider = opts.allowRootsProvider || null;
    /**
     * 新客户端接入 SSE 时，用来补发"当前播放指令"。
     * 没有它的话，晚一步连上的播放核心窗会永远收不到 play（详见 _sse 里的注释）。
     */
    this.resumeProvider = opts.resumeProvider || null;
    this.allowRoots = opts.allowRoots || [];
    this.log = opts.log || (() => {});
    this.clients = new Set(); // SSE 连接
    /**
     * 运行日志总线（可选）。给了它，`/logs` 页面就能实时看到主进程日志 ——
     * 打包成 exe 后没有控制台，这是用户唯一能自查的手段（见 logbus.js 的说明）。
     * 只有明确要日志的 SSE 连接（`/events?logs=1`）才会收到 log 消息，
     * 免得给控制台/叠加层/播放核心白推一堆无关流量。
     */
    this.logBus = opts.logBus || null;
    this.logClients = new Set();
    if (this.logBus && typeof this.logBus.onLine === 'function') {
      this.logBus.onLine((line) => {
        if (!this.logClients.size) return;
        const payload = `data: ${JSON.stringify({ type: 'log', ...line })}\n\n`;
        for (const res of this.logClients) {
          try { res.write(payload); } catch { /* 断开的连接由 close 事件清理 */ }
        }
      });
    }
    this.server = null;
    this.boundPort = null;
    /** 静态资源的版本戳（见 _computeAssetRev）：SSE 建连时发给页面，页面据此判断自己是不是旧货 */
    this.assetRev = this._computeAssetRev();
  }

  /**
   * 静态资源（叠加层 / 控制台 / 播放核心的页面与脚本）的**版本戳** = 最新修改时间。
   *
   * 为什么需要它：**直播姬的浏览器源会一直挂着那个页面**，我们升级 exe、重启程序，
   * 它都不会自己重载 —— 于是直播姬里跑的还是升级前的 JS。
   * 表现极具误导性："新版本明明修好了，直播姬里还是老行为"，用户会怀疑修复没生效
   * （2026-09-26 实测踩到：信息卡片的显示开关在新版里改完即时生效，
   * 但直播姬里那个挂了很久的源纹丝不动）。
   *
   * 所以把版本戳随 SSE 的 `hello` 消息发给页面，页面发现"和刚连上时不一样了"
   * 就**在空闲时段自行重载**（见 overlay.js 的 scheduleReload）。
   */
  _computeAssetRev() {
    let rev = 0;
    const walk = (dir) => {
      if (!dir) return;
      let list = [];
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        try { rev = Math.max(rev, fs.statSync(p).mtimeMs); } catch { /* 读不到就算了 */ }
      }
    };
    walk(this.rendererDir);
    walk(this.sharedDir);
    return String(Math.round(rev));
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._route(req, res).catch((e) => {
        this.log('[server] 处理失败', e && e.message);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('internal error: ' + (e && e.message));
      }));

      let settled = false;
      /**
       * **必须用 `server.address().port`，不能用"这次尝试的端口号"。**
       *
       * 踩过（2026-09-26）：首选端口被占用时（例如用户自己已经开着一个 NekoFM），
       * 我们会依次试 37822、37823；而**每次 `listen()` 都会注册一个 once('listening') 回调**，
       * 真正绑成功那一刻，**之前那些失败尝试的回调会被一并唤起**（用的是各自闭包里那个没绑上的端口号）。
       * 于是 `resolve(port)` 出去的是**最先那个（被占用的）端口**：
       *   · `engine.serverBase` 指向**别人的进程** → 取流地址、封面地址、歌词代理全打错端口；
       *   · 内置测试中心也拿这个 base 发请求 → 测试打到别的实例上（表现为莫名其妙的 403：
       *     实测就是"打开本地文件后白名单没放行"，其实是在测另一个进程的白名单）。
       * `address().port` 是"真的绑到哪个端口"的唯一可信来源，跟尝试顺序无关。
       */
      this.server.on('listening', () => {
        if (settled) return;
        const addr = this.server.address();
        const actual = addr && addr.port;
        if (!actual) return;
        settled = true;
        this.boundPort = actual;
        this.log(`[server] 已启动 http://${this.host}:${actual}`);
        resolve(actual);
      });

      const tryListen = (port, attempt = 0) => {
        this.server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && attempt < 10) {
            this.log(`[server] 端口 ${port} 被占用，试 ${port + 1}`);
            tryListen(port + 1, attempt + 1);
          } else reject(err);
        });
        this.server.listen(port, this.host);
      };
      tryListen(this.port);
    });
  }

  stop() {
    for (const c of this.clients) { try { c.end(); } catch { /* 忽略 */ } }
    this.clients.clear();
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  get baseUrl() { return `http://${this.host}:${this.boundPort || this.port}`; }

  /** 广播状态（10Hz 调用，SSE 天然合流） */
  broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of this.clients) {
      try { c.write(data); } catch { this.clients.delete(c); }
    }
  }

  // ------------------------------------------------------------------ 路由
  async _route(req, res) {
    const u = new URL(req.url, this.baseUrl);
    const p = u.pathname;

    if (p === '/events') return this._sse(req, res);
    if (p === '/api/state') return this._json(res, this.getState());
    /**
     * 运行日志（供 /logs 窗口回填 + 断线续传）。
     * `afterSeq` 只取更新的那批：窗口 SSE 重连时不会把整屏日志再刷一遍。
     */
    if (p === '/api/logs') {
      if (!this.logBus) return this._json(res, { ok: false, msg: '日志总线未启用', lines: [] });
      return this._json(res, {
        ...this.logBus.recent({
          limit: Number(u.searchParams.get('limit')) || 0,
          afterSeq: Number(u.searchParams.get('afterSeq')) || 0,
        }),
        /** 落盘路径（窗口里显示出来，"把日志发给别人"时用户要能找到它） */
        file: this.logBus.filePath || '',
      });
    }
    if (p === '/api/lyrics') return this._json(res, this.getLyrics ? this.getLyrics() : { type: 'lyrics', rev: 0, timeline: { meta: {}, lines: [] } });
    if (p === '/api/command' && req.method === 'POST') return this._command(req, res);
    if (p === '/stream/local') return this._streamLocal(u, req, res);
    if (p === '/stream/bili') return this._streamBili(u, req, res);
    if (p === '/stream/cover') return this._serveCover(u, req, res);
    if (p === '/stream/img') return this._streamImage(u, req, res);

    // 静态页
    const map = { '/': 'control.html', '/player': 'player.html', '/overlay': 'overlay.html', '/logs': 'logs.html', '/candidates': 'candidates.html' };
    if (map[p]) return this._file(res, path.join(this.rendererDir, map[p]));
    if (p.startsWith('/assets/')) {
      const rel = p.slice('/assets/'.length).replace(/\.\./g, '');
      return this._file(res, path.join(this.rendererDir, 'assets', rel));
    }
    // 共享模块（Node 与浏览器加载同一份实现）
    if (p.startsWith('/shared/')) {
      const rel = p.slice('/shared/'.length).replace(/\.\./g, '');
      return this._file(res, path.join(this.sharedDir, rel));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }

  _json(res, obj, code = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  }

  _file(res, file) {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(file).toLowerCase();
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      let body = buf;
      // HTML 页面：响应头给一份 CSP，页面里再注入一份 meta（见 CSP_POLICY 与
      // injectCspMeta 的说明 —— 有 AdGuard 时只有 meta 那份真的管用）。
      // 注入后长度变了，但这里本来就没设 Content-Length，交给 Node 自己算。
      if (ext === '.html') {
        headers['Content-Security-Policy'] = CSP_POLICY;
        body = Buffer.from(injectCspMeta(buf.toString('utf8')), 'utf8');
      }
      res.writeHead(200, headers);
      res.end(body);
    });
  }

  _sse(req, res) {
    const u = new URL(req.url, this.baseUrl);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 1000\n\n');
    /**
     * 第一件事：报上自己的资源版本戳。
     * 直播姬里挂了很久的浏览器源靠它发现"资源变了、我该重载了"
     * （页面自己不会重载，见 _computeAssetRev 的说明）。
     */
    res.write(`data: ${JSON.stringify({ type: 'hello', rev: this.assetRev })}\n\n`);
    res.write(`data: ${JSON.stringify(this.getState())}\n\n`);
    // 客户端可能在任何时刻接入（直播姬浏览器源刷新、OBS 场景重载、
    // 页面手动刷新），而歌词只在"变化时"才广播 —— 所以必须在这里补发当前歌词，
    // 否则后接入的叠加层会一直空白，直到下一首歌才恢复。
    if (this.getLyrics) {
      try { res.write(`data: ${JSON.stringify(this.getLyrics())}\n\n`); } catch { /* 忽略 */ }
    }
    /**
     * 补发当前叠加层配置。**必须在建连时就发**：
     * 配置平时只在"有人改设置"时广播一次，而页面是随时接入的 ——
     * 不补发的话，晚接入的叠加层会一直按**内置默认值**渲染。
     * 表现就是"我选了卡拉OK，它还是双语；重启了也一样"（用户报告）。
     */
    if (this.getConfig) {
      try {
        const overlay = this.getConfig();
        if (overlay) res.write(`data: ${JSON.stringify({ type: 'config', overlay })}\n\n`);
      } catch { /* 忽略 */ }
    }
    // ---------------------------------------------------------------
    // 补发当前播放指令。**这条非常关键**：
    // play 指令只在"载入曲目"那一刻广播一次，而播放核心窗的 SSE
    // 完全可能晚一步才连上（启动较慢、窗口重建、页面刷新）——
    // 那样它就永远收不到 play，表现为"引擎显示在播放，但一点声音都没有"，
    // 而且引擎状态会一直卡在 loading。实测踩过，排查了很久。
    // 补发之后，无论播放核心何时接入，都能对齐到当前曲目与进度。
    if (this.resumeProvider) {
      try {
        const rp = this.resumeProvider();
        if (rp) res.write(`data: ${JSON.stringify({ type: 'player', ...rp })}\n\n`);
      } catch { /* 忽略 */ }
    }
    this.clients.add(res);
    /**
     * `/events?logs=1` → 这个连接还要收运行日志（只有「运行日志」窗口会这么连）。
     * 单独一册，不跟状态广播混在一起：控制台/叠加层/播放核心不需要这些流量。
     */
    if (this.logBus && u.searchParams.get('logs') === '1') this.logClients.add(res);
    const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 忽略 */ } }, 15000);
    req.on('close', () => {
      clearInterval(keep);
      this.clients.delete(res);
      this.logClients.delete(res);
    });
  }

  _readBody(req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
      });
    });
  }

  async _command(req, res) {
    const body = await this._readBody(req);
    try {
      const out = await this.onCommand(body);
      this._json(res, { ok: true, result: out });
    } catch (e) {
      this._json(res, { ok: false, error: String((e && e.message) || e) }, 500);
    }
  }

  // ------------------------------------------------------------ 本地文件流
  /**
   * 提供本地音频文件（支持 Range，用于拖动进度）。
   *
   * **安全约束**：必须落在白名单内（曲库目录 / 用户显式打开的文件 / 封面缓存目录）。
   * 之前这里只检查"文件存在"，等于把 `/stream/local?path=` 做成了任意文件读取 ——
   * 虽然只监听回环地址，但直播机上的任何本地网页都能拿它探文件。
   * 现在与封面接口用同一份白名单，口径一致。
   */
  _streamLocal(u, req, res) {
    const file = u.searchParams.get('path');
    if (!file) { res.writeHead(400); return res.end('missing path'); }

    const roots = (this.allowRootsProvider ? this.allowRootsProvider() : this.allowRoots)
      .filter(Boolean).map((r) => path.resolve(r));
    // fail-closed：只要**配置了**白名单来源（哪怕当前是空的），就必须校验。
    // 否则"白名单为空 → 放行一切"会变成一个静默的安全缺口
    // （e2e 里就是因为没接 provider 而被子检查抓出来）。
    const enforced = !!this.allowRootsProvider || (this.allowRoots || []).length > 0;
    if (enforced) {
      const abs = path.resolve(file);
      // 允许"等于某个白名单项"（单文件）或"位于某个白名单目录下"（目录）
      const inside = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
      if (!inside) {
        this.log('[server] 拒绝越界的本地文件请求:', abs);
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('forbidden: not in media allowlist');
      }
    }
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('file not found'); }
    const stat = fs.statSync(file);
    if (!stat.isFile()) { res.writeHead(404); return res.end('not a file'); }
    const type = AUDIO_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(file).pipe(res);
    }
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  }

  // ------------------------------------------------------------ 本地封面
  /**
   * 提供本地封面图片。
   * **安全约束**：只允许读 allowRoots 白名单内的文件（本地曲库目录 + 封面缓存目录），
   * 且必须是图片后缀。否则 /stream/cover?path= 就变成了任意文件读取漏洞 ——
   * 这个服务虽然只监听回环地址，但直播机上的任何网页都能访问它。
   */
  _serveCover(u, req, res) {
    const file = u.searchParams.get('path');
    if (!file) { res.writeHead(400); return res.end('missing path'); }
    if (!/\.(jpe?g|png|webp|gif|bmp)$/i.test(file)) { res.writeHead(400); return res.end('not an image'); }

    const roots = (this.allowRootsProvider ? this.allowRootsProvider() : this.allowRoots)
      .filter(Boolean).map((r) => path.resolve(r));
    const enforced = !!this.allowRootsProvider || (this.allowRoots || []).length > 0;
    if (enforced) {
      const abs = path.resolve(file);
      const inside = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
      if (!inside) {
        this.log('[server] 拒绝越界的封面请求:', abs);
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('forbidden');
      }
    }
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('cover not found'); }

    const type = MIME[path.extname(file).toLowerCase()] || 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600', 'Access-Control-Allow-Origin': '*' });
    fs.createReadStream(file).pipe(res);
  }

  // ------------------------------------------------------ 远端图片代理
  /**
   * 把远端封面图（主要是 B站 hdslb.com）经本地转发一次。
   *
   * 为什么不让 <img> 直接加载远端图：
   *   实测过 hdslb 的封面在 Playwright 环境里 **11ms 内直接失败**（而网易云封面正常），
   *   属于客户端网络/策略差异，不是图片本身的问题（服务端 fetch 同一 URL 返回 200 正常图片）。
   *   直播机上的浏览器（Electron / 直播姬内置 CEF）配置各异，赌客户端能连不如自己转发，
   *   顺带还能限制体积、统一 Content-Type。
   */
  async _streamImage(u, req, res) {
    const target = u.searchParams.get('url');
    if (!target || !/^https?:\/\//.test(target)) { res.writeHead(400); return res.end('bad url'); }

    const headers = { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com/' };
    try {
      const upstream = await fetch(target, { headers, redirect: 'follow' });
      if (!upstream.ok) { res.writeHead(502); return res.end('upstream ' + upstream.status); }
      const type = upstream.headers.get('content-type') || '';
      if (!/^image\//.test(type)) { res.writeHead(415); return res.end('not an image: ' + type); }

      const buf = Buffer.from(await upstream.arrayBuffer());
      // 封面没必要原图：>2MB 的直接不发（避免叠层卡顿），让前端显示占位
      if (buf.length > 2 * 1024 * 1024) { res.writeHead(413); return res.end('image too large'); }

      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': buf.length,
        'Cache-Control': 'max-age=600',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(buf);
    } catch (e) {
      this.log('[server] 图片代理失败', e.message);
      if (!res.headersSent) res.writeHead(502);
      res.end('proxy error: ' + e.message);
    }
  }

  // ------------------------------------------------------ B站音频流代理
  /**
   * 把 B站 DASH 音频地址透传给 <audio>，并注入防盗链所需的 Referer/UA。
   * 支持 Range 透传（拖动进度必需）。**不落盘、不缓存**，只做头注入与转发。
   */
  async _streamBili(u, req, res) {
    const target = u.searchParams.get('url');
    if (!target || !/^https?:\/\//.test(target)) { res.writeHead(400); return res.end('bad url'); }

    const headers = {
      'User-Agent': BILI_UA,
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
    };
    if (req.headers.range) headers.Range = req.headers.range;

    try {
      const upstream = await fetch(target, { headers, redirect: 'follow' });
      const pass = {
        'Content-Type': upstream.headers.get('content-type') || 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      };
      const len = upstream.headers.get('content-length');
      const cr = upstream.headers.get('content-range');
      if (len) pass['Content-Length'] = len;
      if (cr) pass['Content-Range'] = cr;
      res.writeHead(upstream.status, pass);
      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
        }
        res.end();
      };
      req.on('close', () => { try { reader.cancel(); } catch { /* 忽略 */ } });
      await pump();
    } catch (e) {
      this.log('[server] bili 代理失败', e.message);
      if (!res.headersSent) res.writeHead(502);
      res.end('proxy error: ' + e.message);
    }
  }
}

module.exports = { AppServer, BILI_UA, CSP_POLICY, injectCspMeta };
