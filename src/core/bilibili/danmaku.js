/**
 * B站直播间弹幕客户端（Node 原生实现，零依赖）
 * ===========================================
 * 2026-09-25 端到端实测通过：免登录即可收到真实弹幕。
 * 链路：room_init 取真实房间号 → WBI 签名 getDanmuInfo 拿 token+host_list
 *      → WebSocket 连 /sub → 发认证包(op=7) → 30s 心跳(op=2) → 收 op=5 消息
 *
 * 数据包格式（大端）：
 *   16 字节包头: [包长u32][头长u16=16][协议版本u16][操作码u32][序号u32]
 *   协议版本: 0/1=JSON 明文, 2=zlib 压缩(内含多个完整包), 3=brotli 压缩
 *   操作码  : 2=心跳, 3=心跳回应(人气值), 5=通知(弹幕等), 7=认证, 8=认证回应
 */
'use strict';

const { EventEmitter } = require('node:events');
const zlib = require('node:zlib');
const { WbiSigner, biliFetch, UA } = require('./wbi');

const OP = { HEARTBEAT: 2, HEARTBEAT_REPLY: 3, MESSAGE: 5, AUTH: 7, AUTH_REPLY: 8 };
const HEARTBEAT_MS = 30_000;

class DanmakuClient extends EventEmitter {
  /**
   * @param {{roomId:number|string, uid?:number, cookie?:string, external?:boolean, logger?:(...a:any[])=>void}} opts
   */
  constructor(opts = {}) {
    super();
    this.roomInput = opts.roomId;
    this.roomId = null;
    this.cookie = opts.cookie || '';
    /**
     * 观众身份 uid（认证包里的 `uid` 字段）。
     *
     * **必须给上**：填 0 时 B站把这条连接当**游客** —— 表现是收到的弹幕昵称
     * 全被打码（`L***` 这种），于是"靠昵称认主播"直接失效，连观众昵称也看不全
     * （2026-09-26 用户实测反馈："我自己发消息，用户名识别成一堆星号"）。
     * 引擎那边从来没显式传过 uid，等于一直在当游客 —— 所以这里从 cookie 的
     * `DedeUserID` 自己解析一份（扫码登录后它必然在 cookie 里）。
     */
    this.uid = Number(opts.uid) || DanmakuClient.uidFromCookie(this.cookie) || 0;
    this.log = opts.logger || (() => {});
    /**
     * `external: true` —— 连接由外部通道代持（`browser-channel.js` 拉起的
     * 系统 Edge/Chrome，经 CDP 在直播间页面里跑）。此时本类**不**自己取 token、
     * 不自己开 WebSocket，只等 `feed()` 把原始帧送进来做解包与事件分发。
     *
     * 为什么需要这条通道：B站弹幕服务**只认真实浏览器**，Electron 与 Node 直连
     * 一律被拒（2026-09-26 实测，对照数据见 `browser-channel.js` 文件头）。
     * 解包/指令解析没必要跟着搬家，于是把"网络栈"和"解析"拆开。
     */
    this.external = !!opts.external;
    this.signer = new WbiSigner({ log: this.log });
    this.ws = null;
    this.hbTimer = null;
    this.retry = 0;
    this.closedByUser = false;
    this.token = null;
    this.hosts = [];
    this.stats = { received: 0, danmaku: 0, gifts: 0, connects: 0, reconnects: 0, lastAt: 0 };
  }

