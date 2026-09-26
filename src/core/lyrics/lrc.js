/**
 * 歌词解析引擎
 * ============
 * 统一处理三类歌词源，输出同一条时间轴：
 *
 *   1. 标准 LRC            `[mm:ss.xxx]文本`（支持一行多标签、元信息标签、[offset:] 校正）
 *   2. 增强 LRC（行内逐字） `<mm:ss.xx>字<mm:ss.xx>字`
 *   3. 网易云 yrc（逐字）   两种形态都存在，都要吃：
 *        a) `[行起ms,行长ms](字起ms,字长ms,0)字(字起ms,字长ms,0)字…`
 *        b) `{"t":0,"c":[{"tx":"字"},{"tx":"字"}]}`（每行一个 JSON，整体为逐字行）
 *
 * 输出统一结构（歌词行）：
 *   {
 *     time:   行开始时间（秒）
 *     end:    行结束时间（秒）
 *     text:   原文
 *     trans:  翻译（可空）
 *     roma:   罗马音（可空）
 *     words:  [{ t: 相对行首秒, d: 时长秒, text }]  —— 逐字，可空数组
 *     karaoke: 'word' | 'line' | 'plain'   —— 本行的逐字能力等级
 *   }
 *
 * 三级降级原则：逐字(word) → 整行渐变(line) → 纯高亮(plain)。
 * 渲染层只需看 karaoke 字段决定画法，不必关心数据来自哪个源。
 */

'use strict';

/** `[00:12.34]` / `[00:12.345]` / `[0:12]` → 秒 */
const LRC_TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
/** 元信息 `[ti:xxx]` */
const META_RE = /^\[(ti|ar|al|by|offset|length|re|ve):(.*)\]$/i;
/** 增强 LRC 行内时间标签 `<00:12.34>` */
const WORD_TAG_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/** 毫秒串（无小数点）归一化：`12` → 0.12s、`123` → 0.123s、`12.3` → 0.123s */
function fracToSeconds(frac) {
  if (frac == null || frac === '') return 0;
  const s = String(frac);
  if (s.includes('.')) return parseFloat('0.' + s.split('.').pop());
  return parseInt(s.padEnd(3, '0').slice(0, 3), 10) / 1000;
}

function toSeconds(min, sec, frac) {
  return parseInt(min, 10) * 60 + parseInt(sec, 10) + fracToSeconds(frac);
}

function norm(text) {
  return String(text == null ? '' : text).replace(/\r/g, '').trim();
}

/**
 * 解析标准 LRC / 增强 LRC。
 * @returns {{meta: Object, lines: Array<{time:number,text:string,words:Array}>}}
 */
