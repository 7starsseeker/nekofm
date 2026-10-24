'use strict';
/**
 * 渲染层「卡片归位」回归网（段 2 的前置条件）。
 *
 * 为什么需要它：`src/renderer/assets/ui/shell.js` 靠**按 h2 标题前缀匹配**把卡片搬进
 * 五个面，匹配失败时是**静默兜底**（塞进「审核诊断」+ 一行 console.warn），页面看起来
 * 完全正常，只是卡片跑错了地方。段 2 要按「面」拆模块、逐面改写渲染，这张网用来在
 * 每次移动卡片之后立刻回答三个问题：
 *   ① 有没有卡片没登记进 FACES（会静默掉进「审核诊断」）？
 *   ② 有没有 FACES 里登记的卡片在 HTML 里已经不存在（陈旧条目，会永远匹配不上）？
 *   ③ 有没有卡片被两个面同时认领（长前缀优先会掩盖这种笔误）？
 *
 * 纯静态解析（无 DOM、无浏览器、无依赖），所以能进 `npm test` 常跑。
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✅ ' + name);
  } catch (e) {
    fail++;
    console.log('  ❌ ' + name + '\n     ' + String(e.message).split('\n')[0]);
  }
}

/* ------------------------------------------------------------ 解析 HTML 里的卡片 */

/** 从 `control.html` 抠出所有 `div.card` 的标题（取 h2 的第一段纯文本，与 shell.js 的 titleOf 等价）。 */
function parseCards() {
  const html = read('src/renderer/control.html');
  const cards = [];
  const re = /<div class="card"(?:\s+id="([^"]*)")?\s*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = m.index + m[0].length;
    const nextCard = html.indexOf('<div class="card"', start);
    const h2 = html.indexOf('<h2', start);
    // h2 必须落在本卡片范围内，否则说明这张卡没标题（那时 shell.js 也归不了位）
    if (h2 === -1 || (nextCard !== -1 && h2 > nextCard)) {
      cards.push({ id: m[1] || '', title: null });
      continue;
    }
    const gt = html.indexOf('>', h2);
    const end = html.indexOf('</h2>', gt);
    const raw = html.slice(gt + 1, end);
    const title = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    cards.push({ id: m[1] || '', title });
  }
  return cards;
}

/* ------------------------------------------------------- 解析 shell.js 的 FACES */

/** 抠出 FACES 数组：每个 `key: 'x'` 后面的 `cards: [...]`。 */
function parseFaces() {
  const js = read('src/renderer/assets/ui/shell.js');
  const start = js.indexOf('var FACES = [');
  assert.notStrictEqual(start, -1, 'shell.js 里找不到 `var FACES = [`');
  // 从 FACES 起点向后括到配平的 `];`
  let depth = 0;
  let end = -1;
  for (let i = js.indexOf('[', start); i < js.length; i++) {
    if (js[i] === '[') depth++;
    else if (js[i] === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notStrictEqual(end, -1, 'FACES 数组没闭合');
  const body = js.slice(start, end);

  const faces = [];
  const keyRe = /\bkey:\s*'([^']+)'/g;
  const cardRe = /cards:\s*\[([^\]]*)\]/g;
  let km;
  const keys = [];
  while ((km = keyRe.exec(body)) !== null) keys.push({ key: km[1], at: km.index });
  let cm;
  let idx = 0;
  while ((cm = cardRe.exec(body)) !== null) {
    // 归属：最近一个在它之前的 key
    let owner = keys[0];
    for (const k of keys) if (k.at < cm.index) owner = k;
    const titles = cm[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    faces.push({ key: owner.key, titles });
    idx++;
  }
  // 含 pinned 的面（设置钉底部）——只做提示，不做断言
  return faces;
}

/** shell.js 里「队列恒在右栏」的判定前缀（与源码保持同一份事实来源）。 */
function parseRailPrefixes() {
  const js = read('src/renderer/assets/ui/shell.js');
  const m = /t\.indexOf\('([^']+)'\)\s*===\s*0\s*\|\|\s*t\.indexOf\('([^']+)'\)\s*===\s*0/.exec(js);
  assert.ok(m, 'shell.js 里找不到「队列恒在右栏」的判定（源码形状变了，这条断言要跟着改）');
  return [m[1], m[2]];
}

/* --------------------------------------------------------------- 复刻归位算法 */

function buildMap(cards, faces, railPrefixes) {
  const prefixList = [];
  for (const f of faces) for (const t of f.titles) prefixList.push({ t, key: f.key });
  // 长的先试（与 shell.js 一致：「已保存播放列表」必须先于「已保存」命中）
  prefixList.sort((a, b) => b.t.length - a.t.length);

  const map = [];
  for (const c of cards) {
    const t = c.title || '';
    if (railPrefixes.some((p) => t.indexOf(p) === 0)) { map.push({ title: t, face: 'rail', id: c.id }); continue; }
    const hit = prefixList.find((p) => t.indexOf(p.t) === 0);
    map.push({ title: t, face: hit ? hit.key : null, id: c.id });
  }
  return map;
}

