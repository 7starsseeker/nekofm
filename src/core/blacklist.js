/**
 * 本地黑名单 / 审核规则
 * ======================
 * 纯逻辑、可单测、无 IO。规则由 Engine 持有并持久化到 config.json。
 *
 * 为什么做成"多类型规则"而不是只存歌曲 ID：
 *   直播里被点爆的往往不是某首具体的歌，而是**某类**东西 ——
 *   某个歌手、某个关键词（如"鬼叫""土味"）、或者一段不能播的 B站视频。
 *   只按 ID 拉黑，换个版本/换个人翻唱就又进来了。
 *
 * 规则类型：
 *   song     歌曲 ID（网易云 id / 本地文件路径哈希）—— 精确
 *   bvid     B站视频 BV 号 —— 精确
 *   keyword  标题关键词 —— 子串匹配（归一化后）
 *   artist   歌手名 —— 子串匹配（归一化后）
 *
 * 匹配前统一归一化：转小写、去空格与常见标点。
 * 这样"孤 勇 者"和"孤勇者"、"Lemon"和"lemon"都能命中同一条规则。
 */
'use strict';

const RULE_TYPES = ['song', 'bvid', 'keyword', 'artist'];

/** 归一化：小写 + 去空白与常见标点，用于宽松子串匹配 */
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@\[-`{-~！-＠［-｀｛-～、。，．・：；？！（）【】《》“”‘’—…]/g, '');
}

class Blacklist {
  /**
   * @param {{enabled?:boolean, rules?:Array, log?:Function}} [opts]
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.rules = [];
    this.log = opts.log || (() => {});
    this._seq = 1;
    if (Array.isArray(opts.rules)) for (const r of opts.rules) this._hydrate(r);
  }

  _hydrate(r) {
    if (!r || !r.type || r.value == null) return null;
    const rule = {
      id: r.id || `r${this._seq++}`,
      type: r.type,
      value: String(r.value),
      note: r.note || '',
      addedAt: r.addedAt || Date.now(),
    };
    if (r.id) {
      const n = parseInt(String(r.id).replace(/^r/, ''), 10);
      if (Number.isFinite(n) && n >= this._seq) this._seq = n + 1;
    }
    this.rules.push(rule);
    return rule;
  }

  get size() { return this.rules.length; }

  /**
   * 添加规则。同类型同值视为重复，直接返回旧规则（避免刷出一堆重复项）。
   */
  add({ type, value, note = '' } = {}) {
    if (!RULE_TYPES.includes(type)) return { ok: false, msg: `规则类型必须是 ${RULE_TYPES.join(' / ')} 之一` };
    const v = String(value == null ? '' : value).trim();
    if (!v) return { ok: false, msg: '规则值不能为空' };

    const dup = this.rules.find((r) => r.type === type && (type === 'song' || type === 'bvid' ? r.value === v : norm(r.value) === norm(v)));
    if (dup) return { ok: true, rule: dup, duplicate: true, msg: '该规则已存在' };

    const rule = { id: `r${this._seq++}`, type, value: v, note, addedAt: Date.now() };
    this.rules.push(rule);
    this.log(`[blacklist] 新增规则 ${type}=${v}`);
    return { ok: true, rule };
  }

  /** 按 id 删除 */
  remove(id) {
    const i = this.rules.findIndex((r) => r.id === id);
    if (i < 0) return { ok: false, msg: '规则不存在' };
    const [removed] = this.rules.splice(i, 1);
    return { ok: true, rule: removed };
  }

  clear() {
    const n = this.rules.length;
    this.rules = [];
    return { ok: true, count: n };
  }

  list() {
    return { enabled: this.enabled, total: this.rules.length, rules: this.rules.map((r) => ({ ...r })) };
  }

  /**
   * 检查一个曲目。返回第一条命中的规则。
   * @returns {{blocked:boolean, rule?:object, why?:string}}
   */
  check(song) {
    if (!this.enabled || !song || !this.rules.length) return { blocked: false };

    const title = norm(song.name || song.title || '');
    const artists = norm((song.artists || []).join(' ') + ' ' + (song.artistText || ''));
    const id = song.id != null ? String(song.id) : '';
    const bvid = song.bvid ? String(song.bvid) : '';

    for (const r of this.rules) {
      if (r.type === 'song' && id && r.value === id) return { blocked: true, rule: r, why: '歌曲在黑名单' };
      if (r.type === 'bvid' && bvid && r.value.toLowerCase() === bvid.toLowerCase()) return { blocked: true, rule: r, why: '视频在黑名单' };
      if (r.type === 'keyword' && title && title.includes(norm(r.value))) return { blocked: true, rule: r, why: `标题命中关键词「${r.value}」` };
      if (r.type === 'artist' && artists && artists.includes(norm(r.value))) return { blocked: true, rule: r, why: `歌手命中「${r.value}」` };
    }
    return { blocked: false };
  }

  /** 点歌关键词的预检：在搜索之前就挡掉，省一次网络请求，也避免脏词进队列 */
  checkKeyword(keyword) {
    if (!this.enabled) return { blocked: false };
    const k = norm(keyword);
    if (!k) return { blocked: false };
    for (const r of this.rules) {
      if (r.type === 'keyword' && k.includes(norm(r.value))) {
        return { blocked: true, rule: r, why: `关键词命中「${r.value}」` };
      }
    }
    return { blocked: false };
  }

  /**
   * 过滤一批曲目（歌单导入用）。
   * @returns {{kept:Array, blocked:Array<{song:object, rule:object, why:string}>}}
   */
  filter(songs) {
    const kept = [];
    const blocked = [];
    for (const s of songs || []) {
      const c = this.check(s);
      if (c.blocked) blocked.push({ song: s, rule: c.rule, why: c.why });
      else kept.push(s);
    }
    return { kept, blocked };
  }

  toJSON() {
    return { enabled: this.enabled, rules: this.rules.map((r) => ({ ...r })) };
  }
}

module.exports = { Blacklist, RULE_TYPES, norm };
