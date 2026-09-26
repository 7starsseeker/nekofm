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
    selftest.js          测试中心（约 140 项检查，可离线跑）
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
能把音乐单独送到 VoiceMeeter 的某个通道 —— **这是实现"游戏声与音乐声分开"的
唯一正规途径**。

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
