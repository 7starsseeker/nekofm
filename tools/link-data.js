/**
 * 让绿色版和开发版**共用同一份数据**
 * ==================================
 * 绿色版的数据目录是 `release/win-unpacked/data`，开发版是 `data/`。
 * 想两边看到同样的配置/缓存，就把前者做成**指向后者的目录联接（Junction）**。
 *
 * 为什么是 Junction 不是硬链接：Windows 的硬链接**只能作用于文件**，
 * 目录得用 Junction（`mklink /J`）。它不需要管理员权限，对程序完全透明 ——
 * 绿色版照常往 `data/` 读写，实际落在开发版那份上。
 *
 * ⚠️ **每次重新打包都会把这个联接弄丢**：`electron-builder` 会清空并重建
 * `release/`，联接跟着消失。所以：
 *   · `npm run pack`          → 打包 + **自动重建联接**（本机跑绿色版用这条）
 *   · `npm run pack:release`  → 打发布包（zip 必须干净、**不含** data），
 *                               zip 做完之后**也会**补跑一次本脚本，
 *                               免得打完发布包本机绿色版就变成"空数据"
 *
 * 真实踩过：先 `pack:release` 打了干净包，再直接双击 `release/win-unpacked/NekoFM.exe`，
 * 程序按自己的逻辑在 exe 同目录**新建了一份空 data**（默认配置 + 空 cache），
 * 表现就是"**信息全丢**"—— 其实开发版那份一点没动，只是联接没了、绿色版读了新空目录。
 *
 * 用法：node tools/link-data.js       （幂等，重复跑没事）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const target = path.join(ROOT, 'data');                              // 开发版数据目录（真身）
const link = path.join(ROOT, 'release', 'win-unpacked', 'data');     // 绿色版数据目录（联接）

if (!fs.existsSync(path.join(ROOT, 'release', 'win-unpacked'))) {
  console.error('[link-data] 还没打包过（缺 release/win-unpacked）。先跑 npm run pack');
  process.exit(1);
}
if (!fs.existsSync(target)) {
  fs.mkdirSync(target, { recursive: true });
}

// 已经是指向目标的联接 → 什么都不用做
try {
  const st = fs.lstatSync(link);
  if (st.isSymbolicLink()) {
    const cur = fs.readlinkSync(link);
    if (path.resolve(cur) === target) {
      console.log('[link-data] 已经是联接到开发版数据目录，无需处理');
      process.exit(0);
    }
  }
  /**
   * 这里可能是**真实目录**（打包时 electron-builder 建的空 data，或上次跑出来的数据）。
   * 直接删有丢数据的风险，所以只删**空目录**；非空就报错让用户自己确认。
   *
   * 最常见的来路就是"打完发布包后直接双击了 exe"—— 绿色版在 exe 同目录新建了一份
   * 空 data。所以报错信息要把**两个目录的体积**都摆出来，让人一眼判断该删哪个。
   */
  const entries = fs.readdirSync(link);
  if (entries.length) {
    const size = (p) => {
      let total = 0;
      const walk = (d) => {
        let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of es) {
          const full = path.join(d, e.name);
          try { if (e.isDirectory()) walk(full); else total += fs.statSync(full).size; } catch { /* 忽略 */ }
        }
      };
      walk(p);
      return (total / 1024 / 1024).toFixed(1) + ' MB';
    };
    const hasCfg = (p) => fs.existsSync(path.join(p, 'config.json'));
    console.error(`[link-data] ${link} 是个**非空真实目录**，不是联接，不敢自动删。`);
    console.error('');
    console.error('  这是怎么来的：打完包之后直接双击了 exe，绿色版就在 exe 同目录新建了一份 data。');
    console.error('  它里面通常只有**默认配置**，你真正的东西在开发版那份里。');
    console.error('');
    console.error(`    绿色版目录（要删的）: ${link}   ${size(link)}${hasCfg(link) ? '（有 config.json）' : ''}`);
    console.error(`    开发版目录（真正的）: ${target}   ${size(target)}${hasCfg(target) ? '（有 config.json）' : ''}`);
    console.error('');
    console.error('  确认绿色版那份没用之后，把它整个删掉（或改名挪走），再重跑本脚本即可：');
    console.error(`    rmdir /s /q "${link}"`);
    console.error('    然后想在本机跑绿色版就用：npm run pack（会自动重建联接）');
    process.exit(1);
  }
  fs.rmdirSync(link);
} catch (e) {
  if (e.code !== 'ENOENT') { console.error('[link-data] 检查失败：', e.message); process.exit(1); }
}

try {
  fs.symlinkSync(target, link, 'junction');
  console.log(`[link-data] 已建立联接：${link}  →  ${target}`);
  console.log('  绿色版与开发版从此共用同一份数据（配置 / 缓存 / 登录态）');
} catch (e) {
  console.error('[link-data] 建立联接失败：', e.message);
  process.exit(1);
}
