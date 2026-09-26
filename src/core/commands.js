/**
 * 弹幕指令解析
 * =============
 * 把一条弹幕文本解析成结构化指令。设计为**完全可配置**，
 * 因为不同直播间的主播习惯差异很大（前缀、别名、是否允许点视频…）。
 *
 * 支持（默认词表，均可在 config 里改）：
 *   点歌 孤勇者            → 搜索并点歌（默认音源）
 *   点歌 网易云 孤勇者      → 指定音源
 *   点歌 b站 孤勇者         → 从 B站搜视频
 *   点播 BV1xx411c7mD       → 直接点 B站 视频/链接
 *   切歌 / 跳过             → 需权限
 *   撤歌 / 删除 <序号>       → 需权限
 *   我的                   → 查自己在队列里的位置
 *   队列 / 歌单             → 查队列
 *   歌词 开/关              → 需权限（控制叠加层显隐）
 *   音量 <0-100>           → 需权限
 */
'use strict';

const DEFAULT_WORDS = {
  order: ['点歌', '点播', '来一首', '点一首'],
  biliOrder: ['点播', '点视频'],
  skip: ['切歌', '跳过', '下一首', 'next'],
  remove: ['撤歌', '删除', '撤销'],
  mine: ['我的', '我的歌', '查询'],
  queue: ['队列', '歌单', '列表', 'queue'],
  lyricToggle: ['歌词'],
  volume: ['音量'],
};

const DEFAULT_SOURCE_ALIAS = {
  网易云: 'netease', 网易: 'netease', 网抑云: 'netease', netease: 'netease',
  b站: 'bilibili', bilibili: 'bilibili', 哔哩哔哩: 'bilibili', 视频: 'bilibili',
  本地: 'local', local: 'local',
};

/**
 * @param {string} text 弹幕原文
 * @param {{words?:object, sourceAlias?:object}} [cfg]
 * @returns {{cmd:string, args:any, raw:string}}
 */
function parseCommand(text, cfg = {}) {
  const words = { ...DEFAULT_WORDS, ...(cfg.words || {}) };
  const alias = { ...DEFAULT_SOURCE_ALIAS, ...(cfg.sourceAlias || {}) };
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { cmd: 'none', args: null, raw };

  // 统一去掉常见前缀噪声：全角空格、"！"、"主播"
  const t = raw.replace(/^[!！。.\s]+/, '');

  /**
   * 2026-09-26 弹幕指令收紧（按用户要求）：
   *   - order 系（点歌 / 点播 / 来一首 / 点一首）：**必须有空格 + 内容**，
   *     没空格紧贴前缀的聊天不算指令。单独的"点歌"也不触发（旧版会被识别
   *     成 keyword='' 然后引擎刷"点歌要带上歌名哦~"）。
   *   - skip 词里**只有"切歌"**要求完全匹配 + 不接任何前后内容
   *     （防止"切歌啊"、"我想切歌"被误判）。其他 skip 别名
   *     （跳过 / 下一首 / next）保留 startsWith + 仅房管可用的旧行为；
   *     新严格语义只针对"切歌"。
   *
   * 实现：order 不走精确匹配分支、强制 startsWith + 空格检查；
   * '切歌' 走精确匹配分支，不许任何前后内容。
   */
  const EXACT_ONLY = new Set(['切歌']);
  const hit = (list, { requireSpace = false } = {}) => {
    for (const w of list) {
      const exactOnly = EXACT_ONLY.has(w);
      if (exactOnly) {
        // 完全匹配两个字符的"切歌"，不接任何前后内容
        if (t === w) return { matched: w, rest: '' };
        continue;
      }
      if (requireSpace) {
        // 点歌系：必须"前缀+空格+内容"，连单独"点歌"都不算
        if (!t.startsWith(w + ' ')) continue;
        return { matched: w, rest: t.slice(w.length).trim() };
      }
      // 其他 skip / remove / mine 等：保留 startsWith + 精确匹配
      if (t === w) return { matched: w, rest: '' };
      if (t.startsWith(w)) return { matched: w, rest: t.slice(w.length).trim() };
    }
    return null;
  };

  /**
   * BV 号：**前缀大小写宽容**。B站自己只认大写 `BV`，但观众手打常写成小写 `bv` ——
   * 旧版严格匹配会让 `bv1NzfNBMEvZ` 整条**被当成聊天忽略**（观众以为点了、其实什么都没发生）。
   * 只规范**前缀**：后 10 位是大小写敏感的 base58，改写它等于把号改错，所以原样带走，
   * 真查不到时由解析层如实报"无法识别/视频不存在"。
   */
  const BV_RE = /[Bb][Vv][0-9A-Za-z]{10}/;
  const AV_RE = /av(\d+)/i;
  const URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)?(?:bilibili\.com|b23\.tv|bili2233\.cn)\/\S+/i;

  // 直接点视频（含 BV 号 / 链接）
  const mUrl = t.match(URL_RE);
  const mBv = t.match(BV_RE);
  const mAv = t.match(AV_RE);
  if (mUrl || mBv || mAv) {
    const target = mUrl ? mUrl[0] : (mBv ? 'BV' + mBv[0].slice(2) : mAv[0]);
    // 前面可能带"点播"等词，这里只看是否属于点播类指令；直接甩 BV 号也认
    return { cmd: 'order_video', args: { target }, raw };
  }

  let r;
  if ((r = hit(words.order, { requireSpace: true }))) {
    if (!r.rest) return { cmd: 'order', args: { source: null, keyword: '' }, raw };
    const parts = r.rest.split(/\s+/);
    const src = alias[parts[0].toLowerCase()] || alias[parts[0]];
    if (src) {
      const keyword = parts.slice(1).join(' ').trim();
      return { cmd: 'order', args: { source: src, keyword }, raw };
    }
    return { cmd: 'order', args: { source: null, keyword: r.rest }, raw };
  }
  if ((r = hit(words.biliOrder))) {
    return { cmd: 'order_video', args: { target: r.rest }, raw };
  }
  if ((r = hit(words.skip))) return { cmd: 'skip', args: null, raw };
  if ((r = hit(words.remove))) return { cmd: 'remove', args: { index: r.rest ? Number(r.rest) || null : null }, raw };
  if ((r = hit(words.mine))) return { cmd: 'mine', args: null, raw };
  if ((r = hit(words.queue))) return { cmd: 'queue', args: null, raw };
  if ((r = hit(words.lyricToggle))) {
    const on = /开|on|显示|true|1/i.test(r.rest);
    const off = /关|off|隐藏|false|0/i.test(r.rest);
    return { cmd: 'lyric_toggle', args: { on: on ? true : off ? false : null }, raw };
  }
  if ((r = hit(words.volume))) {
    const n = parseInt(r.rest, 10);
    return { cmd: 'volume', args: { value: Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null }, raw };
  }
  return { cmd: 'none', args: null, raw };
}

/** 队列动作需要权限的动作集合 */
const PRIVILEGED = new Set(['skip', 'remove', 'lyric_toggle', 'volume']);

module.exports = { parseCommand, DEFAULT_WORDS, DEFAULT_SOURCE_ALIAS, PRIVILEGED };
