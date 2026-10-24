/**
 * B站官方「直播开放平台」弹幕客户端（open-live.bilibili.com）
 * ==========================================================
 * 定位：**官方长连接通道**，走正规接口拿弹幕，不碰网页端风控、也不需要外部浏览器。
 *
 * 与另外两条通道的关系（`engine.connectDanmaku` 里的优先级）：
 *   1. **本文件（开放平台）** —— 有凭据就用，最稳
 *   2. `browser-channel.js`（系统 Edge + CDP）—— 没有凭据时的兜底，实测可用
 *   3. `danmaku.js` 的 Node 直连 —— 最后的降级（B站风控基本会拒）
 *
 * 为什么值得走官方：网页端那套（`getDanmuInfo` + 公共 WS）B站只认真实浏览器，
 * Electron / Node 一律被判死（详见 browser-channel.js 的对照数据）。官方开放平台
 * 是**给开发者用的**，主播自己授权自己完全合规，且不受网页端风控影响。
 *
 * 前置条件（都要在开放平台后台办）：
 *   - 个人开发者认证 → `access_key_id` / `access_key_secret`
 *   - 创建项目并通过审核 → `app_id`；在项目里生成**主播身份码** → `room_owner_auth_code`
 *   - **消息类型（弹幕 DM 等）需单独向 B站运营申请开通**
 *
 * 协议（对着官方文档 + blivedm 的实现核对过）：
 *   - HTTP：`POST /v2/app/start` → 换 `game_id` + `wss_link` + `auth_body`
 *   - 签名：把 `x-bili-*` 头按字典序用 `\n` 拼起来，HmacSHA256(access_key_secret) 取十六进制
 *   - WS：连 `wss_link` 任一节点，发 AUTH 包（**包体就是 auth_body 原文**，不是 JSON），
 *     之后 30s 一次心跳；**另有 20s 一次的"项目心跳" HTTP 请求**（两套心跳不能混）
 *   - 封包格式与网页端完全一致 → 直接复用 `mini-ws.js` 的 encode/decode
 */
'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WS_IMPL, encode: biliEncode, decode: biliDecode, OP } = require('./mini-ws');

const START_URL = 'https://live-open.biliapi.com/v2/app/start';
const HEARTBEAT_URL = 'https://live-open.biliapi.com/v2/app/heartbeat';
const END_URL = 'https://live-open.biliapi.com/v2/app/end';

/**
 * WS 心跳间隔（连接层）。
 * 官方 demo 用的就是 20 秒；**不要改成网页端那套 30 秒** —— 两端协议虽然一样，
 * 但开放平台的服务端心跳容忍度按它自己的文档走，发稀了有被判死的风险。
 */
const WS_HEARTBEAT_MS = 20_000;
/**
 * 项目心跳间隔（业务层）。**这个不能省**：它对应 `/v2/app/heartbeat`，
 * 超时（code 7003）项目会被关掉，之后连弹幕都收不到，
 * 必须重新 `/v2/app/start`。blivedm 用的是 20 秒。
 */
const GAME_HEARTBEAT_MS = 20_000;

/** 开放平台的消息类型 */
const CMD = {
  DANMAKU: 'LIVE_OPEN_PLATFORM_DM',
  GIFT: 'LIVE_OPEN_PLATFORM_SEND_GIFT',
  SUPER_CHAT: 'LIVE_OPEN_PLATFORM_SUPER_CHAT',
  SUPER_CHAT_DEL: 'LIVE_OPEN_PLATFORM_SUPER_CHAT_DEL',
  GUARD: 'LIVE_OPEN_PLATFORM_GUARD',
  LIKE: 'LIVE_OPEN_PLATFORM_LIKE',
  ENTER: 'LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER',
  LIVE_START: 'LIVE_OPEN_PLATFORM_LIVE_START',
  LIVE_END: 'LIVE_OPEN_PLATFORM_LIVE_END',
};

/** 项目被关掉时 B站返回的码（7000=已关 7003=异常关闭/心跳超时），都要重新 start */
const GAME_CLOSED_CODES = new Set([7000, 7003]);

