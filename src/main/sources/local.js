/**
 * 本地音乐源
 * ===========
 * 只依赖系统 ffmpeg/ffprobe（用户机器已装 FFmpeg 9.0.2）。
 *   - scan()    递归扫描目录，读时长/标题/艺术家
 *   - lyrics()  歌词优先级：同名 .lrc 文件 → 内嵌 USLT/LYRICS 标签
 *               （.lrc 是别人写的，编码按 BOM/UTF-8/GB18030 自动识别，见 core/text-file.js）
 *
 * 扫描结果带缓存（按 mtime），避免每次启动全盘重扫。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { readTextFile } = require('../../core/text-file');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma', '.ape', '.mp4']);
const LRC_EXT = new Set(['.lrc']);

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, out: stdout || '', err: err ? String(err.message) : '' });
    });
  });
}

class LocalLibrary {
  /**
   * @param {{dirs?:string[], ffprobe?:string, ffmpeg?:string, cacheFile?:string, log?:Function}} opts
   */
  constructor(opts = {}) {
    this.dirs = (opts.dirs || []).filter(Boolean);
    this.ffprobe = opts.ffprobe || 'ffprobe';
    this.ffmpeg = opts.ffmpeg || 'ffmpeg';
    this.cacheFile = opts.cacheFile || null;
    this.coverDir = opts.coverDir || null; // 内嵌封面抽取后的缓存目录
    this.log = opts.log || (() => {});
    this.tracks = [];
    this.index = new Map(); // 小写文件名/标题 → track
    this._coverCache = new Map(); // 音频绝对路径 → 封面绝对路径
    /**
     * 用户用「打开文件」显式加进来的散装文件（不在任何曲库目录里）。
     * 单独记着有两个用处：
     *   1) 重新扫描目录时不能把它们冲掉
     *   2) 流媒体接口的**白名单**要放行它们（否则自己打开的文件反而播不了）
     */
    this.extraFiles = new Set();
    /**
     * 散装文件那几张**侧车封面**（`歌名.jpg` / `folder.jpg`）。
     *
     * 白名单是按**路径**逐条放行的，放行了 `歌.mp3` 并不等于放行同目录的
     * `folder.jpg` —— 结果就是散装文件的封面请求被自己的服务端 403 挡掉，
     * 控制台那一列全是"拒绝越界的封面请求"，歌也没有图（实测踩到）。
     * 这里只登记**我们自己认定过的**那几张（coverFileFor 查出来的），不是整个目录。
     */
    this.extraCovers = new Set();
  }

  /**
   * 把某个文件重新登记进流媒体白名单（幂等）。
   *
   * 为什么需要：`extraFiles` 只在**内存**里 —— 「打开文件」放行的散装文件一重启
   * 就忘了；而「已保存播放列表」是**落盘**的。于是重开程序后从列表里点那首本地歌，
   * 文件已不在白名单里，`/stream/local` 直接 403，播放核心只报一句没头没脑的
   * "The element has no supported sources."（2026-09-27 用户报障）。
   * 取流前把曲目自己的文件登记回来，这条路才闭合。
   *
   * 只认「存在 + 是文件 + 音频后缀」：白名单本意是挡住"随便一个路径都读"，
   * 而这里登记的是**引擎自己正在播的曲目**（路径来自曲目对象，是用户自己挑过的
   * 文件），不是外部请求塞进来的路径。
   *
   * @returns {boolean} 是否可读（false = 文件没了 / 不是音频，调用方应据此报错）
   */
  admitFile(file) {
    if (!file) return false;
    try {
      if (!AUDIO_EXT.has(path.extname(file).toLowerCase())) return false;
      if (!fs.statSync(file).isFile()) return false;
    } catch { return false; } // 不存在 / 无权限
    this.extraFiles.add(file);
    return true;
  }

  // ---------------------------------------------------------------- 扫描
  async scan({ force = false } = {}) {
    if (!force && this.tracks.length) return this.tracks;
    const files = [];
    for (const dir of this.dirs) this._walk(dir, files);
    this.log(`[local] 发现 ${files.length} 个音频文件`);

    const out = [];
    for (const file of files) {
      const t = await this.probe(file);
      if (t) out.push(t);
    }
    out.sort((a, b) => a.title.localeCompare(b.title, 'zh'));

    // 保留用户用「打开文件」加进来的散装文件（它们不在任何扫描目录里，
    // 重扫时如果直接覆盖 tracks 就会被冲掉）。
    for (const p of this.extraFiles) {
      if (out.some((t) => t.file === p)) continue;
      if (!fs.existsSync(p)) { this.extraFiles.delete(p); continue; }
      const t = await this.probe(p);
      if (t) { t.openedAdhoc = true; out.push(t); }
    }
    out.sort((a, b) => a.title.localeCompare(b.title, 'zh'));

    this.tracks = out;
    this._reindex();
    return out;
  }

  _walk(dir, acc, depth = 0) {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) this._walk(full, acc, depth + 1);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) acc.push(full);
    }
  }

  async probe(file) {
    const r = await run(this.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration:format_tags=title,artist,album',
      '-of', 'json', file,
    ]);
    if (!r.ok) return null;
    let j;
    try { j = JSON.parse(r.out); } catch { return null; }
    const fmt = j.format || {};
    // 注意：ffprobe 输出的键是 `format.tags`，**不是** `format.format_tags`
    // （命令行里的 `format_tags=` 只是取值语法，不体现在 JSON 键名上）
    const tags = fmt.tags || fmt.format_tags || {};
    const base = path.basename(file, path.extname(file));
    return {
      source: 'local',
      id: file,
      file,
      name: tags.title || base,
      title: tags.title || base,
      artists: tags.artist ? [tags.artist] : [],
      artistText: tags.artist || '未知艺术家',
      album: tags.album || '',
      duration: parseFloat(fmt.duration) || 0,
    };
  }

  /** 关键词搜索（文件名/标题/艺术家，忽略大小写与空格） */
  search(keyword, limit = 20) {
    const k = String(keyword || '').toLowerCase().replace(/\s+/g, '');
    if (!k) return [];
    return this.tracks
      .filter((t) => (t.title + t.artistText + path.basename(t.file)).toLowerCase().replace(/\s+/g, '').includes(k))
      .slice(0, limit);
  }

  // ---------------------------------------------------------------- 歌词
  /**
   * 找同名旁车歌词文件（大小写不敏感地找一遍）。
   *
   * 命名约定**只写在这一处**：读（`lyrics`）与删（`dropSidecarLyrics`）必须认
   * 同一批文件，各写一遍迟早走样。
   *   · <base>.lrc          标准歌词（兼容其它播放器）—— **首选**
   *   · <base>.karaoke.lrc  旧版逐字文件：逐字显示已下线，但**仍读它**，
   *     兼容以前落过盘的歌（它的正文与标准版一致，只是多了行内时间戳）
   *   · <base>.trans.lrc    翻译
   * @returns {{lrcPath:string|null, karaokePath:string|null, transPath:string|null}}
   */
  _sidecarPaths(file) {
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file));
    const out = { lrcPath: null, karaokePath: null, transPath: null };
    try {
      for (const e of fs.readdirSync(dir)) {
        const ext = path.extname(e).toLowerCase();
        if (!LRC_EXT.has(ext)) continue;
        const stem = path.basename(e, path.extname(e)).toLowerCase();
        if (stem === base.toLowerCase()) out.lrcPath = path.join(dir, e);
        else if (stem === (base + '.karaoke').toLowerCase()) out.karaokePath = path.join(dir, e);
        else if (stem === (base + '.trans').toLowerCase()) out.transPath = path.join(dir, e);
      }
    } catch { /* 目录不可读 */ }
    return out;
  }

  /**
   * 取本地歌词。返回 {lrc, tlyric, source}。
   * 顺序：同名 .lrc → .trans.lrc 翻译 → 内嵌标签
   *
   * **读 .lrc 必须走 readTextFile（不要直接 readFileSync(..., 'utf8')）**：
   * 这些文件不是我们写的，很多是 GBK/GB2312 或 UTF-16LE 的老文件，
   * 按 UTF-8 硬读会得到满屏乱码（见 core/text-file.js 里的实测数据）。
   */
  async lyrics(file) {
    const { lrcPath, karaokePath, transPath } = this._sidecarPaths(file);

    if (lrcPath || karaokePath) {
      // 现在逐字不渲染了，所以**标准版优先**（内容一样，还省一次内联时间戳解析）；
      // 只有旧的逐字文件存在、标准版缺失时才用它兜底
      const main = lrcPath || karaokePath;
      const lrc = readTextFile(main);
      const tlyric = transPath ? readTextFile(transPath) : '';
      return { ok: true, lrc, tlyric, romalrc: '', yrc: '', source: 'sidecar' };
    }

    // 2) 内嵌标签兜底（下面继续）
    return this._lyricsEmbedded(file);
  }

  /**
   * 把匹配到的歌词写到歌曲文件旁边（旁车文件）。
   *
   * 这是最可靠的一条歌词来源：不联网、不受限流影响，歌搬到哪歌词跟哪。
   * 写**两个**文件（都**只在不存在时**创建，绝不覆盖用户自己放的歌词）：
   *   <base>.lrc        标准 LRC —— 给任何播放器都能用
   *   <base>.trans.lrc  翻译     —— 有翻译时才写
   *
   * 2026-09-26：**不再写 `<base>.karaoke.lrc`**（增强型/逐字版）——
   * 逐字染色显示已下线，那份文件再没人读；少写一个文件＝少一份目录噪音，
   * 也少一次磁盘写入。老的 .karaoke.lrc 仍然**照常读取**（向后兼容），
   * 所以以前落过盘的歌不受影响。
   *
   * @returns {{ok:boolean, written?:string[], skipped?:string[], msg?:string}}
   */
  saveLyrics(file, timeline, { enabled = true } = {}) {
    if (!enabled) return { ok: true, written: [], skipped: [], msg: 'disabled' };
    if (!file || !timeline || !(timeline.lines || []).length) return { ok: false, msg: '没有可保存的歌词' };
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file));
    const { timelineToLrc, timelineToTransLrc } = require('../../core/lyrics/lrc');

    const targets = [];
    const text = timelineToLrc(timeline, { enhanced: false });
    if (text) targets.push([path.join(dir, `${base}.lrc`), text, '标准歌词']);
    const trans = timelineToTransLrc(timeline);
    if (trans) targets.push([path.join(dir, `${base}.trans.lrc`), trans, '翻译']);

    const written = [];
    const skipped = [];
    for (const [p, content, what] of targets) {
      try {
        if (fs.existsSync(p)) { skipped.push(p); continue; }  // 绝不覆盖已有歌词
        fs.writeFileSync(p, content, 'utf8');
        written.push(p);
        this.log(`[local] 已写入${what}：${path.basename(p)}`);
      } catch (e) {
        // 常见于只读目录 / 需要管理员权限的目录（比如某些盘符根下）
        return { ok: false, written, skipped, msg: `${path.dirname(p)} 不可写：${e.message}` };
      }
    }
    return { ok: true, written, skipped };
  }

  /**
   * 删掉这首歌的**旁车歌词文件**（`<base>.lrc` / `<base>.trans.lrc`）。
   *
   * 只在用户明确说"这份歌词是错的，删掉"时调用（`engine.lyricAutoBan`）
   * —— 也就是控制台歌词条上的「歌词配错 ✕」。
   *
   * ⚠️ **这里删的可能是用户自己放的歌词**：`saveLyrics` 从不覆盖已有文件，
   * 所以磁盘上无法区分"我们匹配写入的"和"用户从别处拷来的"。
   * "本地曲一并删掉"是用户在 2026-10-16 明确选的取舍。
   * 旧版 `<base>.karaoke.lrc` **不删**（超出用户确认的范围），
   * 它会被只读不删地留在原地 —— 但拉黑之后 `lyrics()` 根本不会被调用。
   *
   * @returns {{ok:boolean, removed:string[], errors:Array<{path:string,msg:string}>, kept:string[], msg?:string}}
   */
  dropSidecarLyrics(file) {
    const out = { ok: true, removed: [], errors: [], kept: [] };
    if (!file) { out.ok = false; out.msg = '没有文件路径'; return out; }
    const { lrcPath, transPath, karaokePath } = this._sidecarPaths(file);
    if (karaokePath) out.kept.push(karaokePath);
    for (const p of [lrcPath, transPath]) {
      if (!p) continue;
      try {
        fs.unlinkSync(p);
        out.removed.push(p);
        this.log(`[local] 已删除旁车歌词：${path.basename(p)}`);
      } catch (e) {
        out.ok = false;
        out.errors.push({ path: p, msg: e.message });
      }
    }
    return out;
  }

  /** 内嵌标签（ffmpeg 的 ffmetadata 会把 lyrics/unsyncedlyrics 打出来） */
  async _lyricsEmbedded(file) {
    const r = await run(this.ffmpeg, ['-v', 'error', '-i', file, '-f', 'ffmetadata', '-']);
    if (r.ok && r.out) {
      const grab = (keys) => {
        for (const line of r.out.split('\n')) {
          const eq = line.indexOf('=');
          if (eq < 0) continue;
          const k = line.slice(0, eq).trim().toLowerCase();
          if (keys.includes(k)) return line.slice(eq + 1).replace(/\\n/g, '\n').replace(/\\([=;#\\])/g, '$1');
        }
        return '';
      };
      const lrc = grab(['lyrics', 'unsyncedlyrics', 'unsynced lyrics', 'syncedlyrics']);
      if (lrc) return { ok: true, lrc, tlyric: '', romalrc: '', yrc: '', source: 'embedded' };
    }

    return { ok: false, lrc: '', tlyric: '', romalrc: '', yrc: '', source: 'none' };
  }

  // ---------------------------------------------------------------- 临时打开单个文件
  /**
   * 把用户用「打开文件」选中的散装音频加进曲库（不影响目录配置）。
   * @param {string[]} paths 绝对路径
   * @returns {Promise<{added:object[], skipped:string[]}>}
   */
  async addFiles(paths = []) {
    const added = [];
    const skipped = [];
    for (const p of paths) {
      if (!p || !fs.existsSync(p)) { skipped.push(p); continue; }
      if (!AUDIO_EXT.has(path.extname(p).toLowerCase())) { skipped.push(p); continue; }
      const already = this.tracks.find((t) => t.file === p);
      if (already) { this.extraFiles.add(p); added.push(already); continue; }
      const t = await this.probe(p);
      if (!t) { skipped.push(p); continue; }
      t.openedAdhoc = true; // 标记来源，便于 UI 区分
      this.tracks.push(t);
      this.tracks.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
      this._reindex();
      this.extraFiles.add(p);
      added.push(t);
    }
    if (added.length) this.log(`[local] 已加入 ${added.length} 个本地文件`);
    return { added, skipped };
  }

  /** 重建索引（新增/删除后调用） */
  _reindex() {
    this.index = new Map();
    for (const t of this.tracks) {
      this.index.set(t.file.toLowerCase(), t);
      this.index.set(t.title.toLowerCase(), t);
      this.index.set(path.basename(t.file, path.extname(t.file)).toLowerCase(), t);
    }
  }

  /** 流媒体白名单：曲库目录 + 用户显式打开的文件 + 侧车封面 + 封面缓存目录 */
  streamAllowList() {
    return [...this.dirs, ...this.extraFiles, ...this.extraCovers, this.coverDir].filter(Boolean);
  }

  // ---------------------------------------------------------------- 封面
  /**
   * 找本地曲目的封面。顺序：
   *   1) 同名图片（`歌名.jpg` / `歌名.png`）—— 最直观
   *   2) 同目录的 `cover.*` / `folder.*` / `front.*` —— 专辑目录惯例
   *   3) 音频文件内嵌封面（ID3 APIC / FLAC PICTURE）—— 用 ffmpeg 抽出来缓存
   *
   * 抽出来的封面写到 `coverDir` 并缓存，避免每次播放都重新解一遍。
   * 同步返回（只在内存里查表），实际抽取由 prepareCover() 异步完成。
   */
  coverFileFor(file) {
    if (!file) return null;
    if (this._coverCache.has(file)) return this._coverCache.get(file);
    const found = this._findSidecarCover(file);
    if (found) {
      this._coverCache.set(file, found);
      // 侧车封面也要进白名单（见 extraCovers 的注释：封面接口与音频接口同一份白名单）
      this.extraCovers.add(found);
      return found;
    }
    return null;
  }

  _findSidecarCover(file) {
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file));
    const exts = ['.jpg', '.jpeg', '.png', '.webp'];
    // 1) 同名图片
    for (const e of exts) {
      for (const cand of [path.join(dir, base + e), path.join(dir, base + e.toUpperCase())]) {
        if (fs.existsSync(cand)) return cand;
      }
    }
    // 2) 目录惯例
    for (const n of ['cover', 'folder', 'front', 'album', 'AlbumArt']) {
      for (const e of exts) {
        const cand = path.join(dir, n + e);
        if (fs.existsSync(cand)) return cand;
      }
    }
    return null;
  }

  /**
   * 异步准备封面：侧车图片直接用；否则尝试从音频里抽内嵌封面并缓存。
   * @returns {Promise<string|null>} 可直接给 <img src> 用的本地绝对路径
   */
  async prepareCover(file) {
    const side = this.coverFileFor(file);
    if (side) return side;

    const cached = this._embeddedCoverPath(file);
    if (fs.existsSync(cached)) { this._coverCache.set(file, cached); return cached; }

    if (!this.coverDir) return null;
    try {
      fs.mkdirSync(this.coverDir, { recursive: true });
    } catch { return null; }

    // `-vn -c:v copy` 对多数容器可用；失败就说明没有内嵌封面，属正常
    const r = await run(this.ffmpeg, [
      '-v', 'error', '-y', '-i', file, '-an', '-vcodec', 'copy', cached,
    ], 20000);
    if (r.ok && fs.existsSync(cached) && fs.statSync(cached).size > 512) {
      this._coverCache.set(file, cached);
      this.log('[local] 已抽取内嵌封面:', path.basename(cached));
      return cached;
    }
    try { if (fs.existsSync(cached)) fs.unlinkSync(cached); } catch { /* 忽略 */ }
    return null;
  }

  _embeddedCoverPath(file) {
    const h = require('node:crypto').createHash('sha1').update(file).digest('hex').slice(0, 16);
    return path.join(this.coverDir || os.tmpdir(), `cover-${h}.jpg`);
  }
}

module.exports = { LocalLibrary, AUDIO_EXT };
