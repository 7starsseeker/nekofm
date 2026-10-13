/* ==========================================================================
   播放核心页
   --------------------------------------------------------------------------
   为什么把 <audio> 放在独立页面而不是主进程：
     · 只有渲染进程的 HTMLMediaElement 才有 setSinkId()，
       这是把「音乐」单独送到 VoiceMeeter AUX/CABLE 通道的唯一正规途径
     · currentTime 就是歌词同步的权威时基（比 SMTC 精确，SMTC 会漂移）
   进度上报：10Hz POST 回 /api/command，服务端再 SSE 广播给叠加层

   2026-10-13 起这里还负责**动态音量**（自动增益）：
   为了拿电平，必须给 <audio> 建 Web Audio 图，于是"声音的去处"从 element
   的 setSinkId 变成 AudioContext.setSinkId —— 见下面「音频图与动态音量」一节。
   ========================================================================== */
'use strict';

(function () {
  const audio = document.getElementById('audio');
  const el = {
    status: document.getElementById('status'),
    device: document.getElementById('device'),
    devLabel: document.getElementById('devLabel'),
    refreshDev: document.getElementById('refreshDev'),
    testTone: document.getElementById('testTone'),
    volSlot: document.getElementById('volSlot'),
    bar: document.getElementById('bar'),
    kName: document.getElementById('kName'),
    kTime: document.getElementById('kTime'),
    kUrl: document.getElementById('kUrl'),
    kErr: document.getElementById('kErr'),
  };

  const S = {
    track: null, sinkId: '', devices: [], lastStatus: '',
    /**
     * 当前这份载入的序号（由 engine 随 play 指令下发）。
     * 每次上报都带回去，让 engine 能**精确判断**这份状态属不属于当前那一首 ——
     * 否则切歌瞬间旧源的 `playing/paused` 会把新歌的 loading 覆盖掉
     * （表现："显示正在播放，其实是上一首在响"）。
     */
    loadSeq: null,
    volume: 1,
    muted: false,
    /** 动态音量：{enabled, targetDb}。由 engine 的 state/player 事件下发 */
    autoGain: { enabled: false, targetDb: -16 },
  };

  const post = (body) => fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});

  /**
   * 带"在飞去重"的上报（2026-09-26）。
   *
   * 为什么要它：浏览器对同一 host 只有 **6 条并发连接**。
   * 播放进度是 10Hz 上报的，如果某次（或某几条长命令）卡住，这些请求就会
   * 越堆越多把连接池占满 —— 于是**所有**命令（包括暂停/切歌）都排不进去，
   * 用户看到的就是"播放器失去响应"。
   * 这里保证**同一时刻最多一个在飞**，超时的那个直接跳过不补发
   * （进度本来就是快照语义，丢一帧毫无影响）。
   */
  let posInFlight = false;
  const postThrottled = (body) => {
    if (posInFlight) return;
    posInFlight = true;
    fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {}).finally(() => { posInFlight = false; });
  };

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  function setStatus(st, err) {
    if (S.lastStatus === st && !err) return;
    S.lastStatus = st;
    el.status.textContent = st;
    el.status.className = 'status ' + (st === 'playing' ? 'playing' : st === 'error' ? 'error' : '');
    if (err) el.kErr.textContent = err;
    post({ action: 'playerStatus', status: st, duration: audio.duration || 0, error: err || '', seq: S.loadSeq });
  }

  // ============================================================ 音频图与动态音量
  /**
   * 为什么要给 <audio> 建 Web Audio 图（2026-10-13 实测，证据见
   * 2026-10-13-agc-gates.md）：
   *   · 只有 `createMediaElementSource` 之后才有 AnalyserNode 能测的电平；
   *   · 一旦建图，**声音的去处就由 `AudioContext.destination` 决定** ——
   *     element 的 `setSinkId()` 不再影响输出，设备选择必须改走
   *     `AudioContext.setSinkId()`。实测：`''`（系统默认）与真实 deviceId 都可用，
   *     但字面量 `'default'` 会抛 NotFoundError（而枚举结果里真有 id 叫 default）。
   *   · 跨源曲目（网易云 CDN 直链）**必须**给 <audio> 加 `crossorigin="anonymous"`：
   *     不加时 Chromium 报 "MediaElementAudioSource outputs zeroes due to CORS
   *     access restrictions"，测到的电平恒为 0；加了之后实测读得到（-30.7 dBFS）。
   *
   * 增益链路：source ─┬─→ analyser（测**增益前**的节目电平）
   *                   └─→ agcGain（动态音量写这里）→ volGain（用户音量写这里）
   *                       → muteGain（静音写这里）→ destination
   *   · 测增益**前**的电平：否则增益一动电平就跟着动、增益再变 —— 自我循环。
   *   · 静音用独立的 GainNode 而不是 `audio.muted`：engine 一直在发 mute 事件，
   *     但播放核心以前**根本没有处理它**（"静音"实际上一直是坏的，只有图标在变）。
   *     建图之后 element 的 muted 是否真的会把图里的输出静掉属于实现细节，
   *     用增益节点是确定的。
   *
   * 用户音量为什么也要挪进图里（2026-10-13 用户反馈"开了动态音量后增益一直 +12dB"
   * 之后实测，用一段已知电平的正弦分别把 element.volume 设成 1 / 0.5 / 0.25 / 0.1，读 AnalyserNode 的 RMS）：
   *   element 的 `volume` 作用在**图的上游** —— 实测 elVol=1 时 tap 读到 -19.99 dBFS
   *   （与 ffmpeg 实测的 -20.0 dBFS 一致），elVol=0.1 时读到 -40.03 dBFS（差 20.04dB）。
   *   也就是说，音量条拉低多少，AGC 就以为"源电平低了多少"、原样补回来 ——
   *   补到 +12dB 上限为止，音量条等于失灵（顺带把用户看到的 +12dB 钉死）。
   *   所以音量必须施加在**测量点之后**：element.volume 永久钉在 1，音量交给 volGain。
   *   语义也更顺：AGC 只负责把**源**拉到目标，之后用户想多安静就多安静。
   */
  const AGC_TICK_MS = 50;
  const AGC_REPORT_MS = 500;                  // 电平回传频率（2Hz）
  const WIN_FRAMES = Math.round(400 / AGC_TICK_MS);   // 400ms 测量窗
  let ctx = null, srcNode = null, analyser = null, agcGain = null, volGain = null, muteGain = null;
  let buf = null;
  let agc = null;
  let agcOn = false;
  let meter = { db: null, gainDb: null, live: false, capped: false };
  let reportTick = 0;
  const win = [];

  /**
   * 把用户音量写进图里（没有图时退回 element.volume —— 那时 AGC 也不存在，
   * 没有"测量被补偿"的问题）。
   */
  function applyVolume(v) {
    S.volume = v;
    if (volGain) volGain.gain.value = v;
    else audio.volume = v;
  }

  function initGraph() {
    // 建图**之前**设 crossorigin：跨源音频不带它，MediaElementAudioSource 只输出 0
    audio.crossOrigin = 'anonymous';
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      srcNode = ctx.createMediaElementSource(audio);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;                // 48kHz 下 ≈43ms 一帧
      agcGain = ctx.createGain();
      volGain = ctx.createGain();
      muteGain = ctx.createGain();
      agcGain.gain.value = 1;
      volGain.gain.value = S.volume;
      muteGain.gain.value = S.muted ? 0 : 1;
      srcNode.connect(analyser);
      srcNode.connect(agcGain);
      agcGain.connect(volGain);
      volGain.connect(muteGain);
      muteGain.connect(ctx.destination);
      audio.volume = 1;                       // 音量改由图负责，element 永远满幅
      buf = new Float32Array(analyser.fftSize);
      agc = NekoAutoGain.create({ targetDb: S.autoGain.targetDb });
      return true;
    } catch (e) {
      ctx = null; analyser = null; agcGain = null; volGain = null; muteGain = null;
      el.kErr.textContent = '音频图创建失败（动态音量与静音不可用）：' + e.message;
      return false;
    }
  }

  /** 取一帧时域波形 → 本窗的 RMS 与峰值（线性 0~1） */
  function measure() {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    win.push({ ms: sum / buf.length, peak });
    while (win.length > WIN_FRAMES) win.shift();
    let s = 0, pk = 0;
    for (let i = 0; i < win.length; i++) { s += win[i].ms; if (win[i].peak > pk) pk = win[i].peak; }
    return { rms: Math.sqrt(s / win.length), peak: pk };
  }

  function reportMeter(force) {
    if (!agcOn && !force) return;
    postThrottled({
      action: 'playerAutoGain',
      enabled: agcOn,
      targetDb: S.autoGain.targetDb,
      db: Number.isFinite(meter.db) ? meter.db : null,
      gainDb: Number.isFinite(meter.gainDb) ? meter.gainDb : 0,
      live: !!meter.live,
      capped: !!meter.capped,
      seq: S.loadSeq,
    });
  }

  /**
   * 应用动态音量配置（来自 engine 的 state 广播或 player 事件）。
   * 目标是**幂等**：10Hz 的 state 广播会反复调它，不能每次都把回路推倒重建。
   */
  function applyAutoGain(g) {
    if (!g) return;
    const on = !!g.enabled;
    const target = g.targetDb == null ? S.autoGain.targetDb : Number(g.targetDb);
    const enabledChanged = on !== S.autoGain.enabled;
    const targetChanged = target !== S.autoGain.targetDb;
    S.autoGain = { enabled: on, targetDb: target };
    if (agc && targetChanged) agc.setTarget(target);
    if (enabledChanged) {
      agcOn = on;
      win.length = 0;
      reportTick = 0;
      if (agc) agc.reset();
      if (agcGain && ctx) agcGain.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
      if (!on) { meter = { db: null, gainDb: null, live: false, capped: false }; reportMeter(true); }
    }
    paintVolume();
  }

  // --------------------------------------------------------------- 设备管理
  async function listDevices() {
    try {
      let list = await navigator.mediaDevices.enumerateDevices();
      // 没有标签说明还没拿到权限，用一次一次性流触发授权后重取
      if (list.filter((d) => d.kind === 'audiooutput').every((d) => !d.label)) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
          list = await navigator.mediaDevices.enumerateDevices();
        } catch { /* 用户拒绝就凑合用默认标签 */ }
      }
      S.devices = list.filter((d) => d.kind === 'audiooutput');
      el.device.innerHTML = '';
      const optDefault = document.createElement('option');
      optDefault.value = '';
      optDefault.textContent = '系统默认';
      el.device.appendChild(optDefault);
      S.devices.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `输出设备 ${i + 1}`;
        el.device.appendChild(o);
      });
      el.device.value = S.sinkId || '';
      // 把设备清单报给服务端，供控制台展示
      post({ action: 'playerDevices', devices: S.devices.map((d) => ({ id: d.deviceId, label: d.label })) });
      updateDevLabel();
      tryRestore();   // 枚举完成后才有条件按 id/标签找到设备
    } catch (e) {
      el.kErr.textContent = '设备枚举失败：' + e.message;
    }
  }

  function updateDevLabel() {
    const d = S.devices.find((x) => x.deviceId === S.sinkId);
    el.devLabel.textContent = '设备：' + (d ? (d.label || d.deviceId.slice(0, 8)) : '系统默认');
  }

  /** 输出设备：建图后用 AudioContext.setSinkId，没建图时退回 element 的 setSinkId */
  function sinkTarget() {
    // 枚举出来的设备里**有一个 id 就叫 'default'**，而 AudioContext.setSinkId('default')
    // 实测抛 NotFoundError；表示"系统默认"的正确写法是空串。
    return S.sinkId === 'default' ? '' : S.sinkId;
  }

  async function applySink(id) {
    S.sinkId = id || '';
    try {
      if (ctx && typeof ctx.setSinkId === 'function') {
        await ctx.setSinkId(sinkTarget());
        el.kErr.textContent = '—';
      } else if (typeof audio.setSinkId === 'function') {
        await audio.setSinkId(S.sinkId);
        el.kErr.textContent = '—';
      } else {
        el.kErr.textContent = '当前环境不支持 setSinkId，请在系统音量合成器里改输出';
      }
    } catch (e) {
      el.kErr.textContent = 'setSinkId 失败：' + e.message;
    }
    updateDevLabel();
  }

  el.device.addEventListener('change', () => {
    const opt = el.device.selectedOptions && el.device.selectedOptions[0];
    const label = opt ? opt.textContent : '';
    applySink(el.device.value);
    // 连标签一起上报：deviceId 会变，标签是找回设备的依据
    post({ action: 'setDevice', deviceId: el.device.value, deviceLabel: el.device.value ? label : '' });
  });

  /**
   * 恢复上次选好的输出设备。
   * 优先用保存的 deviceId；**找不到就按标签找** —— Chromium 的 deviceId
   * 在权限/驱动变化后会变，只存 ID 就会出现"选好的设备过一会儿变回系统默认"。
   *
   * 注意时序：设备枚举是异步的，而首个 state 广播可能**早于**枚举完成。
   * 所以这里不能"试一次就放弃"（第一版就是这样，结果重启后设备没恢复）——
   * 改用 pendingDevice + 枚举完成后重试。
   */
  function requestRestore(id, label) {
    if (S.restoredDevice || (!id && !label)) return;
    S.pendingDevice = { id, label };
    tryRestore();
  }

  function tryRestore() {
    if (S.restoredDevice || !S.pendingDevice || !S.devices.length) return;
    restoreDevice(S.pendingDevice.id, S.pendingDevice.label).then((ok) => {
      if (ok) { S.restoredDevice = true; S.pendingDevice = null; }
    }).catch(() => { /* 忽略 */ });
  }

  async function restoreDevice(id, label) {
    if (!id && !label) return false;
    let target = S.devices.find((d) => d.deviceId === id);
    if (!target && label) {
      target = S.devices.find((d) => d.label === label)
        || S.devices.find((d) => d.label && label && d.label.includes(label));
    }
    if (!target) return false;
    await applySink(target.deviceId);
    el.device.value = target.deviceId;
    post({ action: 'setDevice', deviceId: target.deviceId, deviceLabel: target.label });
    return true;
  }
  el.refreshDev.addEventListener('click', listDevices);

  /**
   * 1kHz 测试音：验证 VoiceMeeter 路由是否接对了。
   * 建图之后必须**走同一个 AudioContext**，否则测试音会去系统默认设备、
   * 而音乐在选好的虚拟声卡上 —— 那样这个按钮就骗人了。
   */
  el.testTone.addEventListener('click', async () => {
    if (ctx) {
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* 忽略 */ } }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 1000;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      setTimeout(() => { try { osc.stop(); } catch { /* 忽略 */ } }, 1200);
      return;
    }
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    const osc = tmp.createOscillator();
    const gain = tmp.createGain();
    osc.frequency.value = 1000;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(tmp.destination);
    osc.start();
    setTimeout(() => { osc.stop(); tmp.close(); }, 1200);
  });

  // ------------------------------------------------- 音量控件（竖刻度，与控制台同一份实现）
  let dial = null;
  function paintVolume() {
    if (!dial) return;
    dial.update({
      volume: S.volume,
      muted: S.muted,
      autoGain: S.autoGain,
      db: meter.db,
      gainDb: meter.gainDb,
      live: meter.live,
      capped: meter.capped,
    });
  }
  dial = window.NekoVolumeDial.mount(el.volSlot, {
    volume: S.volume,
    autoGain: S.autoGain,
    onVolume: (v) => {
      applyVolume(v);            // 写进图里的 volGain（element.volume 永远 1）
      post({ action: 'setVolume', volume: v });
    },
    onMute: (m) => {
      S.muted = m;
      if (muteGain) muteGain.gain.value = m ? 0 : 1;
      // 走 engine 的 toggleMute 会让状态绕一圈再广播回来；这里直接写死目标值更干脆
      post({ action: 'setMuted', muted: m, via: 'dial' });
      paintVolume();
    },
    onAutoGain: (g) => {
      applyAutoGain(g);
      reportMeter(true);
      post({ action: 'setAutoGain', enabled: g.enabled, targetDb: g.targetDb });
    },
  });

  // ------------------------------------------------------------------ 播放
  /**
   * 播放请求序号。
   *
   * 为什么需要：连着切歌时，前一次 `audio.play()` 还没 resolve 就被新的
   * play()/load() 打断，浏览器会抛 **AbortError**。那不是故障，是"被更新的请求抢占了"，
   * 但原来的代码把它当错误弹出来 —— 用户看到的就是
   * 「播放 error（The play() request was interrupted by a call to pause()）」。
   */
  let playSeq = 0;

  async function play(url, volume, resumeAt, startPaused) {
    if (!url) return;
    const my = ++playSeq;
    const sameSrc = audio.src === url || (audio.src && audio.src.endsWith(url));
    if (!sameSrc) {
      // 换源前先停一下，减少旧请求被新请求打断时的噪声
      try { audio.pause(); } catch { /* 忽略 */ }
      audio.src = url;
      audio.load();
    }
    if (volume != null) { applyVolume(volume); paintVolume(); }
    el.kUrl.textContent = url.length > 90 ? url.slice(0, 90) + '…' : url;
    setStatus('loading');
    // 补发的指令会带 resumeAt：让"晚连上的播放核心"接着上次进度继续，
    // 而不是把已经在放的歌从头重放（SSE 重连时也会走到这里）。
    if (resumeAt > 0.5 && !sameSrc) {
      const seekOnce = () => {
        audio.removeEventListener('loadedmetadata', seekOnce);
        try { audio.currentTime = resumeAt; } catch { /* 忽略 */ }
      };
      audio.addEventListener('loadedmetadata', seekOnce);
    }
    /**
     * startPaused（2026-09-26）：用户在**解析直链期间**就按了暂停。
     * 这时只装源、不播 —— 否则 play() 会把用户的暂停直接覆盖掉
     * （表现出来就是"点了暂停没反应，歌照样开始放"）。
     * 之后点播放走 `resume` 分支，src 已在，直接 play 即可。
     */
    if (startPaused) {
      setStatus('paused');
      return;
    }
    try {
      await audio.play();
    } catch (e) {
      // ① AbortError = 被更新的播放请求抢占，属于正常抢占，不该报错
      // ② my !== playSeq = 自己已经过期，不要再写状态，否则会把新歌的状态覆盖成错误
      if (e && e.name === 'AbortError') return;
      if (my !== playSeq) return;
      setStatus('error', '播放被拒：' + e.message);
    }
  }

  audio.addEventListener('playing', () => setStatus('playing'));
  audio.addEventListener('pause', () => { if (!audio.ended) setStatus('paused'); });
  audio.addEventListener('waiting', () => setStatus('loading'));
  audio.addEventListener('ended', () => setStatus('ended'));
  audio.addEventListener('error', () => {
    const e = audio.error;
    setStatus('error', e ? `媒体错误 code=${e.code} ${e.message || ''}` : '未知媒体错误');
  });
  audio.addEventListener('loadedmetadata', () => {
    post({ action: 'playerStatus', status: S.lastStatus || 'loading', duration: audio.duration || 0, error: '', seq: S.loadSeq });
  });

  /**
   * 进度上报 + 本地进度条刷新。
   *
   * 两件事**频率分开**（2026-09-26 改）：
   *   · **DOM 刷新保持 10Hz** —— 纯本地操作，零网络成本，进度条顺滑
   *   · **上报改成 5Hz** —— 这走 HTTP，每次占一条浏览器连接。
   *     连接池只有 6 条，而且 control / player / 每个预览窗各占一条 SSE
   *     （SSE 是长连接，一直占着）。5Hz 足够：叠加层是
   *     `snapshot{position, serverTime, rate}` + rAF 插值，
   *     两次上报之间用 serverTime 外推，歌词同步精度不受影响。
   *   · 再用 `postThrottled` 保证**同一时刻最多一个在飞** ——
   *     绝不因为某次卡住而把连接池堆满（那正是"播放器失去响应"的成因）。
   */
  let posTick = 0;
  setInterval(() => {
    posTick++;
    if (audio.readyState >= 1 && posTick % 2 === 0) {
      postThrottled({ action: 'playerPosition', position: audio.currentTime || 0, duration: audio.duration || 0, paused: audio.paused, seq: S.loadSeq });
    }
    const d = audio.duration || 0;
    el.bar.style.width = d ? ((audio.currentTime / d) * 100).toFixed(1) + '%' : '0%';
    el.kTime.textContent = fmt(audio.currentTime) + ' / ' + fmt(d);
  }, 100);

  /**
   * 动态音量的测量回路。
   * 为什么不用 requestAnimationFrame：播放核心窗**默认是隐藏的**，隐藏窗的 rAF 不跑；
   * 这里用 setInterval（建窗时开了 backgroundThrottling:false，实测隐藏状态下
   * 10ms 定时器 2 秒照样触发 200 次，不节流）。
   */
  setInterval(() => {
    if (!analyser || !agc) return;
    const m = measure();
    if (agcOn) {
      const r = agc.decide(m);
      if (agcGain && ctx) {
        // setTargetAtTime：按时间常数指数逼近，不会因阶跃跳变出"咔"声
        agcGain.gain.setTargetAtTime(Math.pow(10, r.gainDb / 20), ctx.currentTime, Math.max(0.01, r.tauMs / 1000));
      }
      meter = { db: r.outDb, gainDb: r.gainDb, live: r.live };
      reportTick += AGC_TICK_MS;
      if (reportTick >= AGC_REPORT_MS) { reportTick = 0; reportMeter(); paintVolume(); }
    }
  }, AGC_TICK_MS);

  // ------------------------------------------------------------------ 指令
  /**
   * SSE 连接：**单连接 + 断开后退避重连**（2026-09-26 修）。
   *
   * 不能只靠 EventSource 自己的自动重连：它 error 后立刻重连，而服务端可能
   * 还没回收旧连接。Chromium 对同一 host 只有 **6 条**并发连接，每条 SSE 都是
   * 长连接一直占着 —— 重连一堆积就把连接池吃光，表现就是"所有命令都没反应"。
   * 这里显式 close 再延时重连，保证**任一时刻每个窗口只有一条 SSE**。
   */
  let es = null;
  let esRetry = 0;
  function connect() {
    if (es) { try { es.close(); } catch { /* 忽略 */ } es = null; }
    es = new EventSource('/events');
    es.onopen = () => { esRetry = 0; };
    es.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'state') {
        S.track = m.track;
        // 首次拿到状态时恢复用户选好的输出设备（只做一次）
        if (m.player && (m.player.deviceId || m.player.deviceLabel)) {
          requestRestore(m.player.deviceId, m.player.deviceLabel);
        }
        if (m.player && m.player.autoGain) applyAutoGain(m.player.autoGain);
        if (m.player && m.player.muted != null && m.player.muted !== S.muted) {
          S.muted = !!m.player.muted;
          if (muteGain) muteGain.gain.value = S.muted ? 0 : 1;
          paintVolume();
        }
        el.kName.textContent = m.track ? (m.track.name || m.track.title || '—') : '—';
        if (m.playback && m.playback.volume != null && document.activeElement !== (dial && dial.el.range)) {
          applyVolume(m.playback.volume);
          paintVolume();
        }
        return;
      }
      if (m.type === 'player') {
        if (m.action === 'play') { S.loadSeq = m.seq == null ? null : m.seq; play(m.url, m.volume, m.resumeAt, m.startPaused); }
        else if (m.action === 'pause') audio.pause();
        else if (m.action === 'resume') audio.play().catch(() => {});
        else if (m.action === 'stop') {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        // 不上报 'idle'：这是 engine 自己让我们停的，engine 已经把
        // status 设成 loading，重复上报会两边打架、UI 抖来抖去。
        // 我们自己出错/自然结束时（audio 的 error/ended 事件）自然会报。
        S.lastStatus = 'loading';
      }
        else if (m.action === 'seek') { audio.currentTime = m.position || 0; }
        else if (m.action === 'volume') {
          applyVolume(m.volume);
          paintVolume();
        }
        /**
         * 静音：2026-10-13 之前**播放核心完全没处理这个动作**
         * （engine 一直在发，界面图标也在变，但声音一点没变）——
         * 现在写进 muteGain。
         */
        else if (m.action === 'mute') {
          S.muted = !!m.muted;
          if (muteGain) muteGain.gain.value = S.muted ? 0 : 1;
          paintVolume();
        }
        else if (m.action === 'autoGain') applyAutoGain({ enabled: m.enabled, targetDb: m.targetDb });
        else if (m.action === 'device') { S.sinkId = m.deviceId || ''; el.device.value = S.sinkId; applySink(S.sinkId); }
      }
    };
    es.onerror = () => {
      // 显式关闭 + 退避重连：绝不让 EventSource 自己无限快速重连把连接池堆满
      try { es.close(); } catch { /* 忽略 */ }
      es = null;
      const delay = Math.min(1000 * 2 ** esRetry, 15000);
      esRetry++;
      setTimeout(connect, delay);
    };
  }

  // ------------------------------------------------------------------ 启动
  initGraph();              // 必须在首次 play 之前：crossorigin 要赶在载入媒体之前设好
  audio.volume = 1;         // element 永远满幅 —— 用户音量由图里的 volGain 负责
  paintVolume();
  listDevices();
  connect();
  // 设备热插拔
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', listDevices);
  }
})();
