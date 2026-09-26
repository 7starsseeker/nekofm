/** 歌词引擎单测（纯函数，node 直接跑） */
'use strict';
const assert = require('assert');
const { parseLrc, parseYrc, buildTimeline, locate } = require('../src/core/lyrics/lrc');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '\n     ', e.message); fail++; }
}

console.log('== parseLrc ==');
t('基本时间标签', () => {
  const r = parseLrc('[00:12.34]你好\n[01:02.5]世界');
  assert.strictEqual(r.lines.length, 2);
  assert.ok(Math.abs(r.lines[0].time - 12.34) < 1e-6, 'time0=' + r.lines[0].time);
  assert.ok(Math.abs(r.lines[1].time - 62.5) < 1e-6, 'time1=' + r.lines[1].time);
  assert.strictEqual(r.lines[0].text, '你好');
});
t('一行多标签展开', () => {
  const r = parseLrc('[00:10.00][00:20.00]重复');
  assert.strictEqual(r.lines.length, 2);
  assert.deepStrictEqual(r.lines.map((l) => l.time), [10, 20]);
});
t('毫秒位归一化（2位/3位/无）', () => {
  assert.ok(Math.abs(parseLrc('[00:01.5]x').lines[0].time - 1.5) < 1e-6);
  assert.ok(Math.abs(parseLrc('[00:01.50]x').lines[0].time - 1.5) < 1e-6);
  assert.ok(Math.abs(parseLrc('[00:01.500]x').lines[0].time - 1.5) < 1e-6);
  assert.ok(Math.abs(parseLrc('[00:01]x').lines[0].time - 1.0) < 1e-6);
});
t('元信息与 offset 校正', () => {
  const r = parseLrc('[ti:歌名]\n[ar:歌手]\n[offset:500]\n[00:10.00]词');
  assert.strictEqual(r.meta.ti, '歌名');
  assert.strictEqual(r.meta.ar, '歌手');
  assert.ok(Math.abs(r.lines[0].time - 9.5) < 1e-6, 'offset 生效 time=' + r.lines[0].time);
});
t('增强 LRC 行内逐字', () => {
  const r = parseLrc('[00:01.00]<00:01.00>你<00:01.50>好');
  assert.strictEqual(r.lines[0].text, '你好');
  assert.strictEqual(r.lines[0].words.length, 2);
  assert.ok(Math.abs(r.lines[0].words[1].absTime - 1.5) < 1e-6);
});

console.log('== parseYrc ==');
t('括号形态（网易云逐字）', () => {
  const r = parseYrc('[0,300](0,60,0)编(60,60,0)曲(120,60,0)： (180,60,0)Skot');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].text, '编曲： Skot');
  assert.strictEqual(r[0].words.length, 4);
  assert.ok(Math.abs(r[0].words[0].t - 0) < 1e-6);
  assert.ok(Math.abs(r[0].words[1].t - 0.06) < 1e-6, 't1=' + r[0].words[1].t);
  assert.strictEqual(r[0].duration, 0.3);
});
t('JSON 形态', () => {
  const r = parseYrc('{"t":1500,"c":[{"tx":"你"},{"tx":"好"}]}');
  assert.strictEqual(r.length, 1);
  assert.ok(Math.abs(r[0].time - 1.5) < 1e-6);
  assert.strictEqual(r[0].text, '你好');
});

console.log('== buildTimeline 合并与降级 ==');
const LRC = '[00:01.00]编曲： Skot\n[00:05.00]第一句歌词\n[00:09.00]第二句歌词';
const YRC = '[0,300](0,60,0)编(60,60,0)曲(120,60,0)： (180,60,0)Skot\n'
          + '[5000,2000](0,500,0)第(500,500,0)一(1000,500,0)句(1500,500,0)歌(2000,0,0)词';
const TLYRIC = '[00:05.00]First line\n[00:09.00]Second line';

t('yrc 与 lrc 文本一致 → karaoke=word', () => {
  const tl = buildTimeline({ lrc: LRC, yrc: YRC, tlyric: TLYRIC });
  assert.strictEqual(tl.lines.length, 3);
  assert.strictEqual(tl.lines[1].karaoke, 'word', '应识别为逐字');
  assert.strictEqual(tl.lines[1].words.length, 5);
  assert.strictEqual(tl.lines[1].trans, 'First line');
});
t('yrc 文本不一致 → 降级 karaoke=line', () => {
  const tl = buildTimeline({ lrc: LRC, yrc: '[5000,2000](0,500,0)完全(500,500,0)不同' });
  assert.strictEqual(tl.lines[1].karaoke, 'line');
  assert.strictEqual(tl.lines[1].words.length, 0);
});
t('无 yrc → karaoke=plain', () => {
  const tl = buildTimeline({ lrc: LRC });
  assert.strictEqual(tl.lines[0].karaoke, 'plain');
  assert.strictEqual(tl.lines[0].trans, '');
});
t('end 由下一行补齐', () => {
  const tl = buildTimeline({ lrc: LRC });
  assert.ok(Math.abs(tl.lines[0].end - 5) < 1e-6);
  assert.ok(tl.lines[2].end > tl.lines[2].time);
});

console.log('== locate 定位 ==');
t('定位与 0.35s 预滚', () => {
  const tl = buildTimeline({ lrc: LRC, yrc: YRC, tlyric: TLYRIC });
  // 语义：还没进入第一行的预滚区时，没有"当前行"（index = -1），
  // 渲染层据此显示"即将到来"的歌词而不是把第一行当成正在唱。
  assert.strictEqual(locate(tl, 0).index, -1, '歌曲未开始时应无当前行');
  assert.strictEqual(locate(tl, 0.66).index, 0, '进入预滚区后应切到第一行');
  assert.strictEqual(locate(tl, 5.1).index, 1);
  assert.strictEqual(locate(tl, 4.8).index, 1, '预滚应提前切到下一行');
  assert.strictEqual(locate(tl, 100).index, 2);
});
// 数据层指标：按词级时间戳算出的行内进度。逐字**渲染**已下线，
// 但这个值仍由 lyric-sync 提供（将来恢复逐字染色就靠它），所以照常测。
t('词级进度推进', () => {
  const tl = buildTimeline({ lrc: LRC, yrc: YRC });
  const a = locate(tl, 5.0);
  const b = locate(tl, 6.0);
  const c = locate(tl, 7.2);
  assert.ok(a.wordProgress < b.wordProgress, `应递增 ${a.wordProgress} -> ${b.wordProgress}`);
  assert.ok(c.wordProgress > 0.8, '接近行尾应基本填满，实得 ' + c.wordProgress);
  assert.ok(c.wordProgress <= 1);
});
t('空歌词不崩', () => {
  const tl = buildTimeline({});
  assert.strictEqual(tl.lines.length, 0);
  assert.strictEqual(locate(tl, 3).index, -1);
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
