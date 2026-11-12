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
      // 尺寸交给 `.qr img` 那条 CSS（inline 会盖掉它，图就撑出白块压到下面的说明上）
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
      cap.style.cssText = 'max-width:156px;text-align:center;margin-top:4px';
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

    // ---------------------------------------------------------------- 酷狗扫码
    /**
     * 与网易云那张卡的差别（2026-11-12）：**登录不是必需**。
     * 网易云不登录，会员曲被截成 45 秒；酷狗免登录就给免费曲全曲，
     * 登录只解决「自己有酷狗会员，想让会员曲也放」。所以这里的文案一律
     * 说"可选"，不写"必需"——写错了会让人以为不登录就用不了酷狗。
     */
    let kqTimer = null;
    on('kqQr', 'click', async () => {
      const r = await api({ action: 'kugouQrCreate' });
      const res = (r && r.result) || {};
      if (!r || !r.ok || !res.ok) {
        log('error', '酷狗二维码生成失败：' + (res.msg || (r && r.error) || '未知错误'));
        return;
      }
      const box = $('kqBox');
      box.hidden = false;
      box.innerHTML = '';
      const img = document.createElement('img');
      // 酷狗直接回 `data:image/png;base64,…`，不用像网易云那样借 api.qrserver.com 画图
      img.src = res.img;
      img.alt = '酷狗扫码登录二维码';
      // 同上：不写 inline 尺寸，白块与图由 CSS 统一决定
      box.appendChild(img);
      const cap = document.createElement('div');
      cap.className = 'tip';
      cap.style.cssText = 'max-width:156px;text-align:center;margin-top:4px';
      cap.textContent = '酷狗 App 扫一扫 → 手机上点确认';
      box.appendChild(cap);

      $('kqStat').textContent = '等待扫码…';
      clearInterval(kqTimer);
      kqTimer = setInterval(async () => {
        const c = await api({ action: 'kugouQrCheck', key: res.key });
        const d = (c && c.result) || {};
        if (d.ok) {
          clearInterval(kqTimer);
          box.hidden = true;
          $('kqStat').textContent = '✅ 登录成功' + (d.nickname ? `：${d.nickname}` : '');
          log('ok', '酷狗登录成功，token 已保存' + (d.nickname ? `（${d.nickname}）` : ''));
          await showKugouStatus(true);
        } else {
          $('kqStat').textContent = d.msg || '等待扫码…';
          if (d.code === 0) clearInterval(kqTimer); // 0 = 二维码过期
        }
      }, 2000);
    });

    on('kqStatus', 'click', () => showKugouStatus(false));

    on('kqLogout', 'click', async () => {
      if (!await confirmDialog('登出酷狗账号？\n\n只清掉配置里的 token/userid；\n免费曲不受影响，会员曲会重新变成「需要付费」。')) return;
      await api({ action: 'kugouLogout' });
      log('info', '已登出酷狗');
      await showKugouStatus(true);
    });

    /** 查询并显示酷狗登录态（pill + 卡片里的说明） */
    async function showKugouStatus(quiet = false) {
      const el = $('kqStatusText');
      if (el && !quiet) el.textContent = '正在查询…';
      const r = await api({ action: 'kugouStatus' });
      const d = (r && r.result) || {};
      const pill = $('stKugou');
      if (pill) {
        pill.dataset.verified = '1'; // 核验过就以核验结果为准，别被 100ms 的状态广播覆盖
        pill.textContent = d.loggedIn ? '酷狗 已登录' : '酷狗 未登录';
        pill.className = 'pill ' + (d.loggedIn ? 'ok' : 'off');
      }
      if (el) {
        /*
         * 和网易云那条**同一套句式**（「已登录：昵称（UID …）· 权益」），
         * 两边并排看时才分得清谁是谁。酷狗没有免密会员查询，会员态靠样本曲
         * 试取流推出来，所以另外两种情况必须如实写"推不出来"，不能一律写"已登录"。
         */
        const who = d.nickname ? `${d.nickname}（UID ${d.uid || '?'}）`
          : (d.uid ? `UID ${d.uid}` : '账号');
        el.textContent = !d.loggedIn
          ? '❌ 未登录：免费曲照常播全曲；会员曲会明确报「需要付费」。'
          : `✅ 已登录：${who}`
            + (d.vip === 'yes' ? ' · 会员权益有效'
              : d.vip === 'no' ? ' · 非会员（会员曲仍会报「需要付费」）'
                : ' · 会员状态未知（样本曲探测失败），以实际播放为准');
      }
      return d;
    }

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
      /**
       * 酷狗：只按"配置里有没有 token"给出**待核验**的初值。
       * 真正权威的状态要 `/api/state`（或点「检测登录状态」）—— 这里不假装已核验。
       */
      if (config.kugou) {
        const has = !!config.kugou.cookie;
        const pill = $('stKugou');
        if (pill) {
          pill.textContent = has ? '酷狗 已登录' : '酷狗 未登录';
          pill.className = 'pill ' + (has ? 'ok' : 'off');
        }
        const el = $('kqStatusText');
        if (el) {
          const who = config.kugou.nickname
            ? `${config.kugou.nickname}（UID ${config.kugou.userId || '?'}）`
            : (config.kugou.userId ? `UID ${config.kugou.userId}` : '账号');
          el.textContent = has
            ? `配置里有 ${who} 的 token —— 点「检测登录状态」核验；会员曲以实际播放为准。`
            : '❌ 未登录：免费曲照常播全曲；会员曲会明确报「需要付费」。';
        }
      }
    }

    return { refreshDevices, checkNeteaseStatus, fillFromConfig };
  }

  window.__nekofmFaces = window.__nekofmFaces || {};
  window.__nekofmFaces.account = init;
})();
