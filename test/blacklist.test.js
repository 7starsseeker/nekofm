/**
 * 黑名单 / 审核 与 歌单导入 测试
 * ================================
 * 纯逻辑部分不联网；集成部分用真实歌单（热歌榜）验证：
 *   「导入 → 记入已导入列表 → 关键词规则命中 → 被过滤 → 点歌被拒 → 清理队列」
 */
'use strict';


/**
 * ⚠️ **测试隔离（2026-09-26 加）：把数据目录锁到临时目录。**
 *
 * 为什么必须加：`configPath()` 在没设 `NEKOFM_DATA` 时会回落到
 * **`<程序目录>/data`**，也就是用户真实的配置与缓存目录。
 * 这些测试会往里写缓存、封面，最后还调 `engine.cache.clear()` ——
 * **等于每跑一次测试就把用户的真实缓存清空**（实测发生过：T 盘 data/cache
 * 里 ~20MB 音频被测试抹掉了）。测试跑完不该动用户任何东西。
 */
process.env.NEKOFM_DATA = require('node:path').join(require('node:os').tmpdir(), 'nekofm-data-blacklist');
// 每轮从**干净**的数据目录开始：否则上一轮落盘的歌词/音频缓存会在本轮被命中，
// 让"来源=缓存"这类断言和预期的"来源=netease-match"对不上（实测踩到）
require('node:fs').rmSync(process.env.NEKOFM_DATA, { recursive: true, force: true });


const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { Blacklist, norm } = require('../src/core/blacklist');
const { Engine } = require('../src/main/engine');
const { AppServer } = require('../src/main/server');
const { createCommandHandler } = require('../src/main/commands');
const { DEFAULT_CONFIG, deepMerge } = require('../src/core/config');

