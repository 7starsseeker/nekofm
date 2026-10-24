/* ==========================================================================
   NekoFM 新版外壳（段1 · 方案 B）
   --------------------------------------------------------------------------
   只在 `location.pathname === '/console'` 时接管版面；`/` 一行都不执行。
   它**不重新实现任何功能**：卡片标记留在 control.html 里，事件绑定留在
   control.js 里，这里只做三件事 ——
     ① 把 20 张卡片按「使用频次 × 作用域」分到 5 个面；
     ② 把队列从"页签里的一张卡"提成**恒在右栏**（切面不消失）；
     ③ 把 106 段 / 3822 字常驻说明折叠成每卡一行「说明」。

   为什么用"改 DOM"而不是"重写页面"：
     control.js 有 48 处 innerHTML、43 处按 id 取元素、14 处 addEventListener，
     重写等于把这些全部抄一遍。搬 DOM 节点则 id 与监听全部继续有效
     （control.js 自己的 layoutShell 也是这个思路）。
   为什么必须在 control.js 之后跑：
     layoutShell 会把卡片搬进 `section[data-panel]`；本脚本要等它搬完再**重新分堆**。
   为什么用 window.load 而不是 DOMContentLoaded：
     layoutShell 挂在 DOMContentLoaded 上；load 一定在它之后，不依赖脚本注册顺序。
   ========================================================================== */
