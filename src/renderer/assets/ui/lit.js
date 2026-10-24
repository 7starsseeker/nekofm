/**
 * lit-html 加载器（唯一入口）。
 *
 * 为什么单独一个文件：`assets/vendor/lit-html.js` 是纯 ESM（整包一个文件、
 * 零内部 import），只能以 `<script type="module">` 加载；而 control.js 与各
 * face-*.js 都是 classic script。两边唯一的桥就是这里 —— 挂 window + 派发
 * ready 事件，别的地方一律不 import lit。
 *
 * 时序（踩过的坑，别改）：module 一律 defer ⇒ 本文件在所有 classic script
 * **之后**执行。所以 control.js 第一时间渲染时 window.__nekofmLit 还不存在，
 * 渲染侧必须先查可用性、跳过这一帧，然后监听 `nekofm:lit-ready` 重画。
 * 反过来「把渲染函数改成 module」是不行的：control.js 在解析期就同步调
 * __nekofmFaces.X(...) 初始化各面，module 形状的面模块接不到那次同步调用。
 */
import { html, render, nothing, svg } from '/assets/vendor/lit-html.js';

window.__nekofmLit = { html, render, nothing, svg };
window.__nekofmLitVersion = 'lit-html 3.3.3';

window.dispatchEvent(new CustomEvent('nekofm:lit-ready'));
