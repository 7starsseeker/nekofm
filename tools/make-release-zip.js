#!/usr/bin/env node
/**
 * 打发布用 zip 包（零依赖，自带最小 ZIP 写入器）
 * ==============================================
 * 为什么不用 `Compress-Archive` / 7-Zip：
 *
 *   `npm run pack` 会在 `release/win-unpacked/` 里建一个 **指向开发版 data/ 的
 *   目录联接（Junction）**，让绿色版和开发版共用同一份配置与登录态。
 *   如果打包工具"递归跟进"这个联接，就会把**使用者本人的**
 *   `data/config.json`（含网易云 cookie、B站 cookie、开放平台密钥）和
 *   `data/electron/Network/Cookies`（Chromium 登录态库）**一起打进发布包**——
 *   一上传就是公开泄露。
 *
 *   所以这里自己走目录树，**遇到重解析点（符号链接 / 联接）一律跳过**，
 *   并且在最后做一次**入库自检**：包里只要出现 config.json / Cookies / data/，
 *   直接删掉产物并非零退出。
 *
 * 用法：
 *   node tools/make-release-zip.js                     # 默认 release/win-unpacked → release/NekoFM-<版本>-win-x64.zip
 *   node tools/make-release-zip.js <源目录> <输出.zip>
 *   node tools/make-release-zip.js --store             # 不压缩（只打包，最快）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const STORE_ONLY = argv.includes('--store');
const positional = argv.filter((a) => !a.startsWith('--'));

const SRC = path.resolve(positional[0] || path.join(ROOT, 'release', 'win-unpacked'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = path.resolve(positional[1] || path.join(ROOT, 'release', `NekoFM-${pkg.version}-win-x64.zip`));

/** 绝不进包的名字 —— 兜底拦截，正常路径下这些本来就在 data/ 里被跳过 */
const FORBIDDEN = new Set([
  'config.json', 'cookies', 'cookies-journal', 'login data', 'web data',
  'local state', 'preferences', 'secure preferences',
]);
/** 绝不打进去的顶层目录 */
const FORBIDDEN_DIRS = new Set(['data', '.git', 'node_modules']);

const line = (s = '') => process.stdout.write(s + '\n');
const human = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB');

// ------------------------------------------------------------------ CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ------------------------------------------------------------- DOS 时间戳
function dosDateTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

// ------------------------------------------------------------------ 遍历
/** @returns {{rel:string, abs:string, size:number}[]} */
function collect(dir, rel = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    throw new Error(`读不到 ${dir}: ${e.message}`);
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;

    // 顶层受禁目录直接跳过
    if (!rel && FORBIDDEN_DIRS.has(e.name.toLowerCase())) {
      line(`  [跳过目录] ${r}/  （运行时数据/版本库，不进发布包）`);
      continue;
    }

    // ⚠️ 关键：重解析点（联接 / 符号链接）一律不跟进 —— 这是 data/ 联接的防线
    let lst;
    try { lst = fs.lstatSync(abs); } catch { continue; }
    if (lst.isSymbolicLink()) {
      line(`  [跳过链接] ${r}  → ${(() => { try { return fs.readlinkSync(abs); } catch { return '?'; } })()}`);
      continue;
    }

    if (lst.isDirectory()) { out.push(...collect(abs, r)); continue; }
    if (!lst.isFile()) continue;
    if (/\.(log|tmp)$/i.test(e.name)) { line(`  [跳过文件] ${r}`); continue; }
    out.push({ rel: r, abs, size: lst.size });
  }
  return out;
}

// --------------------------------------------------------------- ZIP 写入
function buildZip(files, outFile) {
  const local = [];      // 各文件的本地头 + 数据（顺序写盘）
  const central = [];    // 中央目录条目
  let offset = 0;
  let raw = 0;
  let packed = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.abs);
    const crc = crc32(data);
    let method = 0;
    let body = data;
    if (!STORE_ONLY) {
      const def = zlib.deflateRawSync(data, { level: 6 });
      if (def.length < data.length) { method = 8; body = def; }
    }

    const nameBuf = Buffer.from(f.rel.replace(/\\/g, '/'), 'utf8');
    const { time, date } = dosDateTime(fs.statSync(f.abs).mtime);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);   // UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);       // version made by
    ch.writeUInt16LE(20, 6);       // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);       // extra
    ch.writeUInt16LE(0, 32);       // comment
    ch.writeUInt16LE(0, 34);       // disk
    ch.writeUInt16LE(0, 36);       // internal attrs
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs：普通文件 644
    ch.writeUInt32LE(offset, 42);

    local.push(lh, nameBuf, body);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
    raw += data.length;
    packed += body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile, 'w');
  try {
    for (const b of local) fs.writeSync(fd, b);
    fs.writeSync(fd, cdBuf);
    fs.writeSync(fd, eocd);
  } finally {
    fs.closeSync(fd);
  }
  return { raw, packed };
}

// -------------------------------------------------------------------- 主流程
if (!fs.existsSync(SRC)) {
  console.error(`[zip] 源目录不存在：${SRC}\n      先跑 npm run pack:dir`);
  process.exit(1);
}

line('==============================================');
line(' NekoFM · 打发布 zip 包');
line('==============================================');
line(`源目录 : ${SRC}`);
line(`输出   : ${OUT}`);
line(`压缩   : ${STORE_ONLY ? '不压缩（store）' : 'deflate 6'}`);
line('');
line('遍历（跳过项会逐条列出）：');

const files = collect(SRC);
if (!files.length) { console.error('[zip] 源目录里没有可打包的文件'); process.exit(1); }

// 入库自检：包内**不允许**出现任何运行时数据特征
const bad = files.filter((f) => {
  const base = path.basename(f.rel).toLowerCase();
  const top = f.rel.split('/')[0].toLowerCase();
  return FORBIDDEN.has(base) || FORBIDDEN_DIRS.has(top);
});
if (bad.length) {
  line('');
  console.error('[zip] ✗ 自检不通过：待打包内容里出现了运行时数据文件——');
  for (const b of bad) console.error(`        ${b.rel}`);
  console.error('  这不是可发布的产物，已中止（不写 zip）。请检查 release/ 里是不是混进了 data 联接。');
  process.exit(1);
}

line('');
line(`待打包 ${files.length} 个文件，原始 ${human(files.reduce((s, f) => s + f.size, 0))}`);
line('');

const t0 = Date.now();
const { raw, packed } = buildZip(files, OUT);
const outSize = fs.statSync(OUT).size;

line('入库自检：通过（包内无 data/ 无 config.json 无 Cookies）');
line('');
line(`完成：${OUT}`);
line(`  文件数 ${files.length}   原始 ${human(raw)}   zip 实际 ${human(outSize)}` +
  (packed && raw ? `   压缩率 ${(100 - (packed / raw) * 100).toFixed(1)}%` : ''));
line(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
line('');
line('接下来：把 zip 作为附件挂到 GitHub Release 上即可。');
