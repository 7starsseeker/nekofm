/**
 * Engine —— 一切的中枢
 * ======================
 * 把「弹幕 → 指令 → 搜索 → 队列 → 音源解析 → 播放器 → 歌词时间轴 → SSE 叠加层」
 * 串成一条可观测的流水线。本身不做 IO 细节，网络都在各 client 里，播放交给播放器窗口。
 *
 * 关键设计：**播放进度由播放器窗口回调，Engine 只做中转与广播**，
 * 这样歌词同步的时基就是 `<audio>.currentTime`（精确），
 * 而不是 Windows SMTC（实测很多播放器只在播放/暂停时推时间轴，会漂移）。
 */
'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { configPath } = require('../core/config');
const { NeteaseClient, repairNeteaseCover } = require('../core/netease/client');
const { BiliApi } = require('../core/bilibili/api');
const { biliFetch, WbiSigner } = require('../core/bilibili/wbi');
const { DanmakuClient } = require('../core/bilibili/danmaku');
const { OpenLiveClient } = require('../core/bilibili/open-live');
const { SongQueue, dedupeKey: dedupeKeyOf } = require('../core/queue');
const { Blacklist } = require('../core/blacklist');
const { parseCommand, PRIVILEGED } = require('../core/commands');
const { buildTimeline } = require('../core/lyrics/lrc');
const { LocalLibrary } = require('./sources/local');
const { MediaCache } = require('./cache');
const { BILI_UA } = require('./server');
const { DEMO_REQUESTER } = require('../core/demo');

/** 数据目录（配置/缓存/封面都在这，跟着程序走） */
const dataDir = () => (process.env.NEKOFM_DATA || configPath().dir);

/**
 * 解析缓存根目录。
 * 配置里留空 → `<程序目录>/data/cache`（**绝不默认写系统盘**）。
 * 填了绝对路径 → 用用户的（比如放到大盘上：D:/NekoFM/cache）。
 * 环境变量 NEKOFM_CACHE 优先级最高，方便临时切盘排查。
 */
function resolveCacheDir(config) {
  const fromEnv = process.env.NEKOFM_CACHE;
  const fromCfg = config && config.cache && config.cache.dir;
  const dir = (fromEnv || fromCfg || '').trim();
  return dir ? path.resolve(dir) : path.join(dataDir(), 'cache');
}

/**
 * 标题相似度（二元组 Dice 系数），用来卡住"网易云模糊搜索配错歌词"。
 * 实测：本地文件叫「示例曲目2」时，网易云也能返回一首不相干的歌 + 55 行歌词 ——
 * **配错歌词比没有歌词更糟**，所以要按标题相似度设一道闸。
 */
function titleSimilarity(a, b) {
  const clean = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\s\-_()[\]{}【】（）,.，。!！?？'"“”‘’·:：;；|/\\]+/g, '');
  const x = clean(a);
  const y = clean(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // 包含关系要**直接接受**：歌名被完整包含在另一方里是很强的证据。
  // 典型场景：B站视频标题「陈奕迅x《双城之战》主题曲《孤勇者》」里含「孤勇者」，
  // 按长度占比打折会被误杀（踩过），所以包含关系给到 ≥0.75。
  // 但要挡住"单字歌名被任意长标题命中"：短边至少 2 个字才算数。
  if (x.includes(y) || y.includes(x)) {
    const short = Math.min(x.length, y.length);
    const long = Math.max(x.length, y.length);
    if (short >= 2) return Math.max(TITLE_MATCH_MIN + 0.15, 0.7 + 0.3 * (short / long));
  }
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const [g, n] of gx) if (gy.has(g)) hit += Math.min(n, gy.get(g));
  return (2 * hit) / (x.length - 1 + y.length - 1);
}

/** 标题相似度低于此值时，认为"匹配错了"，宁可不给歌词 */
const TITLE_MATCH_MIN = 0.6;

/** 音源显示名（信息栏的角标用） */
const SOURCE_LABEL = {
  netease: '网易云',
  local: '本地',
  bilibili: 'B站视频',
};

class Engine extends EventEmitter {
  /**
   * @param {{config:object, log?:Function, browser?:object, biliBrowser?:object, biliChannel?:object}} opts
   */
  constructor({ config, log = () => {}, browser = null, biliBrowser = null, biliChannel = null }) {
    super();
    this.config = config;
    this.log = log;
    this.browser = browser || null; // 网易云「浏览器急兑」通道（Electron 注入；headless 为 null）
    // B站登录态通道：只用来把账号登进去换 cookie（字幕接口需要登录态）
    this.biliBrowser = biliBrowser || null;
    /** 弹幕通道（外部浏览器 + CDP）。为什么不用 Electron 自己的窗口见 browser-channel.js */
    this.biliChannel = biliChannel || null;
    /** 当前若走官方开放平台通道，这里指向那个 client（否则 null）；界面靠它禁用房间号输入 */
    this.openLive = null;
    /** 连接序号：只认最后一次 connectDanmaku（防止启动时的自动连接覆盖用户的手动切换） */
    this._connSeq = 0;

    this.netease = new NeteaseClient({ cookie: config.netease.cookie, log, browser });
    this.bili = new BiliApi({ cookie: config.bilibili.cookie, logger: log });
    this.local = new LocalLibrary({
      dirs: config.local.dirs,
      log,
      // 内嵌封面抽取后的缓存目录，跟着数据目录走（不写系统盘）
      coverDir: path.join(dataDir(), 'covers'),
    });

    this.queue = new SongQueue({
      ...config.queue,
      privileged: new Set((config.queue.privilegedUids || []).map(String)),
      log,
    });

    // 黑名单 / 审核规则：配置里来的，改动后由上层持久化
    this.blacklist = new Blacklist({
      enabled: !!(config.blacklist && config.blacklist.enabled),
      rules: (config.blacklist && config.blacklist.rules) || [],
      log,
    });

    this.danmaku = null;
    /**
     * 主播身份（房间房主）—— 判定"主播特权"用。
     * uid 来自房间信息（三个通道都会给：room_init / 开放平台 anchor.uid），
     * 昵称由主播的第一条弹幕补上（房间信息里没有昵称），用于 uid 对不上时的兜底。
     * 详见 `_isAnchorUser`。
     */
    this.anchorUid = 0;
    this.anchorName = '';

    // 在线媒体缓存：在线放过的歌落盘，下次直接读本地
    this.cache = new MediaCache({
      // 缓存根目录：配置留空就用 `<程序目录>/data/cache`（跟程序走，不写系统盘）。
      // 用户也可以改成大盘上的绝对路径，音频/封面/歌词都在这个目录下面。
      dir: resolveCacheDir(config),
      enabled: !!(config.cache && config.cache.enabled !== false),
      maxBytes: ((config.cache && config.cache.maxMB) || 2048) * 1024 * 1024,
      maxFileBytes: ((config.cache && config.cache.maxFileMB) || 120) * 1024 * 1024,
      log,
    });
    this.cache.init();

    // 播放行为
    this.playMode = (config.playback && config.playback.mode) || 'order';
    /**
     * 静音状态：统一放 `player` 段（与 volume / deviceId 同段）。
     *
     * 历史上它读写的是 `playback.muted` —— 那是"**播放行为**"段（放播放模式 mode 的），
     * 而且**改完从不落盘**，重启就丢。音量那边更彻底：构造时读了 `player.volume`，
     * 但 `setVolume` 从来不写回配置，等于完全没记忆
     * （用户报告"播放器音量每次启动都重置到 100%"）。
     * 现在两处都写回 `player.*`，落盘交给命令层（音量高频 → 防抖，2026-09-26 修）。
     */
    this.muted = !!this.config.player.muted;
    /** 播放历史（供「上一首」与「列表循环」用），最多 100 条 */
    /**
     * **用户可见的「已播放」——只记录"从点歌队列里播过的歌"**（2026-09-26 按用户要求改）。
     *
     * 为什么：在「已保存播放列表」里直接播的歌属于"自己放给自己听"，
     * 不该混进点歌记录 —— 否则「已播放」变成一锅粥，也没法回答
     * "这场直播别人点了哪些歌"。
     *
     * 判别依据是**从哪播的**，不是"这首歌是什么"：
     * 同一首歌在队列里播就记录，在已保存歌单里播就不记录。
     */
    this.history = [];
    /**
     * **全部播过的曲目**（队列 + 闲时/已保存歌单都算）。
     *
     * 与 `history` 分开是必须的：`history` 只给用户看（已播放列表），
     * 而闲时歌单的「近期不重复」(`avoidRecent`) 需要看到**所有**刚放过的歌 ——
     * 否则刚在已保存歌单里放过的那首，下一轮马上又会被抽到。
     */
    this.recentPlayed = [];
    /** 闲时歌单的内存游标（顺序播放时用） */
    this._idlePool = null;
    this._idleCursor = 0;
    /** 当前是否在播闲时歌单（UI 上要能看出来） */
    this.playingIdle = false;
    /**
     * 用户在**解析直链期间**按了暂停的意图（2026-09-26 加）。
     * loading 时 audio 还指着上一首的源，直接 pause 只能停到旧的；load() 完成
     * 时会看这个标志改发 startPaused，否则用户的暂停会被自动播放吞掉。
     */
    this._pausePending = false;
    /** playSaved 调用序号（连点时"最新一次赢"，只用于诊断） */
    this._playSavedSeq = 0;
    /** 批量缓存（cachePrefetch）的运行状态与进度 */
    this._prefetching = false;
    this._prefetchDone = 0;
    this._prefetchTotal = 0;
    /**
     * **下一首预载**（2026-09-26 加，思路来自 AIMP）。
     *
     * AIMP 有个开关叫 "Pre-load next track while current is playing"
     * （Preferences > Sound output）；Android Media3 也有官方的 PreloadManager。
     * 这是播放器的通行做法：**当前歌在放的时候，就把下一首的直链和歌词先取好**。
     * 好处是按「下一首 / 切歌」时几乎不需要联网 —— 真正做到"本地控制立刻响应"。
     *
     * 键是 dedupeKey，值 `{stream, lyrics, at}`；命中即用，用完删除（直链会过期）。
     */
    this._preload = new Map();
    this._preloading = false;
    /** 直播状态：下播时把当前列表存成「已保存播放列表」，开播时它当闲时歌单 */
    this.streaming = false;
    /** 弹幕房间的开播状态（0=未开播 1=直播中 2=轮播）；null=还没连/不知道 */
    this.roomLiveStatus = null;
    // 老配置里 idle.source 可能是 netease/local/favorites（早期按来源分支）。
    // 现在唯一来源是「已保存播放列表」，统一纠正，避免行为不一致。
    if (this.config.idle && this.config.idle.source !== 'saved') {
      this.config.idle.source = 'saved';
      this.config.idle.playlistId = '';
    }
    /**
     * 老配置里的歌词主题迁移（2026-09-26）。
     *
     * 「逐字卡拉OK」和「桌面歌词风」两个主题已下线（用户定：只留单行滚动 / 双语）。
     * 但存盘里可能还是旧值 —— 不纠正的话 `data-theme` 会挂着一个**没有任何
     * CSS 规则**的值（看着像样式坏了），而且下拉框也选不中、保存时会写成空值。
     * 映射到最接近的一项：karaoke→scroll（纯原文 + 当前行高亮）、
     * desktop→dual（它本来就是带翻译的）。
     */
    const THEME_MIGRATE = { karaoke: 'scroll', desktop: 'dual' };
    const THEMES = ['scroll', 'dual'];
    /**
     * 各主题的显示预设（与 control.js 的 THEME_PRESETS、下拉框标签保持一致）。
     * 迁移时套用它，否则会出现"主题叫单行滚动、却还挂着翻译行"这种自相矛盾的状态。
     */
    const THEME_PRESET = {
      scroll: { showTranslation: false },
      dual: { showTranslation: true },
    };
    if (this.config.overlay) {
      const t = this.config.overlay.theme;
      const to = THEME_MIGRATE[t] || t;
      const target = THEMES.includes(to) ? to : 'scroll';
      if (target !== t) {
        // **只在真的发生了迁移时**才套预设 —— 主题本来合法就不要动用户的开关
        this.config.overlay.theme = target;
        const p = THEME_PRESET[target];
        if (p) this.config.overlay.showTranslation = p.showTranslation;
        // 逐字染色已下线（2026-09-26）→ 顺手把这个字段从老配置里删干净
        delete this.config.overlay.showKaraoke;
        // showRoma 是用户自己的偏好，迁移时不动
        this.log(`[engine] 歌词主题「${t}」已下线 → 迁移为「${target}」并套用它的显示预设`);
      } else {
        this.config.overlay.theme = target;
      }
    }
    /** 闲时歌单的播放序列与游标 —— 有了它，"上一首"才能确定地回到同一首 */
    this._idleSeq = null;
    this._idleIdx = -1;

    // 播放状态（由播放器窗口回填）
    this.playback = {
      status: 'idle',    // idle | loading | playing | paused | error
      position: 0,       // 秒
      duration: 0,
      rate: 1,
      volume: config.player.volume,
      deviceId: config.player.deviceId,
      error: '',
    };

    this.track = null;          // 当前曲目（统一结构）
    this.streamUrl = '';        // 给播放器的本地流地址
    this._loadSeq = 0;          // 载入序号：用于丢弃过期（晚到）的载入结果
    this.lyricSource = '';      // netease | sidecar | embedded | subtitle | none
    this.lyricTimeline = { meta: {}, lines: [] };
    this.lyricRev = 0;
    this.notices = [];          // 最近提示（错误/回执），供 UI 与叠加层显示
    this.stats = { ordered: 0, skipped: 0, played: 0, danmaku: 0, rejected: 0, blocked: 0 };
  }

  // ================================================================ 初始化
  async init() {
    if (this.config.local.enabled && this.config.local.dirs.length) {
      try {
        const n = (await this.local.scan()).length;
        this.log(`[engine] 本地曲库 ${n} 首`);
      } catch (e) { this.log('[engine] 本地扫描失败', e.message); }
    }
    if (this.config.bilibili.autoConnect && this.config.bilibili.roomId) {
      this.connectDanmaku(this.config.bilibili.roomId).catch((e) => this.notify('error', '弹幕连接失败：' + e.message));
    }
    return this;
  }

  // ================================================================ 弹幕
  /**
   * 给浏览器通道生成 `getDanmuInfo` 的 WBI 签名 URL。
   *
   * 签名算在 Node 侧（`wbi.js`），但**请求本身必须发生在 Chromium 里** ——
   * 同一个 URL 两边都试过：Node 请求回来 token 长度 260、认证必被踢；
   * 浏览器里请求回来 token 长度 272、认证回 `{"code":0}`。
   */
  async danmakuSignUrl(roomId) {
    const signer = new WbiSigner({ log: this.log });
    return signer.signUrl('https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',
      { id: roomId, type: 0, web_location: '444.8' });
  }

  async connectDanmaku(roomId) {
    /**
     * 连接序号：**只认最后一次调用**。
     *
     * 启动时的自动连接（`init()` 里那个 fire-and-forget）中途会 await 好几次
     * （room_init、起浏览器、注入…），用户完全可能在这期间手动切通道/换房间 ——
     * 没有这层保护，先发起的那个会**后完成并覆盖**用户的意图，
     * 表现就是"我切了通道/房间，它又自己变回去了"。
     */
    const seq = ++this._connSeq;
    const stale = () => seq !== this._connSeq;

    if (this.danmaku) this.danmaku.close();
    if (this._danmakuBridge) { try { this._danmakuBridge.stop(); } catch { /* 忽略 */ } this._danmakuBridge = null; }
    this.openLive = null;   // 换通道时清掉，下面按实际选中的通道重新标记

    /**
     * 通道由用户在配置里**明确选定**（控制台「弹幕点歌」卡片里切），不再隐式挑：
     *   - `openlive`：官方直播开放平台。最稳，但**房间由主播身份码绑定**，
     *                 `config.bilibili.roomId` 不生效。
     *   - `browser` ：系统 Edge/Chrome 通道。可以连**任意**直播间，`roomId` 生效。
     * 选了 openlive 但凭据不齐 → 自动回落 browser 并提示，避免"连不上又不知道为什么"。
     */
    const mode = this.config.bilibili.danmakuMode === 'browser' ? 'browser' : 'openlive';
    const ol = this.config.bilibili.openLive || {};
    const openLiveCfg = {
      accessKeyId: ol.accessKeyId, accessKeySecret: ol.accessKeySecret,
      appId: ol.appId, roomOwnerAuthCode: ol.roomOwnerAuthCode,
    };
    const olProbe = new OpenLiveClient({ ...openLiveCfg, logger: this.log });
    let useOpenLive = mode === 'openlive' && olProbe.ready;
    if (mode === 'openlive' && !olProbe.ready) {
      this.notify('warn', '选了「官方开放平台」通道但凭据不全，本次先用浏览器通道；'
        + '把 access_key / app_id / 身份码 填齐即可切过去');
    }

    if (useOpenLive) {
      const client = olProbe;
      this.danmaku = client;          // 接口与 DanmakuClient 对齐（roomId / stats / close）
      this.openLive = client;         // 标记当前走的是官方通道（界面据此禁用房间号输入）
      client.on('room', (info) => {
        /**
         * 用**真实**开播状态，别拿"项目开启成功"当"在播" —— open-live 会顺手
         * 查一次 room_init 带过来（`liveStatus` 为 null 表示没查到，那就保持未知）。
         */
        this.roomLiveStatus = info.liveStatus == null ? null : info.liveStatus;
        if (info.liveStatus != null && info.liveStatus !== 1) {
          const what = info.liveStatus === 2 ? '正在轮播' : '未开播';
          this.notify('warn', `房间 ${info.roomId} ${what}：开放平台长连已建立，但 B站此刻不会推送弹幕；`
            + `开播后自动生效`);
        }
        this.emit('change');
      });
      client.on('open', () => this.notify('info', `弹幕已连接（开放平台 · 房间 ${client.roomId}）`));
      client.on('close', () => this.notify('warn', '开放平台长连断开，正在重连…'));
      client.on('error', () => {});
      client.on('danmaku', (d) => {
        this.stats.danmaku++;
        this.handleDanmaku(d).catch((e) => this.log('[engine] 处理弹幕失败', e.message));
      });
      this.emit('change');
      const ok = await client.connect();
      if (stale()) {
        // 已被更新的调用取代：收掉这次起的连接，并清掉半个状态（别让界面显示一个不存在的连接）
        try { client.close(); } catch { /* 忽略 */ }
        if (this.danmaku === client) { this.danmaku = null; this.emit('change'); }
        return false;
      }
      return ok;
    }

    const useBrowser = !!(this.biliChannel && this.biliChannel.available);
    const dc = new DanmakuClient({ roomId, cookie: this.config.bilibili.cookie, logger: this.log, external: useBrowser });
    this.danmaku = dc;

    /**
     * 房间信息最先到（`room_init` 就带了 live_status）。
     *
     * **未开播必须当场说清楚**：弹幕服务能连上、认证也能过，但 B站**不推送任何弹幕**
     * （2026-09-26 实测：未开播房间 12 秒收到 3 个包 / 0 条弹幕；同一时刻直播中的房间
     * 73 个包 / 46 条弹幕）。不说的话，用户在下播房间发点歌"没反应"，
     * 只会以为程序坏了 —— 实际上那条弹幕根本没被广播出来。
     */
    dc.on('room', (info) => {
      this.roomLiveStatus = info.liveStatus;
      /**
       * 记下**主播的 uid**（room_init 的 uid 就是房主）—— 判定"主播特权"要用它。
       *
       * 2026-09-26 修：这里以前没接，而 `handleDanmaku` 里早就在用 `this.anchorUid`
       * 判断 `isAnchor`，那个字段**永远是 undefined** —— 于是主播本人发指令会被回
       * "该指令需要房管/主播权限"（用户实测："我本身就是主播，但通过直播姬打指令说没有权限"）。
       * 昵称随后由主播的第一条弹幕补上（见 handleDanmaku），用于 uid 对不上的兜底。
       */
      if (info.uid) this.anchorUid = info.uid;
      // 主播昵称来自公开接口（见 danmaku.js 的 _fetchAnchorName）——
      // 不靠"从弹幕里学"，因为游客态下昵称会被打码
      if (info.anchorName) this.anchorName = info.anchorName;
      if (info.uid || info.anchorName) {
        this.log(`[engine] 主播身份：${this.anchorName || '(昵称未知)'} · uid ${this.anchorUid || 0}`
          + `｜本端 B站登录 uid ${(dc && dc.uid) || 0}`
          + `${(dc && dc.uid) ? '' : '（未登录/无 DedeUserID → 昵称可能被打码）'}`);
      }
      if (info.liveStatus !== 1) {
        const what = info.liveStatus === 2 ? '正在轮播' : '未开播';
        this.notify('warn', `房间 ${info.roomId} ${what}：弹幕服务已连上，但 B站此刻不会推送弹幕；`
          + `现在发点歌不会触发，开播后自动生效（想先测点歌用控制台的点歌框）`);
      }
      this.emit('change');
    });
    dc.on('open', () => this.notify('info', `弹幕已连接（房间 ${dc.roomId}）`));
    dc.on('close', () => this.notify('warn', '弹幕连接断开，正在重连…'));
    dc.on('error', () => {});
    dc.on('danmaku', (d) => {
      this.stats.danmaku++;
      this.handleDanmaku(d).catch((e) => this.log('[engine] 处理弹幕失败', e.message));
    });
    this.emit('change');
    if (!useBrowser) return dc.connect();

    /**
     * 浏览器通道：`room_init` 没有客户端识别（Node 直连照样能用），顺带还能把
     * `live_status` 拿回来喂给上面那个"未开播"提示。真正敏感的只有
     * `getDanmuInfo` 与 WebSocket，两件事都在浏览器页面里做。
     */
    const info = await dc.resolveRoom();
    if (stale()) return false;              // 期间又有人发起连接 → 本次作废

    const bridge = await this.biliChannel.start({
      roomId: info.roomId,
      signUrl: await this.danmakuSignUrl(info.roomId),
      urlProvider: (rid) => this.danmakuSignUrl(rid),
      onFrame: (buf) => dc.feed(buf),
      onState: (s) => {
        if (s.state === 'open') this.notify('info', `弹幕已连接（房间 ${info.roomId}）`);
        else if (s.state === 'error' || s.state === 'need-url') this.log('[engine] 弹幕通道异常:', s.err || s.state);
      },
    });
    // 起浏览器/注入要好几秒，这期间可能已经切走了 —— 那这条就白建了，收掉。
    // **同时把 `this.danmaku` 清掉**：留着它会让界面显示一个并不存在的连接
    // （`room.via` 会变成 `direct`、房间号也是错的），排查时非常误导。
    if (stale()) {
      try { bridge.stop(); } catch { /* 忽略 */ }
      if (this.danmaku === dc) { try { dc.close(); } catch { /* 忽略 */ } this.danmaku = null; this.emit('change'); }
      return false;
    }
    this._danmakuBridge = bridge;
    return true;
  }

