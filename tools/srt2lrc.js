#!/usr/bin/env node
/**
 * SRT 字幕 → NekoFM 旁车歌词（LRC）
 * =================================
 * 用途：从 B 站视频/音频识别出来的字幕（.srt）转成 NekoFM 能直接读的双语歌词。
 *
 * NekoFM 的本地歌词约定（见 src/main/sources/local.js 的 lyrics()）：
 *   <歌名>.lrc        主歌词（原文）
 *   <歌名>.trans.lrc  译文      —— 存在时叠加层「双语」主题会一并显示
 * 两份文件都按**时间近似**（容差 0.35s，见 lrc.js 的 buildTimeline）配对，
 * 所以主/译两份字幕的**时间轴必须一致**；本工具会先校验，对不齐就报出来。
 *
 * 用法：
 *   node tools/srt2lrc.js <主字幕.srt> <译文字幕.srt> <音频文件|输出目录>
 *   node tools/srt2lrc.js <主字幕.srt> - <音频文件>          # 只有原文，不写 .trans.lrc
 *   node tools/srt2lrc.js <双语字幕.srt> - <音频文件>         # 单文件双语：首行=原文，其余行=译文
 *   node tools/srt2lrc.js ... --offset 0.3                   # 整体延后 0.3 秒（负数＝提前）
 *   node tools/srt2lrc.js ... --dry                          # 只打印，不落盘
 *
 * 注意：
 *   · 只按**后缀**判断要不要写：主 → `<base>.lrc`，译 → `<base>.trans.lrc`；
 *   · **不覆盖**已存在的同名歌词（与 local.saveLyrics 的口径一致），要重写请先自己删；
 *   · 读 srt 走 core/text-file.js，GBK/UTF-16 的老字幕也能认（B 站导出的多为 UTF-8）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readTextFile } = require('../src/core/text-file');

/** `00:01:23,456` / `00:01:23.456` → 秒 */
function parseTime(s) {
  const m = String(s).trim().match(/^(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
    + parseInt(m[4].padEnd(3, '0'), 10) / 1000;
}

/** 去掉字幕里常见的样式残留（`<i>`、`{\an8}`、`<font …>`） */
function clean(text) {
  return String(text)
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+$/, '')
    .trim();
}

/**
 * 解析 SRT。
 * @returns {Array<{start:number, lines:string[]}>}
 */
function parseSrt(raw) {
  const out = [];
  // 按空行切块；块内首行是序号、第二行是时间轴、其余是正文
  for (const block of String(raw).replace(/\r/g, '').split(/\n{2,}/)) {
    const ls = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
    if (!ls.length) continue;
    let i = /^\d+$/.test(ls[0].trim()) ? 1 : 0;          // 序号行（有的字幕没有）
    const tm = ls[i] && ls[i].match(/^(\S+)\s*-->\s*(\S+)/);
    if (!tm) continue;
    const start = parseTime(tm[1]);
    if (start == null) continue;
    const lines = ls.slice(i + 1).map(clean).filter(Boolean);
    if (!lines.length) continue;
    out.push({ start, lines });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** 秒 → LRC 时间标签，格式与 lrc.js 的 timelineToLrc 完全一致（`[mm:ss.xx]`） */
function fmt(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/**
 * 校验主/译时间轴是否一一对齐。
 * @returns {{ok:boolean, msg:string, pairs:Array<[number,number]>}}
 */
function alignTimeline(main, trans, tol = 0.35) {
  const pairs = [];
  const missMain = [];
  const used = new Set();
  for (const t of trans) {
    let bi = -1;
    let bd = Infinity;
    for (let i = 0; i < main.length; i++) {
      const d = Math.abs(main[i].start - t.start);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd <= tol && !used.has(bi)) { used.add(bi); pairs.push([bi, trans.indexOf(t)]); }
    else missMain.push(t.start);
  }
  const missTrans = main.map((m, i) => (used.has(i) ? -1 : m.start)).filter((v) => v >= 0);
  const bits = [`主 ${main.length} 条 / 译 ${trans.length} 条 → 对齐 ${pairs.length} 条`];
  if (missTrans.length) bits.push(`⚠️ 主字幕有 ${missTrans.length} 条没有译文（${missTrans.slice(0, 5).map(fmt).join(', ')}${missTrans.length > 5 ? ' …' : ''}）`);
  if (missMain.length) bits.push(`⚠️ 译字幕有 ${missMain.length} 条没有对应原文，将被丢弃（${missMain.slice(0, 5).map(fmt).join(', ')}${missMain.length > 5 ? ' …' : ''}）`);
  return { ok: pairs.length > 0, msg: bits.join('；'), pairs };
}

function usage(msg) {
  if (msg) console.error('✗ ' + msg + '\n');
  console.error(`用法：node tools/srt2lrc.js <主字幕.srt> <译文字幕.srt|-> <音频文件|输出目录> [--offset 秒] [--dry] [--anyway]

  主字幕.srt    原文，落到 <歌名>.lrc
  译文字幕.srt  译文，落到 <歌名>.trans.lrc；写 - 表示没有译文
  音频文件      用它推导旁车文件名（**必须真实存在**，与歌曲同目录）；给目录则需再加 --names
  --offset 秒   所有时间戳整体平移，正数＝歌词更晚出现（默认 0）
  --dry         只打印转换结果，不写文件
  --anyway      音频文件还不存在时也照写（默认会拦住，见下）

  ⚠️ 为什么默认拦住：旁车靠**文件名**与音频配对，名字错一个字程序就永远读不到，
  而界面只表现为"这首歌没歌词"（2026-09-27 踩过：手打的歌名多了个「》」）。
  名字建议直接复制文件管理器里的，或先 cd 到歌曲目录用 $(ls *.mp4) 这类方式取。`);
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const pos = [];
  let offset = 0;
  let dry = false;
  let names = null;
  let anyway = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') dry = true;
    else if (a === '--anyway') anyway = true;
    else if (a === '--offset') offset = parseFloat(argv[++i]);
    else if (a === '--names') names = argv[++i];
    else if (a.startsWith('--')) usage('未知参数：' + a);
    else pos.push(a);
  }
  if (pos.length < 3) usage('参数不够');
  if (!Number.isFinite(offset)) usage('--offset 需要一个数字');

  const [mainSrc, transSrc, target] = pos;
  if (!fs.existsSync(mainSrc)) usage('找不到主字幕：' + mainSrc);

  // 只按后缀判断，不做音频格式白名单 —— 这里的 target 可以只是个不存在的路径
  let dir;
  let base;
  const targetIsDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
  if (targetIsDir) {
    if (!names) usage('target 是目录时必须用 --names 指定歌名（不含扩展名）');
    dir = target;
    base = names;
  } else {
    dir = path.dirname(path.resolve(target));
    base = path.basename(target, path.extname(target));
  }
  if (!fs.existsSync(dir)) usage('输出目录不存在：' + dir);

  /**
   * 护栏：target 是**文件**时，它应该就是那首歌。
   *
   * 2026-09-27 的真实翻车：拿手打的文件名（多了个「》」）当 target，
   * 于是旁车挂在一个**磁盘上不存在的名字**上 —— 程序按 `<音频名>.lrc` 找，
   * 永远找不到，界面只表现为"这首歌没歌词"，排查起来毫无线索。
   * 所以名字对不上时**必须喊出来**，并把同目录里名字相近的音频列出来。
   */
  if (!targetIsDir && !fs.existsSync(target)) {
    const cands = [];
    const exts = /\.(mp4|mp3|flac|m4a|aac|wav|ogg|opus|wma|ape|mkv|webm|mov)$/i;
    try {
      for (const e of fs.readdirSync(dir)) if (exts.test(e)) cands.push(e);
    } catch { /* 目录读不到 */ }
    const hint = `找不到这个音频文件：\n     ${target}\n` +
      `   （它只用来推导旁车文件名；名字打错 → 旁车挂在不存在的名字上 → 程序永远读不到）\n` +
      (cands.length
        ? `   这个目录里的音频文件有：\n     ` + cands.slice(0, 5).join('\n     ') + (cands.length > 5 ? `\n     …另外 ${cands.length - 5} 个` : '')
        : '   这个目录里没找到任何音频文件');
    if (!anyway) usage(hint + '\n   确认就是要给这个还不存在的名字配歌词，加 --anyway 继续');
    console.error('⚠️ ' + hint + '\n   （--anyway 已指定，继续写）');
  }

  const shift = (arr) => { for (const c of arr) c.start += offset; return arr; };
  const mainCues = shift(parseSrt(readTextFile(mainSrc)));
  if (!mainCues.length) usage('主字幕里没解析出任何一条字幕：' + mainSrc);

  // 译文：单独文件，或从主字幕的「一行原文 + 一行译文」里拆出来
  let transCues = [];
  if (transSrc && transSrc !== '-') {
    transCues = shift(parseSrt(readTextFile(transSrc)));
    if (!transCues.length) console.error('⚠️ 译文字幕没解析出字幕，按「无译文」继续');
  } else if (mainCues.some((c) => c.lines.length > 1)) {
    transCues = mainCues
      .filter((c) => c.lines.length > 1)
      .map((c) => ({ start: c.start, lines: c.lines.slice(1) }));
    for (const c of mainCues) c.lines = [c.lines[0]];
    console.log('· 单文件双语：首行当原文，其余行当译文');
  }

  const mainOut = mainCues.filter((c) => c.lines.join('').trim())
    .map((c) => `[${fmt(c.start)}]${c.lines.join(' ').trim()}`).join('\n') + '\n';

  let transOut = '';
  if (transCues.length) {
    const { ok, msg } = alignTimeline(mainCues, transCues);
    console.log('· 时间轴校验：' + msg);
    if (!ok) usage('主/译时间轴完全对不上，先核对字幕再转');
    // 只用**能配上原文**的译文行：配不上的（片尾标题卡之类）永远不会显示，
    // 留着只会让文件与主歌词行数不一致
    const kept = new Set();
    const usedIdx = new Set();
    for (const c of mainCues) {
      let bi = -1;
      let bd = Infinity;
      transCues.forEach((t, i) => {
        if (usedIdx.has(i)) return;
        const d = Math.abs(t.start - c.start);
        if (d < bd) { bd = d; bi = i; }
      });
      if (bi >= 0 && bd <= 0.35) { usedIdx.add(bi); kept.add(bi); }
    }
    transOut = transCues.filter((_, i) => kept.has(i))
      .map((c) => `[${fmt(c.start)}]${c.lines.join(' ').trim()}`).join('\n') + '\n';
  }

  const files = [];
  if (mainOut) files.push([path.join(dir, `${base}.lrc`), mainOut, '主歌词（原文）']);
  if (transOut) files.push([path.join(dir, `${base}.trans.lrc`), transOut, '译文']);

  for (const [p, content, what] of files) {
    const n = content.trim().split('\n').length;
    if (dry) {
      console.log(`\n----- ${what} → ${p} （${n} 行）-----\n` + content);
      continue;
    }
    if (fs.existsSync(p)) { console.log(`· 已存在，跳过（不覆盖）：${path.basename(p)}`); continue; }
    fs.writeFileSync(p, content, 'utf8');
    console.log(`✓ 已写入${what}：${p} （${n} 行）`);
  }
  if (!dry) {
    console.log('\n下一步：在 NekoFM 里播放这首歌即可自动读到歌词；');
    console.log('叠加层把主题切到「双语」（dual）就会原文 + 译文一起显示。');
  }
}

main();
