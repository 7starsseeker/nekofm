/**
 * 预览窗拉边改大小的几何计算 单测
 * ==============================
 * 这段逻辑原本长在主进程的 `overlayResize` 里，只能靠真鼠标拖才验得到 ——
 * 抽成纯函数（src/core/overlay-window.js）之后，边界情形可以一条条钉住。
 * 重点是**拉过头时钉住对边**：只夹尺寸不收回坐标的话，窗口会跟着光标整体平移
 * （拖左上角最容易看出来），用户只会觉得"拉小了就乱跑"。
 */
'use strict';
const assert = require('assert');
const { nextBounds, OVERLAY_EDGES, OVERLAY_MIN } = require('../src/core/overlay-window');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '\n      ', e.message); fail++; }
};

/** 拖动起点：一个像信息卡片预览那样的窗口 */
const B = { x: 400, y: 300, width: 460, height: 140 };

console.log('== 八个方向都认得 ==');
t('边名一共 8 个（四边 + 四角）', () => {
  assert.strictEqual(OVERLAY_EDGES.length, 8);
  assert.deepStrictEqual([...OVERLAY_EDGES].sort(), ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
});
t('没动鼠标就一点不变', () => {
  for (const edge of OVERLAY_EDGES) {
    assert.deepStrictEqual(nextBounds(B, edge, 0, 0), B, edge + ' 不该动');
  }
});

console.log('== 四条边 ==');
t('拉右边：只变宽，位置不动', () => {
  assert.deepStrictEqual(nextBounds(B, 'e', 60, 0), { x: 400, y: 300, width: 520, height: 140 });
});
t('拉左边：x 与宽同时变，右边界留在原地', () => {
  const r = nextBounds(B, 'w', 60, 0);
  assert.deepStrictEqual(r, { x: 460, y: 300, width: 400, height: 140 });
  assert.strictEqual(r.x + r.width, B.x + B.width, '右边界应钉住');
});
t('拉下边：只变高', () => {
  assert.deepStrictEqual(nextBounds(B, 's', 0, 40), { x: 400, y: 300, width: 460, height: 180 });
});
t('拉上边：y 与高同时变，下边界留在原地', () => {
  const r = nextBounds(B, 'n', 0, 40);
  assert.strictEqual(r.y, 340);
  assert.strictEqual(r.height, 100);
  assert.strictEqual(r.y + r.height, B.y + B.height, '下边界应钉住');
});

console.log('== 四个角 ==');
t('右下角：宽高一起长，位置不动', () => {
  assert.deepStrictEqual(nextBounds(B, 'se', 30, 20), { x: 400, y: 300, width: 490, height: 160 });
});
t('左上角：x/y 退，宽高双向变长，右下角钉住', () => {
  const r = nextBounds(B, 'nw', -30, -20);
  assert.deepStrictEqual(r, { x: 370, y: 280, width: 490, height: 160 });
  assert.strictEqual(r.x + r.width, B.x + B.width);
  assert.strictEqual(r.y + r.height, B.y + B.height);
});
t('右上角 / 左下角：各只动一个坐标', () => {
  assert.deepStrictEqual(nextBounds(B, 'ne', 25, -15), { x: 400, y: 285, width: 485, height: 155 });
  assert.deepStrictEqual(nextBounds(B, 'sw', -25, 15), { x: 375, y: 300, width: 485, height: 155 });
});

console.log('== 夹最小尺寸（拉过头的那个 bug） ==');
t('拉右边过头：宽度停在最小值，x 不动', () => {
  const r = nextBounds(B, 'e', -10000, 0);
  assert.strictEqual(r.width, OVERLAY_MIN.width);
  assert.strictEqual(r.x, B.x);
});
t('拉左边过头：宽度停在最小值，**右边界不许跟着跑**', () => {
  const r = nextBounds(B, 'w', 10000, 0);
  assert.strictEqual(r.width, OVERLAY_MIN.width);
  assert.strictEqual(r.x + r.width, B.x + B.width, '拉过头后右边界必须还在原处');
});
t('拉上边过头：高度停在最小值，下边界留在原处', () => {
  const r = nextBounds(B, 'n', 0, 10000);
  assert.strictEqual(r.height, OVERLAY_MIN.height);
  assert.strictEqual(r.y + r.height, B.y + B.height);
});
t('左上角拉过头：宽高都到底，右下角仍钉在 (860,440)', () => {
  const r = nextBounds(B, 'nw', 10000, 10000);
  assert.strictEqual(r.width, OVERLAY_MIN.width);
  assert.strictEqual(r.height, OVERLAY_MIN.height);
  assert.strictEqual(r.x + r.width, B.x + B.width);
  assert.strictEqual(r.y + r.height, B.y + B.height);
});
t('最小尺寸可以外部指定（与建窗时给的一致）', () => {
  const r = nextBounds(B, 'e', -10000, 0, { width: 320, height: 200 });
  assert.strictEqual(r.width, 320);
});
t('尺寸是整数（setBounds 不收小数）', () => {
  const r = nextBounds(B, 'se', 0.4, 0.6);
  assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height)
    && Number.isInteger(r.x) && Number.isInteger(r.y));
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
