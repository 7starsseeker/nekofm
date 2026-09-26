/**
 * 网易云音乐客户端
 * =================
 * 设计原则（基于 2026-09-25 活体实测）：
 *   - 优先走老版免加密 `/api/` 端点：实测搜索、歌单、歌词、直链均可用，最省事；
 *   - 需要登录态的能力（会员曲直链、我的歌单、扫码登录）走 weapi 加密；
 *   - cookie 由调用方托管（可来自扫码登录、也可由用户手工粘贴），本模块只管带上；
 *   - 所有网络错误不抛出即崩塌，统一以 {ok:false, code, msg} 返回，便于上层降级。
 *
 * 实测要点：
 *   - `/api/song/lyric` 的 klyric/yrc 恒为空 → 逐字必须用 `/api/song/lyric/v1?...&yv=-1&ytv=-1&yrv=-1`
 *   - `fee=1`（VIP曲）免登录只给 **45 秒试听**（ffprobe 实测），必须带 MUSIC_U；`fee=8` 免登录即给完整 320k
 *   - 登录类接口（qrcode/unikey、client/login、user/playlist）必须走 **eapi**：摘要按 `/api/...` 算，请求发到 `/eapi/...`
 */
'use strict';

const { weapi, eapi, eapiDecrypt } = require('./weapi');
const crypto = require('node:crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE = 'https://music.163.com';
const BASE_IF3 = 'https://interface3.music.163.com';

/**
 * 由 picId 反推封面 URL。
 * =====================
 * 为什么需要它：**搜索接口只给 `album.picId`，不给 `picUrl`**
 * （只有 /api/song/detail 才带 picUrl），所以只靠搜索结果的歌曲封面全是空的。
 * 网易云图片路径里那一段是 picId 与固定 magic 异或后取 MD5 的 base64，
 * 本实现已用已知样本对齐 `/api/song/detail` 返回的 picUrl（逐字符一致）。
 */
const PIC_MAGIC = '3go8&$8*3*3h0k(2)2';
function encryptedPicId(picId) {
  const s = String(picId);
  let str = '';
  for (let i = 0; i < s.length; i++) {
    str += String.fromCharCode(s.charCodeAt(i) ^ PIC_MAGIC.charCodeAt(i % PIC_MAGIC.length));
  }
  return crypto.createHash('md5').update(str, 'binary').digest('base64')
    .replace(/\//g, '_').replace(/\+/g, '-');
}
/**
 * 修复"朴素拼出来的"网易云封面 URL（2026-09-26 加）。
 *
 * 正确的第一段是 picId 异或+MD5 的 hash（含字母/等号/下划线）：
 *   对：`https://p1.music.126.net/LrI3nInqXaMv8yjPGD2BeQ==/109951165227114420.jpg`
 *   错：`https://p1.music.126.net/109951165227114420/109951165227114420.jpg` ← **404**
 * 浏览器通道早期版本就是朴素拼的，把这种坏 URL 写进了 config（savedPlaylist 等）。
 * 这里按**格式特征**识别（第一段是纯数字、且与第二段完全相同 ——
 * 真 hash 不可能长这样）并就地修好，用户的历史数据不用手改。
 *
 * @param {string} url 可能是坏的封面 URL
 * @returns {string} 修好的 URL（不像坏的就原样返回）
 */
function repairNeteaseCover(url) {
  const s = String(url || '');
  //  反向引用：要求两段完全相同，避免误伤正常的 hash 路径
  const m = /^https?:\/\/p1\.music\.126\.net\/(\d+)\/(\d+)\.jpg(\?param=(\d+)y\d+)?$/i.exec(s);
  // 真 hash 不会是「纯数字且与第二段完全相同」，所以按这个特征识别坏 URL
  if (!m || m[1] !== m[2]) return s;
  const size = m[4] ? Number(m[4]) : undefined;
  return neteasePicUrl(m[1], size);
}

/** @param {number|string} picId @param {number} [size] 要几像素的方图（可选，减小体积） */
function neteasePicUrl(picId, size) {
  if (!picId) return '';
  const enc = encryptedPicId(picId);
  return `https://p1.music.126.net/${enc}/${picId}.jpg` + (size ? `?param=${size}y${size}` : '');
}

/**
 * 解析网易云返回的 JSON，**保住超出 JS 安全整数范围的大整数**（2026-09-26 加）。
 * ============================================================================
 * 为什么非做不可（实测踩到，"耀斑"封面裂就是这条）：
 *   封面路径的第二段就是 picId 本身，第一段是 `picId` 异或 magic 后取 MD5 ——
 *   **只要 picId 错一位，整条 URL 就废**。而 picId 长这样：
 *       `109951171396677694`   ← 约 1.1e17，**超过 Number.MAX_SAFE_INTEGER（约 9e15）**
 *   `JSON.parse` 只能把它舍入成 `109951171396677700`（差 6），于是：
 *       权威 URL：p3…/DYDACa_8zB5irAOrasVgnQ==/109951171396677694.jpg → **HTTP 200**
 *       我们算的：p1…/9Ck9Wop8wLRTzt9VTqRehA==/109951171396677700.jpg → **HTTP 400**
 *   （顺带验证过：p1/p2/p3/p4 四个主机名都能 200，**错的只有那 6 个数字**。）
 *
 * 修法：用 `JSON.parse` 的**源文本访问**（`reviver` 第三个参数 `ctx.source`）
 * 拿回原始数字文本，仅对"整数且超过安全范围"的值返回**字符串**，
 * 其余一律原样 —— 所以只有 picId 这类字段类型从 number 变 string，
 * 而 `neteasePicUrl`/`encryptedPicId` 本来就是 `String(picId)`，天然兼容。
 * 老引擎没有 `ctx` 时自动退化为旧行为（拿不到精确值，但不会抛错）。
 *
 * @param {string} text 原始 JSON 文本（**不要先在别处 JSON.parse**，否则精度已经丢了）
 */
function parseJsonExact(text) {
  return JSON.parse(text, function reviver(key, value, ctx) {
    if (typeof value === 'number' && Number.isInteger(value)
      && Math.abs(value) > Number.MAX_SAFE_INTEGER
      && ctx && typeof ctx.source === 'string') {
      return ctx.source;
    }
    return value;
  });
}

/** 极简 cookie 罐：够用且可持久化 */
class CookieJar {
  constructor(str = '') {
    this.map = new Map();
    if (str) this.setFromString(str);
  }
  setFromString(str) {
    for (const part of String(str).split(';')) {
      const i = part.indexOf('=');
      if (i > 0) this.map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  absorbSetCookie(list) {
    for (const raw of list || []) {
      const first = String(raw).split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) this.map.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
    }
  }
  toString() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(key) { return this.map.get(key); }
  has(key) { return this.map.has(key); }
  toJSON() { return Object.fromEntries(this.map); }
}

class NeteaseClient {
  /**
   * @param {{cookie?:string, timeout?:number, log?:(...a:any[])=>void}} [opts]
   */
  constructor(opts = {}) {
    this.jar = new CookieJar(opts.cookie || '');
    /**
     * 单次请求超时（2026-09-26 从 15s 降到 8s）。
     *
     * 为什么调短：用户的真实场景里 `resolveLyrics` 会跑 2 次搜索（标题+歌手 → 标题），
     * 串起来 + 节流就是 30s+。15s × 2 = 30s，单是这一项就能解释"等了一分多钟"。
     * 8s 留得住慢网络（实测网易云搜索 99% 在 1-2s 内返回），同时给"卡"画了硬上限。
     * 真要更慢的环境可用构造参数 `timeout` 调大，**不要**把全局默认再往上抬。
     */
    this.timeout = opts.timeout || 8000;
    this.log = opts.log || (() => {});
    /**
     * 浏览器通道（2026-09-26 上线路径）。
     *
     * 主路径走它 —— 老点歌机（danmu-music / CefSharp）的核心思路，借
     * music.163.com 真浏览器 session 取数，服务端不当作脚本客户端。
     * 直连 fetch 仅作为 fallback（浏览器通道失败或未配置时）。
     *
     * 覆盖的读接口：search / lyric / songDetail / playlist / songUrl / account。
     * 浏览器通道**不做节流**（见 `_fetch` 顶部注释里的两条路分工）。
     */
    this.browser = opts.browser || null;
    // 默认兜一个游客 buvid，减少风控概率
    if (!this.jar.has('os')) {
      this.jar.setFromString('os=pc; appver=2.10.6; osver=; deviceId=nekofm');
    }
  }

  get cookie() { return this.jar.toString(); }
  set cookie(v) { this.jar.setFromString(v); }
  get isLoggedIn() { return this.jar.has('MUSIC_U'); }

  /**
   * 底层请求：自动吸收 set-cookie、自动带 Referer。
   *
   * 限流重试：实测密集请求会收到 `code:405 "操作频繁，请稍候再试"`
   * （直播场景点歌密集、歌单一拉 200 首，很容易撞上；实测裸请求直接 405）。
   * 只对 405/429 做带退避的自动重试（最多 3 次），其余错误立即返回 ——
   * 不给"重试放大问题"留机会。
   */
  async _fetch(url, { method = 'GET', body, headers = {}, raw = false, retries = 2, signal = null } = {}) {
    /**
     * ⚠️ 这里是**直连兜底路径**，节流/熔断只对它生效。
     *
     * 两条路的分工（2026-09-26 确立，**别给浏览器通道也加节流**）：
     *
     *   ┌ 浏览器通道（主路径，src/main/sources/netease-browser.js）
     *   │   · 借 music.163.com 的真浏览器 session 发请求（真 deviceId / WebGL /
     *   │     易盾脚本），服务端当正常用户看待，不会按"脚本客户端"判 405
     *   │   · **刻意不做任何节流/冷却** —— 那只会给用户白加延迟。
     *   │     用户要求"播放器这边必须实时反应"，就靠这条
     *   │   · 它的超时保护在 browserFetch 里（页面侧 8s + 主进程侧 10s），
     *   │     那是**防卡死**，不是限流
     *   └ 直连 fetch（兜底：浏览器通道不可用/失败时）
     *       · 会被网易云按突发速率 405，所以这里才需要节流 + 冷却熔断
     *
     * 判定原则：**只有真的在向网易云直连发请求时才做限流保护**。
     * 本地文件、已缓存音频、已缓存歌词都不产生网络请求，自然也不受限流影响
     * （engine.resolveStream / resolveLyrics 都是"先查盘、命中即返回"）。
     */
    /**
     * 限流熔断。
     *
     * **踩过的坑**：原来命中 405「操作频繁」还会重试 3 次 ——
     * 等于对着一句"你太快了"连打 4 次，只会把限流窗口越推越长。
     * 别的点歌机不那么容易被限流，很大一个原因就是它们撞上 405 会**停下来**。
     * 现在：命中限流就进入冷却期，期间所有请求直接短路（一个包都不发），
     * 冷却时长逐次加倍：60s → 120s → 240s，上限 10 分钟。
     */
    if (this._coolUntil && Date.now() < this._coolUntil) {
      const left = Math.ceil((this._coolUntil - Date.now()) / 1000);
      return { ok: false, code: 405, msg: `被网易云限流，冷却中（还有 ${left} 秒）` };
    }

    /**
     * 全局节流（2026-09-26 升级）：**任何**请求都要至少间隔 450ms。
     *
     * 早期只在 `search()` 里做节流，结果 `load()` 的 `Promise.all([songUrl, lyric])`
     * 会让两个请求在同一毫秒出去——点歌刚完、下一首开始加载就触发限流。
     * 现在抬到 `_fetch()` 顶部，所有路径共享同一把锁：
     *   - search / songUrl / lyric / playlist / songDetail / 扫码 / 账号
     *   - 重试时也走这里（`for` 循环外的 await → _lastReqAt 在 _fetch 入口一次性写好，
     *     循环内的 retry 复用同一把锁；重试间隔另算见末尾 sleepMs）
     * 节流间隙仍保持 450ms：实测安全阈值是 400ms，留 50ms 余量。
     */
    const gap = 450;
    const wait = this._lastReqAt ? (this._lastReqAt + gap - Date.now()) : 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastReqAt = Date.now();

    const h = {
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      Origin: 'https://music.163.com',
      Cookie: this.jar.toString(),
      ...headers,
    };
    if (body && !h['Content-Type']) h['Content-Type'] = 'application/x-www-form-urlencoded';

    /**
     * 可中断（2026-09-26）。
     *
     * 用户明确要求："播放的时候如果还在缓存没出来的话有后续新的输入就中断
     * 当前任务响应后续操作 —— 这个是本地控制，一定要实时响应"。
     *
     * 所以这里接受一个外部 `signal`（engine 每次 load 会建一个新的
     * AbortController，开新 load 前 abort 掉旧的）。它和内部超时**合成**到
     * 同一个 AbortController 上，任一触发都真的掐掉 TCP 请求 ——
     * 不只是"忽略结果"，而是**把连接释放掉**，否则旧请求会一直占着浏览器的
     * 连接池（同一 host 只有 6 条），新操作就排不进去。
     *
     * 默认取 `this.currentSignal`，由 engine 在每次载入前设置，
     * 这样每个 public 方法都不用改签名就能被中断。
     */
    const ext = signal || this.currentSignal || null;
    if (ext && ext.aborted) return { ok: false, code: -4, msg: '已取消（被更新的操作打断）' };

    let last = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeout);
      // 外部中断 → 一并掐掉内部控制器
      const onAbort = () => { try { ac.abort(); } catch { /* 忽略 */ } };
      if (ext) ext.addEventListener('abort', onAbort, { once: true });
      let again = false;
      let sleepMs = 0;
      try {
        const res = await fetch(url, { method, headers: h, body, signal: ac.signal });
        const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        this.jar.absorbSetCookie(setCookies);
        if (raw) return res;

        const text = await res.text();
        if (!text) {
          last = { ok: false, code: -1, msg: 'empty body' };
        } else {
          let parsed = null;
          try { parsed = parseJsonExact(text); } catch {
            try { parsed = parseJsonExact(eapiDecrypt(text)); } catch { parsed = null; }
          }
          if (!parsed) {
            last = { ok: false, code: -2, msg: 'non-json response', text: text.slice(0, 200) };
          } else {
            const limited = parsed.code === 405 || res.status === 429
              || /操作频繁|请稍候|过于频繁|too many/i.test(String(parsed.message || parsed.msg || ''));
            if (limited) {
              // **绝不对限流做重试** —— 那是放大器，不是补救。
              // 直接进入冷却期，让后续请求短路，给网易云足够时间放行。
              this._coolHits = (this._coolHits || 0) + 1;
              /**
               * 冷却时长（2026-09-26 调温和）：
               *   - 起步 30s（之前 60s），短一点用户更愿意等
               *   - 递增倍率 1.5x（之前 2x），避免一口气跳到 4-10 分钟
               *   - 上限 240s（之前 600s = 10 分钟），超过这个就该排查了
               *   - 通了立即清零计数，别把偶发限流当惯犯
               * 30 → 45 → 67 → 101 → 151 → 227 → 240（封顶）
               */
              const wait = Math.min(30000 * (1.5 ** (this._coolHits - 1)), 240000);
              this._coolUntil = Date.now() + wait;
              this.log(`[netease] 命中限流 → 冷却 ${Math.round(wait / 1000)}s（第 ${this._coolHits} 次），期间不再发请求`);
              last = {
                ok: false, code: 405,
                msg: `${parsed.message || parsed.msg || '操作频繁'}；已进入冷却 ${Math.round(wait / 1000)} 秒`,
              };
            } else if (parsed.code != null && parsed.code !== 200 && parsed.code !== 0) {
              last = { ok: false, code: parsed.code, msg: parsed.message || parsed.msg || '', data: parsed };
            } else {
              // 通了就清冷却计数：别把偶发的一次限流记成"惯犯"
              this._coolHits = 0;
              return { ok: true, code: parsed.code, data: parsed };
            }
          }
        }
      } catch (e) {
        /**
         * 中断要能被识别出来：AbortError 有两种来源 ——
         *   · 我们自己的超时（算是失败，如实报告）
         *   · 外部 signal（用户又操作了 → "已取消"，不该当成错误刷通知）
         * 这里按 code=-4 区分，上层看到 -4 就安静地放弃。
         */
        const aborted = e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));
        if (aborted && ext && ext.aborted) {
          last = { ok: false, code: -4, msg: '已取消（被更新的操作打断）' };
        } else {
          last = { ok: false, code: aborted ? -5 : -3, msg: aborted ? `请求超时（${this.timeout}ms）` : String((e && e.message) || e) };
        }
      } finally {
        clearTimeout(timer);
        if (ext) ext.removeEventListener('abort', onAbort);
      }
      if (!again) break;
      await new Promise((r) => setTimeout(r, sleepMs));
    }
    return last || { ok: false, code: -1, msg: 'request failed' };
  }

  _qs(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) u.append(k, String(v));
    }
    return u.toString();
  }

  // ---------------------------------------------------------------- 搜索
  /**
   * 搜索。type: 1=单曲 10=专辑 100=歌手 1000=歌单
   * 实测免登录可用（老版 /api/search/get/web）。
   */
  async search(keyword, { type = 1, limit = 20, offset = 0 } = {}) {
    /**
     * 搜索缓存。
     *
     * 为什么必须做：点歌、歌词匹配都会走搜索，重复查询很常见
     * （同一首歌反复点、歌词匹配失败后重试）。每一次都真打接口，
     * 累计请求量很快就顶到限流线 —— 这也是"别的点歌机不轻易被限流"的另一半原因：
     * 它们大多把搜索结果缓存住。
     *
     *  · 缓存：同样的关键词+参数 10 分钟内直接复用（LRU 上限 200 条）
     *  · 节流：抬到 `_fetch()` 顶部（任何请求都要间隔 450ms），这里不再做。
     *    早期版本这里自己做搜索节流，结果 `load()` 的 songUrl/lyric 走另一条路
     *    完全绕开，连点两首就触发限流（2026-09-26 修）。
     *
     * 主路径（2026-09-26 上线）：有 browser 通道就先走它，借 music.163.com 真
     * 浏览器 session 抗限流（实测撑得住 20+ 次 unique）；browser 失败才回退直连。
     */
    const ck = `${type}|${limit}|${offset}|${keyword}`;
    const hit = this._searchCache && this._searchCache.get(ck);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;

    // 主路径：浏览器通道
    if (this.browser && this.browser.available) {
      try {
        const r = await this._raceAbort(this.browser.search(keyword, { type, limit, offset }));
        if (r && r.ok) {
          if (!this._searchCache) this._searchCache = new Map();
          this._searchCache.set(ck, { at: Date.now(), value: r });
          if (this._searchCache.size > 200) this._searchCache.delete(this._searchCache.keys().next().value);
          return r;
        }
        this.log(`[netease] 浏览器通道搜索失败，回退直连：${(r && r.msg) || '未知'}`);
      } catch (e) {
        this.log('[netease] 浏览器通道异常，回退直连：' + e.message);
      }
    }

    // 兜底：直连
    const url = `${BASE}/api/search/get/web?${this._qs({ s: keyword, type, limit, offset })}`;
    const r = await this._fetch(url);
    if (r.ok) {
      const res0 = r.data.result || {};
      const value = { ok: true, songs: (res0.songs || []).map((x) => this._normSong(x)), total: res0.songCount };
      if (!this._searchCache) this._searchCache = new Map();
      this._searchCache.set(ck, { at: Date.now(), value });
      if (this._searchCache.size > 200) this._searchCache.delete(this._searchCache.keys().next().value);
      return value;
    }
    return { ok: false, code: r.code, msg: r.msg, songs: [] };
  }

  /**
   * 把"浏览器通道调用"与外部中断信号赛跑（2026-09-26）。
   *
   * 为什么需要：页面通道（`executeJavaScript`）没法从 Node 侧直接 abort，
   * 但**调用方不该继续等它** —— 用户已经按了新操作。这里在 signal 触发时
   * 立刻返回 `code:-4`，让整条载入链路马上收尾。页面里的请求有自己的 8s
   * AbortController 兜底，会自行结束，不会泄漏。
   *
   * @param {Promise<any>} promise 浏览器通道的调用
   * @returns {Promise<any>}
   */
  _raceAbort(promise) {
    const s = this.currentSignal;
    if (!s) return promise;
    if (s.aborted) return Promise.resolve({ ok: false, code: -4, msg: '已取消（被更新的操作打断）' });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; s.removeEventListener('abort', onAbort); resolve(v); };
      const onAbort = () => finish({ ok: false, code: -4, msg: '已取消（被更新的操作打断）' });
      s.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(finish, (e) => finish({ ok: false, code: -3, msg: String((e && e.message) || e) }));
    });
  }

  /** 当前是否已被外部中断（每个浏览器通道分支前后都该看一眼） */
  get aborted() { return !!(this.currentSignal && this.currentSignal.aborted); }

  /** 冷却剩余秒数（0 = 正常，可发请求） */
  coolLeft() {
    return this._coolUntil && Date.now() < this._coolUntil
      ? Math.ceil((this._coolUntil - Date.now()) / 1000) : 0;
  }

  /** 搜索缓存的现状（给界面/诊断看，确认节流真的在起作用） */
  searchCacheStats() {
    return { size: this._searchCache ? this._searchCache.size : 0, cooling: this._coolUntil > Date.now() };
  }

  _normSong(s) {
    if (!s) return null;
    const artists = (s.artists || s.ar || []).map((a) => a.name).filter(Boolean);
    const album = s.album || s.al || {};
    // 搜索接口只给 picId，详情接口才给 picUrl —— 缺 picUrl 时用 picId 反推
    const cover = album.picUrl
      || (s.al && (s.al.picUrl || neteasePicUrl(s.al.picId, 200)))
      || neteasePicUrl(album.picId, 200)
      || '';
    return {
      id: s.id,
      name: s.name,
      artists,
      artistText: artists.join(' / '),
      album: album.name || '',
      duration: (s.duration || s.dt || 0) / 1000,
      fee: s.fee,
      cover,
      source: 'netease',
    };
  }

  // ---------------------------------------------------------------- 歌曲
  async songDetail(ids) {
    const idArr = Array.isArray(ids) ? ids : [ids];
    if (this.browser && this.browser.available) {
      try {
        const r = await this._raceAbort(this.browser.songDetail(idArr));
        if (r && r.ok) return r;
      } catch (e) { this.log('[netease] 浏览器 songDetail 失败，回退直连：' + e.message); }
    }
    const r = await this._fetch(`${BASE}/api/song/detail?ids=${encodeURIComponent(JSON.stringify(idArr))}`);
    if (!r.ok) return { ok: false, code: r.code, msg: r.msg, songs: [] };
    return { ok: true, songs: (r.data.songs || []).map((s) => this._normSong(s)) };
  }

  // ---------------------------------------------------------------- 歌单
  /**
   * 从各种输入里解析出歌单 ID。支持：
   *   - 纯数字：`3778678`
   *   - 网页链接：`https://music.163.com/playlist?id=3778678`（含 `/#/playlist?id=` 形态）
   *   - 分享短链：`https://163cn.tv/xxxx`（跟随 302，最终 URL 里带 id）
   *   - 手机分享：`https://y.music.163.com/m/playlist?id=...`
   * @returns {{ok:boolean, id?:string, via?:string, msg?:string}}
   */
  async resolvePlaylistId(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s) return { ok: false, msg: '请填歌单 ID 或链接' };

    const fromUrl = (u) => {
      let m = u.match(/[?&#]id=(\d{3,})/);
      if (m) return m[1];
      m = u.match(/\/playlist\/(\d{3,})/);
      if (m) return m[1];
      return null;
    };

    if (/^\d{3,}$/.test(s)) return { ok: true, id: s, via: 'digits' };

    const direct = fromUrl(s);
    if (direct) return { ok: true, id: direct, via: 'url' };

    if (/^https?:\/\//i.test(s) || /^163cn\.tv\//i.test(s)) {
      const url = /^https?:\/\//i.test(s) ? s : 'https://' + s;
      try {
        const r = await fetch(url, {
          redirect: 'follow',
          headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
        });
        const finalUrl = r.url || '';
        const id = fromUrl(finalUrl);
        if (id) return { ok: true, id, via: 'redirect:' + finalUrl.slice(0, 90) };
        const html = await r.text();
        const m = html.match(/playlist[/?]id=(\d{3,})/i)
          || html.match(/"playlistId"\s*:\s*"?(\d{3,})"?/i);
        if (m) return { ok: true, id: m[1], via: 'html' };
        return { ok: false, msg: '链接里没解析到歌单 ID（可能是专辑/电台链接，或短链已失效）' };
      } catch (e) {
        return { ok: false, msg: '链接解析失败：' + e.message };
      }
    }
    return { ok: false, msg: '无法识别：请填纯数字歌单 ID，或网易云歌单链接' };
  }

  /**
   * 歌单详情。老版一次最多给 200 首；超过则用 v6 分页补齐。
   */
  async playlist(id, { limit = 0 } = {}) {
    /**
     * 主路径（2026-09-26 上线）：浏览器通道优先（一次拿 500 首，避免分页）。
     * 兜底：直连老版 `/api/playlist/detail`（200 上限） + v6 分页补齐。
     */
    if (this.browser && this.browser.available) {
      try {
        const r = await this._raceAbort(this.browser.playlist(id, { limit }));
        if (r && r.ok && r.tracks && r.tracks.length) {
          const tracks = limit ? r.tracks.slice(0, limit) : r.tracks;
          return { ok: true, id: r.id, name: r.name, cover: r.cover, trackCount: r.trackCount, tracks };
        }
      } catch (e) { this.log('[netease] 浏览器 playlist 失败，回退直连：' + e.message); }
    }
    const r = await this._fetch(`${BASE}/api/playlist/detail?id=${id}`);
    if (!r.ok || !r.data.result) return { ok: false, code: r.code, msg: r.msg, tracks: [] };
    const res = r.data.result;
    let tracks = (res.tracks || []).map((t) => this._normSong(t)).filter(Boolean);
    const total = res.trackCount || tracks.length;

    if ((limit && tracks.length < Math.min(limit, total)) || tracks.length < total) {
      const want = limit ? Math.min(limit, total) : total;
      const more = [];
      for (let offset = tracks.length; offset < want; offset += 500) {
        const p = await this._fetch(`${BASE}/api/v6/playlist/detail?${this._qs({ id, n: Math.min(500, want - offset), s: 8, offset })}`);
        const got = (p.data && p.data.playlist && p.data.playlist.tracks) || [];
        more.push(...got.map((t) => this._normSong(t)));
        if (!got.length) break;
      }
      if (more.length) tracks = tracks.concat(more);
    }
    return {
      ok: true,
      id: res.id,
      name: res.name,
      cover: res.coverImgUrl,
      trackCount: total,
      tracks: limit ? tracks.slice(0, limit) : tracks,
    };
  }

  /** 我的歌单（需登录，eapi） */
  async myPlaylists(uid) {
    if (!uid) {
      const acc = await this.account();
      uid = acc && acc.profile && acc.profile.userId;
    }
    if (!uid) return { ok: false, msg: '未登录或拿不到 uid', playlists: [] };
    const r = await this._eapi('/api/user/playlist', { uid, limit: 1000, offset: 0, includeVideo: true });
    const list = (r.data && r.data.playlist) || [];
    if (!r.ok || !list.length) return { ok: false, code: r.code, msg: r.msg || '未取到歌单', playlists: [] };
    return {
      ok: true,
      playlists: list.map((p) => ({
        id: p.id, name: p.name, cover: p.coverImgUrl, trackCount: p.trackCount,
        creator: p.creator && p.creator.nickname, subscribed: !!p.subscribed,
      })),
    };
  }

  // ---------------------------------------------------------------- 歌词
  /**
   * 取歌词。逐字(yrc)必须走 /api/song/lyric/v1 且带 yv/ytv/yrv，
   * 实测免登录可用（老接口的 klyric 恒空，务必别用）。
   * @returns {{ok:boolean, lrc:string, tlyric:string, romalrc:string, yrc:string}}
   */
  async lyric(id) {
    /**
     * 主路径（2026-09-26 上线）：浏览器通道优先（带真 session，扛限流）。
     * 兜底：直连 music.163.com v1 → interface3 镜像（应对直连被限的情况）。
     */
    if (this.browser && this.browser.available) {
      try {
        const r = await this._raceAbort(this.browser.lyric(id));
        if (r && r.ok) return r;
        this.log(`[netease] 浏览器通道歌词失败，回退直连：${(r && r.msg) || '未知'}`);
      } catch (e) {
        this.log('[netease] 浏览器通道歌词异常，回退直连：' + e.message);
      }
    }
    const url =
      `${BASE}/api/song/lyric/v1?${this._qs({ id, lv: -1, kv: -1, tv: -1, rv: -1, yv: -1, ytv: -1, yrv: -1 })}`;
    let r = await this._fetch(url);
    if (!r.ok) {
      // 回退：interface3 镜像（实测同样能出 yrc）
      r = await this._fetch(`${BASE_IF3}/api/song/lyric?${this._qs({ id, lv: -1, kv: -1, tv: -1, rv: -1, yv: -1, ytv: -1, yrv: -1 })}`);
    }
    if (!r.ok) return { ok: false, code: r.code, msg: r.msg, lrc: '', tlyric: '', romalrc: '', yrc: '' };
    const g = (k) => (r.data[k] && r.data[k].lyric) || '';
    return { ok: true, lrc: g('lrc'), tlyric: g('tlyric'), romalrc: g('romalrc'), yrc: g('yrc') };
  }

  // ---------------------------------------------------------------- 播放地址
  /**
   * 取播放直链。
   *
   * 实测（2026-09-25，ffprobe 量过时长）：
   *   - fee=0（免费曲）→ 完整 320kbps
   *   - fee=1（VIP曲）  → **只有 45 秒试听片段**，且响应里带 freeTrialInfo:{start:0,end:45}
   *   - fee=8          → 免登录也给完整 320kbps
   * 因此必须把 freeTrialInfo 暴露出去，否则会"整首歌只放 45 秒"却查不出原因。
   *
   * @returns {{ok:boolean, url:string, trial:boolean, trialEnd:number|null, br:number, size:number, fee:number, level:string|null, path:string, msg:string}}
   */
  async songUrl(id, { level = 'exhigh', encodeType = 'aac' } = {}) {
    const pick = (d, path) => {
      if (!d) return null;
      const trial = d.freeTrialInfo || null;
      return {
        ok: !!d.url,
        url: d.url || '',
        trial: !!trial,
        trialEnd: trial ? trial.end : null,
        br: d.br || 0,
        size: d.size || 0,
        fee: d.fee,
        level: d.level || null,
        path,
        msg: d.url ? '' : (this.isLoggedIn ? '该曲目当前无可用地址（可能版权下架或需要更高等级会员）' : '未登录：收费曲目拿不到完整直链'),
      };
    };

    /**
     * 0) 浏览器通道优先（2026-09-26 补，与其他读接口保持一致）。
     *
     * 之前只有 engine.resolveStream 在"直连给不出完整流"时才试浏览器，
     * 顺序反了 —— 直连先被节流 + 可能已在冷却里，白等一轮才轮到浏览器。
     * 现在和 search/lyric/songDetail 一样：**能走浏览器就先走浏览器**。
     */
    if (this.browser && this.browser.available) {
      try {
        const b = await this._raceAbort(this.browser.getSongUrl(id, { level, encodeType }));
        if (b && b.ok) return { ...b, path: b.path || 'browser' };
        this.log(`[netease] 浏览器取流未成功，回退直连：${(b && b.msg) || '未知'}`);
      } catch (e) { this.log('[netease] 浏览器取流异常，回退直连：' + e.message); }
    }

    // 1) eapi v1（实测最稳，且能拿到 freeTrialInfo）
    const e = await this._eapi('/api/song/enhance/player/url/v1', {
      ids: `[${id}]`, level, encodeType, imme: 'true',
    });
    let r = pick(e.ok && e.data && e.data.data && e.data.data[0], 'eapi');
    if (r && r.ok) return r;

    // 2) 老版 /api/（免加密，实测对 fee=8 也能给完整 320k）
    const legacy = await this._fetch(`${BASE}/api/song/enhance/player/url?ids=%5B${id}%5D&br=999000`);
    r = pick(legacy.ok && legacy.data.data && legacy.data.data[0], 'legacy') || r;
    if (r && r.ok) return r;

    // 3) weapi v1 兜底
    const form = new URLSearchParams(weapi({ ids: `[${id}]`, level, encodeType: 'flac' })).toString();
    const w = await this._fetch(`${BASE}/weapi/song/enhance/player/url/v1`, { method: 'POST', body: form });
    const r3 = pick(w.ok && w.data.data && w.data.data[0], 'weapi');
    if (r3 && r3.ok) return r3;

    return r3 || r || { ok: false, url: '', trial: false, trialEnd: null, br: 0, size: 0, fee: null, level: null, path: 'none', msg: '取地址失败' };
  }

  // ---------------------------------------------------------------- 登录
  /**
   * eapi 调用（登录类接口与 song/url/v1 必须走这里）
   * 关键：**摘要用 `/api/...` 计算，但请求发到 `/eapi/...`** —— 实测写成 /api/ 会得到 400 参数错误。
   */
  async _eapi(apiPath, params) {
    const reqPath = apiPath.replace('/api/', '/eapi/');
    const body = new URLSearchParams(eapi(apiPath, params)).toString();
    const r = await this._fetch(`${BASE}${reqPath}`, { method: 'POST', body });
    if (r.ok) return r;
    // eapi 有时返回 AES-ECB 密文（_fetch 会判成 non-json），这里补一次解密
    if (r.code === -2 && r.text) {
      try { return { ok: true, code: 200, data: parseJsonExact(eapiDecrypt(r.text)) }; } catch { /* 忽略 */ }
    }
    return r;
  }

  async account() {
    /**
     * 主路径（2026-09-26）：浏览器通道优先 —— 拿真 session 里的账号信息，
     * 不需要单独管理 cookie，扫码登录一次够用很久。
     */
    if (this.browser && this.browser.available) {
      try {
        const r = await this._raceAbort(this.browser.account());
        if (r && r.ok && r.profile) return r.profile;
      } catch (e) { this.log('[netease] 浏览器 account 失败，回退直连：' + e.message); }
    }
    const r = await this._fetch(`${BASE}/api/nuser/account/get`);
    if (!r.ok) return null;
    return r.data;
  }

  /** 生成扫码登录二维码（eapi） */
  async qrCreate() {
    const r = await this._eapi('/api/login/qrcode/unikey', { type: 3 });
    const key = r.data && r.data.unikey;
    if (!r.ok || !key) return { ok: false, msg: r.msg || (r.data && r.data.message) || 'unikey 获取失败', code: r.code };
    return { ok: true, key, url: `https://music.163.com/login?codekey=${key}` };
  }

  /** 轮询扫码状态：801 待扫 / 802 已扫待确认 / 803 成功（cookie 已自动落入 jar） */
  async qrCheck(key) {
    const r = await this._eapi('/api/login/qrcode/client/login', { key, type: 3 });
    const code = r.data ? r.data.code : r.code;
    if (code === 803) {
      const acc = await this.account();
      return { ok: true, code, profile: acc && acc.profile, loggedIn: this.isLoggedIn };
    }
    return {
      ok: false, code,
      msg: { 800: '二维码已过期', 801: '等待扫码', 802: '已扫码，等待确认', 402: '二维码凭证失效，请重新生成' }[code] || (r.data && r.data.message) || r.msg,
    };
  }
}

module.exports = { NeteaseClient, CookieJar, neteasePicUrl, encryptedPicId, repairNeteaseCover, parseJsonExact };
