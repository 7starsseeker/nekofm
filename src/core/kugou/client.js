/**
 * 酷狗音乐客户端
 * ==============
 * 设计原则（2026-11-12 活体实测，无登录态）：
 *   - 只走免登录的公开端点：搜索 `song_search_v2`、取流 `getSongInfo`、歌词 `krcs → lyrics/download`；
 *   - 不引第三方依赖（纯内置 fetch）；
 *   - 网络/业务失败一律返回 `{ok:false, code, msg}`，不抛出 —— 与 NeteaseClient 同一套契约，
 *     上层 `resolveStream` / `resolveLyrics` 才能用同一种写法兜住两个源。
 *
 * 实测要点（这些结论直接决定了下面的实现形状）：
 *   - **搜索没有风控**：同参数连打多次都是 200 带数据。不像 QQ 的 `reqCode=2001`
 *     （无 `Cookie: uin=0` 时直接空列表）、也不像网易云要 450ms 节流 + 冷却熔断。
 *     所以这里**故意不做节流/熔断** —— 加了只是给自己加延迟。
 *   - **取流的失败信号是干净的**：免登录可播曲 `url` 非空、`pay_type=0`、`privilege=0`；
 *     VIP 曲 `url` 为空、`pay_type=3`、`privilege=10`、`error='需要付费'`。
 *     **没有"占位片段"陷阱**（酷我 antiserver 对 VIP 曲回 11.28 秒占位音频，
 *     5 首不同歌只回 2 个 URL，ffprobe 才看得出来 —— 那个源因此被弃用）。
 *     这也是这里判定可播**只看 `url` 空不空**的原因：那是唯一权威的字段，
 *     `pay_type` 只用来把原因说清楚。
 *   - 直链在 **https://sharefs.kugou.com/<时间戳>/…**，自带时间戳会过期，所以每次播放现取；
 *     但可以交给缓存落盘（见 engine 的 `cacheSrc`），落盘后就不受过期影响。
 *   - 实测响应头：`206 · accept-ranges: bytes · access-control-allow-origin: *`
 *     —— 能直接喂给 `<audio crossorigin="anonymous">`（播放核心的音频图必须带 CORS），
 *     **不需要再加一条本地代理路由**。
 *   - 歌词 `krcs/search` 会给 20 条候选，取第 1 条 + `duration` 一起传命中率最高；
 *     `lyrics/download` 回 base64 LRC，`code=200`，**不需要 cookie**。
 */

'use strict';

