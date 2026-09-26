/**
 * 指令分发（不依赖 Electron，便于 headless 测试与复用）
 * =====================================================
 * 所有来自 HTTP /api/command 的动作都从这里走。
 * 与桌面相关的动作（显示窗口等）通过 hooks 注入，headless 模式下自然降级为空操作。
 */
'use strict';

const { deepMerge } = require('../core/config');

/** 对外输出配置时抹掉 cookie，避免在 UI/日志里泄露 */
function redact(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  if (c.netease) c.netease.cookie = c.netease.cookie ? '（已配置）' : '';
  if (c.bilibili) c.bilibili.cookie = c.bilibili.cookie ? '（已配置）' : '';
  // 开放平台的 secret 同样不能回显到界面（前端只用来判断"填过没有"）
  if (c.bilibili && c.bilibili.openLive) {
    const ol = c.bilibili.openLive;
    ol.accessKeySecret = ol.accessKeySecret ? '（已配置）' : '';
  }
  return c;
}

/**
 * 给列表项挂上**缓存现状**（2026-09-26）。
 *
 * 为什么在服务端一次算完：列表动辄几十上百行，每行发一次 `cacheSongInfo`
 * 就是几十次 HTTP 往返 + 几十次磁盘 stat。这里在返回列表时顺带算好，
 * 界面直接读 `it.cache` 即可。
 *
 * 形状：`{ cache: { audio:{cached,mb,at}, lyrics:{cached,lines,kb,savedAt}, key } }`
 */
function withCacheInfo(engine, items = []) {
  if (!items.length) return items;
  return items.map((it) => ({ ...it, cache: engine.cacheInfo(it.song) }));
}

/**
 * 把"会等很久"的动作变成**立刻回执**（2026-09-26）。
 *
 * 为什么必须这样：HTTP/1.1 下浏览器对同一 host 只有 6 条并发连接。
 * 一个 `skip` 要等整首歌联网加载完（可能几十秒）才返回，就把连接占住了；
 * 几条长命令一叠，播放核心每 100ms 的进度上报就没连接可用 →
 * 界面表现为"播放器失去响应、进度条不动"。
 *
 * 默认不等待（`accepted: true`），状态交给 SSE 推送。
 * 需要最终结果的调用方（测试 / CLI 脚本）传 `cmd.wait = true` 即可拿到原返回值。
 *
 * @param {Promise<any>} promise 真正的动作
 * @param {{wait?:boolean}} cmd 命令体
 * @param {string} note 立刻回执里的一句提示
 * @param {object} [extra] 额外带进立刻回执的字段（界面要立刻用、又不必等动作完成的东西）
 */
function fireAndForget(promise, cmd = {}, note = '', extra = null) {
  if (cmd && cmd.wait) return promise;
  const p = Promise.resolve(promise);
  p.catch((e) => { /* 动作失败会在引擎里 notify，这里只吞掉未捕获拒绝 */ void e; });
  return { ok: true, accepted: true, msg: note, ...(extra || {}) };
}

/**
 * @param {{engine:object, saveConfig:Function, hooks?:object, onConfigChange?:Function}} deps
 * @returns {(cmd:object)=>Promise<any>}
 */
