/**
 * B站视频 / 直播 API 封装（Node 原生）
 * ====================================
 * 2026-09-25 实测结论（全部写进代码注释，避免以后踩坑）：
 *   - `/x/web-interface/view`  免登录可取 cid/title/duration         → 用于解析点歌请求
 *   - `/x/player/wbi/playurl`  需 WBI 签名；老版 `/x/player/playurl` 目前也还活，留作回退
 *   - DASH 音频在 `data.dash.audio[]`，id: 30216≈64K / 30232≈132K / 30280≈192K
 *   - **拉流必须带 Referer: https://www.bilibili.com**，否则 403（已实测对比）
 *   - `/x/player/v2` 的字幕列表**必须带登录态**：未登录恒返回空（need_login_subtitle=true），
 *     与视频本身有没有字幕无关 → 登录 B站后 CC/AI 字幕可用；没登录就回落"标题匹配歌曲"
 */
'use strict';

const { WbiSigner, biliFetch, UA } = require('./wbi');

const AUDIO_ID_LABEL = {
  30216: '64K', 30232: '132K', 30280: '192K', 30250: 'Dolby', 30251: 'Hi-Res',
};

class BiliApi {
  constructor({ cookie = '', logger = () => {} } = {}) {
    this.cookie = cookie;
    this.log = logger;
    this.signer = new WbiSigner({ log: logger });
    this._vidCache = new Map();
  }

  _headers(extra = {}) {
    return { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...(this.cookie ? { Cookie: this.cookie } : {}), ...extra };
  }

  /** 从任意输入解析出 BV/AV 号：支持 BV 号、av 号、完整链接、b23.tv 短链 */
  async parseVideoId(input) {
    const s = String(input || '').trim();
    /**
     * **BV 前缀大小写宽容**：B站只认大写 `BV`，但观众/主播手打常写成小写 `bv`
     * （旧版严格匹配会直接抛"无法识别视频号"，或者在弹幕那条路上整条被忽略）。
     * 只规范前缀 —— 后 10 位是大小写敏感的 base58，改写其余字符等于把号改错，
     * 真查不到时由 view 接口如实报错。
     */
    let m = s.match(/[Bb][Vv][0-9A-Za-z]{10}/);
    if (m) return { bvid: 'BV' + m[0].slice(2) };
    m = s.match(/av(\d+)/i);
    if (m) return { aid: Number(m[1]) };
    if (/^https?:\/\/(b23\.tv|bili2233\.cn)\//i.test(s)) {
      const r = await biliFetch(s, { raw: true, headers: this._headers() });
      const loc = r && r.headers ? r.headers.get('location') : null;
      const real = loc || (r && r.url);
      if (real) {
        const m2 = String(real).match(/BV[0-9A-Za-z]{10}/);
        if (m2) return { bvid: m2[0] };
        const m3 = String(real).match(/av(\d+)/i);
        if (m3) return { aid: Number(m3[1]) };
      }
      throw new Error('短链解析失败，请直接给 BV 号');
    }
    throw new Error('无法识别视频号：' + s.slice(0, 60));
  }