/* ------------------------------------------------------------------ 断言开始 */

console.log('渲染层卡片归位：');

const cards = parseCards();
const faces = parseFaces();
const railPrefixes = parseRailPrefixes();

check('control.html 里能解析出卡片（>0）', () => {
  assert.ok(cards.length > 0, '一张卡都没解析到，说明 HTML 形状变了');
});

check('每张卡都有 h2 标题（没有标题的卡必然静默掉进「审核诊断」）', () => {
  const bad = cards.filter((c) => !c.title);
  assert.deepStrictEqual(bad.map((c) => c.id || '(无 id)'), [], '这些卡没有 h2：' + bad.map((c) => c.id || '(无 id)').join(', '));
});

let map = [];
check('所有卡片都归到某个面或右栏（没有 unmatched）', () => {
  map = buildMap(cards, faces, railPrefixes);
  const lost = map.filter((x) => !x.face);
  assert.deepStrictEqual(lost.map((x) => x.title), [], '这些卡片没登记进 FACES，会静默掉进「审核诊断」');
});

check('FACES 里没有陈旧的卡片标题（HTML 里已不存在）', () => {
  const titles = new Set(cards.map((c) => c.title));
  const stale = [];
  for (const f of faces) for (const t of f.titles) {
    const anyMatch = [...titles].some((x) => x && x.indexOf(t) === 0);
    if (!anyMatch) stale.push(f.key + ' → ' + t);
  }
  assert.deepStrictEqual(stale, [], 'FACES 登记了 HTML 里不存在的标题：' + stale.join(' / '));
});

check('没有卡片被两个面同时认领（长前缀优先会掩盖这种笔误）', () => {
  const dup = [];
  const seen = new Map();
  for (const f of faces) for (const t of f.titles) {
    if (seen.has(t)) dup.push(t + '（' + seen.get(t) + ' 与 ' + f.key + '）');
    else seen.set(t, f.key);
  }
  assert.deepStrictEqual(dup, [], '重复登记：' + dup.join(' / '));
});

check('卡片总数 = 各面 + 右栏（拆分时不许丢卡）', () => {
  const byFace = {};
  for (const x of map) byFace[x.face] = (byFace[x.face] || 0) + 1;
  const sum = Object.values(byFace).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, cards.length, '面内卡片合计 ' + sum + ' ≠ HTML 卡片数 ' + cards.length + '（分布 ' + JSON.stringify(byFace) + '）');
});

check('server.js 已注册 /console 路由', () => {
  const js = read('src/main/server.js');
  assert.ok(/'\/console'\s*:\s*'control\.html'/.test(js), 'server.js 的页面 map 里没有 /console');
});

check('control.html 已挂上 shell.css 与 shell.js', () => {
  const html = read('src/renderer/control.html');
  assert.ok(/href="\/assets\/ui\/shell\.css"/.test(html), 'control.html 没有引用 /assets/ui/shell.css');
  assert.ok(/src="\/assets\/ui\/shell\.js"/.test(html), 'control.html 没有引用 /assets/ui/shell.js');
});

/* ------------------------------------------------- 面模块接线（段 2 每搬一个面就加一条） */
/*
 * 为什么这条必须有：面模块是 `<script>` 顺序加载的普通全局脚本。少挂一个 `<script>`、
 * 或者把它挂在 `control.js` 之后，页面**照样能打开**，只是那个面的按钮全都没反应
 * —— 这正是"静默失败"，靠肉眼看不出来。所以：磁盘上有 face-*.js，就必须
 * ①被 control.html 引用 ②在 /assets/control.js **之前** ③control.js 里真的调了它的 init。
 */
console.log('\n面模块接线：');

const UI_DIR = path.join(ROOT, 'src/renderer/assets/ui');
const faceFiles = fs.readdirSync(UI_DIR).filter((f) => /^face-[\w-]+\.js$/.test(f)).sort();
const htmlSrc = read('src/renderer/control.html');
const controlSrc = read('src/renderer/assets/control.js');
const controlTagAt = htmlSrc.indexOf('src="/assets/control.js"');

check('assets/ui/ 下至少有 1 个面模块', () => {
  assert.ok(faceFiles.length >= 1, '一个 face-*.js 都没找到，段 2 的模块化等于没做');
});

