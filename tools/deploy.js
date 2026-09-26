#!/usr/bin/env node
/**
 * 部署脚本：把本项目复制到目标目录（例如 T:\nekofm）
 * ==================================================
 * 为什么要有它：
 *   1) 可复现部署 —— 换机器、换盘，一条命令搞定，不用回忆该拷哪些东西
 *   2) 明确排除项 —— node_modules / data / .git / 日志绝不覆盖目标端现有的
 *   3) **只增不删** —— 绝不做镜像删除，目标端的 config、曲库缓存、登录会话都安全
 *
 * 用法（Windows）：
 *   node tools\deploy.js D:\nekofm
 *   node tools\deploy.js D:\nekofm --install      :: 顺便在目标目录装依赖
 *
 * 用法（Linux / macOS）：
 *   node tools/deploy.js /opt/nekofm
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 永不复制的东西：依赖、运行数据、版本库、日志
const EXCLUDE_DIRS = new Set(['node_modules', 'data', '.git', '.playwright-mcp']);
const EXCLUDE_EXT = new Set(['.log']);
const EXCLUDE_FILES = new Set(['package-lock.json']);

function parseArgs(argv) {
  const args = { target: null, install: false, dryRun: false, verbose: false };
  for (const a of argv) {
    if (a === '--install') args.install = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (!a.startsWith('--') && !args.target) args.target = a;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.target) {
  console.error('用法: node tools/deploy.js <目标目录> [--install] [--dry-run] [--verbose]');
  process.exit(2);
}

const SRC = path.resolve(__dirname, '..');
const DST = path.resolve(args.target);

// 安全闸：源与目标不能相同、目标不能是源的父目录（否则会自我覆盖）
if (SRC === DST) {
  console.error('✗ 目标目录与源目录相同，拒绝执行');
  process.exit(2);
}
if (SRC.startsWith(DST + path.sep)) {
  console.error('✗ 目标目录是源目录的上级，拒绝执行');
  process.exit(2);
}

let copied = 0;
let skipped = 0;
let bytes = 0;
const copiedList = [];

function walk(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) { skipped++; continue; }
      walk(abs, r);
      continue;
    }
    if (EXCLUDE_EXT.has(path.extname(e.name).toLowerCase()) || EXCLUDE_FILES.has(e.name)) { skipped++; continue; }

    const dst = path.join(DST, r);
    // 内容一致就跳过，避免无谓写入（也便于看"这次到底同步了什么"）
    try {
      const a = fs.statSync(abs);
      if (fs.existsSync(dst)) {
        const b = fs.statSync(dst);
        if (a.size === b.size && fs.readFileSync(abs).equals(fs.readFileSync(dst))) { skipped++; continue; }
      }
    } catch { /* 读不到就当需要复制 */ }

    if (args.dryRun) {
      copiedList.push('  [dry] ' + r);
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(abs, dst);
      copiedList.push('  ' + r);
    }
    copied++;
    try { bytes += fs.statSync(abs).size; } catch { /* 忽略 */ }
  }
}

console.log(`源目录: ${SRC}`);
console.log(`目标:   ${DST}${args.dryRun ? '  （dry-run，不写盘）' : ''}`);
console.log('');

fs.mkdirSync(DST, { recursive: true });
walk(SRC);

if (args.verbose) console.log(copiedList.join('\n'));

console.log('');
console.log(`文件：更新 ${copied} 个，跳过 ${skipped} 个（依赖/数据/日志/未变化）`);
console.log(`体积：${(bytes / 1024).toFixed(1)} KB`);
console.log(`排除：${[...EXCLUDE_DIRS].join(', ')} 与 *.log —— 目标端的配置、缓存、登录会话不受影响`);

if (args.install && !args.dryRun) {
  const hasModules = fs.existsSync(path.join(DST, 'node_modules', 'electron'));
  if (hasModules) {
    console.log('\n目标目录已有 node_modules（Electron 就位），跳过安装。');
  } else {
    console.log('\n正在目标目录安装依赖…');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    try {
      execFileSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: DST, stdio: 'inherit' });
      console.log('依赖安装完成。');
    } catch (e) {
      console.error('依赖安装失败：', e.message);
      process.exitCode = 1;
    }
  }
}

console.log('\n下一步：');
console.log(`  1) 在 ${DST} 里双击 start.bat（或 npx electron .）`);
console.log('  2) 控制台 → 测试中心 → 运行全部，确认环境正常');
console.log('  3) 控制台 → 网易云登录 → 打开登录窗（会员曲必需）');
