# vendor/lit-html.js

第三方代码，**原样收录、不做任何修改**（含原有 @license 头）。

| 项 | 值 |
|---|---|
| 包 | `lit-html` |
| 版本 | 3.3.3 |
| 源文件 | `node_modules/lit-html/lit-html.js`（npm 包里的生产构建，minified 单文件 ESM） |
| 体积 | 7,309 字节 |
| sha256 | `b878e7f95dec8a9b6e9b217faca6b6a11bad82ebc44c0caa77419ed83edd81f2` |
| 许可 | BSD-3-Clause（全文见同目录 `lit-html.LICENSE`） |
| 升级方式 | `npm i -D lit-html@<ver>` 后把 `node_modules/lit-html/lit-html.js` 与 `LICENSE` 拷回本目录，并更新本表的版本 / 体积 / sha256 |

## 为什么要 vendor 而不是从 node_modules 引用

CSP 是 `script-src 'self'`（`src/main/server.js` 以响应头 + `<meta>` 双份注入，
见该文件 CSP 常量），因此**不允许任何 CDN 脚本**；而 `node_modules/` 不在
`build.files` 里（打包只带 `src/**/*`），从 node_modules 引用会在打包版里 404。

`src/main/server.js` 的静态转发是**前缀式**的：`/assets/` → `src/renderer/assets/`，
所以本目录下的文件直接以 `/assets/vendor/...` 就能取到，**不需要新增路由**。

## 为什么必须用 `<script type="module">` 加载

`lit-html.js` 是纯 ESM（文件末尾 `export{ html, render, nothing, ... }`，且**零内部 import**，
整包就这一个文件），无法用 classic script 加载。加载器见 `src/renderer/assets/ui/lit.js`，
它把 `{html, render, nothing, svg}` 挂到 `window.__nekofmLit` 并派发
`nekofm:lit-ready` 事件。

**时序**：module 一律 defer，执行在所有 classic script 之后，所以 `control.js`
在解析期跑的第一帧**拿不到** `window.__nekofmLit`。渲染侧因此必须先查可用性、
不可用就跳过这一帧，再由 `nekofm:lit-ready` 触发重画 —— 不要写两套实现
（一套字符串、一套模板），那会让同一个事实有两个副本。
