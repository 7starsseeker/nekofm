/**
 * 运行日志总线
 * =============
 * 打包成 exe 后**没有控制台**：`console.log` 写进虚无，出问题时用户手里一条日志都没有。
 * 「卡住了」「没反应」这类反馈因此完全没法查（踩过一次：只能猜）。
 *
 * 这个模块干两件事：
 *   1. **接管主进程的 console**（info/warn/error/log），把每条输出送进环形缓冲 ——
 *      原行为不变（该打印的照旧打印），只是多了一份"可被读取"的副本；
 *   2. 提供 `onLine` 回调，让服务端把新日志经 SSE 推给「运行日志」窗口；
 *      同时（可选）追加到 `<数据目录>/logs.txt`，崩溃/关窗后还能翻。
 *
 * 为什么不在各处改成 logger：全项目几百处 `console.log` / `log()`，
 * 逐个替换既容易漏、又会把 diff 搞得没法review。**在 console 这一层收口最省事、也最全**。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 把 console 的参数格式化成一行（Error 取 message + 头几行栈，对象走 JSON） */
function fmtArgs(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ? String(a.stack).split('\n').slice(0, 4).join(' | ') : a.message;
    if (a === null || a === undefined) return String(a);
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return '[object]'; }
    }
    return String(a);
  }).join(' ');
}

/**
 * 把 stdout / stderr 的 'error' 事件吃掉。
 *
 * 为什么必须有：打包成 exe 后从"不会等待的父进程"启动（PowerShell 的 `& exe --smoke`、
 * 某些快捷方式/更新器）时，父进程一退出管道就断，之后**第一条 console.log 就会失败**。
 * 这个失败是**异步的 'error' 事件**，不是同步 throw —— `try { console.log() } catch {}`
 * 抓不住它（踩过：主进程弹出 "A JavaScript error occurred in the main process"、
 * `Error: EPIPE: broken pipe, write` 停在 logbus.js 的 console 包装里，界面卡死）。
 * 对一个 GUI 程序来说"日志写不出去"永远不该是致命错误，所以这里直接咽掉：
 * 环形缓冲和 logs.txt 才是日志的正经去处，stdout 只是顺带。
 */
function _guardStdStreams() {
  for (const s of [process.stdout, process.stderr]) {
    if (s && typeof s.on === 'function') {
      s.on('error', () => { /* EPIPE 等：咽掉，见上面的注释 */ });
    }
  }
}

/** 允许的等级（渲染层按这个配色/筛选；白名单外的一律降级为 info，但会记一行抱怨） */
const LEVELS = ['info', 'ok', 'reject', 'warn', 'error'];

/**
 * 从文本开头的 `[engine]` / `[server]` 这类前缀里抠出模块名，作为独立字段。
 *
 * 为什么不改 73 处调用点：那 73 处 `this.log('[engine] …')` 的文字前缀本来就是模块名，
 * 只是混在正文里 —— 渲染层没法单独给它上色/筛选，用户只能靠肉眼在长句里找。
 * 在总线这一层抽出来，一处改动拿到结构化字段，调用点一个都不用动。
 * 前缀只认"短、无空格"的方括号，避免把 `[2026-10-24] 某某` 这类正文误判成模块。
 */
function splitCategory(text) {
  const m = /^\[([A-Za-z][\w.-]{0,15})\]/.exec(text);
  return m ? m[1] : '';
}

class LogBus {
  /**
   * @param {{limit?:number, file?:string, fileLimitBytes?:number, levels?:string[]}} [opts]
   *   limit          内存里保留多少条（窗口打开时回填这些）
   *   file           落盘路径（空 = 不落盘）
   *   fileLimitBytes 文件超过这个大小就重命名为 .1 再重开（只留一代，别把盘塞满）
   */
  constructor(opts = {}) {
    this.limit = opts.limit || 800;
    this.file = opts.file || '';
    this.fileLimitBytes = opts.fileLimitBytes || 2 * 1024 * 1024;
    this.lines = [];          // [{ at, level, text }]
    this.seq = 0;             // 单调序号：窗口用它去重/续传
    this._subs = new Set();   // onLine 订阅者
    this._installed = false;
    this._orig = null;
    this._fileBytes = 0;
  }

