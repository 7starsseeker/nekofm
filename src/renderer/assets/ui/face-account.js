/* ==========================================================================
   面模块 · 账号与输出设备（settings 面：网易云登录卡 + 播放核心/输出设备卡）
   --------------------------------------------------------------------------
   契约与 face-ops.js 文件头一致：
     · 只往 `window.__nekofmFaces` 挂一个 `init(ctx)`，不碰页面结构；
     · `ctx` 只有宿主给的那几项，模块不直接读宿主的内部变量；
     · `init` 返回宿主还需要主动调用的方法，缺模块时宿主必须**响亮报错**。
   搬出来的理由：这两张卡是「一次性配置」，和直播流的实时状态无关，
   却是主 IIFE 里最嘈杂的一段（扫码轮询、状态核验、设备下拉签名守卫）。
   ========================================================================== */
(function () {
  'use strict';

  /**
   * @param {{$:Function, api:Function, log:Function, on:Function, confirm:Function}} ctx
   * @returns {{refreshDevices:Function, checkNeteaseStatus:Function, fillFromConfig:Function}}
   */
  function init(ctx) {
    const $ = ctx.$;
    const api = ctx.api;
    const log = ctx.log;
    const on = ctx.on;
    const confirmDialog = ctx.confirm;

    // ---------------------------------------------------------------- 网易云扫码
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
          log('ok', '网易云登录成功，cookie 已保存');
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
      if (!await confirmDialog('登出当前网易云账号？\n\n会清掉：\n  · 浏览器会话的所有登录态\n  · 配置里的 cookie\n\n之后请重新扫码登录。')) return;
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
        log('ok', '网易云登录成功，cookie 已写入配置，会员曲可完整播放');
      } else {
        $('qrStat').textContent = res.msg || '未完成登录';
        log('error', '浏览器登录未完成：' + (res.msg || ''));
      }
    });

    on('btnCookie', 'click', async () => {
      const r = await api({ action: 'neteaseSetCookie', cookie: $('cookie').value.trim() });
      const res = r.result || {};
      log(res.loggedIn ? 'ok' : 'error', res.loggedIn ? '登录成功：' + ((res.profile && res.profile.nickname) || '') : 'cookie 无效或未包含 MUSIC_U');
    });

    // ---------------------------------------------------------------- 播放设备
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

    /** 配置到手后把「已配置」之类的占位文案补上（原来散在 boot() 里） */
    function fillFromConfig(config) {
      if (!config || !config.netease) return;
      if (config.netease.cookie) $('cookie').placeholder = '已配置（留空则不变）';
    }

    return { refreshDevices, checkNeteaseStatus, fillFromConfig };
  }

  window.__nekofmFaces = window.__nekofmFaces || {};
  window.__nekofmFaces.account = init;
})();
