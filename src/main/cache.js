/**
 * 在线媒体本地缓存
 * ==================
 * 目的：**在线放过的歌，下次不再重新取流**。
 *   · 网易云的直链带 `expi`（约 20 分钟过期）—— 缓存下来就不受过期影响
 *   · B站的取流要过代理注入 Referer，每次都要走一趟网络
 *   · 直播间反复点同一首歌是常态，缓存收益很直接
 *
 * 关键设计（都踩过或想过才这么定）：
 *   1) **不阻塞播放**：首次播放仍然直接用远端直链（立刻出声），
 *      同时在后台下载落盘。下次播放才走本地文件。绝不为了缓存让观众多等。
 *   2) **LRU 淘汰**：按 totalBytes 上限自动清理最久未用的条目。
 *   3) **单文件上限**：超大的（比如 B站 Hi-Res）不缓存，避免一条撑爆整个缓存。
 *   4) **原子写入**：先写 `.part` 再 rename，避免半截文件被当成可用缓存。
 *   5) 本地文件不缓存（它本来就是本地的）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * 集中索引文件名（放在缓存目录下）。
 *
 * **边车 `.json` 仍然是真相源** —— 这个文件只是"启动加速用的缓存"：
 * 名字列表对不上（`filesHash` 不匹配）或它本身坏了，就回落到逐条读边车重建。
 */
const INDEX_FILE = 'index.json';

/** 目录里一批文件名的哈希：用来判断集中索引是否与磁盘一致 */
function hashFiles(names) {
  return crypto.createHash('md5').update([...names].sort().join('\n')).digest('hex');
}

