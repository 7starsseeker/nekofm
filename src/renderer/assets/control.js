/* ==========================================================================
   NekoFM 控制台逻辑
   与后端只通过 HTTP + SSE 通信，不依赖 Electron API，因此同一份页面
   既能在 Electron 里用，也能在普通浏览器里打开（headless 模式）。
   ========================================================================== */
'use strict';

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

  let config = null;
  let state = null;

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
  const strip = { el: null, prev: null, cur: null, trans: null, next: null, on: false, lastIdx: -2, lastCfgSig: null, raf: 0 };

  function onLyrics(m) {
    // 歌词是"大对象、低频变"（只在 rev 变化时推），收到就整体换掉
    if (m.rev === SNAP.rev) return;
    SNAP.rev = m.rev;
    SNAP.timeline = m.timeline || null;
    strip.lastIdx = -2;          // 强制重画
  }

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
      $('stRoom').textContent = `弹幕 房间 ${s.room.roomId}（${viaShort}）${suffix}`;
      $('stRoom').className = 'pill ' + (ls === 1 ? 'ok' : (ls == null ? 'ok' : ''));
      $('stRoom').title = ls === 1 ? '' : 'B站只在直播中推送弹幕。未开播/轮播时连接是正常的，但收不到弹幕（发点歌不会触发）；开播后会自动开始收。';

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
    $('qCount').textContent = s.queue ? `（待播 ${s.queue.total} 首）` : '';
    const ul = $('queue');
    const items = (s.queue && s.queue.items) || [];
    const cur = s.queue && s.queue.current;
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
      li.innerHTML = `<span class="idx">▶</span><span class="nm" title="${escapeHtml(cur.name)}">${escapeHtml(cur.name)}</span>`
        + `<span class="by">正在播放${cur.artistText ? ' · ' + escapeHtml(cur.artistText) : ''}</span>${owner}`;
      const keep = document.createElement('button');
      keep.textContent = '加入已保存';
      keep.title = '加入「已保存播放列表」，开播时作为闲时歌单';
      // 发 key 而不是 song：队列项的状态是精简版（`_brief`），**没有完整 song 对象** ——
      // 原来发 `cur.song`（undefined）于是"点了永远不生效"（2026-09-26 修）
      keep.onclick = async () => {
        const r = await api({ action: 'savedAdd', key: cur.key, uname: cur.uname });
        log((r.result && r.result.ok) ? 'info' : 'error',
          (r.result && r.result.ok) ? `已加入已保存播放列表：${r.result.name}` : ((r.result && r.result.msg) || '加入失败'));
      };
      li.appendChild(keep);
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
      li.appendChild(top);

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
      li.appendChild(blWrap);
      const blk = document.createElement('button');
      blk.textContent = '执行';
      blk.title = '按左边选的粒度加入黑名单，并把这首先从队列撤下';
      blk.onclick = async () => {
        const r = await api({ action: 'blacklistFromQueue', index: it.position, type: sel.value });
        if (r.ok) log('info', `已拉黑（${sel.options[sel.selectedIndex].textContent}）：${it.name}`);
      };
      li.appendChild(blk);

      // 加入已保存（闲时）列表 —— 队列里的好歌可以留到下一场
      const keep = document.createElement('button');
      keep.textContent = '加入已保存';
      keep.title = '加入「已保存播放列表」，开播时作为闲时歌单循环播放';
      // 同上：队列项没有 song 字段，要用 key 回查
      keep.onclick = async () => {
        const r = await api({ action: 'savedAdd', key: it.key });
        log((r.result && r.result.ok) ? 'info' : 'error',
          (r.result && r.result.ok) ? `已加入已保存播放列表：${r.result.name}` : ((r.result && r.result.msg) || '加入失败'));
        if (r.result && r.result.ok) window.__nekofmRefreshLists && window.__nekofmRefreshLists();
      };
      li.appendChild(keep);

      const rm = document.createElement('button');
      rm.textContent = '撤';
      rm.onclick = () => api({ action: 'remove', index: it.position });
      li.appendChild(rm);

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

    // 播放器：模式 / 静音 / 收藏 / 闲时 / 缓存
    if (s.player) {
      highlightMode(s.player.mode);
      $('btnMute').textContent = s.player.muted ? '🔇' : '🔊';
      $('btnFavorite').textContent = s.favorited ? '★ 已收藏' : '☆ 收藏';
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

  /**
   * 描边滑块的提示文案。
   *
   * 滑块的值是"**42px 字号时的等效像素**"，实际渲染换算成 `em`（占字号的比例）应用，
   * 上限 6% —— 每行按**自己的**字号算，所以原文行和更小的译文行占比一致。
   * 这里把换算结果直接写出来，用户不用猜。
   */
  function strokeHint(w, fontSize) {
    const want = Math.max(0, Number(w) || 0) / 42;
    const ratio = Math.min(want, 0.06);
    const capped = ratio < want - 0.0001;
    return `${Number(w) || 0}px → 描边占字号 ${(ratio * 100).toFixed(1)}%`
      + `${capped ? '（已触上限 6%）' : ''}`
      + ` · ${ratio <= 0.052 ? '清晰' : '偏粗，建议 2~2.5'}`;
  }

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

  // 三种预览窗各自独立，可以同时打开（对应直播姬里放几个浏览器源的几种摆法）
  on('btnPreviewLyrics', 'click', () => api({ action: 'showOverlayWindow', mode: 'lyrics' }));
  on('btnPreviewInfo', 'click', () => api({ action: 'showOverlayWindow', mode: 'info' }));
  on('btnPreviewBoth', 'click', () => api({ action: 'showOverlayWindow', mode: 'both' }));
  on('btnPreviewAll', 'click', async () => {
    const r = await api({ action: 'showOverlayWindow', mode: 'all' });
    if (r.ok) log('info', '三个预览窗已打开（歌词 / 信息卡片 / 整体），可同时对照');
  });
  on('btnOverlayHide', 'click', async () => {
    for (const mode of ['both', 'lyrics', 'info']) await api({ action: 'hideOverlayWindow', mode });
    log('info', '已关闭全部叠加层预览窗');
  });
  on('btnShowPlayer', 'click', () => api({ action: 'showPlayerWindow' }));
  on('btnClearQ', 'click', () => api({ action: 'clearQueue' }));
  const copyText = async (txt, what) => {
    try { await navigator.clipboard.writeText(txt); log('info', `${what}已复制：${txt}`); }
    catch { log('error', '复制失败，请手动选中复制'); }
  };
  on('copyAddr', 'click', () => copyText($('addr').textContent, '歌词叠加层地址'));
  on('copyAddrInfo', 'click', () => copyText($('addrInfo').textContent, '信息卡片地址'));
  on('copyAddrBoth', 'click', () => copyText(location.origin + '/overlay', '合并地址'));
  on('vol', 'input', () => {
    const v = Number($('vol').value);
    $('volTxt').textContent = v + '%';
    api({ action: 'setVolume', volume: v / 100 });
  });

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
  async function doImportPlaylist(autoQueue) {
    const input = $('plInput').value.trim();
    if (!input) return;
    const limit = Number($('plLimit').value) || 0;
    log('info', autoQueue ? '导入并整单入队中…' : '导入中…');
    const r = await api({ action: 'playlistImport', input, limit, autoQueue, filterBlacklist: true });
    const res = r.result || {};
    if (!res.ok) { log('error', '导入失败：' + (res.msg || r.error || '未知')); return; }
    const p = res.playlist || {};
    let msg = `《${p.name}》已导入 ${p.fetched} 首（歌单共 ${p.trackCount} 首）`;
    if (res.blockedCount) {
      msg += `；黑名单拦下 ${res.blockedCount} 首` + (res.blockedPreview && res.blockedPreview.length
        ? '：' + res.blockedPreview.map((b) => b.name).join(' / ') : '');
    }
    if (autoQueue) msg += `；已入队 ${res.queued} 首`;
    log('info', msg);
  }
  on('btnPlImport', 'click', () => doImportPlaylist(false));
  on('btnPlImportQueue', 'click', () => doImportPlaylist(true));
  on('plInput', 'keydown', (e) => { if (e.key === 'Enter') doImportPlaylist(false); });

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
      const b = document.createElement('button');
      b.textContent = '入队';
      b.onclick = () => api({ action: 'neteaseLoadPlaylist', id: p.id, limit: 50 });
      d.appendChild(b);
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

  // ---- 网易云扫码
  let qrTimer = null;
  on('btnQr', 'click', async () => {
    const r = await api({ action: 'neteaseQrCreate' });
    if (!r.ok || !r.result || !r.result.ok) { log('error', '二维码生成失败：' + ((r.result && r.result.msg) || r.error)); return; }
    const url = r.result.url;
    const box = $('qrBox');
    box.hidden = false;
    box.innerHTML = '';
    box.style.background = 'transparent';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.gap = '8px';
    box.style.width = 'auto';
    box.style.height = 'auto';

    /**
     * 2026-09-26 改：直接渲染**内联二维码图片**，不再让用户点外部链接。
     * 用公共服务 `api.qrserver.com` 把 URL 编码成 PNG，失败回退到「打开登录窗」
     * 按钮（用户可以去浏览器扫码）。**没有安装 qrcode npm 库** —— 保持
     * "零运行时第三方依赖"。codekey 是短时 token，发给第三方服务无隐私风险。
     */
    const img = document.createElement('img');
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=2&data=${encodeURIComponent(url)}`;
    img.alt = '网易云扫码登录二维码';
    img.style.cssText = 'width:200px;height:200px;background:#fff;padding:8px;border-radius:6px;display:block';
    img.onerror = () => {
      // 公共服务挂了时退回原方案（按钮 + URL）
      box.innerHTML = '';
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = '打开网易云登录页（扫码）';
      b.onclick = () => api({ action: 'openExternal', url });
      box.appendChild(b);
      const t = document.createElement('div');
      t.className = 'tip';
      t.style.cssText = 'word-break:break-all;max-width:320px';
      t.textContent = url;
      box.appendChild(t);
      log('warn', '二维码公共服务失败，已退回「打开登录窗」方式');
    };
    box.appendChild(img);
    const cap = document.createElement('div');
    cap.className = 'tip';
    cap.style.cssText = 'max-width:220px;text-align:center;margin-top:4px';
    cap.textContent = '手机端网易云 App 扫一扫 → 自动确认登录';
    box.appendChild(cap);

    $('qrStat').textContent = '等待扫码…';
    clearInterval(qrTimer);
    qrTimer = setInterval(async () => {
      const c = await api({ action: 'neteaseQrCheck', key: r.result.key });
      const res = c.result || {};
      if (res.ok) {
        clearInterval(qrTimer);
        $('qrStat').textContent = '✅ 登录成功：' + ((res.profile && res.profile.nickname) || '');
        box.hidden = true;
        log('info', '网易云登录成功，cookie 已保存');
        // 2026-09-26 补：刷新登录状态面板（pill + netStatus），否则用户看到的还是登出前的"未登录"
        // 走 checkNeteaseStatus(true)：拿到 cookie 后再做一次完整 neteaseStatus 调用，把 nickname/VIP 一并显示
        checkNeteaseStatus(true).catch(() => {});
      } else {
        $('qrStat').textContent = res.msg || ('等待中 (' + res.code + ')');
        if (res.code === 800) clearInterval(qrTimer);
      }
    }, 2000);
  });

  /**
   * 登出（2026-09-26 新增）：清掉 persistent partition 的所有 storage +
   * config 里的 cookie。下次扫码会用新账号。
   * 原来用户痛点：扫码登录过一次后，partition 持久化 → 再开登录窗直接是已登录态，
   * 没办法用新 cookie 登新号。
   */
  on('btnNetLogout', 'click', async () => {
    if (!confirm('登出当前网易云账号？\n\n会清掉：\n  · 浏览器会话的所有登录态\n  · 配置里的 cookie\n\n之后请重新扫码登录。')) return;
    log('info', '正在登出…');
    const r = await api({ action: 'neteaseBrowserLogout' });
    if (r && r.ok) {
      log('info', '已登出，可以重新扫码登新账号');
      checkNeteaseStatus(true);
    } else {
      log('error', '登出失败：' + ((r && r.msg) || '未知错误'));
    }
  });

  /** 核验网易云登录状态，并把结果**明确写出来**（昵称/VIP/失败原因） */
  async function checkNeteaseStatus(quiet = false) {
    const el = $('netStatus');
    if (!quiet) el.textContent = '正在核验…';
    const r = await api({ action: 'neteaseStatus' });
    const d = r.result || {};
    if (d.loggedIn && d.nickname) {
      $('stNet').dataset.verified = '1';
      el.textContent = `✅ 已登录：${d.nickname}（UID ${d.uid}）`
        + (d.vip ? (d.vipExpire ? ` · VIP 到期 ${d.vipExpire}` : ' · VIP 有效') : ' · 非会员（会员曲只能试听 45 秒）');
      $('stNet').textContent = '网易云 已登录';
      $('stNet').className = 'pill ok';
    } else if (d.loggedIn) {
      $('stNet').dataset.verified = '1';
      el.textContent = '⚠️ cookie 在，但账号信息取不到：' + (d.msg || '建议重新扫码登录');
      $('stNet').textContent = '网易云 登录异常';
      $('stNet').className = 'pill off';
    } else {
      $('stNet').dataset.verified = '1';
      el.textContent = '❌ 未登录：会员曲只能放 45 秒试听。扫码或点「打开登录窗」登录。';
      $('stNet').textContent = '网易云 未登录';
      $('stNet').className = 'pill off';
    }
    return d;
  }
  on('btnNetStatus', 'click', () => checkNeteaseStatus(false));

  on('btnBrowserLogin', 'click', async () => {
    log('info', '已打开登录窗，请在弹出的窗口里扫码登录…');
    $('qrStat').textContent = '等待登录窗完成…';
    const r = await api({ action: 'neteaseBrowserLogin' });
    const res = r.result || {};
    if (res.ok) {
      $('qrStat').textContent = '✅ 已登录（浏览器会话）';
      log('info', '网易云登录成功，cookie 已写入配置，会员曲可完整播放');
    } else {
      $('qrStat').textContent = res.msg || '未完成登录';
      log('error', '浏览器登录未完成：' + (res.msg || ''));
    }
  });

  on('btnCookie', 'click', async () => {
    const r = await api({ action: 'neteaseSetCookie', cookie: $('cookie').value.trim() });
    const res = r.result || {};
    log(res.loggedIn ? 'info' : 'error', res.loggedIn ? '登录成功：' + ((res.profile && res.profile.nickname) || '') : 'cookie 无效或未包含 MUSIC_U');
  });

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
    if (!confirm('登出 B站？\n\n会清掉本工具保存的 B站登录态（不影响你浏览器里的 B站登录）。\n之后视频歌词会回落到"按标题匹配网易云"。')) return;
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

  // ---- 播放设备
  /**
   * 设备下拉刷新。
   *
   * **2026-09-26 改：由轮询改为状态驱动。**
   * 原来 `setInterval(refreshDevices, 15000)` 每 15 秒发一次 `/api/state` ——
   * 明明这份数据已经在 10Hz 的 SSE 状态广播里了，再额外轮询纯属浪费一个
   * 周期性请求（浏览器对同一 host 只有 6 条连接，见 PROGRESS.md）。
   * 现在：主渲染循环发现 `state.playerDevices` / `player.deviceId` 变了就调这里。
   *
   * 另外加了**签名守卫**：设备清单没变就不重建 `<option>` ——
   * 重建会丢掉用户当前选中的项（表现成"选了别的设备过一会儿自己变回去"），
   * 而且会让展开中的原生下拉自己收起。
   *
   * @param {object} [s] 已有的状态对象；不传就自己拉一次（兼容旧调用点）
   */
  async function refreshDevices(s) {
    try {
      if (!s) s = await (await fetch('/api/state')).json();
      const list = (s && s.playerDevices) || [];
      const active = (s && s.player && s.player.deviceId) || '';
      const sel = $('device');
      // 内容没变就不重建（保住用户的选择，也避免打断下拉操作）
      const sig = list.map((d) => `${d.id}:${d.label}`).join('|');
      if (sel.dataset.sig === sig) {
        $('devHint').textContent = sel.value
          ? `当前：${sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : ''}`
          : '当前：系统默认';
        return;
      }
      sel.dataset.sig = sig;
      // **重建下拉时必须保留当前选择** ——
      // 原来这里每 15 秒重建一次并丢掉了选中项，界面上就表现为
      // "选了别的设备过一会儿自己变回系统默认"（其实只是显示被刷掉了）。
      const keep = sel.value || active;
      sel.innerHTML = '<option value="">系统默认</option>';
      list.forEach((d) => {
        const o = document.createElement('option');
        o.value = d.id; o.textContent = d.label || d.id.slice(0, 10);
        sel.appendChild(o);
      });
      sel.value = list.some((d) => d.id === keep) ? keep : active;
      $('devHint').textContent = sel.value
        ? `当前：${sel.selectedOptions[0].textContent}`
        : '当前：系统默认';
    } catch { /* 忽略 */ }
  }
  on('device', 'change', async () => {
    const label = $('device').selectedOptions[0] ? $('device').selectedOptions[0].textContent : '';
    await api({ action: 'setDevice', deviceId: $('device').value, deviceLabel: $('device').value ? label : '' });
    refreshDevices();
  });

  // ------------------------------------------------------------------ 叠加层表单
  function fillOverlayForm(o) {
    if (!o) return;
    // 老配置里可能是已下线的主题 → 映射到最接近的一项，否则 select 会落到空值
    const theme = THEME_MIGRATE[o.theme] || o.theme || 'scroll';
    $('oTheme').value = THEME_PRESETS[theme] ? theme : 'scroll';
    $('oSize').value = o.fontSize;
    $('oSizeTxt').textContent = o.fontSize + 'px';
    $('oOpacity').value = Math.round((o.opacity == null ? 1 : o.opacity) * 100);
    $('oOpTxt').textContent = $('oOpacity').value + '%';
    $('oBackdrop').value = Math.round((o.backdrop || 0) * 100);
    if (/^#[0-9a-f]{6}$/i.test(o.backdropColor || '')) $('oBdColor').value = o.backdropColor;
    $('oBdTxt').textContent = Number($('oBackdrop').value) === 0 ? '关' : $('oBackdrop').value + '%';
    if (/^#[0-9a-f]{6}$/i.test(o.color)) $('oColor').value = o.color;
    if (/^#[0-9a-f]{6}$/i.test(o.activeColor)) $('oActive').value = o.activeColor;
    if (/^#[0-9a-f]{6}$/i.test(o.strokeColor)) $('oStroke').value = o.strokeColor;
    $('oStrokeW').value = o.strokeWidth;
    $('oSwTxt').textContent = strokeHint(o.strokeWidth, o.fontSize);
    $('oOffset').value = o.offsetMs;
    $('oTrans').checked = !!o.showTranslation;
    $('oRoma').checked = !!o.showRoma;
    $('oCard').checked = !!o.showTrackCard;
    $('oScaleFont').checked = !!o.scaleFont;
    refreshBoxHint(o);
    fillInfoBarForm(o.infoBar);
  }

  /**
   * 按当前配置估算"**歌词块 / 信息卡片实际占多少像素**"，写进控制台，
   * 让用户在直播姬里照着填浏览器源的宽高 —— 这是"框贴合组件"的唯一可靠办法
   * （浏览器源的框就是页面视口，页面自己改不了它）。
   *
   * 估算依据：`.line` 行高是 `1.28 × 字号`；译文行约 `0.62em` 再加一点间距；
   * 末尾留约 12% 余量加上下 padding。宽度由画面宽度决定，所以只给高度建议。
   */
  function refreshBoxHint(o) {
    const el = $('oBoxHint');
    if (!el) return;
    const rows = o.showTranslation ? 2 : Math.max(1, 1 + (o.linesBefore | 0) + (o.linesAfter | 0));
    const h = Math.round(rows * (o.fontSize || 42) * 1.28 * 1.12 + 18);
    el.textContent = `💡 建议浏览器源尺寸（照着填进直播姬的宽高）：`
      + `歌词 → 画面宽 × ${h}px；信息卡片 → 320 × 92px。`
      + `（浏览器源的框就是页面视口，页面改不了它，所以按这个尺寸填框最贴合）`;
  }

  function collectOverlay() {
    return {
      theme: $('oTheme').value,
      fontSize: Number($('oSize').value),
      opacity: Number($('oOpacity').value) / 100,
      backdrop: Number($('oBackdrop').value) / 100,
      backdropColor: $('oBdColor').value,
      color: $('oColor').value,
      activeColor: $('oActive').value,
      strokeColor: $('oStroke').value,
      strokeWidth: Number($('oStrokeW').value),
      offsetMs: Number($('oOffset').value),
      showTranslation: $('oTrans').checked,
      showRoma: $('oRoma').checked,
      showTrackCard: $('oCard').checked,
      scaleFont: $('oScaleFont').checked,
    };
  }

  on('btnSaveOverlay', 'click', async () => {
    const r = await api({ action: 'setOverlay', overlay: collectOverlay() });
    if (r.ok) log('info', '叠加层设置已应用（立即生效，无需重开直播姬）');
  });

  /**
   * **主题 = 一套预设**（2026-09-26 改，用户报告"改成卡拉OK却依然是双语"）。
   *
   * 原来「主题」和「翻译 / 逐字 / 罗马音」是**两套独立开关** ——
   * 于是用户把主题选成「逐字卡拉OK」，只要「翻译」还勾着就**看起来仍是双语**，
   * 换了主题几乎看不出区别 → "改了没生效 / 还是双语"（用户原话）。
   *
   * 现在：选主题 → **立刻套用该主题的显示预设并即时生效**（不用再点保存）；
   * 三个勾选框成了"微调旋钮"，想给卡拉OK加翻译，再自己勾回来即可。
   *
   * 只两个主题（2026-09-26 用户定的）：
   *   scroll（单行滚动）→ 纯原文，当前行高亮
   *   dual  （双语）    → 双行 + 中文翻译
   *
   * 「逐字」不再绑主题：它由勾选框独立控制，所以"双语 + 逐字"依然可用。
   */
  const THEME_PRESETS = {
    scroll: { showTranslation: false, showRoma: false },   // 纯原文
    dual: { showTranslation: true, showRoma: false },      // 双语
  };
  /** 老配置里可能有已下线的主题（karaoke / desktop）→ 映射到最接近的一项 */
  const THEME_MIGRATE = { karaoke: 'scroll', desktop: 'dual' };
  on('oTheme', 'change', async () => {
    const sel = $('oTheme');
    const p = THEME_PRESETS[sel.value];
    if (!p) return;
    // 1) 同步勾选框，让界面**如实反映**当前这套预设
    $('oTrans').checked = p.showTranslation;
    $('oRoma').checked = p.showRoma;
    // 2) 立刻生效（主题选择是最直观的操作，不该还要求再点一次保存）
    const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : sel.value;
    const r = await api({ action: 'setOverlay', overlay: collectOverlay() });
    if (r.ok) {
      log('info', `主题已切到「${label}」并即时生效`
        + `（翻译${p.showTranslation ? '开' : '关'}）`
        + ' —— 想加翻译可以再单独勾选后点保存');
    }
  });
  ['oTheme', 'oSize', 'oOpacity', 'oColor', 'oActive', 'oStroke', 'oStrokeW', 'oBackdrop', 'oBdColor', 'oOffset', 'oTrans', 'oRoma', 'oCard', 'oScaleFont']
    .forEach((id) => {
      const e = $(id);
      if (!e) return;
      e.addEventListener('input', () => {
        $('oSizeTxt').textContent = $('oSize').value + 'px';
        $('oOpTxt').textContent = $('oOpacity').value + '%';
        $('oBdTxt').textContent = Number($('oBackdrop').value) === 0 ? '关' : $('oBackdrop').value + '%';
        $('oSwTxt').textContent = strokeHint($('oStrokeW').value, $('oSize').value);
      });
    });

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

  // ---- 播放器信息栏
  function fillInfoBarForm(b) {
    if (!b) return;
    $('ibEnabled').checked = !!b.enabled;
    $('ibPos').value = b.position || 'top-left';
    $('ibTheme').value = b.theme || 'card';
    $('ibScale').value = Math.round((b.scale == null ? 1 : b.scale) * 100);
    $('ibScaleTxt').textContent = $('ibScale').value + '%';
    $('ibOpacity').value = Math.round((b.opacity == null ? 1 : b.opacity) * 100);
    $('ibOpTxt').textContent = $('ibOpacity').value + '%';
    $('ibCoverSize').value = b.coverSize || 64;
    $('ibCoverTxt').textContent = $('ibCoverSize').value + 'px';
    if (/^#[0-9a-f]{6}$/i.test(b.accentColor || '')) $('ibAccent').value = b.accentColor;
    $('ibCover').checked = !!b.showCover;
    $('ibRequester').checked = !!b.showRequester;
    $('ibSource').checked = !!b.showSource;
    $('ibProgress').checked = !!b.showProgress;
    $('ibTime').checked = !!b.showTime;
    $('ibUpNext').checked = !!b.showUpNext;
    $('ibBiliStats').checked = !!b.showBiliStats;
    $('ibHideIdle').checked = !!b.hideWhenIdle;
  }

  function collectInfoBar() {
    return {
      enabled: $('ibEnabled').checked,
      position: $('ibPos').value,
      theme: $('ibTheme').value,
      scale: Number($('ibScale').value) / 100,
      opacity: Number($('ibOpacity').value) / 100,
      coverSize: Number($('ibCoverSize').value),
      accentColor: $('ibAccent').value,
      showCover: $('ibCover').checked,
      showRequester: $('ibRequester').checked,
      showSource: $('ibSource').checked,
      showProgress: $('ibProgress').checked,
      showTime: $('ibTime').checked,
      showUpNext: $('ibUpNext').checked,
      showBiliStats: $('ibBiliStats').checked,
      hideWhenIdle: $('ibHideIdle').checked,
    };
  }

  on('btnSaveInfoBar', 'click', async () => {
    const r = await api({ action: 'setOverlay', overlay: { infoBar: collectInfoBar() } });
    if (r.ok) log('info', '信息栏设置已应用（立即生效）');
  });
  ['ibScale', 'ibOpacity', 'ibCoverSize'].forEach((id) => {
    const e = $(id);
    if (e) e.addEventListener('input', () => {
      $('ibScaleTxt').textContent = $('ibScale').value + '%';
      $('ibOpTxt').textContent = $('ibOpacity').value + '%';
      $('ibCoverTxt').textContent = $('ibCoverSize').value + 'px';
    });
  });

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
  on('btnMute', 'click', async () => {
    const r = await api({ action: 'toggleMute' });
    if (r.ok) { $('btnMute').textContent = r.result.muted ? '🔇' : '🔊'; log('info', r.result.muted ? '已静音' : '已取消静音'); }
  });
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

  // 从各来源整批加入「已保存播放列表」——一视同仁
  const pullFrom = async (source, label) => {
    const r = await api({ action: 'savedPullFrom', source });
    const d = r.result || {};
    if (d.ok) { log('info', `已从「${label}」加入 ${d.added} 首${d.dup ? `（跳过重复 ${d.dup} 首）` : ''}，已保存共 ${d.count} 首`); refreshSaved(); }
    else log('error', d.msg || `从「${label}」加入失败`);
  };
  on('btnSavedFromFav', 'click', () => pullFrom('favorites', '我的收藏'));
  on('btnSavedFromLocal', 'click', () => pullFrom('local', '本地曲库'));
  on('btnSavedFromPl', 'click', () => pullFrom('playlist', '已导入歌单'));

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
  async function refreshCacheList() {
    const r = await api({ action: 'cacheStats' });
    const st = r.result;
    if (!st) return;
    fillCacheSummary({ enabled: st.enabled, count: st.count, mb: Number(((st.bytes || 0) / 1048576).toFixed(1)), maxMB: Math.round((st.maxBytes || 0) / 1048576) });
    const ul = $('cacheList');
    ul.innerHTML = '';
    const items = (st.recent || []).slice(0, 12);
    items.forEach((m) => {
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
        refreshCacheList();
      };
      li.appendChild(del);
      ul.appendChild(li);
    });
    if (!items.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="tip">还没有缓存条目</span>';
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
    if (!confirm('清空全部缓存？\n\n音频 + 歌词都会删掉。\n下次播放这些歌会重新从网络取（不受限流保护影响，但会慢一点）。')) return;
    const r = await api({ action: 'cacheClear' });
    if (r.ok) {
      log('info', `已清空缓存（音频 ${r.result.removed} 条${r.result.lyricsRemoved ? ` · 歌词 ${r.result.lyricsRemoved} 条` : ''}）`);
      refreshCacheList();
    }
  });
  // 只清歌词、保留音频：适合"歌词配错了想重新匹配"
  on('btnCacheClearLyrics', 'click', async () => {
    if (!confirm('只清歌词缓存？\n\n音频保留不动 —— 适合「歌词配错了想重新匹配」的场景。\n清完后播放时会重新联网匹配歌词。')) return;
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
    if (!confirm(`将清理 ${scan.count} 首不在「已保存播放列表」和「收藏」里的缓存（约 ${scan.mb} MB）。\n\n`
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
    if (!confirm(`批量缓存「${label}」里的在线曲目？\n\n· 后台串行下载，不影响当前播放\n· 已缓存过的会自动跳过\n· 本地曲目不需要缓存`)) return;
    const r = await api({ action: 'cachePrefetch', source });
    const d = (r && r.result) || {};
    if (d.ok) log('info', `已开始批量缓存「${label}」（共 ${d.total} 首）`);
    else log('error', d.msg || '批量缓存启动失败');
  };
  on('btnCachePrefetchSaved', 'click', () => prefetch('saved', '已保存播放列表'));
  on('btnCachePrefetchHist', 'click', () => prefetch('history', '已播放'));

  // ------------------------------------------------------------------ 测试中心
  let tcGroups = [];

  const tcMark = (ok) => (ok === true ? '✅' : ok === null ? '⏭️' : '❌');

  function renderTcResults(res) {
    const box = $('tcResults');
    box.innerHTML = '';
    if (!res || !res.results) return;
    let lastGroup = null;
    res.results.forEach((r) => {
      if (r.groupName !== lastGroup) {
        lastGroup = r.groupName;
        const h = document.createElement('div');
        h.innerHTML = `<b>${escapeHtml(r.groupName)}</b>`;
        h.style.marginTop = '6px';
        box.appendChild(h);
      }
      const d = document.createElement('div');
      d.className = r.ok === false ? 'error' : (r.ok === null ? 'info' : '');
      d.textContent = `${tcMark(r.ok)} ${r.name}${r.detail ? ' → ' + r.detail : ''}${r.ms ? ` (${r.ms}ms)` : ''}`;
      box.appendChild(d);
    });
    $('tcSummary').textContent = `通过 ${res.passed} / 失败 ${res.failed} / 跳过 ${res.skipped}（共 ${res.total}，${res.ms}ms）`;
  }

  async function runTests(groups) {
    const includeNetwork = $('tcNet').checked;
    $('tcSummary').textContent = '运行中…';
    log('info', `开始自检${includeNetwork ? '（含联网项）' : ''}…`);
    const r = await api({ action: 'runTests', groups: groups || null, includeNetwork });
    const res = r.result;
    if (!res) { log('error', '自检未返回结果'); return; }
    renderTcResults(res);
    log(res.failed ? 'error' : 'info', `自检完成：通过 ${res.passed} / 失败 ${res.failed} / 跳过 ${res.skipped}`);
  }

  on('tcRunAll', 'click', () => runTests(null));

  async function loadTestGroups() {
    const r = await api({ action: 'testList' });
    tcGroups = (r.result && r.result.groups) || [];
    const box = $('tcGroups');
    box.innerHTML = '';
    tcGroups.forEach((g) => {
      const b = document.createElement('button');
      const netOnly = g.checks.every((c) => c.net);
      b.textContent = `${g.name}（${g.checks.length}）${netOnly ? '·需联网' : ''}`;
      b.title = g.desc || '';
      b.onclick = () => runTests([g.id]);
      box.appendChild(b);
    });
  }

  // ------------------------------------------------------------------ 演练 / 注入
  let demoTimer = null;
  on('btnDemoStart', 'click', async () => {
    const r = await api({ action: 'demoStart', seconds: 120 });
    const res = r.result || {};
    if (res.ok) {
      $('demoStat').textContent = `演示中（${res.seconds}s，${res.lines} 行歌词）`;
      log('info', '演示模式已开启 —— 叠加层现在应显示歌词与信息栏');
      clearInterval(demoTimer);
      demoTimer = setInterval(async () => {
        const s = await api({ action: 'demoStatus' });
        if (!(s.result && s.result.running)) { clearInterval(demoTimer); $('demoStat').textContent = '已结束'; }
      }, 3000);
    } else log('error', '演示启动失败：' + (res.msg || ''));
  });
  on('btnDemoStop', 'click', async () => {
    await api({ action: 'demoStop' });
    clearInterval(demoTimer);
    $('demoStat').textContent = '已结束';
  });
  on('btnInject', 'click', async () => {
    const text = $('injText').value.trim();
    if (!text) return;
    const r = await api({ action: 'injectDanmaku', text, uname: '测试观众', isAdmin: $('injAdmin').checked });
    const res = r.result || {};
    if (res.ok) log('info', '已注入弹幕：' + text + (res.notices && res.notices[0] ? ' → ' + res.notices[0] : ''));
    else log('error', '注入失败：' + (res.msg || ''));
    $('injText').value = '';
  });
  on('injText', 'keydown', (e) => { if (e.key === 'Enter') $('btnInject').click(); });

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

    const tl = SNAP.timeline;
    if (!tl || !(tl.lines || []).length) {
      // 没歌词：把**原因**写出来，而不是干挂一个"♪"
      // （"被限流"和"这首歌本来就没词"是两回事，用户需要分得清）
      const why = SNAP.hasLyric ? '' : (SNAP.diag && SNAP.diag.reason) || '';
      const txt = why
        ? (/操作频繁|请稍候|频繁/.test(why) ? '歌词被网易云限流，稍后自动重试' : '无歌词：' + why)
        : (state && state.track ? '♪ 这首歌没有歌词' : '♪ 未在播放');
      if (strip.lastIdx !== -3 || strip.cur._why !== txt) {
        strip.lastIdx = -3;
        strip.cur._why = txt;
        strip.cur.className = 'ls-line ls-cur ls-plain ls-none';
        strip.cur.textContent = txt;
        strip.prev.textContent = '';
        strip.next.textContent = '';
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
      if (strip.lastIdx !== -1) {
        strip.lastIdx = -1;
        strip.cur.className = 'ls-line ls-cur ls-plain ls-none';
        strip.cur.textContent = '♪ 前奏…';
        strip.prev.textContent = '';
        strip.next.textContent = (tl.lines[0] && tl.lines[0].text) || '';
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
    if (at.index !== strip.lastIdx || cfgSig !== strip.lastCfgSig) {
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
    st.setProperty('--ls-opacity', String(ov.opacity == null ? 1 : ov.opacity));
    const sw = Number(ov.strokeWidth) || 0;
    st.setProperty('--ls-stroke', sw > 0
      ? `0 1px ${Math.max(1, Math.round(sw / 2))}px ${ov.strokeColor || '#000'}`
      : 'none');
    st.textAlign = ov.align || 'center';
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
        log('error', `检测到页面被注入了 ${foreign.length} 个**非本机脚本**（${list}）——`
          + '通常是过滤软件（如 AdGuard）注入了 userscript。'
          + '它会阻塞页面解析、让界面和图片显示不出来。'
          + '请在过滤软件里把「127.0.0.1」或本程序加入**白名单/不做过滤**。');
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
      if (config.netease.cookie) $('cookie').placeholder = '已配置（留空则不变）';
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
    loadTestGroups();
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
    return (h.textContent || '').replace(/\s*[\d,]+.*$/, '').trim();
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
   ========================================================================== */
(function newPanels() {
  const $id = (i) => document.getElementById(i);
  const call = (body) => fetch('/api/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({}));

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /**
   * 给一行挂上**统一的管理按钮**：缓存 / 加入已保存 / 拉黑 / 删除。
   * 当前播放列表、已播放、已保存三处共用这套，行为一致，用户不用分别记。
   */
  function addItemActions(li, it, kind, onChanged) {
    const mk = (text, title, fn, cls) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.title = title;
      if (cls) b.className = cls;
      b.onclick = fn;
      return b;
    };

    /**
     * 缓存按钮（2026-09-26）。
     * 状态由服务端在返回列表时一并算好（`it.cache`），不额外发请求。
     *   · 未缓存 → 「缓存」，点一下**立刻**下载音频 + 匹配歌词（用户主动点的，可以等）
     *   · 已缓存 → 「已缓存 ✓」，点一下删除该曲缓存（音频 + 歌词）
     * 本地曲目没有"缓存"概念，直接不显示这个按钮。
     */
    const cache = it.cache;
    const isLocal = it.source === 'local' || (it.song && it.song.source === 'local');
    if (cache && !isLocal) {
      const hasAudio = cache.audio && cache.audio.cached;
      const hasLyric = cache.lyrics && cache.lyrics.cached;
      const full = hasAudio && hasLyric;
      const tip = full
        ? `已缓存：音频 ${cache.audio.mb}MB + 歌词 ${cache.lyrics.lines} 行 —— 点一下删除`
        : `点一下立刻缓存（音频${hasAudio ? '已有' : '待下'}${hasLyric ? ' / 歌词已有' : ' / 歌词待匹配'}）`;
      const b = mk(full ? '已缓存 ✓' : (hasAudio || hasLyric ? '补缓存' : '缓存'), tip, async () => {
        if (full) {
          if (!confirm(`删除《${it.name || ''}》的缓存？\n\n音频 ${cache.audio.mb}MB 会被删掉，下次播放要重新联网取。`)) return;
          const r = await call({ action: 'cacheSongDrop', song: it.song });
          const d = (r && r.result) || {};
          if (d.ok) toast(true, `已删除缓存（音频 ${d.audio && d.audio.ok ? '✓' : '未删'}，歌词 ${d.lyrics && d.lyrics.ok ? '✓' : '未删'}）`);
          else toast(false, (d.audio && d.audio.msg) || '删除失败');
        } else {
          b.textContent = '缓存中…';
          b.disabled = true;
          const r = await call({ action: 'cacheSongFetch', song: it.song });
          const d = (r && r.result) || {};
          const parts = [];
          if (d.audio && d.audio.ok && d.audio.skipped !== 'already') parts.push(`音频 ${((d.audio.size || 0) / 1048576).toFixed(1)}MB`);
          if (d.lyrics && d.lyrics.ok && d.lyrics.skipped !== 'already') parts.push('歌词');
          toast(parts.length > 0, parts.length ? `已缓存：${parts.join(' + ')}`
            : `没有新增内容（音频：${(d.audio && (d.audio.msg || d.audio.skipped)) || '?'}；歌词：${(d.lyrics && (d.lyrics.msg || d.lyrics.skipped)) || '?'}）`);
        }
        onChanged && onChanged();
      });
      if (full) b.style.borderColor = '#2c8a4b';
      li.appendChild(b);
    }
    // 拉黑：三种粒度（歌曲 / 关键词 / 歌手）——"听到不合适，连歌手一起拉黑"很常用
    const sel = document.createElement('select');
    sel.style.cssText = 'padding:1px 4px;font-size:12px';
    for (const [v, t] of [['song', '歌曲'], ['keyword', '关键词'], ['artist', '歌手'], ['bvid', 'BV号']]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      sel.appendChild(o);
    }
    sel.value = (it.source === 'bilibili') ? 'bvid' : 'song';

    li.appendChild(mk('加入已保存', '加入「已保存播放列表」，开播时作为闲时歌单循环播放', async () => {
      const r = await call({ action: 'savedAdd', song: it.song, uname: it.uname });
      toast(!!(r.result && r.result.ok), (r.result && r.result.ok) ? `已加入已保存播放列表：${r.result.name}` : ((r.result && r.result.msg) || '加入失败'));
      onChanged && onChanged();
    }));
    li.appendChild(sel);
    li.appendChild(mk('拉黑', '按所选粒度加入黑名单', async () => {
      const r = await call({ action: 'blacklistSong', song: it.song, type: sel.value });
      if (r.result && r.result.ok) onChanged && onChanged();
      else toast(false, (r.result && r.result.msg) || '拉黑失败');
    }));
    li.appendChild(mk('删除', kind === 'queue' ? '从当前播放列表移除' : (kind === 'history' ? '从已播放记录移除' : '从已保存列表移除'), async () => {
      const act = kind === 'queue' ? 'remove' : (kind === 'history' ? 'historyRemove' : 'savedRemove');
      await call({ action: act, index: it.__index });
      onChanged && onChanged();
    }, 'ghost'));
    return li;
  }

  /** 渲染一个曲目列表（已播放 / 已保存共用） */
  function kindOf(ul) { return ul && ul.id === 'histList' ? 'history' : 'saved'; }
  function onChangedOf(ul) { return ul && ul.id === 'histList' ? refreshHistory : refreshSaved; }
  function renderList(ul, items, emptyText, extra) {
    if (!ul) return;
    ul.innerHTML = '';
    if (!items || !items.length) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="tip">${esc(emptyText)}</span>`;
      ul.appendChild(li);
      return;
    }
    items.forEach((it, i) => {
      const li = document.createElement('li');
      /**
       * 缓存角标（2026-09-26）：服务端在返回列表时已经算好 `it.cache`，
       * 这里只是画出来 —— 用户一眼能看出哪些歌已经能离线播。
       *   · 音频 + 歌词都有 → 绿色「已缓存」
       *   · 只有一个     → 灰色「半缓存」
       */
      let badge = '';
      const c = it.cache;
      if (c && !(it.source === 'local' || (it.song && it.song.source === 'local'))) {
        const a = c.audio && c.audio.cached;
        const l = c.lyrics && c.lyrics.cached;
        if (a && l) badge = `<span class="cache-badge ok" title="音频 ${c.audio.mb}MB + 歌词 ${c.lyrics.lines} 行，已能离线播放">已缓存</span>`;
        else if (a || l) badge = `<span class="cache-badge half" title="${a ? `音频已缓存 ${c.audio.mb}MB` : '歌词已缓存'}，另一半还缺">半缓存</span>`;
        else badge = '<span class="cache-badge none" title="还没有缓存，播放时要联网取">未缓存</span>';
      }
      li.innerHTML = `<span class="idx">${i + 1}</span><span class="nm" title="${esc(it.name)}">${esc(it.name || '—')}</span>`
        + badge
        + `<span class="by">${esc(it.artistText || '')}</span>`
        + (it.uname ? `<span class="by">${esc(it.uname)}</span>` : '');
      ul.appendChild(li);
      it.__index = i + 1;
      if (extra) extra(li, it);
      if (it.song) {
        // 已保存列表：可以直接从这一首开始播（当作整张歌单的起点）
        if (ul.id === 'savedList') {
          const play = document.createElement('button');
          play.textContent = '播放';
          play.title = '从这一首开始播放「已保存播放列表」';
          play.onclick = async () => {
            const r = await call({ action: 'playSaved', from: it.__index });
            const d = r.result || {};
            if (!d.ok) toast(false, d.msg || '播放失败');
          };
          li.appendChild(play);
        }
        addItemActions(li, it, kindOf(ul), onChangedOf(ul));
      }
    });
  }

  async function refreshHistory() {
    const r = await call({ action: 'listHistory', limit: 200 });
    const items = (r.result && r.result.items) || [];
    $id('histCount').textContent = items.length ? `共 ${items.length} 首` : '';
    renderList($id('histList'), items, '还没有播完的曲目。', (li, it) => {
      const b = document.createElement('button');
      b.textContent = '再来一次';
      b.onclick = async () => {
        // 显式动作：直接点**这一首**（带 force 越过"刚放过"的去重），
        // 而不是拿歌名重新搜一遍 —— 搜索既慢又可能配错（实测被反馈）
        const r = await call({ action: 'order', song: it.song, force: true });
        const d = (r && r.result) || {};
        if (!d.ok) toast(false, d.msg || '无法播放这首');
        refreshHistory();
      };
      li.appendChild(b);
    });
  }

  async function refreshSaved() {
    const r = await call({ action: 'listSaved' });
    const items = (r.result && r.result.items) || [];
    $id('savedCount').textContent = items.length ? `共 ${items.length} 首` : '（空）';
    // 注意：下播**不再**自动往这里写（用户明确要手动维护），所以空态文案别提"点下播"
    renderList($id('savedList'), items, '还没有已保存的曲目 —— 在任意列表项上点「加入已保存」，或用下面的来源按钮整批加入。');
  }

  // ------------------------------------------------------------------ 直播状态
  /** 只有两种状态：直播中 / 未直播。切换本身即动作（切到未直播会保存当前列表）。 */
  function paintLive(streaming, savedCount) {
    const on = !!streaming;
    const n = savedCount || 0;
    for (const [pill, btn] of [['livePill', 'btnToggleLive']]) {
      const p = $id(pill); const b = $id(btn);
      if (p) { p.textContent = on ? '直播中' : '未直播'; p.className = 'pill ' + (on ? 'ok' : 'off'); }
      if (b) b.textContent = on ? '结束直播' : '开始直播';
    }
    // 直播中：已保存歌单固定作为闲时歌单 → 屏蔽"单独播放"
    const pb = $id('btnPlaySaved');
    if (pb) {
      pb.disabled = on;
      pb.title = on ? '直播中：「已保存播放列表」固定作为闲时歌单（当前列表放空后自动接着放）' : '未直播：把它当本地歌单直接播放';
    }
    const hint = $id('playSavedHint');
    if (hint) {
      hint.textContent = on
        ? '直播中：它作为闲时歌单自动接着放，不能单独播放'
        : '未直播时可直接播放';
    }
    if ($id('liveStat')) {
      $id('liveStat').textContent = on
        ? `正在直播 · 已保存 ${n} 首作为闲时歌单`
        : `未直播 · 已保存 ${n} 首`;
    }
    liveTouched = true;
  }
  let liveTouched = false;

  async function setLive(on) {
    const r = await call({ action: 'setStreaming', on });
    const d = r.result || {};
    paintLive(d.streaming != null ? d.streaming : on, d.saved);
    refreshSaved();
  }
  if ($id('btnToggleLive')) $id('btnToggleLive').onclick = async () => {
    const st = await (await fetch('/api/state')).json();
    setLive(!st.streaming);
  };
  // 直播状态开关只保留「直播状态」卡片里那一个（底栏不再重复）
  window.__nekofmPaintLive = paintLive;

  if ($id('btnClearHist')) $id('btnClearHist').onclick = async () => { await call({ action: 'clearHistory' }); refreshHistory(); };
  // 待机时把已保存歌单当本地歌单直接播放
  if ($id('btnPlaySaved')) $id('btnPlaySaved').onclick = async () => {
    const btn = $id('btnPlaySaved');
    const r = await call({ action: 'playSaved' });
    const d = r.result || {};
    // 失败原因由命令层**同步**返回（直播中 / 列表为空），所以这里能如实提示；
    // 以前它走"立刻回执"，这些失败全被吞掉，界面只会闪一下然后什么都没发生。
    if (!d.ok) { toast(false, d.msg || '播放失败'); return; }
    /**
     * from = 命令层同步给出的「用户点的行号」（点整张歌单时是 0，表示没指定行），
     * total = 列表长度。真实落点可能是别的行（那一行被拉黑就顺延），由引擎 notify 汇报，
     * 所以这里**只说能确定的事**：没指定行就只说总数，全都拿不到就退回中性文案 ——
     * 绝不把 `undefined` 印到按钮上。
     */
    const total = Number.isFinite(d.total) && d.total > 0 ? d.total : 0;
    const from = Number.isFinite(d.from) && d.from > 0 ? d.from : 0;
    btn.textContent = total
      ? (from ? `正在播放（第 ${from}/${total} 首）` : `已开始播放（共 ${total} 首）`)
      : '已开始播放';
    setTimeout(() => { btn.textContent = '播放已保存歌单'; }, 2500);
  };

  if ($id('btnClearSaved')) $id('btnClearSaved').onclick = async () => { await call({ action: 'clearSaved' }); refreshSaved(); };
  if ($id('btnQueueSaved')) $id('btnQueueSaved').onclick = async () => {
    const r = await call({ action: 'queueSaved' });
    toast(!!(r.result && r.result.ok), (r.result && r.result.ok) ? `已排入 ${r.result.queued} 首` : ((r.result && r.result.msg) || '没有已保存的列表'));
  };

  // ------------------------------------------------------------------ 点歌设置
  async function loadQueueCfg() {
    const cfg = await (await fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'getConfig' }),
    })).json().catch(() => null);
    const q = cfg && cfg.result && cfg.result.config && cfg.result.config.queue;
    if (!q) return;
    $id('cfgPerUser').value = q.perUserMax;
    $id('cfgCooldown').value = Math.round((q.cooldownMs || 0) / 1000);
    $id('cfgMaxSize').value = q.maxSize;
    $id('cfgAllowDup').checked = !!q.allowDuplicate;
    $id('cfgOwnSkip').checked = !(q.danmakuSkip && q.danmakuSkip.ownOnly === false);
  }
  if ($id('btnSaveQueueCfg')) $id('btnSaveQueueCfg').onclick = async () => {
    await call({
      action: 'setConfig',
      patch: {
        queue: {
          perUserMax: Number($id('cfgPerUser').value) || 2,
          cooldownMs: (Number($id('cfgCooldown').value) || 0) * 1000,
          maxSize: Number($id('cfgMaxSize').value) || 50,
          allowDuplicate: $id('cfgAllowDup').checked,
          danmakuSkip: { ownOnly: $id('cfgOwnSkip').checked },
        },
      },
    });
    $id('btnSaveQueueCfg').textContent = '已保存 ✓';
    setTimeout(() => { $id('btnSaveQueueCfg').textContent = '保存点歌设置'; }, 1500);
  };

  // ------------------------------------------------------------------ 缓存目录
  async function loadCacheDir() {
    const r = await call({ action: 'cacheDirInfo' });
    const d = r.result || {};
    $id('cacheDir').value = d.configured || '';
    $id('cacheDirNow').textContent = `当前目录：${d.dir || '—'}`;
  }
  if ($id('btnSaveCacheDir')) $id('btnSaveCacheDir').onclick = async () => {
    const r = await call({ action: 'setCacheDir', dir: $id('cacheDir').value.trim() });
    const d = r.result || {};
    toast(!!d.ok, d.ok ? `缓存目录已切到：${d.dir}` : (d.msg || '切换失败'));
    loadCacheDir();
  };
  if ($id('btnPickCacheDir')) $id('btnPickCacheDir').onclick = async () => {
    // 借"打开文件夹"的原生对话框，只是拿路径，不改曲库
    const r = await call({ action: 'localOpenFolder' });
    const d = r.result || {};
    const dir = d.results && d.results[0] && d.results[0].dir;
    if (dir) { $id('cacheDir').value = dir.replace(/[\\/]+$/, '') + '\\cache'; }
  };

  // ------------------------------------------------------------------ 启动
  window.__nekofmRefreshLists = () => { refreshHistory(); refreshSaved(); };
  loadQueueCfg();
  loadCacheDir();
  refreshHistory();
  refreshSaved();
  /**
   * 列表刷新改为**变化驱动**（见 control.js 里 renderState 的说明）：
   * 计数一变，主渲染循环就调下面这两个钩子。
   * 这里额外挂一个"切到该页签时刷一次"，保证切回去看到的一定是最新的。
   */
  window.__nekofmSyncHistory = refreshHistory;
  window.__nekofmSyncSaved = refreshSaved;
  (function refreshOnTabShow() {
    const nav = document.getElementById('tabs');
    if (!nav) return;
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      const t = btn.dataset.tab;
      if (t === 'played') refreshHistory();
      else if (t === 'saved') refreshSaved();
    });
  })();
})();
