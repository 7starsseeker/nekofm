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
 * ⚠️ **每次重新打包都要跑一次**：`electron-builder` 会清空并重建 `release/`，
 * 这个联接会跟着消失。所以 `npm run pack` 已经把它串在后面了。
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
   */
  const entries = fs.readdirSync(link);
  if (entries.length) {
    console.error(`[link-data] ${link} 是个非空真实目录，不敢自动删。`);
    console.error('  里面可能是绿色版自己产生的数据 —— 确认无用后手动删掉它，再重跑本脚本。');
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
