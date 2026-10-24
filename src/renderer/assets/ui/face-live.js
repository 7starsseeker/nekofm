/**
 * 面模块：直播台（live）—— 段2 第五刀
 *
 * 搬进来的四块（原来都长在 control.js 第一个 IIFE 里）：
 *   1. 当前播放列表（队列）的拉取与行渲染          ← renderQueue / refreshQueue
 *   2. 点歌 / 检索 / 视频入队                      ← doOrder / btnSearch / btnOrderVideo
 *   3. 底栏传输控件（播放模式、上一首/暂停/下一首、收藏、进度条拖动）
 *   4. 直播状态卡（开始/结束直播）—— 从 face-library.js 挪过来：
 *      那张卡属于直播台，逻辑留在曲库模块里是错的（第 4 刀遗留）
 *
 * 契约同 face-ops.js / face-overlay.js / face-account.js / face-library.js：
 *   - 只往 window.__nekofmFaces 挂一个 init(ctx)，不碰 DOM 结构、不改宿主内部变量
 *   - ctx 只有 { $, api, log, on, esc, toast, getState, mkKeepButton }
 *   - init 返回宿主还需要主动调用的方法（renderQueue / highlightMode）
 *   - 模块缺席时宿主必须响亮报错（见 control.html 的接线注释）
 */
