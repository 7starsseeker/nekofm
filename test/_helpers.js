/**
 * 测试公用小工具
 * ==============
 * 只放**跨测试文件复用**的东西，避免每个测试各写一份而口径走偏。
 */
'use strict';

const { execFileSync } = require('node:child_process');

/**
 * 探测 `ffmpeg` / `ffprobe` 是否可用。
 *
 * 为什么要探：本地曲库相关的测试要**现场用 ffmpeg 造音频素材**
 * （这样不依赖任何现成的二进制素材，测试永远自洽）。
 * 但 ffmpeg 不是所有人的机器上都有 —— CI 镜像默认就没装。
 * 实测教训：不加这层探测时，缺 ffmpeg 会让整个测试文件**抛异常崩掉**，
 * 表现成"测试失败"，而真相只是"环境不具备"。
 *
 * 口径（与项目其它自检一致）：**环境不具备 = 跳过，不是失败。**
 * 自检工具谎报军情比不报更糟。
 *
 * @returns {{ffmpeg:boolean, ffprobe:boolean, ok:boolean}}
 */
function probeFfmpeg() {
  const has = (cmd) => {
    try {
      execFileSync(cmd, ['-version'], { stdio: 'pipe', timeout: 10000 });
      return true;
    } catch { return false; }
  };
  const ffmpeg = has('ffmpeg');
  const ffprobe = has('ffprobe');
  return { ffmpeg, ffprobe, ok: ffmpeg && ffprobe };
}

/**
 * 整份测试因环境不具备而跳过：打印原因、退出码 0（**不是失败**）。
 * 调用方自己判断条件，这里只负责统一输出与退出。
 */
function skipAllBecause(title, why) {
  console.log('');
  console.log(`⏭️  ${title} 整体跳过：${why}`);
  console.log('   这是「环境不具备」，不是失败。装上 ffmpeg（并提供 ffprobe 在 PATH）后重跑即可。');
  console.log('   跳过项数按 0 计，退出码 0。');
  process.exit(0);
}

module.exports = { probeFfmpeg, skipAllBecause };
