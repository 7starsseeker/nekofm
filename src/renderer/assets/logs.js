/**
 * 「运行日志 / 状态」窗口
 * =======================
 * 打包成 exe 后没有控制台 —— 这个窗口是用户唯一能自查的地方（见 src/main/logbus.js）。
 *
 * 数据来源两条（都走已经存在的 SSE，不额外加轮询）：
 *   · `/events?logs=1` 的 `type:'log'` 消息 → 实时日志行（服务端只推给带 logs=1 的连接）
 *   · 同一连接里的 `type:'state'` 消息 → 顶部那排状态（播放/曲目/队列/弹幕/网易云/缓存）
 * 打开时先用 `/api/logs` 回填历史，再用 `afterSeq` 续传 —— 断线重连不会把整屏重刷。
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const linesEl = $('lines');
  const mainEl = $('main');
  const MAX_ROWS = 3000;          // DOM 上限：超了就丢最老的（日志是流，不是档案）
  let lastSeq = 0;
  let paused = false;             // 用户往上翻/点了暂停 → 不再自动滚到底
  let errOnly = false;
  let filter = '';
  let total = 0;
  let esRetry = 0;

  const fmtTime = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) + '.' +
    String(new Date(ms).getMilliseconds()).padStart(3, '0');

  function match(level, text) {
    if (errOnly && level !== 'warn' && level !== 'error') return false;
    if (filter && !text.toLowerCase().includes(filter)) return false;
    return true;
  }

  /** 加一行到列表尾部（并维护 DOM 上限与自动滚动） */
  function addLine(line) {
    total++;
    $('pCount').textContent = total + ' 条';
    const hit = filter && String(line.text).toLowerCase().includes(filter);
    if (!match(line.level, String(line.text).toLowerCase())) return;
    const li = document.createElement('li');
    if (line.level === 'warn' || line.level === 'error') li.className = line.level;
    if (hit) li.classList.add('hit');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtTime(line.at || Date.now());
    li.appendChild(t);
    li.appendChild(document.createTextNode(line.text == null ? '' : String(line.text)));
    const nearBottom = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight < 40;
    linesEl.appendChild(li);
    while (linesEl.childElementCount > MAX_ROWS) linesEl.firstElementChild.remove();
    if (!paused && nearBottom) mainEl.scrollTop = mainEl.scrollHeight;
  }

  /** 重画（改过滤条件时用）：把已有行按新条件重新筛一遍 */
  function redraw(all) {
    linesEl.innerHTML = '';
    for (const line of all) addLine(line);
  }

  /**
   * 回填历史。
   *   · 首次（afterSeq=0）：取最近 500 条，**整屏重画**
   *   · 续传（afterSeq>0）：只把新增的**返回给调用方**，绝不碰已有列表
   *     ——踩过的坑：SSE 一连上就发 `hello`，于是"回填 + hello 续传"会连着跑两次；
   *     续传那次因为"没有新增"返回空数组，却仍然走了重画分支，
   *     结果把刚回填好的历史**整屏清空**（页面只剩 hello 之后那一行）。
   */
  async function backfill(afterSeq) {
    try {
      const q = afterSeq > 0 ? `?afterSeq=${afterSeq}` : '?limit=500';
      const r = await (await fetch('/api/logs' + q)).json();
      if (!r || !Array.isArray(r.lines)) return [];
      // 落盘路径由接口给出（"把日志发给别人"时用户得知道文件在哪）
      if (r.file) { $('stLogFile').textContent = r.file; $('stLogFile').title = r.file; }
      else if ($('stLogFile').textContent.startsWith('（')) $('stLogFile').textContent = '未落盘（命令行模式）';
      if (afterSeq > 0) return r.lines;          // 续传：交回新增行，由调用方追加
      redraw(r.lines);                            // 首次：整屏回填
      total = r.lines.length;
      $('pCount').textContent = total + ' 条';
      lastSeq = r.seq || 0;
      mainEl.scrollTop = mainEl.scrollHeight;
    } catch { /* 服务端刚起/正重启，SSE 会补上 */ }
    return [];
  }

  // ---------------------------------------------------------------- 状态面板
  function paintStatus(s) {
    if (!s) return;
    const pb = s.playback || {};
    $('stPlayback').textContent = (pb.status || 'idle') +
      (pb.position || pb.duration ? ` ${fmtSec(pb.position)}/${fmtSec(pb.duration)}` : '');
    $('stTrack').textContent = s.track ? (s.track.name || s.track.title || '—') : '（无）';
    const q = (s.counts && s.counts.queue) || 0;
    $('stQueue').textContent = `${q} 首` + (s.nowPlaying ? '（正在播 1）' : '');
    if (s.room) {
      const ls = s.room.liveStatus;
      const via = s.room.via === 'openlive' ? '开放平台' : (s.room.via === 'browser' ? '浏览器' : '直连');
      const a = s.room.anchor || {};
      $('stRoom').textContent = `房间 ${s.room.roomId}（${via}）` +
        (ls === 1 ? '直播中' : ls === 2 ? '轮播' : ls == null ? '?' : '未开播') +
        (a.uid ? ` · 主播 ${a.name || a.uid}` : '');
      $('stRoom').className = ls === 1 ? 'kv' : 'kv';
    } else {
      $('stRoom').textContent = '未连接';
    }
    const ne = s.netease || {};
    $('stNetease').textContent = (ne.loggedIn ? '已登录' : '未登录') + (ne.coolLeft ? ` · 限流冷却 ${ne.coolLeft}s` : '');
    const c = s.cache || {};
    $('stCache').textContent = c.enabled ? `${c.count || 0} 条 / ${c.mb || 0}MB` : '已关闭';
  }
  const fmtSec = (v) => {
    const s = Math.max(0, Math.floor(Number(v) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  // ---------------------------------------------------------------- SSE
  function connect() {
    const es = new EventSource('/events?logs=1');
    es.onopen = () => {
      esRetry = 0;
      $('pConn').textContent = '已连接';
      $('pConn').className = 'pill ok';
    };
    es.onmessage = async (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'log') {
        if (m.seq && m.seq <= lastSeq) return;      // 续传去重
        if (m.seq) lastSeq = m.seq;
        addLine(m);
        return;
      }
      if (m.type === 'state') { paintStatus(m); return; }
      if (m.type === 'hello') {
        // 重连后把断线期间漏掉的日志补回来（只取 seq 更新的那批）
        const missed = await backfill(lastSeq);
        for (const l of missed) { if (l.seq > lastSeq) lastSeq = l.seq; addLine(l); }
        return;
      }
    };
    es.onerror = () => {
      try { es.close(); } catch { /* 忽略 */ }
      $('pConn').textContent = '已断开，重连中…';
      $('pConn').className = 'pill err';
      // 退避重连：绝不让快速重连把连接池堆满（与 control.js 同一套做法）
      const delay = Math.min(1000 * 2 ** esRetry, 15000);
      esRetry++;
      setTimeout(connect, delay);
    };
  }

  // ---------------------------------------------------------------- 交互
  $('filter').addEventListener('input', () => { filter = $('filter').value.trim().toLowerCase(); });
  $('btnErrOnly').addEventListener('click', () => {
    errOnly = !errOnly;
    $('btnErrOnly').classList.toggle('on', errOnly);
    // 过滤只作用于"以后的行"太反直觉（用户点了按钮却什么都没变），
    // 所以直接清屏重来 —— 服务端缓冲还在，回填一次即可
    linesEl.innerHTML = '';
    total = 0;
    backfill(0);
  });
  $('btnPause').addEventListener('click', () => {
    paused = !paused;
    $('btnPause').classList.toggle('on', paused);
    $('btnPause').textContent = paused ? '继续滚动' : '暂停滚动';
    if (!paused) mainEl.scrollTop = mainEl.scrollHeight;
  });
  $('btnClear').addEventListener('click', () => {
    linesEl.innerHTML = '';
    total = 0;
    $('pCount').textContent = '0 条';
  });
  $('btnCopy').addEventListener('click', async () => {
    const text = [...linesEl.children].map((li) => li.textContent).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      $('btnCopy').textContent = '已复制 ✓';
    } catch {
      // 剪贴板被拒（无焦点窗口等）→ 退回到"选中让用户自己复制"
      const r = document.createRange();
      r.selectNodeContents(linesEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      $('btnCopy').textContent = '已选中，Ctrl+C';
    }
    setTimeout(() => { $('btnCopy').textContent = '复制全部'; }, 2000);
  });
  // 用户手动往上滚 → 自动暂停跟随（否则新日志会把他弹回底部）
  mainEl.addEventListener('scroll', () => {
    if (paused) return;
    const nearBottom = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight < 40;
    $('btnPause').classList.toggle('on', !nearBottom);
  });

  $('stLogFile').textContent = '读取中…';
  backfill(0).then(() => connect());
})();
