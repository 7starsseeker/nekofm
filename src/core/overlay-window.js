/**
 * 预览窗拉边改大小的几何计算（纯函数，故意不碰 Electron）。
 *
 * 为什么要单独一个文件：主进程里的 `overlayResize` 要读真实光标位置
 * （`screen.getCursorScreenPoint()`），那玩意儿在 Node 单测里拿不到 ——
 * 于是"算新尺寸"这一段就抽出来，只吃数字、只吐数字，能直接测。
 * 撑边界的几种夹法（尤其是**拉过头时钉住对边**）是最容易写错的地方，
 * 实测拖到最小时窗口会跟着光标平移就是这一类 bug。
 */

/** 拖得到的八个方向：四边 + 四角 */
const OVERLAY_EDGES = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'];

/** 预览窗最小尺寸：再小连工具条都放不下，也没法再拖回来（与 index.js 里建窗时给的一致） */
const OVERLAY_MIN = { width: 200, height: 90 };

/**
 * 按拖动的边算新的窗口 bounds。
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds 拖动开始时的窗口位置尺寸
 * @param {string} edge 八个方向之一（n/s/w/e + 四角），见 OVERLAY_EDGES
 * @param {number} dx 光标相对拖动起点的横向位移（右为正）
 * @param {number} dy 光标相对拖动起点的纵向位移（下为正）
 * @param {{width:number,height:number}} [min] 最小尺寸，默认 OVERLAY_MIN
 * @returns {{x:number,y:number,width:number,height:number}} 整数化的新 bounds
 */
function nextBounds(bounds, edge, dx, dy, min = OVERLAY_MIN) {
  const b = bounds;
  let x = b.x;
  let y = b.y;
  let width = b.width;
  let height = b.height;
  // 西/北边是"同时改位置和尺寸"的：左边界右移 = 宽度变小、x 变大
  if (edge.includes('e')) width = b.width + dx;
  if (edge.includes('s')) height = b.height + dy;
  if (edge.includes('w')) { width = b.width - dx; x = b.x + dx; }
  if (edge.includes('n')) { height = b.height - dy; y = b.y + dy; }

  /*
    触底时**钉住对边**：先夹尺寸，再把被拖动那侧的坐标收回来。
    只夹尺寸不收回坐标的话，继续往反方向拖会让窗口整体平移
    （拖左上角拉过头时最明显 —— 窗口开始跟着光标跑，而不是停住）。
  */
  if (width < min.width) {
    if (edge.includes('w')) x = b.x + b.width - min.width;
    width = min.width;
  }
  if (height < min.height) {
    if (edge.includes('n')) y = b.y + b.height - min.height;
    height = min.height;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

module.exports = { nextBounds, OVERLAY_EDGES, OVERLAY_MIN };
