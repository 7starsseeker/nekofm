/**
 * 信息卡封面渲染：回归测试
 * =========================
 * 代码块是**从 `src/renderer/assets/overlay.js` 现抽出来的**（不是手抄一份），
 * 所以这里测的就是真文件里的那段逻辑；同时用"修复前"的版本跑同一串状态，
 * 证明断言确实会红（否则就是假测试）。
 *
 * 覆盖的正是 2026-09-27 用户报障：
 *   网易云歌（有封面）→ 打开本地视频（无封面 → 图被藏起来）→ 播回刚才那首网易云歌
 *   修复前：`src` 与 `<img>` 上的属性相同 → 走进"什么都不用做"的分支 → 封面再也不显示，
 *          要点一下「下一首」再「上一首」（中途 src 被别的歌换过）才恢复。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'overlay.js');
const text = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

const START = 'if (b.showCover) {';
const END = `    } else {
      els.ibCover.parentElement.hidden = true;
    }\n`;
const i = text.indexOf(START);
const j = text.indexOf(END, i);
if (i < 0 || j < 0) {
  console.error('❌ 没能从 overlay.js 里抽出封面代码块（renderInfoBar 的封面部分被移动或改名了？）');
  process.exit(1);
}
const FIXED = text.slice(i, j + END.length);

/** 修复前的写法（只用于证明断言会红） */
const BROKEN = `if (b.showCover) {
      els.ibCover.parentElement.hidden = false;
      const src = np.cover || '';
      if (src && els.ibCover.getAttribute('src') !== src) {
        els.ibCover.hidden = false;
        els.ibCoverFallback.hidden = true;
        els.ibCover.onerror = () => { els.ibCover.hidden = true; els.ibCoverFallback.hidden = false; };
        els.ibCover.src = src;
      } else if (!src) {
        els.ibCover.hidden = true;
        els.ibCoverFallback.hidden = false;
      }
    } else {
      els.ibCover.parentElement.hidden = true;
    }
`;

function makeEls() {
  const img = {
    hidden: false, dataset: {}, _a: {}, onerror: null,
    getAttribute(k) { return this._a[k]; },
    get src() { return this._a.src; },
    set src(v) {
      this._a.src = v;
      // 名字里带 broken 的图当作"加载失败"；真实浏览器里 error 是异步派发的，
      // 这里也刻意同步触发 —— 正好能压出"先赋 src 再改显示状态会把 onerror 盖掉"的顺序 bug
      if (/broken/.test(v) && this.onerror) this.onerror();
    },
  };
  img.parentElement = { hidden: false };
  return { infoBar: { classList: { toggle() {} } }, ibCover: img, ibCoverFallback: { hidden: true } };
}

/** 跑一串封面地址（'' = 这首没封面），返回每一步之后 <img> 是否可见 */
function run(block, covers) {
  const els = makeEls();
  const b = { showCover: true };
  const steps = [];
  for (const c of covers) {
    // eslint-disable-next-line no-new-func
    new Function('els', 'b', 'np', block)(els, b, { cover: c });
    steps.push({ cover: c || '(无)', visible: !els.ibCover.hidden });
  }
  return steps;
}

const A = 'https://p2.music.126.net/aaa.jpg';
const D = 'https://p2.music.126.net/ddd.jpg';
const BAD = 'https://p2.music.126.net/broken.jpg';

let pass = 0;
let fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label); } else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); }
};

console.log('== 信息卡封面：当前实现 ==');
const s = run(FIXED, [A, '', A, D, A, BAD, BAD, A]);
console.log('  ' + s.map((x) => `${x.cover.replace(/^.*\//, '')}:${x.visible ? '显示' : '隐藏'}`).join(' → '));
check('有封面 → 显示', s[0].visible === true);
check('无封面的曲目（本地视频没有图）→ 落回音符占位', s[1].visible === false);
check('播回同一首歌 → 封面重新显示', s[2].visible === true, '仍然隐藏');
check('换另一首有封面的 → 显示', s[3].visible === true);
check('再回到那首 → 显示', s[4].visible === true);
check('封面加载失败 → 落回占位', s[5].visible === false);
check('同一张失败的图再渲染 → 保持占位（不硬撑破图）', s[6].visible === false);
check('之后换一首好的 → 还能正常显示', s[7].visible === true);

console.log('\n== 修复前的写法：同一串状态（证明上面第 3 条断言会红）==');
const o = run(BROKEN, [A, '', A, D, A, BAD, BAD, A]);
console.log('  ' + o.map((x) => `${x.cover.replace(/^.*\//, '')}:${x.visible ? '显示' : '隐藏'}`).join(' → '));
check('旧版在"播回同一首歌"处确实是坏的（隐藏）', o[2].visible === false, '旧版竟然显示了 → 这条测试失去意义，需要重写场景');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
