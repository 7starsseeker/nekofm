/**
 * 配置默认值
 * ===========
 * 全部可在 <程序目录>/data/config.json 覆盖；改完重启生效（部分支持热改，见 Engine）。
 */
'use strict';

const path = require('node:path');

const DEFAULT_CONFIG = {
  server: { port: 37821, host: '127.0.0.1' },

  // 网易云
  netease: {
    cookie: '',            // 扫码登录后自动写入，也可手工粘贴
    level: 'exhigh',       // standard / higher / exhigh / lossless / hires
    encodeType: 'aac',     // aac / mp3（aac 体积小、兼容好）
    defaultSource: 'netease',
  },

  // B站
  bilibili: {
    /**
     * B站登录态（整条 cookie 串）。
     *
     * **视频的 CC/AI 字幕必须要它**：`/x/player/v2` 未登录时恒返回
     * `need_login_subtitle: true` + 空列表（与视频有没有字幕无关，2026-09-26 实测），
     * 而没有字幕，视频音频的歌词就只能靠"标题匹配网易云"，冷门曲基本匹配不到。
     * 顺带用于拿完整昵称、让弹幕连接与检索更稳。
     * 获取：控制台「弹幕点歌」卡片里点「登录 B站」（弹窗扫码），或粘贴 SESSDATA。
     */
    cookie: '',
    roomId: '',            // 直播间号（短号也行）—— **只对浏览器/直连通道有效**，见 danmakuMode
    /**
     * 弹幕通道，二选一（控制台「弹幕点歌」卡片里切）：
     *   `openlive` —— **官方直播开放平台**。最稳：不依赖浏览器、不受网页端风控影响。
     *                 代价是**房间由「主播身份码」绑定**，只能收自己那个房间，
     *                 上面 `roomId` 填什么都不生效。
     *   `browser`  —— **系统 Edge/Chrome 通道**。可以连**任意**直播间（`roomId` 生效），
     *                 也是没有开放平台凭据时的兜底；依赖机器上装了 Edge 或 Chrome。
     *
     * 选 `openlive` 但凭据不全时会自动回落到 `browser` 并在界面提示，不会连不上。
     */
    danmakuMode: 'openlive',
    autoConnect: true,
    replyInDanmaku: false, // 是否用弹幕回执（需要登录态才能发弹幕，默认关）

    /**
     * B站官方「直播开放平台」弹幕通道（`open-live.bilibili.com`）。
     *
     * 填好这四项且 enabled=true，弹幕就**优先走官方接口** —— 比浏览器通道更稳、
     * 不依赖机器上装 Edge/Chrome，也不受网页端风控影响；留空则回落到浏览器通道。
     *
     * 四项都在开放平台后台办（`open-live.bilibili.com`）：
     *   1. 个人开发者认证通过 → `accessKeyId` / `accessKeySecret`
     *   2. 创建项目并**通过审核**（3-5 个工作日）→ `appId`（项目 ID）
     *   3. 在项目里生成**主播身份码** → `roomOwnerAuthCode`（绑定自己的直播间）
     *   4. ⚠️ **弹幕(DM)等消息类型要单独向 B站运营申请开通**，
     *      否则长连里根本不会推弹幕（表现是连上了但一条都收不到）
     */
    openLive: {
      enabled: false,
      accessKeyId: '',
      accessKeySecret: '',
      appId: '',
      roomOwnerAuthCode: '',
    },
  },

  // 本地曲库
  local: {
    /**
     * 匹配到歌词后，自动在歌曲文件旁边存一份（.lrc / .karaoke.lrc / .trans.lrc）。
     * 好处：下次播放完全不用联网，也不受网易云限流影响；歌搬走歌词跟着走。
     * 只在文件不存在时写入，绝不覆盖你自己放的歌词。设 false 可关闭。
     */
    autoSaveLyrics: true,
    dirs: [],              // 例如 ["D:/Music", "E:/Songs"]
    enabled: true,
  },

  // 点歌队列
  queue: {
    maxSize: 50,
    perUserMax: 2,
    cooldownMs: 60000,
    dedupeWindowMs: 1800000,
    /**
     * 是否允许**重复点同一首歌**。
     * false（默认）：同一首在 dedupeWindowMs 内只能点一次（防刷屏）
     * true：可以重复点（"这首我想再听一遍"的场合）
     */
    allowDuplicate: false,
    privilegedUids: [],    // 额外授权 UID
    /**
     * 弹幕切歌权限：
     *   ownOnly=true（默认）—— 观众只能切**自己点的那首**，别人的歌要主播在控制台切
     *   ownOnly=false        —— 房管/主播照旧，普通观众一律不能切
     */
    danmakuSkip: { ownOnly: true },
  },

  // 点歌指令词表（可按直播间习惯改）
  commands: {
    order: ['点歌', '点播', '来一首', '点一首'],
    skip: ['切歌', '跳过', '下一首', 'next'],
    remove: ['撤歌', '删除', '撤销'],
    mine: ['我的', '我的歌', '查询'],
    queue: ['队列', '歌单', '列表', 'queue'],
    lyricToggle: ['歌词'],
    volume: ['音量'],
  },

  // 黑名单 / 审核规则（按歌曲 ID / 标题关键词 / 歌手 / BV 号拦截）
  blacklist: {
    // 默认开启：没规则时开启也等于没有影响；但用户一旦加了规则，
    // 期望的就是"立刻生效"，而不是还要再去点一次开关。
    enabled: true,
    rules: [],   // [{id, type:'song'|'keyword'|'artist'|'bvid', value, note, addedAt}]
  },

  // 已导入的网易云歌单（持久化记录，便于一键重新入队）
  playlists: {
    imported: [], // [{id, name, cover, trackCount, importedAt, lastQueuedAt}]
  },

  // 我的收藏（可当闲时歌单的音源）
  favorites: [], // [{song, addedAt}]

  /**
   * 已保存播放列表：**下播时**自动把"当前播放列表"整份存下来，
   * **开播时**它作为闲时歌单（当前队列空了就接着放）。这样一轮直播点过的歌
   * 天然留到下一场，不用手工整理。
   */
  savedPlaylist: [], // [{song, uid, uname, requestedAt}]

  // 播放行为
  playback: {
    /**
     * order      | 顺序播放：放完队列就停
     * repeat-all | 列表循环：队列空了把历史重新排一遍
     * repeat-one | 单曲循环：一直放当前这首
     * shuffle    | 随机播放：从队列里随机抽
     *
     * 注：本段历史上还放过 `volume` / `muted`（早期把"播放行为"和"播放器输出"混在一段）。
     * 那两个字段已统一到 `player` 段（那里才有 volume / deviceId），这里只留播放模式。
     * 老配置里残留的 playback.volume/muted 无人读取，可放心忽略。
     */
    mode: 'order',
  },

  /**
   * 闲时歌单：没有点歌任务时自动播它，避免冷场。
   * source: netease(已导入歌单) | local(本地曲库) | favorites(我的收藏)
   */
  idle: {
    enabled: false,
    source: 'netease',
    playlistId: '',
    shuffle: true,
    /** 最近 N 首不重复（防止随机到刚放过的） */
    avoidRecent: 10,
  },

  /**
   * 在线媒体本地缓存：在线放过的歌落盘，下次直接读本地。
   * 首次播放仍走远端直链（不阻塞出声），后台下载。
   */
  cache: {
    enabled: true,
    maxMB: 2048,
    maxFileMB: 120,
    /**
     * 缓存根目录（歌曲音频、封面、歌词都在它下面）。
     * 留空 = `<程序目录>/data/cache` —— 跟着程序走，**绝不默认写系统盘**。
     * 想放到大盘上就填绝对路径，例如 "D:/NekoFM/cache"。
     */
    dir: '',
  },

  // 歌词叠加层
  overlay: {
    theme: 'scroll',       // scroll=逐行滚动 | karaoke=逐字卡拉OK | dual=双行+翻译 | desktop=桌面歌词+信息卡
    fontSize: 42,
    /**
     * **字号是否随浏览器源尺寸缩放**（默认 off，2026-09-26 按用户要求定）。
     *
     * off（默认）：**字号就是上面的 `fontSize`（固定 px）** ——
     *   适合"把浏览器源的框设成组件尺寸"的用法（用户的做法）：
     *   框 1280×90 + 字号 42 → 字幕正好填满，所见即所得，不用来回试。
     * on：按视口等比缩放（1080p 基准），给"源铺满整个画面"的用法
     *   （那种情况下希望不同分辨率下相对大小一致）。
     *
     * 历史：中间一度用过 `fitHeight`（字号 = 视口高÷行数，让字幕填满框）——
     * 那个方向是**反的**：框还大时字号会被算成几百像素（用户反馈"变成雷霆大字只显示几个"）。
     * 正确的关系是"**字号固定、框按组件尺寸设**"，所以撤掉了。
     */
    scaleFont: false,
    fontFamily: '"Microsoft YaHei UI", "Noto Sans SC", system-ui, sans-serif',
    color: '#ffe9a8',
    activeColor: '#ffd54a',
    strokeColor: '#000000',
    /**
     * 描边宽度：单位是"**字号 42px 时的等效像素**"。
     * 渲染时会按当前字号等比缩放，并夹在 `字号 × 9%` 以内 ——
     * 中文笔画密，描边太粗会把笔画之间的缝填死、整行糊成一团
     * （2026-09-26 实测：32px 字号配 6px 描边 = 18.8%，肉眼就是一团黑）。
     */
    strokeWidth: 2.5,
    opacity: 1,
    /**
     * 歌词底板不透明度（0 = 关闭）。
     * 垫一条半透明深色带 —— 对付文字融进背景（比如浅青高亮落在青蓝色画面上）
     * 最稳的办法；描边太粗中文会糊、换色只是换一种背景翻车。0.35~0.55 最常用。
     */
    backdrop: 0.75,
    /** 底板颜色。深色字配浅底（#ffffff），浅色字配深底（#000000） */
    backdropColor: '#000000',
    align: 'center',
    showTranslation: true,
    showRoma: false,
    // 每行还可能带翻译，上下各留 1 行就够；再多会在小窗口里溢出被裁
    // （用户反馈过"英文只显示下半边、后面还堆了一堆预告行"）
    linesBefore: 1,
    linesAfter: 1,
    offsetMs: 0,           // 全局歌词偏移微调
    showTrackCard: true,
    hideAfterIdleMs: 0,    // 0=不自动隐藏
    width: 1280,           // 叠加层页面逻辑尺寸（直播姬浏览器源用同尺寸最省心）
    height: 200,

    /**
     * 播放器信息栏（独立于歌词的展示模块）
     * 相当于"音乐播放器的信息展示栏"：封面 + 歌名 + 歌手 + 点歌者 + 进度条 + 下一首。
     */
    infoBar: {
      enabled: true,
      position: 'top-left',   // top-left | top-right | bottom-left | bottom-right | top-center | bottom-center
      theme: 'card',          // card（带底卡） | minimal（无底卡，仅文字）
      scale: 1,
      opacity: 1,
      showCover: true,
      showRequester: true,    // 显示"点歌：xxx"
      showSource: true,       // 显示 网易云 / 本地 / B站视频 角标
      showProgress: true,     // 进度条
      showTime: true,         // 当前时间 / 总时长
      showUpNext: true,       // 下一首预览
      showBiliStats: true,    // B站视频额外显示 UP主/播放量/弹幕数
      hideWhenIdle: true,     // 没在播时不显示
      accentColor: '#7ee7ff',
      coverSize: 64,
    },
  },

  player: {
    /**
     * 音量（0~1）与静音**会记忆**：改后写回这里，下次启动按这个恢复。
     * 历史上静音放在 `playback.muted`（"播放行为"段）且**改完不落盘**、
     * 音量则是只读不写 —— 所以两者都记不住（2026-09-26 修，统一到本段）。
     */
    volume: 1,
    muted: false,
    deviceId: '',          // setSinkId 的输出设备（VoiceMeeter 里选）
    deviceLabel: '',       // 设备名；deviceId 失效时按名字找回（见 engine.setDevice）
    prerollMs: 350,        // 歌词提前量，配合人耳延迟
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 数据目录解析
 * ============
 * 默认**放在程序自己所在的目录下**（`<程序目录>/data`），而不是用户主目录。
 * 原因：这套东西是要整个丢在 T 盘跑的，配置、缓存、登录会话都应该跟着程序走，
 * 不能偷偷往 C 盘用户目录里写。
 *
 * 覆盖方式：环境变量 `NEKOFM_DATA`（指向任意目录）。
 */
const APP_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 数据根目录（配置 / 缓存 / 封面 / 登录态 partition 全在它下面）。
 *
 * 定位是**绿色版**：数据就放在程序自己旁边，整个文件夹拷走就换机器可用。
 *   - 打包后 → **exe 同目录下的 `data/`**（所以别装到 Program Files 这类
 *     需要管理员权限的地方，那里写不进去）。
 *   - 开发时 → 源码根目录下的 `data/`。
 *   - `NEKOFM_DATA` 环境变量优先级最高：测试与自检**必须**走这条，
 *     否则会动到用户的真实缓存（见 PROGRESS 里"测试不许动用户数据"那节）。
 *
 * ⚠️ 这也是**不用 portable 单文件包**的原因：那种包运行时会把程序解压到临时目录，
 * `app.getPath('exe')` 指向的是临时目录 —— "exe 同目录"就失去意义了。
 */
function dataRoot() {
  if (process.env.NEKOFM_DATA) return process.env.NEKOFM_DATA;
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.join(path.dirname(app.getPath('exe')), 'data');
    }
  } catch { /* headless（纯 Node）下没有 electron */ }
  return path.join(APP_ROOT, 'data');
}

function configPath() {
  const dir = dataRoot();
  return { dir, file: path.join(dir, 'config.json'), appRoot: APP_ROOT };
}

module.exports = { DEFAULT_CONFIG, deepMerge, configPath, APP_ROOT };
