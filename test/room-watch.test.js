/**
 * 开播状态轮询（2026-10-25）
 *
 * 这条测试覆盖一个**用户实测撞到的界面错觉**：
 * 直播间明明开播了、官方通道的弹幕点歌也能用，控制台里「直播间状态」却一直写着
 * 「未开播（不收弹幕）」—— 因为 `live_status` 只在**连接那一刻**查过一次，
 * 之后再没刷新过（`open-live.js:167` / `danmaku.js:98`）。
 *
 * 修法：连上弹幕后每 30 秒查一次，变化时更新界面 + 发一条提示。
 * 这里直接调被拆出来的 `_pollRoomLive()`（不等定时器），验证三件事：
 *   1. 状态从 0 变 1 → roomLiveStatus 更新、emit('change')、发 ok 提示
 *   2. 状态没变 → 什么都不发生（不能每 30 秒噪一声）
 *   3. 状态从 1 变 0 → 发 warn 提示（下播后官方通道不再投递）
 *
 * 用 `Object.create(Engine.prototype)` 造一个只带被测依赖的壳：
 * 不启动服务器、不建浏览器、不联网，纯逻辑。
 */
const assert = require('assert');
const { Engine } = require('../src/main/engine');

let pass = 0; let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' → ' + extra : ''}`); }
}

function makeShell(statusSeq) {
  const e = Object.create(Engine.prototype);
  const notices = []; const logs = []; let changes = 0;
  let i = 0;
  e.notices = notices;
  e.roomLiveStatus = null;
  e._roomWatchToken = Symbol('test');
  e.bili = {
    roomInfo: async () => {
      const s = statusSeq[Math.min(i, statusSeq.length - 1)];
      i++;
      return { ok: true, roomId: 17537, liveStatus: s };
    },
  };
  e.notify = (level, text) => notices.push({ level, text });
  e.log = (text) => logs.push(String(text));
  e.emit = () => { changes++; };
  return { e, notices, logs, changes: () => changes };
}

(async () => {
  console.log('== 1) 先连接（未开播）再开播：状态必须自己跟上 ==');
  {
    const { e, notices, changes, logs } = makeShell([0, 1]);
    await e._pollRoomLive(17537, e._roomWatchToken);
    ok('首次查到未开播 → roomLiveStatus = 0', e.roomLiveStatus === 0, String(e.roomLiveStatus));
    ok('首次不算"变化"，不发提示', notices.length === 0, JSON.stringify(notices));

    await e._pollRoomLive(17537, e._roomWatchToken);
    ok('开播后 → roomLiveStatus = 1', e.roomLiveStatus === 1, String(e.roomLiveStatus));
    ok('状态变化会 emit(change)（界面靠它重画）', changes() >= 2, String(changes()));
    ok('开播发了一条 ok 提示', notices.some((n) => n.level === 'ok' && /已开播/.test(n.text)),
      JSON.stringify(notices));
    ok('日志写明 0 → 1', logs.some((t) => /直播间状态 0 → 1/.test(t)), JSON.stringify(logs));
  }

  console.log('== 2) 状态没变：不能每 30 秒噪一声 ==');
  {
    const { e, notices } = makeShell([1, 1, 1]);
    // 真实时序里是 `dc.on('room')` 先把 liveStatus 写成 1、再启动轮询，
    // 所以这里也先置 1（否则第一次 null→1 确实算"变化"，那是另一回事）
    e.roomLiveStatus = 1;
    await e._pollRoomLive(17537, e._roomWatchToken);
    await e._pollRoomLive(17537, e._roomWatchToken);
    await e._pollRoomLive(17537, e._roomWatchToken);
    ok('连接时已是直播中 → 之后三次轮询一条提示都不发', notices.length === 0, JSON.stringify(notices));
  }

  console.log('== 3) 下播：官方通道不再投递，必须说清楚 ==');
  {
    const { e, notices } = makeShell([1, 0]);
    await e._pollRoomLive(17537, e._roomWatchToken);
    await e._pollRoomLive(17537, e._roomWatchToken);
    ok('由直播中变未开播 → roomLiveStatus = 0', e.roomLiveStatus === 0, String(e.roomLiveStatus));
    ok('下播发了一条 warn 提示（并指向浏览器通道）',
      notices.some((n) => n.level === 'warn' && /已下播/.test(n.text) && /浏览器通道/.test(n.text)),
      JSON.stringify(notices));
  }

  console.log('== 4) 过期的轮询不能改状态（断开/换房间之后） ==');
  {
    const { e, notices } = makeShell([1]);
    const staleToken = Symbol('已过期');
    await e._pollRoomLive(17537, staleToken);   // token 与 _roomWatchToken 不一致
    ok('token 过期 → 状态不动、也不发提示',
      e.roomLiveStatus === null && notices.length === 0,
      `status=${e.roomLiveStatus} notices=${notices.length}`);
  }

  console.log('== 5) 接口失败不能把状态改坏 ==');
  {
    const e = Object.create(Engine.prototype);
    const notices = [];
    e.notices = notices; e.roomLiveStatus = 1;
    e._roomWatchToken = Symbol('t');
    e.bili = { roomInfo: async () => ({ ok: false, msg: '网络错误' }) };
    e.notify = (l, t) => notices.push({ level: l, text: t });
    e.log = () => {}; e.emit = () => {};
    await e._pollRoomLive(17537, e._roomWatchToken);
    ok('查询失败 → 保留原来的"直播中"，不误判成未开播', e.roomLiveStatus === 1, String(e.roomLiveStatus));
    ok('查询失败不产生提示', notices.length === 0, JSON.stringify(notices));
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
})().catch((e) => { console.error('测试自身异常：', e); process.exit(1); });
