/**
 * 点歌队列
 * =========
 * 纯逻辑、可单测、无 IO。所有拒绝原因都返回结构化 reason，
 * 方便上层直接翻译成一条弹幕回复（直播场景里"为什么没点上"必须能解释）。
 *
 * 规则（全部可配）：
 *   - 队列上限 maxSize
 *   - 每人同时排队上限 perUserMax（在放的那首不算）
 *   - 同一人冷却 cooldownMs
 *   - 同一首歌去重窗口 dedupeWindowMs（含已播放历史，避免刷同一首）
 */
'use strict';

const { EventEmitter } = require('node:events');

const REASON_TEXT = {
  ok: '',
  full: '队列已满，稍后再点~',
  per_user_limit: '你已经有点的歌在队列里啦~',
  cooldown: '点歌太频繁，喝口水再来~',
  duplicate: '这首刚放过/已在队列里~',
  empty_keyword: '点歌要带上歌名哦~',
  not_found: '没找到这首歌~',
  no_permission: '这个指令需要房管或主播权限~',
  bad_index: '序号不对~',
  not_playing: '现在没有在放的歌~',
};

/** 生成去重键：优先用 来源+id，退化到 归一化后的歌名 */
function dedupeKey(song) {
  /**
   * **B站多 P：同一视频的不同 P 是两首歌**（2026-09-27 加）。
   * 键里不带分P号的话，"刚点过第 1P"会把第 3P 当成重复直接拒掉 ——
   * 用户点了合集里的某一集，却收到"这首刚放过/已在队列里"。
   */
  const p = Number(song.page) > 1 ? `-p${Number(song.page)}` : '';
  if (song.id && song.source) return `${song.source}:${song.id}${p}`;
  if (song.bvid) return `bilibili:${song.bvid}${p}`;
  const t = String(song.title || song.name || '').toLowerCase().replace(/[\s\-_（）()【】\[\]]/g, '');
  const a = (song.artists || []).join('').toLowerCase();
  return `title:${t}|${a}`;
}

class SongQueue extends EventEmitter {
  /**
   * @param {{maxSize?:number, perUserMax?:number, cooldownMs?:number,
   *          dedupeWindowMs?:number, historySize?:number,
   *          privileged?:Set<string>, log?:Function}} [opts]
   */
  constructor(opts = {}) {
    super();
    this.maxSize = opts.maxSize ?? 50;
    this.perUserMax = opts.perUserMax ?? 2;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.dedupeWindowMs = opts.dedupeWindowMs ?? 30 * 60_000;
    /** 允许重复点同一首：关掉"刚放过就不给点"这条规则 */
    this.allowDuplicate = !!opts.allowDuplicate;
    this.historySize = opts.historySize ?? 100;
    this.privileged = opts.privileged || new Set();
    this.log = opts.log || (() => {});

    this.items = [];
    this.current = null;
    this.history = []; // [{key, at}]
    this.lastOrderAt = new Map(); // uid -> ts
    this._seq = 1;
  }

  get length() { return this.items.length; }

  /** 是否具备管理权限（房管/主播/配置白名单） */
  canManage(user = {}) {
    if (user.isAdmin || user.isAnchor) return true;
    if (user.uid != null && this.privileged.has(String(user.uid))) return true;
    return false;
  }

  _recentlyPlayed(key) {
    const now = Date.now();
    return this.history.some((h) => h.key === key && now - h.at < this.dedupeWindowMs);
  }

  /**
   * 入队
   * @param {object} song 统一歌曲对象 {source,id,name/artists...} 或 {source:'bilibili',bvid,title}
   * @param {{uid:any,uname:string,isAdmin?:boolean,isAnchor?:boolean,urgent?:boolean}} user
   * @returns {{ok:boolean, reason:string, msg:string, position?:number, item?:object}}
   */
  push(song, user = {}, { urgent = false, force = false } = {}) {
    if (!song) return this._reject('not_found');
    const key = dedupeKey(song);
    const uidKey = String(user.uid ?? user.uname ?? 'anon');

    // force：仅供**引擎内部**使用（列表循环回填、上一首回退、闲时歌单）。
    // 这些场景里"刚放过"本来就正常，不能让去重把它们挡掉
    // —— 踩过：列表循环因为去重完全失效，一首都没回填进来。
    if (!force) {
      if (this.current && this.current.key === key) return this._reject('duplicate');
      if (this.items.some((i) => i.key === key)) return this._reject('duplicate');
      // 「刚放过」这一条可以关掉：有些主播就是想让观众重复点同一首
      if (!this.allowDuplicate && this._recentlyPlayed(key)) return this._reject('duplicate');
    }

    const isManager = this.canManage(user);
    if (!isManager && !force) {
      const mine = this.items.filter((i) => i.uid === uidKey).length;
      if (mine >= this.perUserMax) return this._reject('per_user_limit');
      const last = this.lastOrderAt.get(uidKey) || 0;
      const wait = this.cooldownMs - (Date.now() - last);
      if (wait > 0) {
        return { ok: false, reason: 'cooldown', msg: `点歌太频繁，请等 ${Math.ceil(wait / 1000)} 秒~` };
      }
    }
    // 容量上限：
    //   · 普通观众 → 拦
    //   · 引擎内部回填(force) → 也拦，避免队列无限膨胀
    //   · **主播/房管 → 放行**（这是刻意保留的行为：主播想加就加，别被上限卡住）
    if (this.items.length >= this.maxSize && !isManager) {
      return force
        ? { ok: false, reason: 'full', msg: '队列已满（内部回填被容量上限拦下）' }
        : this._reject('full');
    }

    const item = {
      seq: this._seq++,
      key,
      song,
      uid: uidKey,
      uname: user.uname || '匿名',
      isAdmin: !!user.isAdmin,
      requestedAt: Date.now(),
    };

    // 主播/房管可插队
    if (urgent && isManager) this.items.unshift(item);
    else this.items.push(item);

    this.lastOrderAt.set(uidKey, Date.now());
    const position = this.items.indexOf(item) + 1;
    this.emit('push', item);
    this.emit('change', this.list());
    return { ok: true, reason: 'ok', msg: '', position, item };
  }