  disconnectDanmaku() {
    /**
     * **也要递增连接序号**：用户点「断开」时，很可能上一次「连接」还在
     * 进行中（起浏览器要好几秒）。不递增的话那条流程结束后会判定自己
     * "没过期"，又把连接建回来 —— 用户会看到"点了断开，它自己又连上了"。
     */
    this._connSeq++;
    if (this._danmakuBridge) { try { this._danmakuBridge.stop(); } catch { /* 忽略 */ } this._danmakuBridge = null; }
    if (this.danmaku) {
      this.danmaku.close();
      this.danmaku = null;
      this.roomLiveStatus = null;
      // 主播身份跟着连接走：断开就清掉，免得换房间后还用上一个房间的主播 uid
      this.anchorUid = 0;
      this.anchorName = '';
      this._danmakuSeen = 0;   // 下次连接重新采样"弹幕身份"，便于排查
      this.emit('change');
    }
  }

  /**
   * 设置 B站登录态（cookie）并**立即生效**。
   *
   * 为什么要单独一个入口：`BiliApi` 的 cookie 是**构造时注入的普通字段**
   * （构造函数里 `new BiliApi({ cookie })`）。控制台登录后只改
   * `config.bilibili.cookie` 是不影响那个已建好的实例的 —— 字幕照样是空的，
   * 表现成"登录了却没反应"。这里两处一起改。
   *
   * 顺带核验一次账号（拿到昵称，界面才能确认"真的登进去了"而不是只存了一串字符）。
   * 注意：核验**失败不下结论** —— nav 接口自己也有风控，不能因为一次请求失败
   * 就把用户刚登录的 cookie 判死。
   */
  async biliSetCookie(cookie) {
    const c = String(cookie || '').trim();
    this.bili.cookie = c;
    this.config.bilibili.cookie = c;

    let loggedIn = /SESSDATA=/.test(c);
    let nick = '';
    if (loggedIn) {
      try {
        const nav = await biliFetch('https://api.bilibili.com/x/web-interface/nav', { headers: { Cookie: c } });
        if (nav.ok && nav.data) {
          nick = nav.data.uname || '';
          if (nav.data.isLogin === false) loggedIn = false; // 明确的"不认这个 cookie"
        }
      } catch { /* 核验失败保持在先的判定 */ }
    }
    this.emit('change');
    return { ok: true, loggedIn, nick };
  }

  /**
   * 这条弹幕是不是**主播本人**发的。
   *
   * 判据按可靠度排序（2026-09-26 加，起因：主播自己发指令被回"需要房管/主播权限"）：
   *   1. **uid 相等** —— 房间信息里的房主 uid，最权威，也是唯一在"游客态"下仍然可用的判据；
   *   2. **昵称相等** —— 兜底（直播姬发的与网页发的在服务端侧并不完全一致，
   *      uid 万一对不上时昵称还能认出本人）。昵称取自公开的 `get_anchor_in_room`。
   *
   * ⚠️ **带星号的昵称一律不认**：游客态下 B站把昵称打码成 `L***`，而打码**不唯一**
   * （Luna / Leo 都是 `L***`）—— 拿它当身份判据会把别的观众误认成主播，
   * 那比"认不出来"危险得多（2026-09-26 用户反馈打码昵称后立刻补的这道闸）。
   */
  _isAnchorUser(d) {
    if (!this.danmaku || !d) return false;
    const anchorUid = this.anchorUid;
    if (anchorUid && d.uid && String(d.uid) === String(anchorUid)) return true;
    const name = this.anchorName;
    const uname = d.uname;
    if (!name || !uname) return false;
    if (String(name).includes('*') || String(uname).includes('*')) return false;
    return String(uname) === String(name);
  }

  /** 弹幕 → 指令 → 动作。所有拒绝原因都会变成一条 notice（可显示在叠加层角标） */
  async handleDanmaku(d) {
    const isAnchor = this._isAnchorUser(d);
    /**
     * 前几条弹幕把"是谁发的"写进日志。
     *
     * 用户报过一个只能靠日志定位的问题："我自己发的消息被识别成一堆星号"——
     * 那是认证包里 uid=0 导致服务端按游客下发昵称。这条日志让**运行日志窗口里一眼可见**
     * （uid 是 0 还是真实数字、昵称有没有带星号），不用再猜。
     * 只记前 3 条：弹幕量大，逐条记会把日志刷爆。
     */
    if (this._danmakuSeen == null) this._danmakuSeen = 0;
    if (this._danmakuSeen < 3) {
      this._danmakuSeen++;
      this.log(`[engine] 弹幕身份样本 ${this._danmakuSeen}/3：uid=${d.uid} uname=${JSON.stringify(d.uname)}`
        + ` admin=${!!d.isAdmin} 认成主播=${isAnchor ? '是' : '否'}`
        + ` | 本端 B站登录 uid=${(this.danmaku && this.danmaku.uid) || 0}`
        + ` 主播 uid=${this.anchorUid || 0} 昵称=${JSON.stringify(this.anchorName || '')}`);
    }
    /**
     * 顺手把主播昵称学下来（兜底）——但**带星号的不学**：
     * 游客态下昵称是被打码的（`L***`），学下来只会覆盖掉从公开接口取到的真名。
     */
    if (isAnchor && d.uname && !String(d.uname).includes('*') && this.anchorName !== d.uname) this.anchorName = d.uname;
    const user = {
      uid: d.uid, uname: d.uname,
      isAdmin: d.isAdmin, isAnchor,
    };
    const c = parseCommand(d.text, { words: this.config.commands });

    if (c.cmd === 'order') return this.orderByKeyword(c.args.keyword, c.args.source, user);
    if (c.cmd === 'order_video') return this.orderVideo(c.args.target, user);

    /**
     * 2026-09-26：弹幕"切歌"按用户要求严格处理。
     * 必须是 c.raw === '切歌'（字符级精确，已由 parseCommand 保证）
     * **且**发送者是当前歌曲的请求者本人 / 房管 / Up主。否则：
     *   - 普通观众单独发"切歌"：之前会触发 skip() → 引擎报"只有点歌本人或主播能切这首"刷屏
     *   - 现在**静默丢弃**，当作聊天忽略，不计入 rejected、不出通知
     * 其他 skip 别名（跳过 / 下一首 / next）保留旧的"仅房管可用 + 拒绝时通知"。
     */
    if (c.cmd === 'skip' && c.raw === '切歌') {
      const isManager = this.queue.canManage(user);
      const owner = this.trackMeta && this.trackMeta.requester;
      const isOwner = owner && owner.uid != null && String(owner.uid) === String(user.uid);
      if (!isManager && !isOwner) return null;  // 静默丢弃
      return this.skip(user);
    }
    if (PRIVILEGED.has(c.cmd) && !this.queue.canManage(user)) {
      this.stats.rejected++;
      return this.notify('warn', `${user.uname}：该指令需要房管/主播权限`);
    }
    if (c.cmd === 'skip') return this.skip(user);
    if (c.cmd === 'remove') {
      const r = this.queue.remove(c.args.index, user);
      return this.notify(r.ok ? 'info' : 'warn', `${user.uname}：${r.ok ? `已撤下第 ${c.args.index || ''} 首` : r.msg}`);
    }
    if (c.cmd === 'mine') {
      const pos = this.queue.positionOf(user);
      const msg = pos.playing ? '你点的歌正在播放~' : pos.position ? `你点的歌排在第 ${pos.position} 位` : '你还没有点歌哦~';
      return this.notify('info', `${user.uname}：${msg}`);
    }
    if (c.cmd === 'queue') {
      const l = this.queue.list(5);
      const names = l.items.map((i) => `${i.position}.${i.name}`).join(' / ') || '（空）';
      return this.notify('info', `队列 ${l.total} 首：${names}`);
    }
    if (c.cmd === 'volume') {
      this.setVolume((c.args.value ?? 80) / 100);
      return this.notify('info', `${user.uname}：音量已设为 ${c.args.value}`);
    }
    if (c.cmd === 'lyric_toggle') {
      const on = c.args.on !== null ? c.args.on : !this.config.overlay._shown;
      this.config.overlay._shown = on;
      this.emit('change');
      return this.notify('info', `歌词已${on ? '显示' : '隐藏'}`);
    }
  }

  // ================================================================ 点歌
  /**
   * 从候选里挑"够确信"的那一首。
   *
   * 为什么需要：直接把搜索**第一条**拿来点，模糊关键词会配上完全无关的歌 ——
   * 实测「不存在的歌名xyz」被配成了《When I Find Love / XYZ》。
   * 宁可回一句"没找到确切匹配，这几首接近"，也不要放错歌。
   */
  _pickBestMatch(keyword, songs) {
    const kw = String(keyword || '').trim().toLowerCase();
    const scored = (songs || []).map((s) => {
      const t = String(s.name || s.title || '').toLowerCase();
      let sim = titleSimilarity(kw, t);
      // 关键词是标题的一部分（"孤勇" ⊂ "孤勇者"）也算合理匹配
      if (t && (t.includes(kw) || kw.includes(t))) sim = Math.max(sim, 0.75);
      // 歌手名命中再加一点（"周杰伦 稻香" 这类写法）
      const artist = String(s.artistText || (s.artists || []).join(' ')).toLowerCase();
      if (artist && artist.includes(kw)) sim = Math.max(sim, 0.6);
      return { s, sim };
    }).sort((a, b) => b.sim - a.sim);
    const best = scored[0];
    return {
      best: best && best.s,
      confidence: best ? best.sim : 0,
      candidates: scored.slice(0, 8).map((x) => x.s),
    };
  }

  async orderByKeyword(keyword, source, user, { interactive = false } = {}) {
    if (!keyword || !keyword.trim()) {
      this.stats.rejected++;
      return this.notify('warn', `${user.uname}：点歌要带上歌名哦~`);
    }
    // 预检：关键词直接命中黑名单就不必浪费一次网络搜索。
    // 返回值必须和 _enqueue 的拦截结果**保持同构**（{ok,reason,msg,rule}），
    // 否则调用方得分辨"这次拦截是哪个阶段发生的"，很容易写错。
    const pre = this.blacklist.checkKeyword(keyword);
    if (pre.blocked) {
      this.stats.rejected++;
      this.stats.blocked++;
      this.notify('warn', `${user.uname}：这首不能点（${pre.why}）`);
      return { ok: false, reason: 'blacklisted', msg: `已在黑名单：${pre.why}`, rule: pre.rule };
    }
    const src = source || this.config.netease.defaultSource;
    try {
      /**
       * **按网易云歌曲 ID 直接点播** —— 指令是 `点歌 ID 1234567`（2026-09-26 用户定的）。
       *
       * 为什么放在音源分支之前：ID 是唯一标识，一旦给了 ID 就没什么可"搜"的 ——
       * 直接取歌曲详情入队，既快又**不会配错歌**（搜关键词会把同名的另一首配上来，
       * 实测过「示例曲目2」被模糊匹配成完全不相关的歌）。
       *
       * 大小写不敏感（`ID`/`id`/`Id` 都认）：它只是"后面跟的是 ID 而不是歌名"的标记词，
       * 不是需要字符级精确的业务字面量（那种是"切歌"）。分隔符要求**有空格**
       * （跟点歌系指令一致，`点歌ID123` 紧贴着写不触发）。
       *
       * 弹幕与控制台**共用这一条路径**：控制台点歌框里直接填 `ID 1234567` 同样生效。
       */
      const asId = String(keyword).trim().match(/^id\s+(\d+)$/i);
      if (asId) return await this.orderSongById(asId[1], user);
      if (src === 'local') {
        const hits = this.local.search(keyword, 5);
        if (!hits.length) { this.stats.rejected++; return this.notify('warn', `${user.uname}：本地曲库没找到「${keyword}」`); }
        return this._enqueue(hits[0], user);
      }
      if (src === 'bilibili') {
        const r = await this.bili.searchVideo(keyword, { pageSize: 5 });
        if (!r.ok || !r.results.length) { this.stats.rejected++; return this.notify('warn', `${user.uname}：B站没搜到「${keyword}」`); }
        const v = r.results[0];
        /**
         * **搜索点歌也要带 cid**（2026-09-26 修）：`searchVideo` 的结果里没有 cid，
         * 原来就这么入队了 —— 而缓存键与取流都按 `bvid + cid` 认视频，于是同一个
         * 视频"点播 BV 号"和"点歌 b站 关键词"各存一份缓存、互相不命中。
         * 这里补一次（`videoInfo` 内部有缓存，且 resolveStream 本来也要查），
         * 让曲目**从入队起就是完整的**；取不到就交给 resolveStream 再兜底一次。
         */
        let cid = null;
        try { cid = (await this.bili.videoInfo(v.bvid)).cid; } catch { /* 忽略 */ }
        return this._enqueue({
          source: 'bilibili', bvid: v.bvid, id: v.bvid, name: v.title,
          artists: [v.author], artistText: v.author, title: v.title, duration: parseDuration(v.duration), cover: v.cover,
          ...(cid ? { cid } : {}),
        }, user);
      }
      const r = await this.netease.search(keyword, { limit: 8 });
      if (!r.ok || !r.songs.length) {
        this.stats.rejected++;
        const why = r.msg || `没搜到「${keyword}」`;
        this.notify('warn', `${user.uname}：${why}`);
        return { ok: false, reason: r.ok ? 'notfound' : 'limit', msg: why, candidates: [] };
      }
      const m = this._pickBestMatch(keyword, r.songs);
      /**
       * 取哪一首：**低置信度时信任搜索引擎自己的相关度排序**。
       *
       * 我这套相似度是二元组 Dice，遇到「假面骑士build」这种中日英混写、
       * 或者「孤勇」这种半截标题就算不出来（置信度很低）。而网易云的搜索
       * 用的是一套成熟的相关度模型，它的第 1 条通常就是对的。
       * 所以：我确信时用我的判断（能纠正"标题像但歌手不对"），
       * 我不确信时就用它的第 1 条 —— 而不是把选择甩回给用户。
       * 用户要的是"自动匹配一个最合适的然后开始播放"。
       */
      const lowConf = m.confidence < 0.45;
      const picked = lowConf ? r.songs[0] : m.best;
      if (lowConf) {
        this.log(`[engine] 点歌「${keyword}」相似度低(${m.confidence.toFixed(2)})，改用搜索首选：${picked.name}`);
      }
      const out = this._enqueue(picked, user);
      // 匹配度不高时把候选一并带回去：界面能提示"不是这首？下面还有"，
      // 但**不阻塞播放** —— 先放上才是重点。
      if (out && out.ok && lowConf) {
        out.lowConfidence = true;
        out.candidates = m.candidates.filter((s) => s !== picked).slice(0, 7);
      }
      return out;
    } catch (e) {
      this.log('[engine] 搜索失败', e.message);
      return this.notify('error', `搜索失败：${e.message}`);
    }
  }

  /** 直接点一首**已经拿到的**歌（搜索结果/候选按钮用，不再重新搜索，避免配错） */
  async orderSong(song, user, opts = {}) {
    if (!song || (!song.id && !song.bvid && !song.file)) {
      return { ok: false, reason: 'notfound', msg: '这首缺少可用的标识' };
    }
    return this._enqueue(song, user, opts);
  }

  async orderVideo(target, user) {
    const t = String(target || '').trim();
    if (!t) { this.stats.rejected++; return this.notify('warn', `${user.uname}：请附上 BV 号或视频链接`); }
    try {
      const info = await this.bili.videoInfo(t);
      return this._enqueue({
        source: 'bilibili', bvid: info.bvid, id: info.bvid, name: info.title,
        artists: [info.owner], artistText: info.owner, title: info.title,
        duration: info.duration, cover: info.cover, cid: info.cid,
        // 信息栏要用的投稿信息（播放量/弹幕数/投稿时间）
        stats: info.stat, pubdate: info.pubdate, ownerFace: info.ownerFace,
      }, user);
    } catch (e) {
      this.stats.rejected++;
      return this.notify('warn', `${user.uname}：视频解析失败（${e.message}）`);
    }
  }

  /**
   * **按网易云歌曲 ID 直接点播**（`点歌 ID 1234567`）—— 与 `orderVideo`（按 BV 号）对称。
   *
   * 给的是精确标识就不再搜索：`songDetail` 按 ID 取回**准确的那一首**，
   * 而关键词搜索可能把同名的另一首配上来（这是歌词/点歌配错的常见来源）。
   *
   * 入队后照常过黑名单（`_enqueue` 里）、照常进「已播放」记录、
   * 照常能被「加入已保存」—— 走的是与关键词点歌完全相同的那条路。
   *
   * @param {string|number} id 网易云歌曲 ID
   * @param {{uid?:any, uname?:string}} user 点歌人
   */
  async orderSongById(id, user) {
    const sid = String(id == null ? '' : id).trim();
    if (!/^\d+$/.test(sid)) {
      this.stats.rejected++;
      return this.notify('warn', `${user.uname}：歌曲 ID 应该是数字`);
    }
    try {
      const r = await this.netease.songDetail(sid);
      if (!r.ok) {
        this.stats.rejected++;
        return this.notify('warn', `${user.uname}：按 ID 点歌失败（${r.msg || '接口错误'}）`);
      }
      const song = (r.songs || [])[0];
      if (!song) {
        this.stats.rejected++;
        return this.notify('warn', `${user.uname}：网易云没有 ID 为 ${sid} 的歌曲（可能已下架）`);
      }
      this.log(`[engine] 按 ID 点歌：${song.name} / ${song.artistText}（id=${song.id}）`);
      return this._enqueue(song, user);
    } catch (e) {
      this.stats.rejected++;
      return this.notify('warn', `${user.uname}：按 ID 点歌失败（${e.message}）`);
    }
  }