(function () {
  'use strict';
  if (!window.__nekofmFaces) window.__nekofmFaces = {};

  window.__nekofmFaces.live = function init(ctx) {
    const $ = ctx.$;
    const api = ctx.api;
    const log = ctx.log;
    const on = ctx.on;
    const esc = ctx.esc;
    const toast = ctx.toast || function () {};
    const getState = ctx.getState || function () { return null; };
    const mkKeepButton = ctx.mkKeepButton;

    // ------------------------------------------------------------------ 当前播放列表（队列）
    /** 完整队列的本地缓存（状态里只带前 8 条，见宿主 renderState 的说明） */
    let queueView = null;
    let queueFetchSeq = 0;
    /** 上次渲染用的队列变更签名（服务端算的 rev），变了才重画 */
    let _qRev = null;

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
    // 宿主 renderState 与旧版面的页签切换都要能主动拉一次
    window.__nekofmRefreshQueue = refreshQueue;

    /**
     * 渲染队列这一列。宿主每次收到状态就调（10Hz）。
     *
     * **内容没变就不重建 DOM。**
     * 原来每次都 innerHTML='' 整列重建 —— 用户在 mousedown 与 mouseup 之间
     * 按钮被换成新节点，click 就不会触发，表现成"点『撤』没反应""点『拉黑』没反应"
     * （实测被反馈）。用签名比较，只有队列真的变了才重画。
     */
    /**
     * 队列行的**动作定义（唯一真相）**。
     * v2 把它喂给右键菜单，v1 直接把节点挂到行上 —— 同一份逻辑，两种落点。
     * 为什么两条路并存：v1 是回滚保底面，冻结不动；v2 走 lit 模板（行内零控件）。
     */
    const BL_OPTS = [['song', '这首歌'], ['keyword', '标题关键词'], ['artist', '歌手'], ['bvid', 'BV号']];

    function buildQueueActs(it) {
      const top = document.createElement('button');
      top.textContent = '顶';
      top.title = '把这首提到队列最前';
      top.onclick = () => api({ action: 'queueMove', index: it.position, where: 'top' });

      // 拉黑：外面套个"拉黑"字样的标签 ——
      // 原来是个光秃秃的下拉框，用户根本不知道它是干什么的（实测被问过）。
      const blWrap = document.createElement('span');
      blWrap.className = 'bl-wrap';
      blWrap.title = '选择拉黑的粒度，再点右边的「拉黑」';
      const blLabel = document.createElement('span');
      blLabel.className = 'bl-label';
      blLabel.textContent = '拉黑';
      const sel = document.createElement('select');
      BL_OPTS.forEach(([v, t]) => {
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
        // 队列项没有 song 字段（精简版 `_brief`），要用 key 回查
        onAdd: () => api({ action: 'savedAdd', key: it.key }),
      });
      const rm = document.createElement('button');
      rm.textContent = '撤';
      rm.onclick = () => api({ action: 'remove', index: it.position });
      return { top, blWrap, sel, blk, keep, rm };
    }

    /** 把 buildQueueActs 的结果翻译成右键菜单项。 */
    function queueMenuOf(it, a) {
      const menu = [{ label: '置顶到队列最前', title: a.top.title, run: () => a.top.click() }, '-'];
      for (const [v, t] of BL_OPTS) {
        menu.push({
          label: `拉黑（${t}）`,
          title: `按「${t}」粒度加入黑名单，并把这首先从队列撤下`,
          run: () => { a.sel.value = v; a.blk.click(); },
        });
      }
      menu.push('-');
      menu.push({ label: a.keep.textContent, disabled: a.keep.disabled, title: a.keep.title, run: () => a.keep.click() });
      menu.push('-');
      menu.push({ label: '从队列移除', danger: true, title: '把这首先从当前播放列表撤下', run: () => a.rm.click() });
      return menu;
    }

    /**
     * 用 lit 画队列列（patch，不清空重建）。
     *
     * 这里是 lit 收益最大的地方：这是 **10Hz 热路径**，以前靠
     * `ul.dataset.sig` 签名比较 + `busy`（原生下拉展开时不重画）两个 hack
     * 来回避"整列重建把 mousedown/mouseup 之间的节点换掉"的毛病。
     * lit 本身就是最小 diff、节点复用，这两个 hack 在 v2 侧可以退休。
     */
    function paintQueueLit(ul, cur, items) {
      const { html, render, nothing } = window.__nekofmLit;
      // 首次由 lit 接管时，容器里可能还留着第一帧（lit 未加载时）legacy 拼的行 ——
      // render() 是**追加**不是替换，不先清一次同一个行会出现两份。
      if (!ul.__litOwned) { ul.textContent = ''; ul.__litOwned = true; }

      const rows = [];
      if (cur) {
        // 正在放的那首可能不在待播列表里（从「已播放」回退 / 手动播了队列之外的歌单）
        // —— 如实说明一句，免得用户以为列表丢歌
        const where = !cur.outsideQueue ? '正在播放'
          : (cur.outsideKind === 'idle' ? '正在播放（列表之外的歌单）' : '正在播放（从已播放回退）');
        rows.push(html`<li class="q-current" data-cur="1">
          <span class="idx">▶</span>
          <span class="nm" title=${cur.name}>${cur.name}</span>
          <span class="by">${where}${cur.artistText ? ' · ' + cur.artistText : ''}</span>
          ${cur.uname ? html`<span class="by">${cur.uname}</span>` : nothing}
        </li>`);
      }
      if (!items.length) {
        rows.push(html`<li><span class="tip">队列为空，等弹幕点歌或在上方点歌</span></li>`);
      }
      items.forEach((it) => {
        rows.push(html`<li data-pos=${it.position}>
          <span class="idx">${it.position}</span>
          <span class="nm" title=${it.name}>${it.name}</span>
          <span class="by">${it.artistText || ''}</span>
          ${it.uname ? html`<span class="by">${it.uname}</span>` : nothing}
        </li>`);
      });

      render(rows, ul);
      ul.__q = { cur, items };

      // 监听器只挂一次（挂在 ul 上做事件委托）——
      // 每次右键现造动作节点：这些动作用完就丢，不会随 10Hz 反复创建。
      if (!ul.__ctxBound) {
        ul.__ctxBound = true;
        ul.addEventListener('contextmenu', (e) => {
          const li = e.target.closest('li');
          const ctxMenu = window.__nekofmCtxMenu;
          if (!li || !ctxMenu || !ul.__q) return;
          e.preventDefault();
          e.stopPropagation();
          if (li.dataset.cur) {
            const cur0 = ul.__q.cur;
            if (!cur0) return;
            const keep = mkKeepButton({
              saved: cur0.saved,
              title: '加入「已保存播放列表」，开播时作为闲时歌单',
              onAdd: () => api({ action: 'savedAdd', key: cur0.key, uname: cur0.uname }),
            });
            ctxMenu.openCtx(e.clientX, e.clientY,
              `${cur0.name}${cur0.uname ? ' · ' + cur0.uname : ''}`,
              [{ label: keep.textContent, disabled: keep.disabled, run: () => keep.click() }]);
            return;
          }
          const it = (ul.__q.items || []).find((x) => String(x.position) === String(li.dataset.pos));
          if (!it) return;
          ctxMenu.openCtx(e.clientX, e.clientY,
            `${it.name}${it.uname ? ' · ' + it.uname : ''}`, queueMenuOf(it, buildQueueActs(it)));
        });
      }
    }

    function renderQueue(s) {
      const q = (s && s.queue) || {};
      /**
       * 状态广播里只带**前 8 条**（10Hz，刻意压载荷），队列长了就看不到后续项
       * （用户报告"待播放列表无法查看后续项"）。
       *
       * 现在按 `rev`（服务端算的变更签名）判断：变了就拉一份**完整**的
       * （listQueue，人力频率的一次请求），渲染仍走下面同一段代码，
       * 只是数据源换成 `queueView`。签名而不是条数 —— 置顶/上一首回退这类
       * "条数不变的重排"也必须被发现。
       */
      if (q.rev && q.rev !== _qRev) {
        _qRev = q.rev;
        refreshQueue();
      }
      const qv = queueView || { current: q.current || null, items: q.items || [], total: q.total || 0 };
      const cnt = $('qCount');
      if (cnt) cnt.textContent = `（待播 ${qv.total} 首）`;
      const ul = $('queue');
      if (!ul) return;

      // **正在播放的那首也要显示出来**：它已被 queue.next() 从待播里取出，
      // 只渲染 items 的话，用户点完歌立刻看到"队列为空"，会以为没点上（实测被反馈）。
      const items = qv.items || [];
      const cur = qv.current;

      /* 队列行：新外壳下整行的控件都进右键菜单（见 control.js 顶部 __nekofmCtxMenu 的注释）。
         这两行必须在「正在播放」那一行之前，那个分支也要用它。 */
      const ctxMenu = window.__nekofmCtxMenu;
      const v2 = !!(ctxMenu && ctxMenu.isV2());

      /* v2 + lit 已就绪：走 patch，不重建。
         lit 复用节点 ⇒ 「重建把 mousedown/mouseup 之间的按钮换掉」不再发生，
         下面那套 qSig 签名比较与 busy（下拉展开时不重画）在 v2 侧不再需要。 */
      if (v2 && window.__nekofmLit && window.__nekofmLit.render) { paintQueueLit(ul, cur, items); return; }

      const qSig = (cur ? cur.key : '-') + '|' + items.map((it) => it.key + ':' + it.uname).join(',');
      // 用户正在这一列里操作（比如原生下拉展开着）时一律不重画 ——
      // 原生下拉一旦被重建就会立刻收起，看起来像"点了菜单自己收回去"（实测被反馈）
      const busy = ul.contains(document.activeElement) && document.activeElement.tagName === 'SELECT';
      if (busy || ul.dataset.sig === qSig) return;

      ul.dataset.sig = qSig;
      ul.innerHTML = '';
      if (cur) {
        const li = document.createElement('li');
        li.className = 'q-current';
        const owner = cur.uname ? `<span class="by">${esc(cur.uname)}</span>` : '';
        // 正在放的那首可能不在待播列表里（从「已播放」回退 / 手动播了队列之外的歌单）
        // —— 如实说明一句，免得用户以为列表丢歌
        const where = !cur.outsideQueue ? '正在播放'
          : (cur.outsideKind === 'idle' ? '正在播放（列表之外的歌单）' : '正在播放（从已播放回退）');
        li.innerHTML = `<span class="idx">▶</span><span class="nm" title="${esc(cur.name)}">${esc(cur.name)}</span>`
          + `<span class="by">${where}${cur.artistText ? ' · ' + esc(cur.artistText) : ''}</span>${owner}`;
        const keep = mkKeepButton({
          saved: cur.saved,
          title: '加入「已保存播放列表」，开播时作为闲时歌单',
          // 发 key 而不是 song：队列项的状态是精简版（`_brief`），**没有完整 song 对象** ——
          // 原来发 `cur.song`（undefined）于是"点了永远不生效"（2026-09-26 修）
          onAdd: () => api({ action: 'savedAdd', key: cur.key, uname: cur.uname }),
        });
        // 只剩 v1 会走到这里（v2 已在上面 return）：行内保留「加入已保存」按钮
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
        const owner = it.uname ? `<span class="by">${esc(it.uname)}</span>` : '';
        li.innerHTML = `<span class="idx">${it.position}</span><span class="nm" title="${esc(it.name)}">${esc(it.name)}</span>`
          + `<span class="by">${esc(it.artistText || '')}</span>${owner}`;

        // 动作定义只有一份（buildQueueActs），v1 这里只是把节点挂到行上
        const a = buildQueueActs(it);
        li.appendChild(a.top);
        li.appendChild(a.blWrap);
        li.appendChild(a.blk);
        li.appendChild(a.keep);
        li.appendChild(a.rm);

        ul.appendChild(li);
      });
    }

    // ------------------------------------------------------------------ 点歌 / 检索
    /** 把服务端返回的失败原因**明确显示出来**（以前失败是完全静默的，用户以为界面坏了） */
    function showOrderFailure(msg) {
      const box = $('results');
      if (box) box.innerHTML = `<div class="tip">⚠️ ${esc(msg)}</div>`;
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
          box.innerHTML = `<div class="tip">✅ 已自动匹配并播放：《${esc(nm)}》第 ${d.position} 位`
            + (d.lowConfidence ? '（匹配度不高，不是这首的话点下面换）' : '') + '</div>';
        }
        log('ok', `已点：《${nm}》第 ${d.position} 位`);
        $('kw').value = '';
        if (Array.isArray(d.candidates) && d.candidates.length) {
          d.candidates.forEach((c) => {
            const row = document.createElement('div');
            row.innerHTML = `<span>${esc(c.name)}</span> <span class="tip">— ${esc(c.artistText || '')}</span> `;
            const b = document.createElement('button');
            b.textContent = '换这首';
            b.onclick = async () => {
              const rr = await api({ action: 'order', song: c, force: true });
              const dd = (rr && rr.result) || {};
              if (dd.ok) { log('ok', `已切到：《${c.name}》`); if (box) box.innerHTML = `<div class="tip">✅ 已换：《${esc(c.name)}》</div>`; }
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
        if (box) box.innerHTML = '<div class="tip">没找到确切匹配，这几个是最接近的，点一首：</div>';
        d.candidates.slice(0, 8).forEach((c) => {
          const row = document.createElement('div');
          row.innerHTML = `<span>${esc(c.name)}</span> <span class="tip">— ${esc(c.artistText || '')}</span> `;
          const b = document.createElement('button');
          b.textContent = '点这首';
          b.onclick = async () => {
            const rr = await api({ action: 'order', song: c });
            const dd = (rr && rr.result) || {};
            if (dd.ok) log('ok', `已点：《${c.name}》第 ${dd.position} 位`);
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
        d.innerHTML = `<span>${esc(s.name)}</span> <span class="tip">— ${esc(s.artistText)}</span> `;
        const b = document.createElement('button');
        b.textContent = '点这首';
        b.onclick = async () => {
          const rr = await api({ action: 'order', song: s });
          const dd = (rr && rr.result) || {};
          if (dd.ok) log('ok', `已点：《${s.name}》第 ${dd.position} 位`);
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
      if (r.ok) log('ok', '视频已入队');
      $('bv').value = '';
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
    // 静音按钮已并入音量控件（点按钮＝静音开关，见 volume-dial.js）
    on('btnFavorite', 'click', async () => {
      const r = await api({ action: 'toggleFavorite' });
      if (r.ok) log('ok', r.result.favorited ? '已收藏当前曲目' : '已取消收藏');
    });

    // 进度条拖动跳转
    {
      const bar = $('seekBar');
      let dragging = false;
      const seekTo = (ev) => {
        const rect = bar.getBoundingClientRect();
        const st = getState();
        const d = (st && st.playback && st.playback.duration) || 0;
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

    // ------------------------------------------------------------------ 直播状态
    /** 只有两种状态：直播中 / 未直播。切换本身即动作（切到未直播会保存当前列表）。 */
    function paintLive(streaming, savedCount) {
      const isOn = !!streaming;
      const n = savedCount || 0;
      const p = $('livePill'); const b = $('btnToggleLive');
      if (p) { p.textContent = isOn ? '直播中' : '未直播'; p.className = 'pill ' + (isOn ? 'ok' : 'off'); }
      if (b) b.textContent = isOn ? '结束直播' : '开始直播';
      // 直播中：已保存歌单固定作为闲时歌单 → 屏蔽"单独播放"
      const pb = $('btnPlaySaved');
      if (pb) {
        pb.disabled = isOn;
        pb.title = isOn ? '直播中：「已保存播放列表」固定作为闲时歌单（当前列表放空后自动接着放）' : '未直播：把它当本地歌单直接播放';
      }
      const hint = $('playSavedHint');
      if (hint) {
        hint.textContent = isOn
          ? '直播中：它作为闲时歌单自动接着放，不能单独播放'
          : '未直播时可直接播放';
      }
      const stat = $('liveStat');
      if (stat) {
        stat.textContent = isOn
          ? `正在直播 · 已保存 ${n} 首作为闲时歌单`
          : `未直播 · 已保存 ${n} 首`;
      }
    }

    async function setLive(isOn) {
      const r = await api({ action: 'setStreaming', on: isOn });
      const d = (r && r.result) || {};
      paintLive(d.streaming != null ? d.streaming : isOn, d.saved);
      // 已保存列表的刷新归曲库面管（这边只要结果一致，不去碰它的渲染）
      if (window.__nekofmSyncSaved) window.__nekofmSyncSaved();
    }
    if ($('btnToggleLive')) $('btnToggleLive').onclick = async () => {
      const st = await (await fetch('/api/state')).json();
      setLive(!st.streaming);
    };
    // 直播状态开关只保留「直播状态」卡片里那一个（底栏不再重复）
    window.__nekofmPaintLive = paintLive;

    return {
      refreshQueue: refreshQueue,
      renderQueue: renderQueue,
      highlightMode: highlightMode,
      paintLive: paintLive,
      setLive: setLive,
    };
  };
})();
