/**
 * 端口自救（Windows）
 * ===================
 * 直播姬里的两个浏览器源写死了 `http://127.0.0.1:<server.port>/overlay?only=…`，
 * 端口一漂，那两张卡片就永久空白 —— 用户以为"叠加层坏了"，其实只是地址变了。
 * 所以固定端口绑定失败时要**先想办法把端口要回来**，实在要不回来才提示 + 换端口
 * （换端口必须让用户看见新地址，见 index.js 里的 confirmPortSwitch）。
 *
 * 两类失败各有一套要回来的办法：
 *
 *   EADDRINUSE  别的进程占着。只有占用者**自己**（残留的 NekoFM / 开发时的 electron）
 *               才能结束它；占用者是别的程序就绝不乱杀，交给用户。
 *   EACCES      Windows 把这段端口划进了系统的"排除段"。来源是 Hyper-V / WSL / Docker 的
 *               winnat 动态保留（`netsh int ipv4 show excludedportrange protocol=tcp` 能列出来，
 *               实测每段 100 个端口）。重启 winnat 就能放开 —— 但它要管理员权限，
 *               所以走 `Start-Process -Verb RunAs` 弹一次 UAC，让用户自己点同意。
 *
 * 2026-11-18 实发：37821 落在 37773–37872 里，bind 抛 EACCES、窗口永不创建；
 * 用户手动跑「释放端口」脚本（重启 winnat）才恢复。这里把同一套动作搬进主进程。
 *
 * 本文件只做系统查询与释放动作，**不碰配置、不碰 server**：绑定与否由调用方决定。
 */
'use strict';

const net = require('node:net');
const { execFile } = require('node:child_process');

/** 跑一个外部命令，永远 resolve（失败也带着 stderr 回来，调用方自己判断） */
function run(file, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
      resolve({ code, stdout: text(stdout), stderr: text(stderr), error: err || null });
    });
  });
}

/**
 * 外部命令的输出按 latin1 收：netsh / netstat 是本地代码页（这台机器是 936）输出的，
 * 我们只用其中的 ASCII（端口号、PID、LISTENING），按 latin1 收才不会因为夹了中文崩掉，
 * 正则也不会被半个 GBK 字符干扰。
 */
function text(buf) {
  if (!buf) return '';
  return Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
}

/** 这个端口现在能不能绑（绑上就立刻放掉，只做探针） */
function canBind(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** 等端口重新可绑（进程刚被杀时内核还要收一下 socket） */
async function waitBindable(port, host, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await canBind(port, host)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * 端口落在哪个系统保留段里（不在任何段里 → null）。
 *
 * `netsh` 会在"管理员加的静态排除"那行的结束端口后面打一个 `*`（表头下有说明），
 * 这种段**重启 winnat 是没用的** —— 只能 `netsh int ipv4 delete excludedportrange` 手动删，
 * 所以这里把标记也读回来，免得为了一个静态排除白弹一次 UAC。
 */
async function excludedRangeFor(port) {
  const out = await run('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp']);
  if (out.code !== 0) return null;
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)(\s+\*)?\s*$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (port >= start && port <= end) return { start, end, administered: !!m[3] };
  }
  return null;
}

/** 谁在听这个端口（拿不到 → null） */
async function ownerOf(port) {
  const out = await run('netstat', ['-ano', '-p', 'tcp']);
  if (out.code !== 0) return null;
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (!m) continue;
    if (Number(m[2]) !== port) continue;
    return { pid: Number(m[3]), address: m[1] };
  }
  return null;
}

/** 这个 PID 是什么程序（名字 + 命令行，用来判断"是不是我们自己的残留"） */
async function processInfo(pid) {
  const script = [
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new()',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    'if ($p) { $p | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress }',
  ].join('; ');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (out.code !== 0 || !out.stdout.trim()) return null;
  try {
    return JSON.parse(out.stdout.trim());
  } catch {
    return null;
  }
}

