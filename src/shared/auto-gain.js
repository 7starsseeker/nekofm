/**
 * 动态音量（AGC：自动增益）的核心决策
 * =====================================================================
 * 这是"当前电平离目标差多少、这次该把增益定到哪"的**唯一**决定处，
 * 与 Web Audio 无关 —— 播放核心只负责"喂测量值 / 拿增益去设 GainNode"，
 * 于是这部分能在 Node 里直接对拍（见 tools/agc.check.js）。
 *
 * 2026-10-13 调研过的三条业界路线（选型依据，实测数据记在
 * 2026-10-13-agc-gates.md）：
 *   · ffmpeg `loudnorm`（EBU R128 / BS.1770）—— 按整段或前瞻缓冲算**积分响度**，
 *     一次给一个静态增益。适合交付，不跟随。
 *   · ReplayGain —— 整轨扫一遍把增益写进标签，播放时按标签施加。静态。
 *   · ffmpeg `dynaudnorm` / lordmulder Dynamic Audio Normalizer / **Windows 自带的
 *     「响度均衡」** —— 按短帧算局部电平、逐帧改增益。**本功能属于这一类。**
 * 从 dynaudnorm 抄来的四个关键量（默认值也照抄它的量级）：
 *   framelen 500ms（帧太短会跟着声音抖、太长跟不上）、gausssize 31 帧（跨帧平滑，
 *   窗越大增益变化越慢）、peak 0.95（安全天花板，文档明说"不会超过目标峰值"）、
 *   maxgain 10x（≈+20dB，但**建议 3~5x**，否则会把静音段/底噪一起抬起来）。
 * 我们取 400ms 窗、**±12dB**（≈4x，落在推荐区间）、天花板 -1dBFS（比 0.95 更保守一档）。
 *
 * 与 Windows 响度均衡的另一条共识：**快攻击 + 慢释放**（像宽带压缩器）。
 * 所以下调增益用短时间常数、上调用长时间常数（见 tauMs）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NekoAutoGain = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    targetDb: -16,      // 目标电平（RMS，dBFS）。平台归一化参考：YouTube/Spotify -14 LUFS、播客 -16~-19
    deadbandDb: 3,      // 死区：偏差不超过它就不动（"差得太远"才调整）
    windowMs: 400,      // 测量窗：短于 ~200ms 会跟着节奏抖，长于 ~1s 跟不上段落变化
    maxGainDb: 12,      // 最多提 12dB
    maxCutDb: 12,       // 最多压 12dB
    ceilingDb: -1,      // 输出峰值天花板（防削波）
    attackMs: 250,      // 往下压的速度（快）
    releaseMs: 1500,    // 往上提的速度（慢）
    /**
     * 低于这个 RMS 当作"没有节目"（曲子间隙、纯静音段）——**保持增益不动**。
     * 不这么做的话，间隙里测到的是底噪，增益会被一路顶到 +12dB，
     * 下一句人声进来先被炸一下（正是 dynaudnorm 的 `maxgain` 要防的事）。
     * 0.0015 ≈ -56dBFS。
     */
    minRms: 0.0015,
  };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const dbOf = (a) => 20 * Math.log10(a);

  /**
   * @param {object} [opts] 覆盖 DEFAULTS 的任意项
   */
  function create(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    let gainDb = 0;
    let srcDb = -Infinity;   // 增益**前**的节目电平（RMS）
    let outDb = -Infinity;   // 施加增益后应当达到的电平 = srcDb + gainDb
    let peakDb = -Infinity;
    let tauMs = cfg.releaseMs;
    let live = false;        // 本窗是否真的有节目
    let limited = false;     // 本窗算出的增益是否被 ±12dB 或峰值天花板拦住

    /**
     * 喂一个测量窗的结果，返回这一段该用的增益。
     *
     * 注意测的是**增益前**的电平 —— 这样不会自我循环（增益一动电平跟着动、
     * 于是增益再变），每段节目的校正量是稳定的；死区只用来压掉小抖动。
     *
     * @param {{rms:number, peak:number}} m 线性幅度（0~1），rms=RMS、peak=窗内峰值
     * @returns {{gainDb:number, srcDb:number, outDb:number, peakDb:number,
     *            tauMs:number, inBand:boolean, live:boolean, capped:boolean}}
     */
    function decide(m) {
      const rms = (m && m.rms) || 0;
      const peak = (m && m.peak) || 0;
      live = rms > cfg.minRms;
      if (!live) {
        // 没有节目：不动增益，也不报电平（界面显示"—"）
        srcDb = -Infinity; outDb = -Infinity; peakDb = -Infinity; limited = false;
        return state();
      }
      srcDb = dbOf(rms);
      peakDb = peak > 0 ? dbOf(peak) : -Infinity;
      const err = cfg.targetDb - srcDb;
      let want = gainDb;                       // 死区内：保持上一次的校正
      limited = false;
      if (Math.abs(err) > cfg.deadbandDb) {
        const ideal = clamp(err, -cfg.maxCutDb, cfg.maxGainDb);
        // 目标要求的增益本身就超出 ±12dB ⇒ 怎么加都够不到目标（界面显示"已达上限"）
        limited = Math.abs(ideal - err) > 0.05;
        want = ideal;
      }
      /**
       * 峰值天花板：即使按目标电平该给这么大增益，也不能让**输出峰值**顶破天花板。
       * dynaudnorm 的 `peak`（默认 0.95）就是这件事，只是它按 0.95 定，
       * 我们按 -1dBFS 定（有损编码上线后还会再涨一点，留的余量比 0.95 大）。
       */
      if (peakDb > -Infinity && want > cfg.ceilingDb - peakDb) {
        want = cfg.ceilingDb - peakDb;
        limited = true;                        // 被天花板拦住，同样是"够不到目标"
      }
      const prev = gainDb;
      gainDb = clamp(want, -cfg.maxCutDb, cfg.maxGainDb);
      tauMs = gainDb < prev ? cfg.attackMs : cfg.releaseMs;   // 快攻击 / 慢释放
      outDb = srcDb + gainDb;
      return state();
    }

    function state() {
      const inBand = live && Math.abs(cfg.targetDb - outDb) <= cfg.deadbandDb;
      return {
        gainDb, srcDb, outDb, peakDb, tauMs, live, inBand,
        /** 被 ±12dB 或峰值天花板拦住、确实够不到目标（在死区内就不算，免得白吓人） */
        capped: live && limited && !inBand,
      };
    }

    function setTarget(db) {
      const v = Number(db);
      if (Number.isFinite(v)) cfg.targetDb = clamp(v, -40, 0);
      return cfg.targetDb;
    }

    /** 关掉 AGC / 换曲时归位：增益回到 1.0，避免残留校正量 */
    function reset() {
      gainDb = 0; tauMs = cfg.releaseMs;
      srcDb = -Infinity; outDb = -Infinity; peakDb = -Infinity; live = false;
    }

    return { decide, state, reset, setTarget, cfg };
  }

  return { DEFAULTS, create, dbOf };
}));
