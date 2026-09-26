/** 点歌队列 + 指令解析 单测 */
'use strict';
const assert = require('assert');
const { SongQueue, dedupeKey } = require('../src/core/queue');
const { parseCommand } = require('../src/core/commands');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '\n      ', e.message); fail++; }
};
const song = (id, name, artists = ['某歌手']) => ({ source: 'netease', id, name, artists, artistText: artists.join('/') });
const user = (uid, uname, extra = {}) => ({ uid, uname, ...extra });

console.log('== 指令解析 ==');
t('基础点歌', () => {
  const r = parseCommand('点歌 孤勇者');
  assert.strictEqual(r.cmd, 'order');
  assert.strictEqual(r.args.keyword, '孤勇者');
  assert.strictEqual(r.args.source, null);
});
t('带音源前缀', () => {
  assert.strictEqual(parseCommand('点歌 网易云 晴天').args.source, 'netease');
  assert.strictEqual(parseCommand('点歌 b站 孤勇者').args.source, 'bilibili');
  assert.strictEqual(parseCommand('点歌 本地 老歌').args.source, 'local');
  assert.strictEqual(parseCommand('点歌 网易云 晴天').args.keyword, '晴天');
});
t('直接甩 BV 号 / 链接', () => {
  const a = parseCommand('点播 BV1eLsnzFEoM');
  assert.strictEqual(a.cmd, 'order_video');
  assert.strictEqual(a.args.target, 'BV1eLsnzFEoM');
  const b = parseCommand('BV1eLsnzFEoM');
  assert.strictEqual(b.cmd, 'order_video');
  const c = parseCommand('点歌 https://www.bilibili.com/video/BV1eLsnzFEoM');
  assert.strictEqual(c.cmd, 'order_video');
});
t('管理指令', () => {
  assert.strictEqual(parseCommand('切歌').cmd, 'skip');
  assert.strictEqual(parseCommand('跳过').cmd, 'skip');
  assert.strictEqual(parseCommand('撤歌 2').cmd, 'remove');
  assert.strictEqual(parseCommand('撤歌 2').args.index, 2);
  assert.strictEqual(parseCommand('歌词 关').args.on, false);
  assert.strictEqual(parseCommand('歌词 开').args.on, true);
  assert.strictEqual(parseCommand('音量 80').args.value, 80);
  assert.strictEqual(parseCommand('音量 999').args.value, 100, '应夹到 100');
});
t('普通聊天不误伤', () => {
  assert.strictEqual(parseCommand('主播好厉害').cmd, 'none');
  assert.strictEqual(parseCommand('这首好听').cmd, 'none');
  assert.strictEqual(parseCommand('').cmd, 'none');
});
t('点歌必须带空格（2026-09-26 收紧）', () => {
  // 有空格 = 触发
  assert.strictEqual(parseCommand('点歌 孤勇者').cmd, 'order');
  assert.strictEqual(parseCommand('点播 青花瓷').cmd, 'order');
  assert.strictEqual(parseCommand('来一首 晴天').cmd, 'order');
  // 没空格紧贴内容 = 不触发（聊天）
  assert.strictEqual(parseCommand('点歌今天唱的真好').cmd, 'none');
  assert.strictEqual(parseCommand('点歌孤勇者').cmd, 'none');
  // 单独的"点歌" = 不触发（旧版会刷屏提示"点歌要带上歌名哦~"）
  assert.strictEqual(parseCommand('点歌').cmd, 'none');
  assert.strictEqual(parseCommand('点歌   ').cmd, 'none', '只有空格也按聊天忽略');
});
t('切歌必须完全匹配两个字符（2026-09-26 收紧）', () => {
  // 精确匹配 = 触发
  assert.strictEqual(parseCommand('切歌').cmd, 'skip');
  // 任何前后缀都按聊天忽略
  assert.strictEqual(parseCommand('切歌啊').cmd, 'none');
  assert.strictEqual(parseCommand('切歌 1').cmd, 'none');
  assert.strictEqual(parseCommand('我想切歌').cmd, 'none');
  assert.strictEqual(parseCommand('帮我切歌').cmd, 'none');
  // 其他 skip 别名保持 startsWith
  assert.strictEqual(parseCommand('跳过').cmd, 'skip');
  assert.strictEqual(parseCommand('下一首').cmd, 'skip');
});
t('自定义词表', () => {
  const r = parseCommand('来一首 起风了', { words: { order: ['来一首'] } });
  assert.strictEqual(r.cmd, 'order');
  assert.strictEqual(r.args.keyword, '起风了');
});

