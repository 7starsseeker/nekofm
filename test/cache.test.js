/**
 * 媒体缓存的「收与拒」（2026-10-16）
 * ==================================
 * 需求来源（用户实测 bug）：「勇 者 王 诞 生~外 挂 人 神 话~」显示未缓存、
 * 点补缓存一直缓存不上；同一天另一首 B站视频正常。查下来是 **CDN 把完整的 MP4
 * 标成了 `application/json`**（`upos-sz-mirrorhw`），旧代码只看 content-type
 * 就把它当错误页扔了。所以这里不测"下载"，测的是**那道闸门的判断依据**：
 *
 *   1) 真媒体字节 + 撒谎的 content-type（application/json）→ 必须收下
 *   2) 真错误页（JSON / HTML）→ 必须拒绝，而且报错里要带正文开头（否则没法诊断）
 *   3) 声明了媒体类型但正文是 HTML 错误页 → 也要拒（旧代码会把它当音频存下来）
 *   4) 只拿到部分内容（206 / content-range 不是全长）→ 拒绝，别存半截文件
 *   5) 太小的响应 → 拒绝（错误页兜底）
 *
 * 全程本地起一个 HTTP 服务喂字节，不连外网。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { MediaCache } = require('../src/main/cache');

let pass = 0; let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { console.log(`  ✅ ${n}${extra ? ' → ' + extra : ''}`); pass++; }
  else { console.log(`  ❌ ${n}${extra ? ' → ' + extra : ''}`); fail++; }
};

const ROOT = path.join(os.tmpdir(), 'nekofm-cache-test');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

/** 一个像真 MP4 的开头：box 长度 + `ftyp` + 主品牌 isom */
function mp4Bytes(tail = 8192) {
  const head = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom', 'latin1'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]), Buffer.from('isomiso2mp41', 'latin1'),
  ]);
  return Buffer.concat([head, Buffer.alloc(tail, 0xab)]);
}
/** 一个像真 MP3 的开头：ID3v2 头 */
function mp3Bytes(tail = 8192) {
  return Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(tail, 0x5a)]);
}
const htmlBytes = () => Buffer.from('<!DOCTYPE html><html><head><title>403</title></head><body>'.padEnd(9000, ' '), 'utf8');

const ROUTES = {
  // 真 MP4，但 CDN 谎报成 application/json —— 用户踩到的正是这个
  '/mp4-labeled-json': { body: mp4Bytes(), type: 'application/json' },
  '/mp4-labeled-octet': { body: mp4Bytes(), type: 'application/octet-stream' },
  '/mp4-no-type': { body: mp4Bytes(), type: '' },
  '/mp3-labeled-audio': { body: mp3Bytes(), type: 'audio/mpeg' },
  '/json-error': { body: Buffer.from('{"code":-403,"message":"访问权限不足"}'), type: 'application/json' },
  '/html-error': { body: htmlBytes(), type: 'text/html; charset=utf-8' },
  '/html-error-mislabeled': { body: htmlBytes(), type: 'application/octet-stream' },
  '/tiny': { body: Buffer.from('oops'), type: 'audio/mpeg' },
};

let server = null;
let port = 0;