const PORT = 37903;
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { console.log(`  ✅ ${n}${extra ? ' → ' + extra : ''}`); pass++; }
  else { console.log(`  ❌ ${n}${extra ? ' → ' + extra : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const song = (id, name, artists = ['某歌手'], extra = {}) => ({ source: 'netease', id, name, title: name, artists, artistText: artists.join('/'), ...extra });

console.log('== 1) 黑名单纯逻辑 ==');
{
  const bl = new Blacklist({ enabled: true });

  ok('添加歌曲 ID 规则', bl.add({ type: 'song', value: '12345' }).ok);
  ok('同值重复添加被识别', bl.add({ type: 'song', value: '12345' }).duplicate === true);
  ok('非法类型被拒', bl.add({ type: 'nope', value: 'x' }).ok === false);
  ok('空值被拒', bl.add({ type: 'keyword', value: '   ' }).ok === false);

  bl.add({ type: 'keyword', value: '鬼叫' });
  bl.add({ type: 'artist', value: '某被封杀的歌手' });
  bl.add({ type: 'bvid', value: 'BV1xx411c7mD' });

  ok('歌曲 ID 精确命中', bl.check(song(12345, '随便什么歌')).blocked);
  ok('不同 ID 不误伤', !bl.check(song(99999, '正常歌曲')).blocked);
  ok('标题关键词子串命中', bl.check(song(1, '这首有点鬼叫的感觉')).blocked);
  ok('歌手命中', bl.check(song(2, '正常歌名', ['某被封杀的歌手'])).blocked);
  ok('BV 号命中', bl.check({ source: 'bilibili', bvid: 'BV1xx411c7mD', name: '视频' }).blocked);

  ok('归一化：空格标点不影响匹配', bl.check(song(3, '鬼 叫！！！')).blocked);
  ok('归一化函数可用', norm('  Hello， World!  ') === 'helloworld');
  ok('英文大小写不敏感', (() => { const b2 = new Blacklist({ enabled: true }); b2.add({ type: 'keyword', value: 'lemon' }); return b2.check(song(4, 'Lemon')).blocked; })());

  ok('点歌关键词预检命中', bl.checkKeyword('来一首鬼叫').blocked);
  ok('点歌关键词预检放行', !bl.checkKeyword('孤勇者').blocked);

  const f = bl.filter([song(12345, 'A'), song(500, '正常'), song(501, '也有鬼叫')]);
  ok('批量过滤：保留 ' + f.kept.length + ' / 拦截 ' + f.blocked.length, f.kept.length === 1 && f.blocked.length === 2);

  ok('停用后全部放行', (() => { bl.enabled = false; return !bl.check(song(12345, 'A')).blocked; })());
  bl.enabled = true;

  const listed = bl.list();
  ok('列表输出含条数', listed.total === 4 && listed.rules.length === 4);
  ok('按 id 删除', bl.remove(listed.rules[0].id).ok && bl.size === 3);
  ok('删除不存在的 id 报错', bl.remove('nope').ok === false);

  const json = bl.toJSON();
  const bl2 = new Blacklist({ enabled: json.enabled, rules: json.rules });
  ok('持久化往返一致', bl2.size === bl.size && bl2.check(song(2, '正常歌名', ['某被封杀的歌手'])).blocked);
  ok('清空', bl.clear().ok && bl.size === 0);
}

console.log('\n== 2) 歌单 ID 解析 ==');
(async () => {
  const { NeteaseClient } = require('../src/core/netease/client');
  const nc = new NeteaseClient();

  const r1 = await nc.resolvePlaylistId('3778678');
  ok('纯数字', r1.ok && r1.id === '3778678', r1.via);
  const r2 = await nc.resolvePlaylistId('https://music.163.com/playlist?id=3778678');
  ok('网页链接', r2.ok && r2.id === '3778678', r2.via);
  const r3 = await nc.resolvePlaylistId('https://music.163.com/#/playlist?id=3778678&userid=1');
  ok('带 hash 的链接', r3.ok && r3.id === '3778678', r3.via);
  const r4 = await nc.resolvePlaylistId('https://music.163.com/playlist/3778678/x');
  ok('带路径的链接', r4.ok && r4.id === '3778678', r4.via);
  const r5 = await nc.resolvePlaylistId('随便一串中文');
  ok('无法识别的输入如实报错', !r5.ok && !!r5.msg, r5.msg);

  console.log('\n== 3) 引擎集成：导入 → 过滤 → 拦截 ==');
  const DATA = path.join(os.tmpdir(), 'nekofm-bl-test');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const cfg = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), { server: { port: PORT }, local: { dirs: [] } });
  const engine = new Engine({ config: cfg, log: () => {} });
  const server = new AppServer({
    port: PORT, host: '127.0.0.1',
    rendererDir: path.join(__dirname, '..', 'src', 'renderer'),
    sharedDir: path.join(__dirname, '..', 'src', 'shared'),
    getState: () => engine.state(),
    getLyrics: () => engine.lyricsPayload(),
    onCommand: createCommandHandler({ engine, saveConfig: () => {}, hooks: {} }),
    log: () => {},
  });
  const port = await server.start();
  engine.serverBase = `http://127.0.0.1:${port}`;

  // --- 先导入一个小歌单，拿到真实曲目名
  const imp = await engine.importPlaylist({ input: '3778678', limit: 10, autoQueue: false });
  ok('导入歌单成功', imp.ok, imp.ok ? `《${imp.playlist.name}》${imp.playlist.fetched} 首` : imp.msg);
  ok('已写入已导入列表', (engine.config.playlists.imported || []).some((p) => p.id === '3778678'));
  ok('返回了曲目数据', Array.isArray(imp.tracks) && imp.tracks.length > 0, `${imp.tracks.length} 首`);

  const victim = imp.tracks[0];
  console.log(`     目标曲目：《${victim.name}》/ ${victim.artistText}`);

  // --- 用真实曲名建一条关键词规则，再导入一次，应当被过滤掉
  engine.blacklist.enabled = true;
  engine.blacklist.add({ type: 'keyword', value: victim.name, note: '测试用关键词' });
  const imp2 = await engine.importPlaylist({ input: '3778678', limit: 10, autoQueue: false });
  ok('再次导入时被黑名单过滤', imp2.ok && imp2.blockedCount >= 1,
    `拦下 ${imp2.blockedCount} 首${imp2.blockedPreview.length ? '，如 ' + imp2.blockedPreview[0].name : ''}`);
  ok('过滤后曲目数减少', imp2.tracks.length === imp.tracks.length - imp2.blockedCount,
    `${imp.tracks.length} → ${imp2.tracks.length}`);

  // --- 点歌该曲目：应被拒
  const before = engine.queue.length;
  const rej = await engine.orderByKeyword(victim.name, 'netease', { uid: '1', uname: '测试', isAnchor: true });
  ok('被拉黑的曲目点歌被拒', rej && rej.ok === false && rej.reason === 'blacklisted',
    rej && (rej.msg || rej.reason));
  ok('没有进入队列', engine.queue.length === before, `队列 ${before} → ${engine.queue.length}`);
  ok('观众能看到拒绝原因', engine.notices.some((n) => /不能点|不能播/.test(n.text)), (engine.notices[0] || {}).text);
  ok('拦截计入统计', engine.stats.blocked >= 1, `blocked=${engine.stats.blocked}`);

  // --- 关键词预检：不该发起搜索（用怪词也应立即被拒）
  const rej2 = await engine.orderByKeyword(victim.name + ' 随便加个后缀', 'netease', { uid: '2', uname: '测试2', isAnchor: true });
  ok('关键词预检在搜索前就拦下', rej2 && rej2.reason === 'blacklisted', rej2 && rej2.reason);
  ok('两处拦截的返回结构一致',
    rej && rej2 && Object.keys(rej).sort().join() === Object.keys(rej2).sort().join(),
    Object.keys(rej || {}).sort().join(','));
  ok('拦截统计已累加', engine.stats.blocked >= 2, `blocked=${engine.stats.blocked}`);

  // --- 拉黑当前曲目（用 id 规则）
  engine.track = song(88888, '临时曲目');
  const blk = engine.blockTrack(engine.track);
  ok('一键拉黑当前曲目', blk.ok && blk.rule.type === 'song' && blk.rule.value === '88888', blk.rule && blk.rule.type);
  engine.blacklist.enabled = false;
  engine.blacklist.remove(blk.rule.id);

  // --- 手动塞入违规曲目 → 清理队列
  engine.blacklist.enabled = true;
  engine.queue.clear();
  engine.queue.push(song(victim.id, victim.name, [victim.artistText]), { uid: 'x', uname: '手动', isAnchor: true });
  const good = imp.tracks[1] || song(999, '正常歌曲');
  engine.queue.push(good, { uid: 'y', uname: '手动', isAnchor: true });
  ok('队列里塞入了一首违规曲', engine.queue.length === 2, `队列 ${engine.queue.length}`);
  const purged = createCommandHandler({ engine, saveConfig: () => {}, hooks: {} });
  const pr = await purged({ action: 'blacklistPurgeQueue' });
  ok('清理队列中的违规曲目', pr.ok && pr.removed === 1, `清除 ${pr.removed} 首，剩余 ${engine.queue.length}`);

  // --- 配置同步与持久化
  const synced = engine.syncBlacklistToConfig();
  ok('黑名单可同步进配置', synced && Array.isArray(synced.rules) && synced.enabled === true, `${synced.rules.length} 条`);
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(engine.config, null, 2));
  const reloaded = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
  const engine2 = new Engine({ config: deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), reloaded), log: () => {} });
  ok('重启后黑名单仍在', engine2.blacklist.size === engine.blacklist.size, `${engine2.blacklist.size} 条`);
  ok('重启后已导入歌单仍在', (engine2.config.playlists.imported || []).length >= 1);

  // --- 状态输出包含新字段
  const st = engine.state();
  ok('状态里带 blacklist', !!st.blacklist && typeof st.blacklist.total === 'number');
  ok('状态里带 playlists', Array.isArray(st.playlists));

  await server.stop();
  fs.rmSync(DATA, { recursive: true, force: true });

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
