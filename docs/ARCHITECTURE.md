# 架构说明

> 读完这份能建立起"改动该落在哪个文件"的地图。踩坑原因写在
> [README 第 2 节](../README.md#2-为什么是这样设计的踩过的坑)，这里只讲结构。

## 一句话

一个跑在本机的 Node 服务 + 一个隐藏的 Electron 窗口当播放器 + 若干网页界面。
**没有云端、没有数据库、没有运行时第三方依赖**（只用 Node 内置模块 + Electron）。

```
        B站弹幕                                   浏览器（直播姬 / 控制台）
           │                                                │
           ▼                                                │  HTTP / SSE
  ┌─────────────────┐                                       │
  │  弹幕通道（三选一）│                                      │
  │  openlive 官方   │                                       │
  │  browser 浏览器  │──► 指令解析 ──► 点歌队列               │
  │  直连（降级）    │                    │                  │
  └─────────────────┘                    ▼                  │
                                  音源解析（网易云 / 本地 / B站）
                                         │                  │
                        ┌────────────────┴────────┐         │
                        ▼                         ▼         │
              隐藏窗口的 <audio>            歌词时间轴        │
              （唯一出声的地方）                  │          │
                        │                        └──► SSE ──┘
                        ▼
                 setSinkId 输出设备（音频路由由使用者自己接）
```

---

## 目录与职责

```
src/
  shared/                ★ 主进程与渲染层共用（同一份实现，两边行为天然一致）
    lyric-sync.js        歌词定位（findLine / 插值）
    auto-gain.js         动态音量的决策数学（只算"这次增益定多少"，不出声）
    volume-dial.js       竖刻度音量控件（控制台底栏与播放核心窗共用）

  core/                  ★ 纯 Node，不依赖 Electron —— 可单测、可 headless
    config.js            DEFAULT_CONFIG + dataRoot()/configPath()（决定数据放哪）
    queue.js             点歌队列（去重窗口 / 每人上限 / 冷却 / 权限 / force 回填）
    blacklist.js         黑名单（song / keyword / artist / bvid 四种粒度）
    commands.js          弹幕文本 → 指令对象（纯函数，词表来自 config.commands）
    demo.js              演练模式素材（假曲目 + 假歌词时间轴）
    text-file.js         编码探测读取（歌词/名单文件可能是 GBK）
    overlay-window.js    叠加层窗口几何（拉边改大小的纯函数，有单测）
    lyrics/lrc.js        LRC / 增强型 LRC / 网易云 yrc → 统一 timeline
    netease/
      client.js          网易云客户端（**限流熔断与退避在这里**）
      weapi.js           weapi / eapi 加密（登录与取流用 eapi）
    bilibili/
      wbi.js             WBI 签名（签名后免登录拿弹幕 token）
      danmaku.js         Node 直连弹幕通道（最后的降级，B站风控基本会拒）
      mini-ws.js         极简 WebSocket 客户端（直连通道用，不引依赖）
      open-live.js       官方直播开放平台长连（有凭证时最稳）
      browser-channel.js 系统 Edge/Chrome + CDP 弹幕通道
      browser.js         B站登录窗（只为取 cookie，不拿它发 API）
      api.js             B站 HTTP 接口（视频信息 / 字幕 / 搜索 / 播放地址）

  main/                  ★ Electron 主进程
    index.js             窗口 / 托盘 / 菜单 / 权限 / userData 落点 / 冒烟自检
    engine.js            ★ 播放引擎 —— 最大文件，核心逻辑都在这
    cache.js             MediaCache：音频 + 歌词 + 封面缓存 + 集中索引
    commands.js          /api/command 的指令分发（HTTP → Engine）
    logbus.js            运行日志总线（五级 + 分类 + 环形缓冲 + 落盘）
    server.js            本地 HTTP + SSE 服务、/stream/* 代理
    selftest.js          测试中心（检查项数量见下方「测试分层」）
    sources/
      local.js           本地曲库（递归扫描 / ffprobe 元数据 / 旁车歌词 / 白名单）
      netease-browser.js 借 Electron 登录态会话取直链（"浏览器急兑"）

  renderer/              ★ 全是普通网页，不依赖打包器
    control.html         控制台：**/console 新外壳与 / 旧版面共用这一份 DOM**
    overlay.html         直播姬用的透明歌词叠加层
    player.html          隐藏窗口里的 <audio> 本体
    logs.html            运行日志 / 状态窗口（独立窗口，不进主控制台）
    assets/*.js|css      对应界面的脚本与样式（control.js 是控制台主逻辑）
    assets/ui/           控制台「面」模块：shell.js（新外壳）+ face-*.js（五个面）
                         + lit.js（lit-html 加载器）
    assets/vendor/       vendored lit-html 3.3.3（BSD-3，同源加载 —— CSP 禁 CDN）
```

规模：`src/` 约 22.0k 行 JS（41 个文件），最大单文件 `src/main/engine.js`（4.3k 行），
其次 `src/renderer/assets/control.js`（1.9k 行）。

---

## 控制台有两套版面（`/console` 新外壳 + `/` 旧版面）

0.7.0 起控制台默认打开 `http://127.0.0.1:<port>/console`，而旧的单列版面仍然
原样保留在 `/`，两份**共用同一份 `control.html` 与同一批 id/事件绑定**：

| 路径 | 谁在管版面 | 用途 |
|---|---|---|
| `/console`（默认） | `assets/ui/shell.js` 接管：左侧导航 + 舞台 + 恒在右栏的队列 | 日常使用 |
| `/` | `assets/control.js` 里的 `layoutShell`：五个页签分页 | 逃生门（新版出问题时仍能改到每一张卡） |

想强制回到旧版面：启动前设环境变量 `NEKOFM_CONTROL_PAGE=/`（`src/main/index.js`
的 `controlPage`）。两个版面互相都有入口：旧版面播放器栏上的「新界面 →」常驻；
新版导航底部的「旧版界面」可以在「设置 · 界面」卡里关掉
（存在浏览器 `localStorage.nekofm.legacyEntry`，**不进配置文件** —— 这是界面偏好，
不该跟着直播配置走）。

`shell.js` 只做三件事，**不重新实现任何功能**：① 按 h2 标题把 20+ 张卡分到五个面
（直播台 / 曲库 / 叠加层 / 审核诊断 / 设置，设置钉在导航底部）；② 建「叠加层地址」
「说明」「界面」这类只在新版才有意义的卡；③ 记住上次所在的面
（`localStorage.nekofm.face`）。分面表 `FACES` 是**前缀匹配、长的先试**，新增卡片
必须登记，否则会静默掉进「审核诊断」—— `test/shell-faces.test.js` 就是防这个的回归网。

面的**功能**在 `assets/ui/face-*.js` 里，契约是 `window.__nekofmFaces.<面>(ctx)`
返回一个对象（`ctx` 带 `$ / api / log / on / esc / toast` 等）：`face-live`（队列 / 点歌 /
传输 / 直播状态）、`face-library`（已保存 / 已播放 / 本地曲库 / 歌单导入 / 缓存）、
`face-overlay`（叠加层预览与两个表单）、`face-account`（网易云登录）、
`face-ops`（自测 / 演练）。**模块没加载时宿主会 `log('error', …)` 响亮报错**，
而不是让按钮静默失效。

列表的 DOM 用 `lit-html` 的模板 patch（`assets/ui/lit.js` 把 vendored 的 ESM 挂成
`window.__nekofmLit`）：拿不到就跳过这一帧、等 `nekofm:lit-ready` 事件再重画，
绝不假设它已经就绪。队列行与「已保存」行的行内操作收进了右键菜单
（`window.__nekofmCtxMenu`，只有 `location.pathname === '/console'` 启用）——
这是列宽纪律的一部分：常驻 5 个按钮会在宽列表里吃掉约 380px，在 344px 的队列栏里
更是把一行挤成三层。

**版本号只有一条来源**：主进程 `APP_VERSION = app.getVersion()`（回落读
`package.json`，再回落 `'unknown'`），由 `statePayload()` 拼进 `/api/state` 与每次 SSE
广播（`{ ...engine.state(), version }`）—— **不塞进 `engine.state()`**（Engine 是纯业务层，
版本是外壳的事），也不在渲染层写死。`tools/headless.js` 用同一个字段名，所以命令行
和界面看到的版本一致。「关于」卡只是把这个字段显示出来。

---

## 几条贯穿全局的设计口径

### 播放本体是"隐藏窗口里的 `<audio>`"

不是 Node 侧的音频库。原因很实际：`<audio>` 支持 `setSinkId()`，
能把音乐单独送到虚拟声卡（VoiceMeeter / VB-Cable）的某个通道 ——
**这是实现"游戏声与音乐声分开"的唯一正规途径**
（虚拟声卡是什么、为什么直播场景需要它：见 [README 第 3 节](../README.md#音频为什么这里要用-voicemeeter)）。

推论：**关闭这个窗口不等于停止播放**，关闭 = 隐藏（销毁会导致音频消失）。

**这个 `<audio>` 外面套了一层 Web Audio 图**（2026-10-13 加动态音量时引入）：
`createMediaElementSource` 之后分成两路 —— 一路接 `AnalyserNode` 量电平（量的是**加增益之前**
的源电平，否则增益一动、测量跟着动，成自我循环），另一路依次经
**用户音量增益 → 动态音量增益 → 静音增益** 到输出。三条由此而来的约束：

- **`element.volume` 恒定钉在 1，用户音量由图里的增益节点施加**：`element.volume` 作用在
  **音频图之前**（实测：`element.volume=0.1` 时分析器量到的电平比 1.0 时低 20 dB），
  拿它当音量条就等于把"音量拉低"伪装成"音源太轻"，动态音量会一路补到上限。
  把音量放到分析器**之后**，动态音量就只管把音源拉到目标，二者互不打架。
- **输出设备改由 `AudioContext.setSinkId()` 决定**：一旦建图，`audio.setSinkId()` 不再生效
  （`player.js` 里是"有图走 ctx、没图退回 element"的写法）。默认设备要传**空串**，
  传 `'default'` 会抛 `NotFoundError`。
- **跨源音频必须带 `crossorigin="anonymous"`**：不加这个属性，Chromium 会让 `MediaElementSource`
  输出全零（控制台报 `outputs zeroes due to CORS access restrictions`）—— 即"图建起来了、界面一切正常，
  但没有声音"。网易云 CDN 带 `Access-Control-Allow-Origin: *`，所以这条能成立。
- **AGC 的决策与 Web Audio 无关**：`src/shared/auto-gain.js` 只算"这次增益定多少"，
  播放核心负责喂测量值、把结果设给 GainNode。这样数学部分能在 Node 里直接对拍（`tools/agc.check.js`）。
  界面上那个竖刻度音量控件是另一个共享模块 `src/shared/volume-dial.js`
  （控制台底部播放器栏与「播放核心」窗口共用同一份实现与同一套行为）。

### 时基只有一个：`<audio>.currentTime`

歌词同步不依赖 Windows SMTC 之类的系统媒体会话 —— 很多播放器只在播放/暂停时
推送时间轴，长播必然漂移。链路是：播放器 10Hz 上报 → SSE 广播 → 叠加层用
`requestAnimationFrame` 插值补间。

`src/shared/lyric-sync.js` 被主进程与渲染层**共用**，就是为了保证两边算出的
"当前该显示哪一行/哪个字"完全一致。

### 状态推送用 SSE，且**歌词要重复发**

叠加层（直播姬浏览器源）可能在任何时刻加载或刷新，所以 SSE **建连时必须补发
当前歌词**。只在"歌词变化时"推送的话，晚接入的叠加层会一直空白。

### 数据目录跟着程序走

`config.js` 的 `dataRoot()`：打包版 = exe 同目录 `data/`，开发版 = 源码根 `data/`，
`NEKOFM_DATA` 环境变量优先级最高。

Electron 默认写 `%APPDATA%`，本项目在启动时用 `app.setPath('userData', ...)`
改到 `data/electron/` —— 否则"整个文件夹丢在别的盘"就不成立。

> **测试与自检必须设 `NEKOFM_DATA` 指向临时目录。** 这是硬规矩：
> 曾经因为自检直接跑在真实数据目录上，把使用者的缓存清空了。

### 缓存子系统只有一份

音频、歌词、封面共用同一个 `MediaCache`（同一目录、同一份统计、同一个「清空」）。
启动**不逐条扫盘** —— 目录里有一份集中索引 `index.json`，启动只读它；
边车 `.json` 仍是真相源，索引与磁盘对不上时自动回落逐条扫描并重建。

命中缓存的曲目 = **零网络请求**。

**落盘的准入判据是"字节"，不是"声明"**：上游 CDN 会把完整的 MP4 标成 `application/json`
（实测见 README「踩过的坑」32），所以 `put()` 只把 `content-type` 当参考 ——
先按魔数嗅探第一个数据块，认得出媒体格式就一定收下；声明是媒体、正文却像 JSON/HTML 的才拒。
另外两条闸门：**`content-range` 不是全长就拒**（半截文件会伪装成完整缓存，播到一半断），
以及**小于 4KB 视为错误页**。写入一律先落 `.part` 再 `renameSync` 原子替换，
所以任何时刻盘上的 `.bin` 都是完整文件。

### 歌词"配错了"是一等状态

`resolveLyrics()` 的**第一步**（在预载缓存**之前**）就查 `config.lyrics.banned`：
命中直接返回 `null`，原平台歌词 / B站字幕 / 按歌名匹配**一个来源都不查** ——
"禁止自动匹配"必须是**真的一个都不查**，否则错词会从缓存或字幕那条路绕回来。
键取"曲目身份"（`netease-<id>` / `bilibili-<bvid>-<cid>` / `local:<路径小写>`），
本地曲按**路径**而不是歌名记名：同名两个文件按歌名会混成一条，且那种条目在
`resolveLyrics` 里对真正的本地曲根本匹配不上，只会静默失效。

### 服务端安全口径

`/stream/local` 与 `/stream/cover` 共用一份**白名单**
（`LocalLibrary.streamAllowList()`）：曲库目录 + 使用者显式打开的文件 +
它们那几张侧车封面 + 封面缓存目录。

白名单是**按路径逐条放行**的，所以有两条容易踩的口径：

- 放行 `歌.mp3` **不等于**放行同目录的 `folder.jpg`（封面会被自己的服务端 403）。
- 放行只存在**内存**里，而「已保存播放列表」是落盘的 —— 重启后直接播列表里的
  本地歌会 403。所以本地曲目**取流前会把自己的文件重新登记**回去
  （`LocalLibrary.admitFile()`，见 `Engine.resolveStream`）。

不加白名单的话，`/stream/local?path=` 就是一个**任意文件读取**漏洞 ——
直播机上的任何本地网页都能探文件。改动这一带时先看
`test/e2e.test.js` 里的安全断言。

### 端口：以"真的绑上了哪个"为准

`AppServer.start()` 在首选端口被占用时会依次试 +1、+2，但**必须用
`server.address().port` 作为结果**，不能用"这次尝试的端口号"：
每次 `listen()` 都会注册一个 `once('listening')` 回调，真正绑成功那一刻，
之前失败尝试的回调会被**一并唤起**（各自带着自己那个没绑上的端口号）。

踩过的后果（2026-09-26）：`start()` resolve 出被占用的端口 →
`engine.serverBase` 指向**另一个进程** → 取流/封面/歌词代理地址全打错端口；
内置测试中心也拿它发请求（表现成莫名其妙的 403，排查绕了不少路）。

**0.7.0 起：漂移后的端口不写回配置。** 配置里的 `server.port` 是"意图"
（起始端口），不是"事实"。以前的写法在绑定成功后直接 `config.server.port = port`
并落盘 —— 只要某次 37821 被别的程序占了一下，你填进直播姬的叠加层地址就被
**永久改掉**，之后每次开播都是黑屏，而配置里已经看不出原始值。
现在只在 `port !== config.server.port` 时打一行 warn，让人知道"这次跑在别的端口，
叠加层地址要跟着改"，配置保持原样。

### 运行日志总线（`src/main/logbus.js`）

打包成 exe 后**没有控制台**，`console.log` 写进虚无 ——「卡住了 / 点了没反应」
这类反馈会完全无从查起。所以：

- 在 `console` 这一层**收口**（接管 info/warn/error）：原行为不变，只多一份副本。
  全项目几百处 `console.log` 逐个换成 logger 既容易漏、diff 也没法 review；
- **五级**：`info` / `ok`（做成了）/ `reject`（没做成，且是预期内的拒绝）/ `warn` / `error`。
  "没执行"与"出错了"必须分开 —— 把「你没权限点这首」染成红色，等于教人忽略红色；
- **分类**从行首 `[engine]` / `[netease]` 这类前缀里抽（`splitCategory`），
  日志窗口按分类给固定色，未知分类用哈希取色（同一个分类颜色恒稳定）；
- `console` 里的**运行时噪音**（`(node:1234) [DEP0180] DeprecationWarning…`）降成
  `info` + `category: 'node'`，多行警告用 ` ⏎ ` 拍平成一行 —— 否则一条弃用警告
  能在"只看问题"里堆出二十行红字；
- 白名单之外的等级名一律降 `info` 并只 warn 一次（防止第三方库把 `debug`/`trace` 塞进来）；
- **stdout/stderr 的 `'error'` 事件直接吞掉**：管道断开（EPIPE）时 Node 默认把
  `write after end` 抛成未捕获异常，能**带走整个主进程** —— 日志总线自己不能成为
  让程序崩掉的原因；
- 环形缓冲（默认 800 行）+ 落盘 `data/logs.txt`（超 2MB 滚动一代 `.1`）；
- 经 SSE 推给 `/logs` 页面（**只有 `?logs=1` 的连接收**，不给控制台/叠加层加流量），
  窗口按 `seq` 续传，断线重连不会重刷整屏；
- 页面顶部同时显示运行状态（播放/队列/弹幕房间与主播/网易云登录与限流/缓存），
  是打包版唯一的"现场"。`--smoke` 里有一项会**真的把它打开并查 DOM**。

引擎内部还有一条**结构化通道** `Engine.logEvent(level, text)`（由 `index.js` 注入，
落成 `logBus.push(level, '[engine] ' + text)`）：业务层想标"这是拒绝、不是故障"时，
不必再靠 `console.warn` 的字符串形状去猜。

### 叠加层会自己跟上新版本

直播姬的浏览器源**挂着旧页面不会自己重载**，升级程序后它还在跑旧 JS
（"新版明明修好了、直播姬里还是老样子"）。所以 SSE 建连时带上静态资源的版本戳
（`AppServer._computeAssetRev()` = 渲染层文件的最新 mtime），页面记下首次收到的值，
**重连时发现变了就在"当前没有在播曲目"的间隙自行重载**（不打断正在唱的画面）。

### 叠加层预览窗：镜头里的东西与"壳"分两层

三个预览窗（整体 / 只要歌词 / 只要信息卡片）加载的是**和直播姬浏览器源同一个页面**，
只是多带一个 `?preview=1` —— 这样"预览里看到的"与"推流出去的"天然一致。

页面里因此分成两层（改叠加层布局时别搞混）：

- **画布层 `.overlay-canvas`**：所有会被直播姬看到的元素（歌词 / 信息卡 / 占位 / 角标）。
  预览模式下整块下移一条工具条的高度，**绝对定位的信息卡才不会被工具条压住** ——
  高度由页面实测工具条高度写进 CSS 变量，不写死像素。正式源里它 `inset: 0`，
  与没有这一层时逐像素一致。
- **壳**：工具条、唤出感应带、拉边把手。全部挂在 `body.preview-mode` 门控下，
  直播姬那边不带该参数，所以正式画面里永远不会出现，也不会多出挡点击的热区。

歌词排版是"三条自适应，顺序不能反"：**删非当前行（`autoFit`）→ 还装不下就缩字号（`fitLyrics`）
→ 最后把当前行对齐到舞台中心（`applyLinesTransform`）**。三者都会改整体高度，
先算后一个等于白算。字号是三层系数相乘：配置字号 × 源尺寸缩放（可选）× 长句自适应
（下限 45%，缩无可缩时宁可裁），折进同一个 CSS 变量，正文/译文/描边一起变。
「透明度」只挂在歌词层（`.stage`）上 —— 信息卡片有自己那组的不透明度，两者互不影响。

四件"壳"上的能力，都是**主进程管窗口属性、页面管交互细节**：

| 能力 | 实现要点 |
|---|---|
| 置顶（默认开） | `setAlwaysOnTop(true,'screen-saver')`；关掉后连"失焦重新置顶"也一并停 |
| 自动隐藏标题栏 | 页面监听 `focus`/`blur`（**只认失焦**，鼠标移开不算）；顶边留 14px 感应带唤回 |
| **点击穿越** | 主进程 `setIgnoreMouseEvents(true, { forward: true })`；**forward 不能省** —— 透传后页面收不到普通鼠标事件，只能靠转发来的移动事件知道"光标回到顶边了"。页面按光标 y 上报 `overlayPointerRegion`，主进程据此决定要不要忽略；穿越时悬停不唤出工具条（只认点击）、四边把手让开、托盘菜单留一键取消兜底 |
| 拉边改大小 | 系统缩放热区只有 4px 且叠加层全透明，等于按不到 → 自己铺 8px/14px 把手。**几何算在主进程**（`screen.getCursorScreenPoint()`，与 `getBounds()` 同为 DIP），纯函数在 `src/core/overlay-window.js`（有单测）；渲染层只报 start/move/end + 一条边 |

---

## 三条弹幕通道的优先级

`engine.connectDanmaku` 按下面的顺序选，前一条不可用就顺延：

| 顺序 | 实现 | 前置条件 |
|---|---|---|
| 1 | `open-live.js` 官方开放平台 | **自己申请的开发者凭证 + 消息类型开通** |
| 2 | `browser-channel.js` 系统 Edge/Chrome + CDP | 本机装有 Edge 或 Chrome |
| 3 | `danmaku.js` Node 直连 | 无（但 B站风控基本会拒） |

**为什么需要第 2 条**：B站的弹幕 WebSocket 认的是"客户端实现本身"——
Electron（UA / UA-CH 全套伪装、多个 Chromium 版本都试过）与 Node 直连一律被拒：
握手拿到 `101` 之后立刻 `1006`。所以只能拉起真实的系统浏览器，用 CDP 在里面跑
弹幕客户端，把收到的原始包回主进程解包。**签名算法仍在 Node 侧**，
只有"发请求"这一步发生在浏览器里。

官方通道（第 1 条）还有三件必须知道的事：

- **`ws.binaryType` 必须显式设成 `'arraybuffer'`。** Electron 升到 43（Node 22）后，
  底层 WebSocket 换成了全局实现，二进制帧的 `event.data` 默认是 **`Blob`** ——
  直接丢进解包器只会得到字符串 `"[object Blob]"`：**每一帧都解出 0 个包、而且不报错**，
  表现就是"连上了、一条弹幕都没有"。代码里另有一条 `raw instanceof Blob →
  arrayBuffer()` 的兜底，并把 `binaryType` 写死，不依赖运行时默认值。
- **开播状态要自己轮询，不能只信连接时那一次。** 官方通道建连时如果还没开播，
  之后主播开播不会自动补推——所以 `_startRoomWatch(roomId)` 在连上 1.5 秒后补查一次、
  之后每 30 秒 `_pollRoomLive`，用 `_applyLiveStatus(next, source, roomId)` 统一落地
  （**只在变化时**发 change + 提示；查询失败保留原状态，不误判成未开播；
  断开或换房间后旧轮询用 token 作废）。
- **诊断计数是给"收不到弹幕"用的**：`stats.opCounts` / `cmdCounts` / `unknownCmds`
  把"收到了哪些 op、哪些 CMD"摊开；25 秒没有任何帧会提示"消息类型（DM）未开通"，
  每 60 秒打一行长连统计。没有这些，长连"活着但没数据"和"根本没连上"分不出来。

详见 [CONFIGURATION.md](CONFIGURATION.md#2-b站bilibili) —— 那里写了两种模式的
能力边界和开放平台凭证的申请步骤。

---

## 测试分层

| 层 | 入口 | 是否联网 | 说明 |
|---|---|---|---|
| 单元 | `npm test` | 否 | 歌词解析 / 队列 / 黑名单 / 本地 / 播放器状态机 / 封面状态 / **开播轮询（room-watch）** |
| 端到端 | `npm run test:e2e` | 否（有联网预检） | 点歌 → 取流 → 歌词 → SSE → 代理 → 演练 → 安全 |
| 测试中心 | `npm run test:center` | 否 | 与界面里「测试中心」同一份清单，**共 91 项**（离线 71 / 联网 20） |
| 联网 | `npm run test:live`、`npm run test:center:net` | 是 | 打真实接口，需要网络与（部分项）登录态 |
| 冒烟 | `npm run smoke` | 否 | 启动 Electron → 查 DOM（含日志窗口）→ 自动退出 |

另有一条**纯静态**的版面回归网 `test/shell-faces.test.js`（不含在 `npm test` 之外，
是它的一部分）：解析 `control.html` 的卡片与 `shell.js` 的 `FACES`，断言每张卡都有
h2、都归到某个面、标题不陈旧、不跨面重复、卡片总数守恒 —— 加一张卡忘记登记面，
它当场就红（否则那张卡会静默消失在「审核诊断」里）。

**限流不算失败**：网易云会按 IP 限流（`code:405 操作频繁`）。遇到限流时测试中心
把该项标为「跳过」并写明原因，联网测试整体 SKIP 并退出码 0 ——
**自检工具谎报军情比不报更糟**，这是设计原则。
