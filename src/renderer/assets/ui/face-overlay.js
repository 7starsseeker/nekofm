'use strict';
/**
 * 「叠加层」面：叠加层预览（三个独立预览窗）+ 歌词叠加层表单 + 播放器信息栏表单。
 *
 * 契约见 `face-ops.js` 文件头（模块只往 `window.__nekofmFaces` 挂 `init(ctx)`，
 * ctx 由宿主注入，模块不碰宿主内部变量）。
 *
 * 这一面为什么值得单独成文件：两个表单加起来 60 多个控件 id，散在 2,900 行里
 * 时，改一个滑杆要跨屏幕确认"它到底属于歌词还是信息栏"。搬到一起之后，
 * 两个表单的 id 前缀（`o*` / `ib*`）就是天然的分区，谁也别想到处乱放。
 *
 * 返回：`fillOverlayForm(o)` —— 宿主在拿到 `/api/state` 与服务端 config 推送时
 * 要用它把表单刷成当前值（两处调用点都在 control.js）。
 */
(function () {
  var faces = window.__nekofmFaces = window.__nekofmFaces || {};

  faces.overlay = function initOverlay(ctx) {
    var $ = ctx.$;
    var api = ctx.api;
    var log = ctx.log;
    var on = ctx.on;

    /* ------------------------------------------------------- 预览窗（三个各自独立） */
    // 三种预览窗各自独立，可以同时打开（对应直播姬里放几个浏览器源的几种摆法）
    on('btnPreviewLyrics', 'click', function () { api({ action: 'showOverlayWindow', mode: 'lyrics' }); });
    on('btnPreviewInfo', 'click', function () { api({ action: 'showOverlayWindow', mode: 'info' }); });
    on('btnPreviewBoth', 'click', function () { api({ action: 'showOverlayWindow', mode: 'both' }); });
    on('btnPreviewAll', 'click', async function () {
      var r = await api({ action: 'showOverlayWindow', mode: 'all' });
      if (r.ok) log('info', '三个预览窗已打开（歌词 / 信息卡片 / 整体），可同时对照');
    });
    on('btnOverlayHide', 'click', async function () {
      var modes = ['both', 'lyrics', 'info'];
      for (var i = 0; i < modes.length; i++) await api({ action: 'hideOverlayWindow', mode: modes[i] });
      log('info', '已关闭全部叠加层预览窗');
    });

    /* ----------------------------------------------------------- 歌词叠加层表单 */
    /**
     * 描边滑块的提示文案。
     *
     * 滑块的值是"**42px 字号时的等效像素**"，实际渲染换算成 `em`（占字号的比例）应用，
     * 上限 6% —— 每行按**自己的**字号算，所以原文行和更小的译文行占比一致。
     * 这里把换算结果直接写出来，用户不用猜。
     */
    function strokeHint(w, fontSize) {
      var want = Math.max(0, Number(w) || 0) / 42;
      var ratio = Math.min(want, 0.06);
      var capped = ratio < want - 0.0001;
      return (Number(w) || 0) + 'px → 描边占字号 ' + (ratio * 100).toFixed(1) + '%'
        + (capped ? '（已触上限 6%）' : '')
        + ' · ' + (ratio <= 0.052 ? '清晰' : '偏粗，建议 2~2.5');
    }

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
     */
    var THEME_PRESETS = {
      scroll: { showTranslation: false, showRoma: false },   // 纯原文
      dual: { showTranslation: true, showRoma: false },      // 双语
    };
    /** 老配置里可能有已下线的主题（karaoke / desktop）→ 映射到最接近的一项 */
    var THEME_MIGRATE = { karaoke: 'scroll', desktop: 'dual' };

    /**
     * 按当前配置估算"**歌词块 / 信息卡片实际占多少像素**"，写进控制台，
     * 让用户在直播姬里照着填浏览器源的宽高 —— 这是"框贴合组件"的唯一可靠办法
     * （浏览器源的框就是页面视口，页面自己改不了它）。
     *
     * 估算依据：`.line` 行高是 `1.28 × 字号`；译文行约 `0.62em` 再加一点间距；
     * 末尾留约 12% 余量加上下 padding。宽度由画面宽度决定，所以只给高度建议。
     */
    function refreshBoxHint(o) {
      var el = $('oBoxHint');
      if (!el) return;
      var rows = o.showTranslation ? 2 : Math.max(1, 1 + (o.linesBefore | 0) + (o.linesAfter | 0));
      var h = Math.round(rows * (o.fontSize || 42) * 1.28 * 1.12 + 18);
      el.textContent = '💡 建议浏览器源尺寸（照着填进直播姬的宽高）：'
        + '歌词 → 画面宽 × ' + h + 'px；信息卡片 → 320 × 92px。'
        + '（浏览器源的框就是页面视口，页面改不了它，所以按这个尺寸填框最贴合）';
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

    function fillOverlayForm(o) {
      if (!o) return;
      // 老配置里可能是已下线的主题 → 映射到最接近的一项，否则 select 会落到空值
      var theme = THEME_MIGRATE[o.theme] || o.theme || 'scroll';
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

    on('btnSaveOverlay', 'click', async function () {
      var r = await api({ action: 'setOverlay', overlay: collectOverlay() });
      if (r.ok) log('info', '叠加层设置已应用（立即生效，无需重开直播姬）');
    });

    on('oTheme', 'change', async function () {
      var sel = $('oTheme');
      var p = THEME_PRESETS[sel.value];
      if (!p) return;
      // 1) 同步勾选框，让界面**如实反映**当前这套预设
      $('oTrans').checked = p.showTranslation;
      $('oRoma').checked = p.showRoma;
      // 2) 立刻生效（主题选择是最直观的操作，不该还要求再点一次保存）
      var label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : sel.value;
      var r = await api({ action: 'setOverlay', overlay: collectOverlay() });
      if (r.ok) {
        log('info', '主题已切到「' + label + '」并即时生效'
          + '（翻译' + (p.showTranslation ? '开' : '关') + '）'
          + ' —— 想加翻译可以再单独勾选后点保存');
      }
    });

    // 滑杆本身的读数提示：拖动时就跟着变（不落盘，落盘在 change 里）
    ['oTheme', 'oSize', 'oOpacity', 'oColor', 'oActive', 'oStroke', 'oStrokeW', 'oBackdrop',
      'oBdColor', 'oOffset', 'oTrans', 'oRoma', 'oCard', 'oScaleFont'].forEach(function (id) {
      var e = $(id);
      if (!e) return;
      e.addEventListener('input', function () {
        $('oSizeTxt').textContent = $('oSize').value + 'px';
        $('oOpTxt').textContent = $('oOpacity').value + '%';
        $('oBdTxt').textContent = Number($('oBackdrop').value) === 0 ? '关' : $('oBackdrop').value + '%';
        $('oSwTxt').textContent = strokeHint($('oStrokeW').value, $('oSize').value);
      });
    });

    /* --------------------------------------------------------- 播放器信息栏表单 */
    function collectInfoBar() {
      return {
        enabled: $('ibEnabled').checked,
        position: $('ibPos').value,
        theme: $('ibTheme').value,
        scale: Number($('ibScale').value) / 100,
        opacity: Number($('ibOpacity').value) / 100,
        coverSize: Number($('ibCoverSize').value),
        width: Number($('ibWidth').value),
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
      $('ibWidth').value = b.width || 360;
      $('ibWidthTxt').textContent = $('ibWidth').value + 'px';
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

    on('btnSaveInfoBar', 'click', async function () {
      var r = await api({ action: 'setOverlay', overlay: { infoBar: collectInfoBar() } });
      if (r.ok) log('info', '信息栏设置已应用（立即生效）');
    });

    /**
     * **信息栏的每个控件改完就即时生效**（2026-09-26 加）。
     *
     * 起因（用户反馈）："信息卡片好像不像歌词那样能修改选项之后实时更新"。
     * 这里原来是"改完必须点「应用并保存」" —— 而歌词那边的主题下拉是改一下就变，
     * 于是对比之下信息卡片显得"改了没反应"。现在两边一致：**改一下立刻生效**，
     * 「应用并保存」按钮保留（把当前所有勾选一次性落盘，行为不变）。
     *
     * 为什么监听 `change` 而不是 `input`：滑杆的 `input` 在拖动过程中会连发几十次，
     * 每次 `setOverlay` 都要 `saveConfig` 落盘 —— 那是几十次磁盘写。
     * `change` 只在松手（或勾选框/下拉变化）时发一次，正好一次拖拽一次落盘。
     */
    var INFO_BAR_IDS = [
      'ibEnabled', 'ibPos', 'ibTheme', 'ibScale', 'ibOpacity', 'ibCoverSize', 'ibWidth', 'ibAccent',
      'ibCover', 'ibRequester', 'ibSource', 'ibProgress', 'ibTime', 'ibUpNext', 'ibBiliStats', 'ibHideIdle',
    ];
    INFO_BAR_IDS.forEach(function (id) {
      var e = $(id);
      if (!e) return;
      e.addEventListener('change', async function () {
        var r = await api({ action: 'setOverlay', overlay: { infoBar: collectInfoBar() } });
        if (!r.ok) log('error', '信息栏设置应用失败：' + ((r.result && r.result.msg) || r.error || '未知'));
      });
    });
    ['ibScale', 'ibOpacity', 'ibCoverSize', 'ibWidth'].forEach(function (id) {
      var e = $(id);
      if (e) e.addEventListener('input', function () {
        $('ibScaleTxt').textContent = $('ibScale').value + '%';
        $('ibOpTxt').textContent = $('ibOpacity').value + '%';
        $('ibCoverTxt').textContent = $('ibCoverSize').value + 'px';
        $('ibWidthTxt').textContent = $('ibWidth').value + 'px';
      });
    });

    return { fillOverlayForm: fillOverlayForm };
  };
})();