function parseLrc(raw) {
  const meta = {};
  const lines = [];
  if (!raw) return { meta, lines };

  for (const rawLine of String(raw).replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // 元信息行
    const m = line.match(META_RE);
    if (m) {
      meta[m[1].toLowerCase()] = m[2].trim();
      continue;
    }

    // 收集本行所有时间标签；无标签则跳过（网易云有纯文本版权行）
    LRC_TIME_RE.lastIndex = 0;
    const times = [];
    let lastEnd = 0;
    let tm;
    while ((tm = LRC_TIME_RE.exec(line)) !== null) {
      times.push(toSeconds(tm[1], tm[2], tm[3]));
      lastEnd = LRC_TIME_RE.lastIndex;
    }
    if (!times.length) continue;

    const body = line.slice(lastEnd).trim();

    // 行内逐字标签（增强 LRC）
    const words = [];
    if (body.includes('<')) {
      WORD_TAG_RE.lastIndex = 0;
      const marks = [];
      let wm;
      while ((wm = WORD_TAG_RE.exec(body)) !== null) {
        marks.push({ idx: wm.index, end: WORD_TAG_RE.lastIndex, time: toSeconds(wm[1], wm[2], wm[3]) });
      }
      for (let i = 0; i < marks.length; i++) {
        const text = body.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].idx : undefined);
        if (text) words.push({ absTime: marks[i].time, text });
      }
    }

    // 行内逐字标签本身不是歌词内容，正文需用拼接后的纯文本替换
    const plainText = words.length ? words.map((w) => w.text).join('').trim() : body;

    for (const t of times) {
      lines.push({ time: t, text: plainText, words: words.length ? words.map((w) => ({ ...w })) : [] });
    }
  }

  // [offset:+500] 表示整体提前 500ms
  const off = parseFloat(meta.offset);
  if (Number.isFinite(off) && off !== 0) {
    for (const l of lines) {
      l.time -= off / 1000;
      for (const w of l.words) w.absTime -= off / 1000;
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return { meta, lines };
}

/**
 * 解析网易云 yrc（逐字）。
 * 两种形态都能吃：括号形态 + JSON 形态。
 * @returns {Array<{time:number,duration:number,text:string,words:Array<{t:number,d:number,text:string}>}>}
 */
function parseYrc(raw) {
  const out = [];
  if (!raw) return out;

  for (const rawLine of String(raw).replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // 形态 b：JSON
    if (line.startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        const words = [];
        let text = '';
        for (const c of obj.c || []) {
          const tx = c.tx == null ? '' : String(c.tx);
          text += tx;
          words.push({ t: 0, d: 0, text: tx });
        }
        out.push({ time: (obj.t || 0) / 1000, duration: 0, text: norm(text), words });
        continue;
      } catch {
        /* 落到括号形态 */
      }
    }

    // 形态 a：`[行起,行长](字起,字长,0)字…`
    const head = line.match(/^\[(\d+),(\d+)\]/);
    if (!head) continue;
    const lineStart = parseInt(head[1], 10);
    const lineDur = parseInt(head[2], 10);
    const rest = line.slice(head[0].length);

    const words = [];
    let text = '';
    const re = /\((\d+),(\d+),(\d+)\)/g;
    let m;
    let lastEnd = 0;
    const segs = [];
    while ((m = re.exec(rest)) !== null) {
      segs.push({ tagStart: m.index, tagEnd: re.lastIndex, start: parseInt(m[1], 10), dur: parseInt(m[2], 10) });
    }
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const segText = rest.slice(seg.tagEnd, i + 1 < segs.length ? segs[i + 1].tagStart : rest.length);
      text += segText;
      words.push({ t: seg.start / 1000, d: seg.dur / 1000, text: segText });
      lastEnd = seg.start + seg.dur;
    }
    // 括号形态下第一个 `(0,0,0)` 是无字前缀的占位，文本从它之后开始
    out.push({
      time: lineStart / 1000,
      duration: (lineDur || lastEnd) / 1000,
      text: norm(text),
      words: words.map((w) => ({ ...w, t: w.t - (words[0] ? words[0].t : 0) })),
    });
  }

  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * 把主歌词（LRC）与各附加轨（翻译 / 罗马音 / 逐字）合并成一条时间轴。
 * 匹配策略：时间差 <= tol 秒即视为同一行；逐字轨优先按时间近似匹配。
 * @param {{lrc?:string, tlyric?:string, romalrc?:string, yrc?:string}} sources
 * @param {{tolerance?:number}} [opts]
 */