console.log('== 队列 ==');
t('基本入队与顺序', () => {
  const q = new SongQueue({ cooldownMs: 0 });
  const a = q.push(song(1, 'A'), user(1, '甲'));
  const b = q.push(song(2, 'B'), user(2, '乙'));
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.position, 1);
  assert.strictEqual(b.position, 2);
  assert.strictEqual(q.length, 2);
});
t('同一首歌去重（含已在队列）', () => {
  const q = new SongQueue({ cooldownMs: 0 });
  q.push(song(1, 'A'), user(1, '甲'));
  const dup = q.push(song(1, 'A'), user(2, '乙'));
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.reason, 'duplicate');
});
t('已播放过的歌在窗口内也去重', () => {
  const q = new SongQueue({ cooldownMs: 0, dedupeWindowMs: 60_000 });
  q.push(song(1, 'A'), user(1, '甲'));
  q.next();            // A 进入在放
  q.next();            // A 结束 → 入历史
  const again = q.push(song(1, 'A'), user(2, '乙'));
  assert.strictEqual(again.reason, 'duplicate');
});
t('每人上限', () => {
  const q = new SongQueue({ cooldownMs: 0, perUserMax: 2 });
  q.push(song(1, 'A'), user(1, '甲'));
  q.push(song(2, 'B'), user(1, '甲'));
  const r = q.push(song(3, 'C'), user(1, '甲'));
  assert.strictEqual(r.reason, 'per_user_limit');
});
t('冷却', () => {
  const q = new SongQueue({ cooldownMs: 60_000 });
  q.push(song(1, 'A'), user(1, '甲'));
  const r = q.push(song(2, 'B'), user(1, '甲'));
  assert.strictEqual(r.reason, 'cooldown');
  assert.ok(/秒/.test(r.msg), '冷却提示应含剩余秒数: ' + r.msg);
});
t('队列上限（管理不受限）', () => {
  const q = new SongQueue({ cooldownMs: 0, perUserMax: 99, maxSize: 2 });
  q.push(song(1, 'A'), user(1, '甲'));
  q.push(song(2, 'B'), user(2, '乙'));
  assert.strictEqual(q.push(song(3, 'C'), user(3, '丙')).reason, 'full');
  const boss = q.push(song(3, 'C'), user(9, '主播', { isAnchor: true }));
  assert.strictEqual(boss.ok, true, '主播应可越过队列上限');
});
t('主播插队', () => {
  const q = new SongQueue({ cooldownMs: 0 });
  q.push(song(1, 'A'), user(1, '甲'));
  q.push(song(2, 'B'), user(2, '乙'));
  const vip = q.push(song(3, 'C'), user(9, '主播', { isAnchor: true }), { urgent: true });
  assert.strictEqual(vip.position, 1, '插队后应在第一位');
  assert.strictEqual(q.peek().song.name, 'C');
});
t('next 流转与在放', () => {
  const q = new SongQueue({ cooldownMs: 0 });
  q.push(song(1, 'A'), user(1, '甲'));
  q.push(song(2, 'B'), user(2, '乙'));
  const playing = q.next();
  assert.strictEqual(playing.song.name, 'A');
  assert.strictEqual(q.current.song.name, 'A');
  assert.strictEqual(q.length, 1);
  q.next();
  assert.strictEqual(q.current.song.name, 'B');
  const done = q.next();
  assert.strictEqual(done, null);
  assert.strictEqual(q.current, null);
});
t('按序号删除', () => {
  const q = new SongQueue({ cooldownMs: 0 });
  q.push(song(1, 'A'), user(1, '甲'));
  q.push(song(2, 'B'), user(2, '乙'));
  const r = q.remove(1, user(9, '房管', { isAdmin: true }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(q.peek().song.name, 'B');
  assert.strictEqual(q.remove(5, user(9, '房管', { isAdmin: true })).reason, 'bad_index');
});
t('撤歌不带序号 = 撤自己最后一首', () => {
  const q = new SongQueue({ cooldownMs: 0 });
  q.push(song(1, 'A'), user(1, '甲'));
  q.push(song(2, 'B'), user(2, '乙'));
  const r = q.remove(null, user(2, '乙'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(q.peek().song.name, 'A');
});
t('查询自己的位置', () => {
  const q = new SongQueue({ cooldownMs: 0 });
  q.push(song(1, 'A'), user(1, '甲'));
  q.push(song(2, 'B'), user(2, '乙'));
  assert.strictEqual(q.positionOf(user(2, '乙')).position, 2);
  q.next(); // 甲 在放
  assert.strictEqual(q.positionOf(user(1, '甲')).playing, true);
  assert.strictEqual(q.positionOf(user(3, '丙')).position, null);
});
t('list 快照结构', () => {
  const q = new SongQueue({ cooldownMs: 0 });
  q.push(song(1, 'A'), user(1, '甲'));
  q.next();
  q.push(song(2, 'B'), user(2, '乙'));
  const l = q.list();
  assert.strictEqual(l.current.name, 'A');
  assert.strictEqual(l.items[0].position, 1);
  assert.strictEqual(l.total, 1);
});
t('dedupeKey 退化到标题', () => {
  const a = dedupeKey({ title: '孤勇者', artists: ['陈奕迅'] });
  const b = dedupeKey({ title: '孤 勇 者', artists: ['陈奕迅'] });
  assert.strictEqual(a, b, '归一化后应相同');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
