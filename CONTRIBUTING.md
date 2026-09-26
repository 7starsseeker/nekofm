# 参与贡献

感谢愿意花时间。这个项目**没有运行时第三方依赖**（只用 Node 内置模块 + Electron），
所以开发环境很轻。

## 环境

- Windows 10/11（主要目标平台）
- Node.js ≥ 22
- FFmpeg（本地曲库的元数据/内嵌歌词提取需要 `ffprobe` 在 PATH 上）
- 可选：Edge 或 Chrome（用浏览器弹幕通道时需要）

```bat
npm install
npm start                 :: 拉起 Electron 应用
node tools\headless.js    :: 或者不装 Electron，纯服务模式
```

## 提交前请跑

```bat
npm test                  :: 单元测试（离线，必须全绿）
npm run test:e2e          :: 端到端（离线，有联网预检）
npm run test:center       :: 内置测试中心（离线）
npm run smoke             :: Electron 冒烟自检
```

涉及联网功能时再补：

```bat
npm run test:live         :: 真实接口（网易云 / B站 / 弹幕）
npm run test:center:net   :: 测试中心含联网项
```

### ⚠️ 测试绝不许动真实数据

**这条是硬规矩，违反过的代价是使用者的缓存被清空。**

任何测试、自检、演示代码想写数据时，**必须**把数据目录指到临时目录：

```bat
set NEKOFM_DATA=%TEMP%\nekofm-test
```

`NEKOFM_DATA` 在 `src/core/config.js` 的 `dataRoot()` 里优先级最高。
新增测试如果会落盘，请在测试开头自己设 `process.env.NEKOFM_DATA` 并在结尾清理；
**不要**依赖"反正我只读"。

## 代码约定

### 注释写"为什么"，不写"做了什么"

这个项目的注释密度偏高，是刻意的：很多设计是为了绕开外部服务的实际行为
（B站风控、网易云限流、防盗链、Chromium 绘制 bug……），
**不写下来下一个改的人一定会重新踩一遍**。README 第 2 节是这类结论的汇总。

所以：

- ✅ `// B站弹幕 WS 只认真实浏览器，Electron 握手后被判死（见 browser-channel.js）`
- ❌ `// 连弹幕`

### `.bat` 里绝对不能有中文

`cmd.exe` 按**控制台代码页**（中文系统 936/GBK）解析批处理字节，而文件是 UTF-8 ——
中文必然乱码，严重时某些字节被当成分隔符，cmd 会拿中文当命令去执行。

规定：**`.bat` 只留纯 ASCII + CRLF**，所有面向使用者的文字由 Node 脚本打印
（`chcp 65001` 之后再调 node）。

### 其它

- 缩进 2 空格，UTF-8；编辑器设置见 [.editorconfig](.editorconfig)
- 保持 `src/core/` **不依赖 Electron** —— 那一层要能单测、能在 headless 下跑
- 新增界面文字用中文，与现有风格保持一致
- 改动涉及设计取舍时，**同时更新 README 的「踩过的坑」或 docs/**

## 新增测试

- 单元测试放 `test/*.test.js`，纯逻辑、不联网，并加进 `package.json` 的 `test` 脚本
- 联网测试单独放，且**遇到外部限流一律判"跳过"而不是失败** ——
  自检工具谎报军情比不报更糟
- 源码级"绊线"检查（例如"缓存键必须先补 cid"这类口径）加在
  `src/main/selftest.js` 里，改坏了要能立刻红

## 提交与 PR

- 提交信息写清**动机**（为什么改），不只是改了什么
- 一个 PR 只做一件事；顺手重构请单独拆开
- 界面改动请附截图（`docs/screenshots/`）
- **提交前确认没有把 `data/` 带进来**：`git status --porcelain` 不应该出现
  `data/`、`config.json`、`Cookies` 这类路径

## 不要做的事

- **不要提交任何凭据**：cookie、`accessKeySecret`、主播身份码、设备 ID、直播间号
- **不要把协作时的个性化称呼 / 自称写进仓库**（README、CHANGELOG、代码注释都算）：
  仓库是公开的，写进去就等于公开。`npm run check:secrets` 里有一条专门拦这类词
- **不要添加绕过版权/会员限制的手段**：本项目只使用**使用者自己账号**的登录态取流，
  不分发音频文件与直链
- **不要引入运行时第三方依赖**，除非有充分理由并在 PR 里说明

## 授权

本项目以 **Apache License 2.0** 授权。提交 PR 即表示你同意你的贡献以同一许可分发。