class MediaCache {
  /**
   * @param {{dir:string, maxBytes?:number, maxFileBytes?:number, enabled?:boolean, log?:Function}} opts
   */
  constructor(opts = {}) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? 2 * 1024 * 1024 * 1024; // 默认 2GB
    this.maxFileBytes = opts.maxFileBytes ?? 120 * 1024 * 1024; // 单文件 ≤120MB
    this.enabled = opts.enabled !== false;
    this.log = opts.log || (() => {});
    this.index = new Map(); // key -> {file, size, at, name, artist, source}
    /**
     * 歌词缓存的文件大小（键 → 字节），**内存维护**。
     * 为什么不每次扫目录：见 lyricStats 的注释（那是同步 IO，会被 10Hz 广播顶穿）。
     */
    this._lyricSizes = new Map();
    this._active = new Set(); // 正在下载的 key，防止重复下载
    this._loaded = false;
    /**
     * stats() 的记忆化缓存（2026-09-26 加）。
     *
     * 为什么必须做：`stats()` 要 `readdirSync` 歌词目录 + 对每个文件 `statSync`，
     * 是**同步磁盘 IO**。而它被 `engine.state()` 在 **10Hz 广播**里调用
     * （另外每次 emit('change') 也会走一遍）。Electron 官方性能文档说得很直接：
     * "Avoid using blocking I/O operations in the main process... prefer the
     * asynchronous and non-blocking variant" —— 同步 IO 卡住主进程就是 UI 卡顿。
     *
     * 失效时机：所有会改动缓存的方法末尾调 `_invalidate()`。
     */
    this._statsCache = null;
  }

  /**
   * 缓存内容变了 -> 让 stats() 的记忆失效（所有写路径都要调）。
   * **顺便把集中索引落盘** —— 它只在这里被调用，正好是"索引内容可能变了"的唯一时机，
   * 所以把落盘挂在这一处就够了，不必在每个写方法里各写一遍。
   */
  _invalidate() {
    this._statsCache = null;
    this._writeIndex();
  }

  /**
   * 读取磁盘上的索引。
   *
   * 两条路径（2026-09-26 加集中索引）：
   *   · **快路径**：读 `<dir>/index.json`（一次 IO）。实测 3000 条只要 **3ms**。
   *   · **慢路径**：逐条读边车 `.json`（每条 3 次系统调用：读 json + 判 bin 在不在 + 取 size）。
   *     实测 3000 条要 **1320ms**，而且全是**同步 IO** —— 会把 Electron 主进程卡住，
   *     表现就是"缓存攒多了之后启动变慢/界面卡一下"。
   *     （分解实测：readdir 2ms、JSON.parse 1ms —— 成本**全在"每个条目独立开文件"**上。）
   *
   * 什么时候走慢路径：索引文件不存在（老用户第一次升级）、损坏、或 `filesHash` 对不上
   * （有边车被外部增删）。这些都是"状态不确定"，宁可慢一次也要正确；
   * 重建之后把索引写好，下一次就走快路径。
   */
  init() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.enabled || !this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const files = this._entryFiles();
      if (this._restoreFromIndex(files)) {
        this.log(`[cache] 已加载 ${this.index.size} 条缓存、${(this.totalBytes() / 1048576).toFixed(1)} MB（集中索引）`);
        return;
      }
      this._scanAll(files);
      this._writeIndex();   // 重建好就落盘，下次启动走快路径
      this.log(`[cache] 已加载 ${this.index.size} 条缓存、${(this.totalBytes() / 1048576).toFixed(1)} MB（逐条扫描）`);
    } catch (e) {
      this.log('[cache] 初始化失败:', e.message);
    }
  }

  /** 缓存目录里的**条目**边车文件名（排除集中索引自己） */
  _entryFiles() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') && f !== INDEX_FILE);
    } catch { return []; }
  }

  /** 快路径：从集中索引恢复（文件名单对得上才用） */
  _restoreFromIndex(files) {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(this.dir, INDEX_FILE), 'utf8')); } catch { return false; }
    if (!j || j.v !== 1 || !Array.isArray(j.items) || j.filesHash !== hashFiles(files)) return false;
    for (const m of j.items) {
      if (!m || !m.key) continue;
      this.index.set(m.key, { ...m, file: path.join(this.dir, m.key + '.bin') });
    }
    // 歌词统计一并恢复 —— 否则启动时还要扫一遍歌词目录（同一个"逐文件 stat"的坑）
    this._lyricSizes.clear();
    for (const [k, bytes] of Object.entries(j.lyricSizes || {})) this._lyricSizes.set(k, bytes);
    return true;
  }

  /** 慢路径：逐条读边车 `.json`（真相源） */
  _scanAll(files) {
    this._lyricSizes.clear();
    for (const f of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        const bin = path.join(this.dir, meta.key + '.bin');
        if (!fs.existsSync(bin)) { fs.unlinkSync(path.join(this.dir, f)); continue; }
        meta.file = bin;
        meta.size = fs.statSync(bin).size;
        this.index.set(meta.key, meta);
      } catch { /* 坏索引直接忽略 */ }
    }
    if (this.lyricDir) {
      try {
        for (const f of fs.readdirSync(this.lyricDir)) {
          if (!f.endsWith('.json')) continue;
          try { this._lyricSizes.set(f.slice(0, -5), fs.statSync(path.join(this.lyricDir, f)).size); } catch { /* 忽略 */ }
        }
      } catch { /* 歌词目录还不存在 */ }
    }
  }

  /**
   * 把当前索引写回集中索引文件。**同步写**（实测 3000 条仅 3ms / 614KB）。
   *
   * 为什么不做防抖或异步：一次就几毫秒，换来"索引与内存永远一致"这个简单性质 ——
   * 不需要退出钩子、不需要对账逻辑、也不会在崩溃后留下过期索引。
   * 写失败只记日志（下次启动回落到慢路径重建，不影响正确性）。
   */
  _writeIndex() {
    if (!this.enabled || !this.dir) return;
    // 还没加载完就写，会把磁盘上好好的索引覆盖成空的
    if (!this._loaded) return;
    try {
      const files = this._entryFiles();
      fs.writeFileSync(path.join(this.dir, INDEX_FILE), JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        filesHash: hashFiles(files),
        items: [...this.index.values()].map((m) => ({
          key: m.key, size: m.size, at: m.at, name: m.name, artist: m.artist,
          source: m.source, contentType: m.contentType,
        })),
        lyricSizes: Object.fromEntries(this._lyricSizes),
      }));
    } catch (e) {
      this.log('[cache] 写集中索引失败（不影响使用，下次启动会重建）:', e.message);
    }
  }

  /** 缓存键：只对"在线"曲目有意义；本地文件返回 null */
  keyFor(track) {
    if (!track) return null;
    if (track.source === 'netease' && track.id != null) return `netease-${track.id}`;
    if (track.source === 'bilibili' && (track.bvid || track.cid)) {
      return `bilibili-${track.bvid || track.cid}${track.cid && track.bvid ? '-' + track.cid : ''}`;
    }
    return null;
  }

  totalBytes() {
    let n = 0;
    for (const m of this.index.values()) n += m.size || 0;
    return n;
  }

  /** 命中缓存则返回文件路径并刷新 LRU 时间 */
  get(key) {
    if (!this.enabled) return null;
    this.init();
    const m = this.index.get(key);
    if (!m) return null;
    if (!fs.existsSync(m.file)) { this.index.delete(key); return null; }
    m.at = Date.now();
    try { fs.writeFileSync(path.join(this.dir, key + '.json'), JSON.stringify(m)); } catch { /* 忽略 */ }
    return { file: m.file, size: m.size, meta: m };
  }

  has(key) { return !!this.get(key); }

  /**
   * 下载并落盘。**调用方不必等它**（首次播放走远端直链，这里只做后台落盘）。
   * @param {string} key
   * @param {string} url
   * @param {{headers?:object, name?:string, artist?:string, source?:string, ext?:string}} [meta]
   */
  async put(key, url, meta = {}) {
    if (!this.enabled || !this.dir || !key || !url) return { ok: false, msg: 'cache disabled' };
    this.init();
    if (this.index.has(key)) return { ok: true, cached: true, skipped: 'already' };
    if (this._active.has(key)) return { ok: true, cached: true, skipped: 'in-flight' };
    this._active.add(key);

    const part = path.join(this.dir, key + '.part');
    const bin = path.join(this.dir, key + '.bin');
    try {
      const res = await fetch(url, { headers: meta.headers || {}, redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const type = res.headers.get('content-type') || '';
      if (!/^(audio|video|application\/octet-stream|binary)/.test(type)) {
        throw new Error('非媒体响应：' + type);
      }
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared && declared > this.maxFileBytes) throw new Error(`文件过大（${(declared / 1048576).toFixed(1)}MB），不缓存`);

      const fh = fs.openSync(part, 'w');
      let size = 0;
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          size += buf.length;
          if (size > this.maxFileBytes) throw new Error('超过单文件上限，放弃缓存');
          fs.writeSync(fh, buf);
        }
      } finally {
        fs.closeSync(fh);
      }
      if (size < 4096) throw new Error('内容过小，疑似错误页');

      fs.renameSync(part, bin); // 原子替换，避免半截文件被当成可用缓存
      const rec = {
        key, file: bin, size, at: Date.now(),
        name: meta.name || '', artist: meta.artist || '',
        source: meta.source || '', contentType: type,
      };
      fs.writeFileSync(path.join(this.dir, key + '.json'), JSON.stringify(rec));
      this.index.set(key, rec);
      this._invalidate();
      await this.evictIfNeeded();
      this.log(`[cache] 已缓存 ${rec.name || key}（${(size / 1048576).toFixed(1)} MB）`);
      return { ok: true, size, file: bin };
    } catch (e) {
      try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch { /* 忽略 */ }
      return { ok: false, msg: e.message };
    } finally {
      this._active.delete(key);
    }
  }

  /** 超出总容量时按最久未用淘汰 */
  async evictIfNeeded() {
    if (this.totalBytes() <= this.maxBytes) return { evicted: 0 };
    const items = [...this.index.values()].sort((a, b) => (a.at || 0) - (b.at || 0));
    let evicted = 0;
    let freed = 0;
    for (const m of items) {
      if (this.totalBytes() <= this.maxBytes) break;
      try { fs.unlinkSync(m.file); } catch { /* 忽略 */ }
      try { fs.unlinkSync(path.join(this.dir, m.key + '.json')); } catch { /* 忽略 */ }
      this.index.delete(m.key);
      evicted++;
      freed += m.size || 0;
    }
    if (evicted) {
      this._invalidate();
      this.log(`[cache] 已淘汰 ${evicted} 条（释放 ${(freed / 1048576).toFixed(1)} MB）`);
    }
    return { evicted, freed };
  }

  /**
   * 把一条**已有的**缓存改挂到新键下 —— 键口径变更时的无损迁移。
   *
   * 为什么需要：B站的缓存键是 `bilibili-<bvid>-<cid>`，而"关键词点歌"进来的曲目
   * 一度不带 cid（`searchVideo` 的返回里没有这个字段），于是同一个视频按
   * `bilibili-<bvid>` 存了一份。改对了键口径之后，那份旧条目会变成**永远不被命中
   * 的孤儿** —— 用户既看不到它，又白白占着几十 MB。
   * 这里只做改名认领（同目录 rename，原子且不复制数据），不删任何东西。
   *
   * @returns {object|null} 迁移后的索引记录；无需迁移（或新键已存在）时返回 null
   */
  adopt(oldKey, newKey) {
    if (!this.enabled || !this.dir || !oldKey || !newKey || oldKey === newKey) return null;
    this.init();
    if (this.index.has(newKey)) return null; // 新键已经有条目：那是更权威的一份，别覆盖
    const m = this.index.get(oldKey);
    if (!m || !m.file || !fs.existsSync(m.file)) return null;
    const bin = path.join(this.dir, newKey + '.bin');
    try {
      fs.renameSync(m.file, bin);
      try { fs.unlinkSync(path.join(this.dir, oldKey + '.json')); } catch { /* 忽略 */ }
    } catch (e) {
      this.log(`[cache] 迁移 ${oldKey} → ${newKey} 失败:`, e.message);
      return null;
    }
    this.index.delete(oldKey);
    const rec = { ...m, key: newKey, file: bin };
    this.index.set(newKey, rec);
    try { fs.writeFileSync(path.join(this.dir, newKey + '.json'), JSON.stringify(rec)); } catch { /* 忽略 */ }
    this._invalidate();
    this.log(`[cache] 已把旧键缓存认领到新键：${oldKey} → ${newKey}`);
    return rec;
  }

  /**
   * 删除某一条（例如"这首歌缓存坏了"、或清理孤儿缓存）。
   *
   * **文件删不掉时必须如实报错、且不动索引**：Windows 上正在播放的音频被
   * `<audio>` 占着，`unlinkSync` 会 EBUSY/EPERM。旧实现把这些异常一并吞掉还照删
   * 索引 —— 结果磁盘上的 `.bin` 永远留在那儿，而索引没了它再也不会被加载、
   * 不会统计、不会淘汰，变成**永久垃圾**（清理功能反而制造垃圾）。
   */
  remove(key) {
    const m = this.index.get(key);
    if (!m) return { ok: false, msg: '没有这条缓存' };
    const size = m.size || 0;
    try {
      fs.unlinkSync(m.file);
    } catch (e) {
      // ENOENT = 文件本来就不在了，那就继续把索引清干净
      if (e.code !== 'ENOENT') {
        return { ok: false, msg: `文件正被占用（${e.code || e.message}），停掉播放再删` };
      }
    }
    try { fs.unlinkSync(path.join(this.dir, key + '.json')); } catch { /* 忽略 */ }
    this.index.delete(key);
    this._invalidate();
    return { ok: true, size };
  }

  /** 索引里的全部音频键（缓存管理 / 孤儿清理用） */
  keys() {
    this.init();
    return [...this.index.keys()];
  }

  /**
   * 歌词缓存里的全部键。
   *
   * **不与音频键一一对应**：本地曲与"按歌名匹配"的那条路用的是
   * `match-<歌名>`，而它们根本没有音频条目。所以孤儿清理要把两边合起来看。
   */
  lyricKeys() {
    if (!this.enabled || !this.lyricDir) return [];
    try {
      return fs.readdirSync(this.lyricDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5));
    } catch { return []; }
  }

  /** 某个键占用的字节数（音频 + 歌词分开报），孤儿清理做"将释放多少"预览用 */
  sizeOf(key) {
    this.init();
    const m = this.index.get(key);
    let audio = m ? (m.size || 0) : 0;
    let lyric = 0;
    if (this.lyricDir) {
      try { lyric = fs.statSync(path.join(this.lyricDir, key + '.json')).size; } catch { /* 没有 */ }
    }
    return { audio, lyric };
  }

  /** 清空缓存：**音频与歌词一起清**（同一个子系统，用户点一次就该都干净） */
  async clear() {
    let n = 0;
    for (const m of [...this.index.values()]) {
      try { fs.unlinkSync(m.file); } catch { /* 忽略 */ }
      try { fs.unlinkSync(path.join(this.dir, m.key + '.json')); } catch { /* 忽略 */ }
      n++;
    }
    this.index.clear();
    this._invalidate();
    const ly = this.clearLyrics();
    if (ly.removed) this.log(`[cache] 同时清掉 ${ly.removed} 条歌词缓存`);
    return { ok: true, removed: n, lyricsRemoved: ly.removed };
  }

  /**
   * 缓存摘要。**结果被记忆化**，只有内容真的变了才重算 ——
   * 它被 10Hz 的状态广播调用，绝不能每次都做同步目录扫描（见 constructor 注释）。
   */
  stats() {
    if (this._statsCache) return this._statsCache;
    this.init();
    const items = [...this.index.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
    const ls = this.lyricStats();
    this._statsCache = {
      enabled: this.enabled,
      count: items.length,
      bytes: this.totalBytes(),
      maxBytes: this.maxBytes,
      // 歌词缓存与音频缓存同一套生命周期，统计一起给出
      lyricCount: ls.count,
      lyricBytes: ls.bytes,
      dir: this.dir,
      recent: items.slice(0, 10).map((m) => ({
        key: m.key, name: m.name, artist: m.artist, source: m.source,
        mb: Number(((m.size || 0) / 1048576).toFixed(2)), at: m.at,
      })),
    };
    return this._statsCache;
  }

  /** 缓存目录（要加进流接口白名单，否则缓存文件自己反而播不了） */
  get cacheDir() { return this.dir; }

  // ================================================================ 歌词缓存
  /**
   * 歌词缓存与音频缓存**共用一套目录与生命周期**（同一个缓存子系统）：
   * 一次管理、一份统计、一个「清空缓存」就能照看到两者。
   *
   * 为什么歌词也要缓存：
   *   1) 同一首歌重复播放不必反复联网匹配；
   *   2) 网易云按 IP 限流，反复搜同一批歌很容易把用户打进「操作频繁」，
   *      表现就是"本来有歌词的歌突然没歌词了"（真实发生过）。
   */
  get lyricDir() { return this.dir ? path.join(this.dir, 'lyrics') : null; }

  /** 歌词缓存键：与音频键同源，便于「清空缓存」时一起清掉 */
  lyricKeyFor(song) {
    const k = this.keyFor(song);
    if (k) return k;
    // 本地曲/B站视频是按歌名匹配的，用规范化歌名当键
    const title = String((song && (song.name || song.title)) || '').trim().toLowerCase();
    return title ? 'match-' + title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) : null;
  }

  getLyrics(key) {
    if (!this.enabled || !key || !this.lyricDir) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.lyricDir, key + '.json'), 'utf8'));
      if (!raw || !raw.timeline || !(raw.timeline.lines || []).length) return null;
      return raw;
    } catch { return null; }
  }

  putLyrics(key, timeline, meta = {}) {
    if (!this.enabled || !key || !this.lyricDir) return { ok: false, msg: 'cache disabled' };
    if (!timeline || !(timeline.lines || []).length) return { ok: false, msg: 'empty timeline' };
    try {
      fs.mkdirSync(this.lyricDir, { recursive: true });
      const file = path.join(this.lyricDir, key + '.json');
      const body = JSON.stringify({
        key, savedAt: Date.now(), name: meta.name || '', source: meta.source || '', timeline,
      });
      fs.writeFileSync(file, body);
      this._lyricSizes.set(key, Buffer.byteLength(body));   // 增量维护统计（见 lyricStats）
      this._invalidate();
      return { ok: true, file };
    } catch (e) { return { ok: false, msg: e.message }; }
  }

  /**
   * 歌词缓存条目数与体积（并入 stats 一起展示）。
   *
   * **走内存里的 `_lyricSizes`，不再扫目录**（2026-09-26 改）。
   * 它被 `stats()` 调用，而 `stats()` 被 10Hz 广播调用、且每次缓存写入都会让它失效重算 ——
   * 原来是"readdir + 逐文件 statSync"的同步 IO，缓存攒多之后实测 3000 条约 150ms，
   * 直接顶穿 10Hz 的预算（100ms），主进程就会持续卡顿。
   * 数据来源：启动时从集中索引恢复（或首次扫目录），之后由 putLyrics/removeLyrics 增量维护。
   */
  lyricStats() {
    if (!this.lyricDir) return { count: 0, bytes: 0 };
    let count = 0; let bytes = 0;
    for (const b of this._lyricSizes.values()) { count++; bytes += b || 0; }
    return { count, bytes };
  }

  clearLyrics() {
    if (!this.lyricDir) return { ok: true, removed: 0 };
    let n = 0;
    try {
      for (const f of fs.readdirSync(this.lyricDir)) {
        if (!f.endsWith('.json')) continue;
        try { fs.unlinkSync(path.join(this.lyricDir, f)); n++; } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
    this._lyricSizes.clear();   // 内存统计跟着清（不管磁盘上删掉了几个）
    if (n) this._invalidate();
    return { ok: true, removed: n };
  }

  // ================================================ 单条查询 / 单条删除（2026-09-26）
  /**
   * 某一首曲目的缓存现状（音频 + 歌词分开报）。
   *
   * 为什么分开报：用户可以只想删歌词（配错了想重新匹配）而不动音频 ——
   * 音频往往几十 MB 要重新下载，歌词删了代价几乎为零。
   *
   * @param {object} song
   * @returns {{key:string|null, audio:{cached:boolean, mb:number, at:number|null},
   *            lyrics:{cached:boolean, lines:number, savedAt:number|null, kb:number}}}
   */
  infoFor(song) {
    const key = this.lyricKeyFor(song);       // 音频键与歌词键同源，取不到音频键时退化到歌名
    const audioKey = this.keyFor(song);
    const out = {
      key: audioKey || key,
      audio: { cached: false, mb: 0, at: null },
      lyrics: { cached: false, lines: 0, savedAt: null, kb: 0 },
    };
    if (!this.enabled) return out;

    this.init();
    if (audioKey) {
      const m = this.index.get(audioKey);
      if (m && fs.existsSync(m.file)) {
        out.audio = { cached: true, mb: Number(((m.size || 0) / 1048576).toFixed(2)), at: m.at || null };
      }
    }
    if (key && this.lyricDir) {
      const f = path.join(this.lyricDir, key + '.json');
      try {
        const st = fs.statSync(f);
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        const lines = (raw && raw.timeline && raw.timeline.lines) || [];
        if (lines.length) {
          out.lyrics = {
            cached: true, lines: lines.length,
            savedAt: raw.savedAt || null,
            kb: Number((st.size / 1024).toFixed(1)),
          };
        }
      } catch { /* 没有就是没缓存 */ }
    }
    return out;
  }

  /** 删除某一首的**歌词**缓存（音频不动） */
  removeLyrics(key) {
    if (!key || !this.lyricDir) return { ok: false, msg: '没有歌词缓存目录' };
    const f = path.join(this.lyricDir, key + '.json');
    if (!fs.existsSync(f)) return { ok: false, msg: '没有这首歌的歌词缓存' };
    try { fs.unlinkSync(f); this._lyricSizes.delete(key); this._invalidate(); return { ok: true }; }
    catch (e) { return { ok: false, msg: e.message }; }
  }

  /**
   * 删除某一首的**全部**缓存（音频 + 歌词）。
   *
   * 注意：正在播放的那首歌，Windows 上音频文件被 `<audio>` 占着会删不掉
   * （EBUSY/EPERM）。这时**歌词还是要删掉**，并把音频的失败原因回报给调用方，
   * 让界面能说清楚"音频正被占用，停掉再删"。
   */
  removeAllFor(song) {
    const out = { ok: true, audio: { ok: false, msg: '未缓存' }, lyrics: { ok: false, msg: '未缓存' } };
    const audioKey = this.keyFor(song);
    const lyKey = this.lyricKeyFor(song);

    if (audioKey) {
      const m = this.index.get(audioKey);
      if (m) {
        try {
          fs.unlinkSync(m.file);
          try { fs.unlinkSync(path.join(this.dir, audioKey + '.json')); } catch { /* 忽略 */ }
          this.index.delete(audioKey);
          out.audio = { ok: true, mb: Number(((m.size || 0) / 1048576).toFixed(2)) };
        } catch (e) {
          out.ok = false;
          out.audio = { ok: false, msg: `音频正被占用（${e.code || e.message}），停掉播放再删` };
        }
      }
    }
    if (lyKey) out.lyrics = this.removeLyrics(lyKey);
    return out;
  }
}

module.exports = { MediaCache };
