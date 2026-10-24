'use strict';
/**
 * 「审核诊断」面里的两块：测试中心 / 自检、演练 / 注入。
 *
 * ── 段 2 的模块契约（后面每个面照这个搬） ────────────────────────────────
 * 1. 模块只往 `window.__nekofmFaces` 上挂一个 `init(ctx)`，**不自己碰 DOM 结构**，
 *    也不 import 任何东西（零构建、零依赖，靠 `<script>` 顺序加载）。
 * 2. `ctx` 是宿主（`assets/control.js`）注入的唯一入口，目前只有五项：
 *      $     getElementById
 *      api   发指令，返回解析后的响应体
 *      log   写运行日志（level + 文本）
 *      on    按元素 id 绑事件
 *      esc   HTML 转义
 *    任何模块**不得**直接读宿主里的其它内部变量 —— 需要新能力就加进 ctx，
 *    这样"这个面依赖宿主什么"永远是显式的一行，而不是靠作用域碰巧能拿到。
 * 3. `init` 返回一个对象，交出宿主还需要主动调用的方法（这里是 `loadTestGroups`）；
 *    宿主拿到空对象也不会崩 —— 模块缺席时报错要**响亮**，不能静默少一块功能。
 * 4. 零构建的取舍：这些文件是普通 `<script>`，共享一个全局作用域，所以每个文件都
 *    自己套一层 IIFE，绝不污染 `window` 上除 `__nekofmFaces` 以外的名字。
 * ─────────────────────────────────────────────────────────────────────
 */
(function () {
  var faces = window.__nekofmFaces = window.__nekofmFaces || {};

  faces.ops = function initOps(ctx) {
    var $ = ctx.$;
    var api = ctx.api;
    var log = ctx.log;
    var on = ctx.on;
    var esc = ctx.esc;

    /* ---------------------------------------------------------- 测试中心 */
    var tcGroups = [];

    var tcMark = function (ok) { return ok === true ? '✅' : ok === null ? '⏭️' : '❌'; };

    function renderTcResults(res) {
      var box = $('tcResults');
      box.innerHTML = '';
      if (!res || !res.results) return;
      var lastGroup = null;
      res.results.forEach(function (r) {
        if (r.groupName !== lastGroup) {
          lastGroup = r.groupName;
          var h = document.createElement('div');
          h.innerHTML = '<b>' + esc(r.groupName) + '</b>';
          h.style.marginTop = '6px';
          box.appendChild(h);
        }
        var d = document.createElement('div');
        d.className = r.ok === false ? 'error' : (r.ok === null ? 'info' : '');
        d.textContent = tcMark(r.ok) + ' ' + r.name +
          (r.detail ? ' → ' + r.detail : '') + (r.ms ? ' (' + r.ms + 'ms)' : '');
        box.appendChild(d);
      });
      $('tcSummary').textContent = '通过 ' + res.passed + ' / 失败 ' + res.failed +
        ' / 跳过 ' + res.skipped + '（共 ' + res.total + '，' + res.ms + 'ms）';
    }

    async function runTests(groups) {
      var includeNetwork = $('tcNet').checked;
      $('tcSummary').textContent = '运行中…';
      log('info', '开始自检' + (includeNetwork ? '（含联网项）' : '') + '…');
      var r = await api({ action: 'runTests', groups: groups || null, includeNetwork: includeNetwork });
      var res = r.result;
      if (!res) { log('error', '自检未返回结果'); return; }
      renderTcResults(res);
      log(res.failed ? 'error' : 'info',
        '自检完成：通过 ' + res.passed + ' / 失败 ' + res.failed + ' / 跳过 ' + res.skipped);
    }

    on('tcRunAll', 'click', function () { runTests(null); });

    async function loadTestGroups() {
      var r = await api({ action: 'testList' });
      tcGroups = (r.result && r.result.groups) || [];
      var box = $('tcGroups');
      box.innerHTML = '';
      tcGroups.forEach(function (g) {
        var b = document.createElement('button');
        var netOnly = g.checks.every(function (c) { return c.net; });
        b.textContent = g.name + '（' + g.checks.length + '）' + (netOnly ? '·需联网' : '');
        b.title = g.desc || '';
        b.onclick = function () { runTests([g.id]); };
        box.appendChild(b);
      });
    }

    /* ------------------------------------------------------- 演练 / 注入 */
    var demoTimer = null;

    on('btnDemoStart', 'click', async function () {
      var r = await api({ action: 'demoStart', seconds: 120 });
      var res = r.result || {};
      if (res.ok) {
        $('demoStat').textContent = '演示中（' + res.seconds + 's，' + res.lines + ' 行歌词）';
        log('info', '演示模式已开启 —— 叠加层现在应显示歌词与信息栏');
        clearInterval(demoTimer);
        demoTimer = setInterval(async function () {
          var s = await api({ action: 'demoStatus' });
          if (!(s.result && s.result.running)) {
            clearInterval(demoTimer);
            $('demoStat').textContent = '已结束';
          }
        }, 3000);
      } else log('error', '演示启动失败：' + (res.msg || ''));
    });

    on('btnDemoStop', 'click', async function () {
      await api({ action: 'demoStop' });
      clearInterval(demoTimer);
      $('demoStat').textContent = '已结束';
    });

    on('btnInject', 'click', async function () {
      var text = $('injText').value.trim();
      if (!text) return;
      var r = await api({ action: 'injectDanmaku', text: text, uname: '测试观众', isAdmin: $('injAdmin').checked });
      var res = r.result || {};
      if (res.ok) log('info', '已注入弹幕：' + text + (res.notices && res.notices[0] ? ' → ' + res.notices[0] : ''));
      else log('error', '注入失败：' + (res.msg || ''));
      $('injText').value = '';
    });

    on('injText', 'keydown', function (e) { if (e.key === 'Enter') $('btnInject').click(); });

    return { loadTestGroups: loadTestGroups, runTests: runTests };
  };
})();