function buildTimeline(sources = {}, opts = {}) {
  const tol = opts.tolerance == null ? 0.35 : opts.tolerance;

  const main = sources.lrc ? parseLrc(sources.lrc) : { meta: {}, lines: [] };
  const trans = sources.tlyric ? parseLrc(sources.tlyric).lines : [];
  const roma = sources.romalrc ? parseLrc(sources.romalrc).lines : [];
  const yrc = sources.yrc ? parseYrc(sources.yrc) : [];

  const pick = (arr, t) => {
    let best = null;
    let bestD = Infinity;
    for (const l of arr) {
      const d = Math.abs(l.time - t);
      if (d < bestD) { bestD = d; best = l; }
    }
    return bestD <= tol && best ? best.text : '';
  };

  const lines = [];
  for (const l of main.lines) {
    const k = yrc.find((y) => Math.abs(y.time - l.time) <= tol);
    let words = [];
    let karaoke = 'plain';

    if (k && k.words && k.words.length) {
      // yrc 的逐字文本可能与 LRC 文本略有出入（空格/标点），以 LRC 文本为准做对齐：
      // 若逐字拼接与 LRC 文本一致则直接用，否则退化为整行渐变。
      const joined = k.words.map((w) => w.text).join('').replace(/\s+/g, '');
      const target = String(l.text).replace(/\s+/g, '');
      if (joined === target) {
        words = k.words.map((w) => ({ t: Math.max(0, w.t), d: Math.max(0, w.d), text: w.text }));
        karaoke = 'word';
      } else {
        karaoke = 'line';
      }
    } else if (l.words && l.words.length) {
      const base = l.words[0].absTime;
      words = l.words.map((w) => ({ t: Math.max(0, w.absTime - base), d: 0, text: w.text }));
      karaoke = 'word';
    }

    // 没有逐字数据时，用「下一行起点」补出本行时长 → 渲染层可做整行渐变
    lines.push({
      time: l.time,
      end: Infinity,
      text: l.text,
      trans: pick(trans, l.time),
      roma: pick(roma, l.time),
      words,
      karaoke,
    });
  }

  // 补 end（供整行渐变与预判使用）；末行给一个保守默认时长
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    lines[i].end = next ? next.time : lines[i].time + 6;
    if (lines[i].karaoke === 'word' && lines[i].words.length) {
      const last = lines[i].words[lines[i].words.length - 1];
      const wordEnd = lines[i].time + last.t + (last.d || 0);
      if (wordEnd > lines[i].time) lines[i].end = Math.max(lines[i].end, wordEnd);
    }
  }

  return { meta: main.meta, lines };
}

/**
 * 给定播放进度（秒），返回渲染层需要的一切。
 * 实现**委托给 src/shared/lyric-sync.js** —— 该文件同时被浏览器叠加层加载，
 * 保证服务端与渲染端用的是同一份定位逻辑，不会各写一套导致同步口径不一致。
 */
const lyricSync = require('../../shared/lyric-sync');

function locate(timeline, pos, opts = {}) {
  return lyricSync.locate(timeline, pos, opts);
}

// ------------------------------------------------------------------ 时间轴 → LRC
/**
 * 时间轴 → LRC 文本。用于把在线匹配到的歌词**存成旁车文件**，
 * 下次播放直接读本地，不再联网（顺带绕开网易云限流）。
 *
 * enhanced=true 输出**增强型 LRC**（行内 `<mm:ss.xx>` 逐字时间戳）。
 * 注意：**目前没有调用方用 enhanced=true** —— 旁车歌词只写标准 LRC
 * （`sources/local.js` 传的是 false）。逐字染色下线后没人再需要那份逐字版，
 * 但解析能力留着（读旧 `.karaoke.lrc` 时仍要用），将来要恢复也现成；
 * enhanced=false 输出标准 LRC，兼容其它播放器。两种都会写，见 local.saveLyrics。
 *
 * 翻译不在这里输出：它单独走 `.trans.lrc`，与读取端的约定一致。
 */
function timelineToLrc(timeline, { enhanced = false } = {}) {
  const lines = (timeline && timeline.lines) || [];
  const fmt = (sec) => {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    return `${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
  };
  const out = [];
  for (const ln of lines) {
    if (!ln || typeof ln.time !== 'number') continue;
    const text = (ln.text || '').trim();
    const words = ln.words || [];
    if (enhanced && words.length) {
      out.push(`[${fmt(ln.time)}]` + words
        .map((w) => `<${fmt(ln.time + (w.t || 0))}>${w.text == null ? '' : w.text}`)
        .join(''));
    } else if (text) {
      out.push(`[${fmt(ln.time)}]${text}`);
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

/** 时间轴 → 只含翻译的 LRC（写 `.trans.lrc` 用） */
function timelineToTransLrc(timeline) {
  const lines = (timeline && timeline.lines) || [];
  const fmt = (sec) => {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    return `${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
  };
  const out = [];
  for (const ln of lines) {
    if (!ln || typeof ln.time !== 'number') continue;
    // trans 可能是字符串或对象，两种都容错
    const t = typeof ln.trans === 'string' ? ln.trans : (ln.trans && ln.trans.text) || '';
    if (t.trim()) out.push(`[${fmt(ln.time)}]${t.trim()}`);
  }
  return out.length ? out.join('\n') + '\n' : '';
}

module.exports = {
  parseLrc, parseYrc, buildTimeline, locate, fracToSeconds, lyricSync,
  timelineToLrc, timelineToTransLrc,
};