  /**
   * @param {{force?:boolean}} opts force=true 表示**用户的显式动作**
   *   （控制台「再来一次」、候选按钮），要越过"刚放过就不给点"的去重规则。
   *   否则会出现"我点的是自己刚听完的那首，它却说已经有了"（实测被反馈）。
   */
  _enqueue(song, user, { force = false } = {}) {
    // 中央闸门：不管从弹幕、控制台还是歌单进来的曲目，都要过一遍黑名单。
    // 放在这里而不是各入口分别判断，是为了避免以后新增入口时漏掉。
    const verdict = this.blacklist.check(song);
    if (verdict.blocked) {
      this.stats.rejected++;
      this.stats.blocked++;
      this.notify('warn', `${user.uname || '系统'}：《${song.name || song.title}》不能播（${verdict.why}）`);
      return { ok: false, reason: 'blacklisted', msg: `已在黑名单：${verdict.why}`, rule: verdict.rule };
    }

    const r = this.queue.push(song, user, force ? { force: true } : undefined);
    this.stats.ordered++;
    if (!r.ok) {
      this.stats.rejected++;
      this.notify('warn', `${user.uname}：${r.msg}`);
      return r;
    }
    this.notify('info', `${user.uname} 点了《${song.name || song.title}》，排在第 ${r.position} 位`);
    this.emit('change');
    /**
     * 入队后要不要**马上播**？分三种情况（2026-09-26 定）：
     *   1. 什么都没在播            → 直接开播
     *   2. **正在播闲时歌单**      → **立刻切到点歌队列**（见 _preemptIdleForOrder）
     *   3. 正在播别人点的歌        → 不动，只入队（既有语义："引擎不会打断正在播放的歌"）
     *
     * 第 2 条是用户要求的：直播中「已保存播放列表」固定扮演闲时歌单，
     * 而它的定位就是"没人点歌时放点东西" —— 既然有人点了，就该马上让位。
     * 这也和 AIMP 的队列语义一致："Queue has a priority over playing playlist"。
     */
    if (!this.track && this.playback.status === 'idle') this.next().catch(() => {});
    else if (this.playingIdle) this._preemptIdleForOrder().catch(() => {});
    return r;
  }

  /**
   * **点歌优先于闲时歌单**：正在播闲时歌单时，新点歌立刻顶掉它。
   *
   * 只在"当前这首来自闲时歌单（`playingIdle`）"时抢占 ——
   * 正在播**别人点的歌**时不动，新点歌照旧排队（那条语义用户明确要求过，
   * PROGRESS.md 里也记着："引擎不会打断正在播放的歌"）。
   *
   * 切走的这首走和手动切歌一样的记账路径：`_rememberHistory` 会因为
   * `playingIdle === true` 而**不把它记进「已播放」**（已保存歌单播的不算点播记录），
   * 只进 `recentPlayed` 给「近期不重复」用。
   *
   * @returns {Promise<boolean>} 是否真的抢占了
   */
  async _preemptIdleForOrder() {
    if (!this.track || !this.playingIdle) return false;
    if (!this.queue.items.length) return false;   // 队列空就别折腾了
    this.notify('info', '有人点歌了，切到点歌队列（闲时歌单让位）');
    this.stats.skipped++;                          // 与手动切歌一致地记一次
    await this.next({ force: true });
    return true;
  }

  // ================================================================ 演练模式
  /**
   * 开启演示：用一套假曲目 + 假歌词驱动虚拟进度，**不联网、不出声**。
   * 目的：调叠加层样式 / 验证歌词与信息栏时，不必真的去放一首歌。
   * 所有渲染路径与真实播放完全一致（走同一条 state/lyrics 广播）。
   * @param {{seconds?:number, requester?:object}} opts
   */
  startDemo({ seconds = 45, requester = DEMO_REQUESTER } = {}) {
    if (this._demo) this.stopDemo();
    const { DEMO_LRC, DEMO_YRC, DEMO_TLYRIC, DEMO_SONG, DEMO_DURATION } = require('../core/demo');

    // 备份现场，结束后原样恢复
    this._demo = {
      prevTrack: this.track,
      prevMeta: this.trackMeta,
      prevTimeline: this.lyricTimeline,
      prevRev: this.lyricRev,
      prevSource: this.lyricSource,
      prevPlayback: { ...this.playback },
      timer: null,
      stopTimer: null,
    };

    this.track = DEMO_SONG;
    this.trackMeta = { requester, requestedAt: Date.now(), startedAt: Date.now() };
    this.lyricTimeline = buildTimeline({ lrc: DEMO_LRC, yrc: DEMO_YRC, tlyric: DEMO_TLYRIC });
    this.lyricSource = 'demo';
    this.lyricRev++;
    this.playback = { ...this.playback, status: 'playing', position: 0, duration: DEMO_DURATION, error: '' };

    const t0 = Date.now();
    this._demo.timer = setInterval(() => {
      if (!this._demo) return;
      // 循环播放演示素材，方便反复看效果
      this.playback.position = ((Date.now() - t0) / 1000) % DEMO_DURATION;
    }, 100);
    if (seconds > 0) {
      this._demo.stopTimer = setTimeout(() => this.stopDemo(), seconds * 1000);
    }
    this.notify('info', `演示模式已开启（${seconds} 秒后自动结束）—— 叠加层现在应显示歌词与信息栏`);
    this.emit('change');
    return { ok: true, seconds, duration: DEMO_DURATION, lines: this.lyricTimeline.lines.length };
  }

  stopDemo() {
    if (!this._demo) return { ok: false, msg: '当前没有在演示' };
    const d = this._demo;
    clearInterval(d.timer);
    clearTimeout(d.stopTimer);
    this._demo = null;
    this.track = d.prevTrack;
    this.trackMeta = d.prevMeta;
    this.lyricTimeline = d.prevTimeline;
    this.lyricSource = d.prevSource;
    this.lyricRev++;
    this.playback = d.prevPlayback;
    this.notify('info', '演示模式已结束');
    this.emit('change');
    return { ok: true };
  }

  get demoRunning() { return !!this._demo; }

  // ================================================================ 本地音乐
  /**
   * 打开（播放）若干本地音频文件。
   * 支持两种来源：用户在原生对话框里选的文件、或直接给的路径。
   * @param {string[]} paths
   * @param {{enqueue?:boolean, play?:boolean, user?:object}} [opts]
   */
  async openLocalFiles(paths = [], { enqueue = true, play = true, user = { uname: '本地打开' } } = {}) {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    if (!list.length) return { ok: false, msg: '没有选择文件' };

    const { added, skipped } = await this.local.addFiles(list);
    if (!added.length) return { ok: false, msg: '选中的文件都不是可识别的音频格式', skipped };

    let queued = 0;
    let deduped = 0;
    if (enqueue) {
      for (const t of added) {
        // **force:true** —— 这是控制台里的显式操作，不是弹幕点歌。
        // 不加的话，一首几分钟前放过的歌会被队列的"近期去重"挡掉，
        // 用户点了「打开文件」却什么都不发生（我自己排查时踩到过）。
        // 防刷屏的限制该管弹幕，不该管主播自己的操作。
        const r = this.queue.push(
          { ...t, source: 'local' },
          { uid: 'local', uname: user.uname, isAnchor: true },
          { urgent: true, force: true },
        );
        if (r.ok) queued++;
        else deduped++;
      }
    }

    // 想放的那首**正好就是当前这首** → 从头重播（点「打开」的预期就是听到它）
    const isCurrent = this.track && added.some((t) => t.file === this.track.file);
    if (play && !queued && isCurrent) {
      await this.load(this.track, this.trackMeta || {});
      this.notify('info', `重新播放：${this.track.name || this.track.title}`);
      this.emit('change');
      return { ok: true, added: added.map((t) => ({ name: t.name, file: t.file })), queued: 0, restarted: true, skipped };
    }

    this.notify('info', `已打开 ${added.length} 个本地文件${queued ? `，入队 ${queued} 首` : ''}${!queued && deduped ? '（已在队列中）' : ''}${skipped.length ? `（${skipped.length} 个跳过）` : ''}`);

    // 空闲就直接播第一首（"打开"这个动作的默认预期就是马上放）
    if (play && queued && !this.track) await this.next();
    this.emit('change');
    return { ok: true, added: added.map((t) => ({ name: t.name, file: t.file, duration: t.duration })), queued, skipped };
  }

  /**
   * 打开一个文件夹加入曲库并扫描。
   * 会写进 config.local.dirs（持久化），下次启动自动加载。
   */
  async openLocalFolder(dir, { persist = true } = {}) {
    if (!dir || !fs.existsSync(dir)) return { ok: false, msg: '目录不存在：' + dir };
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return { ok: false, msg: '这不是一个目录：' + dir };

    const dirs = this.config.local.dirs || (this.config.local.dirs = []);
    if (!dirs.includes(dir)) dirs.push(dir);
    this.config.local.enabled = true;
    this.local.dirs = dirs;

    const tracks = await this.local.scan({ force: true });
    this.notify('info', `已加入曲库目录：${dir}（当前共 ${tracks.length} 首）`);
    this.emit('change');
    return { ok: true, dir, total: tracks.length, persist };
  }

  /** 移除一个曲库目录（已在队列/在放的歌不受影响） */
  removeLocalFolder(dir) {
    const dirs = this.config.local.dirs || [];
    const i = dirs.findIndex((d) => path.resolve(d) === path.resolve(dir));
    if (i < 0) return { ok: false, msg: '曲库里没有这个目录' };
    const [removed] = dirs.splice(i, 1);
    this.local.dirs = dirs;
    this.emit('change');
    return { ok: true, dir: removed };
  }

  /** 列出本地曲库（支持关键词过滤与分页），供控制台浏览 */
  listLocal(keyword = '', { limit = 200, offset = 0 } = {}) {
    const all = keyword ? this.local.search(keyword, 1000) : this.local.tracks;
    const page = all.slice(offset, offset + limit);
    return {
      ok: true,
      total: all.length,
      libraryTotal: this.local.tracks.length,
      dirs: this.config.local.dirs || [],
      adhoc: this.local.extraFiles ? this.local.extraFiles.size : 0,
      tracks: page.map((t) => ({
        name: t.name,
        title: t.title,
        artistText: t.artistText,
        duration: t.duration,
        file: t.file,
        adhoc: !!t.openedAdhoc,
        cover: this.coverUrlFor(t),
      })),
    };
  }

  // ================================================================ 黑名单
  /** 把内存里的黑名单状态写回 config，供上层持久化 */
  syncBlacklistToConfig() {
    this.config.blacklist = this.blacklist.toJSON();
    return this.config.blacklist;
  }

  /**
   * 一键拉黑某个曲目。自动挑规则类型（视频→BV 号，正式曲→歌曲 ID，
   * 本地曲/无 ID→标题关键词），免得用户自己纠结该填哪种。
   */
  blockTrack(song, { asKeyword = false, note = '' } = {}) {
    if (!song) return { ok: false, msg: '没有可拉黑的曲目' };
    if (song.source === 'bilibili' && song.bvid) {
      return this.blacklist.add({ type: 'bvid', value: song.bvid, note: note || `${song.name || ''}（视频）` });
    }
    if (asKeyword) {
      return this.blacklist.add({ type: 'keyword', value: String(song.name || song.title || '').trim(), note: note || '拉黑同名歌曲' });
    }
    if (song.id != null && song.source !== 'local') {
      return this.blacklist.add({ type: 'song', value: String(song.id), note: note || `${song.name || ''} - ${song.artistText || ''}` });
    }
    return this.blacklist.add({ type: 'keyword', value: String(song.name || song.title || '').trim(), note: note || '本地曲目' });
  }

  // ================================================================ 歌单导入
  /**
   * 导入一个网易云歌单（支持 ID / 链接 / 分享短链）。
   * 流程：解析 ID → 取全量曲目 → **过黑名单** → 汇入「已保存播放列表」
   * → 记录到 config.playlists.imported。
   *
   * 默认**进「已保存播放列表」而不是点播队列**（2026-09-26 用户要求）：
   * 导入是"备货"，不是"现在就要播"；整单塞进队列会立刻盖掉观众点的歌。
   * 想直接排进当前队列仍可显式传 `autoQueue: true`。
   *
   * @param {{input:string, limit?:number, filterBlacklist?:boolean, toSaved?:boolean, autoQueue?:boolean}} opts
   */
  async importPlaylist({ input, limit = 0, filterBlacklist = true, toSaved = true, autoQueue = false } = {}) {
    const parsed = await this.netease.resolvePlaylistId(input);
    if (!parsed.ok) return { ok: false, msg: parsed.msg };

    const pl = await this.netease.playlist(parsed.id, { limit });
    if (!pl.ok) return { ok: false, msg: pl.msg || '歌单拉取失败' };

    const all = pl.tracks || [];
    const { kept, blocked } = filterBlacklist
      ? this.blacklist.filter(all)
      : { kept: all, blocked: [] };

    // 记录到已导入列表（按 id 去重，重复导入只更新时间与曲目数）
    const list = this.config.playlists.imported || (this.config.playlists.imported = []);
    const rec = {
      id: String(pl.id),
      name: pl.name,
      cover: pl.cover || '',
      trackCount: pl.trackCount || all.length,
      fetched: all.length,
      /** 网易云没给全时留个痕（多半是没登录），排查"怎么又只进来几首"时靠它 */
      truncated: !!pl.truncated,
      importedAt: Date.now(),
      lastQueuedAt: null,
      via: parsed.via,
    };
    const idx = list.findIndex((x) => x.id === rec.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...rec };
    else list.push(rec);

    let savedAdded = 0;
    let savedDup = 0;
    if (toSaved && kept.length) {
      const r = this.savedAddMany(kept, { uname: `歌单《${pl.name}》` });
      savedAdded = r.added;
      savedDup = r.dup;
    }

    let queued = 0;
    if (autoQueue) queued = this.queueTracks(kept, `歌单《${pl.name}》`);

    /**
     * 通知里必须说清两件事，否则用户只能看到"怎么才进来几首"：
     *   · 被网易云截断（fetched < trackCount）—— 通常是没登录网易云
     *   · 有多少首被黑名单拦下
     */
    let msg = `已导入歌单《${pl.name}》共 ${all.length} 首`;
    if (pl.truncated) msg += `（歌单实际 ${pl.trackCount} 首，网易云只给了 ${all.length} 首 —— 多半是没登录网易云）`;
    if (blocked.length) msg += `，其中 ${blocked.length} 首被黑名单拦下`;
    if (toSaved) msg += `；已加入已保存播放列表 ${savedAdded} 首${savedDup ? `（跳过重复 ${savedDup} 首）` : ''}`;
    if (autoQueue) msg += `；已入队 ${queued} 首`;
    this.notify(pl.truncated ? 'warn' : 'info', msg);

    this.emit('change');
    return {
      ok: true,
      playlist: { id: rec.id, name: rec.name, cover: rec.cover, trackCount: rec.trackCount, fetched: all.length },
      blockedCount: blocked.length,
      blockedPreview: blocked.slice(0, 5).map((b) => ({ name: b.song.name, why: b.why })),
      truncated: !!pl.truncated,
      savedAdded,
      savedDup,
      queued,
      tracks: kept,
    };
  }

  /** 把一批曲目塞进队列；返回成功条数 */
  queueTracks(tracks, by = '系统') {
    let n = 0;
    for (const t of tracks || []) {
      const r = this.queue.push(t, { uid: 'playlist', uname: by, isAnchor: true });
      if (r.ok) n++;
    }
    if (n && !this.track && this.playback.status === 'idle') this.next().catch(() => {});
    this.emit('change');
    return n;
  }

  /** 把已导入歌单重新整单入队 */
  async requeuePlaylist(id, { limit = 0, filterBlacklist = true } = {}) {
    const pl = await this.netease.playlist(id, { limit });
    if (!pl.ok) return { ok: false, msg: pl.msg || '歌单拉取失败' };
    const all = pl.tracks || [];
    const { kept, blocked } = filterBlacklist ? this.blacklist.filter(all) : { kept: all, blocked: [] };
    const queued = this.queueTracks(kept, `歌单《${pl.name}》`);
    const list = this.config.playlists.imported || [];
    const rec = list.find((x) => String(x.id) === String(id));
    if (rec) {
      rec.lastQueuedAt = Date.now();
      rec.fetched = all.length;
      rec.trackCount = pl.trackCount || rec.trackCount;
      rec.truncated = !!pl.truncated;
    }
    this.notify(pl.truncated ? 'warn' : 'info',
      `《${pl.name}》入队 ${queued}/${all.length} 首${pl.truncated ? `（歌单实际 ${pl.trackCount} 首 —— 网易云没给全，多半是没登录）` : ''}${blocked.length ? `（${blocked.length} 首被黑名单拦下）` : ''}`);
    return {
      ok: true, name: pl.name, queued, total: all.length,
      blockedCount: blocked.length, truncated: !!pl.truncated,
    };
  }

  removeImportedPlaylist(id) {
    const list = this.config.playlists.imported || [];
    const i = list.findIndex((x) => String(x.id) === String(id));
    if (i < 0) return { ok: false, msg: '没有这条导入记录' };
    const [removed] = list.splice(i, 1);
    this.emit('change');
    return { ok: true, playlist: removed };
  }

  // ================================================================ 播放流转
  /**
   * 下一首。行为由播放模式决定：
   *   order      队列 FIFO，空了就停（除非闲时歌单接着顶上）
   *   repeat-all 队列空了把历史重新排一遍，循环往复
   *   repeat-one 一直重播当前这首（用户显式切歌时传 force=true 才会真的换）
   *   shuffle    从队列里随机抽一首
   * 队列真的空了时会尝试**闲时歌单**顶上（如果开了）。
   */
  async next({ force = false } = {}) {
    // 切歌了 → 之前那轮"下一首预载"的计时器没意义了（结果会按 _loadSeq 丢掉）
    clearTimeout(this._preloadTimer);
    /**
     * **快照"即将被切走的这首是不是闲时/已保存歌单"**（2026-09-26 修）。
     *
     * 必须在这里存下来：下面队列空的时候会走闲时回退，而那段代码会
     * **先把 `this.playingIdle` 改成 true**，之后才调 `_rememberHistory()`。
     * 不先快照的话，一首**队列里**播的歌会被误判成"闲时曲"而漏记进「已播放」
     * （实测复现：队列刚放完一首、再切一下，那首歌就丢了）。
     */
    const wasIdle = this.playingIdle;
    // ---------------------------------------------------------------
    // 播放语义（按使用习惯定的，别混）：
    //   · **当前播放列表（点歌队列）永远是顺序播放** —— 点歌与"打开本地文件"
    //     一视同仁排队，播完就从列表移除、进"已播放"，手动切歌也算播完。
    //     队列不参与随机/循环。
    //   · **只要播的不是点歌队列里的歌，模式就生效** —— 闲时歌单、已保存歌单
    //     都属于这一类（顺序 / 单曲循环 / 随机 / 循环列表都能用）。
    //     判据是 this.playingIdle，见下方赋值处。
    // ---------------------------------------------------------------
    const idleMode = this.playMode;

    // 单曲循环：只在"播的不是点歌队列"时生效
    if (idleMode === 'repeat-one' && this.playingIdle && this.track && !force) {
      this.stats.played++;
      await this.load(this.track, this.trackMeta || {});
      return { song: this.track, repeat: true };
    }

    // ---- 取队列下一首（恒定顺序）
    let item = this.queue.next();

    // ---- 队列空了：先看闲时歌单，再看列表循环，最后才是停
    if (!item) {
      const idleItem = await this._nextIdleTrack();
      if (idleItem) {
        item = idleItem;
        this.playingIdle = true;
      } else if (idleMode === 'repeat-all' && this.history.length) {
        // 列表循环：把历史倒回队列（保留点歌人信息），清空历史避免再次递归
        const back = this.history.splice(0, this.history.length).reverse();
        for (const h of back) {
          this.queue.push(
            h.song,
            { uid: (h.meta && h.meta.requester && h.meta.requester.uid) || 'history', uname: (h.meta && h.meta.requester && h.meta.requester.uname) || '历史', isAnchor: true },
            { force: true },   // 内部回填：绕过去重，"刚放过"在这里是正常的
          );
        }
        item = this.queue.next();
        if (item) this.notify('info', `列表循环：已把 ${back.length} 首重新排入队列`);
      }
    }

    if (!item) {
      // 关键：递增载入序号，作废仍在飞行中的 load()，避免它晚到后把状态写回来
      this._loadSeq++;
      if (process.env.NEKOFM_TRACE === '1') this.log(`[engine] next: 队列空，作废在途载入 → seq=${this._loadSeq}`);
      this._rememberHistory(wasIdle);
      this.track = null;
      this.trackMeta = null;
      this.streamUrl = '';
      this.lyricTimeline = { meta: {}, lines: [] };
      this.lyricRev++;
      this.playingIdle = false;
      this.playback = { ...this.playback, status: 'idle', position: 0, duration: 0, error: '' };
      this.emit('player', { action: 'stop' });
      this.emit('change');
      return null;
    }

    this._rememberHistory(wasIdle);
    this.stats.played++;
    /**
     * 记录"这一首是不是点歌队列之外的曲目"（闲时歌单 / 已保存歌单）。
     * 播放模式只对**队列之外**的播放生效；从队列里取歌时必须把它重置，
     * 否则放完闲时曲再放点歌队列的歌，还会被当成闲时曲去套单曲循环。
     */
    this.playingIdle = !!(item.fromIdle || (item.song && !item.uid));
    await this.load(item.song, {
      requester: item.uid
        ? { uid: item.uid, uname: item.uname }
        : { uid: 'idle', uname: this.playingIdle ? '闲时歌单' : '' },
      requestedAt: item.requestedAt || Date.now(),
    });
    return item;
  }

