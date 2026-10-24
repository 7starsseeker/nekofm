/* ==========================================================================
   NekoFM 控制台逻辑
   与后端只通过 HTTP + SSE 通信，不依赖 Electron API，因此同一份页面
   既能在 Electron 里用，也能在普通浏览器里打开（headless 模式）。
   ========================================================================== */
'use strict';

/* ==========================================================================
   行的操作菜单（右键）—— 2026-10-24
   --------------------------------------------------------------------------
   用户决定：「列表中的各种功能确实不用显示，给右键菜单就行」。
   依据是 8 个成熟列表（foobar2000 / Columns UI / MusicBee / AIMP / Quod Libet /
   Spotify / Apple Music / 点歌机 Songify）的实测与文档：没有一家把播放/删除/收藏
   常驻在行内。常驻 5 个控件在 1016px 的宽列表里吃掉约 380px（歌名只剩 199px），
   在 344px 的队列栏里更是把行挤成好几层。

   **为什么放在这里**：control.js 由三个互不共享作用域的 IIFE 组成
   （主逻辑 / layoutShell / 新面板），队列行在主逻辑里画、已保存行在新面板里画，
   所以要有一个两边都能拿到的入口。这里按本文件既有的 `window.__nekofm*`
   约定挂到 window 上（同 `window.__nekofmMkKeepButton`）。
   只有新外壳 `/console` 用（shell.js 会打上 `data-v2`）；旧版面 `/` 保持原样。
   ========================================================================== */
(function attachCtxMenu() {
  /* 判定「用不用新外壳」只看路径，不看 `data-v2`：
     队列行可能在 window 'load'（shell.js 打标记）之前就画好了，
     用 DOM 标记会产生"先按旧样式画、之后再不重画"的时序竞态（实测踩过：
     队列 3 行都还是行内 5 个按钮）。`/console` 是 shell.js 唯一的挂载点，
     路径从第一次渲染起就是确定的。 */
  const isV2 = () => location.pathname === '/console';
  let el = null;

  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'v2ctx';
    el.hidden = true;
    document.body.appendChild(el);
    const close = () => { el.hidden = true; };
    // 捕获阶段：点在菜单外任何地方、Esc、滚列表、切窗口都收起来
    addEventListener('mousedown', (e) => { if (!el.contains(e.target)) close(); }, true);
    addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    return el;
  }

  /** items: (['-'] | {label,title?,run,danger?,disabled?})[] */
  function openCtx(x, y, head, items) {
    const box = ensure();
    box.innerHTML = '';
    if (head) {
      const h = document.createElement('div');
      h.className = 'hd';
      h.textContent = head;
      box.appendChild(h);
    }
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; box.appendChild(s); continue; }
      const b = document.createElement('button');
      b.className = 'it' + (it.danger ? ' danger' : '') + (it.disabled ? ' off' : '');
      b.textContent = it.label;
      if (it.title) b.title = it.title;
      if (it.disabled) b.disabled = true;
      b.onclick = () => {
        box.hidden = true;
        try { it.run(); } catch (e) {
          const msg = String((e && e.message) || e);
          if (window.__nekofmToast) window.__nekofmToast(false, msg); else console.error(msg);
        }
      };
      box.appendChild(b);
    }
    box.hidden = false;
    // 贴着光标但不许出窗口（最后一行的右键也要能用）
    const r = box.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 8)) + 'px';
    box.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 8)) + 'px';
  }

  window.__nekofmCtxMenu = { isV2, openCtx };
})();