/**
 * 重启 winnat 放开动态保留段。必须管理员：`Start-Process -Verb RunAs` 会弹 UAC，
 * 用户点"是"才继续；点"否"时 PowerShell 报错、我们按"没释放成功"处理。
 * 用 -Wait 等它真跑完，否则紧接着的 bind 会撞在 winnat 停着的空窗里。
 */
async function restartWinnat() {
  const ps = [
    '$ErrorActionPreference = "Stop"',
    "Start-Process -FilePath $env:ComSpec -Verb RunAs -Wait -WindowStyle Hidden" +
      " -ArgumentList '/c', 'net stop winnat /y && net start winnat'",
    'exit 0',
  ].join('; ');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120000 });
}

/**
 * 试着把端口要回来。
 *
 * @param {number} port
 * @param {{host?: string, log?: Function, own?: (info: object|null) => boolean}} opts
 *   `own(info)` 判"占用者是不是我们自己的残留"。**默认只认进程名 NekoFM.exe**。
 *   别用"命令行里出现 nekofm 就算"那种宽松判据：2026-11-18 自测时它把
 *   `node …\nekofm\…\port-guard.js "<项目目录>…"` 这种**只是提到路径**的进程
 *   也判成了残留，直接 taskkill —— 编辑器、终端、跑仓里脚本的 node 都会被误杀。
 *   开发态（electron.exe <项目目录>）由 index.js 传更精确的判据进来。
 * @returns {Promise<{released: boolean, how?: string, reason?: string, steps: string[]}>}
 *   `steps` 是给日志/弹窗看的人类可读过程（哪一步做了什么、为什么没成）。
 */
async function releasePort(port, opts = {}) {
  const host = opts.host || '127.0.0.1';
  const log = opts.log || (() => {});
  const own = opts.own || ((info) => !!info && /^nekofm(\.exe)?$/i.test(String(info.Name || '')));
  const steps = [];

  if (process.platform !== 'win32') {
    return { released: false, reason: '只有 Windows 需要这套自救', steps };
  }
  if (await canBind(port, host)) {
    return { released: true, how: 'already-free', steps };
  }

  // ---- 1) 有别的进程在听：只结束"我们自己的残留" ----
  const owner = await ownerOf(port);
  if (owner) {
    const info = await processInfo(owner.pid);
    steps.push(`端口被 PID ${owner.pid}（${(info && info.Name) || '未知程序'}）占用`);
    if (own(info)) {
      log(`[port] 端口 ${port} 被残留进程（PID ${owner.pid}，${(info && info.Name) || '?'}）占着 —— 结束它`);
      await run('taskkill', ['/F', '/PID', String(owner.pid)]);
      if (await waitBindable(port, host)) {
        return { released: true, how: 'kill-stale-owner', steps };
      }
      steps.push('结束残留进程后端口仍然绑不上');
    } else {
      steps.push('占用者不是 NekoFM，不能替你结束它');
    }
  }

  // ---- 2) 落在系统保留段：重启 winnat（UAC） ----
  const range = await excludedRangeFor(port);
  if (range && range.administered) {
    steps.push(`端口在管理员静态排除段 ${range.start}–${range.end} 内（重启 winnat 无效，得手动删排除段）`);
  } else if (range) {
    steps.push(`端口在系统保留段 ${range.start}–${range.end} 内（Hyper-V / WSL / Docker 的端口排除）`);
    log(`[port] 端口 ${port} 被系统保留（${range.start}–${range.end}），重启 winnat 试图放开 —— 会弹一次 UAC`);
    await restartWinnat();
    const still = await excludedRangeFor(port);
    if (!still && (await waitBindable(port, host))) {
      return { released: true, how: 'winnat-restart', steps };
    }
    steps.push(still
      ? `重启 winnat 后仍在保留段 ${still.start}–${still.end}`
      : '重启 winnat 后端口仍然绑不上');
  } else if (!owner) {
    steps.push('没查到占用者，也不在系统保留段里');
  }

  return { released: false, reason: steps.join('；'), steps };
}

module.exports = { releasePort, canBind, excludedRangeFor, ownerOf, processInfo, restartWinnat };
