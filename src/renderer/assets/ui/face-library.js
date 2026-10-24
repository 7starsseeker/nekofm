/**
 * 面模块：曲库面（本地音乐 / 已播放 / 歌单导入 / 已保存播放列表 / 闲时歌单 / 在线缓存）
 *
 * 为什么整块搬：这 6 张卡的渲染与接线原本是 control.js 最后的 `(function newPanels(){…})()`，
 * 它自带 $id / call / toast / confirm / fmt / esc 与右键菜单入口，几乎不依赖宿主内部 —— 属于
 * 「本来就不该住在宿主里」的那一类。搬出来之后 control.js 只剩它自己的共享层。
 *
 * 契约（同 face-ops.js 头部）：
 *   1. 只往 window.__nekofmFaces 挂 library(ctx)，不碰别的模块与宿主内部变量；
 *   2. ctx 提供 { $, api, log, on, toast, confirm }，缺哪个就用本模块自带的等价实现；
 *   3. init() 返回宿主还需要主动调用的方法（这里没有新的，宿主靠 window.__nekofm* 钩子取）。
 *
 * 这个模块仍会挂这几个 window 钩子（宿主 renderState / 旧版面页签切换要用）：
 *   __nekofmPaintLive / __nekofmRefreshLists / __nekofmSyncHistory / __nekofmSyncSaved
 */