  /** 统一图片协议：B站有些接口给的是 http:// 或 // 开头，统一成 https，
   *  否则页面一旦走 https 就会被浏览器当混合内容拦掉。 */
  static httpsify(u) {
    if (!u) return '';
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('http://')) return 'https://' + u.slice(7);
    return u;
  }

  /**
   * 视频基础信息（含 cid，后续取流/字幕都要它）。
   *
   * 带**结果缓存 + 并发去重**：engine 的取流与取歌词是并行发起的，两边都会来问
   * cid（缓存键 `bilibili-<bvid>-<cid>` 依赖它）。没有 in-flight 去重就会为同一个
   * 视频发两次 `/x/web-interface/view` —— 白白多一次网络往返。
   */
  async videoInfo(input) {
    const key = String(input);
    if (this._vidCache.has(key)) return this._vidCache.get(key);
    if (!this._vidInFlight) this._vidInFlight = new Map();
    const flying = this._vidInFlight.get(key);
    if (flying) return flying;
    const p = this._videoInfo(key);
    this._vidInFlight.set(key, p);
    try {
      return await p;
    } finally {
      this._vidInFlight.delete(key);
    }
  }

  async _videoInfo(key) {
    const id = await this.parseVideoId(key);
    const q = id.bvid ? `bvid=${id.bvid}` : `aid=${id.aid}`;
    const r = await biliFetch(`https://api.bilibili.com/x/web-interface/view?${q}`, { headers: this._headers() });
    if (!r.ok) throw new Error(`view 失败 code=${r.code} msg=${r.msg}`);
    const d = r.data;
    const info = {
      bvid: d.bvid,
      aid: d.aid,
      cid: d.cid,
      title: d.title,
      desc: (d.desc || '').slice(0, 200),
      duration: d.duration,
      cover: BiliApi.httpsify(d.pic),
      owner: d.owner && d.owner.name,
      ownerMid: d.owner && d.owner.mid,
      ownerFace: d.owner && BiliApi.httpsify(d.owner.face),
      pubdate: d.pubdate,           // 投稿时间（Unix 秒），信息栏可显示
      stat: d.stat ? {              // 播放量等，信息栏可显示
        view: d.stat.view,
        danmaku: d.stat.danmaku,
        like: d.stat.like,
        coin: d.stat.coin,
        favorite: d.stat.favorite,
        reply: d.stat.reply,
      } : null,
      pages: (d.pages || []).map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration })),
    };
    this._vidCache.set(key, info);
    return info;
  }

  /**
   * 取流。返回 { audios:[{id,label,bandwidth,url,backupUrls}], videos:[...], duration }
   * @param {{fnval?:number}} [opts]
   */
  async playurl(bvid, cid, { fnval = 4048 } = {}) {
    const params = { bvid, cid, fnval, fnver: 0, fourk: 1 };
    let url = await this.signer.signUrl('https://api.bilibili.com/x/player/wbi/playurl', params);
    let r = await biliFetch(url, { headers: this._headers() });

    if (!r.ok) {
      this.log('[bili] wbi/playurl 失败 code=' + r.code + '，回退老端点');
      const qs = new URLSearchParams({ bvid, cid, fnval, fnver: 0, fourk: 1 }).toString();
      r = await biliFetch(`https://api.bilibili.com/x/player/playurl?${qs}`, { headers: this._headers() });
    }
    if (!r.ok) throw new Error(`playurl 失败 code=${r.code} msg=${r.msg}`);

    const dash = r.data.dash || {};
    const audios = (dash.audio || []).map((a) => ({
      id: a.id,
      label: AUDIO_ID_LABEL[a.id] || String(a.id),
      bandwidth: a.bandwidth,
      codecs: a.codecs,
      url: a.baseUrl || a.base_url,
      backupUrls: a.backupUrl || a.backup_url || [],
    }));
    const videos = (dash.video || []).map((v) => ({
      id: v.id, bandwidth: v.bandwidth, codecs: v.codecs, width: v.width, height: v.height,
      url: v.baseUrl || v.base_url,
    }));
    return {
      duration: r.data.timelength ? r.data.timelength / 1000 : undefined,
      audios: audios.sort((a, b) => b.bandwidth - a.bandwidth),
      videos,
      acceptQuality: r.data.accept_quality || [],
      usedEndpoint: url.includes('/wbi/') ? 'wbi' : 'legacy',
    };
  }

  /** 挑一条最佳音频流 */
  async bestAudio(bvid, cid) {
    const p = await this.playurl(bvid, cid);
    if (!p.audios.length) throw new Error('该视频没有独立音频流');
    return { ...p.audios[0], all: p.audios, duration: p.duration };
  }

  /** 播放地址可用性探测（带 Referer 拉 1KB，确认不是 403） */
  async probeStream(url) {
    const res = await biliFetch(url, { raw: true, headers: this._headers({ Range: 'bytes=0-1023' }) });
    return { status: res.status, contentType: res.headers.get('content-type'), ok: res.status === 200 || res.status === 206 };
  }

  /**
   * 字幕列表 + 内容（视频类"歌词"的来源）。
   *
   * **必须带登录态**（2026-09-26 实测）：未登录时 B站一律返回
   * `need_login_subtitle: true` + `subtitles: []`，采样 5 个视频（含明确标了
   * 「双语字幕」的）全部为空 —— 也就是说"取不到字幕"不是解析写错，而是没登录。
   * 业界实现一致：`data.subtitle.subtitles` 需要 cookie 才有内容。
   * 登录入口见控制台「弹幕点歌」卡片（`config.bilibili.cookie`，本类的 `_headers` 会带上）。
   */
  async subtitles(bvid, cid, { fetchContent = true } = {}) {
    const r = await biliFetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, { headers: this._headers() });
    if (!r.ok) return { ok: false, msg: r.msg, subtitles: [], needLogin: false };
    const d = r.data || {};
    const raw = (d.subtitle && d.subtitle.subtitles) || [];
    const out = raw.map((s) => ({
      lan: s.lan, lanDoc: s.lan_doc, url: s.subtitle_url, ai: !!s.ai_type,
      // 中文优先选轨：zh-CN / zh-Hans / ai-zh 都算中文
      isZh: /^(zh|ai-zh)/i.test(String(s.lan || '')),
    })).sort((a, b) => (b.isZh ? 1 : 0) - (a.isZh ? 1 : 0));
    if (fetchContent) {
      for (const s of out) {
        const u = s.url && s.url.startsWith('//') ? 'https:' + s.url : s.url;
        if (!u) continue;
        const j = await biliFetch(u, { headers: this._headers() });
        s.body = (j && j.data && j.data.body) || [];
      }
    }
    // needLogin：接口说"字幕需要登录"。**只有列表为空时才有诊断意义** ——
    // 登录态下这个字段可能仍为 true（表示"此视频的字幕受登录保护"）而列表非空。
    return { ok: true, subtitles: out, needLogin: !!d.need_login_subtitle };
  }

  /** 把 B站字幕转成歌词时间轴（秒） */
  static subtitleToTimeline(sub) {
    return (sub.body || []).map((b) => ({
      time: b.from,
      end: b.to,
      text: b.content,
      trans: '',
      roma: '',
      words: [],
      karaoke: 'plain',
    }));
  }

  /** 搜索视频（点歌时按关键词找"官方 MV/原曲"用） */
  async searchVideo(keyword, { page = 1, pageSize = 20 } = {}) {
    const params = { search_type: 'video', keyword, page, page_size: pageSize };
    const url = await this.signer.signUrl('https://api.bilibili.com/x/web-interface/wbi/search/type', params);
    const r = await biliFetch(url, { headers: { ...this._headers(), Referer: 'https://search.bilibili.com/' } });
    if (!r.ok) return { ok: false, code: r.code, msg: r.msg, results: [] };
    const list = (r.data && r.data.result) || [];
    return {
      ok: true,
      results: list.map((v) => ({
        bvid: v.bvid, title: String(v.title || '').replace(/<[^>]+>/g, ''), author: v.author,
        duration: v.duration, play: v.play, cover: BiliApi.httpsify(v.pic),
      })),
    };
  }

  /** 直播间信息（用于点歌机显示房间状态） */
  async roomInfo(roomId) {
    const r = await biliFetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
      headers: { Referer: 'https://live.bilibili.com/' },
    });
    if (!r.ok) return { ok: false, msg: r.msg };
    const d = r.data;
    return { ok: true, roomId: d.room_id, liveStatus: d.live_status, title: d.title, uname: d.uname, online: d.online, cover: d.user_cover };
  }
}

module.exports = { BiliApi, AUDIO_ID_LABEL };
