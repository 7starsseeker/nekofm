/** 复核：免登录拿到的网易云直链，到底是完整曲目还是 45s 试听片段？
 * 手段：取直链 → 下载 → ffprobe 量真实时长 → 与歌曲元数据 duration 对比。 */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { NeteaseClient } = require('../src/core/netease/client');

const probeDur = (file) => {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration,bit_rate,format_name',
      '-of', 'json', file,
    ], { encoding: 'utf8' });
    return JSON.parse(out).format;
  } catch (e) { return { error: String(e.message).slice(0, 120) }; }
};

(async () => {
  const nc = new NeteaseClient();
  const cases = [
    { label: '免费曲(情非得已童声版)', id: 33894312 },
    { label: 'fee=1(孤勇者)', id: 1901371647 },
    { label: 'fee=1(VIP热歌 海屿你)', id: 1973665667 },
  ];

  for (const c of cases) {
    console.log('\n' + '='.repeat(70));
    console.log(`用例: ${c.label}  id=${c.id}`);
    const det = await nc.songDetail(c.id);
    const meta = det.songs && det.songs[0];
    const u = await nc.songUrl(c.id);
    console.log(`  元数据: fee=${meta && meta.fee} 时长=${meta && meta.duration}s`);
    console.log(`  直链  : ok=${u.ok} fee=${u.fee} br=${u.br} size=${u.size} path=${u.path}`);
    if (!u.ok || !u.url) { console.log('  → 无地址：', u.msg); continue; }

    const isTrial = await (async () => {
      try {
        const acc = await nc._fetch(`https://music.163.com/api/song/enhance/player/url?ids=%5B${c.id}%5D&br=999000`);
        const d = acc.data && acc.data.data && acc.data.data[0];
        return d && d.freeTrialInfo ? d.freeTrialInfo : null;
      } catch { return null; }
    })();
    console.log('  freeTrialInfo =', JSON.stringify(isTrial));

    const tmp = path.join(os.tmpdir(), `ncm_${c.id}.mp3`);
    try {
      const res = await fetch(u.url);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmp, buf);
      const fmt = probeDur(tmp);
      const real = parseFloat(fmt.duration);
      const full = meta && meta.duration;
      const ratio = full ? (real / full) : 0;
      console.log(`  ffprobe: 时长=${fmt.duration}s 码率=${fmt.bit_rate} 容器=${fmt.format_name} 实际字节=${buf.length}`);
      console.log(`  >>> 判定: ${real < 60 && full > 90 ? '⚠ 试听片段(' + real + 's)' : '✅ 完整曲目'}  (完整应为 ${full}s, 实得占比 ${(ratio * 100).toFixed(0)}%)`);
    } catch (e) {
      console.log('  下载/探测失败:', String(e.message).slice(0, 140));
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