const { createHash, randomBytes } = require('node:crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BASE_SEARCH = 'https://songsearch.kugou.com';
const BASE_INFO = 'https://m.kugou.com';
const BASE_LRC = 'https://krcs.kugou.com';
const BASE_LRC_DL = 'https://lyrics.kugou.com';
const BASE_LOGIN = 'https://login-user.kugou.com';

/**
 * 网页端签名（`signatureWebParams` 的等价实现，2026-11-12 从酷狗网页端行为反推并实测通过）：
 *   md5(SALT + 按 key 字母序拼成的 "k=v" + SALT)
 * 缺参数会返回 `error_code=20010`（不是签名错，是设备参数不全 —— 这个坑踩过一次）。
 */
const KG_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const KG_CLIENTVER = 20489;
const KG_APPID = 1001;
const KG_SRCAPPID = 2919;

const md5 = (s) => createHash('md5').update(String(s), 'utf8').digest('hex');

/** 封面 URL 里的 `{size}` 占位符要替换（400 实测 200 image/jpeg 42KB，够信息栏与卡片用） */
const COVER_SIZE = 400;

class KugouClient {
  /**
   * @param {{timeout?:number, cookie?:string, log?:Function}} opts
   *   timeout 只覆盖**单次**请求。这里没有多级回退（不像网易云要串 4 条通道），
   *   8 秒等不到就该报错让用户重试，而不是继续挂着。
   *   cookie 为空时一切照旧走免登录端点；登录只为**会员曲**（免费曲不需要）。
   */
  constructor({ timeout = 8000, cookie = '', log = () => {} } = {}) {
    this.timeout = timeout;
    this.log = log;
    /**
     * 当前载入的取消信号（engine 每次 `load()` 前塞进来，与 NeteaseClient 同名同语义）。
     * 用户切歌时要把上一次还在飞的请求真的掐掉，否则连接被占着、新歌排不进去。
     */
    this.currentSignal = null;
    /** `token=…; userid=…`；空串 = 未登录 */
    this.cookie = String(cookie || '').trim();
    /** 登录用的设备指纹：扫码与轮询必须是同一个 mid，否则 status 永远是 1 */
    this._mid = null;
  }

  /** 设备 mid：扫码与轮询必须是同一个值，所以缓存在实例上而不是每次现算 */
  _midValue() {
    if (!this._mid) this._mid = md5(randomBytes(16).toString('hex'));
    return this._mid;
  }

  /** 从 cookie 里拆出 token/userid；没登录返回 null */
  _tokenPair() {
    const pick = (k) => {
      const m = this.cookie.match(new RegExp(`(?:^|;\\s*)${k}=([^;]*)`));
      return m ? decodeURIComponent(m[1]) : '';
    };
    const token = pick('token');
    const userid = pick('userid');
    return token && userid ? { token, userid } : null;
  }

  get isLoggedIn() { return !!this._tokenPair(); }

  /** 二维码登录成功 / 用户手填 cookie 后落到这里 */
  setCookie(token, userid) {
    const t = String(token || '').trim();
    const u = String(userid || '').trim();
    this.cookie = t ? `token=${t}; userid=${u}; kg_mid=${this._midValue()}` : '';
    return this.isLoggedIn;
  }

  _signWeb(params) {
    const keys = Object.keys(params).sort();
    return md5(KG_SALT + keys.map((k) => `${k}=${params[k]}`).join('') + KG_SALT);
  }

  _deviceParams() {
    return {
      dfid: '-',
      mid: this._midValue(),
      uuid: '-',
      clientver: String(KG_CLIENTVER),
      clienttime: String(Date.now()),
    };
  }

  /** 登录端点的请求头：设备头是签名之外的第二道校验，缺了照样 20010 */
  _loginHeaders(dev) {
    return {
      'User-Agent': UA,
      Referer: 'https://www.kugou.com/',
      dfid: dev.dfid,
      clienttime: dev.clienttime,
      mid: dev.mid,
    };
  }

  /**
   * 统一请求：超时 + 外部取消 + 错误码。
   *
   * 错误码沿用网易云那套，`load()` 只认得 `-4`（安静放弃，不报错不跳歌）：
   *   -1 空响应 / -2 不是 JSON / -3 网络异常 / -4 已取消 / -5 超时 / 其它 = HTTP 状态码
   */
  async _fetch(url, { signal = null, headers = {} } = {}) {
    const ext = signal || this.currentSignal || null;
    if (ext && ext.aborted) return { ok: false, code: -4, msg: '已取消（被更新的操作打断）' };

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (ext) ext.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        // Referer 不带：实测分享直链与三个 JSON 接口都不校验来源，
        // 带上一个假 Referer 反而是在给"伪装成网页"留把柄。
        // （登录端点例外：那里设备头 + Referer 都是校验的一部分，由调用方显式传。）
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers },
      });
      if (!res.ok) return { ok: false, code: res.status, msg: `HTTP ${res.status}` };
      const text = await res.text();
      if (!text.trim()) return { ok: false, code: -1, msg: '酷狗返回了空响应' };
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, code: -2, msg: '酷狗返回的不是 JSON（接口可能改版）' };
      }
      return { ok: true, data };
    } catch (e) {
      if (timedOut) return { ok: false, code: -5, msg: `请求超时（${this.timeout}ms）` };
      if (ext && ext.aborted) return { ok: false, code: -4, msg: '已取消（被更新的操作打断）' };
      return { ok: false, code: -3, msg: '网络异常：' + String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
      if (ext) ext.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 搜索结果的原始条目 → 曲目对象（与 NeteaseClient._normSong 同形）。
   *
   * `id` 用 `FileHash`：它既是取流要的 hash，又是缓存的唯一键。
   * **歌手名是 `SingerName` 一整串**（多个歌手用「、」分隔），不是数组 ——
   * 不拆开的话 `artists` 只有 1 个元素、`artistText` 看着对但去重键会串味。
   */
  _normSong(it) {
    if (!it || !it.FileHash) return null;
    const artists = String(it.SingerName || '')
      .split(/[、&\/]/)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      source: 'kugou',
      id: String(it.FileHash).toUpperCase(),
      name: it.SongName || it.FileName || '',
      artists,
      artistText: artists.join(' / '),
      album: it.AlbumName || '',
      duration: Number(it.Duration) || 0,
      cover: String(it.Image || it.AlbumImage || '')
        .replace('{size}', String(COVER_SIZE))
        // 实测 `imge.kugou.com` 的 https 同样 200（同一张图），统一升到 https：
        // 控制台将来若换到 https 起源，混合内容会被浏览器直接拦掉。
        .replace(/^http:\/\//, 'https://'),
      // 搜索给的 PayType 与取流时的 pay_type 不是同一套字段（实测同一首可能一个是 0 一个是 3），
      // 所以这里**只作记录**，可播判定一律交给 songUrl 的 url 空不空。
      pay: it.PayType,
    };
  }

  // ---------------------------------------------------------------- 搜索
  /**
   * 搜索单曲。返回 `{ok, songs, total}` / `{ok:false, code, msg, songs:[]}`。
   *
   * 不做搜索缓存：酷狗没有限流，多打一次比维护一份"结果过期了还拿旧数据"的缓存便宜。
   */
  async search(keyword, { limit = 8 } = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) return { ok: true, songs: [], total: 0 };
    const url = `${BASE_SEARCH}/song_search_v2?keyword=${encodeURIComponent(kw)}&page=1&pagesize=${Math.max(1, Math.min(50, limit))}`;
    const r = await this._fetch(url);
    if (!r.ok) return { ok: false, code: r.code, msg: r.msg, songs: [] };
    const body = (r.data && r.data.data) || {};
    const list = Array.isArray(body.lists) ? body.lists : [];
    const seen = new Set();
    const songs = [];
    for (const it of list) {
      const s = this._normSong(it);
      // 同一首歌会在结果里重复出现（不同音质/不同专辑版本共用 FileHash）
      if (s && !seen.has(s.id)) { seen.add(s.id); songs.push(s); }
    }
    return { ok: true, songs, total: Number(body.total) || songs.length };
  }

  // ---------------------------------------------------------------- 取流
  /**
   * 按 hash 取播放直链。
   * 返回 `{ok:true, url, br, quality, duration}` / `{ok:false, code, msg}`。
   *
   * 失败文案直接引用酷狗自己的 `error`（"需要付费"），再补上 `pay_type`/`privilege`
   * —— 没有这两个数字，用户只会看到"取播放地址失败"，分不清是没版权还是没会员。
   */
  async songUrl(hash) {
    const h = String(hash || '').trim();
    if (!h) return { ok: false, code: -1, msg: '缺少曲目 hash' };
    let url = `${BASE_INFO}/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(h)}`;
    /**
     * 登录态：只在有 cookie 时才追加凭证参数。
     *
     * 未登录路径**保持与实测通过时逐字节相同**（少一个参数都可能改变返回形状），
     * 所以这里刻意不把 appid/clientver 等常量无条件拼上去 —— 免费曲的回归风险为零。
     *
     * [未实测] 登录后能否把 `pay_type=3` 的会员曲变成可播：需要会员账号才能验。
     * 失败时的文案会区分「未登录 → 需要付费」与「已登录但仍需要付费」（后者说明
     * 这个账号没有该曲的权益，或者这个端点的鉴权不在 query 上）。
     */
    const tok = this._tokenPair();
    if (tok) {
      url += `&token=${encodeURIComponent(tok.token)}&userid=${encodeURIComponent(tok.userid)}`
        + `&appid=${KG_APPID}&clientver=${KG_CLIENTVER}&dfid=-&mid=${this._midValue()}`;
    }
    const r = await this._fetch(url, tok ? { headers: { Cookie: this.cookie } } : {});
    if (!r.ok) return { ok: false, code: r.code, msg: r.msg };
    const d = r.data || {};
    if (!d.url) {
      const why = String(d.error || '').trim()
        || (d.errcode ? `酷狗错误码 ${d.errcode}` : '酷狗没有给这个曲目的播放地址');
      const detail = (d.pay_type != null || d.privilege != null)
        ? `（pay_type=${d.pay_type}, privilege=${d.privilege}）` : '';
      const who = tok ? '这个账号没有该曲的权益' : '未登录';
      return { ok: false, code: 403, msg: `酷狗：${why}${detail} · ${who}` };
    }
    const br = Number(d.bitRate) || 0;
    return {
      ok: true,
      url: d.url,
      br,
      quality: br ? `${br}k` : '',
      // 歌曲自报时长（秒）：与搜索结果的 Duration 属于两套数据，取流时顺手带回来，
      // 界面显示的时长不会因为搜索结果缺失就变成 0。
      duration: Number(d.timeLength) || 0,
    };
  }

  // ---------------------------------------------------------------- 歌词
  /**
   * 取歌词，返回 `{ok:true, lrc}` / `{ok:false, msg}`。
   *
   * `duration` 一定要传：同一个 hash 在不同版本（原版/Live/remix）下的 LRC 长得不一样，
   * 酷狗拿它挑最贴合的那条候选。
   */
  async lyric(hash, { duration = 0 } = {}) {
    const h = String(hash || '').trim();
    if (!h) return { ok: false, msg: '缺少曲目 hash' };
    const dur = Math.round(Number(duration) || 0);
    const s = await this._fetch(
      `${BASE_LRC}/search?ver=1&man=yes&client=mobi&keyword=&duration=${dur > 0 ? dur : ''}&hash=${encodeURIComponent(h)}`,
    );
    if (!s.ok) return { ok: false, msg: s.msg };
    const cands = (s.data && s.data.candidates) || [];
    if (!cands.length) return { ok: false, msg: '酷狗没有这首歌的歌词' };
    const c = cands[0] || {};
    if (!c.id || !c.accesskey) return { ok: false, msg: '酷狗歌词候选缺少 id/accesskey（接口可能改版）' };
    const r = await this._fetch(
      `${BASE_LRC_DL}/download?ver=1&client=pc&id=${encodeURIComponent(c.id)}&accesskey=${encodeURIComponent(c.accesskey)}&fmt=lrc&charset=utf8`,
    );
    if (!r.ok) return { ok: false, msg: r.msg };
    const b64 = r.data && r.data.content;
    if (!b64) return { ok: false, msg: `酷狗歌词内容为空（code=${(r.data && r.data.code) || '?'}）` };
    const lrc = Buffer.from(String(b64), 'base64').toString('utf8');
    return lrc.trim() ? { ok: true, lrc } : { ok: false, msg: '酷狗歌词解出来是空的' };
  }

  // ---------------------------------------------------------------- 扫码登录
  /**
   * 生成扫码二维码。
   * 返回 `{ok:true, key, img}`，`img` 是**服务端直接给的 base64 PNG data URL**
   * （不像网易云还得把 URL 丢给 api.qrserver.com 画成图 —— 这里不用任何第三方服务）。
   *
   * 关键：`dfid/mid/uuid/clientver/clienttime` 一个都不能少，再对全部参数算 signature。
   * 缺了会返回 `{"data":null,"status":0,"error_code":20010}`，看起来像签名算错，其实是设备参数不全。
   */
  async qrCreate() {
    const base = {
      ...this._deviceParams(),
      appid: String(KG_APPID),
      type: '1',
      plat: '4',
      qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${KG_APPID}&`,
      srcappid: String(KG_SRCAPPID),
    };
    const q = { ...base, signature: this._signWeb(base) };
    const r = await this._fetch(`${BASE_LOGIN}/v2/qrcode?${new URLSearchParams(q)}`, {
      headers: this._loginHeaders(base),
    });
    if (!r.ok) return r;
    const d = (r.data && r.data.data) || {};
    if (!d.qrcode) {
      const ec = (r.data && r.data.error_code) || '?';
      return { ok: false, code: ec, msg: `酷狗没有返回二维码（error_code=${ec}）` };
    }
    return { ok: true, key: String(d.qrcode), img: String(d.qrcode_img || '') };
  }

  /**
   * 轮询扫码状态：`data.status` 0=过期 1=等待 2=已扫码待确认 4=成功。
   * 成功时直接从 `data.token` / `data.userid` 拼 cookie —— 酷狗不像网易云会发 set-cookie。
   *
   * 注意 mid 必须与 `qrCreate` 那次相同，否则永远停在 1（这也是 mid 缓存在实例上的原因）。
   */
  async qrCheck(key) {
    const k = String(key || '').trim();
    if (!k) return { ok: false, code: -1, msg: '缺少二维码 key' };
    const dev = this._deviceParams();
    const q = {
      ...dev,
      plat: '4',
      appid: String(KG_APPID),
      srcappid: String(KG_SRCAPPID),
      qrcode: k,
    };
    const full = { ...q, signature: this._signWeb(q) };
    const r = await this._fetch(`${BASE_LOGIN}/v2/get_userinfo_qrcode?${new URLSearchParams(full)}`, {
      headers: this._loginHeaders(dev),
    });
    if (!r.ok) return r;
    const d = (r.data && r.data.data) || {};
    const st = Number(d.status != null ? d.status : (r.data && r.data.status));
    if (st === 4) {
      const token = d.token || (r.data && r.data.token);
      const userid = d.userid || (r.data && r.data.userid);
      if (!token || !userid) {
        return { ok: false, code: 4, msg: '酷狗说登录成功，但没给 token/userid（接口可能改版）' };
      }
      this.setCookie(token, userid);
      return {
        ok: true,
        code: 4,
        userId: String(userid),
        nickname: String(d.nickname || d.username || d.nick || ''),
      };
    }
    const msg = st === 0 ? '二维码已过期，请重新生成'
      : st === 2 ? '已扫码，请在手机上点确认'
        : `等待扫码…（status=${st}）`;
    return { ok: false, code: st, msg };
  }

  /** 登出：只清本地 cookie（酷狗没有需要清理的持久会话） */
  logout() {
    this.cookie = '';
    return { ok: true, loggedIn: false };
  }
}

module.exports = { KugouClient };
