# 配置说明

## 配置文件在哪

```
<程序目录>/data/config.json
```

- 首次启动自动生成（内容 = `src/core/config.js` 里的 `DEFAULT_CONFIG`）
- 开发版就是仓库根下的 `data/config.json`
- 打包版是 **exe 同目录**的 `data/config.json`（绿色版，整个文件夹拷走即可换机）
- 想放别处：设环境变量 `NEKOFM_DATA=<目录>`（**测试与自检必须走这条**，否则会动到真实数据）

仓库里带了一份 [config.example.json](../config.example.json)，是从 `DEFAULT_CONFIG`
**自动生成**的（`npm run config:example`），可直接照抄。它已清空所有属于使用者自己的字段。

大多数项改完**重启生效**；叠加层与信息栏样式支持热改。

---

## 四段关键配置

### 1. 网易云（`netease`）

| 字段 | 说明 |
|---|---|
| `cookie` | 登录态。**不要手填** —— 控制台「网易云 → 登录」弹窗扫码后自动写入 |
| `level` | `standard` / `higher` / `exhigh` / `lossless` / `hires` |
| `encodeType` | `aac` / `mp3` |

**为什么必须登录**：未登录时网易云对 `fee=1`（会员曲）只返回 45 秒试听片段
（`freeTrialInfo: {start:0, end:45}`，实测 ffprobe 量得 45.024s）。本项目用
**eapi 原生扫码登录**拿自己的会员权益，不伪造浏览器、不绕过版权。

---

### 2. B站（`bilibili`）

#### 弹幕通道：二选一（`danmakuMode`）

这是本项目**最需要按自己环境选**的一项。两条通道的能力边界完全不同：

| 通道 | `danmakuMode` | 需要什么 | 能连哪个房间 |
|---|---|---|---|
| **官方直播开放平台** | `openlive` | **自己申请一整套开发者凭证**（见下） | **只能是自己**（由「主播身份码」绑定） |
| **系统浏览器通道** | `browser` | 本机装有 **Edge 或 Chrome** | 任意直播间（`roomId` 生效） |

> ⚠️ **`openlive` 模式必须自己申请凭证才能用。** 开放平台不是"填个开关就能连"的
> 公共接口 —— 它面向开发者，需要个人开发者认证 + 项目审核 + 主播身份码。
> 凭证没配全时程序**会自动回落到 `browser` 通道**并在界面提示，不会连不上，
> 但**不会**凭空获得开放平台能力。

> ⚠️ **`browser` 模式依赖本机浏览器。** 它靠拉起系统 **Edge**（没有则 **Chrome**）
> 开一个屏幕外窗口走 CDP 收弹幕 —— B站的弹幕 WebSocket 只认真实浏览器，
> Electron 与 Node 直连一律被拒（握手 101 后立刻 `1006`）。
> **机器上没装 Edge/Chrome 就用不了这条通道**（Windows 自带 Edge，通常不用管；
> Linux / macOS 需要自行安装 Chromium 系浏览器）。
> 这条通道也是**没有开放平台凭证时的兜底**，可以连别人的直播间。

#### `openLive`：开放平台凭证（**必须自行申请**）