class OpenLiveClient extends EventEmitter {
  /**
   * @param {{accessKeyId:string, accessKeySecret:string, appId:number|string,
   *          roomOwnerAuthCode:string, logger?:(...a:any[])=>void}} opts
   */
  constructor(opts = {}) {
    super();
    this.accessKeyId = String(opts.accessKeyId || '').trim();
    this.accessKeySecret = String(opts.accessKeySecret || '').trim();
    /**
     * `app_id` 是 **int64**（官方常见问题里专门提醒过"注意这个ID是int64类型的数值，
     * 请开发者换算成自己语言可以支持的数值类型"）。JS 的 Number 只有 53 位精度，
     * 直接 Number() 大 ID 会悄悄变值 → 报 5002。所以这里**原样保留字符串**，
     * 只在确定落在安全整数范围内时才转成数字发给服务端。
     */
    this.appIdRaw = String(opts.appId == null ? '' : opts.appId).trim();
    const asNum = Number(this.appIdRaw);
    this.appId = Number.isSafeInteger(asNum) && asNum > 0 ? asNum : this.appIdRaw;
    this.roomOwnerAuthCode = String(opts.roomOwnerAuthCode || '').trim();
    this.log = opts.logger || (() => {});

    this.roomId = null;         // 主播的真实直播间号（`anchor_info` 里给的）
    this.anchorUid = null;
    this.gameId = null;
    this.authBody = null;
    this.wssLink = [];
    this.ws = null;
    this.closedByUser = false;
    this.stats = {
      received: 0, danmaku: 0, gifts: 0, connects: 0, reconnects: 0, lastAt: 0,
      /**
       * **诊断计数（2026-10-25 加）**。
       *
       * 起因：用户开播后连官方通道，日志里**一点动静都没有** —— 分不清是
       * ①一个 WS 帧都没收到（服务端不投递）②收到了但 cmd 名字变了（我们解析不到）
       * ③收到了、解析了、但被引擎那边的状态挡下。这三种必须能一眼区分。
       */
      opCounts: Object.create(null),    // op 值 → 帧数（5=消息 3=心跳回执 8=认证回执）
      cmdCounts: Object.create(null),   // cmd 名 → 条数
      unknownCmds: [],                  // 见过但不认识的 cmd（每条只记一次）
    };
    this._hbTimer = null;
    this._gameTimer = null;
    this._watchTimer = null;
  }

  /** 凭据是否齐全（engine 用它决定走不走这条通道） */
  get ready() {
    return !!(this.accessKeyId && this.accessKeySecret && this.appId && this.roomOwnerAuthCode);
  }