(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/partial') {
      const body = mp4Bytes();
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes 0-${body.length - 1}/999999`,
        'Content-Length': body.length,
      });
      return res.end(body);
    }
    const r = ROUTES[u.pathname];
    if (!r) { res.writeHead(404); return res.end('nope'); }
    const headers = { 'Content-Length': r.body.length };
    if (r.type) headers['Content-Type'] = r.type;
    res.writeHead(200, headers);
    res.end(r.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  const cacheDir = path.join(ROOT, 'cache');
  const logs = [];
  const cache = new MediaCache({ dir: cacheDir, maxBytes: 512 * 1024 * 1024, log: (m) => logs.push(m) });
  const at = (p) => `http://127.0.0.1:${port}${p}`;

  console.log('\n【1】CDN 撒谎：真 MP4 标成 application/json（用户踩到的那个）');
  {
    const r = await cache.put('bilibili-BVTEST-1', at('/mp4-labeled-json'), { name: '外挂人神话', source: 'bilibili' });
    ok('收下了（不再"非媒体响应"）', r.ok === true, r.ok ? `${(r.size / 1024).toFixed(1)}KB` : r.msg);
    ok('文件落盘且大小与响应一致', !!r.file && fs.existsSync(r.file) && fs.statSync(r.file).size === r.size);
    ok('索引里能查到（下次播放走本地）', !!cache.get('bilibili-BVTEST-1'), String(cache.get('bilibili-BVTEST-1') && cache.get('bilibili-BVTEST-1').size));
    ok('日志里写明了"CDN 标错类型"', logs.some((l) => /标成了 application\/json/.test(l)), logs.slice(-1)[0] || '');
    // 头 12 字节确实是 mp4 魔数（证明存下来的是真文件，不是把 JSON 当音频存了）
    const head = fs.readFileSync(r.file).slice(0, 12);
    ok('存下来的确实是 MP4（ftyp 魔数）', head.toString('latin1', 4, 8) === 'ftyp', head.toString('latin1'));
  }

  console.log('\n【2】正常的两种声明：application/octet-stream / 没有 content-type');
  {
    const a = await cache.put('k-octet', at('/mp4-labeled-octet'), {});
    const b = await cache.put('k-notype', at('/mp4-no-type'), {});
    const c = await cache.put('k-mp3', at('/mp3-labeled-audio'), {});
    ok('octet-stream + MP4 → 收下', a.ok === true, a.msg || '');
    ok('没有 content-type + MP4 魔数 → 收下（靠嗅探）', b.ok === true, b.msg || '');
    ok('audio/mpeg + ID3 → 收下', c.ok === true, c.msg || '');
  }

  console.log('\n【3】真错误页：必须拒，并且报错要带正文开头（否则没法诊断）');
  {
    const a = await cache.put('k-json', at('/json-error'), {});
    ok('JSON 错误页被拒', a.ok === false);
    ok('报错带上了正文开头', /正文开头：\{"code":-403/.test(a.msg || ''), a.msg || '');
    ok('没有留下半截 .part 文件', !fs.readdirSync(cacheDir).some((f) => f.endsWith('.part')), fs.readdirSync(cacheDir).join(','));

    const b = await cache.put('k-html', at('/html-error'), {});
    ok('HTML 错误页被拒', b.ok === false, b.msg || '');
    ok('HTML 也带上了正文开头', /正文开头：<!DOCTYPE html/.test(b.msg || ''), b.msg || '');

    // 旧代码会放行的组合：声明成媒体类型、正文其实是错误页（>4096 骗过"内容过小"那关）
    const c = await cache.put('k-html-mislabeled', at('/html-error-mislabeled'), {});
    ok('声明 octet-stream 的 HTML 错误页也被拒（旧代码会把它当音频存下来）', c.ok === false, c.msg || '');
  }

  console.log('\n【4】只拿到部分内容 → 拒绝（别把半截文件当完整缓存）');
  {
    const r = await cache.put('k-partial', at('/partial'), {});
    ok('206 + content-range 不是全长 → 拒绝', r.ok === false, r.msg || '');
    ok('报错说明了是部分内容', /部分内容/.test(r.msg || ''), r.msg || '');
  }

  console.log('\n【5】兜底：内容过小');
  {
    const r = await cache.put('k-tiny', at('/tiny'), {});
    ok('小于 4KB → 拒绝', r.ok === false, r.msg || '');
  }

  console.log('\n【6】重复调用与并发保护（顺手确认没被这次改动弄坏）');
  {
    const a = await cache.put('bilibili-BVTEST-1', at('/mp4-labeled-json'), {});
    ok('已缓存过的 key 直接返回 skipped=already', a.ok === true && a.skipped === 'already', JSON.stringify(a));
    const inFlight = cache.put('k-concurrent', at('/mp4-labeled-json'), {});
    const second = await cache.put('k-concurrent', at('/mp4-labeled-json'), {});
    ok('同一个 key 正在下时第二个调用不重复下载', second.skipped === 'in-flight', JSON.stringify(second));
    const first = await inFlight;
    ok('第一个调用正常完成', first.ok === true, first.msg || '');
  }

  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n缓存闸门：通过 ${pass} / 失败 ${fail}`);
  if (fail) process.exit(1);
})();
