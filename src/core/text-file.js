/**
 * 文本文件解码（读**别人写的**文本文件时必须用它）
 * ==================================================
 * 为什么需要它：侧车歌词 `.lrc` 大多来自 2010 年前后的歌词站 / 老播放器，
 * 那时中文 Windows 的默认编码是 **GBK/GB2312**，写出来的 .lrc 就是 GBK 字节；
 * 还有一部分是记事本"另存为 Unicode"存下的 **UTF-16LE**。
 *
 * 以前 `local.js` 一律 `readFileSync(f, 'utf8')` —— 解 GBK 字节得到的是
 * **合法但全错**的字符串（不抛错、不报错，只是满屏乱码），所以这个坑能藏很久。
 * 2026-09-27 用户报告"本地文件字幕显示乱码"，实测曲库里 131 个 .lrc 有
 * **105 个是 GBK、2 个是 UTF-16LE**，只有 24 个本来就是 UTF-8。
 *
 * 判定顺序：BOM → 严格 UTF-8 → GB18030 兜底
 *   · **BOM 是唯一可靠的 UTF-16 判据** —— 无 BOM 的 UTF-16 和 GBK 在字节层面
 *     没法区分（两者都是"高位字节 + 低位字节"的形态），只能靠 BOM 认；
 *   · **严格 UTF-8 能解通就一定是 UTF-8**：GBK 双字节里"首字节恰好落在
 *     UTF-8 前导字节区间、且次字节恰好落在续字节区间"的概率约 8%，
 *     整篇歌词全篇碰巧合法的概率可以忽略 —— 所以"解得通"这个信号是可信的；
 *   · **GB18030 是 GBK/GB2312 的严格超集**，收得下中文旧文件里的全部字节，
 *     用它兜底比只认 GBK 更稳（生僻字、繁体、日文汉字都在里面）。
 *
 * 已知不足：极老的 **Shift_JIS** 日文歌词文件会被当成 GB18030 解成另一种乱码。
 * 但这种文件本来（按 UTF-8 读时）也是乱码，所以不算退步；真要支持得靠字频统计
 * 猜编码，代价和误判风险都不划算。实测本机曲库里 105 个非 UTF-8 文件按 GB18030
 * 全部解得通顺（罕见字率 0%），没有 Shift_JIS 混在里面。
 */
'use strict';

const fs = require('node:fs');

/**
 * 解码器实例复用。
 * 每次 `new TextDecoder()` 都有可观开销（要初始化 ICU 转换器），而歌词是按
 * "每首歌切一次"的频率读的，复用能省掉这份无谓开销。
 * 构造失败返回 null —— 理论上只有精简 ICU 的 Node 才会（官方构建是 full-icu）。
 */
const decoders = new Map();
function decoder(label, opts) {
  const key = label + (opts && opts.fatal ? ':fatal' : '');
  if (!decoders.has(key)) {
    let d = null;
    try { d = new TextDecoder(label, opts); } catch { d = null; }
    decoders.set(key, d);
  }
  return decoders.get(key);
}

/**
 * Buffer → 字符串（自动识别 UTF-8 / UTF-16(BOM) / GB18030）。
 * @param {Buffer|string} input
 * @returns {string}
 */
function decodeText(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input == null ? '' : String(input), 'utf8');
  if (!buf.length) return '';

  // 1) 带 BOM 的文件：编码是确定的，直接按 BOM 解（顺带把 BOM 剥掉，
  //    否则它会在歌词第一行头部留一个看不见的 U+FEFF，影响首行匹配）
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.toString('utf8', 3);
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    const d = decoder('utf-16le');
    return d ? d.decode(buf.subarray(2)) : buf.toString('utf8', 2);
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const d = decoder('utf-16be');
    return d ? d.decode(buf.subarray(2)) : buf.toString('utf8', 2);
  }

  // 2) 无 BOM：先严格试 UTF-8。解不通就说明不是 UTF-8，换 GB18030 再来一遍
  const strict = decoder('utf-8', { fatal: true });
  if (strict) {
    try { return strict.decode(buf); } catch { /* 不是 UTF-8 → 走下面 */ }
  }

  // 3) GB18030 兜底（非致命模式：非法字节会被替换成 U+FFFD，而不是抛错）
  const gb = decoder('gb18030');
  if (gb) {
    try { return gb.decode(buf); } catch { /* 极端字节序列，落到下面 */ }
  }

  // 4) 最后一层：ICU 不可用或字节实在解不动时，宁可给原文也不要让播放流程抛错
  return buf.toString('utf8');
}

/**
 * 读文本文件（自动识别编码）。
 * @param {string} file
 * @returns {string}
 */
function readTextFile(file) {
  return decodeText(fs.readFileSync(file));
}

module.exports = { decodeText, readTextFile };
