/**
 * 歌词同步核心（UMD：Node 与浏览器共用同一份实现，避免两端逻辑漂移）
 * =====================================================================
 * 这是整个歌词系统里**唯一**决定"当前该显示哪一行、这一行唱到第几个字"的地方。
 *
 * 为什么不能直接用网络推来的 position：
 *   服务端以约 10Hz 广播进度，网络与事件循环抖动会让歌词"一跳一跳"。
 *   因此叠加层拿到 (position, serverTime) 后，用本地时钟插值：
 *       pos(t) = position + (now - serverTime)/1000 * rate
 *   再由 requestAnimationFrame 每帧调用 locate()，得到 60fps 平滑推进。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LyricSync = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 定位：给定进度（秒）返回渲染所需的一切。
   * @param {{lines:Array}} timeline
   * @param {number} pos 秒
   * @param {{preroll?:number}} [opts] preroll=提前多少秒切到下一行
   */
  function locate(timeline, pos, opts) {
    const lines = (timeline && timeline.lines) || [];
    const pr = (opts && opts.preroll != null) ? opts.preroll : 0.35;
    const n = lines.length;
    if (!n) return empty();

    let idx = -1;
    for (let i = 0; i < n; i++) {
      if (pos + 1e-6 >= lines[i].time - pr) idx = i;
      else break;
    }
    if (idx < 0) return empty();

    const cur = lines[idx];
    const end = (cur.end == null ? cur.time + 6 : cur.end);
    const span = Math.max(0.001, end - cur.time);
    const progressInLine = clamp01((pos - cur.time) / span);

    let wordProgress = 0;
    const words = cur.words || [];
    if (cur.karaoke === 'word' && words.length) {
      const local = pos - cur.time;
      let done = 0;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const d = w.d || 0;
        if (local >= w.t + d) done += w.text.length;
        else if (local >= w.t) {
          const frac = d ? Math.min(1, (local - w.t) / d) : 1;
          done += w.text.length * frac;
        }
      }
      const total = words.reduce((s, w) => s + w.text.length, 0) || 1;
      wordProgress = clamp01(done / total);
    }

    return {
      index: idx,
      current: cur,
      prev: idx > 0 ? lines[idx - 1] : null,
      next: idx + 1 < n ? lines[idx + 1] : null,
      progressInLine,
      wordProgress,
      /** 是否需要逐字渲染 */
      wordLevel: cur.karaoke === 'word' && words.length > 0,
    };
  }

  function empty() {
    return { index: -1, current: null, prev: null, next: null, progressInLine: 0, wordProgress: 0, wordLevel: false };
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /**
   * 把带逐字信息的行切成渲染片段，便于前端给每个字单独上色。
   * 返回 [{text, from, to}]，from/to 是**行内秒数**区间。
   * 非逐字行则退化为单段（from=0, to=行时长）。
   */
  function segments(line) {
    if (!line) return [];
    if (line.karaoke === 'word' && line.words && line.words.length) {
      return line.words.map((w) => ({ text: w.text, from: w.t, to: w.t + (w.d || 0) }));
    }
    const dur = Math.max(0.001, (line.end == null ? line.time + 6 : line.end) - line.time);
    return [{ text: line.text, from: 0, to: dur }];
  }

  /**
   * 估算插值后的播放位置。
   * @param {{position:number, serverTime:number, rate?:number, paused?:boolean}} snapshot
   * @param {number} nowMs 本地时钟（Date.now()）
   */
  function interpolate(snapshot, nowMs) {
    if (!snapshot) return 0;
    if (snapshot.paused) return snapshot.position || 0;
    const rate = snapshot.rate == null ? 1 : snapshot.rate;
    const dt = Math.max(0, (nowMs - (snapshot.serverTime || nowMs)) / 1000);
    return (snapshot.position || 0) + dt * rate;
  }

  return { locate, segments, interpolate, clamp01 };
}));
