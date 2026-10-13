/**
 * 动态音量决策对拍（只测 src/shared/auto-gain.js 的数学，不需要浏览器、不联网络）
 *
 *   node tools/agc.check.js
 *
 * 断言值全部来自需求，不是从实现里抄的常量：
 * 目标 −16 dBFS、死区 ±3 dB、增益上限 +12 dB、输出峰值天花板 −1 dBFS。
 * 所以这份脚本同时是"需求是否被实现"的检查，而不是"实现是否等于自己"的同义反复。
 */
const path = require('path');
const AG = require(path.join(__dirname, '..', 'src', 'shared', 'auto-gain.js'));

let fail = 0;
function check(name, cond, extra) {
  console.log((cond ? '✓' : '✗') + ' ' + name + (extra ? '   ' + extra : ''));
  if (!cond) fail++;
}
const lin = (db) => Math.pow(10, db / 20);

// 1) 明显偏小：-24 dBFS → 一次校正到目标附近
{
  const ag = AG.create({ targetDb: -16, deadbandDb: 3, maxGainDb: 12, ceilingDb: -1 });
  const r = ag.decide({ rms: lin(-24), peak: lin(-20) });
  check('偏小 -24dBFS → 增益 +8dB（一次到位）', Math.abs(r.gainDb - 8) < 0.01, 'gain=' + r.gainDb.toFixed(2));
  check('偏小 -24dBFS → 输出回到 -16dBFS', Math.abs(r.outDb - (-16)) < 0.01, 'out=' + r.outDb.toFixed(2));
  check('偏小 -24dBFS → 报 inBand', r.inBand === true);
  check('偏小 -24dBFS → 走"慢释放"', r.tauMs === ag.cfg.releaseMs, 'tau=' + r.tauMs);
}

// 2) 明显偏大：-5 dBFS → 压下去（且峰值天花板不误伤）
{
  const ag = AG.create({ targetDb: -16 });
  const r = ag.decide({ rms: lin(-5), peak: lin(-1) });
  check('偏大 -5dBFS → 增益 -11dB（一次到位）', Math.abs(r.gainDb - (-11)) < 0.01, 'gain=' + r.gainDb.toFixed(2));
  check('偏大 -5dBFS → 输出回到 -16dBFS', Math.abs(r.outDb - (-16)) < 0.01, 'out=' + r.outDb.toFixed(2));
  check('偏大 -5dBFS → 走"快攻击"', r.tauMs === ag.cfg.attackMs, 'tau=' + r.tauMs);
}

// 3) 上限 +12dB：-30dBFS 顶到头，输出仍差 2dB（落在死区内，算达标）
{
  const ag = AG.create({ targetDb: -16, maxGainDb: 12 });
  const r = ag.decide({ rms: lin(-30), peak: lin(-26) });
  check('极安静 -30dBFS → 增益被夹在上限 +12dB', Math.abs(r.gainDb - 12) < 0.01, 'gain=' + r.gainDb.toFixed(2));
  check('极安静 -30dBFS → 输出 -18dBFS（差 2dB，落在死区内）', Math.abs(r.outDb - (-18)) < 0.01 && r.inBand === true);
}

// 4) 峰值天花板优先于目标：源峰 -2dBFS 时最多只能给 +1dB
{
  const ag = AG.create({ targetDb: -16, ceilingDb: -1 });
  const r = ag.decide({ rms: lin(-20), peak: lin(-2) });
  check('峰值受限 → 增益被压到 +1dB（-1 - (-2)）', Math.abs(r.gainDb - 1) < 0.01, 'gain=' + r.gainDb.toFixed(2));
  check('峰值受限 → 输出峰值不超天花板', r.peakDb + r.gainDb <= -1 + 1e-9, 'peakOut=' + (r.peakDb + r.gainDb).toFixed(2));
}

// 5) 死区：偏差 ≤3dB 时保持上一次的校正，不动（避免来回抖）
{
  const ag = AG.create({ targetDb: -16, deadbandDb: 3 });
  ag.decide({ rms: lin(-24), peak: lin(-20) });            // 建立 +8dB
  const r = ag.decide({ rms: lin(-17), peak: lin(-14) });  // 偏差 +1dB（在死区内）
  check('死区内不动：仍保持 +8dB', Math.abs(r.gainDb - 8) < 0.01, 'gain=' + r.gainDb.toFixed(2));
}

// 6) 静音/间隙：低于 minRms 不追，增益保持不变（避免把底噪抬起来）
{
  const ag = AG.create({ targetDb: -16 });
  ag.decide({ rms: lin(-30), peak: lin(-26) });            // +12dB
  const r = ag.decide({ rms: lin(-70), peak: lin(-66) });
  check('静音段不追：增益仍是 +12dB', Math.abs(r.gainDb - 12) < 0.01, 'gain=' + r.gainDb.toFixed(2));
  check('静音段报 live=false、电平为 —', r.live === false && !Number.isFinite(r.srcDb));
}

// 7) reset：增益归 1（0dB）
{
  const ag = AG.create({ targetDb: -16 });
  ag.decide({ rms: lin(-24), peak: lin(-20) });
  ag.reset();
  check('reset 后增益回到 0dB', ag.state().gainDb === 0);
}

// 8) 目标可设：setTarget 夹在 -40~0
{
  const ag = AG.create({});
  check('setTarget(-23) 生效', ag.setTarget(-23) === -23);
  check('setTarget(-99) 夹到 -40', ag.setTarget(-99) === -40);
  check('setTarget(5) 夹到 0', ag.setTarget(5) === 0);
}

// 9) capped：增益被上限/天花板拦住且**没进死区**时要能报出来
//    起因是用户 2026-10-13 的反馈"选中动态之后增益一直是 +12dB" ——
//    界面拿到 capped=true 才能显示"（已达上限）"，而不是让人以为它在正常工作。
{
  const ag = AG.create({ targetDb: -16, maxGainDb: 12 });
  const r = ag.decide({ rms: lin(-35), peak: lin(-31) });
  check('源 -35dBFS → 增益夹在 +12dB、输出 -23dBFS（差 7dB）',
    Math.abs(r.gainDb - 12) < 0.01 && Math.abs(r.outDb - (-23)) < 0.01, 'out=' + r.outDb.toFixed(2));
  check('源 -35dBFS → capped=true（顶到上限且超出死区）', r.capped === true);
}
{
  const ag = AG.create({ targetDb: -16, ceilingDb: -1 });
  const r = ag.decide({ rms: lin(-20), peak: lin(-1) });
  check('峰值顶到天花板 → 增益 0dB、capped=true',
    Math.abs(r.gainDb) < 0.01 && r.capped === true, 'gain=' + r.gainDb.toFixed(2));
}
{
  const ag = AG.create({ targetDb: -16 });
  const r = ag.decide({ rms: lin(-24), peak: lin(-20) });
  check('正常校正到位 → capped=false（别白吓人）', r.capped === false);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
