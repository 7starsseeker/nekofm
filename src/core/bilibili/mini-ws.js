/**
 * 极简 WebSocket 客户端 + B站直播封包协议
 * ==========================================
 * 谁在用：
 *   - `browser-channel.js`（连本机 CDP）
 *   - `open-live.js`（连 B站官方直播开放平台的长连）
 *
 * 为什么不用全局 `WebSocket`：**Electron 33 内置的是 Node 20，没有全局 WebSocket**
 * （Node 22 才默认提供）。用全局对象会让这两条通道被 Electron 版本绑死；
 * 为一个"连本机明文 ws"的需求去升 Electron 也不划算。
 *
 * `encode` / `decode` 与 `danmaku.js` 里那套是**同一份协议**
 * （16 字节大端头：pack_len / header_size=16 / ver / op / seq），
 * 网页端与开放平台长连都用它，所以这里实现一次、两边共用。
 */
'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// ---------------------------------------------------------------- 协议包
const OP = {
  HEARTBEAT: 2, HEARTBEAT_REPLY: 3, MESSAGE: 5,
  AUTH: 7, AUTH_REPLY: 8,
};

/**
 * 打一个 B站弹幕协议包。
 * @param {number} op 操作码
 * @param {object|string|Buffer} [body] 对象→JSON；字符串→UTF-8 原样（`auth_body` 就是这种）；
 *                                      Buffer→原样；不传→空包体
 * @param {number} [ver=1]
 */
function encode(op, body, ver = 1) {
  let payload;
  if (body === undefined || body === null) payload = Buffer.alloc(0);
  else if (Buffer.isBuffer(body)) payload = body;
  else if (typeof body === 'string') payload = Buffer.from(body, 'utf8');
  else payload = Buffer.from(JSON.stringify(body), 'utf8');

  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + payload.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(ver, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);
  return Buffer.concat([head, payload]);
}

/** 把一坨 buffer 拆成 `[{op, ver, body}]`，自动解 zlib/brotli 并递归展开内嵌包 */
function decode(buf) {
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
      try { body = zlib.inflateSync(body); out.push(...decode(body)); } catch { /* 坏包忽略 */ }
    } else if (ver === 3) {
      try { body = zlib.brotliDecompressSync(body); out.push(...decode(body)); } catch { /* 坏包忽略 */ }
    } else {
      out.push({ op, ver, body });
    }
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------- WS 客户端
/**
 * 最小可用的 WebSocket 客户端（客户端帧必须 mask；服务端帧不 mask）。
 * 只实现两条通道真正用到的部分：文本/二进制收发、open/message/error/close 事件、close。
 */
class MiniWebSocket {
  constructor(url) {
    this._listeners = { open: [], message: [], error: [], close: [] };
    this._buf = Buffer.alloc(0);
    this._opened = false;
    const u = new URL(url);
    const isTls = u.protocol === 'wss:';
    const port = Number(u.port) || (isTls ? 443 : 80);
    const key = crypto.randomBytes(16).toString('base64');

    const onConnected = () => {
      this._sock.write([
        `GET ${u.pathname}${u.search || ''} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'));
    };

    if (isTls) {
      const tls = require('node:tls');
      this._sock = tls.connect({ host: u.hostname, port, servername: u.hostname }, onConnected);
    } else {
      this._sock = net.connect({ host: u.hostname, port }, onConnected);
    }
    this._sock.on('error', (e) => this._emit('error', e));
    this._sock.on('close', () => this._emit('close', {}));
    this._sock.on('data', (d) => this._onData(d));
  }

  addEventListener(type, fn) { if (this._listeners[type]) this._listeners[type].push(fn); }

  _emit(type, ev) {
    for (const fn of this._listeners[type] || []) {
      try { fn(ev); } catch { /* 监听器自己的异常不该拖垮连接 */ }
    }
  }

  /**
   * 发送一帧。**按数据类型自动选 opcode**：
   *   - `Buffer` → **二进制帧**（B站弹幕协议包就是二进制）
   *   - 字符串   → **文本帧**（CDP 的 JSON 只认文本帧）
   *
   * ⚠️ 这里必须区分：早先写死二进制帧，连 CDP 时服务端会**直接断开连接**
   * （表现是 `open` 之后立刻 `close`、请求永远等不到响应），而调试时用
   * Node 22+ 的全局 WebSocket 又完全正常，所以特别容易漏掉。
   */
  send(data) {
    if (!this._opened) return;
    try {
      const isBuf = Buffer.isBuffer(data);
      const payload = isBuf ? data : Buffer.from(String(data), 'utf8');
      this._sock.write(frame(payload, isBuf ? 2 : 1));
    } catch { /* 忽略 */ }
  }

  close() { try { this._sock.destroy(); } catch { /* 忽略 */ } }

  _onData(d) {
    this._buf = Buffer.concat([this._buf, d]);
    if (!this._opened) {
      const i = this._buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const status = this._buf.subarray(0, i).toString().split('\r\n')[0];
      if (!/ 101 /.test(status)) {
        this._emit('error', new Error('WebSocket 握手失败: ' + status));
        try { this._sock.destroy(); } catch { /* 忽略 */ }
        return;
      }
      this._buf = this._buf.subarray(i + 4);
      this._opened = true;
      this._emit('open', {});
    }
    const { frames, rest } = parseFrames(this._buf);
    this._buf = rest;
    for (const f of frames) {
      if (f.opcode === 2 || f.opcode === 1) this._emit('message', { data: f.payload });
      else if (f.opcode === 8) { this._emit('close', {}); try { this._sock.destroy(); } catch { /* 忽略 */ } }
    }
  }
}

/** 客户端→服务端的帧必须 mask */
function frame(payload, opcode) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(6); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(8); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(14); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  const mask = crypto.randomBytes(4);
  mask.copy(head, head.length - 4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, body]);
}

function parseFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b1 = buf[off + 1];
    const opcode = buf[off] & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mk = null;
    if (masked) { mk = buf.subarray(p, p + 4); p += 4; }
    if (p + len > buf.length) break;      // 帧不完整，等下一批数据
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mk) for (let i = 0; i < len; i++) payload[i] ^= mk[i & 3];
    out.push({ opcode, payload });
    off = p + len;
  }
  return { frames: out, rest: buf.subarray(off) };
}

/** 有全局 WebSocket 就用它，没有（Node 20 / Electron 33）就用迷你实现 */
const WS_IMPL = typeof WebSocket === 'function' ? WebSocket : MiniWebSocket;

module.exports = { MiniWebSocket, WS_IMPL, encode, decode, OP };
