/* ==========================================================================
   NekoFM 歌词叠加层逻辑
   --------------------------------------------------------------------------
   数据流：SSE(/events) → snapshot{position, serverTime, rate, paused}
                        → rAF 每帧插值 → locate() → 渲染
   渲染策略（性能关键）：
     · 只在「可见行的窗口」变化时重建 DOM，其余帧只改 CSS 变量/裁剪百分比
     · 逐字卡拉OK用「双层文本 + clip-path」实现，避免每帧改大量 DOM
   ========================================================================== */
'use strict';

(function () {
  const QS = new URLSearchParams(location.search);

  /**
   * 分区显示：`?only=lyrics` 只显示歌词，`?only=info` 只显示播放信息卡片。
   *
   * 为什么要支持分开：直播姬里可以放**两个浏览器源**，各自摆位置和大小
   * （歌词放底部、信息卡放左上角），比挤在一张画布里互相压住强得多。
   * 不传参数时两张都显示，保持向后兼容。
   */
  const ONLY = (QS.get('only') || 'both').toLowerCase();
  if (ONLY === 'lyrics' || ONLY === 'info') {
    document.documentElement.classList.add('only-' + ONLY);
  }

  // ---------------------------------------------------------------- 预览窗工具条
  /**
   * Electron 的叠加层预览窗是无边框的（没有系统标题栏/关闭按钮），
   * 不给入口用户就关不掉 —— 实测被吐槽过。
   * 只有 ?preview=1 才启用；直播姬的浏览器源不带该参数，
   * 所以正式画面里不会出现这条工具条。
   */
  function initPreviewBar() {
    if (QS.get('preview') !== '1') return;
    const bar = document.getElementById('previewBar');
    if (!bar) return;
    bar.hidden = false;
    document.body.classList.add('preview-mode');
    // 走 /api/command（同源），由主进程隐藏窗口
    const post = (body) => fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => { /* 忽略 */ });

    /**
     * **必须带上自己的模式**。
     * 三种预览窗共用同一个页面，如果不带 mode，在"歌词预览"里点关闭
     * 会去关"整体预览"那个窗口 —— 看起来就是"点了没反应"。
     */
    const MY_MODE = (ONLY === 'lyrics' || ONLY === 'info') ? ONLY : 'both';
    const release = (e) => {
      if (e) e.preventDefault();
      post({ action: 'hideOverlayWindow', mode: MY_MODE });
    };

    const close = document.getElementById('pbClose');
    if (close) {
      // 只挂 click：pointerdown 会在它之后触发，会让 release() 被调两次
      // → 多发一次 hideOverlayWindow。close 按钮上方没有任何层，正常 click 不会丢。
      // 历史上同时挂过 pointerdown 做兜底（"万一 click 被吞"），实测并未用到。
      close.addEventListener('click', release);
    }
    const reload = document.getElementById('pbReload');
    if (reload) reload.addEventListener('click', () => location.reload());
    // Esc 也关掉：最符合直觉的"取消"操作
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') release(); });
    // 工具条标题写明当前是哪种预览，三个窗口同时开着时也不会认错
    const drag = document.getElementById('pbDrag');
    if (drag) {
      drag.textContent = '叠加层预览：' + ({ both: '歌词 + 信息卡片', lyrics: '只要歌词', info: '只要信息卡片' }[MY_MODE])
        + ' · 拖动此条可移动窗口';
    }
  }
  initPreviewBar();

  const els = {
    root: document.body,
    stage: document.getElementById('stage'),
    lines: document.getElementById('lines'),
    idle: document.getElementById('idle'),
    notice: document.getElementById('notice'),
    // 播放器信息栏
    infoBar: document.getElementById('infoBar'),
    ibCover: document.getElementById('ibCover'),
    ibCoverFallback: document.getElementById('ibCoverFallback'),
    ibName: document.getElementById('ibName'),
    ibSource: document.getElementById('ibSource'),
    ibQuality: document.getElementById('ibQuality'),
    ibArtist: document.getElementById('ibArtist'),
    ibRequester: document.getElementById('ibRequester'),
    ibBili: document.getElementById('ibBili'),
    ibSep1: document.getElementById('ibSep1'),
    ibSep2: document.getElementById('ibSep2'),
    ibProgressWrap: document.getElementById('ibProgressWrap'),
    ibBar: document.getElementById('ibBar'),
    ibPos: document.getElementById('ibPos'),
    ibDur: document.getElementById('ibDur'),
    ibUpNext: document.getElementById('ibUpNext'),
  };

  const showIdle = QS.get('idle') !== '0';
  const showNotices = QS.get('notices') !== '0';

  // ------------------------------------------------------------------ 状态
  const S = {
    config: {
      theme: QS.get('theme') || 'scroll',
      fontSize: 42,
      fontFamily: '"Microsoft YaHei UI", "Noto Sans SC", system-ui, sans-serif',
      color: '#ffe9a8',
      activeColor: '#ffd54a',
      strokeColor: '#000000',
      // "42px 字号时的等效像素"（实际渲染按当前字号等比缩放，并夹在字号的 9% 以内）
      strokeWidth: 2.5,
      opacity: 1,
      /** 歌词底板不透明度（0=关，0.3~0.6 常用）：垫一条半透明深色带，任何画面都看得清 */
      backdrop: 0.75,
      /** 底板颜色（深色字要配浅底）：'#ffffff' 是白底 */
      backdropColor: '#000000',
      align: 'center',
      showTranslation: true,
      showRoma: false,
      // showKaraoke 已移除（逐字功能下线）
      linesBefore: 2,
      linesAfter: 2,
      offsetMs: 0,
      showTrackCard: true,
      prerollMs: 350,
      infoBar: {
        enabled: true,
        position: 'top-left',
        theme: 'card',
        scale: 1,
        opacity: 1,
        showCover: true,
        showRequester: true,
        showSource: true,
        showProgress: true,
        showTime: true,
        showUpNext: true,
        showBiliStats: true,
        hideWhenIdle: true,
        accentColor: '#7ee7ff',
        coverSize: 64,
      },
    },
    timeline: { meta: {}, lines: [] },
    track: null,
    nowPlaying: null,
    upNext: null,
    /** 服务端快照：`position` **直接用**（不做本地外推，理由见 currentPosition 的注释） */
    snapshot: { position: 0, serverTime: 0, rate: 1, paused: true },
    /**
     * 服务端时钟 → 本地时钟的偏移。
     * **当前没有使用者** —— 叠加层改成直接用上报的 position 之后就不再需要换算时钟
     * （只有外推才需要）。字段留着，是为了将来真要做跨机时钟校准时有地方放。
     */
    clockSkew: 0,
    hidden: false,
    // renderedIndex 已废弃：重建由 frame() 的 lastIndex + renderSig 决定
    activeEl: null,
    notices: [],
    lastNoticeAt: 0,
  };

  // ------------------------------------------------------------------ 工具
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  /**
   * 字号按**视口高度**等比缩放（1080p 为基准）。
   *
   * 为什么（2026-09-26 用户反馈"覆盖层尺寸还是组件和总体大小差得很远"）：
   * 字号原来是**固定 px**，源尺寸一变、歌词的"相对大小"就完全走样。实测同一份 42px 配置：
   *   · 1920×1080 → 歌词块只占视口高的 **8%**（看着很小，跟画面不成比例）
   *   · 1280×360 → 25%
   *   · 800×240  → 38%
   *   · 600×180  → **50% 且开始被裁切**
   * 也就是：在直播姬里把浏览器源拉大拉小，歌词不跟着变，永远对不上。
   *
   * 现在：实际字号 = 配置值 × (视口高 / 1080)。
   *   · 1080p 的源上与原来**完全一致**（系数正好是 1）
   *   · 换源尺寸不用重新调字号，比例自动保持
   * 所以控制台里的"字号"从此是**1080p 基准**的值 —— 和你把源设成 1920×1080 时看到的一致。
   */
  function applyFontScale() {
    const c = S.config;
    const base = Number(c.fontSize) || 42;
    const vh = window.innerHeight || 1080;
    /**
     * **默认：字号就是配置值，不随源尺寸变**（2026-09-26 定）。
     *
     * 这是配合"**把浏览器源的框设成组件尺寸**"的用法 —— 框 1280×90 + 字号 42，
     * 字幕正好填满，所见即所得，不用来回试字号。
     *
     * 中间一度反过来做过（`fitHeight`：字号 = 视口高÷行数，让字幕去填满框），
     * 那是**反的**：框还是大框时字号会被算成几百像素，用户反馈
     * "歌词直接变成雷霆大字稍微显示几个" —— 就是那个。
     *
     * 打开 `scaleFont` 才按视口等比缩放（1080p 基准，源很矮时不缩放），
     * 那是给"源铺满整个画面"的用法准备的。
     */
    const scale = c.scaleFont ? (vh >= 400 ? (vh / 1080) : 1) : 1;
    els.root.style.setProperty('--font-size', Math.max(8, base * scale).toFixed(2) + 'px');
  }

  function applyConfig(cfg) {
    if (!cfg) return;
    // infoBar 是嵌套对象，浅 merge 会把默认值整块冲掉，所以单独深合一次
    if (cfg.infoBar) S.config.infoBar = Object.assign({}, S.config.infoBar, cfg.infoBar);
    Object.assign(S.config, cfg);

    const c = S.config;
    const st = els.root.style;
    // 字号按视口高度缩放（1080p 为基准）—— 见 applyFontScale 的注释
    applyFontScale();
    st.setProperty('--font-family', c.fontFamily);
    st.setProperty('--color', c.color);
    st.setProperty('--active-color', c.activeColor);
    st.setProperty('--stroke-color', c.strokeColor);
    /**
     * 描边宽度**按字号等比缩放**、并夹一个上限（2026-09-26 修）。
     *
     * 原来是把 `strokeWidth` 当**绝对像素**直接用 —— 于是它和字号的比例会随字号漂移：
     * 用户把字号从 42 调到 32 想让字小一点，同一个 6px 描边的占比就从 14% 涨到 **19%**，
     * 中文笔画之间的缝被描边填死，整行**糊成一团**（用户反馈"歌词在画面里基本看不清、
     * 黑乎乎的一团"，截图确认就是这个）。而且直觉会指错方向：觉得"看不清"→ 调大描边 → 更糊。
     *
     * 两条措施：
     *   1) 按字号等比缩放 —— `strokeWidth` 的语义从此是"**42px 字号时的等效像素**"，
     *      换字号时描边占比保持不变；
     *   2) 夹上限 `fontSize * 9%`（42px 字号下约 3.8px）—— 足以在任何画面上勾出轮廓，
     *      又不足以把笔画黏起来。
     */
    /**
     * 描边宽度用 **em**（相对"元素自己的字号"）—— 2026-09-26 第二轮修复的关键一步。
     *
     * 起因：用户反馈"**英文大字体看着还行，中文小字体还是黑乎乎的**"。
     * 上一轮虽然改成按字号等比缩放了，但缩放基准是**基础字号**，而同一屏里各行字号并不相同：
     * 原文行是 `0.92×`、译文行只有 `0.6×` —— 于是在译文那种小字上，
     * 同一个绝对 px 的描边**占比反而更大**（25px 的字配 2.88px 描边 = 11.5%），笔画就被填死了。
     *
     * 改成 em 之后，每行都按**自己的**字号算：同一个 `0.06em` 在大字上是约 2.3px、
     * 在小字上自动变成约 1.5px，**比例恒定** → 大、中、小三种字号都不会糊。
     *
     * `strokeWidth` 的语义仍是"**42px 字号时的等效像素**"（所以这里和 42 相除），
     * 但上限从 9% 收紧到 **6%** —— 9% 对中文偏粗（中文笔画密、笔画间隙比英文小得多）。
     */
    const ratio = Math.min(Math.max(0, Number(c.strokeWidth) || 0) / 42, 0.06);
    st.setProperty('--stroke-width', ratio.toFixed(4) + 'em');
    st.setProperty('--opacity', String(c.opacity == null ? 1 : c.opacity));
    /**
     * 歌词底板（可选）：`backdrop` 是"底色不透明度" 0~0.8，> 0 即开启。
     * 对付"文字融进背景"最稳的一招 —— 见 overlay.css 里那段说明。
     */
    const bd = Math.min(0.95, Math.max(0, Number(c.backdrop) || 0));
    if (bd > 0) {
      els.root.setAttribute('data-backdrop', 'on');
      st.setProperty('--backdrop-alpha', bd.toFixed(2));
      // 底板颜色可选：深色字要配浅底才看得见（反之亦然）
      const bc = String(c.backdropColor || '#ffffff').replace('#', '');
      if (/^[0-9a-f]{6}$/i.test(bc)) {
        const n = parseInt(bc, 16);
        st.setProperty('--backdrop-color', [n >> 16 & 255, n >> 8 & 255, n & 255].join(', '));
      }
    } else {
      els.root.removeAttribute('data-backdrop');
    }
    st.setProperty('--align', c.align || 'center');
    els.stage.setAttribute('data-theme', c.theme || 'scroll');
    applyInfoBarStyle();
    /**
     * 这里**不再**靠 `S.renderedIndex = -2` 来"强制重建" ——
     * 那个字段根本没人读（frame() 的重建条件是 lastIndex + renderSig）。
     * 现在改主题 / 翻译 / 逐字开关会通过 `renderSig()` 让 frame() 自然重建，
     * 见那里的注释。
     */
  }

  /** 信息栏的外观（位置/主题/缩放/透明度/封面尺寸/强调色） */
  function applyInfoBarStyle() {
    const b = S.config.infoBar || {};
    const el = els.infoBar;
    el.className = 'info-bar'
      + ' pos-' + (b.position || 'top-left')
      + ' theme-' + (b.theme || 'card');
    el.style.setProperty('--ib-accent', b.accentColor || '#7ee7ff');
    el.style.setProperty('--ib-cover', (b.coverSize || 64) + 'px');
    el.style.opacity = String(b.opacity == null ? 1 : b.opacity);
    const sc = b.scale || 1;
    // 位置类里可能已经用了 transform（居中类），所以缩放走 zoom 之外的 CSS 变量
    // —— 这里改成在子元素上不缩放、整体用 scale 变量作用于 font-size 与尺寸更稳，
    // 简单起见用 transform 并保留 translate 组合。
    const pos = b.position || 'top-left';
    const base = pos.endsWith('center') ? 'translateX(-50%) ' : '';
    el.style.transform = base + (sc !== 1 ? `scale(${sc})` : '');
    el.style.transformOrigin = pos.includes('right') ? 'top right'
      : pos.includes('left') ? 'top left' : 'top center';
  }

  /**
   * 当前应显示的播放进度（秒）。
   *
   * **直接取上报值，不做本地外推**（2026-09-26 修 —— 与控制台歌词条那次是同一个根因，
   * 当时只改了歌词条，叠加层漏了，用户报"高亮行偏了、依然闪烁"）。
   *
   * 原来的写法是 `LyricSync.interpolate(snapshot, Date.now() + clockSkew)`，用本地时钟外推：
   *     pos(t) = position + (now - serverTime) * rate
   * 问题出在**两条时间线的频率不一致**：`position` 由播放核心 **5Hz** 上报，
   * 而状态广播是 **10Hz** —— 同一个 position 值会被推两次，每次 serverTime 都是新的，
   * 于是后一条消息算出的外推值**比上一条更小**（实测约 0.2s 一步的倒退）。
   * `locate()` 带 0.35s 预滚，换行点因此变得很脆：一倒退就把行号翻回上一行，
   * 相邻两行来回跳 —— 看起来就是"当前高亮行偏了，还在闪"。
   *
   * 为什么现在可以不要外推：它本来是给**逐字填充**准备的（需要 60fps 平滑推进），
   * 而逐字功能已下线（用户定），整句高亮根本不需要帧级精度。直接用上报值多了一个
   * 很宝贵的性质 —— **播放期间单调递增**，换行点确定。代价只是换行最多晚一个上报周期
   * （约 200ms，行内没有任何动画，看不出来）。
   *
   * 进度条也一并用它：5Hz 的步进折算到进度条宽度不足 1%，肉眼不可见，
   * 而换来的是位置单调、不会再出现"进度条往回缩一下"。
   */
  function currentPosition() {
    const snap = S.snapshot;
    const pos = snap && snap.position ? snap.position : 0;
    return pos + (S.config.offsetMs || 0) / 1000;
  }

  // ------------------------------------------------------------ 渲染：重建行
  function buildWindow(r) {
    const lines = S.timeline.lines || [];
    if (!lines.length) {
      els.lines.innerHTML = '';
      S.activeEl = null;
      return;
    }
    /**
     * **只显示当前这一条**（2026-09-26 用户定）。
     *
     * 双语（显示翻译）→ 这一条本身就是"原文 + 译文"两行；
     * 单行 → 只有原文一行。
     * 不再显示上/下若干行 —— 直播画面上要的是"干净的一两句"，
     * 而且**高度因此完全固定**（1 行或 2 行），源的框一次就能调准。
     * （`linesBefore/linesAfter` 现在只在"长前奏、还没唱到第一行"的预告阶段起作用。）
     */
    const before = 0;
    const after = 0;

    // r.index === -1：还没唱到第一行 → 把开头几行作为"预告"渲染，无 active
    const started = r.index >= 0;
    const from = started ? Math.max(0, r.index - before) : 0;
    const to = started
      ? Math.min(lines.length - 1, r.index + after)
      : Math.min(lines.length - 1, Math.max(1, after));

    const frag = document.createDocumentFragment();
    for (let i = from; i <= to; i++) {
      const ln = lines[i];
      const div = document.createElement('div');
      div.className = 'line' + (started && i === r.index ? ' active' : (started && Math.abs(i - r.index) === 1 ? ' near' : (started ? '' : ' upcoming')));
      div.dataset.idx = String(i);

      /**
       * 每行就一个纯文本 span。**逐字/逐行染色已下线**（2026-09-26 用户定）：
       * 之前的双层文本 + clip-path 填充（`.karaoke` / `.karaoke-line` 两套）
       * 连同「逐字」开关一起去掉了 —— 只保留"当前行高亮 + 其余变暗"。
       */
      {
        const span = document.createElement('span');
        span.className = 'seg';
        span.textContent = ln.text;
        div.appendChild(span);
      }

      if (S.config.showTranslation && ln.trans) {
        const t = document.createElement('span');
        t.className = 'trans';
        t.textContent = ln.trans;
        div.appendChild(t);
      }
      if (S.config.showRoma && ln.roma) {
        const t = document.createElement('span');
        t.className = 'roma';
        t.textContent = ln.roma;
        div.appendChild(t);
      }
      frag.appendChild(div);
    }
    els.lines.innerHTML = '';
    els.lines.appendChild(frag);
    S.activeEl = els.lines.querySelector('.line.active');

    // ---------------------------------------------------- 换行：滑动 + 居中
    /**
     * 原来的做法是"记住上一行相对容器的偏移，重建后先位移回旧位置再滑回 0"。
     * 但那个位移**恒为 0、从来没生效过**：`from = index - before` 保证当前行永远是
     * 列表里第 `before+1` 个元素，它的 `offsetTop` 是固定的 —— 于是 `_lastTop` 不变、
     * `dy` 恒为 0。这里保留这个量（开头那几行确实会变，那时它有意义），
     * 但把它和"居中对齐"合并到一次 transform 里，别再互相覆盖。
     */
    const newTop = S.activeEl ? S.activeEl.offsetTop : null;
    const slideY = (typeof S._lastTop === 'number' && newTop != null && S._lastTop !== newTop)
      ? (S._lastTop - newTop) : 0;   // 正值：内容需要往下推，视觉上像"向上滚"
    if (newTop != null) S._lastTop = newTop;

    /**
     * 先收缩到"装得下"，**布局定下来之后**再对齐中心 —— 顺序不能反：
     * `autoFit()` 会删行、改变整体高度，先对齐再删等于白算。
     */
    autoFit();
    applyLinesTransform(slideY);
  }

  /**
   * 把**当前激活行锁在舞台的垂直中心**，列表内容围绕它上下滚动。
   *
   * 为什么需要（2026-09-26 用户反馈："当前激活行上下位置偏了，控制台里是锁在正中的"）：
   * CSS 里 `.stage` 与 `.lines` 都是 `justify-content/align-items: flex-end` ——
   * 也就是整块歌词**贴舞台底部**。块内部当前行确实是"中间那行"，但当块比舞台矮时，
   * 块的中心在舞台中心的**下方**，看起来就是"高亮行偏下"。
   *
   * 做法：量出当前行中心与舞台中心的差值，用 `translateY` 一次补掉。
   * **测之前先把 transform 清掉**再读 `getBoundingClientRect()` —— 否则读到的可能是
   * 上一次滑动动画的中间值，算出来的偏移会飘。
   *
   * @param {number} slideY 换行时额外的滑动位移（0 = 不滑动，直接落位）
   */
  function applyLinesTransform(slideY = 0) {
    if (!els.lines || !els.stage) return;
    const active = S.activeEl;
    if (!active) {
      // 还没有当前行（长前奏的"预告"阶段）：交给 CSS 的贴底布局，不做居中
      els.lines.style.transition = 'none';
      els.lines.style.transform = '';
      S._linesOffsetY = 0;
      return;
    }
    els.lines.style.transition = 'none';
    els.lines.style.transform = 'none';            // 先归零，测"自然位置"
    const sr = els.stage.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    const dy = (sr.top + sr.height / 2) - (ar.top + ar.height / 2);
    S._linesOffsetY = dy;

    els.lines.style.transform = `translateY(${(dy + slideY).toFixed(1)}px)`;
    void els.lines.offsetHeight;                   // 强制回流：这一步必须立刻生效
    if (slideY) {
      // 换行时从"旧位置"滑到居中位置（而不是啪地跳）
      els.lines.style.transition = 'transform .3s cubic-bezier(.22,.61,.36,1)';
      els.lines.style.transform = `translateY(${dy.toFixed(1)}px)`;
    }
  }

  /**
   * 舞台尺寸或留白变了（窗口缩放、信息栏显隐）→ 居中对齐要重算。
   * 这些变化不改行号，所以不会触发 buildWindow，必须单独接一下。
   */
  function reapplyCenter() {
    if (!S.timeline || !S.timeline.lines || !S.timeline.lines.length) return;
    requestAnimationFrame(() => applyLinesTransform(0));
  }

  /**
   * 把行数收缩到**装得下**为止。
   * 为什么必须有：每行可能还带翻译、字号又大，固定"上下各一行"在某些尺寸下
   * 依然会溢出 —— 溢出的表现就是最上面那行被裁掉一半（用户反馈"英文只显示下半边"）。
   * 宁可少显示几行，也保证当前行完整可见。
   * 收缩顺序：从**末尾**开始删，即先去调还没唱到的那些
   * （用户抱怨过"后面预告一大堆"）。
   */
  function autoFit() {
    const stageH = els.stage ? els.stage.clientHeight : 0;
    if (!stageH) return;
    let guard = 0;
    while (els.lines.scrollHeight > stageH && guard++ < 24) {
      const kids = Array.from(els.lines.children);
      const removable = kids.filter((el) => !el.classList.contains('active'));
      if (!removable.length) break; // 只剩当前行，再删就没内容了
      removable[removable.length - 1].remove();
    }
  }

  /**
   * 给歌词区让出信息栏的高度。
   * 信息栏在顶部时会压住歌词（用户反馈过"两块区域重合"），
   * 这里按它的实际高度留白，歌词区域自然下移。
   */
  function reserveForInfoBar() {
    const b = S.config.infoBar || {};
    let h = 0;
    if (b.enabled !== false && els.infoBar && !els.infoBar.hidden
        && String(b.position || 'top-left').startsWith('top')) {
      h = els.infoBar.offsetHeight + 6;
    }
    document.documentElement.style.setProperty('--lyric-reserve', h + 'px');
    S._lyricReserve = h;
  }

  /**
   * `?debug=1` 字体自检：把"候选字体在这台机器的浏览器里到底能不能用"直接画在页面上。
   *
   * 为什么需要：用户反馈"中文字体依然是衬线，怀疑没渲染到"，而**直播姬用的是 CEF**、
   * 我这边只能测 Edge —— 看不到它的真实渲染。与其猜，不如让页面自己报：
   * `document.fonts.check()` 对每个候选字体给有/无，再报一次 `computed fontFamily`。
   * 用户拍张照，就能确定是"字体名解析不到"还是"渲染管线的问题"。
   */
  (function debugFontProbe() {
    if (QS.get('debug') !== '1') return;
    const cands = ['Microsoft YaHei', '微软雅黑', 'SimHei', '黑体', 'Microsoft YaHei UI', 'Noto Sans SC'];
    const rows = cands.map((f) => `${f}: ${document.fonts.check(`16px "${f}"`) ? '有 ✅' : '无 ❌'}`);
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:6px;top:6px;z-index:99999;white-space:pre;'
      + 'font:13px/1.5 monospace;color:#0f0;background:rgba(0,0,0,.85);padding:6px 9px;border-radius:6px';
    el.textContent = '[字体自检] ' + rows.join(' ｜ ')
      + ' ｜ 实际使用: ' + getComputedStyle(document.body).fontFamily.split(',')[0];
    document.body.appendChild(el);
  })();

  // ------------------------------------------------- 渲染：每帧只更新进度
  /**
   * 逐字/逐行填充已下线（2026-09-26 用户定），所以这里不再需要每帧改填充比例。
   * 当前行的指示只靠 CSS（`.line.active` 用强调色、其余降透明度），
   * 由 buildWindow 在换行时重建即可 —— **每帧零 DOM 操作**。
   * 函数保留成一个空壳，是因为主循环里还调它；将来若要恢复"行内进度条"，
   * 这里是唯一的落点。
   */
  function updateProgress(/* r, pos */) { /* 无逐字填充 */ }

  // ------------------------------------------------------------------ 主循环
  /**
   * **渲染签名**：任何"影响歌词行 DOM 结构"的配置都要算进来。
   *
   * 踩过的坑（2026-09-26，用户报告"歌词形式改不回去"）：
   * 重建条件原来只比较**行号**（`r.index !== lastIndex`），而 applyConfig 里
   * 写的 `S.renderedIndex = -2`（本意是"强制重建"）**frame() 从来没读过**。
   * 后果：改主题 / 翻译 / 逐字开关时，`data-theme` 会变（CSS 跟着变），
   * 但**歌词行的 DOM 结构不重建** —— 之前按逐字拆好的 `.seg` 片段一直留着，
   * 于是"永远停在卡拉OK格式，再改也没用"。
   *
   * 教训：**"强制重建"这种意图，必须落在真正被读取的条件上**，
   * 写一个没人读的字段等于没写。
   */
  function renderSig() {
    const c = S.config;
    return [c.theme, c.showTranslation, c.showRoma, c.showTrackCard].join('|');
  }
  let lastIndex = -2;
  let lastSig = null;
  function frame() {
    requestAnimationFrame(frame);
    const pos = currentPosition();
    // 信息栏与歌词无关：没有歌词（纯音乐/视频）时进度条照样要走
    updateInfoBarProgress();
    if (!S.timeline.lines.length) {
      // 没有歌词时把**原因**写进占位文案，别让画面空着又不说为什么
      // （用户曾经看到叠加层只剩信息卡，以为布局坏了，其实是限流导致没歌词）
      if (els.idle) {
        const d = S.lyricDiag;
        if (d && d.reason) {
          els.idle.textContent = /操作频繁|请稍候|频繁/.test(d.reason)
            ? '歌词暂时取不到（网易云限流，稍后重播这首歌会自动恢复）'
            : '这首歌没有歌词';
        } else {
          els.idle.textContent = '等待播放…';
        }
      }
      return;
    }
    const r = LyricSync.locate(S.timeline, pos, { preroll: (S.config.prerollMs || 350) / 1000 });

    // index === -1 表示"还没唱到第一行"（长前奏常见）。
    // 此时不显示空白，而是把即将到来的几行暗着摆出来，观感更好。
    // 行号变了 **或** 渲染相关配置变了 → 重建（后者是"改主题不生效"的修复）
    const sig = renderSig();
    if (r.index !== lastIndex || sig !== lastSig) {
      lastIndex = r.index;
      lastSig = sig;
      S._r = r;
      buildWindow(r);
    }
    if (r.index >= 0) updateProgress(S._r || r, pos);
  }

  // ------------------------------------------------------------------ 信息栏
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  /** B站那些大数字：12345 → 1.2万 */
  function humanCount(n) {
    const v = Number(n) || 0;
    if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
    return String(v);
  }

  /**
   * 长文本**左右循环滚动** —— 只在真正溢出时滚。
   *
   * 用户要求："信息卡的显示是否可以做到左右循环滚动？目前一页显示不全的内容很多"。
   *
   * 做法：
   *   1. 先把上一次的包装**拆掉**，恢复成"干净的单份内容"
   *      （否则每次重绘都会再叠一层，内容越滚越长）；
   *   2. 量宽度：`scrollWidth <= clientWidth` 就是没溢出 → 保持静止，
   *      短歌名不会无谓地晃；
   *   3. 溢出时把现有子节点搬进 `.mq-run`（inline-block，宽度 = 内容），
   *      再追加一份 `.mq-dup` 副本，动画滚 `-50%` —— 那正好是"内容 + 3em 间隔"，
   *      首尾无缝衔接、看不出接缝；
   *   4. 时长按长度算（约 40px/s），长歌名不会滚得飞快。
   *
   * **必须在下一帧量宽度**：本帧刚改完文本，布局还没生效。
   */
  function applyRolling(el) {
    if (!el) return;
    const oldRun = el.querySelector(':scope > .mq-run');
    if (oldRun) {
      while (oldRun.firstChild) el.insertBefore(oldRun.firstChild, oldRun);
      oldRun.remove();
    }
    el.classList.remove('rolling');
    el.style.removeProperty('--mq-dur');
    requestAnimationFrame(() => {
      if (!el.clientWidth) return;                       // 卡片被隐藏时不折腾
      if (el.scrollWidth <= el.clientWidth + 2) return;  // 没溢出 → 静止
      const run = document.createElement('span');
      run.className = 'mq-run';
      while (el.firstChild) run.appendChild(el.firstChild);
      const dup = document.createElement('span');
      dup.className = 'mq-dup';
      dup.innerHTML = run.innerHTML;
      run.appendChild(dup);
      el.appendChild(run);
      el.style.setProperty('--mq-dur', Math.max(6, Math.round(run.scrollWidth / 40)) + 's');
      el.classList.add('rolling');
    });
  }

  function renderInfoBar() {
    const b = S.config.infoBar || {};
    const np = S.nowPlaying;
    if (!b.enabled || (!np && b.hideWhenIdle)) { els.infoBar.hidden = true; return; }
    if (!np) { els.infoBar.hidden = true; return; }
    els.infoBar.hidden = false;
    els.infoBar.classList.toggle('has-cover', !!b.showCover);

    // 封面：远端图直接用；本地图走 /stream/cover。取不到就显示音符占位
    if (b.showCover) {
      els.ibCover.parentElement.hidden = false;
      const src = np.cover || '';
      if (src && els.ibCover.getAttribute('src') !== src) {
        els.ibCover.hidden = false;
        els.ibCoverFallback.hidden = true;
        els.ibCover.onerror = () => { els.ibCover.hidden = true; els.ibCoverFallback.hidden = false; };
        els.ibCover.src = src;
      } else if (!src) {
        els.ibCover.hidden = true;
        els.ibCoverFallback.hidden = false;
      }
    } else {
      els.ibCover.parentElement.hidden = true;
    }

    els.ibName.textContent = np.name || '—';
    els.ibArtist.textContent = np.artistText || '';

    // 音源角标
    if (b.showSource && np.sourceLabel) {
      els.ibSource.hidden = false;
      els.ibSource.textContent = np.sourceLabel;
    } else els.ibSource.hidden = true;

    // 音质角标（网易云 level / B站码率标签）
    const q = np.quality || (np.via === 'browser' ? '浏览器取流' : '');
    if (q) { els.ibQuality.hidden = false; els.ibQuality.textContent = q; }
    else els.ibQuality.hidden = true;

    // 点歌者
    const who = np.requester && np.requester.uname;
    if (b.showRequester && who) {
      els.ibRequester.hidden = false;
      els.ibRequester.textContent = '点歌：' + who;
    } else els.ibRequester.hidden = true;
    els.ibSep1.hidden = els.ibRequester.hidden || !np.artistText;

    // B站视频附加信息：UP主 · 播放 · 弹幕
    if (b.showBiliStats && np.source === 'bilibili') {
      const bits = [];
      if (np.owner) bits.push('UP：' + np.owner);
      if (np.stats && np.stats.view != null) bits.push('播放 ' + humanCount(np.stats.view));
      if (np.stats && np.stats.danmaku != null) bits.push('弹幕 ' + humanCount(np.stats.danmaku));
      if (bits.length) { els.ibBili.hidden = false; els.ibBili.textContent = bits.join(' · '); }
      else els.ibBili.hidden = true;
    } else els.ibBili.hidden = true;
    els.ibSep2.hidden = els.ibBili.hidden || (els.ibRequester.hidden && !np.artistText);

    // 进度条与时长
    els.ibProgressWrap.hidden = !(b.showProgress || b.showTime);
    els.ibBar.parentElement.hidden = !b.showProgress;
    els.ibDur.textContent = fmtTime(S.snapshot.duration || np.duration || 0);
    els.ibPos.hidden = !b.showTime;
    els.ibDur.hidden = !b.showTime;

    // 下一首
    if (b.showUpNext && S.upNext) {
      els.ibUpNext.hidden = false;
      els.ibUpNext.textContent = '下一首：' + S.upNext.name
        + (S.upNext.artistText ? ' - ' + S.upNext.artistText : '')
        + (S.upNext.uname ? `（${S.upNext.uname} 点）` : '');
    } else els.ibUpNext.hidden = true;

    // 长文本（歌名 / 第二行）溢出时左右循环滚动
    applyRolling(els.ibName);
    applyRolling(els.ibLine2 || document.querySelector('.ib-line2'));
  }

  let _lastShownSec = -1;
  function updateInfoBarProgress() {
    const np = S.nowPlaying;
    if (!np || els.infoBar.hidden) return;
    const d = S.snapshot.duration || np.duration || 0;
    const pos = currentPosition();
    const pct = d ? clamp01(pos / d) * 100 : 0;
    els.ibBar.style.width = pct.toFixed(2) + '%';
    const sec = Math.floor(pos);
    if (sec !== _lastShownSec) {
      _lastShownSec = sec;
      els.ibPos.textContent = fmtTime(pos);
      if (!d) els.ibDur.textContent = fmtTime(np.duration || 0);
    }
  }

  // ------------------------------------------------------------------ 提示角标
  function showNotice(n) {
    if (!showNotices || !n) return;
    els.notice.textContent = n.text;
    els.notice.className = 'notice ' + (n.level || 'info');
    els.notice.hidden = false;
    clearTimeout(showNotice._t);
    showNotice._t = setTimeout(() => { els.notice.hidden = true; }, 4200);
  }

  // ------------------------------------------------------------------ SSE
  // SSE 单连接 + 退避重连的状态（见 control.js 同名注释：6 条连接上限）
  let esRetry = 0;
  function connect() {
    const es = new EventSource('/events');
    es.onopen = () => { esRetry = 0; };
    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'state') {
        // 记住"为什么没有歌词"，用于空闲占位文案（限流 / 这首歌确实没歌词）
        S.lyricDiag = (msg.lyric && msg.lyric.diag) || null;
        S.snapshot = {
          position: msg.playback.position || 0,
          serverTime: msg.serverTime,
          rate: msg.playback.rate || 1,
          paused: msg.playback.status !== 'playing',
          duration: msg.playback.duration || 0,
        };
        S.clockSkew = 0; // 当前不使用（位置已改为直接用上报值，见 currentPosition 的注释）
        S.track = msg.track;
        S.nowPlaying = msg.nowPlaying || null;
        S.upNext = msg.upNext || null;
        document.body.dataset.status = msg.playback.status;
        els.idle.hidden = !showIdle || !!msg.track;
        // 信息栏只在"曲目/点歌者/下一首/状态"变化时重渲染，
        // 进度与时间由每帧的 updateInfoBarProgress() 推，避免 10Hz 重建 DOM。
        const sig = [
          S.nowPlaying && S.nowPlaying.name,
          S.nowPlaying && S.nowPlaying.source,
          S.nowPlaying && S.nowPlaying.requester && S.nowPlaying.requester.uname,
          S.nowPlaying && S.nowPlaying.quality,
          S.upNext && S.upNext.name,
          msg.playback.status,
        ].join('|');
        if (sig !== renderInfoBar._sig) {
          renderInfoBar._sig = sig;
          renderInfoBar();
          reserveForInfoBar(); // 信息栏高度变了，歌词区的让位也要跟着变
          // 舞台可用高度变了 → 居中对齐要重算（这里没走 buildWindow，得单独接）
          reapplyCenter();
        }
        if (msg.notices && msg.notices[0] && msg.notices[0].at !== S.lastNoticeAt) {
          S.lastNoticeAt = msg.notices[0].at;
          showNotice(msg.notices[0]);
        }
        return;
      }

      if (msg.type === 'lyrics') {
        S.timeline = msg.timeline || { meta: {}, lines: [] };
        lastIndex = -2;
        lastSig = null;
        els.lines.innerHTML = '';
        return;
      }

      if (msg.type === 'config') {
        applyConfig(msg.overlay);
        return;
      }
    };
    es.onerror = () => {
      // 显式 close + 退避重连：绝不让快速重连把连接池堆满（见 control.js 同名注释）
      try { es.close(); } catch { /* 忽略 */ }
      const delay = Math.min(1000 * 2 ** esRetry, 15000);
      esRetry++;
      setTimeout(() => { connect(); }, delay);
    };
  }

  // ------------------------------------------------------------------ 启动
  applyConfig(S.config);
  renderInfoBar();
  reserveForInfoBar();
  connect();
  requestAnimationFrame(frame);
  // 字体/封面等异步内容到位后高度可能变化，再校准一次让位与行数
  setTimeout(() => { reserveForInfoBar(); if (S._r) buildWindow(S._r); }, 600);

  // 供调试：window.__nekofm 可手工改配置
  // 窗口尺寸变化（用户拖预览窗、直播姬里改源尺寸）时重新排版
  window.addEventListener('resize', () => {
    reserveForInfoBar();
    applyFontScale();            // 视口高度变了 → 字号的比例基准跟着变
    if (S._r) buildWindow(S._r);
  });
  // 暴露给调试：可在控制台手工调自动收缩/让位
  window.__nekofm = { S, applyConfig, locate: LyricSync.locate, autoFit, reserveForInfoBar, applyRolling };
})();
