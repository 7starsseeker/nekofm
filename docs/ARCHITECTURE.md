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
  shared/
    lyric-sync.js        主进程与渲染层共用的歌词定位（findLine / 插值）

  core/                  ★ 纯 Node，不依赖 Electron —— 可单测、可 headless
    config.js            DEFAULT_CONFIG + dataRoot()/configPath()（决定数据放哪）
    queue.js             点歌队列（去重窗口 / 每人上限 / 冷却 / 权限 / force 回填）
    blacklist.js         黑名单（song / keyword / artist / bvid 四种粒度）
    commands.js          弹幕文本 → 指令对象（纯函数，词表来自 config.commands）
    demo.js              演练模式素材（假曲目 + 假歌词时间轴）
    lyrics/lrc.js        LRC / 增强型 LRC / 网易云 yrc → 统一 timeline
    netease/
      client.js          网易云客户端（**限流熔断与退避在这里**）
      weapi.js           weapi / eapi 加密（登录与取流用 eapi）
    bilibili/
      wbi.js             WBI 签名（签名后免登录拿弹幕 token）
      danmaku.js         Node 直连弹幕通道（最后的降级，B站风控基本会拒）
      open-live.js       官方直播开放平台长连（有凭证时最稳）
      browser-channel.js 系统 Edge/Chrome + CDP 弹幕通道
      browser.js         B站登录窗（只为取 cookie，不拿它发 API）
      api.js             B站 HTTP 接口（视频信息 / 字幕 / 搜索 / 播放地址）

  main/                  ★ Electron 主进程
    index.js             窗口 / 托盘 / 菜单 / 权限 / userData 落点 / 冒烟自检
    engine.js            ★ 播放引擎 —— 最大文件，核心逻辑都在这
    cache.js             MediaCache：音频 + 歌词 + 封面缓存 + 集中索引
    commands.js          /api/command 的指令分发（HTTP → Engine）
    server.js            本地 HTTP + SSE 服务、/stream/* 代理
    selftest.js          测试中心（88 项检查：离线 68 / 联网 20）
    sources/
      local.js           本地曲库（递归扫描 / ffprobe 元数据 / 旁车歌词 / 白名单）
      netease-browser.js 借 Electron 登录态会话取直链（"浏览器急兑"）

  renderer/              ★ 全是普通网页，不依赖打包器
    control.html         控制台（分页 + 底部固定播放器）
    overlay.html         直播姬用的透明歌词叠加层
    player.html          隐藏窗口里的 <audio> 本体
    assets/*.js|css      对应界面的脚本与样式
```

规模：`src/` 约 15.7k 行 JS，最大单文件 `src/main/engine.js`（3.2k 行）。

---

## 几条贯穿全局的设计口径

### 播放本体是"隐藏窗口里的 `<audio>`"

不是 Node 侧的音频库。原因很实际：`<audio>` 支持 `setSinkId()`，
能把音乐单独送到虚拟声卡（VoiceMeeter / VB-Cable）的某个通道 ——
**这是实现"游戏声与音乐声分开"的唯一正规途径**
（虚拟声卡是什么、为什么直播场景需要它：见 [README 第 3 节](../README.md#音频为什么这里要用-voicemeeter)）。

推论：**关闭这个窗口不等于停止播放**，关闭 = 隐藏（销毁会导致音频消失）。

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

### 服务端安全口径

`/stream/local` 与 `/stream/cover` 共用一份**白名单**
（`LocalLibrary.streamAllowList()`）：曲库目录 + 使用者显式打开的文件 + 封面缓存目录。

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

### 运行日志总线（`src/main/logbus.js`）

打包成 exe 后**没有控制台**，`console.log` 写进虚无 ——「卡住了 / 点了没反应」
这类反馈会完全无从查起。所以：

- 在 `console` 这一层**收口**（接管 info/warn/error）：原行为不变，只多一份副本。
  全项目几百处 `console.log` 逐个换成 logger 既容易漏、diff 也没法 review；
- 环形缓冲（默认 800 行）+ 落盘 `data/logs.txt`（超 2MB 滚动一代 `.1`）；
- 经 SSE 推给 `/logs` 页面（**只有 `?logs=1` 的连接收**，不给控制台/叠加层加流量），
  窗口按 `seq` 续传，断线重连不会重刷整屏；
- 页面顶部同时显示运行状态（播放/队列/弹幕房间与主播/网易云登录与限流/缓存），
  是打包版唯一的"现场"。`--smoke` 里有一项会**真的把它打开并查 DOM**。

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

详见 [CONFIGURATION.md](CONFIGURATION.md#2-b站bilibili) —— 那里写了两种模式的
能力边界和开放平台凭证的申请步骤。

---

## 测试分层

| 层 | 入口 | 是否联网 | 说明 |
|---|---|---|---|
| 单元 | `npm test` | 否 | 歌词解析 / 队列 / 黑名单 / 本地 / 播放器状态机 |
| 端到端 | `npm run test:e2e` | 否（有联网预检） | 点歌 → 取流 → 歌词 → SSE → 代理 → 演练 → 安全 |
| 测试中心 | `npm run test:center` | 否 | 与界面里「测试中心」同一份清单 |
| 联网 | `npm run test:live`、`npm run test:center:net` | 是 | 打真实接口，需要网络与（部分项）登录态 |
| 冒烟 | `npm run smoke` | 否 | 启动 Electron → 查 DOM → 自动退出 |

**限流不算失败**：网易云会按 IP 限流（`code:405 操作频繁`）。遇到限流时测试中心
把该项标为「跳过」并写明原因，联网测试整体 SKIP 并退出码 0 ——
**自检工具谎报军情比不报更糟**，这是设计原则。
