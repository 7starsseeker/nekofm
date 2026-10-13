/**
 * 竖刻度音量控件（UMD：控制台底部播放器栏与播放核心窗共用同一份实现）
 * =====================================================================
 * 2026-10-13 用户要求：把横着的音量条换成一个按钮，鼠标移上去弹出**竖着的、
 * 带刻度的**音量条（比原来长），并且**按每格 2% 变化**（不要无缝上下拉）。
 *
 * 为什么是一个共享模块，而不是两个页面各写一遍：
 *   音量控件在两个页面都存在（控制台底部栏、播放核心窗），而"每格 2%""刻度是
 *   51 格""面板不能被裁掉"这些约束只要有一边写歪就是两个不同的控件。
 *   控制台页的 CSS 全内联在 <head>、播放核心页也有自己的 <style>，
 *   所以这里**自带样式**（前缀 nkvd-），挂载即用。
 *
 * 竖条怎么实现的：`writing-mode: vertical-lr` + `direction: rtl`
 *   —— Chromium 119+ 的原生竖排 range（旧写法 `-webkit-appearance: slider-vertical`
 *   已废弃）。`direction: rtl` 让它 0 在下、100 在上。
 *   原生轨道整个透明，刻度与凹槽由我们自己画。
 *   旋钮也是自己画的：Chromium 排竖排 range 时原生拇指横向**不居中**（实测右偏 9px），
 *   所以原生拇指只留手感（opacity:0），视觉旋钮由 paint() 按音量定位。
 *   面板里**不再写"每格 2% / 共 50 格"这类说明文字** —— 刻度自己会说话（用户 2026-10-13 要求去掉）。
 *
 * 面板为什么用 position:fixed：播放核心页的 <main> 是 `overflow:auto` 的滚动容器，
 *   绝对定位的子元素会被它裁掉；fixed 的包含块是视口，不被祖先的 overflow 剪裁。
 *   代价是要自己算坐标（open() 里做了上下翻转 + 视口夹取）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NekoVolumeDial = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEP = 2;            // 每格 2%
  const TRACK_H = 200;       // 竖条长度（px）—— 原来的横条只有 72px
  const TICKS = 100 / STEP;  // 50 格 ⇒ 51 条刻度
  const GAP = 8;             // 面板与按钮的间距
  const CLOSE_DELAY = 220;   // 移开后延时关闭，给"从按钮挪进面板"留出时间
  const PAD = 6;             // 凹槽/刻度相对轨道上下各内缩多少（两端才不会顶格）
  const KNOB_W = 24;         // 旋钮宽 —— 比 20px 的条略宽一点（用户 2026-10-13 反馈）
  const KNOB_H = 13;

  const CSS = `
.nkvd { position: relative; display: inline-flex; align-items: center; gap: 6px; }
.nkvd-btn { display: inline-flex; align-items: center; gap: 5px; }
.nkvd-btn .nkvd-pct { font-variant-numeric: tabular-nums; font-size: 12px; opacity: .9; }
.nkvd-btn.open { border-color: #2bd3ff; color: #d9f6ff; }
/* 动态音量开着时按钮底边亮一道 —— 不是第二个按钮，只是"我知道它在工作" */
.nkvd-btn.agc { box-shadow: inset 0 -2px 0 #2bd3ff; }
.nkvd-panel {
  position: fixed; z-index: 1000; display: flex; flex-direction: column; gap: 8px;
  padding: 10px 12px 8px; border-radius: 10px; background: rgba(13, 18, 26, .98);
  border: 1px solid #26313f; box-shadow: 0 10px 28px rgba(0, 0, 0, .55);
}
.nkvd-panel[hidden] { display: none; }
.nkvd-body { display: flex; align-items: stretch; gap: 10px; }
/* 条宽 20px：再宽就只是空白（用户 2026-10-13："条本身有点宽"）。
   滑块（thumb）比条**略宽一点**（24px），像卡在轨道上的一枚旋钮；条本身不再变宽 ——
   第一版做成"占条一半"（10px）细得难看（同为 2026-10-13 的反馈）。 */
.nkvd-track { position: relative; width: 20px; height: ${TRACK_H}px; }
.nkvd-groove {
  position: absolute; left: 50%; transform: translateX(-50%); top: 6px; bottom: 6px;
  width: 6px; border-radius: 3px; background: rgba(23, 32, 48, .9); box-shadow: inset 0 0 0 1px #16202c;
}
/* 两种刻度叠在一起：每 10% 一条长的，每 2% 一条短的（50 格 ⇒ 51 条） */
.nkvd-ticks {
  position: absolute; left: 0; right: 0; top: 6px; bottom: 6px; pointer-events: none;
  background-image:
    repeating-linear-gradient(to top, #7c9cbd 0 2px, transparent 2px 10%),
    repeating-linear-gradient(to top, #33475c 0 1px, transparent 1px ${(100 / TICKS).toFixed(3)}%);
}
.nkvd-range {
  -webkit-appearance: none; appearance: none; position: relative; z-index: 1;
  width: 20px; height: ${TRACK_H}px; margin: 0; background: transparent;
  writing-mode: vertical-lr; direction: rtl; cursor: ns-resize;
}
.nkvd-range::-webkit-slider-runnable-track { width: 6px; height: 100%; background: transparent; }
/* 原生拇指**只留手感、不留外观**：Chromium 排竖排 range 时把它往右偏了约 9px
   （实测：条中心 CSS 1074.7 / 拇指中心 1083.7），改样式治不了 —— 所以让它透明，
   视觉上的旋钮由 .nkvd-knob 自己画、位置由 paint() 按音量算，跟凹槽/刻度严格同心。 */
.nkvd-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: ${KNOB_W}px; height: ${KNOB_H}px; opacity: 0;
}
.nkvd-range:focus-visible { outline: 2px solid #2bd3ff; outline-offset: 2px; }
/* 旋钮：比 20px 的条略宽（24px），像卡在轨道上的一枚旋钮，不盖死刻度 */
.nkvd-knob {
  position: absolute; left: 50%; top: 0; margin-left: ${-KNOB_W / 2}px;
  width: ${KNOB_W}px; height: ${KNOB_H}px; border-radius: 5px; pointer-events: none;
  background: linear-gradient(180deg, #bff2ff, #2bd3ff); border: 1px solid #0b1118;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .6);
}
.nkvd-side { display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 58px; }
.nkvd-big { font-size: 20px; font-weight: 700; color: #d9f6ff; font-variant-numeric: tabular-nums; }
.nkvd-agcrow {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  border-top: 1px solid #1d2836; padding-top: 7px; font-size: 12px; color: #8b98a8;
}
.nkvd-agcrow label { display: inline-flex; align-items: center; gap: 4px; }
.nkvd-agcrow input[type=number] { width: 52px; background: #172030; color: #cfd8e3; border: 1px solid #26313f; border-radius: 6px; padding: 2px 4px; font-size: 12px; }
.nkvd-cur { color: #7c8798; font-variant-numeric: tabular-nums; }
.nkvd-cur.on { color: #9fe9ff; }
`;

  let styled = false;
  function injectStyle(doc) {
    if (styled || !doc || doc.getElementById('nkvd-style')) { styled = true; return; }
    const s = doc.createElement('style');
    s.id = 'nkvd-style';
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
    styled = true;
  }

  const pctOf = (v) => Math.round((Number(v) || 0) * 100);
  /** 量化到 2% 的整数倍 —— "不用无缝上下拉"就落在这里（唯一一处改值的地方） */
  const snap = (v) => Math.round((Number(v) || 0) * 100 / STEP) * STEP / 100;
  const fmtDb = (db) => (Number.isFinite(db) ? (db >= 0 ? '+' : '') + db.toFixed(1) : '—');

  /**
   * 挂载到 host 元素里。
   *
   * 2026-10-13 用户反馈后的第二次调整：**栏里只留一个按钮**（喇叭图标 + 百分比），
   *   鼠标移上去展开竖条、**点击直接静音/取消静音**；"动态音量"不再单独占一个
   *   状态按钮与一行 dB 读数，开关和读数都收进弹出面板里（面板本来就住得下）。
   *
   * @param {HTMLElement} host 容器（会被清空）
   * @param {object} [opts]
   *   opts.volume      初始音量（线性 0~1）
   *   opts.muted       是否静音（按钮图标随之变 🔇）
   *   opts.showAgc     面板里要不要"动态音量"那一行（默认要）
   *   opts.autoGain    {enabled, targetDb}
   *   opts.onVolume    (volume:number) => void            用户改了音量
   *   opts.onAutoGain  (g:{enabled,targetDb}) => void     用户改了动态音量
   *   opts.onMute      (muted:boolean) => void            用户点了按钮要切静音
   * @returns {{update:Function, open:Function, close:Function, el:object}}
   */
  function mount(host, opts) {
    const o = opts || {};
    const doc = host.ownerDocument;
    injectStyle(doc);
    const st = {
      volume: o.volume == null ? 1 : Number(o.volume),
      muted: !!o.muted,
      showAgc: o.showAgc !== false,
      autoGain: Object.assign({ enabled: false, targetDb: -16 }, o.autoGain || {}),
      /** 播放核心回报的实时电平（dBFS）与增益（dB）；null = 还没有读数 */
      db: null,
      gainDb: null,
      live: false,
      /** 增益是否已经顶到上限（源电平过低，AGC 再怎么加也够不到目标） */
      capped: false,
    };

    host.textContent = '';
    const wrap = doc.createElement('span');
    wrap.className = 'nkvd';
    wrap.innerHTML = [
      '<button type="button" class="nkvd-btn" title="音量 / 静音：点击切换静音，鼠标移上来展开竖条（每格 2%）">',
      '<span class="nkvd-ico">🔊</span>',
      '<span class="nkvd-pct">100%</span></button>',
      '<div class="nkvd-panel" hidden>',
      '  <div class="nkvd-body">',
      '    <div class="nkvd-track">',
      '      <div class="nkvd-groove"></div><div class="nkvd-ticks"></div>',
      `      <input type="range" class="nkvd-range" min="0" max="100" step="${STEP}" value="100" title="音量：每格 ${STEP}%" />`,
      '      <div class="nkvd-knob"></div>',
      '    </div>',
      '    <div class="nkvd-side">',
      '      <div class="nkvd-big">100%</div>',
      '    </div>',
      '  </div>',
      st.showAgc ? [
        '  <div class="nkvd-agcrow">',
        '    <label><input type="checkbox" class="nkvd-agcon" />动态音量</label>',
        '    <label>目标 <input type="number" class="nkvd-target" min="-40" max="0" step="1" /> dBFS</label>',
        '    <span class="nkvd-cur">当前 —</span>',
        '  </div>',
      ].join('\n') : '',
      '</div>',
    ].join('\n');
    host.appendChild(wrap);

    const el = {
      wrap,
      btn: wrap.querySelector('.nkvd-btn'),
      ico: wrap.querySelector('.nkvd-ico'),
      pct: wrap.querySelector('.nkvd-pct'),
      panel: wrap.querySelector('.nkvd-panel'),
      range: wrap.querySelector('.nkvd-range'),
      knob: wrap.querySelector('.nkvd-knob'),
      big: wrap.querySelector('.nkvd-big'),
      agcon: wrap.querySelector('.nkvd-agcon'),
      target: wrap.querySelector('.nkvd-target'),
      cur: wrap.querySelector('.nkvd-cur'),
    };

    // ------------------------------------------------------------------ 绘制
    function paint() {
      const p = pctOf(st.volume);
      if (!st.dragging && doc.activeElement !== el.range) el.range.value = String(p);
      // 旋钮中心在凹槽两端之间走：中心从 PAD 走到 TRACK_H - PAD（与刻度同一段）
      const travel = TRACK_H - PAD * 2;
      // 0% 在下、100% 在上，所以是 travel * (1 - v)（与 direction:rtl 的滑块一致）
      if (el.knob) el.knob.style.top = (PAD - KNOB_H / 2 + travel * (1 - p / 100)).toFixed(2) + 'px';
      el.pct.textContent = p + '%';
      el.big.textContent = (st.muted ? '静音 ' : '') + p + '%';
      el.ico.textContent = st.muted ? '🔇' : (p === 0 ? '🔈' : p <= 50 ? '🔉' : '🔊');
      el.btn.classList.toggle('agc', !!st.autoGain.enabled);
      if (el.agcon) el.agcon.checked = !!st.autoGain.enabled;
      if (el.target && doc.activeElement !== el.target) el.target.value = String(Math.round(st.autoGain.targetDb));
      const on = !!st.autoGain.enabled;
      if (el.cur) {
        el.cur.textContent = on
          ? (st.db == null ? '当前 —' : `当前 ${fmtDb(st.db)} dBFS · 增益 ${fmtDb(st.gainDb)} dB` + (st.capped ? '（已达上限）' : ''))
          : `当前 —（目标 ${fmtDb(st.autoGain.targetDb)} dBFS）`;
        el.cur.classList.toggle('on', on);
      }
    }

    // ------------------------------------------------------------------ 面板开合
    let closeTimer = null;
    function place() {
      if (!el.panel || el.panel.hidden) return;
      const r = el.btn.getBoundingClientRect();
      const pw = el.panel.offsetWidth;
      const ph = el.panel.offsetHeight;
      // 上下翻转：上方放不下就往下开（播放核心窗的按钮在最上面一行）
      let top = r.top - ph - GAP;
      if (top < GAP) top = Math.min(r.bottom + GAP, Math.max(GAP, window.innerHeight - ph - GAP));
      let left = r.left + r.width / 2 - pw / 2;
      left = Math.max(GAP, Math.min(left, window.innerWidth - pw - GAP));
      el.panel.style.top = Math.round(top) + 'px';
      el.panel.style.left = Math.round(left) + 'px';
    }
    function open() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      if (!el.panel.hidden) return;
      el.panel.hidden = false;
      place();
      el.btn.classList.add('open');
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
    }
    function close() {
      if (el.panel.hidden) return;
      el.panel.hidden = true;
      el.btn.classList.remove('open');
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    }
    function closeSoon() {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        closeTimer = null;
        // 指针在面板里、或面板里的输入框有焦点（正在输目标 dB）时不关
        if (wrap.matches(':hover') || el.panel.contains(doc.activeElement)) return;
        close();
      }, CLOSE_DELAY);
    }
    el.btn.addEventListener('mouseenter', open);
    el.btn.addEventListener('focus', open);
    // 点击 = 静音开关（用户 2026-10-13：图标与百分比合成一个按钮，点了直接静音）。
    // 展开面板仍靠 hover / 键盘 focus，所以点击不会把面板顶开或关掉。
    el.btn.addEventListener('click', (e) => {
      e.preventDefault();
      st.muted = !st.muted;
      paint();
      if (o.onMute) o.onMute(st.muted);
    });
    wrap.addEventListener('mouseleave', closeSoon);
    el.panel.addEventListener('mouseleave', closeSoon);
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    doc.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) close(); });

    // ------------------------------------------------------------------ 交互
    el.range.addEventListener('pointerdown', () => { st.dragging = true; });
    const stopDrag = () => { st.dragging = false; };
    el.range.addEventListener('pointerup', stopDrag);
    el.range.addEventListener('pointercancel', stopDrag);
    window.addEventListener('pointerup', stopDrag);
    el.range.addEventListener('input', () => {
      const v = snap(Number(el.range.value) / 100);
      st.volume = v;
      paint();
      if (o.onVolume) o.onVolume(v);
    });
    // 键盘操作同样按格走：默认 step 已是 2，这里只补一次 paint
    el.range.addEventListener('change', paint);

    function emitAgc(patch) {
      st.autoGain = Object.assign({}, st.autoGain, patch);
      paint();
      if (o.onAutoGain) o.onAutoGain({ enabled: !!st.autoGain.enabled, targetDb: Number(st.autoGain.targetDb) });
    }
    if (el.agcon) el.agcon.addEventListener('change', () => emitAgc({ enabled: el.agcon.checked }));
    if (el.agc) el.agc.addEventListener('click', (e) => { e.preventDefault(); emitAgc({ enabled: !st.autoGain.enabled }); });
    if (el.target) {
      const commit = () => {
        const v = Math.max(-40, Math.min(0, Math.round(Number(el.target.value))));
        if (!Number.isFinite(v)) { paint(); return; }
        el.target.value = String(v);
        emitAgc({ targetDb: v });
      };
      el.target.addEventListener('change', commit);
      el.target.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
    }

    /**
     * 外部状态回填（10Hz 的 state 广播会反复调用它）。
     * 拖动中/焦点在滑块上时不回填滑块 —— 与旧实现同一条判据，
     * 否则手指按着的时候滑块会被广播拽回去。
     */
    function update(patch) {
      const p = patch || {};
      if (p.volume != null) st.volume = snap(p.volume);
      if (p.muted != null) st.muted = !!p.muted;
      if (p.autoGain) st.autoGain = Object.assign({}, st.autoGain, p.autoGain);
      if (p.db !== undefined) st.db = p.db;
      if (p.gainDb !== undefined) st.gainDb = p.gainDb;
      if (p.live !== undefined) st.live = !!p.live;
      if (p.capped !== undefined) st.capped = !!p.capped;
      paint();
      return st;
    }

    paint();
    return { update, open, close, el, state: st };
  }

  return { mount, STEP, TRACK_H, TICKS, snap };
}));