(function () {
  'use strict';
  window.__nekofmFaces = window.__nekofmFaces || {};

  window.__nekofmFaces.library = function init(ctx) {
    ctx = ctx || {};
    const $id = (i) => document.getElementById(i);
    const call = (body) => fetch('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => ({}));
    /** 宿主优先通过 ctx 注入（面模块契约），拿不到再退回那个全局钩子 —— 两条路都存在，永不静默。 */
    const toast = (ok, text) => (ctx.toast || window.__nekofmToast)(ok, text);
    /** 同上：`__nekofmConfirm` 早就暴露好了，这里一直没人接（2026-10-16 发现「删缓存」按钮点了没反应就是这个） */
    const confirmDialog = (message) => (ctx.confirm || window.__nekofmConfirm)(message);

    const fmt = (s) => {
      s = Math.max(0, Math.floor(s || 0));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    /**
     * 给一行挂上**统一的管理按钮**：缓存 / 加入已保存 / 拉黑 / 删除。
     * 当前播放列表、已播放、已保存三处共用这套，行为一致，用户不用分别记。
     */
    /* 右键菜单的实现在文件顶部（三个 IIFE 共用，队列行在主逻辑里画）。
       这里只取两个入口，名字保持一致，下面 addItemActions 直接调用。 */
    const isV2 = () => !!(window.__nekofmCtxMenu && window.__nekofmCtxMenu.isV2());
    const openCtx = (...a) => window.__nekofmCtxMenu.openCtx(...a);

    function addItemActions(li, it, kind, onChanged) {
      /** 收进这里的按钮不会进 DOM，只在右键菜单里出现 */
      const acts = [];
      const mk = (text, title, fn, cls) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        if (cls) b.className = cls;
        b.onclick = fn;
        return b;
      };

      /* 「从这一首开始播整张歌单」——只在已保存列表出现（原来是 renderList 里直接
         appendChild 的，2026-10-24 统一收进 acts，否则菜单少一条、行内还多一个按钮）。 */
      if (kind === 'saved') {
        acts.push({ btn: mk('从这首开始播放', '从这一首开始播放「已保存播放列表」', async () => {
          const r = await call({ action: 'playSaved', from: it.__index });
          const d = r.result || {};
          if (!d.ok) toast(false, d.msg || '播放失败');
        }) });
      }

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
        /**
         * 按钮文字留一份在闭包里：点完要能还原 —— 列表刷新是异步的，
         * 万一中间抛异常就再也没人把它改回来了。
         * 2026-10-16 用户实测的「点补缓存卡在缓存中…」就是这么来的：
         * 响应回来后的 `toast(...)` 抛 `toast is not defined`，把后面的 `onChanged()` 一起带走了。
         * 现在两处都补上：toast 能用了，刷新也放进 finally（抛了照样还原 + 刷新）。
         */
        const label = full ? '已缓存 ✓' : (hasAudio || hasLyric ? '补缓存' : '缓存');
        const b = mk(label, tip, async () => {
          const done = () => { b.textContent = label; b.disabled = false; onChanged && onChanged(); };
          if (full) {
            if (!await confirmDialog(`删除《${it.name || ''}》的缓存？\n\n音频 ${cache.audio.mb}MB 会被删掉，下次播放要重新联网取。`)) return;
            try {
              const r = await call({ action: 'cacheSongDrop', song: it.song });
              const d = (r && r.result) || {};
              if (d.ok) toast(true, `已删除缓存（音频 ${d.audio && d.audio.ok ? '✓' : '未删'}，歌词 ${d.lyrics && d.lyrics.ok ? '✓' : '未删'}）`);
              else toast(false, (d.audio && d.audio.msg) || '删除失败');
            } finally { done(); }
          } else {
            b.textContent = '缓存中…';
            b.disabled = true;
            try {
              const r = await call({ action: 'cacheSongFetch', song: it.song });
              const d = (r && r.result) || {};
              if (r && r.ok === false) {
                // 命令本身没跑起来（服务端 500，比如 B站链接失效）：把原因原样说出来，
                // 别只报一个"?"（2026-10-16 实测坏链接就是这种情况）
                toast(false, `缓存失败：${r.error || '服务端没有返回原因'}`);
              } else {
                /**
                 * 两侧都报 —— 用户要求「匹配不到歌词时不要停在半截，要明确说没匹配到」
                 * （2026-10-16）。只报成功的那半，会让"音频成了、歌词没匹配到"
                 * 看起来像卡住了；`na`（本地曲目不需要缓存音频）不算失败。
                 */
                const side = (o, label) => {
                  if (!o) return `${label}：?`;
                  if (o.na) return `${label}：不需要`;
                  if (o.ok && o.skipped === 'already') return `${label}：已有`;
                  if (o.ok) return `${label}：已缓存${o.size ? ` ${(o.size / 1048576).toFixed(1)}MB` : ''}`;
                  return `${label}：${o.msg || o.skipped || '失败'}`;
                };
                const missing = (o) => !o || !(o.ok || o.na);
                const aTxt = side(d.audio, '音频');
                const lTxt = side(d.lyrics, '歌词');
                const bad = missing(d.audio) || missing(d.lyrics);
                toast(!bad, bad ? `${aTxt}；${lTxt}（下次点「补缓存」会再检测一次）` : `${aTxt}；${lTxt}`);
              }
            } finally { done(); }
          }
        });
        if (full) b.style.borderColor = '#2c8a4b';
        acts.push({ btn: b });
      }
      // 拉黑粒度：菜单里展开成 4 条（原来是行内的下拉框，占位又不直观）
      const sel = document.createElement('select');
      for (const [v, t] of [['song', '歌曲'], ['keyword', '关键词'], ['artist', '歌手'], ['bvid', 'BV号']]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        sel.appendChild(o);
      }
      sel.value = (it.source === 'bilibili') ? 'bvid' : 'song';

      /**
       * 「加入已保存」：三个列表共用一套按钮（见 mkKeepButton）。
       * `it.saved` 由服务端算好 —— 已保存列表里恒为 true，已播放/队列里按去重键判。
       * 用户要求"点了要有实时反馈"，所以按钮自己会变成「已保存 ✓」，
       * 而不是只往日志里写一行。
       */
      const mkKeep = window.__nekofmMkKeepButton || ((o) => {
        // 首个 IIFE 没加载（理论上不会）时的兜底：至少能点、能报日志
        const b = mk(o.saved ? '已保存 ✓' : '加入已保存', o.title, o.onAdd);
        if (o.saved) b.disabled = true;
        return b;
      });
      acts.push({ btn: mkKeep({
        saved: !!it.saved,
        title: '加入「已保存播放列表」，开播时作为闲时歌单循环播放',
        onAdd: async () => {
          const r = await call({ action: 'savedAdd', song: it.song, uname: it.uname });
          if (r.result && r.result.ok) onChanged && onChanged();
          return r;
        },
      }) });
      const blacklistBy = (type, label) => ({
        label: `拉黑（${label}）`,
        title: type === 'song' ? '这首歌以后不再能点' : (type === 'artist' ? '这个歌手的所有歌都不再能点' : (type === 'keyword' ? '歌名包含这个词的都不再能点' : '这个 BV 号不再能点')),
        run: async () => {
          const r = await call({ action: 'blacklistSong', song: it.song, type });
          if (r.result && r.result.ok) onChanged && onChanged();
          else toast(false, (r.result && r.result.msg) || '拉黑失败');
        },
      });
      acts.push('-');
      acts.push(blacklistBy('song', '歌曲'));
      acts.push(blacklistBy('keyword', '关键词'));
      acts.push(blacklistBy('artist', '歌手'));
      acts.push(blacklistBy('bvid', 'BV号'));
      /* 删除：菜单里叫得更具体，行内（旧版面）还是「删除」一个词。
         动作同一份 lambda，不许两边漂移。 */
      const doRemove = async () => {
        const act = kind === 'queue' ? 'remove' : (kind === 'history' ? 'historyRemove' : 'savedRemove');
        await call({ action: act, index: it.__index });
        onChanged && onChanged();
      };
      acts.push('-');
      acts.push({
        label: kind === 'queue' ? '从播放列表移除' : (kind === 'history' ? '从已播放移除' : '从已保存移除'),
        danger: true,
        run: doRemove,
      });
      /* 把收集到的按钮挂到右键菜单上。旧版面 `/` 不参与（见 isV2 的注释）。 */
      if (isV2()) {
        li.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const items = acts.map((a) => (a.btn
            ? { label: a.btn.textContent, title: a.btn.title, disabled: a.btn.disabled, run: () => a.btn.click() }
            : a));
          openCtx(e.clientX, e.clientY, `${it.name || ''}${it.artistText ? ` — ${it.artistText}` : ''}`, items);
        });
      } else {
        for (const a of acts) { if (a.btn) li.appendChild(a.btn); }
        li.appendChild(sel);
        // 旧版面保持原样：拉黑仍是「下拉 + 按钮」两个控件
        li.appendChild(mk('拉黑', '按所选粒度加入黑名单', async () => {
          const r = await call({ action: 'blacklistSong', song: it.song, type: sel.value });
          if (r.result && r.result.ok) onChanged && onChanged();
          else toast(false, (r.result && r.result.msg) || '拉黑失败');
        }));
        li.appendChild(mk('删除', kind === 'queue' ? '从当前播放列表移除' : (kind === 'history' ? '从已播放记录移除' : '从已保存列表移除'), doRemove, 'ghost'));
      }
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
         *   · 只有一个     → 灰色「半缓存（无歌词）」/「半缓存（无音频）」
         *
         * 2026-10-16 用户要求：**缺的那一半要说清是哪一半**。原来只写「半缓存」，
         * 而"音频已缓存、歌词没匹配到"是最常见的情况（尤其 B站视频），
         * 用户看到的就是"状态停在半截、不知道歌词怎么了"。
         */
        let badge = '';
        const c = it.cache;
        if (c && !(it.source === 'local' || (it.song && it.song.source === 'local'))) {
          const a = c.audio && c.audio.cached;
          const l = c.lyrics && c.lyrics.cached;
          if (a && l) badge = `<span class="cache-badge ok" title="音频 ${c.audio.mb}MB + 歌词 ${c.lyrics.lines} 行，已能离线播放">已缓存</span>`;
          else if (a || l) badge = `<span class="cache-badge half" title="${a ? `音频已缓存 ${c.audio.mb}MB，歌词没匹配到 —— 下次点「补缓存」会再检测一次` : '歌词已缓存，音频还没下 —— 下次点「补缓存」会再试一次'}">半缓存（${a ? '无歌词' : '无音频'}）</span>`;
          else badge = '<span class="cache-badge none" title="还没有缓存，播放时要联网取">未缓存</span>';
        }
        /* **列槽占位**（2026-10-24）：缓存角标 / 点歌人 / 时长这三个是可选字段，
           原来缺了就整段不输出 —— 这行的后面所有列就都左移一格，纵向扫视时列立不住
           （实测：同表内时长列在 x=677 与 708 之间跳）。成熟播放器的列表列宽固定，
           空值也占位，所以这里一律输出 span，只让内容为空。 */
        const durSec = it.duration || (it.song && it.song.duration) || 0;
        li.innerHTML = `<span class="idx">${i + 1}</span><span class="nm" title="${esc(it.name)}">${esc(it.name || '—')}</span>`
          + (badge || '<span class="cache-badge"></span>')
          + `<span class="by">${esc(it.artistText || '')}</span>`
          + `<span class="by by-user">${esc(it.uname || '')}</span>`
          /* 时长列：foobar2000 / MusicBee / AIMP 的列表都有，且**定宽右对齐** ——
             不定宽就随歌名长短左右抖，扫一遍表全在动。本地曲目在 renderLocalList 里另有一套。 */
          + `<span class="dur">${durSec ? fmt(durSec) : ''}</span>`;
        ul.appendChild(li);
        it.__index = i + 1;
        if (extra) extra(li, it);
        if (it.song) {
          // 已保存列表的「从这首开始播放」在 addItemActions 里统一收进右键菜单
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
    // 队列首屏就要完整列表（状态广播里只带前 8 条，见 renderState 的说明）
    if (window.__nekofmRefreshQueue) window.__nekofmRefreshQueue();
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

    return { refreshHistory: refreshHistory, refreshSaved: refreshSaved, paintLive: paintLive };
  };
})();