  /**
   * 接管 console。**幂等**（重复调用不会套娃把日志打两遍）。
   * 原方法一定先调用（stdout 行为保持不变）。
   */
  install() {
    if (this._installed) return this;
    this._installed = true;
    _guardStdStreams();
    const self = this;
    const wrap = (level, name) => {
      const orig = console[name] ? console[name].bind(console) : console.log.bind(console);
      console[name] = (...args) => {
        try { orig(...args); } catch { /* 原方法出错也不能连累业务 */ }
        try { self.push(level, fmtArgs(args)); } catch { /* 日志本身不许抛 */ }
      };
    };
    wrap('info', 'log');
    wrap('info', 'info');
    wrap('warn', 'warn');
    wrap('error', 'error');
    return this;
  }

  /** 追加一行（同时广播 + 落盘） */
  push(level, text) {
    let lv = level || 'info';
    if (!LEVELS.includes(lv)) {
      // 白名单外的等级不静默改成 info：留一行抱怨，否则配色会莫名其妙地"没生效"
      const bad = lv;
      lv = 'info';
      this._warnOnce = this._warnOnce || new Set();
      if (!this._warnOnce.has(bad)) {
        this._warnOnce.add(bad);
        try { console.warn(`[logbus] 未知日志等级「${bad}」，按 info 处理（允许：${LEVELS.join('/')}）`); } catch { /* 忽略 */ }
      }
    }
    const raw = String(text == null ? '' : text);
    const line = {
      seq: ++this.seq,
      at: Date.now(),
      level: lv,
      category: splitCategory(raw),   // `[engine]` → 'engine'，渲染层用它上色/筛选
      text: raw,
    };
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    for (const cb of this._subs) { try { cb(line); } catch { /* 单个订阅者出错不影响别的 */ } }
    this._appendFile(line);
    return line;
  }

  /** 订阅新日志；返回取消订阅函数 */
  onLine(cb) {
    this._subs.add(cb);
    return () => this._subs.delete(cb);
  }

  /**
   * 取最近若干条。`afterSeq` 用于"我只缺 seq 大于它的那批"（窗口重连时续传，
   * 不会因为重连把整屏日志再刷一遍）。
   */
  recent({ limit = 0, afterSeq = 0 } = {}) {
    let list = afterSeq > 0 ? this.lines.filter((l) => l.seq > afterSeq) : this.lines.slice();
    if (limit > 0 && list.length > limit) list = list.slice(-limit);
    return { ok: true, seq: this.seq, lines: list };
  }

  clear() {
    const n = this.lines.length;
    this.lines = [];
    return { ok: true, cleared: n };
  }

  get filePath() { return this.file; }

  /** 落盘（滚动一代 .1，防止无限增长） */
  _appendFile(line) {
    if (!this.file) return;
    try {
      if (!this._fileBytes) {
        try { this._fileBytes = fs.statSync(this.file).size; } catch { this._fileBytes = 0; }
      }
      if (this._fileBytes > this.fileLimitBytes) {
        try { fs.renameSync(this.file, this.file + '.1'); } catch { /* 忽略 */ }
        this._fileBytes = 0;
      }
      const ts = new Date(line.at).toLocaleString('zh-CN', { hour12: false });
      const text = `${ts} [${line.level}] ${line.text}\n`;
      fs.appendFileSync(this.file, text, 'utf8');
      this._fileBytes += Buffer.byteLength(text);
    } catch {
      /**
       * 落盘失败（盘满/权限/目录没了）就把 file 关掉，别让每条日志都去撞一次异常 ——
       * 日志系统的故障绝不能反过来拖慢主流程。
       */
      this.file = '';
    }
  }

  /** 数据目录下的默认落盘路径 */
  static defaultFile(dataDir) {
    return path.join(dataDir, 'logs.txt');
  }
}

module.exports = { LogBus, fmtArgs };