for (const file of faceFiles) {
  const key = file.replace(/^face-/, '').replace(/\.js$/, '');
  check(`面模块 ${file}：已挂载、顺序正确、宿主真的调了它`, () => {
    const tagAt = htmlSrc.indexOf(`src="/assets/ui/${file}"`);
    assert.ok(tagAt >= 0, `control.html 没有引用 /assets/ui/${file}`);
    assert.ok(controlTagAt >= 0, 'control.html 里找不到 /assets/control.js');
    assert.ok(tagAt < controlTagAt, `${file} 挂在 control.js 之后了 —— 宿主启动时调 init 会拿到 undefined`);
    const callable = new RegExp('__nekofmFaces\\s*&&[^\\n]*__nekofmFaces\\.' + key + '\\b|__nekofmFaces\\.' + key + '\\s*\\(');
    assert.ok(callable.test(controlSrc), `control.js 里没找到调用 window.__nekofmFaces.${key}(...) 的地方`);
  });
}

/* ------------------------------------------------------------------- lit 接线 */

/* vendor 里那份 lit-html 是纯 ESM，只能用 <script type="module"> 加载。
 * 少了 type="module" 的话浏览器会按 classic 解析、直接 SyntaxError，而渲染侧
 * 的 canLit() 闸门只会「这一帧不画」——表现就是在线缓存列表空着、控制台一条
 * 报错都没有。这种静默失败必须在测试里挡掉。 */
check('lit-html：vendor 文件在位、加载器与宿主接线齐全', () => {
  const vendorPath = path.join(ROOT, 'src/renderer/assets/vendor/lit-html.js');
  assert.ok(fs.existsSync(vendorPath), 'src/renderer/assets/vendor/lit-html.js 不存在');
  assert.ok(fs.statSync(vendorPath).size > 5000, 'vendored lit-html.js 体积异常（应约 7.3KB）');
  const loader = read('src/renderer/assets/ui/lit.js');
  assert.ok(/from\s+'\/assets\/vendor\/lit-html\.js'/.test(loader), 'lit.js 没有从 /assets/vendor/lit-html.js 导入');
  assert.ok(/__nekofmLit\s*=/.test(loader), 'lit.js 没有把句柄挂到 window.__nekofmLit');
  assert.ok(/nekofm:lit-ready/.test(loader), 'lit.js 没有派发 nekofm:lit-ready');
  const modTag = htmlSrc.match(/<script type="module" src="\/assets\/ui\/lit\.js"><\/script>/);
  assert.ok(modTag, 'control.html 里的 lit.js 必须是 <script type="module">（classic 解析会 SyntaxError）');
  assert.ok(controlSrc.includes('function canLit()'), 'control.js 里没有 canLit() 闸门');
  assert.ok(controlSrc.includes('nekofm:lit-ready'), 'control.js 没有监听 nekofm:lit-ready（列表会一直空着）');
});

/* ------------------------------------------------------------ 顶层调用不能撞 TDZ
 *
 * control.js 是一个大 IIFE，里面用 `const` / `function` 声明的东西有**严格的先后**。
 * 2026-10-25 真实踩到：`onLitReady(paintBlacklist)` 被写在 `const litReadyHooks`
 * 之前 ⇒ 抛 `ReferenceError: Cannot access 'litReadyHooks' before initialization`，
 * 而那是 IIFE#1 的顶层语句 ⇒ **整个 IIFE#1 挂掉**：旧版面 21 张卡全堆在 main 里、
 * 5 个页签点了没反应，而 smoke 和 12 个测试文件全绿（它们都不打开 `/`）。
 * 这类静默失败必须在静态检查里挡掉。 */
check('control.js：onLitReady(...) 的调用点必须在 litReadyHooks 声明之后', () => {
  // 先把注释剥掉再扫：否则注释里那句「见那边的 onLitReady(paintBlacklist)」会被当成调用点。
  // 只剥块注释与整行的 // 注释 —— 行尾注释里的代码片段不值得为它写个词法器。
  const clean = controlSrc
    .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (s) => s.replace(/[^\n]/g, ' '));
  const declAt = clean.indexOf('const litReadyHooks');
  assert.ok(declAt >= 0, 'control.js 里找不到 const litReadyHooks 声明');
  const re = /onLitReady\s*\(/g;
  let m;
  let checked = 0;
  while ((m = re.exec(clean))) {
    // 跳过函数自身的声明 `function onLitReady(fn)`
    const before = clean.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s+$/.test(before)) continue;
    checked += 1;
    assert.ok(
      m.index > declAt,
      'control.js 第 ' + (clean.slice(0, m.index).split('\n').length) + ' 行的 onLitReady(...) '
        + '在 const litReadyHooks 声明之前 —— 会抛 ReferenceError 并让整个 IIFE#1 挂掉'
    );
  }
  assert.ok(checked >= 1, '没找到任何 onLitReady(...) 调用点，这条断言形同虚设');
});

/* ------------------------------------------------------------------- 打一张地图 */

console.log('\n当前归位（' + cards.length + ' 张卡）：');
const byFace2 = {};
for (const x of map) (byFace2[x.face || '?!'] = byFace2[x.face || '?!'] || []).push(x.title);
for (const k of Object.keys(byFace2)) {
  console.log('  ' + (k === 'rail' ? '右栏(恒显示)' : k) + '：' + byFace2[k].join(' / '));
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