  // ------------------------------------------------------------ 房间解析
  /**
   * 从 cookie 串里取 `DedeUserID`（B站登录后的用户 uid）。
   * 拿不到就返回 0（未登录 / cookie 过期）—— 调用方据此知道"现在是游客态"。
   */
  static uidFromCookie(cookie) {
    const m = String(cookie || '').match(/(?:^|;\s*)DedeUserID=(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  async resolveRoom() {
    const r = await biliFetch(
      `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(this.roomInput)}`,
      { headers: { Referer: 'https://live.bilibili.com/' } }
    );
    if (!r.ok) throw new Error(`room_init 失败 code=${r.code} msg=${r.msg}`);
    this.roomId = r.data.room_id;
    /**
     * **主播的 uid**（`room_init` 的 `data.uid` 就是房主）。
     *
     * 2026-09-26 加：engine 判定"这条弹幕是主播本人发的"要用它。
     * 在这之前 engine 用的是 `this.anchorUid`，而**那个字段从来没被赋过值** ——
     * 于是"主播特权"整条路是死的：主播自己发指令会被回"需要房管/主播权限"
     * （用户实测反馈："我本身就是主播，但通过直播姬打指令说我没有权限"）。
     * 单靠弹幕里的 `admin` 位（房管标记）不够稳：不同客户端发出来的标记并不一致。
     */
    this.anchorUid = r.data.uid || 0;
    /**
     * 房间的开播状态（0=未开播 1=直播中 2=轮播）。
     *
     * **这个字段很关键**：未开播的房间，弹幕服务**能连上、认证也能过，但不推送任何弹幕**。
     * 2026-09-26 实测：未开播房间 12 秒只收到 3 个包（认证 + 1 个心跳回应）、弹幕 0 条；
     * 同一时刻的直播中房间收到 73 个包 / 46 条弹幕。
     * 用户在下播房间里发点歌指令"没反应"，就是因为它根本没被推过来 —— 不是程序坏了。
     * 界面必须据此说清楚，别让"连接成功"的假象骗人。
     */
    this.liveStatus = r.data.live_status;
    /**
     * **主播昵称**：从公开接口取，不靠弹幕里学。
     *
     * 为什么不能"从主播的第一条弹幕里学"：游客态（未登录/uid 为 0）下 B站把昵称打码
     * （`L***`），学到的就是个面具 —— 更糟的是打码昵称**不唯一**（Luna / Leo 都会是
     * `L***`），拿它当身份判据会把别的观众误认成主播。
     * `get_anchor_in_room` 是公开接口（无需登录），一次拿准。
     */
    this.anchorName = await this._fetchAnchorName();
    const info = {
      roomId: r.data.room_id,
      shortId: r.data.short_id,
      uid: r.data.uid,
      anchorName: this.anchorName,
      liveStatus: r.data.live_status,
      encrypted: r.data.encrypted,
    };
    this.emit('room', info);
    return info;
  }

  /**
   * 取主播昵称（公开接口，尽力而为）。
   * 失败不给脸色：认不出昵称只影响"昵称兜底"这一条判据，uid 那条仍然管用。
   */
  async _fetchAnchorName() {
    try {
      const r = await biliFetch(
        `https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${this.roomId}`,
        { headers: { Referer: 'https://live.bilibili.com/', Cookie: this.cookie } }
      );
      const info = (r.data && r.data.info) || {};
      return (r.ok && info.uname) || '';
    } catch { return ''; }
  }

  // ------------------------------------------------------------ 取弹幕服务器
  async fetchDanmuInfo() {
    const base = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo';
    const params = { id: this.roomId, type: 0, web_location: '444.8' };
    let url = await this.signer.signUrl(base, params);
    let r = await biliFetch(url, { headers: { Referer: 'https://live.bilibili.com/', Cookie: this.cookie } });

    // -352 风控 / -403：刷新 mixin_key 后重试一次
    if (!r.ok && (r.code === -352 || r.code === -403)) {
      this.log('[danmaku] 命中风控 code=' + r.code + '，刷新 WBI 后重试');
      url = await this.signer.signUrl(base, params, true);
      r = await biliFetch(url, { headers: { Referer: 'https://live.bilibili.com/', Cookie: this.cookie } });
    }
    if (!r.ok) throw new Error(`getDanmuInfo 失败 code=${r.code} msg=${r.msg}`);
    this.token = r.data.token;
    this.hosts = r.data.host_list || [];
    if (!this.hosts.length) throw new Error('getDanmuInfo 未返回 host_list');
    return { token: this.token, hosts: this.hosts };
  }

  // ------------------------------------------------------------ 包封装/解析
  static encode(op, body, protoVer = 1) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    const head = Buffer.alloc(16);
    head.writeUInt32BE(16 + payload.length, 0);
    head.writeUInt16BE(16, 4);
    head.writeUInt16BE(protoVer, 6);
    head.writeUInt32BE(op, 8);
    head.writeUInt32BE(1, 12);
    return Buffer.concat([head, payload]);
  }

  /** 把一坨 buffer 拆成 [{op, body}]，自动解 zlib/brotli 并递归展开内嵌包 */
  static decode(buf) {
    const out = [];
    let off = 0;
    while (off + 16 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const headLen = buf.readUInt16BE(off + 4);
      const ver = buf.readUInt16BE(off + 6);
      const op = buf.readUInt32BE(off + 8);
      if (len < 16 || off + len > buf.length) break;
      let body = buf.subarray(off + headLen, off + len);
      if (ver === 2) {
        try { body = zlib.inflateSync(body); out.push(...DanmakuClient.decode(body)); } catch (e) { /* 忽略坏包 */ }
      } else if (ver === 3) {
        try { body = zlib.brotliDecompressSync(body); out.push(...DanmakuClient.decode(body)); } catch (e) { /* 忽略坏包 */ }
      } else {
        out.push({ op, ver, body });
      }
      off += len;
    }
    return out;
  }

  // ------------------------------------------------------------ 连接
  async connect() {
    this.closedByUser = false;
    // 外部通道模式：token 与 WebSocket 都在 Chromium 那边（见构造函数的说明），
    // 这里只把连接状态置为"已交给外部"，具体帧通过 feed() 进来。
    if (this.external) return true;
    if (!this.roomId) await this.resolveRoom();
    await this.fetchDanmuInfo();

    const host = this.hosts[0];
    const url = `wss://${host.host}:${host.wss_port || 443}/sub`;
    this.log(`[danmaku] 连接 ${url}`);

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };

      ws.addEventListener('open', () => {
        this.stats.connects++;
        this.log('[danmaku] 已连接，发送认证包');
        const auth = {
          uid: this.uid,
          roomid: this.roomId,
          protover: 3, // 3=brotli，带宽最省；服务端会按此压缩下发
          /**
           * `buvid` 原本恒为空串。顺手从 cookie 里带上真实的 buvid3 ——
           * 认证包里"uid=0 且 buvid 为空"是最典型的游客画像，正是它让服务端
           * 把昵称打码下发（见 constructor 里 uid 的注释）。
           */
          buvid: (String(this.cookie).match(/(?:^|;\s*)buvid3=([^;]+)/) || [])[1] || '',
          platform: 'web',
          type: 2,
          key: this.token,
        };
        ws.send(DanmakuClient.encode(OP.AUTH, auth));
        this._startHeartbeat();
        this.emit('open', { roomId: this.roomId });
        if (!settled) { settled = true; resolve(true); }
      });

      ws.addEventListener('message', (ev) => this._onMessage(ev));

      ws.addEventListener('error', (e) => {
        // 主动关闭时的 error 属噪声，不上抛
        if (!this.closedByUser) this.emit('error', e);
        fail(new Error('WebSocket 错误'));
      });

      ws.addEventListener('close', (ev) => {
        this.log(`[danmaku] 连接关闭 code=${ev && ev.code}`);
        this._stopHeartbeat();
        this.emit('close', ev);
        if (!this.closedByUser) this._scheduleReconnect();
        fail(new Error('WebSocket 在认证前关闭'));
      });
    });
  }

  /**
   * 外部通道送来的一帧原始数据，等价于原生 WebSocket 的 `message` 事件。
   *
   * 注意心跳：本类的 `_startHeartbeat` 依赖 `this.ws`，外部模式下它是 null，
   * tick 会静默失败 —— 心跳由外部通道自己发（browser.js 里 30s 一次），
   * 这里不要重复发，否则同一条连接会出现两组心跳。
   */
  feed(data) {
    this._onMessage({ data });
  }

  _onMessage(ev) {
    let buf;
    if (ev.data instanceof ArrayBuffer) buf = Buffer.from(ev.data);
    else if (Buffer.isBuffer(ev.data)) buf = ev.data;
    else buf = Buffer.from(String(ev.data), 'utf8');

    let packets;
    try { packets = DanmakuClient.decode(buf); } catch (e) { this.log('[danmaku] 解包失败', e.message); return; }
    for (const p of packets) {
      this.stats.received++;
      if (p.op === OP.HEARTBEAT_REPLY) {
        const popularity = p.body.length >= 4 ? p.body.readUInt32BE(0) : 0;
        this.stats.lastAt = Date.now();
        this.emit('popularity', popularity);
        continue;
      }
      if (p.op !== OP.MESSAGE) continue;
      let obj;
      try { obj = JSON.parse(p.body.toString('utf8')); } catch { continue; }
      this._dispatch(obj);
    }
  }

  _dispatch(obj) {
    const cmd = String(obj.cmd || '');
    if (cmd.startsWith('DANMU_MSG')) {
      this.stats.danmaku++;
      const info = obj.info || [];
      const text = info[1];
      const user = info[2] || [];
      const medal = info[3] || [];
      this.emit('danmaku', {
        type: 'danmaku',
        text,
        uid: user[0],
        uname: user[1],
        isAdmin: !!user[2],
        isVip: !!(user[3] || user[4]),
        medal: medal.length ? { level: medal[0], name: medal[1], anchor: medal[2] } : null,
        level: (info[4] && info[4][0]) || 0,
        timestamp: info[9] || Date.now(),
        raw: obj,
      });
      return;
    }
    if (cmd === 'SUPER_CHAT_MESSAGE' || cmd === 'SUPER_CHAT_MESSAGE_JPN') {
      const d = obj.data || {};
      this.emit('superchat', {
        type: 'superchat', uid: d.uid, uname: d.user_info && d.user_info.uname,
        text: d.message, price: d.price, duration: d.time, raw: obj,
      });
      return;
    }
    if (cmd === 'SEND_GIFT') {
      const d = obj.data || {};
      this.stats.gifts++;
      this.emit('gift', {
        type: 'gift', uid: d.uid, uname: d.uname, gift: d.giftName,
        num: d.num, price: (d.total_coin || 0) / 1000, raw: obj,
      });
      return;
    }
    if (cmd === 'INTERACT_WORD') {
      const d = obj.data || {};
      this.emit('interact', { type: 'interact', uid: d.uid, uname: d.uname, msgType: d.msg_type, raw: obj });
      return;
    }
    this.emit('raw', obj);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    const tick = () => {
      try { this.ws && this.ws.send(DanmakuClient.encode(OP.HEARTBEAT, Buffer.alloc(0))); } catch { /* 忽略 */ }
    };
    tick();
    this.hbTimer = setInterval(tick, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  }

  _scheduleReconnect() {
    this.stats.reconnects++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry++, 5));
    this.log(`[danmaku] ${delay / 1000}s 后重连（第 ${this.stats.reconnects} 次）`);
    setTimeout(() => {
      if (this.closedByUser) return;
      this.connect().catch((e) => this.log('[danmaku] 重连失败:', e.message));
    }, delay);
  }

  close() {
    this.closedByUser = true;
    this._stopHeartbeat();
    try { this.ws && this.ws.close(); } catch { /* 忽略 */ }
    this.ws = null;
  }
}

module.exports = { DanmakuClient, OP };