(function () {
  'use strict';

  if (location.pathname !== '/console') return;

  /* ------------------------------------------------------------ 面的划分
     依据是用户 2026-10-24 亲口给的三个高频动作：切歌 / 队列 / 点歌（含手动搜歌）。
     ⇒ 这三个必须**进窗即达**，其余按"什么时候会用到"归面。
     「设置」钉在导航底部：MS 的 app-settings 规范就是"入口是导航最后一项、固定在底部"。 */
  var FACES = [
    {
      key: 'live', label: '直播台', hint: '开播、点歌、切歌、看队列',
      cards: ['直播状态', '点歌 / 检索'],
    },
    {
      key: 'library', label: '曲库', hint: '已保存 / 已播放 / 闲时 / 本地 / 导入 / 缓存',
      cards: ['已保存播放列表', '已播放', '闲时歌单', '本地音乐', '歌单导入（网易云）', '在线缓存'],
    },
    {
      key: 'overlay', label: '叠加层', hint: '给直播姬的浏览器源：歌词、信息卡、地址',
      cards: ['叠加层预览', '歌词叠加层', '播放器信息栏'],
    },
    {
      key: 'ops', label: '审核诊断', hint: '黑名单、自检、注入演练、日志',
      cards: ['黑名单 / 审核', '测试中心 / 自检', '演练 / 注入（不需要开播）', '提示 / 日志'],
    },
    {
      key: 'settings', label: '设置', hint: '每场直播只碰一次的东西', pinned: true,
      cards: ['网易云登录（会员曲必需）', '播放核心 / 输出设备', '点歌设置', '弹幕点歌'],
    },
  ];

  /* 卡片标题归一化：h2 里常带**会被 JS 改写**的计数 span
     （「已播放 <span id="histCount">0</span>」→「已播放 共 190 首」）。
     不能只靠"去掉尾部数字"：control.js 的填充时机晚于 load，
     所以同一张卡在不同时刻算出来的标题可能不一样。
     ⇒ 用**前缀匹配**（长的先试），标题里多出什么后缀都不影响归位。 */
  function titleOf(card) {
    var h = card.querySelector('h2');
    if (!h) return '';
    return (h.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function build() {
    var all = Array.prototype.slice.call(document.querySelectorAll('main .card, aside .card'));
    /* 去重（理论上不重复，防止 layoutShell 之外还有人搬过） */
    all = all.filter(function (c, i) { return all.indexOf(c) === i; });
    if (!all.length) return;

    /* -------------------------------------------------- 1) 骨架 */
    var wrap = document.createElement('div');
    wrap.id = 'v2wrap';

    var nav = document.createElement('nav');
    nav.id = 'v2nav';

    var mainEl = document.createElement('div');
    mainEl.id = 'v2main';

    /* 注意：这里必须是 div，不能是 aside —— shell.css 为了藏掉旧版右侧栏写了
       `html[data-v2] aside { display:none !important }`，用 aside 会被自己藏掉（实测踩过）。 */
    var rail = document.createElement('div');
    rail.id = 'v2rail';

    var faceEls = {};
    FACES.forEach(function (f) {
      var sec = document.createElement('section');
      sec.className = 'v2face';
      sec.dataset.face = f.key;
      if (f.key === 'live') sec.classList.add('active');
      faceEls[f.key] = sec;
      mainEl.appendChild(sec);
    });

    /* -------------------------------------------------- 2) 卡片分堆 */
    /* 前缀表：长的先试（「已保存播放列表」必须先于「已保存」命中） */
    var prefixList = [];
    FACES.forEach(function (f) {
      f.cards.forEach(function (t) { prefixList.push({ t: t, key: f.key }); });
    });
    prefixList.sort(function (a, b) { return b.t.length - a.t.length; });

    function faceOf(card) {
      var t = titleOf(card);
      for (var i = 0; i < prefixList.length; i++) {
        if (t.indexOf(prefixList[i].t) === 0) return prefixList[i].key;
      }
      return null;
    }

    var unmatched = [];
    all.forEach(function (card) {
      var t = titleOf(card);
      /* 队列恒在右栏，不进任何面 */
      if (t.indexOf('当前播放列表') === 0 || t.indexOf('队列') === 0) { rail.appendChild(card); return; }
      var key = faceOf(card);
      if (!key) { unmatched.push(t); key = 'ops'; }   /* 兜底：绝不丢卡片 */
      faceEls[key].appendChild(card);
    });

    /* -------------------------------------------------- 3) 说明折叠 */
    /* 只搬卡片**直接子级**的 div.tip：`.row` 与 `h2` 里的 span.tip 是 JS 会写字的
       实时读数（#liveStat / #qCount / #playSavedHint …），碰了就会断。 */
    all.forEach(function (card) {
      var tips = Array.prototype.filter.call(card.children, function (el) {
        return el.classList && el.classList.contains('tip') && el.tagName === 'DIV';
      });
      if (!tips.length) return;
      var d = document.createElement('details');
      d.className = 'v2-notes';
      var s = document.createElement('summary');
      s.textContent = '说明';
      d.appendChild(s);
      tips.forEach(function (t) { d.appendChild(t); });
      card.appendChild(d);
    });

    /* -------------------------------------------------- 4) 顶栏瘦身
       两个叠加层地址 + 两个复制 + 合并地址：一周填一次的东西占着顶栏最好的位置，
       而真正的状态（登录/弹幕/播放/歌词）只有 4 个小 pill。搬到「叠加层」面。 */
    var addr = document.getElementById('addr');
    var addrInfo = document.getElementById('addrInfo');
    if (addr && addrInfo) {
      var card = document.createElement('div');
      card.className = 'card';
      var h2 = document.createElement('h2');
      h2.textContent = '叠加层地址';
      card.appendChild(h2);

      var mkRow = function (labelText, addrEl, copyId, title) {
        var row = document.createElement('div');
        row.className = 'row';
        var lb = document.createElement('span');
        lb.className = 'tip';
        lb.textContent = labelText;
        row.appendChild(lb);
        row.appendChild(addrEl);
        var btn = document.getElementById(copyId);
        if (btn) {
          if (title) btn.title = title;
          row.appendChild(btn);
        }
        card.appendChild(row);
      };
      mkRow('歌词叠加层', addr, 'copyAddr', '复制歌词叠加层地址（填进直播姬的浏览器源）');
      mkRow('信息卡片', addrInfo, 'copyAddrInfo', '复制信息卡片地址');

      var both = document.getElementById('copyAddrBoth');
      if (both) {
        var rowBoth = document.createElement('div');
        rowBoth.className = 'row';
        rowBoth.appendChild(both);
        card.appendChild(rowBoth);
      }

      var note = document.createElement('div');
      note.className = 'tip';
      note.textContent = '直播姬里建议加两个浏览器源：歌词叠加层的框设成想要的歌词区域（如 1280×200），'
        + '信息卡片的框贴合卡片（约 320×100）。浏览器源的框就是页面尺寸 —— 一个源里塞两样东西，'
        + '框必然比各自都大得多；分开就刚刚好。';
      var d = document.createElement('details');
      d.className = 'v2-notes';
      var s = document.createElement('summary');
      s.textContent = '说明';
      d.appendChild(s);
      d.appendChild(note);
      card.appendChild(d);

      faceEls.overlay.appendChild(card);
    }

    /* 顶栏里指向地址的那两个标签，地址搬走后就没有指向了 */
    Array.prototype.forEach.call(document.querySelectorAll('header .tip'), function (el) { el.remove(); });

    /* -------------------------------------------------- 5) 顶部那条常驻教程
       「直播姬里建议加两个浏览器源…」整条 47px 常驻在页签上方，属于"看一次就够"。
       搬进设置面成一张卡片（内容与上面新卡的说明同源，但保留原位给人找）。 */
    var topTip = document.querySelector('body > .tip');
    if (topTip) {
      var help = document.createElement('div');
      help.className = 'card';
      var hh = document.createElement('h2');
      hh.textContent = '直播姬用法（说明）';
      help.appendChild(hh);
      var dl = document.createElement('details');
      dl.className = 'v2-notes';
      dl.open = true;
      var ss = document.createElement('summary');
      ss.textContent = '展开';
      dl.appendChild(ss);
      dl.appendChild(topTip);
      help.appendChild(dl);
      faceEls.settings.appendChild(help);
    }

    /* -------------------------------------------------- 6) 导航按钮 */
    FACES.forEach(function (f) {
      if (f.pinned) {
        var spacer = document.createElement('div');
        spacer.className = 'v2-nav-spacer';
        nav.appendChild(spacer);
        var sep = document.createElement('div');
        sep.className = 'v2-nav-sep';
        nav.appendChild(sep);
      }
      var b = document.createElement('button');
      b.className = 'v2-nav-btn';
      b.dataset.face = f.key;
      b.textContent = f.label;
      if (f.hint) b.title = f.hint;
      if (f.key === 'live') b.classList.add('active');
      nav.appendChild(b);
    });

    /* 逃生门：旧版面就在 `/`，随时可以点回去看（不需要改代码、不需要重启） */
    var back = document.createElement('a');
    back.href = '/';
    back.textContent = '旧版界面';
    back.title = '回到改造前的单列分页版面（数据与功能完全相同）';
    back.className = 'v2-nav-back';
    nav.appendChild(back);

    /* -------------------------------------------------- 7) 装进文档 */
    wrap.appendChild(nav);
    wrap.appendChild(mainEl);
    wrap.appendChild(rail);
    document.body.appendChild(wrap);
    document.documentElement.dataset.v2 = '1';

    /* -------------------------------------------------- 8) 切面 */
    function show(key) {
      if (!faceEls[key]) key = 'live';
      Object.keys(faceEls).forEach(function (k) {
        faceEls[k].classList.toggle('active', k === key);
      });
      Array.prototype.forEach.call(nav.querySelectorAll('.v2-nav-btn'), function (b) {
        b.classList.toggle('active', b.dataset.face === key);
      });
      mainEl.scrollTop = 0;
      try { localStorage.setItem('nekofm.face', key); } catch (e) { /* 忽略 */ }
    }

    nav.addEventListener('click', function (e) {
      var b = e.target.closest('.v2-nav-btn');
      if (!b) return;
      show(b.dataset.face);
    });

    var last = null;
    try { last = localStorage.getItem('nekofm.face'); } catch (e) { /* 忽略 */ }
    show(last && faceEls[last] ? last : 'live');

    /* 兜底把没认出来的卡片报出来：新增卡片时能立刻发现它掉进了「审核诊断」 */
    if (unmatched.length && window.console) {
      console.warn('[shell] 这些卡片没在 FACES 里登记，已放进「审核诊断」：', unmatched.join(' / '));
    }
  }

  if (document.readyState === 'complete') build();
  else window.addEventListener('load', build, { once: true });
})();