  /**
   * 记录"当前这首已经放过了"（在 next() 里于切换**之前**调用）。
   *
   * 2026-09-26 按用户要求拆成两份记录：
   *   · `recentPlayed` —— **所有**播过的歌（含已保存歌单/闲时），
   *     只服务于闲时歌单的「近期不重复」
   *   · `history`      —— **只记点歌队列里播的歌**，这才是用户看到的「已播放」
   *
   * 判别依据是 `this.playingIdle`：调用时它描述的还是**即将被切走的这首**
   * 是不是"队列之外"的播放（next() 是在这之后才重新赋值的）。
   */
  _rememberHistory(wasIdle = this.playingIdle) {
    if (!this.track) return;
    const rec = { song: this.track, meta: this.trackMeta, at: Date.now() };

    // 全部播放记录（给 avoidRecent 用）
    this.recentPlayed.push(rec);
    if (this.recentPlayed.length > 100) this.recentPlayed.splice(0, this.recentPlayed.length - 100);

    // 用户可见的「已播放」：只记点歌队列的歌（已保存歌单/闲时播的不算）
    if (wasIdle) return;
    this.history.push(rec);
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);
  }

  /** 上一首：从历史里回退（顺手把当前这首塞回队列最前，便于再切回来） */
  async prev() {
    // 正在放闲时/已保存歌单 → 走**序列游标回退**，
    // 这样即使当前是随机播放，"上一首"也确定地回到同一首（用户明确要求）。
    if (this.playingIdle && this._idleSeq && this._idleIdx > 0) {
      const back = await this._prevIdleTrack();
      if (back) {
        this.stats.played++;
        await this.load(back.song, { requester: { uid: 'idle', uname: back.uname }, requestedAt: Date.now() });
        this.emit('change');
        return back.song;
      }
    }
    const last = this.history.pop();
    if (!last) { this.notify('warn', '已经是第一首了'); return null; }
    if (this.track) {
      this.queue.items.unshift({
        seq: 0, key: `hist-${Date.now()}`, song: this.track,
        uid: (this.trackMeta && this.trackMeta.requester && this.trackMeta.requester.uid) || 'history',
        uname: (this.trackMeta && this.trackMeta.requester && this.trackMeta.requester.uname) || '历史',
        requestedAt: Date.now(), isAdmin: false,
      });
      this.queue.emit('change', this.queue.list());
    }
    this.stats.played++;
    await this.load(last.song, last.meta || {});
    this.emit('change');
    return last.song;
  }

  // ================================================================ 播放模式
  setPlayMode(mode) {
    const allowed = ['order', 'repeat-all', 'repeat-one', 'shuffle'];
    if (!allowed.includes(mode)) return { ok: false, msg: '模式必须是 ' + allowed.join(' / ') };
    this.playMode = mode;
    // 换了模式就重建闲时序列：随机↔顺序 必须重排，"上一首"才有确定的落点
    this._idleSeq = null;
    this._idleIdx = -1;
    if (this.config.playback) this.config.playback.mode = mode;
    const label = { order: '顺序播放', 'repeat-all': '列表循环', 'repeat-one': '单曲循环', shuffle: '随机播放' }[mode];
    this.notify('info', `播放模式：${label}`);
    this.emit('change');
    return { ok: true, mode, label };
  }

  setMuted(muted) {
    this.muted = !!muted;
    this.config.player.muted = this.muted;   // 写回配置才会被记住（段名是 player）
    this.emit('player', { action: 'mute', muted: this.muted });
    this.emit('change');
    return { ok: true, muted: this.muted };
  }

  // ================================================================ 闲时歌单
  /**
   * 取下一首闲时曲目。没有任务、队列空时由 next() 调用。
   * 返回队列项形状的对象（uid='idle'），这样下游一视同仁。
   */
  /**
   * 取闲时歌单的曲池。
   *
   * **恒为「已保存播放列表」** —— 用户定的模型：
   * 不管歌来自网易云歌单、本地曲库还是收藏，都先"加入已保存"，
   * 再由这一个列表统一充当闲时歌单（所以这里不再按 source 分支）。
   */
  async _idlePoolTracks() {
    return (this.config.savedPlaylist || []).map((it) => it.song);
  }

  /** 早期按音源分支的实现，保留备查/将来扩展；闲时歌单不再走这里 */
  async _idlePoolTracksBySource() {
    const cfg = this.config.idle || {};
    if (cfg.source === 'local') return this.local.tracks.map((t) => ({ ...t, source: 'local' }));
    if (cfg.source === 'favorites') return (this.config.favorites || []).map((f) => f.song);
    if (cfg.source === 'saved' || !cfg.source) return (this.config.savedPlaylist || []).map((it) => it.song);
    // netease：用已导入的歌单
    const pid = cfg.playlistId;
    if (!pid) return [];
    if (!this._idlePoolCache || this._idlePoolCache.id !== String(pid)) {
      const pl = await this.netease.playlist(pid, { limit: 200 });
      if (!pl.ok) { this.log('[engine] 闲时歌单拉取失败:', pl.msg); return []; }
      this._idlePoolCache = { id: String(pid), name: pl.name, tracks: pl.tracks, at: Date.now() };
    }
    return this._idlePoolCache.tracks;
  }

  /**
   * 构建闲时歌单的**播放序列**。
   *
   * 为什么不每步随机抽：那样「上一首」没有确定落点 ——
   * 用户明确要求"随机播放时切上一首也要固定回到同一首"。
   * 固定序列 + 游标之后，上一首/下一首就是游标加减，两个方向都可复现。
   */
  async _idleSequence() {
    const cfg = this.config.idle || {};
    const pool = (await this._idlePoolTracks()).filter((s) => s && !this.blacklist.check(s).blocked);
    if (!pool.length) return [];
    let seq = pool.slice();
    /**
     * 是否打乱**只看播放模式**（模式按钮）。
     * 原来还看 idle.shuffle 这个独立开关，两个开关会互相打架：
     * 模式明明调成了"顺序"，闲时歌单却因为 idle.shuffle 默认为 true 还在随机，
     * "从第 N 首开始播"也落到意料之外的位置（实测踩到）。现在单一来源就是 playMode。
     */
    if (this.playMode === 'shuffle') {
      for (let i = seq.length - 1; i > 0; i--) {  // Fisher–Yates，一次性定序
        const j = Math.floor(Math.random() * (i + 1));
        [seq[i], seq[j]] = [seq[j], seq[i]];
      }
    }
    /**
     * 「近期不重复」对**顺序和随机都生效**：把最近放过的挪到序列末尾。
     * 原来只在顺序分支做了 —— 随机模式下这条设置等于没有（被测试抓出来）。
     */
    if (cfg.avoidRecent) {
      // 用 recentPlayed（含已保存歌单里刚放过的）—— 只用 history 的话，
      // 刚在已保存歌单里放过的那首下一轮会立刻被再抽到（用户会以为随机坏了）
      const recent = new Set(this.recentPlayed.slice(-(cfg.avoidRecent || 10)).map((h) => dedupeKeyOf(h.song)));
      if (recent.size) {
        seq = seq.filter((s) => !recent.has(dedupeKeyOf(s))).concat(seq.filter((s) => recent.has(dedupeKeyOf(s))));
      }
    }
    return seq;
  }

  /** 闲时序列的有效性签名：黑名单变了就必须重建（否则拉黑了还在放） */
  _idleSig() {
    const bl = this.blacklist.list();
    const cfg = this.config.idle || {};
    return `${bl.enabled}|${bl.rules.length}|${cfg.source}|${this.playMode}`;
  }

  /** 游标 +1：下一首闲时曲目 */
  async _nextIdleTrack() {
    const cfg = this.config.idle || {};
    if (!cfg.enabled) return null;
    // 序列是按"当时的曲池 + 当时的黑名单"建的；黑名单一改就必须重建，
    // 否则会出现"刚拉黑的歌还在放"（被测试抓出来过）
    if (this._idleSeqSig !== this._idleSig()) { this._idleSeq = null; this._idleIdx = -1; }
    if (!this._idleSeq || !this._idleSeq.length) {
      this._idleSeq = await this._idleSequence();
      this._idleSeqSig = this._idleSig();
      this._idleIdx = -1;
    }
    if (!this._idleSeq.length) return null;

    // 单曲循环：一直同一首
    if (this.playMode === 'repeat-one' && this._idleIdx >= 0) {
      return this._idleItem(this._idleSeq[this._idleIdx]);
    }
    this._idleIdx++;
    if (this._idleIdx >= this._idleSeq.length) {
      // 一轮放完 → 重开一轮（顺序/随机都重新定序）
      this._idleSeq = await this._idleSequence();
      this._idleIdx = 0;
    }
    const song = this._idleSeq[this._idleIdx];
    return song ? this._idleItem(song) : null;
  }

  /**
   * 把闲时游标**定位**到序列第 idx 项（0 起）并返回它。
   *
   * 为什么需要它、而不复用 `_nextIdleTrack()` 的"+1"约定（2026-09-26 修）：
   * `_nextIdleTrack()` 在**单曲循环**下会**直接返回当前游标项而不自增**
   * （那是对的 —— 它的语义就是"重播当前这首"）。而 `playSaved` 里原本写的是
   *   `this._idleIdx = idx - 1; await this._nextIdleTrack();`
   * 指望那次 `++` 把游标补到 idx —— **单曲循环下这个 ++ 被跳过了**，
   * 于是少走一格 → "点第 N 首播成第 N-1 首"。
   * 实测复现（点 1→甲、点 2→甲、点 3→乙…），用户报告的就是这个。
   *
   * 教训：**定位就是定位，别借用"前进一格"的接口。**
   */
  _seekIdle(idx) {
    if (!this._idleSeq || !this._idleSeq.length) return null;
    const i = Math.max(0, Math.min(Number(idx) || 0, this._idleSeq.length - 1));
    this._idleIdx = i;
    return this._idleItem(this._idleSeq[i]);
  }

  /** 游标 -1：上一首闲时曲目（随机模式下也能确定回到同一首） */
  async _prevIdleTrack() {
    if (!this._idleSeq || !this._idleSeq.length) return null;
    if (this._idleIdx <= 0) return null;
    this._idleIdx--;
    const song = this._idleSeq[this._idleIdx];
    return song ? this._idleItem(song) : null;
  }

  /**
   * 包装成一条"点歌队列之外"的播放项。
   *
   * 这里标的是**角色**（闲时歌单 = 队列空了自动顶上）。
   * 手动点「播放已保存歌单」时由 playSaved 自己把归属写成"已保存歌单" ——
   * 内容来自同一份列表，但用户看到的身份应当能区分。
   */
  _idleItem(song) {
    return {
      seq: 0, key: dedupeKeyOf(song), song,
      uid: 'idle', uname: '闲时歌单',
      requestedAt: Date.now(), isAdmin: false, fromIdle: true,
    };
  }

  setPlayModeIdle(patch = {}) {
    this.config.idle = { ...(this.config.idle || {}), ...patch };
    // 「随机顺序」与播放模式是同一件事：勾上=随机模式，取消=顺序模式。
    // 两个独立开关会互相打架（模式设为顺序却还在随机），所以同步掉。
    if (patch.shuffle !== undefined) {
      this.playMode = patch.shuffle ? 'shuffle' : 'order';
      if (this.config.playback) this.config.playback.mode = this.playMode;
    }
    this._idlePoolCache = null; // 配置变了就丢弃缓存的歌单
    // 音源/顺序变了 → 重建播放序列（否则还是老顺序）
    this._idleSeq = null;
    this._idleIdx = -1;
    if (this.config.idle.enabled) {
      const label = { netease: '网易云歌单', local: '本地曲库', favorites: '我的收藏' }[this.config.idle.source] || this.config.idle.source;
      this.notify('info', `闲时歌单已开启（来源：${label}）`);
    } else {
      this.notify('info', '闲时歌单已关闭');
    }
    // 现在没歌在放、队列也空 → 立刻顶上，不用等下一次切歌
    if (this.config.idle.enabled && !this.track && this.queue.items.length === 0) {
      this.next().catch(() => {});
    }
    this.emit('change');
    return { ok: true, idle: this.config.idle };
  }

  /**
   * 把 config.queue 里的点歌规则同步到运行中的队列。
   * 不加这个的话，用户在控制台改了"每人上限/允许重复点歌"要重启才生效 ——
   * 而这类设置恰恰是直播中随时要调的。
   */
  applyQueueConfig() {
    const q = this.config.queue || {};
    const Q = this.queue;
    if (q.maxSize != null) Q.maxSize = q.maxSize;
    if (q.perUserMax != null) Q.perUserMax = q.perUserMax;
    if (q.cooldownMs != null) Q.cooldownMs = q.cooldownMs;
    if (q.dedupeWindowMs != null) Q.dedupeWindowMs = q.dedupeWindowMs;
    Q.allowDuplicate = !!q.allowDuplicate;
    Q.privileged = new Set((q.privilegedUids || []).map(String));
    return { ok: true, config: { maxSize: Q.maxSize, perUserMax: Q.perUserMax, cooldownMs: Q.cooldownMs, allowDuplicate: Q.allowDuplicate } };
  }

  // ================================================================ 直播状态 / 已保存歌单
  /**
   * 直播状态切换：**直播中 / 未直播**。
   *
   * 语义（2026-09-26 按用户要求定稿）：
   *   · 切到**未直播** → **不动「已保存播放列表」**，只换状态（见下面的详细说明）
   *   · 切到**直播中** → 把「已保存播放列表」当作闲时歌单：当前队列空了就接着放
   *
   * **「已保存播放列表」是手动维护的**：只有点列表项旁边的「加入已保存」才往里加。
   * 下播不再自动写入（曾经自动覆盖、后来自动并入，用户最终明确说只要手动的）。
   */
  setStreaming(on) {
    const want = !!on;
    // 注意：这里**不**提前返回。虽然"下播"已经不再写列表了，但状态切换本身
    // （streaming → false、闲时指向、通知）仍要照做，否则界面会与实际不一致。

    if (!want) {
      /**
       * 下播**不改动「已保存播放列表」**（2026-09-26 用户明确要求）。
       *
       * 演进过程（记下来免得绕回去）：
       *   1. 最初：`savedPlaylist = 本次队列+在放` —— **覆盖**。
       *      后果：已保存列表里积累的整份曲库被本次点过的几首冲掉
       *      （用户报告："结束直播状态时直接会把已保存的歌曲清理掉"）。
       *   2. 一度改成**并入**（保留旧的 + 追加本次没见过的）——
       *      不再丢数据了，但仍然是"自动"往里塞。
       *   3. **现在（用户定的）**：这个列表是**手动维护**的 ——
       *      只有点「加入已保存」才往里加，下播时不自动动它。
       *
       * 所以这里只做状态切换 + 如实汇报本次范围，**不写 savedPlaylist**。
       */
      const session = this.queue.items.length + (this.track ? 1 : 0);
      const total = (this.config.savedPlaylist || []).length;
      this.streaming = false;
      this.notify('info', session
        ? `已切到「未直播」：本次播放列表 ${session} 首（已保存列表保持 ${total} 首不变；`
          + `想留下某首请点它旁边的「加入已保存」）`
        : `已切到「未直播」：已保存列表保持 ${total} 首不变`);
    } else {
      this.streaming = true;
      const saved = this.config.savedPlaylist || [];
      // 进入直播中：闲时歌单 = 已保存播放列表。**无条件**指向它 ——
      // 列表为空时也要（否则之后往已保存里加歌，闲时仍走在旧的来源分支上，取不到曲）
      this.config.idle = { ...(this.config.idle || {}), enabled: true, source: 'saved', playlistId: '' };
      // 闲时池也要失效：列表可能刚被改过（上面的 _idleSeq 只清序列，不清来源池）
      this._idleSeq = null; this._idleIdx = -1; this._idleSeqSig = null; this._idlePoolCache = null;
      if (saved.length) {
        this.notify('info', `已切到「直播中」：已保存的 ${saved.length} 首将作为闲时歌单`);
        /**
         * **本来空着就立刻开播**（2026-09-26 用户要求）。
         *
         * 旧行为只把闲时指向已保存列表、写明"队列空了自动接着放" —— 但如果此刻
         * 什么都没在播，**没有任何事件去触发它**：界面一直空着，主播只能手动点一首，
         * 而直播中点了还会被 `playSavedGuard` 拒绝。用户的两条反馈正是这么来的
         * （"打开直播状态应该直接开始自动播闲时歌单才对"）。
         *
         * 条件卡在"真空闲"：有歌在播（或放着暂停）就不动它，别打断主播。
         */
        /**
         * 判据只看 `!this.track`（**别再看 `playback.status === 'idle'`**）。
         *
         * 为什么：status 会因为各种原因残留（清队列、换曲失败、测试里手工重置），
         * 而"当前有没有一首歌"这件事只有 `this.track` 说了算。用 status 判会让
         * "track 已空但 status 还写着 playing"的场合漏掉自动开播 —— 测试就抓到了这个
         * （清空曲目后 status 残留 playing → 切直播什么都不发生）。
         * 反过来 track 有值时不自动开播，正好也保护了"加载中/错误/暂停"这些正在处理
         * 某首歌的状态（load 一进来就设 track，所以载入中同样不会被抢）。
         */
        if (!this.track) {
          this.log('[engine] 切到直播中且当前空闲 → 立即开始播闲时歌单');
          this.next().catch((e) => this.log('[engine] 自动开播失败:', e.message));
        }
      } else {
        this.notify('info', '已切到「直播中」：暂无已保存的播放列表');
      }
    }
    this.emit('change');
    return { ok: true, streaming: this.streaming, saved: (this.config.savedPlaylist || []).length };
  }

  /**
   * 按**去重键**在"正在播放 + 待播队列"里回查那首歌。
   *
   * 为什么需要它（2026-09-26 修）：控制台的队列项来自 `queue.list()` →
   * `_brief()`，那里**只有精简字段、没有完整 song 对象**（刻意保持状态载荷小）。
   * 于是「加入已保存」按钮发 `song: it.song` 时拿到的是 `undefined`，
   * 服务端只能回"没有可加入的曲目"—— 点了永远不生效（用户报告）。
   * 现在按钮改发 `key`，由这里在服务端回查，**待播项和在放项都能命中**。
   */
  findQueueSong(key) {
    if (!key) return null;
    if (this.queue.current && this.queue.current.key === key) return this.queue.current.song;
    const hit = this.queue.items.find((i) => i.key === key);
    return hit ? hit.song : null;
  }

  /** 已保存播放列表（下播时自动存下来的那份） */
  listSaved() {
    return (this.config.savedPlaylist || []).map((it) => ({
      name: it.song && (it.song.name || it.song.title),
      artistText: it.song && it.song.artistText,
      source: it.song && it.song.source,
      uname: it.uname,
      song: it.song,
    }));
  }

  /** 把已保存列表整份排进当前队列（想接着上次的继续点就用它） */
  queueSaved({ clearFirst = false } = {}) {
    const saved = this.config.savedPlaylist || [];
    if (!saved.length) return { ok: false, msg: '还没有已保存的播放列表（下播时会自动保存）' };
    if (clearFirst) this.queue.clear();
    let n = 0;
    for (const it of saved) {
      const r = this.queue.push(it.song, { uid: it.uid || 'saved', uname: it.uname || '已保存', isAnchor: true }, { force: true });
      if (r.ok) n++;
    }
    this.notify('info', `已把 ${n} 首已保存曲目排入当前队列`);
    this.emit('change');
    return { ok: true, queued: n, total: saved.length };
  }

  /**
   * **把「已保存播放列表」当成一张本地歌单直接播放。**
   *
   * 与"闲时歌单"的区别在于触发方式：闲时是"队列空了自动顶上"，
   * 这里是你主动按播放 —— 待机状态想放点东西时用。
   *
   * 因为它属于"点歌队列之外"的播放，所以播放模式（顺序/单曲/随机）
   * 与上一首/下一首全都生效，和闲时歌单走的是同一套序列与游标。
   *
   * @param {{from?:number}} opts from=从第几首开始（1 起）
   */
  /**
   * `playSaved` 的**同步前置检查**。
   *
   * 为什么单独抽出来（2026-09-26 修）：`playSaved` 走的是"立刻回执 +
   * 后台慢慢加载"（见 commands.js 的 fireAndForget 注释）。这样一来
   * **凡是在 await 之前就能判断的失败，都会被那个回执吞掉** ——
   * 用户点「播放已保存歌单」，按钮变一下、然后什么都不发生，也没有任何提示。
   * 抽成同步函数后，命令层可以在回执之前先问一次，把原因**如实**返回给界面。
   * 文案只留这一处，避免命令层抄一份、以后改一处忘一处。
   *
   * @returns {null|{ok:false, msg:string}} 通过检查返回 null
   */
  playSavedGuard() {
    if (!(this.config.savedPlaylist || []).length) {
      return { ok: false, msg: '「已保存播放列表」是空的（点列表里的「加入已保存」往里加歌）' };
    }
    /**
     * 直播中的自由度**仅限闲时**（2026-09-26 用户定的规则）。
     *
     * 直播中「已保存播放列表」就是闲时歌单，用户要的是"**闲时歌单里自由挑一首**"。
     * 但**点歌队列优先于闲时歌单**（见 6g 的用例）：如果此刻正在播的是观众点的歌，
     * 手动抢播就等于把观众的点歌顶掉 —— 那不是"自由选曲"，是打断别人。所以那种情况
     * 仍然拒绝，等回到闲时再选。
     *
     * 放行集合：
     *   · 未直播（这张列表就是普通歌单，怎么点都行）
     *   · 直播中 + 正在播闲时歌单（`playingIdle`）
     *   · 直播中 + 什么都没在播（闲时逻辑马上会接管，手动选一首等于选了开头那首）
     *
     * 历史（别绕回去）：更早的规则是"直播中一律不可单独播放"，那太严 ——
     * 主播想听某首只会收到"请先切到未直播"，而切状态代价太大（用户反馈过）。
     */
    if (this.streaming && this.track && !this.playingIdle) {
      return { ok: false, msg: '现在播的是观众点的歌（点歌优先），要自由选曲请等闲时歌单接管后' };
    }
    return null;
  }

  async playSaved({ from = 1 } = {}) {
    const guard = this.playSavedGuard();
    if (guard) return guard;
    const list = this.config.savedPlaylist || [];

    /**
     * 连点处理：**不拒绝，最新一次赢**（2026-09-26 改）。
     *
     * 原来这里是"忙就返回错误"。问题在于：走 HTTP 的调用方走的是
     * fireAndForget（立刻回执 accepted），那个拒绝**根本传不到界面**，
     * 于是用户连点第 2 首时看到的是"点了没反应，还在放第 1 首"。
     *
     * 现在 `load()` 已经会**真的 abort** 掉上一次在飞的载入（见 load() 注释），
     * 所以并发是安全的：最后一次点击会抢占前面所有。这也正是播放器该有的
     * 语义（latest wins）。只保留计数用于诊断。
     */
    this._playSavedSeq = (this._playSavedSeq || 0) + 1;
    // 「播放某一首」是显式播放入口 → 清掉之前的暂停意图
    this._pausePending = false;

    // 把闲时音源指向"已保存"，并重建序列
    this.config.idle = { ...(this.config.idle || {}), enabled: true, source: 'saved', playlistId: '' };

    {
      this._idleSeq = null;
      this._idleIdx = -1;
      this._idleSeqSig = null;
      this._idlePoolCache = null;

      /**
       * 「从第 N 首开始播」—— 这里的 from 是**用户在「已保存播放列表」里看到的
       * 行号**（1 起），不是闲时序列的下标。
       *
       * 踩过的坑（2026-09-26）：直接把 from 当序列下标用 → 播放模式和列表行号
       * 对不上，点第 3 条可能放第 7 条，而且**每次点都不一样**。原因是闲时序列
       * 还经过三道变换：
       *   1) 黑名单过滤（少歌 → 下标整体前移）
       *   2) 随机模式下 Fisher-Yates 打乱（每次重建顺序都不同！）
       *   3) avoidRecent 把最近放过的挪到末尾
       * 正确做法：先按行号取出**用户点的那首歌**，再用 dedupeKey 在序列里定位它。
       * 这样"点哪条就放哪条"，且播放模式（顺序/随机）只影响**之后**的走向。
       */
      const seq = await this._idleSequence();
      if (!seq.length) return { ok: false, msg: '取不到可播放的曲目（可能全被黑名单过滤了）' };
      this._idleSeq = seq;
      this._idleSeqSig = this._idleSig();

      const wantIdx = Math.max(1, Math.min(Number(from) || 1, list.length));
      const wantSong = (list[wantIdx - 1] || {}).song;
      const wantKey = wantSong ? dedupeKeyOf(wantSong) : null;
      let idx = wantKey ? seq.findIndex((s) => dedupeKeyOf(s) === wantKey) : -1;
      if (idx < 0) {
        // 兜底：那首歌被黑名单滤掉了 / 键对不上 —— 退回按行号夹取，至少不崩
        idx = Math.max(0, Math.min(wantIdx - 1, seq.length - 1));
        this.log(`[engine] playSaved：第 ${wantIdx} 条不在可播序列里（可能被拉黑），退到第 ${idx + 1} 条`);
      }
      /**
       * 直接**定位**到那一首（不要走 `_nextIdleTrack` 的"+1"约定 ——
       * 单曲循环下它不自增，会少走一格，见 `_seekIdle` 的注释）。
       */
      const item = this._seekIdle(idx);
      if (!item) return { ok: false, msg: '取不到可播放的曲目（可能全被黑名单过滤了）' };

      this.playingIdle = true;
      this.stats.played++;
      await this.load(item.song, {
        requester: { uid: 'idle', uname: '已保存歌单' },
        requestedAt: Date.now(),
      });
      // 注意：**不要**在这里手动 push recentPlayed —— 下次切走时
      // `_rememberHistory()` 会记它，这里再记一次就会重复（实测踩到）。
      this.notify('info', `开始播放「已保存播放列表」（第 ${idx + 1}/${seq.length} 首：${item.song.name || item.song.title}）`);
      this.emit('change');
      return { ok: true, total: seq.length, from: idx + 1, playing: item.song.name || item.song.title };
    }
  }

  // ------------------------------------------------ 列表项管理（各列表共用）
  /**
   * 把一首歌加入「已保存播放列表」（也就是闲时歌单的来源）。
   * 任何列表里的条目都能这么加 —— 已播放里听到好听的可以直接留到下一场。
   */
  savedAdd(song, meta = {}) {
    if (!song) return { ok: false, msg: '没有可加入的曲目' };
    const list = this.config.savedPlaylist || (this.config.savedPlaylist = []);
    const key = dedupeKeyOf(song);
    if (list.some((it) => dedupeKeyOf(it.song) === key)) {
      return { ok: false, msg: '已经在已保存播放列表里了' };
    }
    list.push({ song, uid: meta.uid || '', uname: meta.uname || '', requestedAt: Date.now() });
    this.emit('change');
    return { ok: true, count: list.length, name: song.name || song.title };
  }

  /**
   * **批量加入「已保存播放列表」**。
   * 设计前提（用户定的）：不管来源是网易云歌单、本地曲库还是收藏，
   * 一律汇入这一个列表 —— 它才是"闲时歌单"的唯一内容来源。
   */
  savedAddMany(songs, meta = {}) {
    const list = this.config.savedPlaylist || (this.config.savedPlaylist = []);
    const have = new Set(list.map((it) => dedupeKeyOf(it.song)));
    let added = 0;
    let dup = 0;
    for (const song of songs || []) {
      if (!song) continue;
      const k = dedupeKeyOf(song);
      if (have.has(k)) { dup++; continue; }
      have.add(k);
      list.push({ song, uid: meta.uid || '', uname: meta.uname || '', requestedAt: Date.now() });
      added++;
    }
    this._idleSeq = null;
    this._idleIdx = -1;
    this._idleSeqSig = null;
    this.emit('change');
    return { ok: true, added, dup, count: list.length };
  }

  /**
   * 从某个来源整批拉进「已保存播放列表」。
   * @param {'favorites'|'local'|'playlist'} source
   */
  async savedPullFrom(source, { playlistId = '' } = {}) {
    let songs = [];
    let label = '';
    if (source === 'favorites') {
      songs = (this.config.favorites || []).map((f) => f.song);
      label = '我的收藏';
    } else if (source === 'local') {
      songs = this.local.tracks.map((t) => ({ ...t, source: 'local' }));
      label = '本地曲库';
    } else if (source === 'playlist') {
      const pid = playlistId || (this.config.playlists && this.config.playlists.imported && this.config.playlists.imported[0] && this.config.playlists.imported[0].id);
      if (!pid) return { ok: false, msg: '还没有导入过歌单' };
      const pl = await this.netease.playlist(pid, { limit: 0 });
      if (!pl.ok) return { ok: false, msg: pl.msg || '歌单拉取失败' };
      songs = pl.tracks;
      label = pl.name || '已导入歌单';
      if (pl.truncated) {
        this.notify('warn', `《${pl.name}》只取到 ${pl.fetched}/${pl.trackCount} 首（多半是没登录网易云）`);
      }
    } else {
      return { ok: false, msg: '未知来源：' + source };
    }
    if (!songs.length) return { ok: false, msg: `${label}里没有曲目` };
    const r = this.savedAddMany(songs, { uname: label });
    this.notify('info', `已从「${label}」加入已保存播放列表：新增 ${r.added} 首${r.dup ? `，跳过重复 ${r.dup} 首` : ''}（共 ${r.count} 首）`);
    return { ...r, source, label };
  }

  /** 按序号从「已保存播放列表」移除 */
  savedRemoveAt(index) {
    const list = this.config.savedPlaylist || [];
    const i = Number(index) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= list.length) return { ok: false, msg: '序号不对' };
    const [removed] = list.splice(i, 1);
    this.emit('change');
    return { ok: true, removed: removed.song && (removed.song.name || removed.song.title) };
  }

  /** 按序号从「已播放列表」移除（只影响历史，不动队列） */
  historyRemoveAt(index) {
    const i = Number(index) - 1;
    const len = this.history.length;
    if (!Number.isInteger(i) || i < 0 || i >= len) return { ok: false, msg: '序号不对' };
    // 列表是倒序展示的（最近在前），所以要把展示序号换算回内部下标
    const real = len - 1 - i;
    const [removed] = this.history.splice(real, 1);
    this.emit('change');
    return { ok: true, removed: removed.song && (removed.song.name || removed.song.title) };
  }

  /**
   * 对任意一首歌拉黑（不必先入队）。
   * type: song(按平台 ID 或本地路径) | keyword(标题关键词) | artist(歌手) | bvid
   * 这三种粒度在"已播放/已保存"里同样需要 —— 听到不合适的直接连歌手一起拉黑。
   */
  blacklistSong(song, type = null) {
    if (!song) return { ok: false, msg: '没有可拉黑的曲目' };
    let r;
    if (type === 'keyword') {
      r = this.blacklist.add({ type: 'keyword', value: song.name || song.title, note: '来自列表操作' });
    } else if (type === 'artist') {
      const a = (song.artists || [])[0];
      if (!a) return { ok: false, msg: '这首没有歌手信息' };
      r = this.blacklist.add({ type: 'artist', value: a, note: '来自列表操作' });
    } else {
      r = this.blockTrack(song, { note: '来自列表操作' });
    }
    if (r.ok) this.syncBlacklistToConfig();
    this.emit('change');
    return r;
  }

  clearSaved() {
    const n = (this.config.savedPlaylist || []).length;
    this.config.savedPlaylist = [];
    this.emit('change');
    return { ok: true, removed: n };
  }

  /** 已播放列表（从当前播放列表里播完的，最近的在前） */
  listHistory(limit = 200) {
    return this.history.slice(-limit).reverse().map((h) => ({
      name: h.song && (h.song.name || h.song.title),
      artistText: h.song && h.song.artistText,
      source: h.song && h.song.source,
      uname: (h.meta && h.meta.requester && h.meta.requester.uname) || '',
      at: h.at,
      song: h.song,
    }));
  }

  /** 清空已播放列表（不影响队列） */
  clearHistory() {
    const n = this.history.length;
    this.history = [];
    this.recentPlayed = [];   // 「已播放」清了，"近期不重复"的底账也该一起清
    this.emit('change');
    return { ok: true, removed: n };
  }

  /** 切换缓存目录（音频/封面/歌词都在它下面）；返回新目录与统计 */
  setCacheDir(dir) {
    const next = (dir || '').trim();
    this.config.cache = { ...(this.config.cache || {}), dir: next };
    const resolved = resolveCacheDir(this.config);
    if (path.resolve(resolved) === path.resolve(this.cache.dir || '')) {
      return { ok: true, dir: resolved, unchanged: true };
    }
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (e) {
      return { ok: false, msg: `目录不可用（${e.message}）：${resolved}` };
    }
    // 换目录 = 换一个缓存实例；旧目录的文件保留不动（用户的东西不替他删）
    this.cache = new MediaCache({
      dir: resolved,
      enabled: this.config.cache.enabled !== false,
      maxBytes: (this.config.cache.maxMB || 2048) * 1024 * 1024,
      maxFileBytes: (this.config.cache.maxFileMB || 120) * 1024 * 1024,
      log: this.log,
    });
    this.cache.init();
    this.notify('info', `缓存目录已切换到：${resolved}（旧目录的文件保留未动）`);
    this.emit('change');
    return { ok: true, dir: resolved };
  }

  /**
   * 切歌。权限规则（可按需配置）：
   *   · 主播 / 房管 → 随便切
   *   · **点歌本人 → 只能切自己点的那首**（默认开启 ownOnly）
   *   · 其他人 → 只能由用户在工具本地（控制台 / HTTP 本地调用）切
   * @param {{uid?:any, uname?:string, isAdmin?:boolean, isAnchor?:boolean}} user
   * @param {{local?:boolean, force?:boolean}} [opts] local=true 表示"本工具内部操作"，无条件放行
   */
  async skip(user = {}, { local = false, force = false } = {}) {
    // 切歌是"我要听下一首"的显式意图 → 清掉 loading 期间留下的暂停意图
    this._pausePending = false;
    const ownOnly = !this.config.queue || !this.config.queue.danmakuSkip
      || this.config.queue.danmakuSkip.ownOnly !== false;

    if (!local) {
      const isManager = this.queue.canManage(user);
      if (!isManager) {
        const owner = this.trackMeta && this.trackMeta.requester;
        const isOwner = ownOnly && owner && owner.uid != null && String(owner.uid) === String(user.uid);
        if (!isOwner) {
          const who = owner && owner.uname ? `（这首是「${owner.uname}」点的）` : '';
          this.notify('warn', `${user.uname || '观众'}：只有点歌本人或主播能切这首${who}`);
          return { ok: false, reason: 'not_owner', msg: '只有点歌本人或主播能切' };
        }
        this.notify('info', `${user.uname}：切掉自己点的歌`);
      }
    }

    this.stats.skipped++;
    if (local) this.notify('info', `${user.uname || '控制台'}：切歌`);
    const nextItem = await this.next({ force: true });
    // 统一返回结构：调用方要看的是"切歌有没有被允许"，
    // 而不是"下一首存不存在"（队列正好空了时 next 返回 null，别有歧义）
    return { ok: true, skipped: true, next: nextItem, nowPlaying: this.track ? (this.track.name || this.track.title) : null };
  }

  // ================================================================ 收藏
  /** 收藏/取消收藏（收藏列表可当闲时歌单音源） */
  toggleFavorite(song) {
    if (!song) return { ok: false, msg: '没有可收藏的曲目' };
    const list = this.config.favorites || (this.config.favorites = []);
    const key = dedupeKeyOf(song);
    const i = list.findIndex((f) => dedupeKeyOf(f.song) === key);
    if (i >= 0) {
      const [removed] = list.splice(i, 1);
      this.notify('info', `已取消收藏《${removed.song.name || removed.song.title}》`);
      this.emit('change');
      return { ok: true, favorited: false };
    }
    list.push({ song, addedAt: Date.now() });
    this.notify('info', `已收藏《${song.name || song.title}》`);
    this.emit('change');
    return { ok: true, favorited: true };
  }

  isFavorited(song) {
    if (!song) return false;
    const key = dedupeKeyOf(song);
    return (this.config.favorites || []).some((f) => dedupeKeyOf(f.song) === key);
  }

  listFavorites() {
    return (this.config.favorites || []).slice().reverse().map((f) => ({
      name: f.song.name || f.song.title, artistText: f.song.artistText,
      source: f.song.source, cover: this.coverUrlFor(f.song), addedAt: f.addedAt, song: f.song,
    }));
  }

  // ================================================================ 队列操作
  /** 把队列里的某一项置顶/上移/下移（index 为 1-based 队列序号） */
  moveInQueue(index, where = 'top') {
    const items = this.queue.items;
    if (!Number.isInteger(index) || index < 1 || index > items.length) {
      return { ok: false, msg: '序号不对' };
    }
    const [it] = items.splice(index - 1, 1);
    if (where === 'top') items.unshift(it);
    else if (where === 'up') items.splice(Math.max(0, index - 2), 0, it);
    else if (where === 'down') items.splice(Math.min(items.length, index), 0, it);
    else if (where === 'bottom') items.push(it);
    else return { ok: false, msg: 'where 必须是 top/up/down/bottom' };
    this.queue.emit('change', this.queue.list());
    this.emit('change');
    return { ok: true, item: this.queue._brief(it) };
  }

  /**
   * 从队列某一项直接拉黑。
   * type: song(默认按平台ID) | keyword(标题关键词) | artist(歌手) | bvid
   */
  blacklistFromQueue(index, type = null) {
    const it = this.queue.items[index - 1];
    if (!it) return { ok: false, msg: '序号不对' };
    const song = it.song;
    let r;
    if (type === 'keyword') {
      r = this.blacklist.add({ type: 'keyword', value: song.name || song.title, note: `来自队列第 ${index} 项` });
    } else if (type === 'artist') {
      const a = (song.artists || [])[0];
      if (!a) return { ok: false, msg: '这首没有歌手信息' };
      r = this.blacklist.add({ type: 'artist', value: a, note: `来自队列第 ${index} 项` });
    } else {
      r = this.blockTrack(song, { note: `来自队列第 ${index} 项` });
    }
    if (!r.ok) return r;
    this.syncBlacklistToConfig();
    // 不论哪种类型，都顺手把这一项从队列里摘掉 ——
    // 拉黑的本意就是不想让它播（第一版只在默认分支做了，另外两种漏了）
    const removed = this.queue.remove(index, { isAdmin: true });
    this.emit('change');
    return { ...r, removedFromQueue: removed.ok };
  }

  /** 解析曲目为可播放流 + 取歌词，然后命令播放器窗口加载 */
  async load(song, meta = {}) {
    /**
     * **真正打断上一次仍在飞的载入**（2026-09-26）。
     *
     * 用户明确要求："播放的时候如果还在缓存没出来的话有后续新的输入就中断
     * 当前任务响应后续操作 —— 这个是本地控制，一定要实时响应。"
     *
     * 光靠 `_loadSeq` 只是"晚到的结果丢弃"，底层 HTTP 请求还在跑、还占着
     * 连接（浏览器对同一 host 只有 6 条并发）。必须**真的 abort** 掉，
     * 把连接立刻释放，新操作才排得进去。
     *
     * 链路：AbortController → netease.currentSignal → `_fetch` 的 fetch(signal)
     * → Node 层直接掐掉 TCP 请求。
     */
    if (this._loadAbort) { try { this._loadAbort.abort(); } catch { /* 忽略 */ } }
    this._loadAbort = new AbortController();
    if (this.netease) this.netease.currentSignal = this._loadAbort.signal;

    // 载入序号：双保险（abort 不保证每个异步分支都立刻退出）
    const seq = ++this._loadSeq;
    if (process.env.NEKOFM_TRACE === '1') this.log(`[engine] load seq=${seq}`, song.name || song.title, 'meta=' + JSON.stringify(meta && meta.requester || null));
    const stale = () => seq !== this._loadSeq;

    this.track = song;
    // 谁点的、什么时候开始播 —— 信息栏要显示，重开时也算一次
    this.trackMeta = {
      requester: meta.requester || { uid: null, uname: '' },
      requestedAt: meta.requestedAt || Date.now(),
      startedAt: Date.now(),
    };
    this.playback = { ...this.playback, status: 'loading', position: 0, duration: song.duration || 0, error: '' };
    this.streamUrl = '';
    this.lyricTimeline = { meta: {}, lines: [] };
    this.lyricRev++;
    this.emit('change');

    try {
      // 本地曲目：先把封面准备好（侧车图 → 内嵌抽取并缓存），否则信息栏没图
      if (song.source === 'local' && song.file && this.local.prepareCover) {
        this.local.prepareCover(song.file).catch(() => {});
      }

      /**
       * **取流与取歌词并行，但开播只等取流**（2026-09-26 改）。
       *
       * 原来写的是 `await Promise.all([取流, 取歌词])` —— 开播要等**两者都**回来。
       * 实测：直连取流 259ms / 取歌词 423ms（浏览器通道更慢）；
       * 也就是**白白多等一步**（用户问："老点歌机基本秒播，是不是有分段加载？"）。
       *
       * 现在：流一到就 emit play（立刻出声），歌词拿到再补时间轴 ——
       * 叠加层与底部歌词条都按 `lyricRev` 重推，晚到完全看不出来。
       */
      const streamPromise = this.resolveStream(song);
      const lyricPromise = this.resolveLyrics(song).catch((e) => {
        this.log('[engine] 歌词获取失败', e.message);
        return null;
      });
      const stream = await streamPromise;

      // 被更新的载入请求取代：这本身是正常的（用户切歌了）。
      // 但**绝不能静默** —— 原来只写日志，于是"引擎显示在播放、其实什么都没放"
      // 这种状态在界面上完全看不出来（我为此排查了很久）。
      // 现在带上序号，并在 trace 下给出提示，便于定位是谁触发了新的载入。
      if (stale()) {
        this.log(`[engine] 丢弃过期载入 seq=${seq}/${this._loadSeq}:`, song.name || song.title);
        if (process.env.NEKOFM_TRACE === '1') {
          this.notify('warn', `载入被更新的请求取代：${song.name || song.title}（seq ${seq} → ${this._loadSeq}）`);
        }
        return;
      }

      if (!stream.ok) {
        // 被用户的新操作打断（code -4）→ 安静放弃，不报错也不跳歌
        if (stream.code === -4) {
          this.log(`[engine] 载入被新操作打断，放弃：${song.name || song.title}`);
          return;
        }
        this.playback = { ...this.playback, status: 'error', error: stream.msg };
        this.notify('error', `《${song.name || song.title}》：${stream.msg}`);
        this.emit('change');
        // 自动跳到下一首，避免卡死队列
        setTimeout(() => this.next().catch(() => {}), 1200);
        return;
      }
      if (stream.trial) {
        this.notify('warn', `《${song.name}》是会员曲，当前仅 45 秒试听 —— 请在控制台扫码登录网易云`);
      }

      this.streamUrl = stream.url;
      this.streamInfo = {
        level: stream.level, br: stream.br, via: stream.via, trial: stream.trial,
        quality: stream.quality, cached: !!stream.cached,
      };

      // 后台落盘缓存：**不阻塞播放**。首次仍走远端直链（立刻出声），
      // 下载在后台进行；下次播放这首歌就直接读本地文件。
      // 注意：试听片段（trial）绝不缓存，否则以后永远只能放那 45 秒。
      const ck = this.cache.keyFor(song);
      if (ck && !stream.cached && !stream.trial && stream.cacheSrc && this.config.cache && this.config.cache.enabled !== false) {
        this.cache.put(ck, stream.cacheSrc.url, {
          headers: stream.cacheSrc.headers,
          name: song.name || song.title, artist: song.artistText, source: song.source,
        }).then((res) => {
          if (res.ok && !res.skipped) this.log(`[engine] 《${song.name}》已缓存到本地`);
        }).catch(() => { /* 缓存失败不影响播放 */ });
      }
      /**
       * startPaused（2026-09-26 修）：用户可能在**解析直链期间**就按了暂停。
       * 旧行为：pause() 作用在**旧 audio** 上（那时新 src 还没设），等 load 完成
       * 再 emit play → audio.play() 把用户的暂停直接覆盖掉。表现出来就是
       * "点了暂停没反应，歌照样放"。
       * 现在把待播意图一起传下去，player.js 见到 startPaused 就只装源不播。
       */
      this.emit('player', {
        action: 'play',
        url: stream.url,
        track: song,
        volume: this.playback.volume,
        deviceId: this.playback.deviceId,
        startPaused: !!this._pausePending,
        /**
         * **带上载入序号**（2026-09-26 加）：播放核心把它回填到每一次
         * playerStatus / playerPosition 上报里，engine 用它做**精确的过期判定** ——
         * 序号不是当前的，说明那份状态属于上一首，一律忽略。
         *
         * 为什么不用"状态字符串白名单"了：那套会误伤合法转移 ——
         * 音频**中途开始缓冲**时播放核心会报 `waiting`→loading，而白名单不允许
         * `playing → loading`，于是引擎一直显示 playing，实际没在响
         * （用户报告："歌词看见了但是一直卡着没播放，播放状态看着是 playing"）。
         */
        seq,
      });
      if (this._pausePending) this.playback = { ...this.playback, status: 'paused' };
      this.emit('change');

      /**
       * 歌词**晚到**：拿到再补时间轴。这中间界面显示"歌词 0 行"，
       * 通常几百毫秒后就填上（比"等歌词才出声"体验好得多）。
       * 被更新的载入取代（stale）就丢弃 —— 别把上一首的歌词贴到新歌上。
       */
      lyricPromise.then((lyrics) => {
        if (stale()) return;
        if (lyrics) {
          this.lyricTimeline = lyrics.timeline;
          this.lyricSource = lyrics.source;
        } else {
          this.lyricSource = 'none';
          this.lyricTimeline = { meta: {}, lines: [] };
        }
        this.lyricRev++;
        this.emit('change');
      }).catch(() => { /* resolveLyrics 已 catch，这里兜底 */ });

      /**
       * 预载下一首（AIMP 的 "Pre-load next track while current is playing"）。
       * 延后 1.2s 再开始：先把当前这首的播放稳定下来，
       * 别让预载的请求跟"刚开始播"抢带宽和连接。
       * 用 setTimeout 而不是 await —— 预载绝不能拖慢当前这首的开播。
       */
      clearTimeout(this._preloadTimer);
      this._preloadTimer = setTimeout(() => {
        this._preloadNext().catch(() => { /* 预载失败无所谓 */ });
      }, 1200);
    } catch (e) {
      if (stale()) return;
      this.playback = { ...this.playback, status: 'error', error: String(e.message) };
      this.notify('error', `加载失败：${e.message}`);
      this.emit('change');
    }
  }

  /**
   * B站曲目补齐 cid（**幂等**；`BiliApi.videoInfo` 自带结果缓存与并发去重）。
   *
   * 为什么值得单拎出来：**缓存键就是 `bilibili-<bvid>-<cid>`**。任何"先算键、后取流"
   * 的地方都必须在算键**之前**补 cid，否则同一个视频会按两套键各存一份 ——
   * 实测踩过：`点播 BV 号` 与 `点歌 b站 关键词` 两条入口各存 17.3MB、互相不命中，
   * 界面上还显示"未缓存"（用户报告"缓存一直缓存不上"的真正来源）。
   *
   * 入口处（`orderVideo` / `orderByKeyword`）已经补过，这里是**兜底**：覆盖历史
   * 播放记录、已保存播放列表、收藏里那些早先存下来的无 cid 条目。
   */
  async _ensureBiliCid(song) {
    if (!song || song.source !== 'bilibili' || !song.bvid || song.cid) return song ? song.cid : null;
    try {
      const info = await this.bili.videoInfo(song.bvid);
      if (info && info.cid) song.cid = info.cid;
    } catch (e) {
      this.log('[engine] 补 cid 失败，按无 cid 处理:', e.message);
    }
    return song.cid || null;
  }

  /**
   * 曲目 → 本地可播流地址。
   * 顺序：**缓存命中 → 远端直链**（缓存的歌直接读本地文件，不受直链过期影响）。
   * B站必须经代理注入 Referer；本地文件本来就直读。
   */
  async resolveStream(song) {
    // 预载命中：直接用（见 constructor 里的 _preload 说明）
    const pre = this._takePreload(song, 'stream');
    if (pre) {
      this.log(`[engine] 取流命中预载：${song.name || song.title}`);
      return pre;
    }

    if (song.source === 'local') {
      return { ok: true, url: `${this.serverBase}/stream/local?path=${encodeURIComponent(song.file)}`, trial: false };
    }

    // B站曲目：**先把 cid 补进曲目对象，再算缓存键**（见 _ensureBiliCid）
    await this._ensureBiliCid(song);

    // ---- 缓存命中：读本地文件，最快也最稳
    const ck = this.cache.keyFor(song);
    if (ck) {
      // 键口径变更前存下的无 cid 条目在这里认领过来，免得白白重下几十 MB
      if (song.source === 'bilibili' && song.bvid && song.cid) {
        this.cache.adopt(`bilibili-${song.bvid}`, ck);
      }
      const hit = this.cache.get(ck);
      if (hit) {
        return {
          ok: true, trial: false, via: 'cache', cached: true,
          url: `${this.serverBase}/stream/local?path=${encodeURIComponent(hit.file)}`,
        };
      }
    }

    if (song.source === 'bilibili') {
      const info = song.cid ? { cid: song.cid } : await this.bili.videoInfo(song.bvid);
      const audio = await this.bili.bestAudio(song.bvid, info.cid);
      if (!audio || !audio.url) return { ok: false, msg: '该视频没有可用音频流' };
      return {
        ok: true,
        trial: false,
        url: `${this.serverBase}/stream/bili?url=${encodeURIComponent(audio.url)}`,
        quality: audio.label,
        // 真实远端地址 + 请求头，交给后台缓存用
        cacheSrc: { url: audio.url, headers: { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com/' } },
      };
    }
    /**
     * 网易云取流。**浏览器 → eapi → legacy → weapi 的优先级已经收进
     * `NeteaseClient.songUrl` 里**，engine 这边只负责翻译结果结构。
     */
    const r = await this.netease.songUrl(song.id, {
      level: this.config.netease.level,
      encodeType: this.config.netease.encodeType,
    });
    // code 要透传：-4 = 被用户的新操作打断，load() 见到就安静放弃（不报错、不跳歌）
    if (!r.ok) return { ok: false, code: r.code, msg: r.msg || '取播放地址失败' };

    /**
     * 免登录/非会员拿到的是 45 秒试听片段：**绝不能缓存**，
     * 否则以后即使登录了，也一直放那段 45 秒的残缺音频。
     *
     * cacheSrc 只在"有真实远端直链且非试听"时给 —— `load()` 拿它做后台落盘。
     * 之前只有直连分支给了 cacheSrc，浏览器通道取到的直链反而**不会被缓存**
     * （2026-09-26 补：统一在这里给，两条路都能落盘）。
     */
    if (r.trial) {
      this.notify('warn', `《${song.name}》只有 ${r.trialEnd || 45} 秒试听，请确认账号会员状态`);
      return { ok: true, url: r.url, trial: true, trialEnd: r.trialEnd, br: r.br, level: r.level, via: r.path === 'browser' ? 'browser' : undefined };
    }
    return {
      ok: true, url: r.url, trial: false, br: r.br, level: r.level,
      via: r.path === 'browser' ? 'browser' : undefined,
      cacheSrc: { url: r.url, headers: {} },
    };
  }
  /** 曲目 → 歌词时间轴（三级来源：原平台 → 同名匹配 → B站字幕） */
  async resolveLyrics(song) {
    // 预载命中：直接用（见 constructor 里的 _preload 说明）
    const pre = this._takePreload(song, 'lyrics');
    if (pre) return pre;

    if (song.source === 'netease') {
      /**
       * 2026-09-26 修：**网易云歌词也走磁盘缓存**。
       *
       * 旧版每次切歌都打 `netease.lyric(id)`，从不读缓存、不写缓存。
       * 后果：用户以为"歌词缓存过了切歌应该秒切"，实际每次都重新走网络
       * → 命中限流就 30s+（节流 + 超时 15s + 冷却熔断），这就是用户报告的
       * "切歌卡几十秒"的真正根因。
       *
       * 键直接复用音频缓存的 `netease-${id}`（keyFor 已经这么干），跟音频缓存
       * 一起进同一个目录、同一份索引、同一份统计、同一份「清空缓存」。
       */
      const ck = this.cache.lyricKeyFor(song);
      const cached = ck ? this.cache.getLyrics(ck) : null;
      if (cached) {
        this.lastLyricDiag = null;
        return { source: '缓存', timeline: cached.timeline };
      }
      const ly = await this.netease.lyric(song.id);
      /**
       * **判定标准是"解析出多少行"，不是"字符串非空"**（2026-09-26 修）。
       *
       * 网易云对没有人声的曲目（交响 / 器乐版）会返回**只有元信息的歌词** ——
       * 实测《Answers (From "Final Fantasy XIV")》(id 1445403856, Distant Worlds III)
       * 的 `lrc` 是 85 字节的 `{"t":-1,"c":[{"tx":"作曲: "},{"tx":"植松伸夫"}]}`，
       * 只有作曲/编曲两行，一行正文都没有。
       *
       * 旧写法 `if (ly.ok && ly.lrc)` 把它当成功：source 记成 netease、行数 0、
       * 缓存写不进去（`putLyrics` 拒写空时间轴，这是对的），而界面因为
       * source != 'none' **连诊断都不给** —— 用户能看到的只有"这首一直缓存不下来歌词"。
       */
      const timeline = ly.ok && ly.lrc ? buildTimeline(ly) : null;
      if (timeline && (timeline.lines || []).length) {
        if (ck) this.cache.putLyrics(ck, timeline, { name: song.name || song.title, source: 'netease' });
        return { source: 'netease', timeline };
      }
      this.lastLyricDiag = {
        song: song.name || song.title,
        reason: ly.ok
          ? '这首歌在网易云的歌词里只有曲目信息、没有正文（器乐/交响版常见）'
          : (ly.msg || '取歌词失败'),
      };
      /**
       * 兜底：**按歌名再搜一次**，看能不能命中另一个有正文歌词的版本
       * （同一首歌常有好几个专辑版本，其中只有一部分带词）。
       * 命中就缓存到**当前这首歌的键**下 —— 用户要的是"这首歌能看见歌词"。
       */
      const alt = await this._matchNetease(song, { cacheKey: ck });
      if (alt) return alt;
      return null;
    }

    if (song.source === 'local') {
      const ly = await this.local.lyrics(song.file);
      if (ly.ok) {
        const timeline = buildTimeline(ly);
        // 同样按"有没有真实行"判断 —— 侧车文件里只有元信息（作曲/编曲）不算拿到歌词
        if ((timeline.lines || []).length) return { source: ly.source, timeline };
      }
      /**
       * 旁车 lrc 没有 → 拿歌名去网易云匹配。
       * **先查磁盘缓存**再联网：网易云按 IP 限流，同一首重复匹配很容易打进
       * 「操作频繁」，然后用户就看到"本来有歌词的歌突然没歌词了"。
       */
      const lk = this.cache.lyricKeyFor(song);
      const cached = lk ? this.cache.getLyrics(lk) : null;
      if (cached) {
        this.lastLyricDiag = null;
        return { source: '缓存', timeline: cached.timeline };
      }
      const hit = await this._matchNetease(song, { cacheKey: lk });
      if (hit) return hit;
      return null;
    }

    if (song.source === 'bilibili') {
      /**
       * 2026-09-26 修：**B站视频的歌词也要读/写磁盘缓存**。
       *
       * 旧版只有网易云分支查缓存，B站每次都重新走"字幕 → 网易云同名匹配"两条网络 ——
       * 手动点过「缓存这首」也照样重新联网，体感就是"歌词缓存了却没用"（实测：B站曲目
       * 第二次播放仍然打两次网）。键直接用音频键 `bilibili-<bvid>-<cid>`，
       * 与音频缓存同目录、同统计、同一次「清空缓存」。
       */
      await this._ensureBiliCid(song); // 歌词键＝音频键，同样依赖 cid
      const lk = this.cache.lyricKeyFor(song);
      const cached = lk ? this.cache.getLyrics(lk) : null;
      if (cached) {
        this.lastLyricDiag = null;
        return { source: '缓存', timeline: cached.timeline };
      }

      // 1) 视频自带 CC / AI 字幕（最贴合"视频音频"的语义；需要登录态，见 api.subtitles）
      let subDiag = '';
      try {
        const info = song.cid ? { cid: song.cid } : await this.bili.videoInfo(song.bvid);
        const sub = await this.bili.subtitles(song.bvid, info.cid);
        if (sub.ok && sub.subtitles.length) {
          const s0 = sub.subtitles[0];
          if (s0.body && s0.body.length) {
            const timeline = { meta: {}, lines: BiliApi.subtitleToTimeline(s0) };
            if (lk) this.cache.putLyrics(lk, timeline, { name: song.name || song.title, source: 'subtitle' });
            return { source: 'subtitle', timeline };
          }
          subDiag = `视频有 ${sub.subtitles.length} 条字幕轨但内容为空`;
        } else {
          /**
           * 空列表要区分两种可能，否则用户只能干看着"0 行"：
           * 没登录（接口恒空）vs 视频本来就没字幕。**B站不告诉我们是哪种**
           * （need_login_subtitle 在"有登录态但该视频无字幕"时也可能是 true），
           * 所以文案把两种可能一起说清，并给出可操作的那一步。
           */
          const logged = !!(this.config.bilibili && this.config.bilibili.cookie);
          subDiag = logged
            ? '该视频没有可读的 CC/AI 字幕（或登录态已过期）'
            : 'B站字幕需要登录：控制台「弹幕点歌」卡片里登录 B站 后即可拿到 CC/AI 字幕';
        }
      } catch (e) {
        subDiag = '字幕获取失败：' + e.message;
        this.log('[engine] 字幕获取失败', e.message);
      }
      // 2) 用视频标题去网易云匹配歌曲
      const hit = await this._matchNetease(
        { name: song.name || song.title, artists: song.artists || [] },
        { cacheKey: lk },
      );
      if (hit) return hit;
      // 两条路都没成 —— 把"字幕为什么没拿到"如实带出去（界面状态栏 tooltip 会显示）
      if (!this.lastLyricDiag) {
        this.lastLyricDiag = { song: song.name || song.title, reason: subDiag || '没有可用的歌词来源' };
      }
      return null;
    }
    return null;
  }

  /**
   * 按歌名去网易云匹配歌词（本地曲与 B站视频的公共兜底）。
   *
   * 带**磁盘缓存**：同一首歌重复播放时不再联网。
   * 这不只是为了快 —— 网易云按 IP 限流，反复搜同一批歌很容易把自己打进
   * 「操作频繁」，然后用户就看到"本来有歌词的歌突然没歌词了"（实际发生过）。
   */
  /**
   * @param {object} song 曲目（只需 name/title/artists，可选 source/file）
   * @param {{cacheKey?:string}} [opts] cacheKey：调用方指定的磁盘缓存键。
   *   B站曲目传它自己的**音频键** `bilibili-<bvid>-<cid>`，让歌词与音频同键 ——
   *   缓存查询、单条删除、清空缓存全都跟着音频一起走。不传则退回按歌名派生的 `match-<歌名>`。
   */
  async _matchNetease(song, { cacheKey } = {}) {
    const title = stripNoise(song.name || song.title || '');
    if (!title) {
      this.lastLyricDiag = { song: '', reason: '歌名为空，无法匹配' };
      return null;
    }
    const artist = (song.artists || [])[0] || '';

    /**
     * 多策略关键词：**先"歌名+歌手"，不行再只用歌名**。
     * 为什么必须这样：本地文件的标签经常不规整 ——
     * 实测一首曲目的 artist 标签填的其实是专辑名（"某游戏原声"），
     * 拼进去反而搜不到。
     * 缓存键统一用**歌名**，这样不同策略之间可以复用。
     */
    const candidates = [];
    if (artist && artist.toLowerCase() !== title.toLowerCase()) candidates.push(`${title} ${artist}`);
    // 2026-09-26 调整：**只跑 1 次搜索**，不再做"标题+歌手 → 标题"回退。
    // 旧逻辑（再 push(title)）看着贴心，但网络慢时 2 次搜索 × 15s 超时 = 30s+，
    // 用户感受就是"卡了一分多钟"。标题+歌手找不到时，单标题也多半找不到。
    // 真要恢复回退，做成显式开关（环境变量 / 配置项），不要硬编码。
    if (!candidates.length) candidates.push(title);

    // ---- 缓存命中（与在线音频同一个缓存子系统）：直接还原，不联网
    // 键：调用方给了就用它（B站视频＝音频键），否则用**歌名**派生（不是带歌手的
    // 长关键词）——换搜索策略时也能命中同一份。
    const ck = cacheKey || this.cache.lyricKeyFor({ source: 'local', name: title });
    const cached = ck ? this.cache.getLyrics(ck) : null;
    if (cached) {
      this.lastLyricDiag = null;
      return { source: '缓存', timeline: cached.timeline };
    }

    let kw = candidates[0];
    let r = null;
    let hit = null;
    for (const q of candidates) {
      kw = q;
      r = await this.netease.search(q, { limit: 1 });
      if (!r.ok) {
        // 限流就没必要再换关键词重试了，直接如实报告
        break;
      }
      if (!r.songs.length) continue;
      // 闸门：标题对不上就认定"搜错了"，宁可不给歌词，也不要配一段不相干的词。
      // （实测「示例曲目2」会被模糊搜索命中一首完全不相关的歌。）
      const sim = titleSimilarity(title, r.songs[0].name);
      if (sim >= TITLE_MATCH_MIN) {
        hit = r.songs[0];
        // 带 id：同一首歌常有好几个专辑版本，只有一部分带正文歌词
        // （实测《Answers》就有 1441990890/1440186679 有词、1445403856 只有曲目信息），
        // 排查"歌词是哪一版来的"必须能看见 id
        this.log(`[engine] 歌词匹配成功（关键词「${q}」→《${r.songs[0].name}》id=${r.songs[0].id} 相似度 ${sim.toFixed(2)}）`);
        break;
      }
      // 记下最后一次"搜到了但对不上"的情况，便于诊断
      hit = null;
      this.lastLyricDiag = {
        song: title, keyword: q, matched: r.songs[0].name, similarity: Number(sim.toFixed(2)),
        reason: `搜到的《${r.songs[0].name}》与原曲名对不上（相似度 ${sim.toFixed(2)}），已放弃以避免配错歌词`,
      };
    }

    if (!r || !r.ok) {
      // 别静默失败：用户需要知道"为什么这首歌没歌词"（限流/无结果/网络）
      this.lastLyricDiag = {
        song: title, keyword: kw,
        reason: (r && r.msg) || `搜索失败 code=${(r && r.code) || '?'}`,
        rateLimited: /操作频繁|请稍候|频繁/.test(String((r && r.msg) || '')),
      };
      this.log('[engine] 歌词匹配失败:', this.lastLyricDiag.reason);
      return null;
    }
    if (!hit) {
      if (!this.lastLyricDiag || !this.lastLyricDiag.matched) {
        this.lastLyricDiag = { song: title, keyword: kw, reason: '换了多种关键词都没有搜到匹配的歌曲' };
      }
      return null;
    }
    const sim = titleSimilarity(title, hit.name);
    const ly = await this.netease.lyric(hit.id);
    if (!ly.ok || !ly.lrc) {
      this.lastLyricDiag = { song: title, keyword: kw, matched: hit.name, reason: ly.ok ? '匹配到的歌曲没有歌词' : (ly.msg || '取歌词失败') };
      return null;
    }
    this.lastLyricDiag = null;
    const timeline = buildTimeline(ly);

    // 缓存键用**歌名**（不是带歌手的长关键词）：换策略时也能命中。
    // 存进媒体缓存（与在线音频同一套目录/统计/清理）。
    if (ck) this.cache.putLyrics(ck, timeline, { name: title, source: 'netease-match' });

    // 本地曲：额外把歌词**落到歌曲旁边**，下次完全不联网。
    // 这是最可靠的一条路 —— 旁车文件不受限流影响，也能跟着文件一起搬走。
    if (song.source === 'local' && song.file) {
      const saved = this.local.saveLyrics(song.file, timeline, {
        enabled: this.config.local && this.config.local.autoSaveLyrics !== false,
      });
      if (saved.ok && saved.written && saved.written.length) {
        this.notify('info', `已把歌词保存到歌曲旁边：${saved.written.map((f) => path.basename(f)).join('、')}`);
        this.log('[engine] 已保存旁车歌词:', saved.written.join(', '));
      } else if (saved.ok === false && saved.msg) {
        this.log('[engine] 旁车歌词未能保存:', saved.msg);
      }
    }

    return { source: 'netease-match', timeline, matched: { id: hit.id, name: hit.name, similarity: Number(sim.toFixed(2)) } };
  }

  // ---------------------------------------------------------------- 歌词缓存（并入媒体缓存）
  /**
   * 歌词缓存**统一走 MediaCache**，与在线音频缓存同一个目录、同一份统计、
   * 同一个「清空缓存」动作 —— 用户管理缓存只需要看一个地方。
   * 详见 cache.js 里歌词缓存那一段的说明（为什么要缓存、避开限流）。
   */
  /**
   * 查网易云账号状态（昵称 / VIP / 到期）。
   * 为什么需要：界面只显示"未登录/已登录"太容易让人困惑 ——
   * 用户根本无法确认自己到底登没登进去（被问过）。
   * 这里直接向接口要 profile，连同 VIP 到期一起给出，状态就明确了。
   */
  async neteaseStatus() {
    const out = { loggedIn: this.netease.isLoggedIn, cookieLen: (this.config.netease.cookie || '').length };
    if (!out.loggedIn) return out;
    try {
      const acc = await this.netease.account();
      const p = acc && acc.profile;
      if (p) {
        out.nickname = p.nickname;
        out.uid = p.userId;
        out.vipType = p.vipType || 0;
        out.vip = !!(p.vipType && p.vipType > 0);
        out.vipExpire = p.vipRights && p.vipRights.associator
          ? (p.vipRights.associator.expiredAtText || '') : '';
      } else {
        out.msg = 'cookie 存在但账号信息取不到（可能已过期，建议重新扫码登录）';
      }
    } catch (e) {
      out.msg = '查询账号失败：' + e.message;
    }
    return out;
  }

  clearLyricCache() {
    const r = this.cache.clearLyrics();
    return r.removed || 0;
  }

  // ================================================ 单曲缓存管理（2026-09-26）
  /**
   * 某一首的缓存现状。给列表行显示"已缓存 / 无缓存"用。
   * 音频与歌词**分开报** —— 用户常常只想重配歌词，不想重下几十 MB 音频。
   */
  cacheInfo(song) {
    return this.cache.infoFor(song);
  }

  /** 批量查缓存状态（列表渲染用，一次问完，避免每行一次往返） */
  cacheInfoMany(songs = []) {
    const out = {};
    for (const s of songs) {
      const key = (s && (s.source ? this.cache.keyFor(s) : null)) || null;
      const k = key || (s && (s.name || s.title)) || '';
      if (!k) continue;
      if (out[k]) continue;   // 同一首出现多次只算一次
      out[k] = this.cache.infoFor(s);
    }
    return out;
  }

  /**
   * 删除某一首的缓存（音频 + 歌词）。
   *
   * 正在播的那首在 Windows 上音频文件被 `<audio>` 占着删不掉 ——
   * 这时歌词照样删，音频的错误如实回报，界面能说清"停掉再删"。
   */
  cacheDrop(song) {
    if (!song) return { ok: false, msg: '没有曲目' };
    const r = this.cache.removeAllFor(song);
    const name = song.name || song.title || '这首';
    if (r.ok) {
      const parts = [];
      if (r.audio.ok) parts.push(`音频 ${r.audio.mb || 0}MB`);
      if (r.lyrics.ok) parts.push('歌词');
      this.notify('info', parts.length ? `已删除《${name}》的缓存（${parts.join(' + ')}）` : `《${name}》本来就没有缓存`);
    } else {
      this.notify('warn', `《${name}》：${r.audio.msg || '删除失败'}（歌词${
        r.lyrics.ok ? '已删除' : '未删除'}）`);
    }
    this.emit('change');
    return r;
  }

  /**
   * 手动缓存某一首（音频 + 歌词）。**这是用户主动点的，所以可以等它下载完**
   * （后台自动落盘那条路是不阻塞播放的，这里相反：要给出明确的完成反馈）。
   *
   * 已缓存的部分会跳过（`skipped: 'already'`），所以这个按钮天然就是
   * "补齐缺失的那一半"：比如音频在、歌词丢了 → 点一下只补歌词。
   */
  async cacheFetch(song) {
    if (!song) return { ok: false, msg: '没有曲目' };
    const name = song.name || song.title || '这首';
    const out = { ok: true, name, audio: null, lyrics: null };

    // ---- 音频
    // 先补 cid 再算键：缓存键依赖它，算在补之前会写到另一个键上（见 _ensureBiliCid）
    await this._ensureBiliCid(song);
    const ck = this.cache.keyFor(song);
    if (!ck) {
      out.audio = { ok: false, msg: '本地曲目不需要缓存' };
    } else if (this.cache.get(ck)) {
      out.audio = { ok: true, skipped: 'already', msg: '音频已有缓存' };
    } else {
      const st = await this.resolveStream(song);
      if (st.ok && st.cached) {
        out.audio = { ok: true, skipped: 'already', msg: '音频已有缓存' };
      } else if (st.ok && st.trial) {
        out.audio = { ok: false, msg: '试听片段不缓存（登录后重试）' };
      } else if (st.ok && st.cacheSrc) {
        out.audio = await this.cache.put(ck, st.cacheSrc.url, {
          headers: st.cacheSrc.headers,
          name: song.name || song.title, artist: song.artistText, source: song.source,
        });
      } else {
        out.audio = { ok: false, msg: st.msg || '取不到可缓存的音源' };
      }
    }

    // ---- 歌词
    const lk = this.cache.lyricKeyFor(song);
    if (!lk) {
      out.lyrics = { ok: false, msg: '无法确定歌词缓存键' };
    } else if (this.cache.getLyrics(lk)) {
      out.lyrics = { ok: true, skipped: 'already', msg: '歌词已有缓存' };
    } else {
      try {
        const ly = await this.resolveLyrics(song);
        if (ly && ly.timeline && (ly.timeline.lines || []).length) {
          out.lyrics = this.cache.putLyrics(lk, ly.timeline, { name: song.name || song.title, source: ly.source });
        } else {
          out.lyrics = { ok: false, msg: '没匹配到歌词' };
        }
      } catch (e) {
        out.lyrics = { ok: false, msg: e.message };
      }
    }

    const done = [];
    if (out.audio.ok && out.audio.skipped !== 'already') done.push('音频');
    if (out.lyrics.ok && out.lyrics.skipped !== 'already') done.push('歌词');
    if (done.length) this.notify('info', `《${name}》已缓存：${done.join(' + ')}`);
    else if (!out.audio.ok && !out.lyrics.ok) this.notify('warn', `《${name}》缓存失败：${out.audio.msg}`);
    this.emit('change');
    return out;
  }

  // ================================================ 批量缓存管理（2026-09-26）
  /** 只清歌词、保留音频。音频动辄几十 MB 要重下，歌词删了几乎零代价 —— 常用来重配歌词 */
  cacheClearLyrics() {
    const r = this.cache.clearLyrics();
    this.notify(r.removed ? 'info' : 'warn',
      r.removed ? `已清掉 ${r.removed} 首的歌词缓存（音频保留）` : '本来就没有歌词缓存');
    this.emit('change');
    return { ok: true, removed: r.removed || 0 };
  }

  /** 按缓存键批量删除（缓存列表里勾选删除用） */
  cacheDropKeys(keys = []) {
    let audio = 0; let lyrics = 0; const failed = [];
    for (const k of keys || []) {
      if (!k) continue;
      const a = this.cache.remove(k);
      if (a.ok) audio++;
      else failed.push(`${k}: ${a.msg}`);
      const l = this.cache.removeLyrics(k);
      if (l.ok) lyrics++;
    }
    this.notify(audio || lyrics ? 'info' : 'warn',
      audio || lyrics ? `已删除 ${audio} 条音频 + ${lyrics} 条歌词缓存` : '没有可删除的条目');
    this.emit('change');
    return { ok: true, audio, lyrics, failed };
  }

  /**
   * 清理「孤儿缓存」：**已经缓存了、但不在已保存播放列表 / 收藏里**的曲目。
   *
   * 为什么需要它：直播间点过的歌绝大多数是**一次性**的（弹幕随手点的、试听的）。
   * 缓存留着只是占地方 —— 2GB 上限很容易被这批曲目填满，然后 LRU 去淘汰真正常听的
   * 那批，**适得其反**：想留的被挤掉，不想留的一直占着。
   *
   * 保留集合 = `已保存播放列表` ∪ `收藏` ∪ **正在播放的那首**。
   * 为什么连收藏一起保：收藏与已保存一样是"用户显式说我要留着"的动作，只因为没进
   * 已保存列表就被清掉属于误删。这条语义写死在按钮提示里，不靠猜。
   *
   * @param {{dryRun?:boolean}} [opts] dryRun 只统计不删 —— 界面先给用户看数量再确认
   */
  cacheDropOrphans({ dryRun = false } = {}) {
    const keep = new Set();
    const add = (song) => {
      if (!song) return;
      const k = this.cache.keyFor(song);
      if (k) keep.add(k);
      const lk = this.cache.lyricKeyFor(song);
      if (lk) keep.add(lk);
    };
    for (const it of (this.config.savedPlaylist || [])) add(it && it.song);
    for (const it of (this.config.favorites || [])) add(it && it.song);
    add(this.track); // 正在播的这首别删（文件还占着，删了也会失败）

    // 音频键与歌词键**不完全重合**（本地曲/按歌名匹配的只有歌词键），两边都要看
    const all = new Set([...this.cache.keys(), ...this.cache.lyricKeys()]);
    const orphans = [...all].filter((k) => !keep.has(k));

    let bytes = 0;
    for (const k of orphans) {
      const s = this.cache.sizeOf(k);
      bytes += s.audio + s.lyric;
    }
    const mb = Number((bytes / 1048576).toFixed(2));

    if (dryRun) {
      return { ok: true, dryRun: true, count: orphans.length, mb, keepCount: keep.size, preview: orphans.slice(0, 20) };
    }

    let audio = 0; let lyrics = 0; let freed = 0; const failed = [];
    for (const k of orphans) {
      const a = this.cache.remove(k);
      if (a.ok) { audio++; freed += a.size || 0; }
      else if (/占用/.test(String(a.msg))) failed.push({ key: k, msg: a.msg });
      if (this.cache.removeLyrics(k).ok) lyrics++;
    }

    if (audio || lyrics) {
      this.notify('info', `已清理 ${audio} 条音频 + ${lyrics} 条歌词缓存（约 ${Number((freed / 1048576).toFixed(1))} MB）`
        + (failed.length ? `；${failed.length} 条文件被占用已跳过（停掉播放再清）` : ''));
    } else {
      this.notify(failed.length ? 'warn' : 'info', failed.length
        ? `${failed.length} 条缓存文件正被占用，停掉播放再清`
        : '没有可清理的缓存：现有缓存里的曲目都还在已保存列表/收藏里');
    }
    this.log(`[engine] 孤儿缓存清理：候选 ${orphans.length} 条，删除音频 ${audio} + 歌词 ${lyrics}，跳过 ${failed.length}`);
    this.emit('change');
    return {
      ok: true, count: orphans.length, audio, lyrics,
      mb: Number((freed / 1048576).toFixed(2)), skipped: failed.length,
      failed: failed.slice(0, 5),
    };
  }

  /**
   * 批量缓存（"把整个已保存列表预先下下来，直播时完全不吃网"）。
   *
   * 设计取舍：
   *   · **后台串行跑**，一个完了下一个 —— 并发下载会把带宽和网易云都打满，
   *     而且用户很可能一边播着歌一边预缓存。
   *   · 用 notify 报进度（每首报会很吵 → 每 5 首 + 最后一首各报一次）。
   *   · `_prefetching` 防止重复点（连点不会起两轮）。
   *   · 全程**不阻塞播放**：它只是在给缓存子系统喂数据。
   *
   * @param {{source?:'saved'|'history', limit?:number}} opts
   */
  async cachePrefetch({ source = 'saved', limit = 200 } = {}) {
    if (this._prefetching) return { ok: false, msg: '已有一轮批量缓存在跑，等它结束', running: true };

    const songs = (source === 'history'
      ? this.listHistory(limit).map((it) => it.song)
      : (this.config.savedPlaylist || []).map((it) => it.song).slice(0, limit)
    ).filter((s) => s && (s.source === 'netease' || s.source === 'bilibili'));

    if (!songs.length) {
      return {
        ok: false,
        msg: source === 'history'
          ? '还没有播放记录（本地曲目不需要缓存）'
          : '「已保存播放列表」里没有需要缓存的在线曲目（本地曲目不需要缓存）',
      };
    }

    this._prefetching = true;
    this._prefetchTotal = songs.length;
    // 立即返回，让界面能提示"已开始"，实际下载在后台跑
    this.notify('info', `开始批量缓存 ${songs.length} 首（后台进行，不影响播放）`);

    (async () => {
      let audio = 0; let lyrics = 0; let fail = 0; let i = 0;
      try {
        for (const s of songs) {
          i++;
          try {
            const r = await this.cacheFetch(s);
            if (r.audio && r.audio.ok && r.audio.skipped !== 'already') audio++;
            if (r.lyrics && r.lyrics.ok && r.lyrics.skipped !== 'already') lyrics++;
            if ((r.audio && !r.audio.ok) && (r.lyrics && !r.lyrics.ok)) fail++;
          } catch { fail++; }
          this._prefetchDone = i;
          // 每 5 首报一次 + 收尾报一次（每首都报会把通知栏刷爆）
          if (i % 5 === 0 || i === songs.length) {
            this.notify('info', `批量缓存 ${i}/${songs.length}：新增音频 ${audio} · 歌词 ${lyrics}${fail ? ` · 失败 ${fail}` : ''}`);
          }
          this.emit('change');
        }
        this.notify('info', `批量缓存完成：${songs.length} 首处理完毕（新增音频 ${audio} · 歌词 ${lyrics}${fail ? ` · 失败 ${fail}` : ''}）`);
      } finally {
        this._prefetching = false;
        this._prefetchDone = 0;
        this._prefetchTotal = 0;
        this.emit('change');
      }
    })().catch(() => { this._prefetching = false; });

    return { ok: true, started: true, total: songs.length };
  }

  // ================================================ 下一首预载（思路来自 AIMP）
  /**
   * 从预载表里取一项（取完即删 —— 直链有 expi，用过就不该再复用）。
   * @param {object} song
   * @param {'stream'|'lyrics'} field
   */
  _takePreload(song, field) {
    if (!this._preload || !this._preload.size) return null;
    const key = dedupeKeyOf(song);
    if (!key) return null;
    const rec = this._preload.get(key);
    if (!rec) return null;
    // 超过 5 分钟视为过期（网易云直链 expi 约 20 分钟，但播放场景没必要留那么久）
    if (Date.now() - rec.at > 5 * 60_000) { this._preload.delete(key); return null; }
    const v = rec[field];
    if (!v) return null;
    rec[field] = null;                 // 只消费一次
    if (!rec.stream && !rec.lyrics) this._preload.delete(key);
    return v;
  }

  /**
   * 预载"下一首"的直链 + 歌词（AIMP 的 "Pre-load next track while current is playing"）。
   *
   * 为什么值得做：切歌/下一首是**本地控制**，用户要求必须立刻响应。
   * 不预载的话每次都要联网取直链 + 匹配歌词，慢的时候几秒；
   * 预载之后这一段在**上一首还在播的时候**就已经做完了，切歌几乎零等待。
   *
   * 实现要点：
   *   · 用 `_loadSeq` 做失效判断 —— 播放内容变了就丢弃预载结果
   *   · 复用 `netease.currentSignal`：真·load() 一开就会 abort 掉预载的请求，
   *     不会出现"预载和新载入抢连接"（浏览器同 host 只有 6 条连接）
   *   · `_preloading` 防重入，且一轮只预载一首（不铺开）
   *   · **静默**：失败就失败，不通知用户（预载只是优化，不是功能）
   */
  async _preloadNext() {
    if (this._preloading) return;

    const song = this._nextTrackGuess();
    if (!song) return;
    const key = dedupeKeyOf(song);
    if (!key) return;
    const old = this._preload.get(key);
    if (old && Date.now() - old.at < 5 * 60_000) return;   // 已经有一份新鲜的

    this._preloading = true;
    const seqAtStart = this._loadSeq;
    try {
      const [stream, lyrics] = await Promise.all([
        this.resolveStream(song).catch(() => null),
        this.resolveLyrics(song).catch(() => null),
      ]);
      // 预载期间播放已经变了 → 结果没用，丢掉
      if (seqAtStart !== this._loadSeq) return;
      if (!stream || !stream.ok) return;
      this._preload.set(key, { stream, lyrics, at: Date.now() });
      if (this._preload.size > 5) this._preload.delete(this._preload.keys().next().value);
      this.log(`[engine] 已预载下一首：${song.name || song.title}`);
    } catch { /* 预载失败无所谓 */ } finally {
      this._preloading = false;
    }
  }

  /**
   * 猜"下一首是谁"：点歌队列优先于闲时歌单（和 AIMP 的 queue 语义一致：
   * "Queue is just playlist over playlists. It has a priority over playing playlist"）。
   */
  _nextTrackGuess() {
    const peek = this.queue.peek();
    if (peek && peek.song) return peek.song;
    // 队列空 → 闲时序列的下一首
    if (this._idleSeq && this._idleSeq.length && this._idleIdx >= 0 && this._idleIdx + 1 < this._idleSeq.length) {
      return this._idleSeq[this._idleIdx + 1];
    }
    // 还没有序列（刚开始播）→ 用已保存列表的第一首兜底
    const saved = (this.config.savedPlaylist || []);
    if (saved.length) return saved[0].song;
    return null;
  }

  /** 批量缓存进度（界面用它显示"正在缓存 3/20"） */
  prefetchState() {
    return {
      running: !!this._prefetching,
      done: this._prefetchDone || 0,
      total: this._prefetchTotal || 0,
    };
  }

  // ================================================================ 播放器回调
  onPlayerEvent(ev) {
    if (!ev || !ev.type) return;
    /**
     * **过期判定**（2026-09-26 重做）：播放核心上报时带上它当前那一份载入序号；
     * 序号不等于 `_loadSeq` 就是上一首的残留状态，直接丢弃。
     *
     * 这比之前那套"看状态字符串"的判断精确得多：
     *   · 之前 position 靠「loading/idle 期间忽略」—— 切歌后一旦状态变了就漏防护
     *   · 之前 status 靠一个转移白名单 —— 却把**合法的 `playing → loading`（缓冲）**
     *     也挡掉了，于是缓冲中仍显示 playing、看起来"卡着但没停"
     * （老版播放核心页不带 seq，所以两种判据都保留作兜底。）
     */
    const stale = ev.seq != null && this._loadSeq != null && ev.seq !== this._loadSeq;

    if (ev.type === 'position') {
      if (stale) return;
      // 兜底：不带 seq 的老页面，仍按"loading/idle 期间忽略"处理
      if (ev.seq == null && (this.playback.status === 'loading' || this.playback.status === 'idle')) return;
      this.playback.position = ev.position || 0;
      if (ev.duration) this.playback.duration = ev.duration;
      return; // 高频，不触发 change，由广播循环统一推送
    }
    if (ev.type === 'status') {
      if (stale) return;
      if (!this.track) return;   // 没有曲目时任何状态都没意义（别把 idle 写成 paused）
      /**
       * 播放结束（player.js 的 audio `ended` 事件 → status='ended'）：
       * **不把这个字面量写进 `playback.status`**（状态枚举是 idle/loading/playing/paused/error），
       * 直接交给 `next()` 去接下一首 / 闲时歌单。所以这一判断必须在赋值**之前**。
       *
       * 这一行原先是 `if (next === 'ended')` —— `next` 是个**未定义的变量**，
       * 于是**每一次状态上报**走到这里都抛 `ReferenceError`（实测：`headless --simulate`
       * 跑几秒就崩）。后果有三层：
       *   1) `this.next()` **从来没被调用过** → 一首歌播完不会自动接下一首（核心功能坏掉）；
       *   2) 异常从 onPlayerEvent 抛出、被命令层的兜底吞掉 → 表面看只是"状态没变化"；
       *   3) `'ended'` 先被写进 `playback.status`，界面状态栏显示成播放器内部字面量。
       */
      if (ev.status === 'ended') { this.next().catch(() => {}); return; }
      this.playback.status = ev.status;
      if (ev.duration) this.playback.duration = ev.duration;
      if (ev.error) this.playback.error = ev.error;
      this.emit('change');
    }
  }

  /**
   * 改音量。**同时写回配置**，下次启动才记得住。
   *
   * 用户报告："播放器音量每次启动都重置到 100%"。原因是这条链只读了配置
   * （构造时 `volume: config.player.volume`）、却从来不写回 —— 等于没记忆。
   * 落盘由命令层做**防抖**（滑块拖动会连续触发，不能每次都写磁盘）。
   */
  setVolume(v) {
    this.playback.volume = Math.max(0, Math.min(1, v));
    this.config.player.volume = this.playback.volume;
    this.emit('player', { action: 'volume', volume: this.playback.volume });
    this.emit('change');
  }

  /**
   * 切换输出设备（送去 VoiceMeeter 的通道）。
   * 同时记下 deviceId 与**设备名标签**：Chromium 的 deviceId 在权限变化或
   * 驱动变动后可能失效，而标签（"Voicemeeter AUX Input"）是稳定的 ——
   * 下次启动可以靠标签把设备找回来，否则就会出现
   * "选好的设备过一会儿自己变回系统默认"。
   */
  setDevice(deviceId, label = '') {
    // 调用方没给标签时，从播放核心上报的设备清单里查一个 ——
    // 标签是 deviceId 失效后找回设备的唯一依据，不能丢。
    if (deviceId && !label && Array.isArray(this.playerDevices)) {
      const hit = this.playerDevices.find((d) => d.id === deviceId);
      if (hit && hit.label) label = hit.label;
    }
    this.playback.deviceId = deviceId || '';
    this.playback.deviceLabel = label || '';
    if (this.config.player) {
      this.config.player.deviceId = deviceId || '';
      this.config.player.deviceLabel = label || '';
    }
    this.emit('player', { action: 'device', deviceId: deviceId || '', deviceLabel: label || '' });
    this.emit('change');
  }

  /**
   * 暂停 / 恢复。
   *
   * `_pausePending`（2026-09-26 加）：记录"用户在解析直链期间按了暂停"的意图。
   * loading 期间 audio 指的是**上一首**的源，直接 pause 只能停到旧的；
   * load() 完成时会看这个标志，改发 startPaused，避免把暂停吞掉。
   */
  /**
   * 暂停。**没有曲目时什么都不做**（2026-09-26 修）。
   *
   * 原来是无条件 `status = 'paused'`，于是刚启动、什么都没有的时候点暂停，
   * 状态会从 idle 变成 paused —— 状态在撒谎（没有任何东西被暂停）。
   */
  pause() {
    if (!this.track) return { ok: false, reason: 'nothing_playing' };
    this._pausePending = true;
    this.playback = { ...this.playback, status: 'paused' };
    this.emit('player', { action: 'pause' });
    this.emit('change');
    return { ok: true };
  }

  /**
   * 恢复播放。**没有曲目时不能假装在播**（2026-09-26 修，用户报告）。
   *
   * 踩过的坑：原来无条件 `status = 'playing'`，于是刚启动、什么都没选的时候
   * 点一下播放按钮，顶栏就显示「播放 playing」，但实际一个音都没有 ——
   * 状态在撒谎，用户只会以为程序坏了（用户原话："上方状态依然会变成 playing"）。
   *
   * 现在按"这个按钮到底该做什么"分三种情况：
   *   1. 有曲目（暂停中 / 加载中）→ 正常恢复
   *   2. 没有曲目但**队列里有歌** → 直接开播（这才是"播放"按钮的直觉行为）
   *   3. 也没有队列 → 什么都不做，如实说明去哪开播，状态保持 idle
   *
   * 注意**不**自动去播「已保存播放列表」：那是一个独立的入口
   * （列表页的「播放已保存歌单」），点"播放"不该意外启动一整张歌单。
   */
  resume() {
    this._pausePending = false;

    if (!this.track) {
      if (this.queue.items.length) {
        this.next().catch(() => { /* 失败会走 notify */ });
        return { ok: true, started: true };
      }
      this.notify('info', '还没有在播的歌：先在「点歌」里点一首，或用列表页的「播放已保存歌单」开始');
      this.emit('change');   // 让界面把状态重新拉一次（保持 idle，不做假）
      return { ok: false, reason: 'nothing_to_play' };
    }

    this.playback = { ...this.playback, status: 'playing' };
    this.emit('player', { action: 'resume' });
    this.emit('change');
    return { ok: true, started: true };
  }
  seek(sec) { this.emit('player', { action: 'seek', position: sec }); }

  // ================================================================ 状态输出
  notify(level, text) {
    const n = { level, text, at: Date.now() };
    this.notices.unshift(n);
    if (this.notices.length > 30) this.notices.length = 30;
    this.emit('notice', n);
    this.log(`[${level}] ${text}`);
    return n;
  }

  /**
   * 信息栏用的"正在播放"视图。
   * 刻意在这里把各音源的差异抹平 —— 渲染层不该关心是网易云还是 B站。
   */
  nowPlaying() {
    if (!this.track) return null;
    const t = this.track;
    const meta = this.trackMeta || {};
    const isBili = t.source === 'bilibili';
    const isLocal = t.source === 'local';
    return {
      name: t.name || t.title || '未知曲目',
      artistText: t.artistText || (t.artists || []).join(' / ') || '',
      album: t.album || '',
      source: t.source,
      sourceLabel: SOURCE_LABEL[t.source] || t.source,
      cover: this.coverUrlFor(t),
      duration: this.playback.duration || t.duration || 0,
      position: this.playback.position || 0,
      status: this.playback.status,
      requester: meta.requester || null,
      requestedAt: meta.requestedAt || null,
      startedAt: meta.startedAt || null,
      // B站特有信息（封面/UP主/播放量等），本地与网易云留空
      bvid: isBili ? t.bvid : undefined,
      owner: isBili ? (t.artists || [])[0] : undefined,
      pageUrl: isBili ? `https://www.bilibili.com/video/${t.bvid}` : undefined,
      stats: isBili ? t.stats : undefined,
      pubdate: isBili ? t.pubdate : undefined,
      file: isLocal ? t.file : undefined,
      quality: this.streamInfo && this.streamInfo.level ? this.streamInfo.level : undefined,
      via: this.streamInfo && this.streamInfo.via ? this.streamInfo.via : undefined,
      queueRemaining: this.queue.length,
    };
  }

  /** 封面地址：网易云直接用远端图；B站经本地代理（客户端网络差异大）；本地走本地封面服务 */
  coverUrlFor(track) {
    if (!track) return '';
    // 顺手修掉历史数据里"朴素拼出来的"坏网易云封面 URL（见 repairNeteaseCover），
    // 这样用户 config 里存着的旧封面不用手改也能正常显示
    track = { ...track, cover: repairNeteaseCover(track.cover) };
    if (track.source === 'local' && track.file) {
      const c = this.local.coverFileFor ? this.local.coverFileFor(track.file) : null;
      if (c) return `${this.serverBase}/stream/cover?path=${encodeURIComponent(c)}`;
      return '';
    }
    const c = track.cover || '';
    // B站封面（hdslb.com）经本地转发一次，避免客户端直连的不确定性。
    // 顺手要个缩略图：原图实测有 4500x2813 / 1.26MB，而信息栏只显示 64px，
    // 白白拖慢叠加层。B站图片支持 `@宽w_高h_裁剪c.格式` 后缀。
    if (c && /hdslb\.com/i.test(c)) {
      const sized = /@\d/.test(c) ? c : `${c}@240w_240h_1c.webp`;
      return `${this.serverBase}/stream/img?url=${encodeURIComponent(sized)}`;
    }
    return c;
  }

  _brief(song, item) {
    if (!song) return null;
    return {
      name: song.name || song.title || '未知',
      artistText: song.artistText || (song.artists || []).join(' / '),
      source: song.source,
      sourceLabel: SOURCE_LABEL[song.source] || song.source,
      cover: this.coverUrlFor(song),
      duration: song.duration || 0,
      uname: item ? item.uname : undefined,
    };
  }

  /** 高频状态（10Hz 广播用，必须小） */
  state() {
    return {
      type: 'state',
      serverTime: Date.now(),
      playback: { ...this.playback },
      track: this.track,
      nowPlaying: this.nowPlaying(),
      upNext: this.queue.peek() ? this._brief(this.queue.peek().song, this.queue.peek()) : null,
      streamUrl: this.streamUrl,
      lyric: {
        rev: this.lyricRev, source: this.lyricSource, count: this.lyricTimeline.lines.length,
        // 为什么没有歌词（限流 / 没搜到 / 名字对不上）—— 不暴露这个的话，
        // 用户只能看到"0 行"，完全无从判断（实测被质疑过）。
        //
        // 2026-09-26 补：**0 行也要给诊断**，不能只在 source === 'none' 时给。
        // 网易云对器乐/交响版会返回"只有曲目信息"的歌词，那种情况 source 是
        // netease、行数却是 0 —— 只按 'none' 判断会让用户彻底看不到原因，
        // 只能反馈"这首一直缓存不下来歌词"。
        diag: (this.lyricSource === 'none' || !this.lyricTimeline.lines.length) ? (this.lastLyricDiag || null) : null,
      },
      queue: this.queue.list(8),
      /**
       * `via` 告诉界面当前走的是哪条通道：
       *   - `openlive`：官方开放平台 —— **房间由身份码绑定决定，界面上的房间号无效**
       *   - `browser` ：系统浏览器通道（房间号生效）
       *   - `direct`  ：Node 直连（房间号生效，但基本会被风控拒）
       * 界面要用它决定「房间号」输入框该不该置灰，免得让人以为改了就能换房间。
       */
      room: this.danmaku ? {
        roomId: this.danmaku.roomId,
        liveStatus: this.roomLiveStatus,
        via: this.openLive ? 'openlive' : (this._danmakuBridge ? 'browser' : 'direct'),
        stats: this.danmaku.stats,
        /**
         * 认到的"主播是谁"—— 只读诊断用。
         * 用户反馈过"我本身就是主播，但打指令说我没权限"，有这两个字段就能当场看出
         * 是"没认出来"还是"认到了别人"，不用再去翻日志。
         */
        anchor: { uid: this.anchorUid || 0, name: this.anchorName || '' },
      } : null,
      netease: {
        loggedIn: this.netease.isLoggedIn,
        // 限流冷却剩余秒数 —— 让界面能说"在等冷却"，而不是让用户以为卡死了
        coolLeft: this.netease.coolLeft ? this.netease.coolLeft() : 0,
        searchCache: this.netease.searchCacheStats ? this.netease.searchCacheStats().size : 0,
      },
      playerDevices: this.playerDevices || [],
      blacklist: this.blacklist.list(),
      /**
       * 已导入歌单**只发摘要**（2026-09-26 瘦身）。
       *
       * 原来直接发 `imported` 整个数组 —— 里面每首歌都是完整对象，
       * 一个 200 首的歌单就是 **25KB 的 JSON**，而 state 是 **10Hz** 广播的：
       * 25KB × 10/s = 250KB/s 的纯序列化开销（还不算 SSE 传输）。
       * 界面列表只需要 id/name/trackCount，完整的曲目在「整单入队」时才拉。
       */
      playlists: (this.config.playlists ? this.config.playlists.imported || [] : []).map((pl) => ({
        id: pl.id, name: pl.name, cover: pl.cover, trackCount: pl.trackCount,
      })),
      /** 播放器状态：模式/静音/历史/闲时/缓存/收藏 */
      player: {
        mode: this.playMode,
        muted: this.muted,
        volume: this.playback.volume,
        historyCount: this.history.length,
        playingIdle: this.playingIdle,
        cached: !!(this.streamInfo && this.streamInfo.cached),
        via: this.streamInfo ? this.streamInfo.via : undefined,
        favorited: this.track ? this.isFavorited(this.track) : false,
        deviceId: this.playback.deviceId || '',
        deviceLabel: this.playback.deviceLabel || '',
      },
      idle: this.config.idle || { enabled: false },
      /** 直播状态与列表页计数（界面分页用） */
      streaming: this.streaming,
      counts: {
        queue: this.queue.items.length,
        history: this.history.length,
        saved: (this.config.savedPlaylist || []).length,
        favorites: (this.config.favorites || []).length,
        blacklist: this.blacklist.list().rules.length,
      },
      cache: (() => {
        const s = this.cache.stats();
        return {
          enabled: s.enabled, count: s.count,
          mb: Number((s.bytes / 1048576).toFixed(1)),
          maxMB: Math.round(s.maxBytes / 1048576),
          lyricCount: s.lyricCount || 0,
          lyricMB: Number(((s.lyricBytes || 0) / 1048576).toFixed(1)),
          dir: s.dir,
          // 批量缓存进度（界面显示「正在批量缓存 3/20」）
          prefetch: this.prefetchState(),
        };
      })(),
      favoritesCount: (this.config.favorites || []).length,
      notices: this.notices.slice(0, 3),
      stats: this.stats,
    };
  }

  /** 大对象：歌词，仅在 revision 变化时推送 */
  lyricsPayload() {
    return { type: 'lyrics', rev: this.lyricRev, source: this.lyricSource, timeline: this.lyricTimeline };
  }

  get serverBase() { return this._serverBase || 'http://127.0.0.1:37821'; }
  set serverBase(v) { this._serverBase = v; }
}

/** B站时长字符串 "4:34" → 秒 */
function parseDuration(s) {
  if (typeof s === 'number') return s;
  const m = String(s || '').match(/(\d+):(\d+)(?::(\d+))?/);
  if (!m) return 0;
  return m[3] ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
}

/** 去掉视频标题里的噪声，提高歌曲匹配命中率 */
function stripNoise(t) {
  return String(t || '')
    .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ')
    .replace(/(官方|MV|高清|4K|60FPS|1080P|完整版|字幕版|中文字幕|无损|音质|循环|纯音乐|cover|翻唱|live|现场)/gi, ' ')
    .replace(/[_\-|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { Engine, stripNoise, parseDuration, titleSimilarity, TITLE_MATCH_MIN };
