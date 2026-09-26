/**
 * 文本文件解码单测（纯函数，node 直接跑，不联网、不用 ffmpeg）
 * ==========================================================
 * 钉住的是**别人写的 .lrc 怎么读**这件事。
 *
 * 为什么专门给它一个测试文件：读错编码**不会报错**，只会满屏乱码 ——
 * 而乱码只有真去播那首歌才看得见。曲库里 105 个 GBK 文件意味着
 * "绝大多数本地歌"都踩这条路径，所以判定逻辑必须有离线回归。
 *
 * 2026-09-27 用户报告："播放本地文件时对应的字幕显示为乱码"，
 * 真身就是 `readFileSync(f, 'utf8')` 硬读 GBK 歌词。
 */
'use strict';

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { decodeText, readTextFile } = require('../src/core/text-file');
const { parseLrc } = require('../src/core/lyrics/lrc');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '\n     ', e.message); fail++; }
}

/** GBK 字节（Node 内置没有 GBK 编码器，只能把字节直接钉成十六进制） */
const GBK_MAIN = Buffer.from(
  '5b30303a30312e30305db5dad2bbbee4b2e2cad4b8e8b4ca0d0a'
  + '5b30303a30332e35305db5dab6febee4b2e2cad4b8e8b4ca0d0a', 'hex');
const GBK_TRANS = Buffer.from('5b30303a30312e30305db5dad2bbd0d0b7add2eb0d0a', 'hex');
/** 用户报告那个文件的开头（`2-09 No Way Back.lrc`，2010 年的 GBK 文件）—— 真实素材 */
const GBK_REAL_HEAD = Buffer.from('5b74693a4e6f20576179204261636b5d0d0a5b61723ad3f1d6c3b3c98c675d0d0a', 'hex');

console.log('== decodeText：各编码识别 ==');
t('GBK 歌词解得通顺（不再是乱码）', () => {
  const s = decodeText(GBK_MAIN);
  assert.ok(s.includes('第一句测试歌词'), '实得：' + JSON.stringify(s));
  assert.ok(s.includes('第二句测试歌词'));
  assert.ok(!s.includes('\uFFFD'), '不应出现替换字符');
});
t('用户报告的真实文件头（含日文汉字 実）', () => {
  const s = decodeText(GBK_REAL_HEAD);
  assert.ok(s.includes('[ar:玉置成実]'), '实得：' + JSON.stringify(s));
});
t('纯 UTF-8 原样读出', () => {
  assert.strictEqual(decodeText(Buffer.from('[00:01.00]中文歌词\n', 'utf8')), '[00:01.00]中文歌词\n');
});
t('UTF-8 BOM 要剥掉（否则首行头部藏一个看不见的 U+FEFF）', () => {
  const withBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('[00:01.00]带BOM', 'utf8')]);
  const s = decodeText(withBom);
  assert.strictEqual(s, '[00:01.00]带BOM');
  assert.strictEqual(s.charCodeAt(0), '['.charCodeAt(0), '首字符不该是 U+FEFF');
});
t('UTF-16LE（记事本「Unicode」）要认 BOM', () => {
  const body = Buffer.from('[ti:银の意志 金の翼]\n[00:00.50]中文歌词', 'utf16le');
  const s = decodeText(Buffer.concat([Buffer.from([0xFF, 0xFE]), body]));
  assert.strictEqual(s, '[ti:银の意志 金の翼]\n[00:00.50]中文歌词');
});
t('UTF-16BE 也要认', () => {
  const txt = '[00:00.50]大端序';
  const le = Buffer.from(txt, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
  assert.strictEqual(decodeText(Buffer.concat([Buffer.from([0xFE, 0xFF]), be])), txt);
});
t('纯 ASCII 不被误判（它本身是合法 UTF-8）', () => {
  assert.strictEqual(decodeText(Buffer.from('[ti:No Way Back]\n[00:00.50]No Way Back', 'ascii')),
    '[ti:No Way Back]\n[00:00.50]No Way Back');
});
t('空输入 / 非法类型不炸', () => {
  assert.strictEqual(decodeText(Buffer.alloc(0)), '');
  assert.strictEqual(decodeText(''), '');
  assert.strictEqual(decodeText(null), '');
  assert.strictEqual(decodeText(undefined), '');
});

console.log('== readTextFile：落盘读回 ==');
const DIR = path.join(os.tmpdir(), 'nekofm-textfile-test');
t('GBK 文件按盘上字节自动识别', () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const f = path.join(DIR, 'gbk.lrc');
  fs.writeFileSync(f, GBK_MAIN);              // 原始字节，不转码
  assert.ok(readTextFile(f).includes('第一句测试歌词'));
  fs.rmSync(DIR, { recursive: true, force: true });
});

console.log('== 与歌词解析串起来（还原用户看到的症状） ==');
t('GBK 侧车歌词 → 时间轴正文正确（不是乱码）', () => {
  const tl = parseLrc(decodeText(GBK_MAIN));
  assert.strictEqual(tl.lines.length, 2, '实得 ' + tl.lines.length + ' 行');
  assert.ok(Math.abs(tl.lines[0].time - 1) < 1e-6);
  assert.strictEqual(tl.lines[0].text, '第一句测试歌词');
  assert.strictEqual(tl.lines[1].text, '第二句测试歌词');
});
t('GBK 翻译侧车同样正确', () => {
  const tl = parseLrc(decodeText(GBK_TRANS));
  assert.strictEqual(tl.lines[0].text, '第一行翻译');
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