(function () {
  const $ = (id) => document.getElementById(id);
  const api = async (body) => {
    const r = await fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ ok: false, error: 'bad json' }));
    if (!j.ok) log('error', `${body.action} 失败：${j.error || (j.result && j.result.msg) || '未知'}`);
    return j;
  };
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  /**
   * **非阻塞**的结果提示（2026-09-26 替换掉 alert）。
   *
   * 为什么必须换掉 `alert()`：它是**模态、阻塞**的 —— 弹出来的时候整个页面的
   * JS 线程停住，10Hz 的状态渲染、按钮点击全都不响应。用户连点几下
   * （比如"播放"在引擎忙时会被拒）就会叠出好几个 alert，
   * 表现就是"页面卡死了"。而本项目的要求是**本地控制必须实时响应**。
   *
   * 改成写进右下角日志（本来就在显示），不打断任何操作。
   */
  const toast = (ok, text) => {
    try { window.__nekofmLog && window.__nekofmLog(ok ? 'info' : 'warn', String(text)); }
    catch { /* 忽略 */ }
  };

  /**
   * **页面内确认框**（2026-09-27 替换掉原生 `confirm()`）。
   *
   * 为什么必须换掉（用户实测报告）：Electron 里的 `confirm()` 是**系统模态对话框**，
   * 在 Windows 上关掉之后窗口会**收不到键盘输入** —— 光标还在点歌框里闪，
   * 但打字毫无反应，必须让窗口失去焦点再回来才恢复。
   * 触发场景极不直观："清理掉非已保存音乐的缓存之后，点歌框就打不了字了"。
   *
   * `alert()` 早就因为同类问题换成了 toast（见上面的注释），`confirm()` 是漏网的那批。
   * 和 toast 相反，确认框**必须**阻断用户（删缓存这类不可逆操作不该盲点），
   * 所以做成"页面内的模态"：挡操作、不挡主线程，也完全不碰系统焦点。
   *
   * @param {string} message 支持 \n 换行（CSS 用 white-space: pre-wrap）
   * @returns {Promise<boolean>} 确定 → true；取消 / Esc / 点遮罩 → false
   */
  function confirmDialog(message) {
    const mask = $('confirmMask');
    if (!mask) return Promise.resolve(window.confirm(message));   // 老页面兜底
    const btnOk = $('confirmOk');
    const btnCancel = $('confirmCancel');
    $('confirmText').textContent = String(message == null ? '' : message);
    const prevFocus = document.activeElement;
    mask.hidden = false;
    try { btnOk.focus(); } catch { /* 忽略 */ }

    return new Promise((resolve) => {
      const done = (val) => {
        mask.hidden = true;
        document.removeEventListener('keydown', onKey, true);
        mask.removeEventListener('mousedown', onMask);
        btnOk.onclick = null;
        btnCancel.onclick = null;
        /**
         * **把焦点还给原来的元素**。删缓存这类操作常从列表行的按钮点起，
         * 焦点丢到 body 之后用户接着敲键盘就全落在空气里 —— 这也是
         * "点歌框打不了字"的另一半原因。
         */
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch { /* 忽略 */ }
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
      };
      // 只有点"遮罩本身"才算取消；点框内不关（免得误点正文就退出）
      const onMask = (e) => { if (e.target === mask) done(false); };
      btnOk.onclick = () => done(true);          // 确定按钮默认聚焦 → 回车即确定
      btnCancel.onclick = () => done(false);
      document.addEventListener('keydown', onKey, true);
      mask.addEventListener('mousedown', onMask);
    });
  }
  window.__nekofmConfirm = confirmDialog;   // 第二个 IIFE（新版面板）也要用

  // ------------------------------------------------------------------ 日志
  const logBox = $('log');
  /**
   * 日志输出。同时挂到 window 上，让**别的 IIFE**（新版面板那一块）也能写日志 ——
   * 它里面的 alert 都换成了 toast（见上面的说明）。
   */
  function log(level, text) {
    const d = document.createElement('div');
    d.className = level;
    d.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    logBox.prepend(d);
    while (logBox.childElementCount > 200) logBox.lastElementChild.remove();
  }
  window.__nekofmLog = log;   // 供其它 IIFE（新版面板）写日志用
  /**
   * 同理把 toast 也暴露出去。
   *
   * 为什么必须暴露（2026-10-16 用户实测）：`newPanels()` 那个 IIFE 里 9 处
   * 都写了 `toast(...)`，但 `toast` 只在这个 IIFE 里定义 —— 严格模式下
   * 那是 `ReferenceError: toast is not defined`。而它**几乎总是出现在
   * `await 某命令` 之后、`onChanged()` 之前**，异常一抛，后面的刷新就没了：
   * 「缓存」按钮因此永远停在"缓存中…"（缓存成功与否都停）。
   */
  window.__nekofmToast = toast;

  let config = null;
  let state = null;
  /**
   * 竖刻度音量控件（2026-10-13）。
   *
   * 为什么音量控件是**共享模块**：控制台底部栏与播放核心窗都要它，而
   * "每格 2%""面板向上弹出""动态音量开关"这些约束只要两边各写一遍就必然走样。
   * 挂载在下面的接线区（`dial = window.NekoVolumeDial.mount(...)`），
   * 这里先声明是因为 10Hz 的 renderState 要回填它。
   */
  let dial = null;
  /** 动态音量的最近读数（由 state.player.autoGain 来；测量在播放核心窗做） */
  let agcReading = { db: null, gainDb: null, live: false, capped: false };

  /**
   * 底部歌词条（2026-09-26 加）。
   *
   * 与直播姬叠加层**共用同一份 lyric-sync.js 与同一条 SSE**，所以
   * "显示哪一行、唱到第几个字"必然一致 —— 不会出现控制台和画面不同步。
   *
   * 渲染策略（照抄叠加层踩过的经验）：
   *   · 行没变 → 只改一个 CSS 变量（进度填充），**零 DOM 重建**
   *   · 行变了 → 只改 3 个 textContent
   *   · 位置**直接用上报值**，不做本地外推：position 由播放核心 5Hz 上报、状态 10Hz 广播，
   *     外推会在每个广播周期里先推进、再被新快照拉回去，换行点就会闪回。
   *     控制台歌词条与叠加层**都栽过这个坑**（见 overlay.js 的 currentPosition 注释）。
   */
  const SNAP = { position: 0, serverTime: Date.now(), paused: true, timeline: null, diag: null, hasLyric: false, rev: -1 };
  const strip = { el: null, prev: null, cur: null, trans: null, next: null, on: false, lastIdx: -2, lastCfgSig: null, lastRev: -1, raf: 0 };

  function onLyrics(m) {
    // 歌词是"大对象、低频变"（只在 rev 变化时推），收到就整体换掉
    if (m.rev === SNAP.rev) return;
    SNAP.rev = m.rev;
    SNAP.timeline = m.timeline || null;
    /**
     * 强制重画。**这里不要动 `strip.lastRev`** —— 那个字段由渲染帧自己推进
     * （`tickLyricStrip` 靠 `lastRev !== SNAP.rev` 判断"换歌了，整条重画"）。
     * 在这一起改掉的话，这个信号当场就被吃掉了。
     */
    strip.lastIdx = -2;
  }

  /** 完整队列的本地缓存（状态里只带前 8 条，见 renderState 的说明） */
  let queueView = null;
  let queueFetchSeq = 0;
  /**
   * 拉一份**完整**的当前播放列表。
   * 用序号防乱序：连点几下（顶/撤/切歌）会并发几次请求，
   * 旧的那次晚回来不能盖掉新的（否则界面会闪回旧队列）。
   */
  async function refreshQueue() {
    const my = ++queueFetchSeq;
    const r = await api({ action: 'listQueue' });
    if (my !== queueFetchSeq) return;
    const d = (r && r.result) || {};
    if (!d.ok) return;
    queueView = { current: d.current || null, items: d.items || [], total: d.total || 0 };
  }

  /**
   * 「加入已保存」按钮（队列 / 已播放 / 已保存三处共用，见 addItemActions）。
   *
   * 用户要求"点了要有实时反馈"：成功之后按钮**立刻**变成「已保存 ✓」并禁用，
   * 而不是只在右下角日志里写一行。已经在已保存列表里的（服务端算好的 `saved`
   * 字段）一上来就画成已保存态 —— 不用点也知道这首留过没有。
   */
  function mkKeepButton({ saved, title, onAdd }) {
    const b = document.createElement('button');
    const markSaved = () => {
      b.textContent = '已保存 ✓';
      b.disabled = true;
      b.title = '已经在「已保存播放列表」里了';
      b.style.borderColor = '#2c8a4b';
      b.style.color = '#7fe0a3';
    };
    const markIdle = () => {
      b.textContent = '加入已保存';
      b.disabled = false;
      b.title = title || '加入「已保存播放列表」，开播时作为闲时歌单';
      b.style.borderColor = '';
      b.style.color = '';
    };
    if (saved) markSaved(); else markIdle();
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '加入中…';
      let r = null;
      try { r = await onAdd(); } catch { /* 网络异常按失败处理 */ }
      const d = (r && r.result) || {};
      // 「已经在里面了」不算失败：用户的意图本来就达成了
      if (d.ok || /已经在/.test(d.msg || '')) {
        markSaved();
        toast(true, d.ok ? `已加入已保存播放列表：${d.name}` : d.msg);
        window.__nekofmRefreshLists && window.__nekofmRefreshLists();
        return;
      }
      markIdle();
      toast(false, '加入已保存失败：' + (d.msg || '未知原因'));
    };
    return b;
  }
  window.__nekofmMkKeepButton = mkKeepButton;   // 第二个 IIFE（新版面板）复用同一套按钮
  window.__nekofmRefreshQueue = refreshQueue;   // 同上：队列渲染在第一个 IIFE 里

  // ------------------------------------------------------------------ 渲染
  function renderState(s) {
    state = s;
    const pb = s.playback || {};
    // 歌词条插值要用的播放快照：position + serverTime + paused
    // （服务端约 5Hz 报进度，靠 serverTime 在本地外推，60fps 平滑）
    SNAP.position = pb.position || 0;
    SNAP.serverTime = s.serverTime || Date.now();
    SNAP.paused = pb.status !== 'playing';
    // 没有歌词时把原因也带出来（"限流" / "没匹配上" 和 "这首歌本来就没词" 是两回事）
    SNAP.diag = (s.lyric && s.lyric.diag) || null;
    SNAP.hasLyric = !!(s.lyric && s.lyric.count);

    // 顶部 pill 只反映"cookie 在不在"；**详细状态（昵称/VIP）由 checkNeteaseStatus 写**。
    // 一旦核验过就以核验结果为准，否则状态广播每 100ms 会把它覆盖掉。
    // 限流冷却中：明确告诉用户在等什么（而不是让"点歌中…"一直挂着）
    const cool = s.netease && s.netease.coolLeft;
    if (cool > 0) {
      $('stNet').dataset.verified = '1';
      $('stNet').textContent = `网易云 限流冷却 ${cool}s`;
      $('stNet').className = 'pill off';
    }
    if (!$('stNet').dataset.verified) {
      $('stNet').textContent = '网易云 ' + (s.netease && s.netease.loggedIn ? '已登录' : '未登录');
      $('stNet').className = 'pill ' + (s.netease && s.netease.loggedIn ? 'ok' : 'off');
    }
    /**
     * 弹幕状态。**未开播/轮播必须写出来**：弹幕服务连得上、认证也过，但 B站此刻
     * 不推送任何弹幕（实测未开播房间 12 秒 0 条，直播中 46 条）—— 不提示的话，
     * 用户在下播房间发点歌没反应，只会以为程序坏了。
     */
    if (s.room) {
      const ls = s.room.liveStatus;
      const suffix = ls === 1 ? '' : (ls === 2 ? '（轮播·不收弹幕）' : (ls == null ? '' : '（未开播·不收弹幕）'));
      const via = s.room.via;
      const viaShort = via === 'openlive' ? '开放平台' : (via === 'browser' ? '浏览器' : '直连');
      /**
       * 把"认出主播是谁"写进 tooltip。
       * 用户反馈过"我本身就是主播，打指令却说我没权限" —— 有这个就能一眼看出
       * 是"没认出主播"还是"认成了别人"，不用翻日志。
       */
      const anchor = s.room.anchor || {};
      const anchorTxt = anchor.uid
        ? `已认出主播：${anchor.name || '(昵称待首条弹幕)'} · uid ${anchor.uid}`
        : '还没认到主播 uid（房间信息未返回）—— 主播权限会退化为"仅房管"';
      $('stRoom').textContent = `弹幕 房间 ${s.room.roomId}（${viaShort}）${suffix}`;
      $('stRoom').className = 'pill ' + (ls === 1 ? 'ok' : (ls == null ? 'ok' : ''));
      $('stRoom').title = (ls === 1 ? '' : 'B站只在直播中推送弹幕。未开播/轮播时连接是正常的，但收不到弹幕（发点歌不会触发）；开播后会自动开始收。') + '\n' + anchorTxt;

      /**
       * 通道说明。**房间号输入框的启用/禁用不在这里管** —— 那由通道单选按钮
       * （`applyDmModeUI`）统一决定。否则状态每次刷新都会把用户刚点的选择覆盖掉。
       * 这里只负责把"**实际正在用哪条通道**"如实写出来（它和用户选的可能不同：
       * 选了 openlive 但凭据不全时会回落浏览器）。
       */
      $('roomViaTip').innerHTML = via === 'openlive'
        ? `当前走 <b>官方开放平台</b>通道：房间由<b>主播身份码</b>绑定，固定为 <b>${s.room.roomId}</b>，
           上面的房间号<b>不生效</b>（要换房间得去开放平台换身份码）。`
        : (via === 'browser'
          ? '当前走<b>浏览器通道</b>：房间号生效，可以连任意直播间。'
          : '当前走 <b>Node 直连</b>：B站风控基本会拒收，建议用开放平台凭据（最稳）或浏览器通道。');
    } else {
      $('stRoom').textContent = '弹幕 未连接';
      $('stRoom').className = 'pill off';
      $('roomViaTip').textContent = '';
      $('stRoom').title = '';
    }
    $('stPlay').textContent = '播放 ' + pb.status + (pb.error ? '（' + pb.error + '）' : '');
    $('stPlay').className = 'pill ' + (pb.status === 'playing' ? 'ok' : pb.status === 'error' ? 'off' : '');
    // 歌词状态：没有歌词时把**原因**也显示出来。
    // 否则用户只看到"0 行"，根本分不清是没这首歌的歌词、还是网易云限流
    // （这件事真实发生过，让人以为程序坏了）。
    const ly = s.lyric || {};
    const n = ly.count || 0;
    if (n > 0) {
      $('stLyric').textContent = `歌词 ${n} 行`;
      $('stLyric').className = 'pill ok';
      $('stLyric').title = '';
    } else if (ly.diag && ly.diag.reason) {
      const limited = /操作频繁|请稍候|频繁/.test(ly.diag.reason);
      $('stLyric').textContent = limited ? '歌词 被网易云限流' : '歌词 无';
      $('stLyric').className = 'pill ' + (limited ? 'off' : '');
      $('stLyric').title = ly.diag.reason + (ly.diag.keyword ? `（搜索词：${ly.diag.keyword}）` : '');
    } else {
      $('stLyric').textContent = '歌词 0 行';
      $('stLyric').className = 'pill';
      $('stLyric').title = '';
    }

    const t = s.track;
    $('name').textContent = t ? (t.name || t.title || '—') : '—';
    $('artist').textContent = t ? (t.artistText || (t.artists || []).join(' / ') || '') : '';
    $('srcTag').textContent = t ? ({ netease: '网易云', local: '本地', bilibili: 'B站' }[t.source] || t.source) : '—';
    $('lyricTag').textContent = s.lyric ? ('歌词来源 ' + (s.lyric.source || '无')) : '—';
    /**
     * 封面取**服务端统一解析过**的那一份（`nowPlaying.cover`），不要用原始的 `track.cover`。
     *
     * 踩过的坑（2026-09-26 用户："控制台播放器中封面依然裂的（覆盖层中有了）"）：
     * 覆盖层读的是 `nowPlaying.cover`，控制台读的是 `track.cover` ——
     * 两者**不是一回事**：
     *   · `nowPlaying.cover` 走 `engine.coverUrlFor()`：本地曲目会补成
     *     `/stream/cover` 代理地址；历史坏的网易云封面（手拼成 404 的那种）会被修好
     *   · `track.cover` 是**原始字段**：本地曲目为空、老数据里可能是坏 URL
     * 于是同一首歌在覆盖层正常、在控制台却是裂的。
     */
    const coverUrl = (s.nowPlaying && s.nowPlaying.cover) || (t && t.cover) || '';
    if (coverUrl) { $('cover').src = coverUrl; $('cover').style.display = 'block'; }
    else { $('cover').style.display = 'none'; }
    const dur = pb.duration || (t && t.duration) || 0;
    $('time').textContent = `${fmt(pb.position)} / ${fmt(dur)}`;
    $('prog').style.width = dur ? Math.min(100, (pb.position / dur) * 100).toFixed(1) + '%' : '0%';

    // 队列（当前播放列表）
    // **正在播放的那首也要显示出来**：它已被 queue.next() 从待播里取出，
    // 只渲染 items 的话，用户点完歌立刻看到"队列为空"，会以为没点上（实测被反馈）。
    /**
     * 队列：状态广播里只带**前 8 条**（10Hz，刻意压载荷），队列长了就看不到后续项
     * （用户报告"待播放列表无法查看后续项"）。
     *
     * 现在按 `rev`（服务端算的变更签名）判断：变了就拉一份**完整**的（listQueue，
     * 人力频率的一次请求），渲染仍走下面同一段代码，只是数据源换成 `queueView`。
     * 签名而不是条数 —— 置顶/上一首回退这类"条数不变的重排"也必须被发现。
     */
    const q = s.queue || {};
    if (q.rev && q.rev !== renderState._qRev) {
      renderState._qRev = q.rev;
      refreshQueue();
    }
    const qv = queueView || { current: q.current || null, items: q.items || [], total: q.total || 0 };
    $('qCount').textContent = `（待播 ${qv.total} 首）`;
    const ul = $('queue');
    const items = qv.items || [];
    const cur = qv.current;
    /* 队列行：新外壳下整行的控件都进右键菜单（见文件顶部 __nekofmCtxMenu 的注释）。
       这两行必须在「正在播放」那一行之前，那个分支也要用它。 */
    const ctxMenu = window.__nekofmCtxMenu;
    const v2 = !!(ctxMenu && ctxMenu.isV2());
    /**
     * **内容没变就不重建 DOM。**
     *
     * 状态是 10Hz 推的，原来每次都 innerHTML='' 整列重建 ——
     * 用户在 mousedown 与 mouseup 之间按钮被换成新节点，click 就不会触发，
     * 表现成"点『撤』没反应""点『拉黑』没反应"（实测被反馈）。
     * 用签名比较，只有队列真的变了才重画。
     */
    const qSig = (cur ? cur.key : '-') + '|' + items.map((it) => it.key + ':' + it.uname).join(',');
    // 用户正在这一列里操作（比如原生下拉展开着）时一律不重画 ——
    // 原生下拉一旦被重建就会立刻收起，看起来像"点了菜单自己收回去"（实测被反馈）
    const busy = ul.contains(document.activeElement) && document.activeElement.tagName === 'SELECT';
    if (!busy && ul.dataset.sig !== qSig) {
    ul.dataset.sig = qSig;
    ul.innerHTML = '';
    if (cur) {
      const li = document.createElement('li');
      li.className = 'q-current';
      const owner = cur.uname ? `<span class="by">${escapeHtml(cur.uname)}</span>` : '';
      // 正在放的那首可能不在待播列表里（从「已播放」回退 / 手动播了队列之外的歌单）
      // —— 如实说明一句，免得用户以为列表丢歌
      const where = !cur.outsideQueue ? '正在播放'
        : (cur.outsideKind === 'idle' ? '正在播放（列表之外的歌单）' : '正在播放（从已播放回退）');
      li.innerHTML = `<span class="idx">▶</span><span class="nm" title="${escapeHtml(cur.name)}">${escapeHtml(cur.name)}</span>`
        + `<span class="by">${where}${cur.artistText ? ' · ' + escapeHtml(cur.artistText) : ''}</span>${owner}`;
      const keep = mkKeepButton({
        saved: cur.saved,
        title: '加入「已保存播放列表」，开播时作为闲时歌单',
        // 发 key 而不是 song：队列项的状态是精简版（`_brief`），**没有完整 song 对象** ——
        // 原来发 `cur.song`（undefined）于是"点了永远不生效"（2026-09-26 修）
        onAdd: () => api({ action: 'savedAdd', key: cur.key, uname: cur.uname }),
      });
      // 新外壳：控件收进右键菜单（队列栏只有 344px，常驻控件会把行挤成好几层）
      if (ctxMenu && ctxMenu.isV2()) {
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          ctxMenu.openCtx(e.clientX, e.clientY, `${cur.name}${cur.uname ? ' · ' + cur.uname : ''}`, [
            { label: keep.textContent, disabled: keep.disabled, run: () => keep.click() },
          ]);
        });
      } else {
        li.appendChild(keep);
      }
      ul.appendChild(li);
    }
    if (!items.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="tip">队列为空，等弹幕点歌或在上方点歌</span>';
      ul.appendChild(li);
    }
    items.forEach((it) => {
      const li = document.createElement('li');
      const owner = it.uname ? `<span class="by">${escapeHtml(it.uname)}</span>` : '';
      li.innerHTML = `<span class="idx">${it.position}</span><span class="nm" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>`
        + `<span class="by">${escapeHtml(it.artistText || '')}</span>${owner}`;

      // 置顶
      const top = document.createElement('button');
      top.textContent = '顶';
      top.title = '把这首提到队列最前';
      top.onclick = () => api({ action: 'queueMove', index: it.position, where: 'top' });

      // 拉黑：按粒度分别拉黑。**外面套个"拉黑"字样的标签** ——
      // 原来是个光秃秃的下拉框，用户根本不知道它是干什么的（实测被问过）。
      const blWrap = document.createElement('span');
      blWrap.className = 'bl-wrap';
      blWrap.title = '选择拉黑的粒度，再点右边的「拉黑」';
      const blLabel = document.createElement('span');
      blLabel.className = 'bl-label';
      blLabel.textContent = '拉黑';
      const sel = document.createElement('select');
      const opts = [['song', '这首歌'], ['keyword', '标题关键词'], ['artist', '歌手'], ['bvid', 'BV号']];
      opts.forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        sel.appendChild(o);
      });
      sel.value = it.source === 'bilibili' ? 'bvid' : 'song';
      sel.title = '拉黑粒度：这首歌 / 标题关键词 / 歌手 / BV号';
      blWrap.appendChild(blLabel);
      blWrap.appendChild(sel);
      const blk = document.createElement('button');
      blk.textContent = '执行';
      blk.title = '按左边选的粒度加入黑名单，并把这首先从队列撤下';
      blk.onclick = async () => {
        const r = await api({ action: 'blacklistFromQueue', index: it.position, type: sel.value });
        if (r.ok) log('info', `已拉黑（${sel.options[sel.selectedIndex].textContent}）：${it.name}`);
      };

      // 加入已保存（闲时）列表 —— 队列里的好歌可以留到下一场
      const keep = mkKeepButton({
        saved: it.saved,
        title: '加入「已保存播放列表」，开播时作为闲时歌单循环播放',
        // 同上：队列项没有 song 字段，要用 key 回查
        onAdd: () => api({ action: 'savedAdd', key: it.key }),
      });
      const rm = document.createElement('button');
      rm.textContent = '撤';
      rm.onclick = () => api({ action: 'remove', index: it.position });

      if (v2) {
        /* 新外壳：顶 / 拉黑×4 / 加入已保存 / 撤 全部收进右键菜单。
           队列栏只有 344px，原来这 5 个控件把行挤成两三层。 */
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const menu = [
            { label: '置顶到队列最前', title: top.title, run: () => top.click() },
            '-',
          ];
          for (const [v, t] of opts) {
            menu.push({
              label: `拉黑（${t}）`,
              title: `按「${t}」粒度加入黑名单，并把这首先从队列撤下`,
              run: () => { sel.value = v; blk.click(); },
            });
          }
          menu.push('-');
          menu.push({ label: keep.textContent, disabled: keep.disabled, title: keep.title, run: () => keep.click() });
          menu.push('-');
          menu.push({ label: '从队列移除', danger: true, title: '把这首先从当前播放列表撤下', run: () => rm.click() });
          ctxMenu.openCtx(e.clientX, e.clientY, `${it.name}${it.uname ? ' · ' + it.uname : ''}`, menu);
        });
      } else {
        li.appendChild(top);
        li.appendChild(blWrap);
        li.appendChild(blk);
        li.appendChild(keep);
        li.appendChild(rm);
      }

      ul.appendChild(li);
    });
    }   // ← 结束「内容变了才重画」的判断

    // 提示
    if (s.notices && s.notices.length) {
      const newest = s.notices[0];
      if (renderState._last !== newest.at) {
        renderState._last = newest.at;
        log(newest.level || 'info', newest.text);
      }
    }

    // 页签计数（从 state.counts 来，避免各页自己去数）
    if (s.counts) {
      const set = (id, n) => { const el = $(id); if (el) el.textContent = n || 0; };
      set('cntQueue', s.counts.queue);
      set('cntPlayed', s.counts.history);
      set('cntSaved', s.counts.saved);
      set('cntBlack', s.counts.blacklist);
      /**
       * **计数变了就刷列表**（2026-09-26 修）。
       *
       * 原来的毛病：计数走 SSE 实时更新，但「已播放」「已保存」两个列表是
       * `setInterval(refreshHistory, 5000)` 每 5 秒才刷一次 —— 于是最多有 5 秒
       * 的窗口里**计数和列表内容对不上**（"总数对了，但列表里还是上一首"，
       * 实测被反馈）。现在改成变化驱动：计数一变立刻拉列表，两者永远一致。
       *
       * 顺带把两个 5 秒轮询删掉了（少 2 个周期性 HTTP 请求，对连接池友好）。
       */
      if (s.counts.history !== renderState._lastHist) {
        renderState._lastHist = s.counts.history;
        if (window.__nekofmSyncHistory) window.__nekofmSyncHistory();
      }
      if (s.counts.saved !== renderState._lastSaved) {
        renderState._lastSaved = s.counts.saved;
        if (window.__nekofmSyncSaved) window.__nekofmSyncSaved();
      }
      if (window.__nekofmPaintLive && !window.__nekofmPaintLive._busy) {
        window.__nekofmPaintLive(s.streaming, s.counts.saved);
      }
    }
    if (s.cache && s.cache.dir) { const el = $('cacheDirNow'); if (el) el.textContent = '当前目录：' + s.cache.dir; }

    // 黑名单与已导入歌单（低频变化，但列表不长，随状态一起刷即可）
    renderBlacklist(s.blacklist);
    renderImported(s.playlists);
    // 「歌词配错」按钮 + 被禁名单（2026-10-16）：低频变化，同样随状态刷
    renderLyricBan(s.lyric, s.lyricBan);

    // 播放器：模式 / 静音 / 收藏 / 闲时 / 缓存
    if (s.player) {
      highlightMode(s.player.mode);
      // 静音不再有独立按钮：喇叭图标与百分比合成在音量控件里（点了直接静音）
      $('btnFavorite').textContent = s.favorited ? '★ 已收藏' : '☆ 收藏';
      // 音量控件回填（服务端记着的值）—— 不回填的话每次开机都停在 100%
      // 动态音量：开关/目标/实时读数一起回填（读数只有播放核心窗测得出来，
      // 控制台显示的是它 2Hz 报上来的值）
      if (s.player.autoGain) {
        agcReading = {
          autoGain: { enabled: !!s.player.autoGain.enabled, targetDb: s.player.autoGain.targetDb },
          db: s.player.autoGain.db == null ? null : s.player.autoGain.db,
          gainDb: s.player.autoGain.gainDb == null ? null : s.player.autoGain.gainDb,
          live: !!s.player.autoGain.live,
          capped: !!s.player.autoGain.capped,
        };
      }
      syncVolSlider(s.player.volume, s.player.muted);
      syncAgcBar();
      const badges = [];
      if (s.player.playingIdle) badges.push('闲时歌单');
      if (s.player.cached) badges.push('来自缓存');
      if (s.player.muted) badges.push('静音');
      if (s.favoritesCount) badges.push(`收藏 ${s.favoritesCount}`);
      $('npBadges').textContent = badges.length ? '· ' + badges.join(' · ') : '';
    }
    if (s.favoritesCount != null && state && state.track) {
      // 收藏按钮状态由 setConfig 广播的 favorites 决定，这里只在本地已知时更新
    }
    // 闲时表单只在配置**真的变了**时重填 —— 否则 10Hz 的状态广播会不停
    // 覆盖用户正在选的歌单/勾选项。
    const idleSig = JSON.stringify(s.idle || {}) + '|' + JSON.stringify((s.playlists || []).map((p) => p.id));
    if (idleSig !== renderState._idleSig) {
      renderState._idleSig = idleSig;
      fillIdleForm(s.idle, s.playlists);
    }
    // 缓存只刷摘要 + 批量缓存进度；详细列表按需拉（见 refreshCacheList）
    if (s.cache) {
      fillCacheSummary(s.cache);
      // 跨 IIFE 调用（该函数定义在下面的 newPanels 里）
      if (window.__nekofmPaintCacheBusy) window.__nekofmPaintCacheBusy(s.cache.prefetch);
    }

    // 设备下拉（由播放核心页上报）—— 数据本来就在状态里，直接用它，不再轮询
    if (window.__nekofmRefreshDevices && (s.playerDevices || (s.player && s.player.deviceId))) {
      window.__nekofmRefreshDevices(s);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // strokeHint（描边宽度提示文案）随「歌词叠加层」表单一起搬进了 face-overlay.js

  // ------------------------------------------------------------------ SSE
  /**
   * SSE 连接：**单连接 + 断开后退避重连**（2026-09-26 修）。
   *
   * 不能只靠 EventSource 自己的自动重连：它 error 后立刻重连，服务端可能还没
   * 回收旧连接。Chromium 对同一 host 只有 6 条并发连接，每条 SSE 都长占一条，
   * control / player / 每个预览窗各一条 —— 重连一堆积就把连接池吃光，
   * 表现就是"按钮全都没反应"。这里显式 close + 退避，保证任一时刻只有一条。
   */
  let es = null;
  let esRetry = 0;
  function connect() {
    if (es) { try { es.close(); } catch { /* 忽略 */ } es = null; }
    es = new EventSource('/events');
    es.onopen = () => { esRetry = 0; };
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'state') renderState(m);
      else if (m.type === 'lyrics') { onLyrics(m); }
      else if (m.type === 'config' && m.overlay) {
        fillOverlayForm(m.overlay);
        // 歌词条要用同一套歌词设置（主题/逐字/翻译），所以得记住它
        config = config || {};
        config.overlay = m.overlay;
      }
    };
    es.onerror = () => {
      try { es.close(); } catch { /* 忽略 */ }
      es = null;
      const delay = Math.min(1000 * 2 ** esRetry, 15000);
      esRetry++;
      setTimeout(connect, delay);
    };
  }

  // ------------------------------------------------------------------ 交互
  const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };

  // ------------------------------------------------ 叠加层面（已搬到模块）
  /*
   * 段 2 第二刀：叠加层预览三键 + 歌词叠加层表单 + 播放器信息栏表单
   * 全部搬进 `/assets/ui/face-overlay.js`。这里只负责把它接上，并拿到
   * `fillOverlayForm` —— 服务端推 config 时（下面 connect 的 'config' 分支）
   * 和启动时（boot 里）都要用它把表单刷成当前值。
   */
  const overlayFace = (window.__nekofmFaces && typeof window.__nekofmFaces.overlay === 'function')
    ? window.__nekofmFaces.overlay({ $, api, log, on })
    : null;
  if (!overlayFace) {
    log('error', '/assets/ui/face-overlay.js 没加载 —— 叠加层预览与两个表单会没反应');
  }
  const fillOverlayForm = (o) => { if (overlayFace) overlayFace.fillOverlayForm(o); };

  on('btnShowPlayer', 'click', () => api({ action: 'showPlayerWindow' }));
  on('btnClearQ', 'click', () => api({ action: 'clearQueue' }));
  const copyText = async (txt, what) => {
    try { await navigator.clipboard.writeText(txt); log('info', `${what}已复制：${txt}`); }
    catch { log('error', '复制失败，请手动选中复制'); }
  };
  on('copyAddr', 'click', () => copyText($('addr').textContent, '歌词叠加层地址'));
  on('copyAddrInfo', 'click', () => copyText($('addrInfo').textContent, '信息卡片地址'));
  on('copyAddrBoth', 'click', () => copyText(location.origin + '/overlay', '合并地址'));
  /**
   * 竖刻度音量控件（2026-10-13 换掉原来的 72px 横条）。
   *
   * 用户要求：横条 → 按钮，鼠标移上去弹出**竖着的、带刻度的**音量条（更长），
   * 并且按每格 2% 走。控件本体在 `/shared/volume-dial.js`
   * （控制台与播放核心窗**共用同一份实现**），这里只接四件事：
   * 改音量、切静音、切动态音量、把状态回填进去。
   *
   * 2026-10-13 第二次调整（用户反馈"喇叭图标、百分比、动态音量状态三个按钮整合一下"）：
   * 栏里只剩**一个**按钮（🔊 + 百分比），点击＝静音开关、悬停＝展开竖条；
   * 动态音量的开关与 dB 读数都收进弹出面板。
   */
  dial = window.NekoVolumeDial.mount($('volSlot'), {
    volume: 1,
    showAgc: true,
    // 音量是高频拖动 → 服务端那边走防抖落盘（见 main/commands.js 的 setVolume）
    onVolume: (v) => { api({ action: 'setVolume', volume: v }); },
    // 用 setMuted 带上明确的目标值（而不是 toggleMute）：控件的本地状态已经翻转了，
    // 两边各翻一次万一不同步，图标就会和实际值反着显示
    onMute: (m) => { api({ action: 'setMuted', muted: m }); },
    onAutoGain: (g) => { api({ action: 'setAutoGain', enabled: g.enabled, targetDb: g.targetDb }); },
  });

  /**
   * 把服务端记着的音量/静音/动态音量**回填**成界面状态。
   *
   * 2026-09-26 用户反馈："每次启动程序进去音量都是 100%"。
   * 音量本身其实存住了（`config.player.volume`，实测 0.37），问题在于控件
   * **只有出没有进** —— 于是每次开机都停在 HTML 里的默认值。后果不只是"看着不对"：
   * 从 100% 往下拖一点，设进去的是 0.9x，音量会**突然变响**
   * （看起来像没记住，其实是拖错了基准）。
   *
   * 拖动过程中不回填滑块（`activeElement` 判据在控件内部），否则 10Hz 的
   * 状态广播会在手指按着的时候把滑块拽回去。动态音量的读数也走这里 ——
   * 它由播放核心窗测量、经 state 广播回来，控制台只是显示。
   */
  function syncVolSlider(volume, muted) {
    if (!dial) return;
    dial.update(Object.assign({}, agcReading, {
      volume: volume == null ? undefined : volume,
      muted: muted == null ? undefined : muted,
    }));
  }

  /**
   * 底部栏传输控件右边那枚动态音量读数（用户 2026-10-13 指定的位置）。
   *
   * 数据只有一个来源：`engine.state().player.autoGain` —— 由播放核心窗 2Hz 上报
   * （控制台自己没有 `<audio>`，测不出电平）。所以这里**只显示、不计算**。
   * 开关没开就整块 hidden：不然常温下底部栏白占一块地方。
   */
  function syncAgcBar() {
    const el = $('agcBar');
    if (!el) return;
    const on = !!(agcReading.autoGain && agcReading.autoGain.enabled);
    if (!on) {
      if (!el.hidden) { el.hidden = true; el.className = 'pill pb-agc'; }
      return;
    }
    const fmt = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(1) : '—');
    let tx;
    if (agcReading.db == null) tx = '动态音量 测量中…';
    else if (!agcReading.live) tx = '动态音量 安静段（不追）';
    else tx = `动态音量 ${fmt(agcReading.db)} dBFS · 增益 ${fmt(agcReading.gainDb)} dB`;
    el.className = 'pill pb-agc' + (agcReading.capped ? ' capped' : '');
    el.hidden = false;
    $('agcBarTx').textContent = tx + (agcReading.capped ? ' · 已达上限' : '');
  }

  /** 把服务端返回的失败原因**明确显示出来**（以前失败是完全静默的，用户以为界面坏了） */
  function showOrderFailure(msg) {
    const box = $('results');
    if (box) box.innerHTML = `<div class="tip">⚠️ ${escapeHtml(msg)}</div>`;
    log('error', msg);
  }

  const doOrder = async () => {
    const kw = $('kw').value.trim();
    if (!kw) return;
    const src = $('src').value || null;
    const box = $('results');
    if (box) box.innerHTML = '<div class="tip">搜索并点歌中…</div>';
    // 网易云搜索偶尔要好几秒（限流时更久）。**必须给出进展提示**，
    // 否则就是一直挂着"点歌中…"，用户以为卡死了（实测被反馈）。
    const t1 = setTimeout(() => { if (box) box.innerHTML = '<div class="tip">还在搜索（网易云较慢或正在限流），请稍候…</div>'; }, 5000);
    const t2 = setTimeout(() => { if (box) box.innerHTML = '<div class="tip">搜索超过 15 秒，可能被网易云限流了 — 稍后再试，或先用「只搜索」</div>'; }, 15000);
    let r;
    try {
      r = await api({ action: 'order', keyword: kw, source: src });
    } finally {
      clearTimeout(t1); clearTimeout(t2);
    }
    const d = (r && r.result) || {};
    if (d.ok) {
      const nm = d.item && d.item.song ? d.item.song.name : kw;
      // 自动匹配上了就直接放 —— 匹配度低时额外列出候选，但**不拦着播放**
      if (box) {
        box.innerHTML = `<div class="tip">✅ 已自动匹配并播放：《${escapeHtml(nm)}》第 ${d.position} 位`
          + (d.lowConfidence ? '（匹配度不高，不是这首的话点下面换）' : '') + '</div>';
      }
      log('info', `已点：《${nm}》第 ${d.position} 位`);
      $('kw').value = '';
      if (Array.isArray(d.candidates) && d.candidates.length) {
        d.candidates.forEach((c) => {
          const row = document.createElement('div');
          row.innerHTML = `<span>${escapeHtml(c.name)}</span> <span class="tip">— ${escapeHtml(c.artistText || '')}</span> `;
          const b = document.createElement('button');
          b.textContent = '换这首';
          b.onclick = async () => {
            const rr = await api({ action: 'order', song: c, force: true });
            const dd = (rr && rr.result) || {};
            if (dd.ok) { log('info', `已切到：《${c.name}》`); if (box) box.innerHTML = `<div class="tip">✅ 已换：《${escapeHtml(c.name)}》</div>`; }
            else showOrderFailure(dd.msg || '点歌失败');
          };
          row.appendChild(b);
          box.appendChild(row);
        });
      }
      return;
    }
    // 失败一定要说清楚是哪一种
    const why = {
      duplicate: '这首刚放过或已经在队列里了',
      cooldown: '点歌太频繁，稍等一下',
      peruser: '你同时点的歌已达上限',
      full: '队列满了',
      blacklist: '这首在黑名单里',
      notfound: '没有搜到这首歌（换个更准确的名字，或先点「只搜索」挑一首）',
      limit: '接口被限流了，稍后再试',
    }[d.reason] || d.msg || '点歌失败';
    showOrderFailure(why + (d.msg && d.msg !== why ? `（${d.msg}）` : ''));
    // 搜到候选就顺手列出来，让用户直接挑，而不是自己猜歌名
    if (Array.isArray(d.candidates) && d.candidates.length) {
      if (box) box.innerHTML = `<div class="tip">没找到确切匹配，这几个是最接近的，点一首：</div>`;
      d.candidates.slice(0, 8).forEach((c) => {
        const row = document.createElement('div');
        row.innerHTML = `<span>${escapeHtml(c.name)}</span> <span class="tip">— ${escapeHtml(c.artistText || '')}</span> `;
        const b = document.createElement('button');
        b.textContent = '点这首';
        b.onclick = async () => {
          const rr = await api({ action: 'order', song: c });
          const dd = (rr && rr.result) || {};
          if (dd.ok) log('info', `已点：《${c.name}》第 ${dd.position} 位`);
          else showOrderFailure(dd.msg || '点歌失败');
        };
        row.appendChild(b);
        box.appendChild(row);
      });
    }
  };
  on('btnOrder', 'click', doOrder);
  on('kw', 'keydown', (e) => { if (e.key === 'Enter') doOrder(); });

  on('btnSearch', 'click', async () => {
    const kw = $('kw').value.trim();
    if (!kw) return;
    const box = $('results');
    box.innerHTML = '<div class="tip">搜索中…</div>';
    const r = await api({ action: 'neteaseSearch', keyword: kw, limit: 10 });
    const list = (r.result && r.result.songs) || [];
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="tip">没有结果</div>'; return; }
    list.forEach((s) => {
      const d = document.createElement('div');
      d.innerHTML = `<span>${escapeHtml(s.name)}</span> <span class="tip">— ${escapeHtml(s.artistText)}</span> `;
      const b = document.createElement('button');
      b.textContent = '点这首';
      b.onclick = async () => {
        const rr = await api({ action: 'order', song: s });
        const dd = (rr && rr.result) || {};
        if (dd.ok) log('info', `已点：《${s.name}》第 ${dd.position} 位`);
        else showOrderFailure(dd.msg || '点歌失败');
      };
      d.appendChild(b);
      box.appendChild(d);
    });
  });

  on('btnOrderVideo', 'click', async () => {
    const v = $('bv').value.trim();
    if (!v) return;
    const r = await api({ action: 'orderVideo', target: v });
    if (r.ok) log('info', '视频已入队');
    $('bv').value = '';
  });

  // ---- 歌单导入
  /**
   * @param {'saved'|'queue'} mode
   *   saved（默认）→ 汇入「已保存播放列表」，不打断正在播/正在排的点歌
   *   queue        → 整单排进当前播放列表
   */
  async function doImportPlaylist(mode = 'saved') {
    const input = $('plInput').value.trim();
    if (!input) return;
    const limit = Number($('plLimit').value) || 0;
    const toQueue = mode === 'queue';
    log('info', toQueue ? '导入并整单排进当前队列中…' : '导入到「已保存播放列表」中…');
    const r = await api({
      action: 'playlistImport', input, limit,
      toSaved: !toQueue, autoQueue: toQueue, filterBlacklist: true,
    });
    const res = r.result || {};
    if (!res.ok) { log('error', '导入失败：' + (res.msg || r.error || '未知')); return; }
    const p = res.playlist || {};
    let msg = `《${p.name}》已取到 ${p.fetched} 首（歌单共 ${p.trackCount} 首）`;
    // 网易云只给了一部分（多半是没登录）——必须说清，否则用户只会看到"怎么才几首"
    if (res.truncated) msg += '　⚠️ 网易云没给全，登录网易云后可重导';
    if (res.blockedCount) {
      msg += `；黑名单拦下 ${res.blockedCount} 首` + (res.blockedPreview && res.blockedPreview.length
        ? '：' + res.blockedPreview.map((b) => b.name).join(' / ') : '');
    }
    if (!toQueue) msg += `；已加入已保存播放列表 ${res.savedAdded} 首${res.savedDup ? `（跳过重复 ${res.savedDup} 首）` : ''}`;
    else msg += `；已排进当前队列 ${res.queued} 首`;
    log(res.truncated ? 'warn' : 'info', msg);
    if (!toQueue) refreshSavedList();
  }
  on('btnPlImport', 'click', () => doImportPlaylist('saved'));
  on('btnPlImportQueue', 'click', () => doImportPlaylist('queue'));
  on('plInput', 'keydown', (e) => { if (e.key === 'Enter') doImportPlaylist('saved'); });

  /**
   * 「我的歌单」列表：每个歌单两个动作。
   *
   * 2026-09-26 改：原来只有一个「入队」按钮，而且**硬编码 limit 50** ——
   * 100+ 首的歌单点一下就只进 50 首（再叠上服务端只给 10 首的老问题，体感就是"丢了"）。
   * 现在两个按钮都取全量（limit 0），默认入口是「加入已保存」。
   */
  on('btnMyPl', 'click', async () => {
    const box = $('plList');
    box.innerHTML = '<div class="tip">读取中…</div>';
    const r = await api({ action: 'neteaseMyPlaylists' });
    const list = (r.result && r.result.playlists) || [];
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="tip">没有歌单（需先登录网易云）</div>'; return; }
    list.slice(0, 50).forEach((p) => {
      const d = document.createElement('div');
      d.innerHTML = `<span>${escapeHtml(p.name)}</span> <span class="tip">${p.trackCount} 首</span> `;
      const add = document.createElement('button');
      add.textContent = '加入已保存';
      add.title = `把《${p.name}》整张加入「已保存播放列表」（取全量，不打断点歌）`;
      add.onclick = async () => {
        const rr = await api({ action: 'playlistImport', input: String(p.id), limit: 0, toSaved: true });
        const d2 = rr.result || {};
        if (d2.ok) {
          log('info', `《${(d2.playlist || {}).name || p.name}》已加入已保存播放列表 ${d2.savedAdded} 首` +
            (d2.savedDup ? `（跳过重复 ${d2.savedDup} 首）` : '') + (d2.truncated ? '　⚠️ 网易云没给全' : ''));
          refreshSavedList();
        } else log('error', d2.msg || '加入失败');
      };
      const q = document.createElement('button');
      q.textContent = '排进队列';
      q.title = `把《${p.name}》整张排进当前播放列表（取全量）`;
      q.onclick = async () => {
        const rr = await api({ action: 'playlistImport', input: String(p.id), limit: 0, autoQueue: true, toSaved: false });
        const d2 = rr.result || {};
        if (d2.ok) log('info', `《${(d2.playlist || {}).name || p.name}》已排进当前队列 ${d2.queued} 首${d2.truncated ? '　⚠️ 网易云没给全' : ''}`);
        else log('error', d2.msg || '入队失败');
      };
      d.appendChild(add);
      d.appendChild(q);
      box.appendChild(d);
    });
  });

  on('btnConnRoom', 'click', async () => {
    const room = $('room').value.trim();
    if (!room) return;
    const r = await api({ action: 'connectDanmaku', roomId: room });
    if (r.ok) log('info', '弹幕已连接，真实房间号 ' + (r.result && r.result.room));
  });
  on('btnDiscRoom', 'click', () => api({ action: 'disconnectDanmaku' }));

  // ---- 弹幕通道：官方开放平台 / 浏览器
  /**
   * 两条通道是**互斥的两种模式**，由用户显式选：
   *   - `openlive`：官方开放平台。房间由**主播身份码绑定**，所以「房间号」这个框
   *                 对它没有意义 —— 选它就把房间号禁掉，免得用户以为填了能换房间。
   *   - `browser` ：系统 Edge/Chrome 通道，**房间号在这里才生效**，可以连任意直播间。
   */
  const dmMode = () => ($('dmOpenLive') && $('dmOpenLive').checked) ? 'openlive' : 'browser';
  function applyDmModeUI() {
    const openlive = dmMode() === 'openlive';
    $('room').disabled = openlive;
    $('btnConnRoom').disabled = openlive;
    $('olBox').hidden = !openlive;
  }
  async function switchDmMode(mode) {
    applyDmModeUI();
    const room = $('room').value.trim();
    log('info', mode === 'openlive' ? '切到「官方开放平台」通道…' : '切到「浏览器」通道…');
    try {
      const r = await api({ action: 'setDanmakuMode', mode, roomId: room || undefined });
      if (r.ok) log('info', `通道已切换（${r.result && r.result.mode}），房间 ${(r.result && r.result.room) || '?'}`);
    } catch (e) {
      log('error', '通道切换失败：' + (e && e.message));
    }
  }
  on('dmOpenLive', 'change', () => switchDmMode('openlive'));
  on('dmBrowser', 'change', () => switchDmMode('browser'));

  // 保存开放平台凭据（secret 留空 = 不改已存的那份）
  on('btnSaveOpenLive', 'click', async () => {
    const body = {
      action: 'setOpenLive',
      enabled: true,
      accessKeyId: $('olKeyId').value.trim(),
      accessKeySecret: $('olKeySecret').value.trim(),
      appId: $('olAppId').value.trim(),
      roomOwnerAuthCode: $('olAuthCode').value.trim(),
    };
    const missing = [];
    if (!body.accessKeyId) missing.push('access_key_id');
    if (!body.appId) missing.push('app_id');
    if (!body.roomOwnerAuthCode) missing.push('身份码');
    if (missing.length && !$('olKeySecret').placeholder.includes('已保存')) {
      missing.push('access_key_secret');
    }
    if (missing.length) {
      $('olInfo').textContent = '还缺：' + missing.join(' / ');
      return;
    }
    try {
      await api(body);
      $('olKeySecret').value = '';
      $('olInfo').textContent = '已保存并重连 ✓';
      log('info', '开放平台凭据已保存，正在按新凭据重连');
    } catch (e) {
      $('olInfo').textContent = '保存失败：' + (e && e.message);
      log('error', '开放平台凭据保存失败：' + (e && e.message));
    }
  });

  /* 网易云登录（扫码 / 登录窗 / 核验 / 登出 / cookie）已搬进 face-account.js。
     宿主只留下面的接线与两个转发；模块没加载时上面那行 log('error') 会说出来。 */
  const accountFace = (window.__nekofmFaces && typeof window.__nekofmFaces.account === 'function')
    ? window.__nekofmFaces.account({ $, api, log, on, confirm: confirmDialog })
    : null;
  if (!accountFace) { log('error', '/assets/ui/face-account.js 没加载 —— 网易云登录与输出设备下拉会没反应'); }
  const checkNeteaseStatus = (quiet) => (accountFace ? accountFace.checkNeteaseStatus(quiet) : Promise.resolve({}));
  const refreshDevices = (s) => { if (accountFace) accountFace.refreshDevices(s); };
  const fillAccountForm = (c) => { if (accountFace) accountFace.fillFromConfig(c); };

  /**
   * B站登录（视频字幕要用）。
   *
   * 两条路：登录窗扫码（省事，但要过 B站对自动化环境的检测）与 SESSDATA 粘贴
   * （一定可用，headless 下也能用）。哪条成了都会把 cookie 写进配置，
   * 之后字幕接口就能拿到列表了。
   */
  on('btnBiliLogin', 'click', async () => {
    $('biliStat').textContent = '等待登录窗完成…';
    log('info', '已打开 B站登录窗，请扫码或输入账号密码…');
    const r = await api({ action: 'biliBrowserLogin' });
    const res = r.result || {};
    if (res.ok && res.loggedIn) {
      $('biliStat').textContent = '✅ 已登录' + (res.nick ? '：' + res.nick : '');
      log('info', 'B站登录成功，视频的 CC/AI 字幕现在可以当歌词用了');
    } else {
      $('biliStat').textContent = res.msg || '未完成登录';
      log('error', 'B站登录未完成：' + (res.msg || '（可改用下面的 SESSDATA 粘贴框）'));
    }
  });

  on('btnBiliLogout', 'click', async () => {
    if (!await confirmDialog('登出 B站？\n\n会清掉本工具保存的 B站登录态（不影响你浏览器里的 B站登录）。\n之后视频歌词会回落到"按标题匹配网易云"。')) return;
    await api({ action: 'biliBrowserLogout' });
    $('biliStat').textContent = '已登出';
    log('info', '已登出 B站');
  });

  on('btnBiliCookie', 'click', async () => {
    const v = $('biliCookie').value.trim();
    if (!v) { log('error', '先粘贴 cookie 再保存'); return; }
    const r = await api({ action: 'biliSetCookie', cookie: v });
    const res = r.result || {};
    $('biliStat').textContent = res.loggedIn ? '✅ 已登录' + (res.nick ? '：' + res.nick : '') : '⚠️ cookie 已保存但核验未通过';
    log(res.loggedIn ? 'info' : 'error',
      res.loggedIn ? 'B站已登录' + (res.nick ? '：' + res.nick : '') + '，视频字幕可用' : 'B站 cookie 无效（没拿到 SESSDATA，或已过期）');
    if (res.loggedIn) $('biliCookie').value = '';
  });

  /* 播放设备下拉（含签名守卫、以及"重建时必须保留当前选择"那段坑）已搬进 face-account.js。 */

  // 叠加层表单已搬进 face-overlay.js（宿主侧只留一个 fillOverlayForm 转发，见上面接线）

  // refreshBoxHint / collectOverlay 也搬进了 face-overlay.js

  // btnSaveOverlay 现在由 face-overlay.js 处理（那里的 collectOverlay 才读真正的表单）

  // ------------------------------------------------------------------ 黑名单 / 歌单渲染
  const RULE_LABEL = { song: '歌曲ID', keyword: '关键词', artist: '歌手', bvid: 'BV号' };

  /**
   * 已导入歌单列表。
   *
   * **内容没变就不重建 DOM**（2026-09-26 修）：这个函数在 10Hz 的状态广播里被调用，
   * 旧版每次都 `innerHTML=''` 整块重建 —— 白耗主线程，而且按钮在
   * mousedown/mouseup 之间被换成新节点会导致 click 丢失（和队列列表同一类坑）。
   */
  function renderImported(list) {
    const box = $('importedList');
    const sig = (list || []).map((p) => `${p.id}:${p.name}:${p.trackCount}`).join('|');
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = '';
    if (!list || !list.length) { box.innerHTML = '<div class="tip">还没有导入过歌单</div>'; return; }
    list.slice().reverse().forEach((p) => {
      const d = document.createElement('div');
      d.innerHTML = `<span>${escapeHtml(p.name)}</span> <span class="tip">${p.trackCount} 首 · id ${p.id}</span> `;
      const q = document.createElement('button');
      q.textContent = '入队';
      q.onclick = async () => {
        const r = await api({ action: 'playlistQueue', id: p.id, filterBlacklist: true });
        const res = r.result || {};
        if (res.ok) log('info', `《${res.name}》入队 ${res.queued}/${res.total} 首${res.blockedCount ? `（拦下 ${res.blockedCount}）` : ''}`);
      };
      const del = document.createElement('button');
      del.textContent = '移除';
      del.onclick = () => api({ action: 'playlistRemove', id: p.id });
      d.appendChild(q); d.appendChild(del);
      box.appendChild(d);
    });
  }

  /**
   * 黑名单列表。
   *
   * **内容没变就不重建 DOM**（2026-09-26 修）：`renderBlacklist` 也在 10Hz 的
   * 状态广播里跑。旧版每次都整块重建 —— 黑名单有 N 条规则时，等于
   * **每秒 10×N 次元素创建**，主线程被这条白白压住（叠加层预览、输入框、
   * 按钮都会跟着变迟钝）。而且规则一多就会踩"按钮被换节点、click 丢失"的坑。
   */
  function renderBlacklist(bl) {
    if (!bl) return;
    const cb = $('blEnabled');
    if (document.activeElement !== cb) cb.checked = !!bl.enabled;
    $('blCount').textContent = `共 ${bl.total} 条规则${bl.enabled ? '' : '（已停用）'}`;
    const ul = $('blList');
    const sig = `${bl.enabled}|${bl.total}|` + (bl.rules || []).map((r) => `${r.id}:${r.type}:${r.value}`).join('|');
    // 正在这一列里操作（下拉展开等）时一律不重画 —— 原生控件被重建会自己收起
    const busy = ul.contains(document.activeElement) && document.activeElement.tagName === 'SELECT';
    if (busy || ul.dataset.sig === sig) return;
    ul.dataset.sig = sig;
    ul.innerHTML = '';
    if (!bl.rules || !bl.rules.length) {
      ul.innerHTML = '<li><span class="tip">暂无规则。可添加关键词/歌手/歌曲ID/BV号。</span></li>';
      return;
    }
    bl.rules.forEach((r) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="tip">${RULE_LABEL[r.type] || r.type}</span>`
        + `<span class="nm">${escapeHtml(r.value)}</span>`
        + (r.note ? `<span class="by">${escapeHtml(String(r.note).slice(0, 16))}</span>` : '');
      const b = document.createElement('button');
      b.textContent = '删';
      b.onclick = () => api({ action: 'blacklistRemove', id: r.id });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  on('blEnabled', 'change', () => api({ action: 'blacklistToggle', enabled: $('blEnabled').checked }));
  on('btnBlAdd', 'click', async () => {
    const value = $('blValue').value.trim();
    if (!value) return;
    const r = await api({ action: 'blacklistAdd', type: $('blType').value, value });
    const res = r.result || {};
    if (res.ok) {
      log('info', res.duplicate ? '该规则已存在' : `已添加拦截规则：${RULE_LABEL[$('blType').value]} = ${value}`);
      $('blValue').value = '';
    } else {
      log('error', '添加失败：' + (res.msg || ''));
    }
  });
  on('blValue', 'keydown', (e) => { if (e.key === 'Enter') $('btnBlAdd').click(); });
  on('btnBlBlockCurrent', 'click', async () => {
    const r = await api({ action: 'blacklistBlockTrack' });
    const res = r.result || {};
    if (res.ok) log('info', `已拉黑当前曲目（${res.rule ? RULE_LABEL[res.rule.type] + '=' + res.rule.value : ''}）`);
    else log('error', res.msg || '拉黑失败');
  });
  on('btnBlBlockKw', 'click', async () => {
    const r = await api({ action: 'blacklistBlockTrack', asKeyword: true });
    const res = r.result || {};
    if (res.ok) log('info', '已按曲名关键词拉黑');
    else log('error', res.msg || '拉黑失败');
  });
  on('btnBlPurge', 'click', async () => {
    const r = await api({ action: 'blacklistPurgeQueue' });
    log('info', `已从队列清理 ${(r.result && r.result.removed) || 0} 首违规曲目`);
  });
  on('btnBlClear', 'click', async () => {
    const r = await api({ action: 'blacklistClear' });
    log('info', `已清空黑名单（${(r.result && r.result.count) || 0} 条）`);
  });

  // ---- 歌词配错（2026-10-16）
  /** 被禁名单里显示"来源"用；跟 engine 的 SOURCE_LABEL 是两码事（这里只管三个值） */
  const LYRIC_SRC_TXT = { netease: '网易云', bilibili: 'B站', local: '本地' };

  /**
   * 底部歌词条上那颗按钮 + 「在线缓存」卡片里的被禁名单。
   *
   * 跑在 10Hz 的状态广播里，所以**内容没变就不重建 DOM**（跟 renderBlacklist
   * 同一个道理：每条按钮每秒被重建 10 次，点击就会丢，也会白白压住主线程）。
   */
  function renderLyricBan(lyric, ban) {
    const list = (ban && ban.list) || [];
    const stat = $('lyricBanStat');
    if (stat) stat.textContent = list.length ? `已禁止自动匹配的曲目：${list.length}` : '自动匹配歌词：没有被禁的曲目';

    const btn = $('btnLyricMismatch');
    if (btn) {
      const banned = !!(lyric && lyric.banned);
      const key = (lyric && lyric.banKey) || '';
      const label = banned ? '恢复自动匹配' : '歌词配错 ✕';
      if (btn.textContent !== label) btn.textContent = label;
      // 没有在播曲目（或算不出标识）时不可点 —— 点了也不知道该删谁的词
      btn.disabled = !key;
      btn.title = banned
        ? '这首歌已被禁止自动匹配歌词（那份词已经删了）。点一下恢复：马上重新取一次歌词。'
        : '这份歌词配错了（比如配上了别的版本、后半段对不上）？点一下删掉它，并禁止这首歌以后再自动匹配。';
    }

    const ul = $('lyricBanList');
    if (!ul) return;
    const sig = list.map((e) => `${e.key}:${e.addedAt}`).join('|');
    if (ul.dataset.sig === sig) return;
    ul.dataset.sig = sig;
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li><span class="tip">没有被禁的曲目。歌词配错时点底部歌词条上的「歌词配错 ✕」。</span></li>';
      return;
    }
    list.forEach((e) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="nm" title="${escapeHtml(e.name || e.key)}">${escapeHtml(e.name || e.key)}</span>`
        + `<span class="by">${escapeHtml(LYRIC_SRC_TXT[e.source] || e.source || '')}</span>`;
      const b = document.createElement('button');
      b.textContent = '恢复';
      b.onclick = async () => {
        const r = await api({ action: 'lyricAutoUnban', key: e.key });
        const res = r.result || {};
        toast(!!res.ok, res.ok ? `已恢复《${e.name || e.key}》的自动匹配歌词` : (res.msg || '恢复失败'));
      };
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  on('btnLyricMismatch', 'click', async () => {
    const s = state || {};
    const lyric = s.lyric || {};
    const name = (s.track && (s.track.name || s.track.title)) || '当前曲目';

    // 已经禁过 → 这颗按钮变成"恢复"
    if (lyric.banned) {
      const r = await api({ action: 'lyricAutoUnban', key: lyric.banKey });
      const res = r.result || {};
      toast(!!res.ok, res.ok ? `已恢复《${name}》的自动匹配歌词，正在重新取词…` : (res.msg || '恢复失败'));
      return;
    }

    const yes = await confirmDialog(
      `把《${name}》的歌词删掉，并且以后不再自动匹配？\n\n`
      + '· 删掉这份歌词（磁盘缓存；本地曲目会连同名 .lrc / .trans.lrc 一起删）\n'
      + '· 之后播放它不再查任何自动来源（原平台歌词 / B站字幕 / 按歌名匹配），显示"无歌词"\n'
      + '· 音频缓存不动；「在线缓存」卡片里可以随时恢复',
    );
    if (!yes) return;

    const r = await api({ action: 'lyricAutoBan' });
    const res = r.result || {};
    if (!res.ok) { toast(false, '操作失败：' + (res.msg || '未知原因')); return; }
    toast(true, `已删除《${res.name || name}》的歌词并禁止自动匹配${
      res.files && res.files.length ? `（连带删掉 ${res.files.length} 个旁车文件）` : ''}`);
    if (res.fileErrors && res.fileErrors.length) {
      toast(false, '旁车歌词删除失败：' + res.fileErrors.map((e) => `${e.path}（${e.msg}）`).join('；'));
    }
  });

  on('btnLyricBanClear', 'click', async () => {
    const n = (state && state.lyricBan && state.lyricBan.total) || 0;
    if (!n) { log('info', '没有被禁的曲目'); return; }
    const yes = await confirmDialog(`把 ${n} 条「禁止自动匹配歌词」全部恢复？\n\n以后播放它们会重新联网匹配歌词（正在播的那首会立刻重取一次）。`);
    if (!yes) return;
    const r = await api({ action: 'lyricAutoBanClear' });
    const res = r.result || {};
    toast(!!res.ok, res.ok ? `已恢复 ${res.removed || 0} 首的自动匹配歌词` : (res.msg || '恢复失败'));
  });

  // ---- 播放器信息栏：整块（fillInfoBarForm / collectInfoBar / 即时生效）搬进 face-overlay.js

  // ------------------------------------------------------------------ 传输控件 / 播放模式
  const MODE_LABEL = { order: '顺序播放', 'repeat-all': '列表循环', 'repeat-one': '单曲循环', shuffle: '随机播放' };

  function highlightMode(mode) {
    document.querySelectorAll('#modeGroup .mode').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.style.borderColor = on ? '#1d7b93' : '';
      b.style.background = on ? '#14586b' : '';
      b.style.color = on ? '#d9f6ff' : '';
    });
  }

  document.querySelectorAll('#modeGroup .mode').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await api({ action: 'setPlayMode', mode: b.dataset.mode });
      if (r.ok) { highlightMode(b.dataset.mode); log('info', '播放模式：' + (r.result.label || MODE_LABEL[b.dataset.mode])); }
    });
  });

  on('btnPrev', 'click', () => api({ action: 'prev' }));
  /**
   * 播放 / 暂停。
   *
   * **如实反馈**（2026-09-26 修）：什么都没有在播的时候点"播放"，
   * 引擎不会假装播起来（状态保持 idle），这里也要说明白为什么，
   * 否则用户看到"点了没反应"又要以为程序坏了。
   */
  on('btnPlayToggle', 'click', async () => {
    const r = await api({ action: 'togglePlay' });
    const d = (r && r.result) || {};
    if (d.did === 'nothing_to_play') {
      log('info', '还没有在播的歌 —— 先在「点歌」里点一首，或用列表页的「播放已保存歌单」开始');
    }
  });
  on('btnSkip', 'click', () => api({ action: 'skip', uname: '控制台' }));
  // 静音按钮已并入音量控件（点按钮＝静音开关，见上面的 NekoVolumeDial.mount）
  on('btnFavorite', 'click', async () => {
    const r = await api({ action: 'toggleFavorite' });
    if (r.ok) log('info', r.result.favorited ? '已收藏当前曲目' : '已取消收藏');
  });

  // 进度条拖动跳转
  {
    const bar = $('seekBar');
    let dragging = false;
    const seekTo = (ev) => {
      const rect = bar.getBoundingClientRect();
      const d = (state && state.playback && state.playback.duration) || 0;
      if (!d) return;
      const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      api({ action: 'seek', position: ratio * d });
    };
    if (bar) {
      bar.addEventListener('mousedown', (e) => { dragging = true; seekTo(e); });
      bar.addEventListener('mousemove', (e) => { if (dragging) seekTo(e); });
      window.addEventListener('mouseup', () => { dragging = false; });
      bar.style.cursor = 'pointer';
    }
  }

  // ------------------------------------------------------------------ 闲时歌单
  /**
   * 闲时歌单**不再按来源分支**（没有音源/歌单下拉了）。
   * 它的内容就是「已保存播放列表」：不管歌来自网易云歌单、本地曲库还是收藏，
   * 都先"加入已保存"，再由这一个列表统一充当闲时歌单。
   */
  function fillIdleForm(idle, playlists) {  // playlists 参数保留：调用方签名不变
    if (!idle) return;
    $('idleEnabled').checked = !!idle.enabled;
    $('idleShuffle').checked = state && state.player ? state.player.mode === 'shuffle' : idle.shuffle !== false;
    $('idleAvoid').value = idle.avoidRecent == null ? 10 : idle.avoidRecent;
    const n = (state && state.counts && state.counts.saved) || 0;
    $('idleStat').textContent = idle.enabled
      ? `开启中 · 内容 = 已保存播放列表（${n} 首）`
      : '已关闭';
  }

  on('btnSaveIdle', 'click', async () => {
    const patch = {
      enabled: $('idleEnabled').checked,
      // 闲时歌单的唯一来源
      source: 'saved',
      shuffle: $('idleShuffle').checked,
      avoidRecent: Number($('idleAvoid').value) || 0,
    };
    if (patch.enabled && !(state && state.counts && state.counts.saved)) {
      log('error', '「已保存播放列表」还是空的 —— 先往里面加歌（列表项上的「加入已保存」，或下面的来源按钮）');
      return;
    }
    const r = await api({ action: 'setIdle', patch });
    if (r.ok) { fillIdleForm(r.result.idle); log('info', '闲时歌单已保存'); }
  });
  ['idleEnabled', 'idleShuffle'].forEach((id) => {
    const e = $(id);
    if (e) e.addEventListener('change', () => { /* 改动由「保存」按钮提交 */ });
  });

  /**
   * 刷新「已保存播放列表」。
   *
   * **必须走 window 钩子**：control.js 按功能拆成了几个 IIFE，`refreshSaved`
   * 定义在后面那个 IIFE 里 —— 这里直接写 `refreshSaved()` 是 ReferenceError
   * （「我的收藏」/「本地曲库」按钮点了只记日志、列表不刷新，就是踩了这个）。
   * 页面加载后钩子已就绪，用户点击时必定可用。
   */
  const refreshSavedList = () => {
    if (window.__nekofmRefreshLists) window.__nekofmRefreshLists();
    else if (window.__nekofmSyncSaved) window.__nekofmSyncSaved();
  };

  /**
   * 从各来源整批加入「已保存播放列表」——一视同仁。
   *
   * 「已导入歌单」这个来源按钮 2026-09-26 去掉了：歌单导入现在**默认就直接落进已保存列表**，
   * 再留一个"从已导入歌单加入"的按钮纯属多余（用户反馈"那几个来源按钮好像没意义了"）。
   * 收藏 / 本地曲库这两个来源与歌单无关，仍然保留。
   */
  const pullFrom = async (source, label) => {
    const r = await api({ action: 'savedPullFrom', source });
    const d = r.result || {};
    if (d.ok) { log('info', `已从「${label}」加入 ${d.added} 首${d.dup ? `（跳过重复 ${d.dup} 首）` : ''}，已保存共 ${d.count} 首`); refreshSavedList(); }
    else log('error', d.msg || `从「${label}」加入失败`);
  };
  on('btnSavedFromFav', 'click', () => pullFrom('favorites', '我的收藏'));
  on('btnSavedFromLocal', 'click', () => pullFrom('local', '本地曲库'));

  // ------------------------------------------------------------------ 媒体缓存
  /** 摘要（随状态广播刷新，很轻） */
  function fillCacheSummary(c) {
    if (!c) return;
    $('cacheEnabled').checked = c.enabled !== false;
    // 音频与歌词是同一个缓存子系统，统计一起显示
    const ly = c.lyricCount || 0;
    const parts = [];
    if (c.count) parts.push(`音频 ${c.count} 首 / ${c.mb} MB`);
    if (ly) parts.push(`歌词 ${ly} 首`);
    $('cacheStat').textContent = parts.length
      ? `已缓存：${parts.join('，')}（音频上限 ${c.maxMB} MB）`
      : '暂无缓存';
  }

  /** 详细列表（含最近缓存条目 + 逐条删除），按需拉取 */
  /**
   * 缓存条目列表一次最多渲染多少行。
   *
   * 缓存条目可以到几千条（每行带一个删除按钮），一次性铺满 DOM 没必要；
   * 超过就只渲染前 N 条 + 一个「显示全部」按钮。
   * 注意这**不是**后端限制：数据是完整的，只是默认不一次画出来。
   */
  const CACHE_RENDER_MAX = 300;

  /**
   * 刷新缓存列表。
   *
   * 2026-09-26 修：旧实现取 `stats().recent`（服务端只截 10 条）再 `slice(0, 12)`，
   * 两处上限叠起来 —— 55 条缓存只显示 10 条，用户反馈"显示的项目不全"。
   * 现在摘要走 `cacheStats`、明细走 `cacheList`（全量）。
   *
   * @param {boolean} showAll 是否铺开全部行（点「显示全部」后为 true）
   */
  async function refreshCacheList(showAll = false) {
    const r = await api({ action: 'cacheStats' });
    const st = r.result;
    if (!st) return;
    fillCacheSummary({ enabled: st.enabled, count: st.count, mb: Number(((st.bytes || 0) / 1048576).toFixed(1)), maxMB: Math.round((st.maxBytes || 0) / 1048576) });

    const lr = await api({ action: 'cacheList' });
    const all = (lr.result && lr.result.items) || [];
    const ul = $('cacheList');
    ul.innerHTML = '';
    const shown = all.slice(0, showAll ? all.length : CACHE_RENDER_MAX);

    shown.forEach((m) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="nm">${escapeHtml(m.name || m.key)}</span>`
        + `<span class="by">${escapeHtml(m.artist || '')}</span>`
        + `<span class="by">${m.mb} MB</span>`;
      const del = document.createElement('button');
      del.textContent = '删';
      del.title = '删除这一条缓存（音频 + 对应歌词）';
      del.onclick = async () => {
        const rr = await api({ action: 'cacheDropKeys', keys: [m.key] });
        const d = (rr && rr.result) || {};
        log(d.audio || d.lyrics ? 'info' : 'error',
          d.audio || d.lyrics ? `已删除（音频 ${d.audio} · 歌词 ${d.lyrics}）` : '删除失败');
        refreshCacheList(showAll);
      };
      li.appendChild(del);
      ul.appendChild(li);
    });

    if (!all.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="tip">还没有缓存条目</span>';
      ul.appendChild(li);
    }
    const info = $('cacheListInfo');
    if (info) {
      info.textContent = all.length
        ? `缓存了 ${all.length} 条（按缓存时间倒序）`
          + (shown.length < all.length ? `，下面先列最近 ${shown.length} 条` : '')
        : '';
    }
    // 条数很多时给一个手动铺开的入口
    if (shown.length < all.length) {
      const li = document.createElement('li');
      const more = document.createElement('button');
      more.textContent = `显示全部（还有 ${all.length - shown.length} 条）`;
      more.onclick = () => refreshCacheList(true);
      li.appendChild(more);
      ul.appendChild(li);
    }
  }

  /**
   * 批量缓存进度：由状态广播（state.cache.prefetch）驱动显示。
   *
   * 注意跨 IIFE：`renderState` 在**上一个** IIFE 里，访问不到这个函数，
   * 所以挂到 window 上（和 `__nekofmPaintLive` 一个套路）。
   */
  function paintCacheBusy(pf) {
    const el = $('cacheBusy');
    if (!el) return;
    el.textContent = pf && pf.running ? `正在批量缓存 ${pf.done || 0}/${pf.total || 0}…` : '';
  }
  window.__nekofmPaintCacheBusy = paintCacheBusy;

  on('cacheEnabled', 'change', async () => {
    await api({ action: 'cacheToggle', enabled: $('cacheEnabled').checked });
    refreshCacheList();
  });
  on('btnCacheClear', 'click', async () => {
    if (!await confirmDialog('清空全部缓存？\n\n音频 + 歌词都会删掉。\n下次播放这些歌会重新从网络取（不受限流保护影响，但会慢一点）。')) return;
    const r = await api({ action: 'cacheClear' });
    if (r.ok) {
      log('info', `已清空缓存（音频 ${r.result.removed} 条${r.result.lyricsRemoved ? ` · 歌词 ${r.result.lyricsRemoved} 条` : ''}）`);
      refreshCacheList();
    }
  });
  // 只清歌词、保留音频：适合"歌词配错了想重新匹配"
  on('btnCacheClearLyrics', 'click', async () => {
    if (!await confirmDialog('只清歌词缓存？\n\n音频保留不动 —— 适合「歌词配错了想重新匹配」的场景。\n清完后播放时会重新联网匹配歌词。')) return;
    const r = await api({ action: 'cacheClearLyrics' });
    if (r && r.ok) { log('info', `已清掉 ${r.result.removed} 首的歌词缓存（音频保留）`); refreshCacheList(); }
  });
  /**
   * 清理孤儿缓存：只看"在不在已保存列表/收藏里"，与播放历史无关。
   *
   * 先 dryRun 拿数量给用户看清楚再确认 —— 批量删除不该让人凭感觉点。
   */
  on('btnCacheDropOrphans', 'click', async () => {
    const scan = ((await api({ action: 'cacheDropOrphans', dryRun: true })).result) || {};
    if (!scan.count) {
      log('info', '没有可清理的：现有缓存里的曲目都还在「已保存播放列表」或「收藏」里');
      return;
    }
    const preview = (scan.preview || []).slice(0, 6).join('\n  ');
    if (!await confirmDialog(`将清理 ${scan.count} 首不在「已保存播放列表」和「收藏」里的缓存（约 ${scan.mb} MB）。\n\n`
      + `保留：已保存播放列表 + 收藏 + 正在播放的那首。\n`
      + `下次播放到这些歌时会重新从网络缓存。\n\n`
      + `其中（最多列出 6 条键名）：\n  ${preview}`)) return;
    const r = ((await api({ action: 'cacheDropOrphans' })).result) || {};
    log(r.audio || r.lyrics ? 'info' : 'warn',
      (r.audio || r.lyrics)
        ? `已清理 ${r.audio} 条音频 + ${r.lyrics} 条歌词缓存（约 ${r.mb} MB）`
          + (r.skipped ? `；${r.skipped} 条文件被占用已跳过` : '')
        : '没有可清理的条目');
    refreshCacheList();
  });
  /** 批量缓存（后台串行跑，进度看顶栏通知 + 本行的"正在批量缓存 N/M"） */
  const prefetch = async (source, label) => {
    if (!await confirmDialog(`批量缓存「${label}」里的在线曲目？\n\n· 后台串行下载，不影响当前播放\n· 已缓存过的会自动跳过\n· 本地曲目不需要缓存`)) return;
    const r = await api({ action: 'cachePrefetch', source });
    const d = (r && r.result) || {};
    if (d.ok) log('info', `已开始批量缓存「${label}」（共 ${d.total} 首）`);
    else log('error', d.msg || '批量缓存启动失败');
  };
  on('btnCachePrefetchSaved', 'click', () => prefetch('saved', '已保存播放列表'));
  on('btnCachePrefetchHist', 'click', () => prefetch('history', '已播放'));

  // ------------------------------------------------ 测试中心 / 演练·注入（已搬到模块）
  /*
   * 段 2 第一刀：这两张卡的代码已经搬进 `/assets/ui/face-ops.js`。
   * 「面」模块的契约写在那个文件头上：模块只往 `window.__nekofmFaces` 挂 `init(ctx)`，
   * ctx 由这里注入（$ / api / log / on / esc），模块不碰宿主的其它内部变量。
   *
   * 为什么先搬这一块：它是五个面里**最不缠数据流**的一段（只发指令、画结果），
   * 适合先把契约跑通再动别的。缺少模块时**必须响亮报错**——静默少一块功能
   * 正是这次改造要消灭的那类问题。
   */
  const opsFace = (window.__nekofmFaces && typeof window.__nekofmFaces.ops === 'function')
    ? window.__nekofmFaces.ops({ $, api, log, on, esc: escapeHtml })
    : null;
  if (!opsFace) {
    log('error', '/assets/ui/face-ops.js 没加载 —— 测试中心与演练/注入按钮会没反应');
  }

  // ------------------------------------------------------------------ 本地音乐
  const fmtDur = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  function renderLocalList(res) {
    const ul = $('localList');
    ul.innerHTML = '';
    const tracks = (res && res.tracks) || [];
    $('localStat').textContent = res
      ? `曲库 ${res.libraryTotal} 首${res.adhoc ? `（含 ${res.adhoc} 个临时打开）` : ''}${res.total !== res.libraryTotal ? `，匹配 ${res.total} 首` : ''}`
      : '';
    if (!tracks.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="tip">曲库为空。点「打开音乐文件夹…」加入目录，或「打开音乐文件…」直接放一首。</span>';
      ul.appendChild(li);
      return;
    }
    tracks.slice(0, 200).forEach((t) => {
      const li = document.createElement('li');
      const tag = t.adhoc ? '<span class="by">临时</span>' : '';
      li.innerHTML = `<span class="nm" title="${escapeHtml(t.file)}">${escapeHtml(t.name)}</span>`
        + `<span class="by">${escapeHtml(t.artistText || '')}</span>${tag}`
        + `<span class="by">${fmtDur(t.duration)}</span>`;
      const play = document.createElement('button');
      play.textContent = '播放';
      play.onclick = async () => {
        const r = await api({ action: 'localQueue', file: t.file, urgent: true });
        if (r.ok) log('info', `已排入并播放：${t.name}`);
      };
      const queue = document.createElement('button');
      queue.textContent = '入队';
      queue.onclick = async () => {
        const r = await api({ action: 'localQueue', file: t.file });
        if (r.ok) log('info', `已入队：${t.name}`);
      };
      li.appendChild(play);
      li.appendChild(queue);
      ul.appendChild(li);
    });
  }

  async function loadLocal(keyword = '') {
    const r = await api({ action: 'localList', keyword, limit: 200 });
    renderLocalList(r.result);
  }

  // 主栏与右栏两个入口走同一套逻辑（避免两处实现漂移）
  const doOpenFiles = async () => {
    const r = await api({ action: 'localOpenFiles' });
    const res = r.result || {};
    if (res.canceled) return;
    if (!res.ok) { log('error', '打开失败：' + (res.msg || '')); return; }
    log('info', `已打开 ${res.added.length} 个文件，入队 ${res.queued} 首`);
    loadLocal($('localSearch').value.trim());
  };

  const doOpenFolder = async () => {
    const r = await api({ action: 'localOpenFolder' });
    const res = r.result || {};
    if (res.canceled) return;
    if (!res.ok) { log('error', '加入曲库失败：' + ((res.results && res.results[0] && res.results[0].msg) || res.msg || '')); return; }
    log('info', `已加入曲库，共 ${res.total} 首`);
    const cfg = await api({ action: 'getConfig' });
    if (cfg.result && cfg.result.config) $('localDirs').value = (cfg.result.config.local.dirs || []).join(';');
    loadLocal();
  };

  // 本地入口只有「本地音乐」卡片那一套（点歌卡片里的重复按钮已移除）
  on('btnOpenFiles', 'click', doOpenFiles);
  on('btnOpenFolder', 'click', doOpenFolder);

  on('btnLocalSearch', 'click', () => loadLocal($('localSearch').value.trim()));
  on('btnLocalAll', 'click', () => { $('localSearch').value = ''; loadLocal(); });
  on('localSearch', 'keydown', (e) => { if (e.key === 'Enter') loadLocal($('localSearch').value.trim()); });

  // ------------------------------------------------------------------ 本地曲库（目录配置）
  on('btnSaveDirs', 'click', async () => {
    const dirs = $('localDirs').value.split(';').map((s) => s.trim()).filter(Boolean);
    await api({ action: 'setConfig', patch: { local: { dirs, enabled: true } } });
    log('info', '目录已保存，开始扫描…');
    const r = await api({ action: 'localRescan' });
    $('localStat').textContent = `已索引 ${(r.result && r.result.count) || 0} 首`;
    loadLocal();
  });
  on('btnRescan', 'click', async () => {
    const r = await api({ action: 'localRescan' });
    $('localStat').textContent = `已索引 ${(r.result && r.result.count) || 0} 首`;
    loadLocal();
  });

  // ------------------------------------------------------------------ 底部歌词条
  /**
   * 初始化（只在 boot 里调一次）。**默认开启** —— 用户要的就是"当播放器用能看词"。
   * 开关状态存 localStorage，下次打开还记得。
   */
  function initLyricStrip() {
    strip.el = $('lyricStrip');
    strip.prev = $('lsPrev');
    strip.cur = $('lsCur');
    strip.trans = $('lsTrans');
    strip.next = $('lsNext');
    if (!strip.el) return;

    if (config && config.overlay) applyStripStyle(config.overlay);

    let saved = '1';
    try { saved = localStorage.getItem('nekofm.lyricStrip') || '1'; } catch { /* 忽略 */ }
    setLyricStrip(saved !== '0');

    const toggle = () => setLyricStrip(!strip.on);
    on('btnLyricStrip', 'click', toggle);
    on('btnLyricClose', 'click', toggle);
    if (typeof LyricSync === 'undefined') {
      // 共享模块没加载（理论上不会）—— 给个明确提示，别静默不动
      strip.cur.textContent = '歌词模块未加载';
      log('error', '共享模块 /shared/lyric-sync.js 未加载，底部歌词条不可用');
      return;
    }
    tickLyricStrip();
  }

  /** 开/关歌词条：改两个高度变量，播放器栏和整页留白一起让位 */
  function setLyricStrip(on) {
    strip.on = !!on;
    try { localStorage.setItem('nekofm.lyricStrip', strip.on ? '1' : '0'); } catch { /* 忽略 */ }
    updateStripHeight();
    if (strip.el) strip.el.hidden = !strip.on;
    const b = $('btnLyricStrip');
    if (b) { b.style.borderColor = strip.on ? '#1d7b93' : ''; b.style.background = strip.on ? '#14586b' : ''; }
    if (strip.on) strip.lastIdx = -2;   // 重新展开时强制重画
  }

  /**
   * 每帧渲染。只在"歌词条开着 + 有歌词"时真的做事，其余情况开销接近 0。
   * 用 rAF 而不是定时器：跟随显示器刷新率，窗口最小化时浏览器自动暂停。
   */
  function tickLyricStrip() {
    strip.raf = requestAnimationFrame(tickLyricStrip);
    if (!strip.on || !strip.el) return;

    /**
     * **换歌（歌词 rev 变了）就无条件重画三行 + 翻译行。**
     *
     * 2026-09-27 修（用户报"切下一首时上一首的歌词还残留一部分"）：
     * 原来重建条件只有"行号变了"，而两个提前 return 的分支（无歌词 / 前奏）
     * 只清了「上一行」「下一行」，**没清翻译行** —— 于是歌词条上会一直挂着
     * 上一首的翻译那一行（`with-trans` 的高度也赖着不走）。另外，如果新歌的
     * 当前行号恰好与旧歌相同（长歌词切到中间），行号比较也发现不了歌词换了。
     * 用 rev 做判据，这一整类残留就都堵住了。
     */
    const tlRev = SNAP.rev;
    const force = strip.lastRev !== tlRev;
    strip.lastRev = tlRev;

    const tl = SNAP.timeline;
    if (!tl || !(tl.lines || []).length) {
      // 没歌词：把**原因**写出来，而不是干挂一个"♪"
      // （"被限流"和"这首歌本来就没词"是两回事，用户需要分得清）
      const why = SNAP.hasLyric ? '' : (SNAP.diag && SNAP.diag.reason) || '';
      const txt = why
        ? (/操作频繁|请稍候|频繁/.test(why) ? '歌词被网易云限流，稍后自动重试' : '无歌词：' + why)
        : (state && state.track ? '♪ 这首歌没有歌词' : '♪ 未在播放');
      if (force || strip.lastIdx !== -3 || strip.cur._why !== txt) {
        strip.lastIdx = -3;
        strip.cur._why = txt;
        strip.cur.className = 'ls-line ls-cur ls-plain ls-none';
        strip.cur.textContent = txt;
        strip.prev.textContent = '';
        strip.next.textContent = '';
        applyTransRow(null);       // 翻译行也要清（否则残留上一首的译文）
      }
      return;
    }

    /**
     * 位置**直接用上报值，不做外推**（2026-09-26 修"切换时文字闪烁"）。
     *
     * 之前这里用 `LyricSync.interpolate()` 按 serverTime 外推 —— 那套是给叠加层的
     * **逐字填充**准备的（已下线）。对歌词条来说外推有害无益，而且会**系统性抖动**：
     *   · 状态 10Hz 推、播放核心 5Hz 上报位置
     *   · 于是每隔一条消息，`position` 还没更新，而 `now - serverTime` 变小了
     *     → 外推值比上一条**倒退**一次（实测约 0.2s 一步）
     *   · `locate()` 的 0.35s 预滚让换行点很"脆"，一倒退就把行号翻回上一行
     *     → 文字在相邻两行之间来回跳，看起来就是闪烁
     *
     * 现在只画"当前行"、行内没有动画，所以用上报值就够：它本身就是
     * `audio.currentTime`，**播放期间单调递增**，换行点确定、不再抖。
     * 代价只是换行最多晚 100ms（10Hz），没有逐字染色，完全看不出来。
     */
    const pos = SNAP.position;
    const at = LyricSync.locate(tl, pos);

    // ---- 还没唱到第一行（前奏 / 刚起播）
    if (!at || at.index < 0) {
      applyStripStyle((config && config.overlay) || {});
      if (force || strip.lastIdx !== -1) {
        strip.lastIdx = -1;
        strip.cur.className = 'ls-line ls-cur ls-plain ls-none';
        strip.cur.textContent = '♪ 前奏…';
        strip.prev.textContent = '';
        strip.next.textContent = (tl.lines[0] && tl.lines[0].text) || '';
        applyTransRow(null);       // 前奏期间不该还挂着上一首的译文
      }
      return;
    }

    // 歌词外观全部来自叠加层那份配置（主题/翻译/字号/颜色…），见 applyStripStyle
    const ovCfg = (config && config.overlay) || {};

    /**
     * **行变了才动 DOM** —— 每帧只改一个 CSS 变量。
     * 行没变的绝大多数帧里开销≈0（这是叠加层那边踩出来的经验：
     * 10Hz 状态 + 60fps 渲染，一旦每帧重建 DOM 就会拖垮主线程）。
     */
    /**
     * 重建条件 = **行号变了 或 歌词设置变了**。
     *
     * 后半条是必须的（和叠加层 renderSig 同一个道理）：用户在面板里改
     * 「翻译」/「逐字」开关时，当前行并没有换行，只比较行号就永远不重建 ——
     * 表现就是"改了没反应，要等下一行才生效"。
     */
    /**
     * 签名要覆盖**所有会改变歌词条长相的设置**（主题/逐字/翻译 + 外观）。
     * 只放前三个的话，改字号/颜色这些还是会"点了没反应"（用户报告的那个）。
     */
    const cfgSig = [
      ovCfg.theme, ovCfg.showTranslation,
      ovCfg.fontSize, ovCfg.color, ovCfg.activeColor, ovCfg.strokeColor, ovCfg.strokeWidth,
      ovCfg.opacity, ovCfg.align,
    ].join('|');
    if (force || at.index !== strip.lastIdx || cfgSig !== strip.lastCfgSig) {
      strip.lastCfgSig = cfgSig;
      applyStripStyle(ovCfg);
      strip.lastIdx = at.index;
      strip.prev.textContent = at.prev ? at.prev.text : '';
      strip.next.textContent = at.next ? at.next.text : '';
      strip.cur.textContent = at.current.text || '♪';
      // 恒为纯色高亮（逐字染色已下线，2026-09-26）
      strip.cur.className = 'ls-line ls-cur ls-plain';
    }
    // 翻译行每帧都过一遍（内部"没变就直接 return"）——
    // 这样中途改「翻译」开关也能立刻生效，不必等下一行
    applyTransRow(at.current);
  }

  /**
   * 翻译行（"双语"就是它）。
   *
   * 跟随**叠加层的同一套设置**：`showTranslation` 关掉就不显示，
   * 有翻译才占位并加高歌词条 —— 这样在面板里改歌词设置，
   * 叠加层和底部歌词条会**一起变**（之前歌词条完全忽略这些设置，
   * 用户以为"改了没生效"）。
   */
  function applyTransRow(line) {
    if (!strip.trans) return;   // 旧页面缓存时元素可能不在
    const ov = (config && config.overlay) || {};
    const txt = ov.showTranslation && line && line.trans ? line.trans : '';
    const show = !!txt;
    if (strip.trans.hidden === !show && strip.trans.textContent === txt) return;
    strip.trans.textContent = txt;
    strip.trans.hidden = !show;
    strip.el.classList.toggle('with-trans', show);
    updateStripHeight();
  }

  /**
   * 把叠加层的**歌词外观设置**同步到底部歌词条（2026-09-26）。
   *
   * 之前歌词条只有自己一套写死的样式 —— 用户在面板里改字号/颜色/描边/对齐，
   * 叠加层跟着变了，歌词条却纹丝不动，于是"点了保存没变化"（用户报告）。
   * 现在这些设置都映射成 `--ls-*` 变量：
   *   fontSize    → 当前行字号（**按比例缩下来**：叠加层那份是给直播画面用的，
   *                 32px 直接塞进 74px 的条里会撑爆）
   *   color       → 非当前行颜色
   *   activeColor → 当前行（含它的翻译行）颜色
   *   stroke*     → 文字描边（text-shadow）
   *   opacity     → 整条文字透明度
   *   align       → 对齐
   */
  function applyStripStyle(ov) {
    if (!strip.el) return;
    const st = strip.el.style;
    const fs = Math.max(13, Math.min(30, Math.round((ov.fontSize || 32) * 0.55)));
    st.setProperty('--ls-fs', fs + 'px');
    if (/^#[0-9a-f]{3,8}$/i.test(ov.color || '')) st.setProperty('--ls-color', ov.color);
    if (/^#[0-9a-f]{3,8}$/i.test(ov.activeColor || '')) st.setProperty('--ls-active', ov.activeColor);
    const sw = Number(ov.strokeWidth) || 0;
    st.setProperty('--ls-stroke', sw > 0
      ? `0 1px ${Math.max(1, Math.round(sw / 2))}px ${ov.strokeColor || '#000'}`
      : 'none');
    st.textAlign = ov.align || 'center';
    /**
     * 歌词条也吃「歌词透明度」（它就是歌词的另一个显示位置，跟自己窗里的那套口径一致）。
     * 直接设元素 opacity —— 曾经还多设过一个 `--ls-opacity` 变量，但全工程没人用过它
     * （真正的变淡只有这一行），2026-09-27 顺手删掉，免得让人以为设了两处。
     */
    strip.el.style.opacity = String(ov.opacity == null ? 1 : ov.opacity);
  }

  /** 歌词条高度：关掉=0 / 有翻译行=94 / 无翻译=74。播放器栏的 bottom 用同一个变量，会一起让位 */
  function updateStripHeight() {
    const h = !strip.on ? 0 : (strip.trans && !strip.trans.hidden ? 94 : 74);
    document.documentElement.style.setProperty('--strip-h', h + 'px');
  }

  /**
   * **页面干扰自检**（2026-09-26 加）。
   *
   * 为什么需要：装了 AdGuard 这类过滤软件时，它会拦截本机 HTTP、往我们页面的
   * `<head>` 里**注入一个外站 `<script>`**，还会**改写我们的 CSP** 好让那个脚本
   * 能加载。那个域名一旦不可达，浏览器就会**阻塞 HTML 解析 20~30 秒**
   * （实测：`readyState` 一直 `loading`、连 `<body>` 都建不出来），
   * 界面和图片看起来全是坏的 —— 用户只会以为程序坏了，根本想不到是过滤软件。
   *
   * 我们**改不动它**（它连 CSP 都改写），能做的是**如实告知**：
   * 把"加载慢了多久 / 页面上有哪些非本机脚本"写进日志，并给出对策。
   */
  function detectPageInterference() {
    try {
      const foreign = Array.from(document.scripts)
        .map((el) => el.src)
        .filter((src) => src && !src.startsWith(location.origin) && !src.startsWith('file:'));
      let elapsed = 0;
      const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      if (nav) elapsed = nav.domContentLoadedEventEnd || nav.duration || 0;
      if (!foreign.length && elapsed < 3000) return;
      const list = [...new Set(foreign)].slice(0, 4).join('、');
      if (foreign.length) {
        // 注：这个日志面板是 textContent 渲染的 —— 这里不能写 Markdown 的 `**` （会原样显示星号），
        // 也不能写 `<b>`（会被当成普通文字）。强调一律用中文引号。
        log('error', `检测到页面被注入了 ${foreign.length} 个「非本机脚本」（${list}）——`
          + '通常是过滤软件（如 AdGuard）注入了 userscript。'
          + '它会阻塞页面解析、让界面和图片显示不出来。'
          + '请在过滤软件里把「127.0.0.1」或本程序加入「白名单 / 不做过滤」。');
      }
      if (elapsed >= 3000) {
        log('warn', `本次页面加载耗时 ${(elapsed / 1000).toFixed(1)} 秒（正常应 <1 秒）——`
          + '常见原因是过滤软件在拦截本机请求。'
          + '对策：在 AdGuard 等软件里关闭「过滤本机/localhost」或把本程序加入白名单。');
      }
    } catch { /* 诊断失败无所谓，绝不能影响启动 */ }
  }

  // ------------------------------------------------------------------ 启动
  async function boot() {
    const r = await api({ action: 'getConfig' });
    config = (r.result && r.result.config) || null;
    if (config) {
      fillOverlayForm(config.overlay);
      $('room').value = config.bilibili.roomId || '';
      $('localDirs').value = (config.local.dirs || []).join(';');
      fillAccountForm(config);   // 「已配置」占位文案在 face-account.js 里
      // B站登录态：配置里的 cookie 是脱敏后的「（已配置）」，有值就说明存过登录态
      if (config.bilibili.cookie) $('biliStat').textContent = '已配置登录态';

      // 弹幕通道 + 开放平台凭据（secret 在配置里是脱敏值，只用来判断"填过没有"）
      const ol = config.bilibili.openLive || {};
      $('olKeyId').value = ol.accessKeyId || '';
      $('olAppId').value = ol.appId || '';
      $('olAuthCode').value = ol.roomOwnerAuthCode || '';
      if (ol.accessKeySecret) $('olKeySecret').placeholder = '已保存（留空则不改）';
      const dmMode = config.bilibili.danmakuMode === 'browser' ? 'browser' : 'openlive';
      $('dmOpenLive').checked = dmMode === 'openlive';
      $('dmBrowser').checked = dmMode === 'browser';
      applyDmModeUI();
    }
    // 两个独立地址：直播姬里各放一个浏览器源，位置互不干扰
    $('addr').textContent = location.origin + '/overlay?only=lyrics';
    $('addrInfo').textContent = location.origin + '/overlay?only=info';
    // 设备清单改为状态驱动（见 refreshDevices 注释），不再 15 秒轮询。
    // 要在 connect() 之前挂好，免得第一帧状态到了却调不到。
    window.__nekofmRefreshDevices = refreshDevices;
    connect();
    checkNeteaseStatus(true).catch(() => {});   // 启动就核验一次，别让用户猜
    refreshDevices();
    if (opsFace && opsFace.loadTestGroups) opsFace.loadTestGroups();   // 在 face-ops.js 里
    loadLocal();
    refreshCacheList();
    initLyricStrip();   // 底部歌词条（开着的话立即开始跟帧）
    log('info', 'NekoFM 控制台已就绪');
    detectPageInterference();
  }
  boot();
})();

/* ==========================================================================
   界面分页 + 底部固定播放器
   --------------------------------------------------------------------------
   做法说明（为什么不是重写 HTML）：现有卡片里已经有大量 id 与事件绑定，
   重写等于把所有绑定再抄一遍，很容易漏。这里改成**按卡片标题把整块搬进对应页签**，
   并把"正在播放"卡片里的封面/歌名/进度/传输控件**迁移到固定底栏**（id 不变，
   所以原有监听全部继续有效）。
   ========================================================================== */
(function layoutShell() {
  // 卡片标题 → 页签。新增卡片只要在这里补一条即可。
  const TAB_OF_CARD = {
    '直播状态': 'queue',
    '点歌 / 检索': 'queue',
    '本地音乐': 'queue',
    '当前播放列表': 'queue',
    '队列': 'queue',              // 兼容旧标题
    '点歌设置': 'queue',

    '已播放': 'played',

    '已保存播放列表': 'saved',
    '已保存': 'saved',
    '闲时歌单': 'saved',
    '歌单导入（网易云）': 'saved',
    '歌单导入': 'saved',

    '黑名单': 'blacklist',
    '已拉黑列表': 'blacklist',

    '叠加层预览': 'more',
  };
  const TABS = ['queue', 'played', 'saved', 'blacklist', 'more'];

  function cardTitle(card) {
    const h = card.querySelector('h2');
    if (!h) return '';
    /**
     * 只取 h2 的**第一个文本节点**，不要 textContent。
     * 为什么：h2 里常挂一个由 JS 填字的计数 span（`已播放 <span id="histCount">`），
     * 而它什么时候被填上取决于异步取数的快慢 —— 用 textContent 的话，
     * 同一张卡在"填字前"和"填字后"算出两个不同标题，落到两个不同页签
     * （实测：段1 加了一个 <link> 就改变了时序，「已保存播放列表 共 190 首」
     * 从 saved 整块漏进 more，让「已保存」页签从 3 张卡变成 2 张）。
     * 取第一个文本节点 = 拿 HTML 里写死的那个标题，与取数时机无关。
     */
    const first = Array.prototype.find.call(h.childNodes, (n) => n.nodeType === 3);
    const text = first ? first.textContent : h.textContent;
    return (text || '').replace(/\s*[\d,]+.*$/, '').trim();
  }

  function build() {
    const main = document.querySelector('main');
    const aside = document.querySelector('aside');
    const nav = document.getElementById('tabs');
    if (!main || !nav) return;

    // 1) 建立五个页签容器
    const panels = {};
    for (const t of TABS) {
      const sec = document.createElement('section');
      sec.dataset.panel = t;
      if (t === 'queue') sec.classList.add('active');
      panels[t] = sec;
      main.appendChild(sec);
    }

    // 2) 把现有卡片按标题搬进对应页签；aside 里的也一并搬（统一成单列分页）
    const cards = [...document.querySelectorAll('main > .card, aside > .card')];
    for (const card of cards) {
      const title = cardTitle(card);
      const tab = TAB_OF_CARD[title] || 'more';
      panels[tab].appendChild(card);
    }
    // aside 空了就移除，免得占位
    if (aside && !aside.querySelector('.card')) aside.remove();

    // 3) 底栏控件**已经直接写在 HTML 里**（同一批 id），不再需要迁移。
    //    之前靠 JS 从「正在播放」卡片搬过来，那张卡片与底栏在同一屏里重复，
    //    所以改成"控件本来就属于底栏"、卡片删除。原来的迁移代码已移除。

    // 4) 页签切换
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      for (const b of nav.querySelectorAll('.tab')) b.classList.toggle('active', b === btn);
      for (const t of TABS) panels[t].classList.toggle('active', t === btn.dataset.tab);
      try { localStorage.setItem('nekofm.tab', btn.dataset.tab); } catch { /* 忽略 */ }
    });
    // 记住上次所在页签
    try {
      const last = localStorage.getItem('nekofm.tab');
      if (last && TABS.includes(last)) {
        const b = nav.querySelector(`.tab[data-tab="${last}"]`);
        if (b) b.click();
      }
    } catch { /* 忽略 */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();

/* ==========================================================================
   直播状态 / 列表页 / 点歌设置 / 缓存目录
   ---- 整块已搬到 /assets/ui/face-library.js（段2 第四刀），这里只剩接线。
   少挂一个 script 页面照样能开、只是这 6 张卡全没反应 —— 所以缺席必须响亮。
   ========================================================================== */
(function wireLibraryFace() {
  const libraryFace = (window.__nekofmFaces && typeof window.__nekofmFaces.library === 'function')
    ? window.__nekofmFaces.library({ toast: window.__nekofmToast, confirm: window.__nekofmConfirm })
    : null;
  if (libraryFace) return;
  const msg = '/assets/ui/face-library.js 没加载 —— 曲库面的列表、点歌设置、缓存目录按钮都会没反应';
  if (window.__nekofmToast) window.__nekofmToast(false, msg);
  else console.error(msg);
})();

