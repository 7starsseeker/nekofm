#!/usr/bin/env node
/**
 * 入库自检：确认**没有任何属于使用者的凭据或运行时数据**进了版本库
 * ==============================================================
 * 为什么需要它：
 *   本项目的 `data/config.json` 里存着网易云 cookie、B站 cookie、
 *   直播开放平台 `accessKeySecret`，`data/electron/` 下还有 Chromium 的
 *   Cookies 库。这些都是"使用者自己的东西"，一旦跟着 commit 或 release
 *   出了门就是公开泄露。靠人肉检查不可靠 —— 所以钉成一条能自动跑的检查。
 *
 * 检查两层：
 *   1. **路径层**：入库文件里不允许出现 data/ 、PROGRESS.md、.zcode/ 等
 *   2. **内容层**：对文本文件扫高信号凭据特征（cookie 值、密钥、私钥、PAT）
 *
 * 用法：
 *   node tools/check-no-secrets.js          # 在仓库里跑（用 git ls-files）
 *   node tools/check-no-secrets.js --all    # 不依赖 git，按排除表遍历工作区
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const USE_GIT = !process.argv.includes('--all') && fs.existsSync(path.join(ROOT, '.git'));

/** 绝不允许入库的路径（相对仓库根，前缀匹配 / 精确匹配） */
const FORBIDDEN_PATHS = [
  ['dir', 'data/'],
  ['dir', '.zcode/'],
  ['dir', 'node_modules/'],
  ['dir', 'release/'],
  ['file', 'PROGRESS.md'],
  ['file', 'cleanup-c-drive.bat'],
  ['file', 'tools/cleanup-c-drive.js'],
  ['file', 'tools/deploy.js.bak'],
];

/** 遍历时永远不进（--all 模式用） */
const SKIP_DIRS = new Set(['node_modules', 'data', 'release', '.git', '.zcode', '.playwright-mcp', 'dist']);

/**
 * 内容层规则。**都刻意做得很"紧"** —— 宁可漏一点点，也不要因为误报
 * 让维护者养成"这条检查本来就爱红"的习惯，那等于没检查。
 * 每条：{ 名, 正则, 说明 }
 */
const CONTENT_RULES = [
  { name: '网易云登录态', re: /MUSIC_U=[A-Za-z0-9%._-]{16,}/, note: '出现了真实的网易云 cookie 值' },
  { name: 'B站登录态', re: /SESSDATA=[A-Za-z0-9%._,*-]{16,}/, note: '出现了真实的 SESSDATA 值' },
  { name: 'B站 CSRF', re: /bili_jct=[0-9a-f]{32}/, note: '出现了真实的 bili_jct 值' },
  { name: '开放平台密钥', re: /"accessKeySecret"\s*:\s*"[^"\s]{8,}"/, note: 'accessKeySecret 有非空值' },
  { name: '开放平台身份码', re: /"roomOwnerAuthCode"\s*:\s*"[^"\s]{8,}"/, note: '主播身份码有非空值' },
  { name: '配置里的 cookie', re: /"cookie"\s*:\s*"[^"\s]{24,}"/, note: 'cookie 字段有非空的长值' },
  { name: 'GitHub PAT', re: /gh[pousr]_[A-Za-z0-9]{30,}/, note: '出现 GitHub Personal Access Token' },
  { name: '接口 Key', re: /sk-[A-Za-z0-9_-]{24,}/, note: '出现形如 sk- 的接口密钥' },
  { name: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, note: '出现 PEM 私钥' },
  { name: 'AWS 凭据', re: /AKIA[0-9A-Z]{16}/, note: '出现 AWS Access Key ID' },
];

/** 只扫文本、且体积有上限（避免读二进制与超大文件） */
const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.json', '.jsonc', '.md', '.txt', '.yml', '.yaml',
  '.html', '.css', '.bat', '.cmd', '.ps1', '.sh', '.xml', '.toml', '.ini', '.example',
]);
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * 简易 .gitignore 匹配（只支持本项目实际用到的三类写法）：
 *   `dir/`      目录（含其下所有内容）
 *   `*.ext`     后缀通配
 *   `path/name` 精确路径
 * `--all` 模式没有 git 帮忙过滤，就靠它把"本来就被忽略的工作区文件"排除掉，
 * 否则自检会一直对着 PROGRESS.md / data/ 报假警。
 */
function loadIgnore() {
  const file = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => (s.endsWith('/') ? { kind: 'dir', v: s.slice(0, -1) } : { kind: 'glob', v: s.replace(/^\//, '') }));
}

function ignored(rel, rules) {
  const base = rel.split('/').pop();
  for (const r of rules) {
    if (r.kind === 'dir' && (rel === r.v || rel.startsWith(r.v + '/'))) return true;
    if (r.kind === 'glob') {
      if (r.v.startsWith('*') && base.endsWith(r.v.slice(1))) return true;
      if (rel === r.v || rel.endsWith('/' + r.v)) return true;
    }
  }
  return false;
}

function listFiles() {
  if (USE_GIT) {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    return out.toString('utf8').split('\0').filter(Boolean);
  }
  const ignoreRules = loadIgnore();
  const acc = [];
  (function walk(dir, rel = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ignored(r, ignoreRules)) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r); continue; }
      if (e.isFile()) acc.push(r);
    }
  })(ROOT);
  return acc;
}

const files = listFiles();
const problems = [];

// ---------------------------------------------------------------- 路径层
for (const f of files) {
  for (const [kind, pat] of FORBIDDEN_PATHS) {
    const hit = kind === 'dir' ? (f === pat.slice(0, -1) || f.startsWith(pat)) : f === pat;
    if (hit) problems.push({ file: f, rule: '禁止入库路径', note: `匹配规则 ${kind}:${pat}` });
  }
}

// ---------------------------------------------------------------- 内容层
let scanned = 0;
for (const f of files) {
  const abs = path.join(ROOT, f);
  if (TEXT_EXT.size && !TEXT_EXT.has(path.extname(f).toLowerCase()) && !/\.example$/.test(f)) continue;
  let st;
  try { st = fs.statSync(abs); } catch { continue; }
  if (st.size > MAX_BYTES) continue;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  scanned++;
  for (const r of CONTENT_RULES) {
    const m = text.match(r.re);
    if (!m) continue;
    // 报出行号，方便定位；**不回显命中内容本身**（免得把凭据打印到 CI 日志里）
    const line = text.slice(0, m.index).split('\n').length;
    problems.push({ file: f, line, rule: r.name, note: r.note });
  }
}

// ------------------------------------------------------------------ 结果
const line = (s = '') => process.stdout.write(s + '\n');
line('==============================================');
line(' NekoFM · 入库自检（凭据与运行时数据）');
line('==============================================');
line(`文件清单来源：${USE_GIT ? 'git ls-files' : '工作区遍历（--all）'}`);
line(`入库文件 ${files.length} 个；内容扫描 ${scanned} 个文本文件`);
line('');

if (problems.length) {
  line(`✗ 发现 ${problems.length} 处问题：`);
  for (const p of problems) {
    line(`  ${p.file}${p.line ? ':' + p.line : ''}  [${p.rule}] ${p.note}`);
  }
  line('');
  line('这条检查失败**不要用加白名单绕过** —— 说明确实有使用者的凭据或运行时数据要被提交。');
  line('处理方式：把该项加进 .gitignore（若是文件），或把值清空（若在源码/示例里）。');
  process.exit(1);
}

line('✓ 通过：入库文件里没有使用者凭据，也没有 data/ 这类运行时数据。');
process.exit(0);