function createCommandHandler({ engine, saveConfig = () => {}, hooks = {}, onConfigChange = () => {} }) {
  /**
   * 防抖落盘。**专给音量滑块用**：拖动时会连续触发 `setVolume`（每次都要写回配置），
   * 直接每次都 `saveConfig` 就是几十次磁盘写。停手约 800ms 后落一次盘即可。
   */
  let _saveTimer = null;
  const saveConfigDebounced = (ms = 800) => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => { try { saveConfig(engine.config); } catch { /* 忽略 */ } }, ms);
  };

  return async function handleCommand(cmd = {}) {
    const { action } = cmd;
    switch (action) {
      // ------------------------------------------------ 播放器窗口回填
      // seq 必须透传：engine 用它做"这份状态是不是当前这一首"的过期判定
      // （不带 seq 就退化成旧的字符串判断，切歌瞬间状态会互相覆盖）
      case 'playerPosition':
        engine.onPlayerEvent({ type: 'position', position: cmd.position, duration: cmd.duration, seq: cmd.seq });
        return { ok: true };
      case 'playerStatus':
        engine.onPlayerEvent({ type: 'status', status: cmd.status, duration: cmd.duration, error: cmd.error, seq: cmd.seq });
        return { ok: true };
      case 'playerDevices':
        engine.playerDevices = cmd.devices || [];
        return { ok: true, count: engine.playerDevices.length };

      // ------------------------------------------------ 播放控制
      // 从控制台/HTTP 发起的切歌一律视为"工具本地操作"，无条件放行
      //
      /**
       * ⚠️ 播放控制必须**立刻回执**，绝不能等整首歌加载完（2026-09-26 修）。
       *
       * 踩过的坑（"播放器点不动、进度条不动"的真凶）：
       * `skip`/`prev`/`playSaved` 内部会 await 完整的 `load()` ——
       * 联网取直链 + 匹配歌词，慢的时候几秒甚至几十秒。HTTP 请求就这么
       * **占着一条连接**等。而浏览器对同一个 host 只给 **6 条并发连接**，
       * 播放核心每 100ms 又要 POST 一次播放进度 —— 几条长命令一占，
       * 连接池就满了：后续所有命令（包括进度上报、暂停、切歌）全部排队，
       * 用户看到的就是"播放器失去响应"。
       *
       * 解决：命令处理器**不 await**，立刻返回 `{ok, accepted:true}`。
       * 状态本来就通过 SSE 10Hz 推给界面，界面根本不需要等这个 HTTP 响应。
       * 引擎内部仍然会按顺序正确执行（`load()` 有 `_loadSeq` 处理抢占）。
       *
       * 需要拿到最终结果的调用方（测试、CLI）可以传 `cmd.wait = true`。
       */
      case 'skip': return fireAndForget(
        engine.skip({ uname: cmd.uname || '控制台' }, { local: true }), cmd, '已切歌');
      case 'prev': return fireAndForget(engine.prev(), cmd, '已回到上一首');
      case 'pause': engine.pause(); return { ok: true };
      case 'resume': engine.resume(); return { ok: true };
      case 'togglePlay': {
        /**
         * 播放 / 暂停切换。**返回真实的最终状态**（2026-09-26 修）。
         *
         * 原来无条件 `return { ok: true, status: engine.playback.status }` ——
         * 而 resume() 那时会无条件把状态写成 playing，于是"什么都没有时点播放"
         * 也回报 playing（用户报告：顶栏状态变成了 playing 但没声音）。
         * 现在 resume()/pause() 会如实反映（可能什么都没做），这里照实回报。
         */
        const r = engine.playback.status === 'playing' ? engine.pause() : engine.resume();
        return {
          ok: true, status: engine.playback.status,
          did: (r && r.ok) ? 'ok' : (r && r.reason) || 'noop',
        };
      }
      case 'seek': engine.seek(cmd.position); return { ok: true };
      /**
       * 音量 / 静音**都要写回配置**（下次启动按这个恢复）。
       * 音量拖动是高频的 → 走防抖落盘；静音是低频点击 → 直接落盘。
       */
      case 'setVolume':
        engine.setVolume(cmd.volume);
        saveConfigDebounced();
        return { ok: true };
      case 'setMuted': {
        const r = engine.setMuted(cmd.muted);
        saveConfig(engine.config);
        return r;
      }
      case 'toggleMute': {
        const r = engine.setMuted(!engine.muted);
        saveConfig(engine.config);
        return r;
      }
      case 'setPlayMode': {
        const r = engine.setPlayMode(cmd.mode);
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'setDevice': {
        engine.setDevice(cmd.deviceId, cmd.deviceLabel);
        saveConfig(engine.config);   // 不落盘的话重启就丢，用户会以为"自己变回去了"
        return { ok: true, deviceId: cmd.deviceId || '', deviceLabel: cmd.deviceLabel || '' };
      }

      // ------------------------------------------------ 队列操作
      case 'queueMove': return engine.moveInQueue(Number(cmd.index), cmd.where || 'top');
      case 'blacklistFromQueue': {
        const r = engine.blacklistFromQueue(Number(cmd.index), cmd.type || null);
        if (r.ok) saveConfig(engine.config);
        return r;
      }

      // 播放核心窗内部真实状态（排查"没声音 / 一直 loading"用）
      case 'playerDiag': return hooks.playerDiag ? hooks.playerDiag() : { ok: false, msg: 'headless 模式无播放核心窗口' };
      case 'windowsDiag': return hooks.windowsDiag ? hooks.windowsDiag() : { ok: false, msg: 'headless 模式无窗口' };
      /** 歌词匹配缓存（排障用：怀疑缓存了错误结果时清掉） */
      /** 网易云登录状态（昵称/VIP），让界面能给出确定答案 */
      case 'neteaseStatus': return engine.neteaseStatus();
      case 'lyricCacheClear': {
        const n = engine.clearLyricCache();
        return { ok: true, removed: n };
      }

      // ------------------------------------------------ 收藏
      case 'toggleFavorite': {
        const song = cmd.song || engine.track;
        const r = engine.toggleFavorite(song);
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'listFavorites': return { ok: true, favorites: engine.listFavorites(), count: (engine.config.favorites || []).length };

      // ------------------------------------------------ 闲时歌单
      case 'setIdle': {
        const r = engine.setPlayModeIdle(cmd.patch || {});
        saveConfig(engine.config);
        return r;
      }
      case 'getIdle': return { ok: true, idle: engine.config.idle || { enabled: false } };

      // ------------------------------------------------ 直播状态 / 列表页
      /** 开播/下播：下播存列表，开播把已保存列表当闲时歌单 */
      case 'setStreaming': {
        const r = engine.setStreaming(cmd.on);
        saveConfig(engine.config);
        return r;
      }
      case 'listSaved': return {
        ok: true,
        items: withCacheInfo(engine, engine.listSaved()),
        count: (engine.config.savedPlaylist || []).length,
      };
      /** 把已保存歌单当本地歌单直接播放（待机时想放点东西） */
      case 'playSaved': {
        /**
         * 先做**同步前置检查**并如实返回，别让它被"立刻回执"吞掉。
         *
         * 踩过的坑（2026-09-26，用户报"点播放已保存歌单，出现 第 undefined/undefined 首"）：
         * 这条路走的是 fireAndForget —— 回执在真实动作跑完前就返回了，
         * 所以 (a) 回执里根本没有 from/total，按钮上就显示成了 `undefined/undefined`；
         * (b) `playSaved` 里"直播中 / 列表为空"这类**立刻就能判断**的失败
         *     也被同一个回执吞掉，界面只会显示"已开始播放"然后什么都不发生。
         * 现在：能同步判断的失败直接返回（界面 toast 提示），能同步算出的
         * from/total 直接放进回执。
         */
        const guard = engine.playSavedGuard ? engine.playSavedGuard() : null;
        if (guard) return guard;

        const total = (engine.config.savedPlaylist || []).length;
        const from = Math.max(1, Math.min(Number(cmd.from) || 1, total));
        // 同样不能等：内部要走完整 load()（联网取流 + 匹配歌词），
        // 等它就等于占着一条连接几十秒（见 fireAndForget 注释）。
        // 配置落盘挂在 promise 的 then 上，不阻塞回执。
        const p = engine.playSaved({ from: Number(cmd.from) || 1 })
          .then((r) => {
            if (r && r.ok) { try { saveConfig(engine.config); } catch { /* 忽略 */ } }
            // 异步阶段才发现的失败（比如那一行被黑名单滤掉、取不到可播曲目）
            // 回执早就发出去了，只能走 notify 让用户看得见 —— 绝不能静默。
            else if (r && !r.ok) engine.notify('warn', r.msg || '播放「已保存播放列表」失败');
            return r;
          });
        /**
         * from/total 给的是「**用户点的行号 / 列表长度**」—— 与界面行号一致，
         * 而且能同步算出来。点整张歌单时（cmd.from 没给）**不谎称"第 1 首"**，
         * 用 0 表示"没说具体哪一行" —— 真实落点由引擎随后 notify
         * （那里有真实的 idx+1/总数 + 歌名）。
         */
        return fireAndForget(p, cmd, '已开始播放', { from: Number(cmd.from) ? from : 0, total });
      }
      case 'queueSaved': {
        const r = engine.queueSaved({ clearFirst: !!cmd.clearFirst });
        return r;
      }
      // 任意列表项的管理动作（当前列表/已播放/已保存共用同一套）
      case 'savedAdd': {
        /**
         * 三种入参任选（2026-09-26 补 key）：
         *   · song  —— 完整对象（已播放/已保存列表用，那边本来就带 song）
         *   · key   —— 去重键（**队列项用这个**：queue.list() 刻意不带 song，
         *              靠 engine.findQueueSong 回查，待播项和在放项都能命中）
         *   · index —— 待播项序号（保底）
         */
        const song = cmd.song
          || (cmd.key ? engine.findQueueSong(cmd.key) : null)
          || (cmd.index != null ? (engine.queue.items[cmd.index - 1] || {}).song : null);
        const r = engine.savedAdd(song, cmd);
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'savedRemove': {
        const r = engine.savedRemoveAt(cmd.index);
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'historyRemove': return engine.historyRemoveAt(cmd.index);
      /** 从某个来源整批加入已保存列表（收藏/本地曲库/已导入歌单） */
      case 'savedPullFrom': {
        const r = await engine.savedPullFrom(cmd.source, { playlistId: cmd.playlistId });
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'savedAddMany': {
        const r = engine.savedAddMany(cmd.songs || [], cmd);
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'blacklistSong': {
        const r = engine.blacklistSong(cmd.song, cmd.type || null);
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'clearSaved': {
        const r = engine.clearSaved();
        saveConfig(engine.config);
        return r;
      }
      case 'listHistory': return {
        ok: true,
        items: withCacheInfo(engine, engine.listHistory(cmd.limit || 200)),
        count: engine.history.length,
      };
      case 'clearHistory': return engine.clearHistory();
      /** 缓存根目录（音频/封面/歌词都在它下面），留空 = 程序目录下的 data/cache */
      case 'setCacheDir': {
        const r = engine.setCacheDir(cmd.dir);
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'cacheDirInfo': return {
        ok: true,
        dir: engine.cache.dir,
        configured: (engine.config.cache && engine.config.cache.dir) || '',
        defaultDir: require('node:path').join(require('../core/config').configPath().dir, 'cache'),
      };

      // ------------------------------------------------ 单曲缓存管理（2026-09-26）
      /**
       * 某一首的缓存现状（音频 / 歌词分开报）。
       * 列表行用它显示角标，按需刷新时也用它。
       */
      case 'cacheSongInfo': return { ok: true, info: engine.cacheInfo(cmd.song) };
      /** 删除某一首的缓存（音频 + 歌词）。正在播的那首音频会被占用，见 engine.cacheDrop */
      case 'cacheSongDrop': return engine.cacheDrop(cmd.song);
      /** 手动缓存某一首（音频 + 歌词）。已缓存的那半会自动跳过，相当于"补齐缺失的部分" */
      case 'cacheSongFetch': return engine.cacheFetch(cmd.song);
      /** 只清歌词、保留音频（音频几十 MB 要重下，歌词删了几乎零代价） */
      case 'cacheClearLyrics': return engine.cacheClearLyrics();
      /** 按缓存键批量删除（缓存列表勾选删除） */
      case 'cacheDropKeys': return engine.cacheDropKeys(cmd.keys || []);
      /** dryRun=true 只统计（界面先告知"将清理 N 首 / X MB"，确认后再真删） */
      case 'cacheDropOrphans': return engine.cacheDropOrphans({ dryRun: !!cmd.dryRun });
      /** 批量缓存：source=saved（已保存列表）/ history（已播放）。后台串行跑，立即返回 */
      case 'cachePrefetch': return engine.cachePrefetch({ source: cmd.source || 'saved', limit: cmd.limit || 200 });

      // ------------------------------------------------ 媒体缓存
      case 'cacheStats': return { ok: true, ...engine.cache.stats() };
      /** 缓存条目全量列表（按需读取；`limit<=0` = 全部）。`cacheStats` 只有摘要，不含列表 */
      case 'cacheList': return engine.cache.list({ limit: cmd.limit || 0, offset: cmd.offset || 0 });
      case 'cacheClear': {
        const r = await engine.cache.clear();
        engine.emit('change');
        return r;
      }
      case 'cacheToggle': {
        engine.cache.enabled = cmd.enabled !== false;
        engine.config.cache = { ...(engine.config.cache || {}), enabled: engine.cache.enabled };
        saveConfig(engine.config);
        engine.emit('change');
        return { ok: true, enabled: engine.cache.enabled };
      }

      // ------------------------------------------------ 点歌
      case 'order': {
        const who = { uid: 'console', uname: '控制台', isAnchor: true };
        // 直接点了某首（搜索结果/候选按钮）→ 不再搜索，直接入队
        if (cmd.song) return engine.orderSong(cmd.song, who, { force: !!cmd.force });
        /**
         * 关键词点歌**要等结果**（界面要显示"没找到"或候选列表）。
         * 但它内部会联网搜索 —— 为了不让连接池被占住，只对
         * "控制台里连着点好几首歌"这种场景做保护：加一个上限超时，
         * 超时就先回"还在搜"，别把连接一直挂着。
         */
        const search = engine.orderByKeyword(cmd.keyword, cmd.source, who, { interactive: true });
        const timeout = new Promise((resolve) => setTimeout(
          () => resolve({ ok: true, pending: true, msg: '还在搜索，稍候看通知栏' }), 8000));
        return Promise.race([search, timeout]);
      }
      case 'orderVideo': return engine.orderVideo(cmd.target, { uid: 'console', uname: '控制台', isAnchor: true });
      case 'remove': return engine.queue.remove(cmd.index, { uid: 'console', isAnchor: true });
      case 'clearQueue': return engine.queue.clear();

      // ------------------------------------------------ 弹幕
      case 'connectDanmaku': {
        const roomId = cmd.roomId || engine.config.bilibili.roomId;
        await engine.connectDanmaku(roomId);
        engine.config.bilibili.roomId = String(roomId);
        saveConfig(engine.config);
        return { ok: true, room: engine.danmaku && engine.danmaku.roomId };
      }
      case 'disconnectDanmaku': engine.disconnectDanmaku(); return { ok: true };

      /**
       * 切换弹幕通道：`openlive`（官方开放平台）/ `browser`（系统浏览器）。
       * 立即按新通道重连，不用重启。
       */
      case 'setDanmakuMode': {
        const mode = cmd.mode === 'browser' ? 'browser' : 'openlive';
        engine.config.bilibili.danmakuMode = mode;
        saveConfig(engine.config);
        const rid = cmd.roomId || engine.config.bilibili.roomId;
        await engine.connectDanmaku(rid);
        return { ok: true, mode, room: engine.danmaku && engine.danmaku.roomId };
      }

      /**
       * 保存 B站官方直播开放平台的凭据（`bilibili.openLive`）。
       * 传 `enabled: true` 会立即按新配置重连，方便填完就验（不对再改）。
       */
      case 'setOpenLive': {
        const cur = engine.config.bilibili.openLive || {};
        const pick = (v, fallback) => (v != null ? String(v).trim() : (fallback || ''));
        const next = {
          enabled: cmd.enabled != null ? !!cmd.enabled : !!cur.enabled,
          accessKeyId: pick(cmd.accessKeyId, cur.accessKeyId),
          accessKeySecret: pick(cmd.accessKeySecret, cur.accessKeySecret),
          appId: pick(cmd.appId, cur.appId),
          roomOwnerAuthCode: pick(cmd.roomOwnerAuthCode, cur.roomOwnerAuthCode),
        };
        engine.config.bilibili.openLive = next;
        saveConfig(engine.config);
        const shown = { ...next, accessKeySecret: next.accessKeySecret ? '***' : '' };
        if (next.enabled) {
          const rid = cmd.roomId || engine.config.bilibili.roomId;
          await engine.connectDanmaku(rid);
          engine.config.bilibili.roomId = String(rid);
          saveConfig(engine.config);
          return { ok: true, openLive: shown, room: engine.danmaku && engine.danmaku.roomId };
        }
        return { ok: true, openLive: shown };
      }

      // ------------------------------------------------ 网易云
      case 'neteaseQrCreate': return engine.netease.qrCreate();
      case 'neteaseQrCheck': {
        const r = await engine.netease.qrCheck(cmd.key);
        if (r.ok) {
          engine.config.netease.cookie = engine.netease.cookie;
          saveConfig(engine.config);
        }
        return r;
      }
      case 'neteaseSetCookie': {
        engine.netease.cookie = cmd.cookie || '';
        engine.config.netease.cookie = engine.netease.cookie;
        saveConfig(engine.config);
        const acc = await engine.netease.account();
        return { ok: true, loggedIn: engine.netease.isLoggedIn, profile: acc && acc.profile };
      }
      case 'neteaseMyPlaylists': return engine.netease.myPlaylists();
      case 'neteaseBrowserLogin': return hooks.neteaseBrowserLogin
        ? hooks.neteaseBrowserLogin()
        : { ok: false, msg: '浏览器登录需要 Electron 运行环境' };
      case 'neteaseBrowserLogout': return hooks.neteaseBrowserLogout
        ? hooks.neteaseBrowserLogout()
        : { ok: false, msg: '浏览器登出需要 Electron 运行环境' };

      // ------------------------------------------------ B站登录态（视频字幕要用）
      /**
       * 直接粘 SESSDATA / 整条 cookie。**这是登录的兜底路径** ——
       * 登录窗（biliBrowserLogin）依赖 Electron 且要过 B站对自动化环境的检测，
       * 粘贴框在 headless 下也能用，且一定通得过。
       */
      case 'biliSetCookie': {
        const r = await engine.biliSetCookie(cmd.cookie || '');
        saveConfig(engine.config);
        return r;
      }
      case 'biliBrowserLogin': return hooks.biliBrowserLogin
        ? hooks.biliBrowserLogin()
        : { ok: false, msg: '登录窗需要 Electron 运行环境；请改用 SESSDATA 粘贴框' };
      case 'biliBrowserLogout': return hooks.biliBrowserLogout
        ? hooks.biliBrowserLogout()
        : { ok: false, msg: '登出需要 Electron 运行环境' };
      /**
       * 原来的 `neteaseLoadPlaylist` 已删（2026-09-26）：它只做"整单入队"，
       * 而且 limit 默认 200、界面还硬传 50 —— 100+ 首的歌单点一下只进 50 首，
       * 容易被当成"歌单导丢了"。现在统一走 `playlistImport`：
       * 默认汇入「已保存播放列表」，要排队列就传 `autoQueue: true`，
       * 两条路都取全量、都会过黑名单、都会记录导入信息。
       */
      case 'neteaseSearch': return engine.netease.search(cmd.keyword || '', { limit: cmd.limit || 20 });

      // ------------------------------------------------ 歌单导入
      case 'playlistImport': {
        const r = await engine.importPlaylist({
          input: cmd.input,
          limit: cmd.limit || 0,
          filterBlacklist: cmd.filterBlacklist !== false,
          /**
           * 默认**汇入「已保存播放列表」**（导入是备货，不该盖掉观众点的歌）；
           * 只有界面显式要求"整单排进队列"时才 autoQueue。
           */
          toSaved: cmd.toSaved !== false,
          autoQueue: !!cmd.autoQueue,
        });
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'playlistList': return { ok: true, playlists: (engine.config.playlists && engine.config.playlists.imported) || [] };
      case 'playlistQueue': {
        const r = await engine.requeuePlaylist(cmd.id, {
          limit: cmd.limit || 0,
          filterBlacklist: cmd.filterBlacklist !== false,
        });
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'playlistRemove': {
        const r = engine.removeImportedPlaylist(cmd.id);
        if (r.ok) saveConfig(engine.config);
        return r;
      }
      case 'playlistResolve': return engine.netease.resolvePlaylistId(cmd.input);

      // ------------------------------------------------ 黑名单 / 审核
      case 'blacklistList': return { ok: true, ...engine.blacklist.list() };
      case 'blacklistAdd': {
        const r = engine.blacklist.add({ type: cmd.type, value: cmd.value, note: cmd.note });
        if (r.ok) { engine.syncBlacklistToConfig(); saveConfig(engine.config); engine.emit('change'); }
        return r;
      }
      case 'blacklistRemove': {
        const r = engine.blacklist.remove(cmd.id);
        if (r.ok) { engine.syncBlacklistToConfig(); saveConfig(engine.config); engine.emit('change'); }
        return r;
      }
      case 'blacklistClear': {
        const r = engine.blacklist.clear();
        engine.syncBlacklistToConfig();
        saveConfig(engine.config);
        engine.emit('change');
        return r;
      }
      case 'blacklistToggle': {
        engine.blacklist.enabled = cmd.enabled !== false;
        engine.syncBlacklistToConfig();
        saveConfig(engine.config);
        engine.emit('change');
        return { ok: true, enabled: engine.blacklist.enabled };
      }
      /** 一键拉黑：不传 song 时用"当前正在播放的那首" */
      case 'blacklistBlockTrack': {
        const song = cmd.song || engine.track;
        if (!song) return { ok: false, msg: '当前没有可拉黑的曲目' };
        const r = engine.blockTrack(song, { asKeyword: !!cmd.asKeyword, note: cmd.note });
        if (r.ok) { engine.syncBlacklistToConfig(); saveConfig(engine.config); engine.emit('change'); }
        return r;
      }
      /** 拉黑后立刻把队列里同类的清掉（可选，默认开） */
      case 'blacklistPurgeQueue': {
        let removed = 0;
        for (let i = engine.queue.items.length - 1; i >= 0; i--) {
          const it = engine.queue.items[i];
          if (engine.blacklist.check(it.song).blocked) { engine.queue.items.splice(i, 1); removed++; }
        }
        engine.queue.emit('change', engine.queue.list());
        engine.emit('change');
        return { ok: true, removed };
      }

      // ------------------------------------------------ 本地音乐
      /**
       * 打开本地音乐文件。
       * 有 Electron 时弹原生多选对话框；headless 下允许直接传 paths（便于脚本/测试）。
       */
      case 'localOpenFiles': {
        let paths = cmd.paths;
        if (!paths || !paths.length) {
          if (!hooks.pickLocalFiles) {
            return { ok: false, msg: '当前是 headless 模式（无原生对话框），请改用 localOpenFiles + paths 传绝对路径' };
          }
          const picked = await hooks.pickLocalFiles();
          if (!picked.ok) return picked;
          paths = picked.paths;
        }
        return engine.openLocalFiles(paths, { enqueue: cmd.enqueue !== false, play: cmd.play !== false });
      }
      case 'localOpenFolder': {
        let dirs = cmd.dirs;
        if (!dirs || !dirs.length) {
          if (!hooks.pickLocalFolder) {
            return { ok: false, msg: '当前是 headless 模式（无原生对话框），请改用 localOpenFolder + dirs 传绝对路径' };
          }
          const picked = await hooks.pickLocalFolder();
          if (!picked.ok) return picked;
          dirs = picked.dirs;
        }
        const results = [];
        for (const d of dirs) results.push(await engine.openLocalFolder(d));
        saveConfig(engine.config);
        const okCount = results.filter((r) => r.ok).length;
        return { ok: okCount > 0, results, total: engine.local.tracks.length };
      }
      case 'localList': return engine.listLocal(cmd.keyword || '', { limit: cmd.limit || 200, offset: cmd.offset || 0 });
      case 'localRemoveFolder': {
        const r = engine.removeLocalFolder(cmd.dir);
        if (r.ok) { saveConfig(engine.config); engine.local.scan({ force: true }).catch(() => {}); }
        return r;
      }
      /** 直接把一个已经在曲库里的本地曲目加入队列/播放 */
      case 'localQueue': {
        const t = engine.local.tracks.find((x) => x.file === cmd.file);
        if (!t) return { ok: false, msg: '曲库里没有这个文件' };
        const r = engine.queue.push({ ...t, source: 'local' }, { uid: 'console', uname: cmd.uname || '控制台', isAnchor: true }, { urgent: !!cmd.urgent });
        if (r.ok && !engine.track) engine.next().catch(() => {});
        engine.emit('change');
        return r;
      }
      case 'localRescan': {
        const t = await engine.local.scan({ force: true });
        return { ok: true, count: t.length };
      }
      case 'localSearch': return { ok: true, results: engine.local.search(cmd.keyword || '', cmd.limit || 30) };

      // ------------------------------------------------ 测试中心 / 演练
      case 'testList': return { ok: true, groups: engine.selftest ? engine.selftest.listGroups() : [] };
      case 'runTests': {
        if (!engine.selftest) return { ok: false, msg: '测试中心未初始化（需要在带 server 的环境里运行）' };
        return engine.selftest.run({ groups: cmd.groups, includeNetwork: !!cmd.includeNetwork });
      }
      case 'demoStart': return engine.startDemo({ seconds: cmd.seconds == null ? 45 : cmd.seconds });
      case 'demoStop': return engine.stopDemo();
      case 'demoStatus': return { ok: true, running: engine.demoRunning };
      /** 注入一条假弹幕，用来验证点歌指令链路（不依赖真实直播间） */
      case 'injectDanmaku': {
        if (!cmd.text) return { ok: false, msg: '缺少 text' };
        await engine.handleDanmaku({
          uid: cmd.uid || 'selftest-user',
          uname: cmd.uname || '测试观众',
          text: cmd.text,
          isAdmin: !!cmd.isAdmin,
          /**
           * 标记"这是控制台注入的测试弹幕"。
           * `handleDanmaku` 在**未直播时一律不处理指令**（用户要求指令只在直播中生效），
           * 但这条是用来测指令链路的，必须放行 —— 否则测试工具会被直播状态挡住。
           */
          injected: true,
        });
        return { ok: true, notices: engine.notices.slice(0, 3).map((n) => n.text) };
      }

      // ------------------------------------------------ 配置
      case 'setOverlay': {
        engine.config.overlay = deepMerge(engine.config.overlay, cmd.overlay || {});
        saveConfig(engine.config);
        onConfigChange(engine.config.overlay);
        return { ok: true, overlay: engine.config.overlay };
      }
      case 'setConfig': {
        engine.config = deepMerge(engine.config, cmd.patch || {});
        saveConfig(engine.config);
        onConfigChange(engine.config.overlay);
        // 点歌规则改了要**立刻作用到运行中的队列**，否则改了不生效（非重启不可）
        engine.applyQueueConfig();
        /**
         * 曲库目录也要**立刻同步给运行中的 LocalLibrary**（2026-09-26 修）。
         *
         * 踩过的坑：控制台「保存目录」按钮走的就是这个 setConfig，
         * 但 `LocalLibrary` 的 `dirs` 是构造时读进去的 —— setConfig 只改了
         * `engine.config`，没通知它。于是"保存了目录 → 点扫描 → 还是 0 首"，
         * 非重启不生效（实测定位到）。
         */
        if (cmd.patch && cmd.patch.local && cmd.patch.local.dirs) {
          engine.local.dirs = (engine.config.local.dirs || []).filter(Boolean);
        }
        return { ok: true };
      }
      case 'getConfig': return { ok: true, config: redact(engine.config) };

      // ------------------------------------------------ 窗口 / 外壳
      case 'showOverlayWindow': return hooks.showOverlay ? hooks.showOverlay(cmd.mode) : { ok: false, msg: 'headless 模式无窗口' };
      case 'showControlWindow': return hooks.showControl ? hooks.showControl() : { ok: false, msg: 'headless 模式无窗口' };
      case 'hideOverlayWindow': return hooks.hideOverlay ? hooks.hideOverlay(cmd.mode) : { ok: false, msg: 'headless 模式无窗口' };
      case 'showPlayerWindow': return hooks.showPlayer ? hooks.showPlayer() : { ok: false, msg: 'headless 模式无窗口' };
      case 'openExternal': return hooks.openExternal ? hooks.openExternal(cmd.url) : { ok: true };
      case 'quit': return hooks.quit ? hooks.quit() : { ok: false };

      default: throw new Error('未知指令：' + action);
    }
  };
}

module.exports = { createCommandHandler, redact };