四项都要在 [open-live.bilibili.com](https://open-live.bilibili.com) 后台办：

| 字段 | 怎么来 |
|---|---|
| `accessKeyId` / `accessKeySecret` | **个人开发者认证通过**后获得 |
| `appId` | 创建项目并**通过审核**（约 3~5 个工作日）后拿到项目 ID |
| `roomOwnerAuthCode` | 在项目里生成**主播身份码**（绑定你自己的直播间） |

填好这四项并把 `openLive.enabled` 设为 `true`，弹幕就优先走官方通道 ——
不依赖本机浏览器、不受网页端风控影响。

> ⚠️ **弹幕（DM）等消息类型要单独向 B站运营申请开通。**
> 这是最容易踩的坑：凭证齐了、长连也建立成功，但**一条弹幕都收不到**，
> 原因就是消息类型没开通。申请入口在开放平台后台（或联系对接的运营）。

> `appId` 在官方是 **int64**。本项目**原样按字符串保存**，只在能安全表示时才转数字 ——
> JS 的 Number 只有 53 位精度，直接 `Number()` 大 ID 会悄悄变值并报 `5002`。

#### 其它字段

| 字段 | 说明 |
|---|---|
| `roomId` | 直播间号（短号也行）。**只对 `browser` 通道有效**，`openlive` 下填什么都不生效 |
| `autoConnect` | 启动后自动连弹幕 |
| `replyInDanmaku` | 是否用弹幕回执（需登录态才能发弹幕，默认关） |
| `cookie` | B站登录态（整条 cookie 串）。**视频的 CC/AI 字幕必须要它** |

**为什么字幕要登录**：`/x/player/v2` 未登录时恒返回 `need_login_subtitle: true` +
空字幕列表（与视频本身有没有字幕无关），拿不到字幕就只能靠"标题匹配网易云"，
冷门曲基本匹配不到。控制台「弹幕点歌」卡片里点「登录 B站」扫码，或直接粘贴 SESSDATA。

---

### 3. 本地曲库（`local`）

| 字段 | 说明 |
|---|---|
| `dirs` | 曲库目录数组，例如 `["D:/Music", "E:/Songs"]`。也可用控制台「打开音乐文件夹…」写入 |
| `enabled` | 是否启用本地音乐 |
| `autoSaveLyrics` | 匹配到歌词后自动在歌曲文件旁写 `.lrc` / `.karaoke.lrc` / `.trans.lrc`。**只在文件不存在时写入，绝不覆盖你自己放的歌词** |

---

### 4. 缓存与音源（`cache`）

| 字段 | 说明 |
|---|---|
| `enabled` | 在线放过的歌是否落盘 |
| `maxMB` | 缓存总量上限（LRU 淘汰），默认 2048 |
| `maxFileMB` | 单文件上限，默认 120 |
| `dir` | 缓存根目录。**留空 = `<程序目录>/data/cache`**，绝不默认写系统盘 |

规则：首次播放仍走远端直链（不为缓存多等一秒）；**45 秒试听片段绝不缓存**
（否则以后一直只能放那半首）。

---

## 其余段

| 段 | 作用 |
|---|---|
| `server` | 本地服务端口/地址，默认 `127.0.0.1:37821`（被占用会自动 +1，看启动日志） |
| `queue` | 队列上限、每人上限、冷却、去重窗口、`danmakuSkip.ownOnly`（观众能否切自己的歌） |
| `commands` | 弹幕指令词表，按直播间习惯改（如把「点歌」改成「来一首」） |
| `blacklist` | 黑名单规则，四种粒度：`song` / `keyword` / `artist` / `bvid` |
| `playlists` | 已导入的网易云歌单记录 |
| `favorites` | 我的收藏（可当闲时歌单音源） |
| `savedPlaylist` | 「已保存播放列表」，下播自动存、开播当闲时歌单 |
| `playback` | 只有播放模式（`order` / `repeat-all` / `repeat-one` / `shuffle`） |
| `idle` | 闲时歌单设置 |
| `overlay` | 叠加层样式：主题、字号、颜色、描边、底板、行数、翻译/罗马音开关、信息栏 |
| `player` | 输出设备（`deviceId` / `deviceLabel`，供 `setSinkId`）、歌词提前量 `prerollMs` |
| `demo` | 演练模式素材开关 |

> 历史上 `playback` 段放过 `volume` / `muted`，现已统一到 `player` 段；
> 老配置里残留的这两个字段无人读取，可放心忽略。

---

## 配置里**不要**提交到版本库的东西

`data/config.json` 里有你的网易云 cookie、B站 cookie、开放平台 `accessKeySecret`，
`data/electron/` 下有 Chromium 的 Cookies 库。仓库的 `.gitignore` 已把整个 `data/`
排除在外 —— 如果你 fork 后改动了目录结构，**务必自己再确认一遍**。
