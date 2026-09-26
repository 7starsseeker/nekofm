/**
 * 演示素材（演练模式用）
 * ======================
 * 一套**完全离线**的假曲目 + 假歌词，用来在不放歌、不联网、不开播的情况下
 * 验证整条展示链路：歌词滚动 / 当前行高亮 / 翻译 / 信息栏 / 进度条。
 *
 * 为什么值得单独做一个模块：
 *   调叠加层样式时如果必须"真的放一首歌"，成本太高（要等前奏、要对进度、
 *   要占着音频设备）。演示模式下 `startDemo()` 会驱动虚拟进度，
 *   所有渲染路径与真实播放完全一致，界面上一眼就能看出对不对。
 */
'use strict';

/**
 * 歌词用 **yrc 格式**（带逐字时间戳）。
 *
 * 逐字染色显示已下线（2026-09-26），但**解析路径仍然要在**：真实的网易云歌词
 * 里 yrc 与 LRC 是两条轨、要按时间对齐合并（`lrc.js` 的 `mergeTimeline`），
 * 演示素材走 yrc 才能把这条路径也覆盖到。所以这里保留 yrc 数据，
 * 只是**文案不再宣传逐字染色** —— 演示时画面上看到的是整行高亮。
 */
const DEMO_LRC = [
  '[00:00.00]NekoFM 演示曲目',
  '[00:02.00]这是歌词叠加层演示',
  '[00:07.00]当前行用高亮色强调',
  '[00:12.00]翻译与进度条同时可见',
  '[00:17.00]信息栏显示封面与点歌者',
  '[00:22.00]演示到此结束',
].join('\n');

const DEMO_YRC = [
  '[0,0](0,0,0)NekoFM (0,0,0)演示曲目',
  '[2000,4500](0,500,0)这(500,500,0)是(1000,500,0)歌(1500,500,0)词(2000,500,0)叠(2500,500,0)加(3000,500,0)层(3500,500,0)演(4000,500,0)示',
  '[7000,4500](0,500,0)当(500,500,0)前(1000,500,0)行(1500,500,0)用(2000,500,0)高(2500,500,0)亮(3000,500,0)色(3500,500,0)强(4000,500,0)调',
  '[12000,4500](0,600,0)翻(600,600,0)译(1200,600,0)与(1800,600,0)进(2400,600,0)度(3000,600,0)条(3600,600,0)同(4200,300,0)时可见',
  '[17000,4500](0,600,0)信(600,600,0)息(1200,600,0)栏(1800,600,0)显(2400,600,0)示(3000,600,0)封(3600,600,0)面(4200,300,0)与点歌者',
  '[22000,4000](0,600,0)演(600,600,0)示(1200,600,0)到(1800,600,0)此(2400,600,0)结(3000,600,0)束',
].join('\n');

const DEMO_TLYRIC = [
  '[00:00.00]NekoFM Demo Track',
  '[00:02.00]This is the lyrics overlay demo',
  '[00:07.00]The current line is highlighted',
  '[00:12.00]Translation and progress bar together',
  '[00:17.00]Info bar shows cover and requester',
  '[00:22.00]End of demo',
].join('\n');

const DEMO_DURATION = 27;

/** 内嵌 SVG 封面：不依赖网络，也不占磁盘 */
const DEMO_COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#2bd3ff"/><stop offset="1" stop-color="#14586b"/>'
  + '</linearGradient></defs>'
  + '<rect width="200" height="200" fill="url(#g)"/>'
  + '<circle cx="100" cy="86" r="34" fill="#04121a" opacity="0.75"/>'
  + '<rect x="94" y="120" width="12" height="48" rx="6" fill="#04121a" opacity="0.75"/>'
  + '<text x="100" y="182" font-size="22" text-anchor="middle" fill="#eaf8ff" font-family="sans-serif">DEMO</text>'
  + '</svg>');

/** 演示用假曲目：把信息栏会显示的字段都给齐 */
const DEMO_SONG = {
  source: 'netease',
  id: 'demo-0',
  name: 'NekoFM 演示曲目',
  title: 'NekoFM 演示曲目',
  artists: ['演示歌手'],
  artistText: '演示歌手',
  album: '功能自检专辑',
  duration: DEMO_DURATION,
  cover: DEMO_COVER,
};

const DEMO_REQUESTER = { uid: 'demo', uname: '演示观众' };

module.exports = { DEMO_LRC, DEMO_YRC, DEMO_TLYRIC, DEMO_DURATION, DEMO_SONG, DEMO_COVER, DEMO_REQUESTER };