  // ---------------------------------------------------------------- 签名
  /**
   * 按官方标准生成签名头。
   *
   * **头的插入顺序就是签名顺序**（`x-bili-accesskeyid` → `content-md5` →
   * `signature-method` → `signature-nonce` → `signature-version` → `timestamp`），
   * 恰好也是字典序；拼串用 `\n` 连接、每项 `key:value`。改顺序就会签名不通过。
   */
  _signedHeaders(bodyBytes) {
    const headers = {
      'x-bili-accesskeyid': this.accessKeyId,
      'x-bili-content-md5': crypto.createHash('md5').update(bodyBytes).digest('hex'),
      'x-bili-signature-method': 'HMAC-SHA256',
      'x-bili-signature-nonce': crypto.randomUUID().replace(/-/g, ''),
      'x-bili-signature-version': '1.0',
      'x-bili-timestamp': String(Math.floor(Date.now() / 1000)),
    };
    const strToSign = Object.entries(headers).map(([k, v]) => `${k}:${v}`).join('\n');
    const signature = crypto.createHmac('sha256', this.accessKeySecret).update(strToSign).digest('hex');
    return { ...headers, Authorization: signature, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  async _post(url, body) {
    const bodyBytes = Buffer.from(JSON.stringify(body), 'utf8');
    const r = await fetch(url, { method: 'POST', headers: this._signedHeaders(bodyBytes), body: bodyBytes });
    let j;
    try { j = await r.json(); } catch { throw new Error(`${url} 返回非 JSON（HTTP ${r.status}）`); }
    return j;
  }

  // ---------------------------------------------------------------- 连接
  async connect() {
    this.closedByUser = false;
    if (!this.ready) throw new Error('开放平台凭据不完整（需要 access_key_id / secret、app_id、主播身份码）');

    const started = await this._post(START_URL, { code: this.roomOwnerAuthCode, app_id: this.appId });
    if (started.code !== 0) {
      throw new Error(`开启项目失败 code=${started.code} ${started.message || ''}`
        + (started.code === 7003 ? '（项目已被关闭/心跳超时）' : ''));
    }
    const data = started.data || {};
    /**
     * `game_id` **要当字符串用**：官方 demo 里是 `str(game_info.game_id)`，
     * 后面心跳/end 的请求体也是按字符串拼的（`{"game_id":"..."}`）。
     * 这里统一 String() 一下，免得某次响应给的是数字、拼进 JSON 就变成了数值类型。
     */
    this.gameId = data.game_info && data.game_info.game_id != null
      ? String(data.game_info.game_id) : null;
    this.authBody = (data.websocket_info && data.websocket_info.auth_body) || null;
    this.wssLink = (data.websocket_info && data.websocket_info.wss_link) || [];
    const anchor = data.anchor_info || {};
    this.roomId = anchor.room_id || null;
    this.anchorUid = anchor.uid || null;
    if (!this.authBody || !this.wssLink.length) throw new Error('start 响应缺少 auth_body / wss_link');

    /**
     * 顺手拿一次**真实开播状态**。
     *
     * `start` 成功只代表"项目开启成功"，**不代表主播在播** —— 把前者当成后者
     * 会让界面在未开播时显示"直播中"，而 B站未开播是不推弹幕的，
     * 于是排查时会绕远路（我自己就绕了一圈）。`room_init` 没有客户端识别，
     * 直连即可。
     */
    const liveStatus = await this._fetchLiveStatus(this.roomId);

    this.emit('room', {
      roomId: this.roomId, uid: this.anchorUid,
      openId: anchor.open_id, gameId: this.gameId, liveStatus,
    });
    this.log(`[open-live] 项目已开启 game_id=${this.gameId} 房间=${this.roomId} live_status=${liveStatus}`);
    this._startGameHeartbeat();

    await this._connectWs();
    this._startWatch();
    return true;
  }

  /** 查房间真实开播状态（0 未开播 / 1 直播中 / 2 轮播）；查不到返回 null */
  async _fetchLiveStatus(roomId) {
    if (!roomId) return null;
    try {
      const r = await fetch(
        `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`,
        { headers: { Referer: 'https://live.bilibili.com/' } }
      );
      const j = await r.json();
      return j && j.data ? j.data.live_status : null;
    } catch { return null; }
  }

  async _connectWs() {
    // 列表里随便挑一个（B站给的都是等价节点）
    const url = this.wssLink[0];
    this.log(`[open-live] 连接弹幕长连 ${url}`);
    const ws = new WS_IMPL(url);
    /**
     * ⚠️ **必须显式设 `binaryType = 'arraybuffer'`**（2026-10-25 修的真 bug）。
     *
     * `mini-ws.js` 的 `WS_IMPL` 在「运行时自带全局 WebSocket」时会用全局实现
     * （Node 22+ 才有；Electron 33 = Node 20 没有，所以升到 Electron 43 之后
     * 这条路**悄悄换了实现**）。全局 WebSocket 的 `event.data` 对二进制帧默认是
     * **`Blob`**，而下面的适配只认 Buffer / ArrayBuffer / 字符串 —— 于是每帧都被
     * 转成 `"[object Blob]"`，解出来 0 个包 ⇒ `received` 一直是 0，**日志里一条错都没有**。
     *
     * 症状就是用户报的：「开播了、连上了官方通道、状态也对，但一条弹幕都收不到」。
     * A/B 实测：同一份代码同一套凭据，Node 20 收到 `op8×1 op3×2`，Node 24 收到 0 帧。
     */
    try { if ('binaryType' in ws) ws.binaryType = 'arraybuffer'; } catch { /* 手写实现没有这个属性，忽略 */ }
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };

      ws.addEventListener('open', () => {
        this.stats.connects++;
        // 包体**直接是 auth_body 原文**（B站给的字符串），不要再 JSON 包装一层
        ws.send(biliEncode(OP.AUTH, this.authBody));
        this._startWsHeartbeat();
        this.emit('open', { roomId: this.roomId });
        if (!settled) { settled = true; resolve(true); }
      });
      ws.addEventListener('message', (ev) => {
        const raw = ev && ev.data;
        let buf;
        if (Buffer.isBuffer(raw)) buf = raw;
        else if (raw instanceof ArrayBuffer) buf = Buffer.from(raw);
        else if (typeof Blob !== 'undefined' && raw instanceof Blob) {
          // 全局 WebSocket 默认就是这条（binaryType 没生效时的兜底，别再静默丢帧）
          raw.arrayBuffer()
            .then((ab) => this._onPacket(Buffer.from(ab)))
            .catch((e) => this.log('[open-live] 读取 Blob 帧失败', e && e.message));
          return;
        } else buf = Buffer.from(String(raw), 'utf8');
        this._onPacket(buf);
      });
      ws.addEventListener('error', (e) => {
        if (!this.closedByUser) this.emit('error', e);
        fail(new Error('长连错误'));
      });
      ws.addEventListener('close', () => {
        this._stopWsHeartbeat();
        this.emit('close', {});
        if (!this.closedByUser) this._scheduleReconnect();
        fail(new Error('长连在认证前关闭'));
      });
    });
  }

  _onPacket(buf) {
    let packets;
    try { packets = biliDecode(buf); } catch (e) { this.log('[open-live] 解包失败', e.message); return; }
    for (const p of packets) {
      this.stats.received++;
      this.stats.opCounts[p.op] = (this.stats.opCounts[p.op] || 0) + 1;
      if (p.op === OP.HEARTBEAT_REPLY) { this.stats.lastAt = Date.now(); this.emit('popularity', 0); continue; }
      if (p.op === OP.AUTH_REPLY) {
        let code = null;
        try { code = JSON.parse(p.body.toString('utf8')).code; } catch { /* 非 JSON */ }
        /**
         * ⚠️ 开放平台的 AUTH_REPLY **同样是 `{"code":0}` 的形式**，但网页端那套的
         * code 0 代表"认证通过"；这里如果拿到非 0 就要重开项目（token 失效）。
         */
        if (code !== null && code !== 0) {
          this.log(`[open-live] 认证被拒 code=${code}，重开项目`);
          this._restartGame();
        }
        continue;
      }
      if (p.op !== OP.MESSAGE) continue;
      let obj;
      try { obj = JSON.parse(p.body.toString('utf8')); } catch { continue; }
      this._dispatch(obj);
    }
  }

  /** 把开放平台的消息映射成引擎认的弹幕结构（与网页端 `danmaku.js` 的字段对齐） */
  _dispatch(obj) {
    const cmd = String(obj.cmd || '');
    const d = obj.data || {};
    this.stats.cmdCounts[cmd] = (this.stats.cmdCounts[cmd] || 0) + 1;
    if (cmd === CMD.DANMAKU) {
      this.stats.danmaku++;
      this.emit('danmaku', {
        type: 'danmaku',
        text: d.msg,
        /**
         * 开放平台**不给 B站 uid**，给的是 `open_id`（同一开发者下的用户唯一标识）。
         * 用它当 uid 足够 —— 队列里"点歌本人可切歌"只要求同一来源内一致，
         * 而且两边都是字符串比较。
         */
        uid: d.open_id,
        uname: d.uname,
        isAdmin: d.is_admin === 1,
        isVip: false,
        medal: d.fans_medal_level
          ? { level: d.fans_medal_level, name: d.fans_medal_name, anchor: false }
          : null,
        level: d.glory_level || 0,
        timestamp: (d.timestamp || 0) * 1000 || Date.now(),
        raw: obj,
      });
      return;
    }
    if (cmd === CMD.GIFT) {
      this.stats.gifts++;
      this.emit('gift', { type: 'gift', uid: d.open_id, uname: d.uname, gift: d.gift_name, num: d.gift_num, price: d.price, raw: obj });
      return;
    }
    if (cmd === CMD.SUPER_CHAT) {
      this.emit('superchat', { type: 'superchat', uid: d.open_id, uname: d.uname, text: d.message, price: d.rmb, raw: obj });
      return;
    }
    if (cmd === CMD.GUARD) {
      this.emit('guard', { type: 'guard', uid: d.open_id, uname: (d.user_info && d.user_info.uname) || d.uname, level: d.guard_level, raw: obj });
      return;
    }
    if (cmd === CMD.LIKE) {
      this.emit('like', { type: 'like', uid: d.open_id, uname: d.uname, raw: obj });
      return;
    }
    /**
     * **下播/开播事件**（2026-10-25 加）。B站在长连里会推这两个，以前我们
     * 只靠 30 秒轮询去发现开播 —— 有推送就该立即用上。
     */
    if (cmd === CMD.LIVE_START) { this.emit('liveStart', { roomId: this.roomId, raw: obj }); return; }
    if (cmd === CMD.LIVE_END) { this.emit('liveEnd', { roomId: this.roomId, raw: obj }); return; }
    if (!this.stats.unknownCmds.includes(cmd)) {
      this.stats.unknownCmds.push(cmd);
      // 只记一次：真出现"改名"这一种情况时，这行就是证据
      this.log(`[open-live] 收到未处理的 cmd=${cmd || '(空)'}（已记下，不影响其它消息）`);
    }
    this.emit('raw', obj);
  }

  // ---------------------------------------------------------------- 心跳
  _startWsHeartbeat() {
    this._stopWsHeartbeat();
    const tick = () => { try { this.ws && this.ws.send(biliEncode(OP.HEARTBEAT)); } catch { /* 忽略 */ } };
    tick();
    this._hbTimer = setInterval(tick, WS_HEARTBEAT_MS);
  }

  _stopWsHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  }

  _startGameHeartbeat() {
    this._stopGameHeartbeat();
    this._gameTimer = setInterval(() => { this._sendGameHeartbeat().catch(() => {}); }, GAME_HEARTBEAT_MS);
  }

  _stopGameHeartbeat() {
    if (this._gameTimer) { clearInterval(this._gameTimer); this._gameTimer = null; }
  }

  async _sendGameHeartbeat() {
    if (!this.gameId || this.closedByUser) return;
    const r = await this._post(HEARTBEAT_URL, { game_id: this.gameId });
    if (r.code !== 0) {
      this.log(`[open-live] 项目心跳失败 code=${r.code} ${r.message || ''}`);
      if (GAME_CLOSED_CODES.has(r.code)) this._restartGame();
    }
  }

  /**
   * **长连健康看门狗**（2026-10-25 加）。
   *
   * 用户的真实困惑：「开播了、连上了官方通道、也能看到状态在直播中，但日志里
   * 一条弹幕都没有」—— 到底是服务端没投递、还是 cmd 改名了、还是被状态挡了？
   * 这个问题不该靠猜：
   *   - 连上 25 秒后 `received === 0` ⇒ 服务端**一个帧都没发**（最可能是开放平台
   *     的「弹幕消息类型(DM)」没开通，长连照样能建、但服务器不推任何业务消息）
   *   - 有帧但 `cmdCounts` 里没有 DM ⇒ cmd 名字对不上（那条 unknownCmds 日志就是证据）
   *   - 有 DM ⇒ 通道正常，问题在引擎侧（那边有「未直播已忽略弹幕」的日志可对）
   *
   * 之后每 60 秒打一次统计，让"有没有在收"这件事在日志里可见。
   */
  _startWatch() {
    this._stopWatch();
    const t0 = Date.now();
    this._watchTimer = setInterval(() => {
      if (this.closedByUser) return;
      const sec = Math.round((Date.now() - t0) / 1000);
      const st = this.stats;
      if (st.received === 0) {
        if (sec >= 25 && !this._warnedSilent) {
          this._warnedSilent = true;
          this.log(`[open-live] ⚠ ${sec} 秒内一个 WS 帧都没收到（连上了但没有数据）。`
            + `开放平台的「弹幕消息类型(DM)」未开通时就是这个现象 —— 长连能建、服务器不推任何业务消息`);
        }
        return;
      }
      const ops = Object.entries(st.opCounts).map(([k, v]) => `op${k}×${v}`).join(' ');
      const cmds = Object.entries(st.cmdCounts).map(([k, v]) => `${k || '(空)'}×${v}`).join(' ');
      this.log(`[open-live] 长连统计 ${sec}s：帧 ${st.received}［${ops}］弹幕 ${st.danmaku}｜cmd ${cmds || '（暂无业务消息）'}`);
    }, 60_000);
    if (this._watchTimer.unref) this._watchTimer.unref();
    setTimeout(() => {
      if (this.closedByUser) return;
      if (this.stats.received === 0 && !this._warnedSilent) {
        this._warnedSilent = true;
        this.log('[open-live] ⚠ 连上 25 秒仍一个 WS 帧都没收到。开放平台的「弹幕消息类型(DM)」'
          + '未开通时就是这个现象：长连能建、服务器不推任何业务消息。'
          + '（申请：QQ 群 642908379 或邮件 live-open@bilibili.com）');
      }
    }, 25_000).unref?.();
  }

  _stopWatch() {
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
  }

  /** 供 engine 在「直播间开播」时调用：在开播状态下重开一次项目，DM 会话才绑得上 */
  async restartForLive() {
    this._warnedSilent = false;
    this.log('[open-live] 检测到直播间开播 → 重开项目，让弹幕会话按"直播中"重新建立');
    await this._restartGame();
  }

  /**
   * 项目失效（心跳超时 / token 过期）时重开。
   * 注意要先把旧的 WS 与心跳停掉，否则会和新的连接互相打架。
   */
  async _restartGame() {
    if (this.closedByUser) return;
    this._stopGameHeartbeat();
    this._stopWsHeartbeat();
    this._stopWatch();
    try { if (this.ws) this.ws.close(); } catch { /* 忽略 */ }
    this.ws = null;
    this.log('[open-live] 重新开启项目…');
    try {
      await this.connect();
      this.stats.reconnects++;
    } catch (e) {
      this.log('[open-live] 重开项目失败:', e.message);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.closedByUser) return;
    this.stats.reconnects++;
    const delay = Math.min(60_000, 3000 * 2 ** Math.min(this.stats.reconnects, 4));
    this.log(`[open-live] ${Math.round(delay / 1000)}s 后重连（第 ${this.stats.reconnects} 次）`);
    setTimeout(() => { if (!this.closedByUser) this._restartGame(); }, delay);
  }

  /** 收工：关长连 + 通知 B站关闭项目（不调 end 的话短时间内连不上同一个房间） */
  async stop() {
    this.closedByUser = true;
    this._stopWsHeartbeat();
    this._stopGameHeartbeat();
    this._stopWatch();
    try { if (this.ws) this.ws.close(); } catch { /* 忽略 */ }
    this.ws = null;
    if (this.gameId) {
      const gameId = this.gameId;
      this.gameId = null;
      try { await this._post(END_URL, { app_id: this.appId, game_id: gameId }); } catch { /* 忽略 */ }
    }
  }

  /** 与 DanmakuClient 的接口对齐，便于 engine 无差别地替换（见 engine.connectDanmaku） */
  close() { this.stop().catch(() => {}); }
}

module.exports = { OpenLiveClient, CMD };