  _reject(reason) {
    return { ok: false, reason, msg: REASON_TEXT[reason] || '点歌失败' };
  }

  /** 取出下一首并设为在放（同时写入历史用于去重） */
  next() {
    if (this.current) {
      this.history.unshift({ key: this.current.key, at: Date.now() });
      if (this.history.length > this.historySize) this.history.length = this.historySize;
      this.emit('finish', this.current);
    }
    const item = this.items.shift() || null;
    this.current = item;
    this.emit('change', this.list());
    if (item) this.emit('play', item);
    return item;
  }

  /** 预排下一首（不弹出） */
  peek() { return this.items[0] || null; }

  /**
   * **回退**：把「正在放的那首」塞回待播最前，并清空 `current`。
   *
   * 为什么必须把 `current` 一起清掉（2026-09-27 修，用户报"上一首之后列表对不上"）：
   * 原来「上一首」只是 `items.unshift(当前这首)`，`current` 照样指着它。于是
   * 那首歌**同时**出现在"正在播放"行和待播第一行 —— 界面上看到同一个歌名两次，
   * 而真正在放的那首（从历史里回退出来的）反倒不在任何一行里。用户据此判断
   * "点了上一首，列表却没回去"，进而以为下一首会跳歌。
   *
   * 清空 current 之后语义才自洽：正在放的那首由引擎的 `track` 决定，
   * 队列里就只剩"待播"。界面拿 `state().queue.current` 为空时用当前曲目补一行。
   *
   * @param {object} item 待回退的队列项（形状与 items 里的项一致）
   * @returns {object|null} 塞回去的那一项
   */
  rewindTo(item) {
    if (!item) return null;
    this.items.unshift(item);
    this.current = null;
    this.emit('change', this.list());
    return item;
  }

  /** 按队列序号（1-based）删除；无 index 时删除自己下一首 */
  remove(index, user = {}) {
    if (index == null) {
      const uidKey = String(user.uid ?? user.uname ?? 'anon');
      const i = this.items.findIndex((it) => it.uid === uidKey);
      if (i < 0) return this._reject('bad_index');
      index = i + 1;
    }
    if (!Number.isInteger(index) || index < 1 || index > this.items.length) return this._reject('bad_index');
    const [removed] = this.items.splice(index - 1, 1);
    this.emit('remove', removed);
    this.emit('change', this.list());
    return { ok: true, reason: 'ok', msg: '', item: removed };
  }

  /** 清空队列（不影响在放） */
  clear(user = {}) {
    const n = this.items.length;
    this.items = [];
    this.emit('change', this.list());
    return { ok: true, reason: 'ok', msg: `已清空 ${n} 首`, count: n };
  }

  /** 查询某人在队列里的位置 */
  positionOf(user = {}) {
    const uidKey = String(user.uid ?? user.uname ?? 'anon');
    if (this.current && this.current.uid === uidKey) return { playing: true, position: 0 };
    const i = this.items.findIndex((it) => it.uid === uidKey);
    return { playing: false, position: i >= 0 ? i + 1 : null };
  }

  /** 给弹幕回执用的文本队列快照 */
  list(limit = 10) {
    return {
      current: this.current && this._brief(this.current),
      items: this.items.slice(0, limit).map((it, i) => ({ ...this._brief(it), position: i + 1 })),
      total: this.items.length,
    };
  }

  _brief(item) {
    const s = item.song || {};
    return {
      seq: item.seq,
      /**
       * 去重键要带出来（2026-09-26 修）：
       *   · 控制台的队列重绘签名用它比较（原来没有 → `it.key` 恒为 undefined，
       *     同批歌曲重排时不重绘，界面会停在旧顺序）
       *   · 队列里的「加入已保存」按它回查歌曲（见 engine.findQueueSong）
       */
      key: item.key,
      name: s.name || s.title || '未知',
      artists: s.artists || [],
      artistText: s.artistText || (s.artists || []).join(' / '),
      source: s.source,
      bvid: s.bvid,
      uname: item.uname,
      uid: item.uid,
      duration: s.duration || 0,
    };
  }
}

module.exports = { SongQueue, dedupeKey, REASON_TEXT };
