/**
 * 内置自检中心
 * =============
 * 目标：**程序内的每个功能都能在这里点一下验证**，不需要开播、不需要主播懂命令行。
 *
 * 设计原则：
 *   1) 检查项是**数据**不是代码分支 —— 每项声明 { id, name, net, run() }，
 *      UI 与 CLI 共用同一份清单，不会两边行为不一致。
 *   2) `net: true` 的项会打真实网络/真实接口，默认不跑（用户显式勾选），
 *      避免"点一下自检就触发一堆外部请求"。
 *   3) 每项返回 { ok, detail }，并且**不许抛异常逃逸** —— 抛了就记成失败并留下原因，
 *      自检工具自己崩掉是最没有意义的行为。
 *   4) 演练类（演示叠加层、注入弹幕）不产生外部副作用，随时可跑可停。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseLrc, parseYrc, buildTimeline, locate } = require('../core/lyrics/lrc');
const LyricSync = require('../shared/lyric-sync');
const { parseCommand } = require('../core/commands');
const { Blacklist } = require('../core/blacklist');
const { SongQueue } = require('../core/queue');
const { DEFAULT_CONFIG, deepMerge, configPath } = require('../core/config');
const { neteasePicUrl, repairNeteaseCover, parseJsonExact } = require('../core/netease/client');
const { CSP_POLICY, injectCspMeta } = require('./server');

// ---------------------------------------------------------------- 演示素材
// 统一来自 src/core/demo.js（引擎的演练模式用的是同一份，避免两处漂移）
const { DEMO_SONG, DEMO_DURATION } = require('../core/demo');

// ---------------------------------------------------------------- 工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 判断一个失败是不是"外部服务限流"造成的。
 * NetEase 实测会在密集请求后返回 `code:405 "操作频繁，请稍候再试"`（按 IP 限流，
 * 不同操作系统上同时中招，说明与平台/代码无关）。
 * 这类失败**不该报成"功能坏了"** —— 自检工具谎报军情比不报更糟。
 * 在 run() 里统一判定，所有联网项自动受益，不用逐项包装。
 */
function isRateLimited(v) {
  if (!v) return false;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /操作频繁|请稍候|过于频繁|too many|rate.?limit/i.test(s) || (v && v.code === 405);
}

class SelfTest {
  /**
   * @param {{engine:object, server:object, baseUrl:string, log?:Function}} deps
   */
  constructor(deps) {
    this.engine = deps.engine;
    this.server = deps.server;
    this.baseUrl = deps.baseUrl;
    this.log = deps.log || (() => {});
    this.groups = this._buildGroups();
  }

  listGroups() {
    return this.groups.map((g) => ({
      id: g.id, name: g.name, desc: g.desc,
      checks: g.checks.map((c) => ({ id: c.id, name: c.name, net: !!c.net })),
    }));
  }

  /**
   * 跑检查。
   * @param {{groups?:string[], includeNetwork?:boolean, onResult?:Function}} [opts]
   */
  async run(opts = {}) {
    const want = opts.groups && opts.groups.length ? new Set(opts.groups) : null;
    const includeNet = !!opts.includeNetwork;
    const results = [];
    const t0 = Date.now();

    for (const g of this.groups) {
      if (want && !want.has(g.id)) continue;
      for (const c of g.checks) {
        if (c.net && !includeNet) {
          const row = { group: g.id, groupName: g.name, id: c.id, name: c.name, net: true, ok: null, detail: '已跳过（未勾选联网测试）', ms: 0 };
          results.push(row);
          if (opts.onResult) opts.onResult(row);
          continue;
        }
        const s = Date.now();
        let row;
        try {
          const r = await c.run();
          // 支持三种结果：true / {ok:true|false} / {skip:true}（环境不具备，不算失败）
          const isSkip = !!(r && r.skip);
          let detail = r === true ? '' : ((r && r.detail) || '');
          let okVal = isSkip ? null : (r === true ? true : !!(r && r.ok));
          // 联网项若因**外部服务限流**失败，降级为"跳过"而不是判失败。
          // （实测 NetEase 密集请求后按 IP 返回 code:405「操作频繁」，
          //   不同操作系统同时中招 —— 那是外部状态，不是本程序的功能缺陷。）
          if (okVal === false && c.net && isRateLimited(detail)) {
            okVal = null;
            detail = `⏳ 外部服务限流，本次跳过（原结果：${detail}）`;
          }
          row = {
            group: g.id, groupName: g.name, id: c.id, name: c.name, net: !!c.net,
            ok: okVal, detail, ms: Date.now() - s,
          };
        } catch (e) {
          // 自检项自己崩掉也必须留下可见原因，不能把整个自检带崩
          row = { group: g.id, groupName: g.name, id: c.id, name: c.name, net: !!c.net, ok: false, detail: '异常：' + String((e && e.message) || e), ms: Date.now() - s };
        }
        results.push(row);
        if (opts.onResult) opts.onResult(row);
      }
    }

    const passed = results.filter((r) => r.ok === true).length;
    const failed = results.filter((r) => r.ok === false).length;
    const skipped = results.filter((r) => r.ok === null).length;
    return { ok: failed === 0, passed, failed, skipped, total: results.length, ms: Date.now() - t0, results };
  }

  // ================================================================ 检查清单
  _buildGroups() {
    const e = this.engine;
    const base = this.baseUrl;
    const self = this;

    const json = async (p, init) => {
      const r = await fetch(base + p, init);
      return { status: r.status, body: await r.json().catch(() => null), raw: r };
    };
    const cmd = async (body) => (await json('/api/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).body;

    return [
      // ---------------------------------------------------------- 基础
      {
        id: 'basic', name: '基础与配置', desc: '数据目录、配置读写、服务可用性',
        checks: [
          { id: 'dataDir', name: '数据目录可写', run: () => {
            const d = configPath().dir;
            fs.mkdirSync(d, { recursive: true });
            const f = path.join(d, '.selftest.tmp');
            fs.writeFileSync(f, 'ok'); const t = fs.readFileSync(f, 'utf8'); fs.unlinkSync(f);
            return { ok: t === 'ok', detail: d };
          } },
          { id: 'configRoundtrip', name: '配置合并与默认值', run: () => {
            const merged = deepMerge(DEFAULT_CONFIG, { server: { port: 12345 }, overlay: { infoBar: { position: 'top-right' } } });
            const ok = merged.server.port === 12345
              && merged.overlay.infoBar.position === 'top-right'
              && merged.overlay.infoBar.showCover === DEFAULT_CONFIG.overlay.infoBar.showCover
              && merged.overlay.fontSize === DEFAULT_CONFIG.overlay.fontSize;
            return { ok, detail: ok ? '嵌套合并未冲掉其它默认值' : '深合并丢字段' };
          } },
          { id: 'dataNotInHome', name: '数据目录跟随程序目录', run: () => {
            // 真正要保证的是"数据跟着程序走"，而不是字面上的"不在主目录"——
            // 开发时程序本身就在主目录下，硬卡主目录会误报。
            const { appRoot } = configPath();
            const d = path.resolve(configPath().dir);
            const inside = d === path.resolve(appRoot) || d.startsWith(path.resolve(appRoot) + path.sep);
            return {
              ok: inside || !!process.env.NEKOFM_DATA,
              detail: `数据目录 ${d}（程序目录 ${appRoot}）${inside ? '，不写系统用户目录' : ''}`,
            };
          } },
          { id: 'port', name: 'HTTP 服务已监听', run: () => ({ ok: !!self.server.boundPort, detail: base }) },

          /**
           * 源码级绊线：**B站缓存键的口径**。
           *
           * 为什么值得钉住：缓存键是 `bilibili-<bvid>-<cid>`，而 cid 只在部分入口
           * （点播 BV 号）天然带着 —— "关键词点歌"进来的是没有 cid 的。一旦有谁把
           * "补 cid"挪到"算缓存键"之后就退化成两套键、同一视频存两份、互相不命中
           * （2026-09-26 实测踩过：17.3MB × 2，用户报告"缓存一直缓存不上"）。
           */
          { id: 'biliCacheKey', name: 'B站缓存键口径：先补 cid 再算键（源码级绊线）', run: () => {
            const src = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
            /**
             * 只看 `resolveStream` 的函数体**内部**顺序。
             *
             * 为什么不能直接全文 `indexOf` 比大小：`load()` 里也有一处
             * `cache.keyFor(song)`，它在 `await streamPromise` **之后**（那时 cid 已经补好了），
             * 但文本位置在 `resolveStream` 之前 —— 全文比大小会误报。
             */
            const a = src.indexOf('async resolveStream(song) {');
            const b = src.indexOf('async resolveLyrics(song) {');
            const body = a >= 0 ? src.slice(a, b > a ? b : undefined) : '';
            const iEnsure = body.indexOf('_ensureBiliCid(song)');
            const iKey = body.indexOf('const ck = this.cache.keyFor(song)');
            const orderOk = iEnsure > 0 && iKey > iEnsure;
            // 补 cid 的调用点至少两处：resolveStream（取流）+ cacheFetch（手动缓存）
            const calls = (src.match(/await this\._ensureBiliCid\(song\)/g) || []).length;
            const hasAdopt = /cache\.adopt\(/.test(src);
            return {
              ok: orderOk && calls >= 2 && hasAdopt,
              detail: `取流内「补 cid 先于算键」=${orderOk}；补 cid 调用点=${calls}（需 ≥2）；旧键条目认领=${hasAdopt}`,
            };
          } },

          /** 源码级绊线：B站会话必须用自己的 partition，不能和网易云共用一个（登录态会串） */
          { id: 'biliSessionPartition', name: 'B站会话与网易云会话隔离（源码级绊线）', run: () => {
            let src = '';
            try { src = fs.readFileSync(path.join(__dirname, '..', 'core', 'bilibili', 'browser.js'), 'utf8'); }
            catch { return { ok: false, detail: 'core/bilibili/browser.js 读不到' }; }
            const own = /persist:nekofm-bilibili/.test(src);
            const leaked = /persist:nekofm-netease/.test(src);
            return { ok: own && !leaked, detail: `独立 partition=${own}；误用网易云 partition=${leaked}` };
          } },

          /**
           * 源码级绊线：**叠加层的播放位置必须直接用上报值，不得再本地外推**。
           *
           * 为什么钉它：这个坑犯过**两次** ——
           *   1) 控制台歌词条：外推导致换行点闪回（当时的修法就是改成不外推）；
           *   2) 叠加层：同一个根因，但只改了歌词条、叠加层漏了，用户报"高亮行偏了、依然闪烁"。
           * 根因是两条时间线频率不同：`position` 由播放核心 **5Hz** 上报，状态广播 **10Hz** ——
           * 同一个位置被推两次、serverTime 每次都是新的，于是外推值在每个广播周期里
           * 先推进、再被新快照拉回去（实测 20 秒倒退 10 次，正好每次换行一次）。
           */
          { id: 'overlayNoExtrapolate', name: '叠加层位置不得本地外推（源码级绊线）', run: () => {
            let src = '';
            try { src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'assets', 'overlay.js'), 'utf8'); }
            catch { return { ok: false, detail: '读不到 renderer/assets/overlay.js' }; }
            const a = src.indexOf('function currentPosition()');
            const b = src.indexOf('function buildWindow(');
            const body = a >= 0 ? src.slice(a, b > a ? b : a + 900) : '';
            // 只检查**代码行**：注释里会引用这个旧写法（当作"为什么改掉"的说明），不能算违规
            const code = body.split('\n')
              .filter((l) => { const t = l.trim(); return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
              .join('\n');
            const usesInterp = /LyricSync\.interpolate\s*\(/.test(code);
            const usesSnap = /S\.snapshot/.test(code) || /snapshot/.test(code);
            return {
              ok: !usesInterp && usesSnap,
              detail: `currentPosition 代码里调用 interpolate=${usesInterp}（必须为 false）；直接用上报值=${usesSnap}`,
            };
          } },

          /**
           * 指令契约：**B站点播要自动认出 BV 号**（裸号 / 链接 / 小写前缀都算）。
           * 钉它的理由：BV 前缀一度是严格大写匹配，观众手打的小写 `bv1NzfNBMEvZ`
           * 会整条被当成聊天忽略 —— 观众以为点了、其实什么都没发生。
           */
          { id: 'bvDetect', name: 'B站点播自动识别 BV 号（裸号/链接/小写前缀）', run: () => {
            const { parseCommand } = require('../core/commands');
            const cases = [
              ['BV1NzfNBMEvZ', 'BV1NzfNBMEvZ'],
              ['bv1NzfNBMEvZ', 'BV1NzfNBMEvZ'],          // 小写前缀 → 规范成大写
              ['点播 bv1NzfNBMEvZ', 'BV1NzfNBMEvZ'],
              ['https://b23.tv/abc123', 'https://b23.tv/abc123'],
              ['av12345', 'av12345'],
            ];
            const bad = cases.filter(([inp, want]) => {
              const r = parseCommand(inp);
              return r.cmd !== 'order_video' || r.args.target !== want;
            });
            return {
              ok: bad.length === 0,
              detail: bad.length
                ? `未按预期识别：${bad.map((b) => b[0]).join(' / ')}`
                : `${cases.length} 种写法全部识别为点播（含小写 bv）`,
            };
          } },

          /**
           * 契约：**B站多 P 视频要认出分P号**（2026-09-27 用户报告）。
           *
           * 钉它的理由：`/x/web-interface/view` 的 `data.cid` **恒为第一 P** 的 ——
           * 分P号只存在于用户给的那串东西里（页面地址的 `?p=3`、或手写的 `BV… p3`）。
           * 一旦没人解析它，"点合集第 3P 放第 1P"就会静默重现，而且用户看到的
           * 只是"歌名对不上"，很难联想到是解析层把分P号丢了。
           */
          { id: 'biliPage', name: 'B站多 P：分P号解析（?p=3 / BV… p3）', run: async () => {
            const { pageRankOf, BiliApi } = require('../core/bilibili/api');
            const api = new BiliApi({});
            const cases = [
              // [输入, 期望的分P号]
              ['https://www.bilibili.com/video/BV1HP411d7Qj/?spm_id_from=333.788.videopod.episodes&vd_source=a181a7f7&p=3', 3],
              ['https://www.bilibili.com/video/BV1HP411d7Qj?p=12', 12],
              ['BV1HP411d7Qj', 1],
              ['BV1NzfNBMEvZ p3', 3],
              ['点播 bv1NzfNBMEvZ P2', 2],
              // 标题里出现 p3 不算（只看末尾 token）—— 否则"我是p3玩家"这类标题会被当分P
              ['BV1NzfNBMEvZ 我是p3玩家', 1],
            ];
            const bad = [];
            for (const [inp, want] of cases) {
              if (pageRankOf(inp) !== want) bad.push(`pageRankOf(${inp.slice(0, 36)}…)≠${want}`);
              const id = await api.parseVideoId(inp);
              if ((id.page || 1) !== want) bad.push(`parseVideoId(${inp.slice(0, 36)}…).page≠${want}`);
            }
            return {
              ok: bad.length === 0,
              detail: bad.length ? bad.join(' / ') : `${cases.length} 种写法都能认出分P号`,
            };
          } },


          /**
           * 指令契约：**`点歌 ID 1234567` → 按网易云 ID 直接点播**（2026-09-26 用户定的）。
           * 解析层要把它**原样透传**给引擎（keyword 保持 `ID <数字>`）再由引擎识别。
           * 一旦有人把 `id` 加进音源别名表（sourceAlias），它就会被拆成"音源 id + 空关键词"
           * 而静默失效 —— 所以这里钉住透传形式。
           */
          { id: 'orderById', name: '「点歌 ID 歌曲ID」指令透传与识别', run: () => {
            const { parseCommand } = require('../core/commands');
            const a = parseCommand('点歌 ID 1445403856');
            const b = parseCommand('点歌 id 1445403856');
            const c = parseCommand('点歌 ID1445403856');   // 紧贴：不算 ID 指令，按歌名去搜
            const passThrough = a.cmd === 'order' && a.args.keyword === 'ID 1445403856'
              && b.cmd === 'order' && b.args.keyword === 'id 1445403856'
              && c.cmd === 'order' && c.args.keyword === 'ID1445403856';
            const hasFn = typeof e.orderSongById === 'function';
            return {
              ok: passThrough && hasFn,
              detail: `弹幕透传（含大小写/紧贴边界）=${passThrough}；engine.orderSongById=${hasFn}`,
            };
          } },
        ],
      },

      // ---------------------------------------------------------- 歌词引擎
      {
        id: 'lyrics', name: '歌词引擎', desc: 'LRC/yrc 解析、翻译合并、行级定位',
        checks: [
          { id: 'parseLrc', name: '标准 LRC 解析', run: () => {
            const r = parseLrc('[00:01.00]甲\n[00:02.50]乙');
            return { ok: r.lines.length === 2 && Math.abs(r.lines[1].time - 2.5) < 1e-6, detail: `${r.lines.length} 行` };
          } },
          { id: 'offset', name: '[offset:] 校正', run: () => {
            const r = parseLrc('[offset:500]\n[00:10.00]词');
            return { ok: Math.abs(r.lines[0].time - 9.5) < 1e-6, detail: 't=' + r.lines[0].time };
          } },
          { id: 'parseYrc', name: 'yrc 逐字解析（含两种形态）', run: () => {
            const a = parseYrc('[0,300](0,60,0)编(60,60,0)曲');
            const b = parseYrc('{"t":1500,"c":[{"tx":"你"},{"tx":"好"}]}');
            return { ok: a[0].words.length === 2 && Math.abs(b[0].time - 1.5) < 1e-6, detail: `${a[0].words.length} 字 / JSON 形态 t=${b[0].time}` };
          } },
          { id: 'merge', name: '逐字+翻译合并与降级', run: () => {
            const lrc = '[00:05.00]第一句\n[00:09.00]第二句';
            const yrc = '[5000,2000](0,500,0)第(500,500,0)一(1000,500,0)句';
            const tl = buildTimeline({ lrc, yrc, tlyric: '[00:05.00]First' });
            const bad = buildTimeline({ lrc, yrc: '[5000,2000](0,500,0)完全(500,500,0)不同' });
            return {
              ok: tl.lines[0].karaoke === 'word' && tl.lines[0].trans === 'First' && bad.lines[0].karaoke === 'line',
              detail: `逐字=${tl.lines[0].karaoke} 翻译=${tl.lines[0].trans} 文本不符时降级=${bad.lines[0].karaoke}`,
            };
          } },
          { id: 'coverUrl', name: '网易云封面 URL：坏格式能识别并修好', run: () => {
            /**
             * 2026-09-26 踩过：浏览器通道早期把封面朴素拼成
             * `p1.music.126.net/<picId>/<picId>.jpg` —— 那是 **404**（实测），
             * 而浏览器通道现在是主路径，于是"封面以前能看、改了之后全裂"。
             * 正确格式第一段必须是 picId 异或+MD5 的 hash（见 client.encryptedPicId）。
             */
            const picId = '109951165227114420';
            const broken = `https://p1.music.126.net/${picId}/${picId}.jpg?param=200y200`;
            const fixed = repairNeteaseCover(broken);
            const okFixed = fixed !== broken && fixed.includes('==') === false
              ? /p1\.music\.126\.net\/[^/]+\/109951165227114420\.jpg/.test(fixed) && !fixed.includes(`/${picId}/${picId}.jpg`)
              : /p1\.music\.126\.net\/[^/]+\/109951165227114420\.jpg/.test(fixed) && !fixed.includes(`/${picId}/${picId}.jpg`);
            // 不该误伤的几种
            const good = neteasePicUrl(picId, 200);
            const keepGood = repairNeteaseCover(good) === good;
            const keepBili = repairNeteaseCover('https://i0.hdslb.com/bfs/archive/a.jpg') === 'https://i0.hdslb.com/bfs/archive/a.jpg';
            const keepEmpty = repairNeteaseCover('') === '';
            const keepDiff = repairNeteaseCover('https://p1.music.126.net/111/222.jpg') === 'https://p1.music.126.net/111/222.jpg';
            return {
              ok: okFixed && keepGood && keepBili && keepEmpty && keepDiff,
              detail: `坏URL修好=${okFixed} 正确URL不动=${keepGood} B站不动=${keepBili} 空值=${keepEmpty} 两段不同=${keepDiff}`,
            };
          } },
          { id: 'picIdPrecision', name: '大 picId 不被 JSON 精度吃掉（封面 400 的根因）', run: () => {
            /**
             * 2026-09-26 用户报「点了个耀斑，来自缓存，封面依然裂」——实测根因：
             *   picId 是 `109951171396677694`（约 1.1e17），**超过 Number.MAX_SAFE_INTEGER
             *   （约 9e15）**，`JSON.parse` 只能舍入成 `109951171396677700`（差 6）。
             *   而封面 URL 的第二段就是 picId、第一段是它异或+MD5 —— 差 6 个数字就整条废掉：
             *     权威 URL p3…/DYDACa_8zB5irAOrasVgnQ==/109951171396677694.jpg → 200
             *     我们算的 p1…/9Ck9Wop8wLRTzt9VTqRehA==/109951171396677700.jpg → **400**
             *   （主机名无关，p1~p4 实测都 200；换正确路径就通。）
             *
             * 注意下面这个 JSON 必须写成**字符串**：把它写成 JS 字面量的话，
             * 文件一被解析就已经是舍入后的值了，测不出东西。
             */
            const raw = '{"al":{"picId":109951171396677694}}';
            const exact = parseJsonExact(raw).al.picId;
            const lossy = String(JSON.parse(raw).al.picId);   // 舍入后的错误值（用来证明这个坑真实存在）
            const urlExact = neteasePicUrl(exact, 200);
            const urlLossy = neteasePicUrl(lossy, 200);
            const ok = exact === '109951171396677694'
              && urlExact.includes('DYDACa_8zB5irAOrasVgnQ==') && urlExact.includes('/109951171396677694.jpg')
              && lossy !== exact                                  // 旧写法确实会丢精度
              && urlLossy.includes('9Ck9Wop8wLRTzt9VTqRehA==')     // 丢精度算出来的就是那个坏 hash
              && !urlExact.includes('9Ck9Wop8wLRTzt9VTqRehA==');
            // 顺带盯住浏览器通道：页面里不许再自己 JSON.parse（精度在那边就没了）
            // 先剥掉整行注释再判断，免得注释里写了 `JSON.parse(` 就误报。
            const bsrc = fs.readFileSync(path.join(__dirname, 'sources', 'netease-browser.js'), 'utf8');
            const codeOnly = bsrc.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
            const pageParses = /JSON\.parse\s*\(/.test(codeOnly);
            const usesExact = /parseJsonExact/.test(bsrc);
            return {
              ok: ok && !pageParses && usesExact,
              detail: `保留原值=${exact} 舍入值=${lossy} 正确hash=${urlExact.includes('DYDACa_8zB5irAOrasVgnQ==')}`
                + ` 浏览器通道页面内JSON.parse=${pageParses} 用精确解析=${usesExact}`,
            };
          } },
          { id: 'coverConsumer', name: '前端取封面必须用解析过的那份（源码级绊线）', run: async () => {
            /**
             * 2026-09-26 踩过：覆盖层读 `nowPlaying.cover`（服务端解析过：本地补代理、
             * 历史坏 URL 会修好），控制台却读 `track.cover`（原始字段）——
             * 于是**同一首歌覆盖层正常、控制台封面是裂的**（用户报告）。
             * 这条绊线禁止控制台再直接读 `t.cover` 当封面。
             */
            const js = await (await fetch(base + '/assets/control.js')).text();
            const usesResolved = /nowPlaying\.cover/.test(js);
            const rawAssign = /\$\('cover'\)\.src\s*=\s*t\.cover/.test(js);
            return {
              ok: usesResolved && !rawAssign,
              detail: `用 nowPlaying.cover=${usesResolved}；仍直接赋 t.cover=${rawAssign}`,
            };
          } },
          { id: 'browserCover', name: '浏览器通道不得手拼封面 URL（源码级绊线）', run: () => {
            // 这条绊线盯的是"别再有人图省事自己拼"：
            // 必须用 client.js 的 neteasePicUrl，且源码里不能出现 <picId>/<picId>.jpg 那种朴素拼法
            const src = fs.readFileSync(path.join(__dirname, 'sources', 'netease-browser.js'), 'utf8');
            const usesHelper = /neteasePicUrl/.test(src);
            const naive = /\/\$\{[^}]*picId[^}]*\}\/\$\{[^}]*picId[^}]*\}\.jpg/.test(src);
            return {
              ok: usesHelper && !naive,
              detail: `用 neteasePicUrl=${usesHelper}；朴素拼接残留=${naive}`,
            };
          } },
          { id: 'locate', name: '歌词行定位（随进度单调前进）', run: () => {
            /**
             * 注意：这里验的是**行级定位**，不是逐字进度 ——
             * 逐字染色显示已下线（2026-09-26），测试中心不该再宣传那个功能。
             * 逐字时间戳本身仍照常解析（数据层保留，见 lyric-sync.js 顶部说明），
             * 所以 yrc 还是喂进去，只是断言改为"当前行随进度正确前进"。
             */
            // 用 String.fromCharCode(10) 拼接换行，避免源码里的转义序列被生成过程吃掉
            const NL = String.fromCharCode(10);
            const tl = buildTimeline({
              lrc: ['[00:02.00]第一行', '[00:05.00]第二行', '[00:08.00]第三行'].join(NL),
              yrc: '[2000,3000](0,1000,0)第(1000,1000,0)一(2000,1000,0)行',
            });
            const a = locate(tl, 2.1, { preroll: 0 });
            const b = locate(tl, 5.1, { preroll: 0 });
            const c = locate(tl, 8.1, { preroll: 0 });
            const ok = a.index === 0 && b.index === 1 && c.index === 2
              && a.current.text.startsWith('第一行') && c.current.text.startsWith('第三行');
            return { ok, detail: `行号 ${a.index}→${b.index}→${c.index}；文本 ${a.current.text} / ${c.current.text}` };
          } },
          { id: 'syncShared', name: '前后端共用同步模块一致', run: () => {
            const tl = buildTimeline({ lrc: '[00:01.00]甲\n[00:05.00]乙' });
            const a = locate(tl, 5.1, { preroll: 0 }).index;
            const b = LyricSync.locate(tl, 5.1, { preroll: 0 }).index;
            return { ok: a === b, detail: `服务端 index=${a}，渲染端 index=${b}` };
          } },
          { id: 'interpolate', name: '播放进度插值（暂停不推进）', run: () => {
            const paused = LyricSync.interpolate({ position: 10, serverTime: Date.now() - 5000, paused: true }, Date.now());
            const playing = LyricSync.interpolate({ position: 10, serverTime: Date.now() - 2000, rate: 1, paused: false }, Date.now());
            return { ok: Math.abs(paused - 10) < 1e-6 && playing > 11.5 && playing < 12.5, detail: `暂停=${paused} 播放=${playing.toFixed(2)}` };
          } },
        ],
      },

      // ---------------------------------------------------------- 指令/队列
      {
        id: 'queue', name: '弹幕指令与队列', desc: '指令解析、权限、去重、冷却、插队',
        checks: [
          { id: 'cmds', name: '指令解析（点歌/切歌/BV）', run: () => {
            const a = parseCommand('点歌 孤勇者');
            const b = parseCommand('点歌 本地 老歌');
            const c = parseCommand('点播 BV1eLsnzFEoM');
            const d = parseCommand('这首好听');
            return {
              ok: a.cmd === 'order' && a.args.keyword === '孤勇者' && b.args.source === 'local' && c.cmd === 'order_video' && d.cmd === 'none',
              detail: `${a.cmd}/${b.args.source}/${c.cmd}/闲聊=${d.cmd}`,
            };
          } },
          { id: 'queueRules', name: '队列规则（去重/冷却/上限）', run: () => {
            // perUserMax 要给够，否则第二次点歌会先撞"每人上限"，
            // 根本走不到"冷却"那条分支（踩过一次）
            const q = new SongQueue({ cooldownMs: 60000, perUserMax: 3, maxSize: 3 });
            const s = (id) => ({ source: 'netease', id, name: 'S' + id, artists: ['A'] });
            const r1 = q.push(s(1), { uid: 'u1', uname: '甲' });
            const dup = q.push(s(1), { uid: 'u2', uname: '乙' });
            const cd = q.push(s(2), { uid: 'u1', uname: '甲' });
            const okAll = r1.ok && dup.reason === 'duplicate' && cd.reason === 'cooldown';
            return { ok: okAll, detail: `首次=${r1.ok} 去重=${dup.reason} 冷却=${cd.reason}` };
          } },
          { id: 'queuePrivilege', name: '主播越限与插队', run: () => {
            const q = new SongQueue({ cooldownMs: 0, maxSize: 1, perUserMax: 1 });
            const s = (id) => ({ source: 'netease', id, name: 'S' + id, artists: ['A'] });
            q.push(s(1), { uid: 'a', uname: '甲' });
            const full = q.push(s(2), { uid: 'b', uname: '乙' });
            const boss = q.push(s(3), { uid: 'c', uname: '主播', isAnchor: true }, { urgent: true });
            return { ok: full.reason === 'full' && boss.ok && boss.position === 1, detail: `满=${full.reason} 插队位置=${boss.position}` };
          } },
        ],
      },

      // ---------------------------------------------------------- 黑名单
      {
        id: 'blacklist', name: '黑名单 / 审核', desc: '四种规则、匹配、过滤、持久化',
        checks: [
          { id: 'blTypes', name: '四种规则类型命中', run: () => {
            const bl = new Blacklist({ enabled: true });
            bl.add({ type: 'song', value: '111' });
            bl.add({ type: 'keyword', value: '鬼叫' });
            bl.add({ type: 'artist', value: '某歌手' });
            bl.add({ type: 'bvid', value: 'BV1xx411c7mD' });
            const hit = [
              bl.check({ source: 'netease', id: 111, name: 'A' }).blocked,
              bl.check({ source: 'netease', id: 2, name: '有点鬼叫' }).blocked,
              bl.check({ source: 'netease', id: 3, name: 'B', artists: ['某歌手'] }).blocked,
              bl.check({ source: 'bilibili', bvid: 'BV1xx411c7mD', name: 'C' }).blocked,
              !bl.check({ source: 'netease', id: 9, name: '正常歌曲' }).blocked,
            ];
            return { ok: hit.every(Boolean), detail: `song/keyword/artist/bvid/放行 = ${hit.map((x) => (x ? '✓' : '✗')).join('')}` };
          } },
          { id: 'blFilter', name: '批量过滤（歌单导入用）', run: () => {
            const bl = new Blacklist({ enabled: true, rules: [{ type: 'keyword', value: '鬼叫' }] });
            const f = bl.filter([{ name: 'A' }, { name: '有鬼叫' }, { name: 'B' }]);
            return { ok: f.kept.length === 2 && f.blocked.length === 1, detail: `保留 ${f.kept.length} / 拦下 ${f.blocked.length}` };
          } },
          { id: 'blEngine', name: '引擎拦截（点歌被拒且不入队）', run: async () => {
            const prevEnabled = e.blacklist.enabled;
            e.blacklist.enabled = true; // 默认可能被用户在控制台关掉，自检时必须显式打开
            e.blacklist.add({ type: 'keyword', value: '自检专用禁用词' });
            const n0 = e.queue.length;
            const r = await e.orderByKeyword('自检专用禁用词 测试', 'netease', { uid: 'selftest', uname: '自检', isAnchor: true });
            const passed = r && r.ok === false && r.reason === 'blacklisted' && e.queue.length === n0;
            // 用完就拆，别污染用户的规则表
            const added = e.blacklist.list().rules.find((x) => x.value === '自检专用禁用词');
            if (added) e.blacklist.remove(added.id);
            e.blacklist.enabled = prevEnabled;
            return { ok: passed, detail: (r && (r.msg || r.reason)) + `；队列 ${n0} → ${e.queue.length}` };
          } },
        ],
      },

      // ---------------------------------------------------------- 服务与页面
      {
        id: 'server', name: '服务与页面', desc: '静态页、SSE、API、安全边界',
        checks: [
          { id: 'pages', name: '控制台/叠加层/播放核心页可达', run: async () => {
            const rs = await Promise.all(['/', '/overlay', '/player', '/shared/lyric-sync.js'].map((p) => fetch(base + p)));
            return { ok: rs.every((r) => r.status === 200), detail: rs.map((r) => r.status).join('/') };
          } },
          /**
           * 弹幕身份的**源码闸门**（2026-09-26 加）。
           *
           * 真实事故：浏览器通道的认证包把 `uid` 写死成 `0` → B站按游客对待 →
           * 收到的弹幕昵称全被打码（`飞***`）、每条弹幕的 sender uid 也是 0 →
           * 主播自己发指令被判"需要房管/主播权限"。
           * 修法：把登录 cookie 注入进那个（独立 profile、本来没登录态的）页面，
           * 并用页面侧读到的 `DedeUserID` 当认证 uid。
           * 这条检查守住两件事：**不能再写死 0**、**注入代码必须在**。
           */
          { id: 'danmakuIdentity', name: '弹幕身份不写死为游客（源码闸门）', run: () => {
            const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'bilibili', 'browser-channel.js'), 'utf8');
            const hardcoded = /uid:\s*0\s*,\s*roomid/.test(src);
            const hasInject = src.includes('applyCookie');
            const usesUid = /uid:\s*st\.uid/.test(src);
            return {
              ok: !hardcoded && hasInject && usesUid,
              detail: `写死 uid:0=${hardcoded ? '仍在（危险）' : '无'} · cookie 注入=${hasInject ? '有' : '丢失'} · 用页面侧 uid=${usesUid ? '是' : '否'}`,
            };
          } },
          { id: 'logsPage', name: '运行日志窗口（页面 + 日志接口）', run: async () => {
            /**
             * 打包成 exe 后没有控制台，这个窗口是用户唯一能自查的地方
             * （见 src/main/logbus.js）。所以页面和接口都得在这儿把住：
             * 页面 404 / 接口拿不到行，用户出问题时就是"两眼一抹黑"。
             */
            const page = await fetch(base + '/logs');
            const html = await page.text();
            const r = await (await fetch(base + '/api/logs?limit=5')).json();
            const hasNodes = ['id="lines"', 'id="status"', 'logs.js'].every((n) => html.includes(n));
            const okAll = page.status === 200 && hasNodes && r.ok === true && Array.isArray(r.lines);
            return {
              ok: okAll,
              detail: `页面 ${page.status}${hasNodes ? '' : '（缺关键节点）'} · 日志接口 ${r.ok ? 'ok' : '失败'}`
                + (Array.isArray(r.lines) ? ` / 缓冲 ${r.lines.length} 条（seq ${r.seq}）` : ''),
            };
          } },
          { id: 'overlayDom', name: '叠加层含歌词与信息栏节点', run: async () => {
            const html = await (await fetch(base + '/overlay')).text();
            const need = ['id="stage"', 'id="lines"', 'id="infoBar"', 'id="ibName"', 'id="ibBar"', 'id="ibRequester"', 'id="ibUpNext"', 'lyric-sync.js'];
            const miss = need.filter((n) => !html.includes(n));
            return { ok: miss.length === 0, detail: miss.length ? '缺少 ' + miss.join(', ') : `${need.length} 个关键节点齐全` };
          } },
          { id: 'overlaySplit', name: '歌词与信息卡可拆成两个独立源', run: async () => {
            // 直播姬里放两个浏览器源各自摆位置，避免两块内容互相压住。
            // 判据要贴着实现写：JS 里是 `'only-' + ONLY` 拼接，并没有 "only-lyrics" 字面量
            // （第一版判据就这么写错了，误报失败）。
            const html = await (await fetch(base + '/overlay')).text();
            const js = await (await fetch(base + '/assets/overlay.js')).text();
            const css = await (await fetch(base + '/assets/overlay.css')).text();
            const jsOk = /QS\.get\('only'\)/.test(js) && /'only-'/.test(js);
            const cssOk = /only-lyrics/.test(css) && /only-info/.test(css);
            const hasBar = html.includes('id="previewBar"');
            return {
              ok: jsOk && cssOk && hasBar,
              detail: `?only= 解析=${jsOk}；两种分区样式=${cssOk}；预览工具条=${hasBar}`,
            };
          } },
          { id: 'overlayRebuild', name: '叠加层：改歌词设置会触发重建（源码级绊线）', run: async () => {
            /**
             * 渲染层的东西 Node 单测够不到，但这条不变量必须守住 ——
             * 所以做**源码级绊线**：frame() 的重建条件里必须同时比较
             * "行号"和"渲染签名"，否则改主题/翻译/逐字开关时
             * `data-theme` 会变（CSS 生效）但**歌词行的 DOM 不重建**，
             * 表现就是"永远停在卡拉OK格式，再改也改不回去"（真实踩过）。
             */
            const js = await (await fetch(base + '/assets/overlay.js')).text();
            const hasSig = /function renderSig\s*\(/.test(js);
            const sigInclCfg = /renderSig\(\)[\s\S]{0,200}?c\.theme/.test(js) || /\[c\.theme/.test(js);
            const gateUsesSig = /r\.index !== lastIndex \|\| sig !== lastSig/.test(js);
            return {
              ok: hasSig && sigInclCfg && gateUsesSig,
              detail: `有 renderSig=${hasSig}；含主题等开关=${sigInclCfg}；重建条件用它=${gateUsesSig}`,
            };
          } },
          { id: 'lyricStrip', name: '底部歌词条跟随歌词设置（源码级绊线）', run: async () => {
            // 同上：歌词条的逐字门控与翻译行必须读叠加层配置，
            // 而不是自己拍脑袋决定（否则"面板里改了、歌词条不变"）
            const js = await (await fetch(base + '/assets/control.js')).text();
            const html = await (await fetch(base + '/')).text();
            // 逐字功能已下线 → 歌词条**不该**再引用 showKaraoke / 逐字填充
            const gates = !/showKaraoke/.test(js) && !/ls-fill/.test(js) && !/useWords/.test(js);
            const trans = /function applyTransRow/.test(js) && /ovCfg\.showTranslation/.test(js);
            const dom = html.includes('id="lsTrans"');
            /**
             * 外观设置（字号/颜色/描边/透明度）也必须跟着叠加层走 ——
             * 否则用户在面板里改这些，歌词条纹丝不动，看起来就是"点了保存没变化"
             * （用户报告的原话）。要求：有 applyStripStyle，且它读 fontSize 与颜色。
             */
            const style = /function applyStripStyle/.test(js)
              && /ov\.fontSize/.test(js) && /ov\.activeColor/.test(js) && /ov\.color/.test(js);
            // 签名要覆盖外观，否则"改了不重建"会重演
            const sigCovers = /ovCfg\.fontSize/.test(js) && /ovCfg\.activeColor/.test(js);
            return {
              ok: gates && trans && dom && style && sigCovers,
              detail: `已无逐字残留=${gates}；翻译行=${trans}；节点=${dom}；外观跟随=${style}；签名覆盖外观=${sigCovers}`,
            };
          } },
          { id: 'previewBar', name: '叠加层预览窗有可关闭的入口与工具条开关', run: async () => {
            /**
             * 无边框窗口没有系统关闭按钮，必须自带入口（实测被吐槽过）。
             * 工具条上还有「置顶」「自动隐藏标题栏」两个开关，窗口一圈还有拉边改尺寸的把手
             * —— 这三样**只在 ?preview=1 下生效**，而直播姬的浏览器源加载的是同一个页面，
             * 所以顺带查一道门控：JS 里两条都必须先判 preview、CSS 里把手必须挂在
             * body.preview-mode 下，否则正式画面里会多出一圈看不见的热区（挡住点击）。
             */
            const html = await (await fetch(base + '/overlay?preview=1')).text();
            const js = await (await fetch(base + '/assets/overlay.js')).text();
            const css = await (await fetch(base + '/assets/overlay.css')).text();
            const hasBar = ['id="previewBar"', 'id="pbClose"', 'id="pbTop"', 'id="pbAuto"']
              .every((s) => html.includes(s));
            // 四边 + 四角 = 8 个把手，少一个就说明有边拉不动
            const grips = (html.match(/class="pb-edge pb-e-/g) || []).length;
            const jsOk = /action: 'setOverlayTop'/.test(js) && /action: 'overlayResize'/.test(js)
              && /bar-hidden/.test(js);
            const cssGate = /body\.preview-mode[^{]*\.pb-edge\s*\{[^}]*pointer-events: auto/.test(css)
              && /body\.bar-hidden \.pb-hot/.test(css);
            return {
              ok: hasBar && grips === 8 && jsOk && cssGate,
              detail: `工具条与开关按钮=${hasBar}；拉边把手=${grips}/8；`
                + `JS 接线=${jsOk}；只在预览窗生效的门控=${cssGate}`,
            };
          } },
          { id: 'previewCanvas', name: '预览工具条不会压住画面内容（画布层在）', run: async () => {
            /**
             * 2026-09-27 修的老问题：工具条压在窗口最上面，而信息卡是 `position: absolute`
             * （相对视口）—— 卡片头顶那一条被盖住。原来那条"让位"规则
             * `body.preview-mode .overlay-root { padding-top: 34px }` 同时还是个**死规则**：
             * body 自己就是 `.overlay-root`、不是它的后代，永远不匹配。
             *
             * 现在的做法是内容全装进 `.overlay-canvas`，预览模式下整块下移一条工具条的高度。
             * 这条守四个不变量，缺一个就会退回"被压住"：
             *   · HTML 里有画布层，且信息卡/歌词在它里面（工具条在它外面）
             *   · 画布是**定位过的**（不然绝对定位的信息卡还是相对视口，白搭）
             *   · 预览模式下确实按 CSS 变量下移
             *   · 那个变量由页面**实测**工具条高度写入（写死像素的版本会随时间漂移）
             */
            const html = await (await fetch(base + '/overlay')).text();
            const css = await (await fetch(base + '/assets/overlay.css')).text();
            const js = await (await fetch(base + '/assets/overlay.js')).text();
            const canvas = /class="overlay-canvas"/.test(html);
            const wraps = /overlay-canvas[\s\S]*id="infoBar"[\s\S]*id="stage"[\s\S]*id="previewBar"/.test(html);
            const positioned = /\.overlay-canvas\s*\{[^}]*position:\s*absolute/.test(css);
            const shifted = /body\.preview-mode \.overlay-canvas\s*\{[^}]*top:\s*var\(--preview-bar-h/.test(css);
            const measured = /--preview-bar-h/.test(js) && /bar\.offsetHeight/.test(js);
            return {
              ok: canvas && wraps && positioned && shifted && measured,
              detail: `画布层=${canvas}；内容在画布内、工具条在外=${wraps}；画布已定位=${positioned}；`
                + `预览下移=${shifted}；高度实测=${measured}`,
            };
          } },
          { id: 'previewClickThrough', name: '点击穿越：开关 / 顶部可点带 / forward 都在', run: async () => {
            /**
             * 点击穿越是这一堆预览功能里最容易"开了就回不来"的一个：整窗透传之后，
             * 只要有一环漏了，用户就再也点不回工具条（只能去控制台关）。四环都要在：
             *   · 顶边那条可点带（工具条可见时是它本身，藏起来时是 14px 感应带）
             *   · 主进程调 `setIgnoreMouseEvents` 时必须带 **forward: true** ——
             *     透传后页面收不到普通鼠标事件，只有转发过来的移动事件能让它知道
             *     "光标挪回顶边了"，从而把窗口切回可点
             *   · 页面得有个口子上报"光标在不在那条里"（overlayPointerRegion）
             *   · 开了穿越时拉边把手必须让开（`:not(.ct-on)`）—— 否则四边还留着一圈
             *     看不见的热区在吃点击，用户会觉得"穿越时灵时不灵"
             */
            const html = await (await fetch(base + '/overlay?preview=1')).text();
            const js = await (await fetch(base + '/assets/overlay.js')).text();
            const css = await (await fetch(base + '/assets/overlay.css')).text();
            let main = '';
            try { main = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'); }
            catch { return { ok: false, detail: 'src/main/index.js 读不到' }; }
            const btn = html.includes('id="pbCt"');
            const acts = /action: 'setOverlayClickThrough'/.test(js) && /action: 'overlayPointerRegion'/.test(js);
            const forward = /setIgnoreMouseEvents\(ignore, \{ forward: ignore \}\)/.test(main);
            const band = /const HOT_H = 14/.test(js) && /topBandH/.test(js) && /body\.bar-hidden \.pb-hot/.test(css);
            const gripsOff = /:not\(\.ct-on\)[^{]*\.pb-edge\s*\{[^}]*pointer-events: auto/.test(css);
            return {
              ok: btn && acts && forward && band && gripsOff,
              detail: `穿越按钮=${btn}；两条命令接线=${acts}；setIgnoreMouseEvents 带 forward=${forward}；`
                + `顶部可点带=${band}；穿越时把手让开=${gripsOff}`,
            };
          } },
          { id: 'controlDom', name: '控制台含本地音乐入口与各功能面板', run: async () => {
            const html = await (await fetch(base + '/')).text();
            const need = [
              ['打开音乐文件', 'id="btnOpenFiles"'], ['打开音乐文件夹', 'id="btnOpenFolder"'],
              ['曲库列表', 'id="localList"'], ['测试中心', 'id="tcRunAll"'],
              ['黑名单', 'id="blList"'], ['歌单导入', 'id="btnPlImport"'],
              ['信息栏设置', 'id="btnSaveInfoBar"'],
              ['关闭叠加层预览', 'id="btnOverlayHide"'],
              // 分页与底部固定播放器
              ['分页导航', 'id="tabs"'], ['底部播放器', 'id="playerBar"'],
              ['直播状态开关', 'id="btnToggleLive"'], ['播放已保存歌单', 'id="btnPlaySaved"'],
            ];
            const miss = need.filter(([, id]) => !html.includes(id)).map(([n]) => n);
            // 本地文件入口只该有**一套**（同一页出现两套一样的按钮会让人犹豫点哪个）
            const dupOpen = (html.match(/id="btnOpenFiles/g) || []).length;
            const dupFolder = (html.match(/id="btnOpenFolder"/g) || []).length;
            const okDup = dupOpen === 1 && dupFolder === 1;
            const mis = miss.concat(okDup ? [] : ['本地文件入口重复']);
            return { ok: mis.length === 0, detail: mis.length ? '缺少/重复：' + mis.join('、') : `${need.length} 个入口齐全，本地入口唯一` };
          } },
          { id: 'playerDom', name: '播放核心页具备 setSinkId 能力', run: async () => {
            const js = await (await fetch(base + '/assets/player.js')).text();
            return { ok: js.includes('setSinkId') && js.includes('playerPosition'), detail: 'setSinkId + 进度上报' };
          } },
          { id: 'stateApi', name: '/api/state 与 /api/lyrics 结构正确', run: async () => {
            const s = await json('/api/state');
            const l = await json('/api/lyrics');
            const ok = s.body && s.body.type === 'state' && s.body.playback
              && l.body && l.body.type === 'lyrics' && l.body.timeline;
            return { ok, detail: `state.playback=${!!(s.body && s.body.playback)} lyrics.lines=${(l.body && l.body.timeline && l.body.timeline.lines.length) || 0}` };
          } },
          { id: 'sse', name: 'SSE 建连即收到状态与歌词', run: async () => {
            const res = await fetch(base + '/events');
            const reader = res.body.getReader();
            let acc = '';
            for (let i = 0; i < 12; i++) {
              const { value, done } = await reader.read();
              if (done) break;
              acc += Buffer.from(value).toString();
              if (acc.includes('"type":"state"') && acc.includes('"type":"lyrics"')) break;
            }
            try { reader.cancel(); } catch { /* 忽略 */ }
            return { ok: acc.includes('"type":"state"') && acc.includes('"type":"lyrics"'), detail: `${acc.length} 字节` };
          } },
          { id: 'sseConfig', name: 'SSE 建连即补发叠加层配置（新接入不会用默认值）', run: async () => {
            /**
             * 这条不变量很关键（2026-09-26 加）：
             * 配置平时只在"有人改设置"时广播一次，而叠加层是**随时接入**的
             * （直播姬刷新浏览器源、重开场景、重启后再刷新）。
             * 如果建连时不补发，新页面就用**内置默认值**渲染 ——
             * 表现是"我选了卡拉OK，它还是双语；重启了也一样"（真实踩过）。
             */
            const res = await fetch(base + '/events');
            const reader = res.body.getReader();
            let acc = '';
            for (let i = 0; i < 12; i++) {
              const { value, done } = await reader.read();
              if (done) break;
              acc += Buffer.from(value).toString();
              if (acc.includes('"type":"config"')) break;
            }
            try { reader.cancel(); } catch { /* 忽略 */ }
            const has = acc.includes('"type":"config"') && acc.includes('"overlay"');
            return { ok: has, detail: has ? '建连即收到 config+overlay' : `没收到（${acc.length} 字节）` };
          } },
          { id: 'cspMeta', name: 'CSP 注入正确（在 <head>、在 script 之前、与策略一致）', run: () => {
            /**
             * 2026-09-26 踩到两次，两次都是"看着加了 CSP，其实没生效"：
             *   1. `media-src` 只写了 `'self' https: blob:`，而网易云音频直链是 **http://**
             *      → 浏览器拒播：`MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`，
             *      表现成"点歌后显示正在播放，但一个音都没有"。
             *   2. CSP 的 `<meta>` 被手写进了 `<title>` 里。`<title>` 是 **RCDATA** 元素，
             *      里面的注释和标签**一律按纯文本处理** —— CSP 完全没生效，
             *      窗口标题还变成了那段 1150 字符的注释。
             *
             * 这两次当时都"检查通过"了：旧检查只是拿正则去文件里搜 CSP 字符串，搜到就报绿。
             * 所以现在改成**语义化**判断：
             *   · 三个页面都要过（原来只看 control.html）
             *   · 注入后的 meta 必须落在第一个 `<script>` 之前（CSP 只对之后的内容生效）
             *   · meta 内容必须等于 server.js 的 CSP_POLICY（单一来源，防抄漏/抄错）
             *   · media-src / img-src 都要放行 `http:`（音频直链、B 站封面都可能是 http）
             *   · HTML 里不该再手写 meta，避免两份策略打架
             *
             * 注意**读本地文件**而不是 fetch 页面：装了 AdGuard 时它会把响应里的 CSP
             * （HTTP 头和 meta 都算）**改写**成自己的版本（还会加
             * `injections.adguard.org`），照 fetch 的结果判断会误报失败。
             * 我们要守的是"源码拼出来的那份是对的"。
             */
            const pages = ['control.html', 'overlay.html', 'player.html'];
            const mediaSrc = (/media-src([^;]*)/.exec(CSP_POLICY) || [])[1] || '';
            const imgSrc = (/img-src([^;]*)/.exec(CSP_POLICY) || [])[1] || '';
            const bad = [];
            if (!/http:/.test(mediaSrc)) bad.push('media-src 未放行 http:');
            if (!/http:/.test(imgSrc)) bad.push('img-src 未放行 http:');
            for (const page of pages) {
              const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', page), 'utf8');
              if (/http-equiv="Content-Security-Policy"/i.test(html)) {
                bad.push(`${page}: HTML 里手写了 meta（应由 server.js 注入）`);
              }
              const served = injectCspMeta(html);
              const metaIdx = served.indexOf(`<meta http-equiv="Content-Security-Policy" content="${CSP_POLICY}">`);
              const scriptIdx = served.search(/<script[\s>]/i);
              if (metaIdx < 0) bad.push(`${page}: 注入后找不到 CSP meta`);
              else if (scriptIdx >= 0 && metaIdx > scriptIdx) bad.push(`${page}: meta 落在第一个 <script> 之后`);
            }
            return {
              ok: bad.length === 0,
              detail: bad.length
                ? bad.join('；')
                : `${pages.length} 个页面：meta 都在 <script> 之前且与 CSP_POLICY 一致；media/img 均放行 http`,
            };
          } },
          { id: 'titleSanity', name: '页面标题干净（没把注释/标签写进 <title>）', run: () => {
            /**
             * `<title>` 是 RCDATA 元素：写进去的 `<!-- -->`、`<meta>`、`<script>`
             * 都不会被解析，只会变成窗口标题的一部分（实测标题栏被撑到 1150 字符，
             * 真正的标题反而看不见了）。这类错误"能跑但看着不对"，光靠肉眼很容易漏。
             */
            const bad = [];
            for (const page of ['control.html', 'overlay.html', 'player.html']) {
              const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', page), 'utf8');
              const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
              const text = m ? m[1].trim() : '';
              if (!text) bad.push(`${page}: 没有标题`);
              else if (/[<>]/.test(text)) bad.push(`${page}: 标题里混进了标签/注释`);
              else if (text.length > 40) bad.push(`${page}: 标题过长（${text.length} 字符）`);
            }
            return { ok: bad.length === 0, detail: bad.length ? bad.join('；') : '3 个页面标题都是干净的短文本' };
          } },
          { id: 'coverGuard', name: '封面接口拒绝越界/非图片', run: async () => {
            const a = await fetch(base + '/stream/cover?path=' + encodeURIComponent('/etc/passwd'));
            const b = await fetch(base + '/stream/cover?path=' + encodeURIComponent('/etc/hosts'));
            return { ok: a.status === 400 || a.status === 403, detail: `非图片=${a.status} 越界=${b.status}` };
          } },
          { id: 'proxyGuard', name: 'B站代理拒绝非 http(s) 目标', run: async () => {
            const r = await fetch(base + '/stream/bili?url=' + encodeURIComponent('file:///etc/passwd'));
            return { ok: r.status === 400, detail: 'HTTP ' + r.status };
          } },
          { id: 'localStreamGuard', name: '本地流接口拒绝白名单外的文件', run: async () => {
            // 加「打开本地音乐」之后这个口子必须收紧：
            // 否则 /stream/local?path= 就是任意文件读取（直播机上的网页可探文件）
            const probe = path.join(os.tmpdir(), 'nekofm-guard-probe.txt');
            fs.writeFileSync(probe, 'not audio');
            const r = await fetch(base + '/stream/local?path=' + encodeURIComponent(probe));
            try { fs.unlinkSync(probe); } catch { /* 忽略 */ }
            return { ok: r.status === 403, detail: 'HTTP ' + r.status + '（期望 403）' };
          } },
          { id: 'unknownCmd', name: '未知指令返回错误而非静默', run: async () => {
            const r = await cmd({ action: 'definitely-not-a-command' });
            return { ok: r && r.ok === false, detail: (r && r.error) || '' };
          } },
        ],
      },

      // ---------------------------------------------------------- 播放链路
      {
        id: 'playback', name: '播放链路（离线）', desc: '模拟进度 → 歌词定位 → 叠加层数据',
        checks: [
          { id: 'nowPlaying', name: 'nowPlaying 视图字段完整', run: () => {
            const saved = e.track; const savedMeta = e.trackMeta;
            e.track = DEMO_SONG; e.trackMeta = { requester: { uid: 'x', uname: '观众甲' }, requestedAt: Date.now(), startedAt: Date.now() };
            const np = e.nowPlaying();
            e.track = saved; e.trackMeta = savedMeta;
            const need = ['name', 'artistText', 'sourceLabel', 'cover', 'requester', 'duration', 'position', 'queueRemaining'];
            const miss = need.filter((k) => np[k] === undefined);
            return { ok: miss.length === 0, detail: miss.length ? '缺少 ' + miss.join(',') : `${need.length} 个字段齐全` };
          } },
          { id: 'demo', name: '演示模式（叠加层可看到完整效果）', run: async () => {
            // 自检项必须**无副作用**：验证完就收掉，否则会污染后续状态
            // （曾经因为留着 6 秒演示，导致后面的断言拿到假曲目）。
            // 想持续观察请用控制台的「开始演示」按钮。
            e.startDemo({ seconds: 3 });
            await sleep(900);
            const st = e.state();
            const ok = !!st.nowPlaying && st.nowPlaying.name === DEMO_SONG.name
              && e.lyricTimeline.lines.length >= 6
              && e.lyricTimeline.lines.some((l) => l.karaoke === 'word');
            const detail = `歌词 ${e.lyricTimeline.lines.length} 行，逐字 ${e.lyricTimeline.lines.filter((l) => l.karaoke === 'word').length} 行（已自动结束，可用「开始演示」持续观察）`;
            e.stopDemo();
            return { ok, detail };
          } },
          { id: 'lyricPush', name: '歌词能推送到叠加层（SSE）', run: async () => {
            // 必须按 SSE 事件边界（空行）切分再 JSON.parse。
            // 之前用"看到 type 标记就停"的写法，在 Windows 上因为消息被拆包而假失败 ——
            // 歌词 payload 有几十行、十几 KB，跨 chunk 是常态。
            const res = await fetch(base + '/events');
            const reader = res.body.getReader();
            let acc = '';
            let payload = null;
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline && !payload) {
              const { value, done } = await reader.read();
              if (done) break;
              acc += Buffer.from(value).toString();
              const parts = acc.split('\n\n');
              for (const part of parts.slice(0, -1)) {   // 最后一段可能还没收完
                const line = part.split('\n').find((l) => l.startsWith('data: '));
                if (!line) continue;
                try {
                  const m = JSON.parse(line.slice(6));
                  if (m.type === 'lyrics') { payload = m; break; }
                } catch { /* 半包，丢弃 */ }
              }
            }
            try { reader.cancel(); } catch { /* 忽略 */ }
            if (!payload) return { ok: false, detail: '未在 SSE 中收到完整的 lyrics 事件' };
            return { ok: true, detail: `歌词 ${payload.timeline.lines.length} 行，rev=${payload.rev}` };
          } },
        ],
      },

      // ---------------------------------------------------------- 本地音乐
      {
        id: 'localMusic', name: '本地音乐', desc: '打开文件/文件夹、曲库浏览、流接口白名单',
        checks: [
          { id: 'localList', name: '曲库列表与搜索', run: () => {
            const l = e.listLocal('');
            const s = e.listLocal('不存在的关键词xyz');
            return {
              ok: l.ok && Array.isArray(l.tracks) && typeof l.libraryTotal === 'number' && s.total === 0,
              detail: `曲库 ${l.libraryTotal} 首（临时打开 ${l.adhoc} 个），目录 ${l.dirs.length} 个`,
            };
          } },
          { id: 'localOpenFile', name: '打开本地文件 → 入队 → 白名单放行', run: async () => {
            // 现场用 ffmpeg 造一个文件，完整走一遍"打开"流程
            const { execFileSync } = require('node:child_process');
            const tmp = path.join(os.tmpdir(), `nekofm-selftest-${Date.now()}.mp3`);
            try {
              execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
                '-c:a', 'libmp3lame', '-b:a', '96k', '-metadata', 'title=自检临时曲目', tmp], { timeout: 20000 });
            } catch (err) {
              return { skip: true, detail: 'ffmpeg 不可用，无法生成测试音频' };
            }

            const outside = await fetch(base + '/stream/local?path=' + encodeURIComponent(tmp));
            const blockedBefore = outside.status === 403;

            const opened = await e.openLocalFiles([tmp], { enqueue: true, play: false });
            const allowedAfter = (await fetch(base + '/stream/local?path=' + encodeURIComponent(tmp))).status === 200;

            // 收尾：从曲库与白名单里摘掉，别污染用户的曲库
            try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
            e.local.extraFiles.delete(tmp);
            e.local.tracks = e.local.tracks.filter((t) => t.file !== tmp);
            e.queue.items = e.queue.items.filter((i) => !(i.song && i.song.file === tmp));

            const okAll = blockedBefore && opened.ok && allowedAfter;
            return {
              ok: okAll,
              detail: `打开前=${outside.status}(期望403) 打开=${opened.ok ? '成功' : opened.msg} 打开后=${allowedAfter ? 200 : '被拒'}`,
            };
          } },
          { id: 'localFolder', name: '打开文件夹加入曲库（可撤回）', run: async () => {
            const dir = path.join(os.tmpdir(), `nekofm-selftest-dir-${Date.now()}`);
            fs.mkdirSync(dir, { recursive: true });
            const r = await e.openLocalFolder(dir);
            const inCfg = (e.config.local.dirs || []).includes(dir);
            const rm = e.removeLocalFolder(dir);
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
            return { ok: r.ok && inCfg && rm.ok, detail: `加入=${r.ok} 写入配置=${inCfg} 移除=${rm.ok}` };
          } },
          { id: 'localCover', name: '本地曲目封面（无图时优雅降级）', run: () => {
            const t = e.local.tracks[0];
            if (!t) return { skip: true, detail: '曲库为空，无法检查封面' };
            const url = e.coverUrlFor(t);
            return { ok: url === '' || url.includes('/stream/cover') || /^https?:/.test(url), detail: url ? url.slice(0, 60) : '无封面（将显示占位音符）' };
          } },
        ],
      },

      // ---------------------------------------------------------- 播放器
      {
        id: 'player', name: '播放器', desc: '播放模式、切歌权限、收藏、队列、闲时、缓存',
        checks: [
          { id: 'playModes', name: '四种播放模式可切换', run: () => {
            const before = e.playMode;
            const modes = ['order', 'repeat-all', 'repeat-one', 'shuffle'];
            const allOk = modes.every((m) => e.setPlayMode(m).ok);
            const bad = e.setPlayMode('nope').ok === false;
            e.setPlayMode(before || 'order');
            return { ok: allOk && bad, detail: modes.join(' / ') + '，非法值被拒=' + bad };
          } },
          { id: 'repeatOne', name: '播放模式只作用于"点歌队列之外"的播放', run: async () => {
            // 语义（用户定）：点歌队列恒为顺序播放；闲时/已保存歌单才吃模式。
            /**
             * ⚠️ 必须把**队列**也一起快照（2026-09-26 修）。
             *
             * 这个自检项里调了 `e.queue.clear()`，但原来只保存/还原了
             * mode/track/idle —— **没管队列**。于是用户点一下「测试中心」，
             * 待播队列就被清空了（自检项必须无副作用，这条违反了）。
             */
            const save = {
              mode: e.playMode, track: e.track, meta: e.trackMeta,
              idle: e.config.idle && e.config.idle.enabled, playingIdle: e.playingIdle,
              queue: { items: e.queue.items.slice(), current: e.queue.current, history: e.queue.history.slice() },
            };
            if (e.config.idle) e.config.idle.enabled = false;
            const fake = { source: 'local', id: '__selftest__', name: '自检曲', title: '自检曲', duration: 3 };
            e.track = fake; e.trackMeta = { requester: { uid: 'x', uname: '自检' } };

            // ① 队列播放：即使选了单曲循环，也要往下走（队列恒顺序）
            e.playingIdle = false;
            e.queue.clear(); e.queue.current = null; e.queue.history.length = 0;
            e.queue.push({ source: 'local', id: '__selftest_b__', name: '自检曲B', title: '自检曲B' },
              { uid: 'q', uname: '自检', isAnchor: true }, { force: true });
            e.setPlayMode('repeat-one');
            const queueRuns = await e.next();
            const queueMoved = !(queueRuns && queueRuns.repeat === true);

            // ② 队列之外的播放：单曲循环应重播当前曲
            e.queue.clear(); e.queue.current = null; e.queue.history.length = 0;
            e.track = fake; e.trackMeta = { requester: { uid: 'idle', uname: '闲时歌单' } };
            e.playingIdle = true;
            const r = await e.next();
            const okRepeat = !!(r && r.repeat === true && e.track === fake);

            e.setPlayMode(save.mode || 'order');
            e.track = save.track; e.trackMeta = save.meta;
            e.playingIdle = save.playingIdle;
            if (e.config.idle) e.config.idle.enabled = save.idle;
            // 队列原样放回（顺序、在放项、去重历史一个都不能少）
            e.queue.items = save.queue.items;
            e.queue.current = save.queue.current;
            e.queue.history = save.queue.history;
            return {
              ok: queueMoved && okRepeat,
              detail: `队列忽略单曲循环=${queueMoved}；队列之外生效=${okRepeat}`,
            };
          } },
          { id: 'skipOwner', name: '切歌权限：本人可切、他人不可', run: async () => {
            const save = { track: e.track, meta: e.trackMeta, idle: e.config.idle && e.config.idle.enabled };
            if (e.config.idle) e.config.idle.enabled = false;
            const fake = { source: 'local', id: '__selftest2__', name: '权限自检曲', title: '权限自检曲' };
            e.track = fake; e.trackMeta = { requester: { uid: 'owner-1', uname: '点歌人' } };
            const deny = await e.skip({ uid: 'other-2', uname: '路人' });
            const allow = await e.skip({ uid: 'owner-1', uname: '点歌人' });
            const local = await e.skip({ uname: '控制台' }, { local: true });
            e.track = save.track; e.trackMeta = save.meta;
            if (e.config.idle) e.config.idle.enabled = save.idle;
            const okAll = deny && deny.ok === false && deny.reason === 'not_owner'
              && allow && allow.ok === true && local && local.ok === true;
            return {
              ok: okAll,
              detail: `他人=${deny && deny.reason} 本人=${allow && allow.ok} 本机=${local && local.ok}`,
            };
          } },
          { id: 'favorites', name: '收藏可增可删', run: () => {
            const s = { source: 'local', id: '__fav_selftest__', name: '收藏自检', title: '收藏自检' };
            const a = e.toggleFavorite(s);
            const on = e.isFavorited(s);
            const b = e.toggleFavorite(s);
            const off = !e.isFavorited(s);
            return { ok: a.favorited === true && on && b.favorited === false && off, detail: `加=${a.favorited} 查=${on} 删=${b.favorited} 复查=${off}` };
          } },
          { id: 'queueOps', name: '队列置顶与拉黑（按类型）', run: () => {
            const q = e.queue;
            const saveItems = q.items.slice();
            const saveCurrent = q.current;
            const saveHist = q.history.slice();
            const saveRules = e.config.blacklist ? JSON.parse(JSON.stringify(e.config.blacklist)) : null;
            const mk = (n, id) => ({ source: 'local', id, name: n, title: n, artists: ['自检歌手'] });
            q.items = [];
            q.current = null;
            ['A', 'B', 'C'].forEach((n, i) => q.push(mk(n, `__q${i}__`), { uid: 'q', uname: '自检', isAnchor: true }));
            const moved = e.moveInQueue(3, 'top');
            const topOk = moved.ok && q.items[0].song.name === 'C';
            const before = q.items.length;
            const blk = e.blacklistFromQueue(1, 'keyword');
            const removedOk = blk.ok && blk.removedFromQueue === true && q.items.length === before - 1;
            // 还原
            q.items = saveItems;
            q.current = saveCurrent;
            q.history = saveHist;
            if (saveRules) { e.blacklist.enabled = saveRules.enabled; e.blacklist.rules = []; for (const r of saveRules.rules) e.blacklist._hydrate(r); }
            return { ok: topOk && removedOk, detail: `置顶=${topOk} 拉黑并撤下=${removedOk}` };
          } },
          { id: 'idle', name: '闲时歌单（队列空自动顶上）', run: async () => {
            const save = { idle: JSON.parse(JSON.stringify(e.config.idle || {})), track: e.track, meta: e.trackMeta, items: e.queue.items.slice(), current: e.queue.current, hist: e.queue.history.slice() };
            if (!e.local.tracks.length) {
              return { skip: true, detail: '本地曲库为空，无法验证闲时歌单' };
            }
            e.queue.items = []; e.queue.current = null; e.queue.history = [];
            e.track = null;
            e.config.idle = { enabled: true, source: 'local', shuffle: false, avoidRecent: 0 };
            const item = await e._nextIdleTrack();
            const okIdle = !!item && item.uid === 'idle' && item.song.source === 'local';
            // 还原
            e.config.idle = save.idle;
            e.track = save.track; e.trackMeta = save.meta;
            e.queue.items = save.items; e.queue.current = save.current; e.queue.history = save.hist;
            return { ok: okIdle, detail: item ? `取到《${item.song.name}》并标记为闲时` : '没有取到曲目' };
          } },
          { id: 'playSavedAck', name: '「播放已保存歌单」的失败要如实回、回执要带 from/total', run: () => {
            /**
             * 2026-09-26 用户报："点「播放已保存歌单」，出现 正在播放（第 undefined/undefined 首）"。
             *
             * 根因：这条路走 fireAndForget（**立刻回执**，不等整首加载完），于是
             *   (a) 回执里根本没有 from/total → 按钮上印出 `undefined/undefined`；
             *   (b) "直播中 / 列表为空"这类**同步就能判断**的失败也被同一个回执吞掉 ——
             *       界面闪一下然后什么都不发生，用户看不到任何原因。
             *
             * 这里**故意不 POST 那个命令**：在用户真机上列表非空，一按就真的开始播放了，
             * 自检必须有副作用禁令（见文件头）。改为断言引擎的同步检查函数本身 ——
             * 它按状态只有三种正确结果，逐一对照，纯读不写。
             */
            if (typeof e.playSavedGuard !== 'function') {
              return { ok: false, detail: '引擎没有 playSavedGuard（命令层没法在回执前拦下失败）' };
            }
            const hasList = (e.config.savedPlaylist || []).length > 0;
            const g = e.playSavedGuard();
            let want; let got;
            if (!hasList) {
              want = '列表为空要给出同步错误';
              got = g && /已保存/.test(g.msg || '') ? '列表为空要给出同步错误' : `实际=${JSON.stringify(g)}`;
            } else {
              /**
               * 2026-09-26 定的规则：**直播中的手动选曲仅限闲时**。
               *   · 正在播观众点的歌（`track` 有值且不是闲时）→ 拒绝（点歌优先，别被抢播）
               *   · 其余（未直播 / 闲时歌单在播 / 什么都没在播）→ 放行
               * 断言必须**跟着当前运行状态走** —— 写死"一定放行"会在真机处于
               * "直播中且正在播点歌队列"时误报。
               */
              const shouldBlock = e.streaming && e.track && !e.playingIdle;
              want = shouldBlock ? '直播中且正在播点歌队列 → 应拒绝（点歌优先）' : '应放行（未直播 / 闲时 / 空闲）';
              got = shouldBlock
                ? (g && /点歌/.test(g.msg || '') ? want : `实际=${JSON.stringify(g)}`)
                : (g === null ? want : `实际=${JSON.stringify(g)}`);
            }
            // 回执必须带上 from/total（这条 ack 只有"列表非空"时才走得到，
            // 测试里不能往用户的已保存列表塞歌，所以用源码断言锁住这个契约）
            const src = fs.readFileSync(path.join(__dirname, 'commands.js'), 'utf8');
            const carries = /fireAndForget\(p,\s*cmd,\s*'已开始播放',\s*\{[^}]*\bfrom\b[^}]*\btotal\b[^}]*\}/.test(src);
            const usesGuard = /playSavedGuard/.test(src);
            return {
              ok: want === got && carries && usesGuard,
              detail: `${got}；回执带 from/total=${carries} 用同步检查=${usesGuard}`,
            };
          } },
          { id: 'cache', name: '媒体缓存（落盘/命中/超限淘汰/清空）', run: async () => {
            const c = e.cache;
            const dir = c.cacheDir;
            if (!dir) return { skip: true, detail: '缓存未启用' };
            // 用本机流接口当"远端"，自包含、不依赖外网
            let src = null;
            if (e.local.tracks[0]) {
              src = `${base}/stream/local?path=${encodeURIComponent(e.local.tracks[0].file)}`;
            } else {
              // 没有本地歌时造一个最小可下载目标：用页面本身（非媒体，会被拒）→ 跳过
              return { skip: true, detail: '本地曲库为空，无法构造缓存源' };
            }
            const key = '__selftest_cache__';
            await c.put(key, src, { name: '自检缓存', source: 'local' });
            const hit = c.get(key);
            const okHit = !!hit && fs.existsSync(hit.file);
            const served = okHit ? (await fetch(`${base}/stream/local?path=${encodeURIComponent(hit.file)}`)).status === 200 : false;
            c.remove(key);
            const cleaned = !c.get(key);
            return {
              ok: okHit && served && cleaned,
              detail: `落盘=${okHit ? (hit.size / 1024).toFixed(0) + 'KB' : '失败'} 白名单可播=${served} 删除=${cleaned}`,
            };
          } },
          { id: 'lyricCache', name: '歌词缓存（与音频缓存同一子系统）', run: async () => {
            // 歌词缓存统一走 MediaCache：同一目录、同一统计、同一「清空」——
            // 用户管理缓存只需要看一个地方。
            const c = e.cache;
            if (!c.lyricDir) return { skip: true, detail: '缓存未启用' };
            const tl = { meta: {}, lines: [{ time: 1, text: '自检歌词', words: [], karaoke: 'plain' }] };
            const key = '__selftest_lyric__';
            const put = c.putLyrics(key, tl, { name: '自检' });
            const got = c.getLyrics(key);
            const stats = c.lyricStats();
            /**
             * ⚠️ **只删自己那一条，绝不调 `clearLyrics()`**（2026-09-26 修）。
             *
             * 这里原来写的是 `c.clearLyrics()` —— 那会把**用户全部**歌词缓存清光。
             * 而测试中心是在真实应用里跑的（点一下按钮就执行），
             * 等于"点一下自检，歌词缓存全没"。自检项必须**无副作用**，
             * 这是 PROGRESS.md 里早就写下的铁律，这条违反了。
             */
            const removed = c.removeLyrics(key);
            const gone = !c.getLyrics(key);
            return {
              ok: put.ok && !!got && got.timeline.lines.length === 1 && stats.count >= 1 && removed.ok && gone,
              detail: `写入=${put.ok} 读回=${!!got} 统计含歌词=${stats.count > 0} 删除=${removed.ok} 复查已清=${gone}`,
            };
          } },
          { id: 'sidecarSave', name: '匹配到的歌词可落到歌曲旁边', run: async () => {
            // 落成旁车文件后，下次播放完全不联网 —— 这是最可靠的一条歌词来源
            const dir = path.join(os.tmpdir(), `nekofm-selftest-lyric-${Date.now()}`);
            fs.mkdirSync(dir, { recursive: true });
            const fake = path.join(dir, '自检歌.mp3');
            fs.writeFileSync(fake, 'x');
            const tl = { meta: {}, lines: [{ time: 1, text: '甲', words: [{ t: 0, d: 0.5, text: '甲' }], karaoke: 'word' }] };
            const r = e.local.saveLyrics(fake, tl);
            const files = fs.readdirSync(dir).filter((f) => f.endsWith('.lrc'));
            const reread = await e.local.lyrics(fake);
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
            /**
             * 2026-09-26 起只写 `.lrc`（+ 有翻译时的 `.trans.lrc`），
             * **不再写 `.karaoke.lrc`** —— 逐字染色显示已下线，没人再读它。
             * 所以这里断言的是"写出来了 + 能读回"，不再要求文件数 ≥2。
             */
            return {
              ok: r.ok && files.includes('自检歌.lrc') && !files.includes('自检歌.karaoke.lrc') && reread.ok,
              detail: `写出 ${files.length} 个文件（${files.join('、')}），读回=${reread.ok}`,
            };
          } },

          /**
           * 源码级绊线：**读侧车 .lrc 必须走 readTextFile，不得直接按 UTF-8 硬读**。
           *
           * 为什么钉它：这类错误**不抛异常**，只把歌词变成"合法但全错"的乱码 ——
           * 单元测试只看 `ok`/`source` 照样是绿的，只有真去播那首歌才看得见，
           * 所以极易在重构中悄悄复活。2026-09-27 用户报告"本地文件字幕乱码"，
           * 实测曲库 131 个 .lrc 里 **105 个是 GBK、2 个是 UTF-16LE**。
           */
          { id: 'lrcEncoding', name: '侧车歌词按原编码读，不硬按 UTF-8（源码级绊线）', run: () => {
            let src = '';
            try { src = fs.readFileSync(path.join(__dirname, 'sources', 'local.js'), 'utf8'); }
            catch { return { ok: false, detail: '读不到 main/sources/local.js' }; }
            const usesHelper = /readTextFile\(main\)/.test(src) && /readTextFile\(transPath\)/.test(src);
            // 旧写法（会复活这个 bug）：readFileSync(main|transPath, 'utf8')
            const rawUtf8 = /readFileSync\(\s*(main|transPath|lrcPath|karaokePath)\s*,\s*['"]utf8['"]/.test(src);
            return {
              ok: usesHelper && !rawUtf8,
              detail: `走 readTextFile=${usesHelper}；仍按 utf8 硬读=${rawUtf8}`,
            };
          } },
        ],
      },

      // ---------------------------------------------------------- 部署/环境
      {
        id: 'env', name: '运行环境', desc: 'Node/ffmpeg/Electron/数据落点',
        checks: [
          { id: 'node', name: 'Node 版本 ≥ 22', run: () => {
            const v = parseInt(process.versions.node.split('.')[0], 10);
            return { ok: v >= 22, detail: 'v' + process.versions.node };
          } },
          { id: 'ffmpeg', name: 'ffmpeg / ffprobe 可用', run: async () => {
            const { execFile } = require('node:child_process');
            const one = (cmd) => new Promise((res) => execFile(cmd, ['-version'], { timeout: 8000 }, (err, out) => res(err ? null : String(out).split('\n')[0])));
            const a = await one('ffmpeg'); const b = await one('ffprobe');
            return { ok: !!a && !!b, detail: a ? a.slice(0, 42) : '未找到 ffmpeg（本地曲库的元数据/封面提取会不可用）' };
          } },
          { id: 'electron', name: 'Electron 运行时', run: () => {
            const ok = !!(e.browser && e.browser.available);
            if (!ok) {
              return { skip: true, detail: 'headless 模式：浏览器急兑与登录窗不可用，其余功能不受影响' };
            }
            return { ok: true, detail: '浏览器急兑与扫码登录窗可用' };
          } },
          { id: 'batEncoding', name: '批处理脚本编码安全（纯 ASCII + CRLF）', run: () => {
            // Windows 的 cmd.exe 按控制台代码页（中文系统 936/GBK）解析 .bat 字节，
            // 而文件通常是 UTF-8 —— 中文会乱码，严重时 cmd 会把乱码当命令执行。
            // 所以硬性要求：.bat 里不许出现非 ASCII 字节，且必须 CRLF 换行。
            const root = configPath().appRoot;
            const bats = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.bat'));
            if (!bats.length) return { ok: false, detail: '没找到任何 .bat' };
            const bad = [];
            for (const f of bats) {
              const buf = fs.readFileSync(path.join(root, f));
              const nonAscii = [...buf].filter((b) => b > 127).length;
              const crlf = buf.includes(Buffer.from('\r\n'));
              const loneLf = /[^\r]\n/.test(buf.toString('latin1'));
              if (nonAscii > 0) bad.push(`${f}: ${nonAscii} 个非 ASCII 字节`);
              else if (loneLf) bad.push(`${f}: 含裸 LF 换行`);
              else if (!crlf) bad.push(`${f}: 无 CRLF`);
            }
            return {
              ok: bad.length === 0,
              detail: bad.length ? bad.join('；') : `${bats.length} 个 .bat 全部纯 ASCII + CRLF`,
            };
          } },
          { id: 'batTargets', name: '批处理调用的 Node 入口都存在', run: () => {
            /**
             * **动态从 .bat 里提取入口**，不再硬编码清单。
             *
             * 踩过的坑：原清单里写了 `tools/cleanup-c-drive.js` —— 那是**作者本机的
             * 清理脚本，故意不入库**（见 .gitignore）。于是 CI 上仓库里根本没有这两个
             * 文件，检查就报"缺少 tools/cleanup-c-drive.js"，把绿色构建判红。
             *
             * 现在的口径：**仓库里存在的 .bat 引用的入口必须存在**；不存在的 .bat 不管。
             * 这样本机（有 cleanup 脚本）与干净检出（没有）都能正确判定。
             */
            const root = configPath().appRoot;
            const bats = fs.readdirSync(root).filter((f) => /\.bat$/i.test(f));
            const need = [];
            for (const b of bats) {
              const txt = fs.readFileSync(path.join(root, b), 'utf8');
              for (const m of txt.matchAll(/node\s+"?([\w./\\-]+\.js)"?/g)) {
                const rel = m[1].replace(/\\/g, '/');
                if (!need.includes(rel)) need.push(rel);
              }
            }
            const miss = need.filter((f) => !fs.existsSync(path.join(root, f)));
            const detail = miss.length
              ? '缺少 ' + miss.join(', ')
              : `${bats.length} 个 .bat 共引用 ${need.length} 个入口，全部就位（${need.join('、')}）`;
            return { ok: miss.length === 0 && need.length > 0, detail };
          } },
          { id: 'launcher', name: '启动器自检可运行（不拉 GUI）', run: () => {
            // 启动器本身也要能被测试：--check-only 只做环境检查，
            // 否则"测一下启动脚本"会真的弹出界面（踩过这个坑）。
            const root = configPath().appRoot;
            const { execFileSync } = require('node:child_process');
            const out = execFileSync(process.execPath, [path.join(root, 'tools', 'start.js'), '--check-only'], {
              encoding: 'utf8', timeout: 20000, cwd: root,
            });
            const ok = /环境自检通过/.test(out) && /数据目录/.test(out);
            return { ok, detail: ok ? '环境检查通过，未启动界面' : '输出异常：' + out.slice(0, 80) };
          } },
        ],
      },

      // ---------------------------------------------------------- 联网：网易云
      {
        id: 'netNetease', name: '联网·网易云', desc: '搜索/歌词/取流/歌单/封面', 
        checks: [
          { id: 'search', name: '搜索接口', net: true, run: async () => {
            const r = await e.netease.search('孤勇者 陈奕迅', { limit: 3 });
            return { ok: r.ok && r.songs.length > 0, detail: r.songs[0] ? `${r.songs[0].name} - ${r.songs[0].artistText}` : r.msg };
          } },
          { id: 'cover', name: '搜索结果封面可直接取到图', net: true, run: async () => {
            const r = await e.netease.search('孤勇者 陈奕迅', { limit: 1 });
            // 前置搜索失败（多半是限流）时如实透传原因，交给 run() 判定是跳过还是失败，
            // 不要在这里硬崩 —— 否则自检会因为外部限流刷一堆红。
            if (!r.ok || !r.songs.length) return { ok: false, detail: `前置搜索未成功：${r.msg || '无结果'}` };
            const u = r.songs[0].cover;
            if (!u) return { ok: false, detail: '搜索没有返回封面地址' };
            const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } });
            const buf = Buffer.from(await res.arrayBuffer());
            return { ok: res.status === 200 && buf.length > 500, detail: `HTTP ${res.status}，${buf.length} 字节` };
          } },
          // 验的是**数据层**：歌词接口能不能拿到 + yrc 逐字轨能不能解析出行。
          // 别再写成"逐字歌词"这种功能名 —— 逐字染色渲染已下线，检查名字要如实。
          { id: 'lyric', name: '歌词接口（含 yrc 逐字数据解析）', net: true, run: async () => {
            const r = await e.netease.search('孤勇者 陈奕迅', { limit: 1 });
            if (!r.ok || !r.songs.length) return { ok: false, detail: `前置搜索未成功：${r.msg || '无结果'}` };
            const ly = await e.netease.lyric(r.songs[0].id);
            const tl = buildTimeline(ly);
            const w = tl.lines.filter((l) => l.karaoke === 'word').length;
            return { ok: ly.ok && tl.lines.length > 0, detail: `${tl.lines.length} 行，其中逐字 ${w} 行` };
          } },
          { id: 'songUrl', name: '取播放地址（并识别试听片段）', net: true, run: async () => {
            const r = await e.netease.search('孤勇者 陈奕迅', { limit: 1 });
            if (!r.ok || !r.songs.length) return { ok: false, detail: `前置搜索未成功：${r.msg || '无结果'}` };
            const u = await e.netease.songUrl(r.songs[0].id);
            const tip = !u.ok ? (u.msg || '无地址')
              : u.trial ? `⚠ 仅 ${u.trialEnd || 45} 秒试听（未登录/非会员）` : `完整 ${u.br} bps（${u.path}）`;
            return { ok: u.ok, detail: tip };
          } },
          { id: 'login', name: '登录态', net: true, run: async () => {
            const acc = await e.netease.account();
            const nick = acc && acc.profile && acc.profile.nickname;
            return { ok: true, detail: nick ? `已登录：${nick}` : '未登录（会员曲只能试听；可在控制台扫码登录）' };
          } },
          { id: 'plResolve', name: '歌单 ID/链接解析', net: true, run: async () => {
            const a = await e.netease.resolvePlaylistId('3778678');
            const b = await e.netease.resolvePlaylistId('https://music.163.com/playlist?id=3778678');
            return { ok: a.ok && b.ok && a.id === b.id, detail: `${a.via} / ${b.via} → ${a.id}` };
          } },
        ],
      },

      // ---------------------------------------------------------- 联网：B站
      {
        id: 'netBili', name: '联网·B站', desc: 'WBI/取流/代理/搜索/弹幕',
        checks: [
          { id: 'wbi', name: 'WBI 签名可取到密钥', net: true, run: async () => {
            const k = await e.bili.signer.key(true);
            return { ok: !!k && k.length === 32, detail: 'mixin_key ' + String(k).slice(0, 12) + '…' };
          } },
          { id: 'video', name: '视频信息（cid/时长/封面）', net: true, run: async () => {
            const v = await e.bili.videoInfo('BV1K44y1e7gv');
            return { ok: !!v.cid && v.duration > 0, detail: `${v.title.slice(0, 22)}｜${v.duration}s｜封面${v.cover ? '有' : '无'}` };
          } },
          { id: 'playurl', name: '取音频流', net: true, run: async () => {
            const v = await e.bili.videoInfo('BV1K44y1e7gv');
            const p = await e.bili.playurl(v.bvid, v.cid);
            return { ok: p.audios.length > 0, detail: `${p.audios.length} 条：${p.audios.map((a) => a.label).join('/')}` };
          } },
          { id: 'proxyReferer', name: '代理注入 Referer 后可拉流（206）', net: true, run: async () => {
            const v = await e.bili.videoInfo('BV1K44y1e7gv');
            const a = await e.bili.bestAudio(v.bvid, v.cid);
            const url = `${base}/stream/bili?url=${encodeURIComponent(a.url)}`;
            const r = await fetch(url, { headers: { Range: 'bytes=0-2047' } });
            const buf = Buffer.from(await r.arrayBuffer());
            const magic = buf.length >= 8 ? buf.slice(4, 8).toString() : '';
            return { ok: (r.status === 206 || r.status === 200) && ['ftyp', 'styp', 'moof'].includes(magic), detail: `HTTP ${r.status}，容器 ${magic}` };
          } },
          { id: 'biliCover', name: 'B站封面经本地代理可取到图', net: true, run: async () => {
            const v = await e.bili.videoInfo('BV1K44y1e7gv');
            const proxied = e.coverUrlFor({ source: 'bilibili', cover: v.cover, bvid: v.bvid });
            if (!proxied.includes('/stream/img')) return { ok: false, detail: '封面未走本地代理：' + proxied.slice(0, 60) };
            const r = await fetch(proxied);
            const buf = Buffer.from(await r.arrayBuffer());
            return { ok: r.status === 200 && buf.length > 500, detail: `HTTP ${r.status}，${buf.length} 字节（缩略图）` };
          } },
          { id: 'biliSearch', name: '视频搜索', net: true, run: async () => {
            const r = await e.bili.searchVideo('孤勇者 MV', { pageSize: 3 });
            return { ok: r.ok && r.results.length > 0, detail: r.results[0] ? r.results[0].title.slice(0, 28) : r.msg };
          } },
          /**
           * 字幕接口。**判定只看"接口通不通"**，不看字幕条数 ——
           * 绝大多数视频本来就没有字幕，那不算故障；而"未登录时恒为空"是 B站的
           * 接口行为（need_login_subtitle），不是我们能修的 bug。
           * 这个自检的价值在于**把"是不是登录态的问题"直接写出来**，省得再猜。
           */
          { id: 'subtitle', name: '视频字幕接口（未登录时为空，需登录 B站）', net: true, run: async () => {
            const v = await e.bili.videoInfo('BV1K44y1e7gv');
            const sub = await e.bili.subtitles(v.bvid, v.cid, { fetchContent: false });
            if (!sub.ok) return { ok: false, detail: '接口失败：' + (sub.msg || '') };
            const logged = !!(e.config.bilibili && e.config.bilibili.cookie);
            return {
              ok: true,
              detail: `接口 OK｜登录态 ${logged ? '有' : '无'}｜字幕轨 ${sub.subtitles.length} 条`
                + (sub.needLogin && !sub.subtitles.length ? '（接口要求登录：未登录拿不到字幕列表）' : ''),
            };
          } },
          { id: 'danmaku', name: '弹幕连接（连上即算通过）', net: true, run: async () => {
            const rid = (e.config.bilibili && e.config.bilibili.roomId) || '545068';
            const { DanmakuClient } = require('../core/bilibili/danmaku');
            const dc = new DanmakuClient({ roomId: rid, logger: () => {} });
            let got = 0;
            dc.on('danmaku', () => { got++; });
            await dc.connect();
            await sleep(6000);
            const info = { room: dc.roomId, hosts: dc.hosts.length, packets: dc.stats.received, danmaku: dc.stats.danmaku };
            dc.close();
            return {
              ok: dc.stats.received > 0,
              detail: `房间 ${info.room}｜服务器 ${info.hosts} 个｜6 秒收到 ${info.packets} 个数据包 / ${info.danmaku} 条弹幕`,
            };
          } },
        ],
      },

      // ---------------------------------------------------------- 联网：本地
      {
        id: 'netLocal', name: '联网·本地曲库', desc: '扫描、歌词来源、封面、Range',
        checks: [
          { id: 'scan', name: '扫描曲库目录', net: true, run: async () => {
            const dirs = e.config.local.dirs || [];
            if (!dirs.length) return { ok: true, detail: '未配置本地曲库目录（跳过，属正常）' };
            const t = await e.local.scan({ force: true });
            return { ok: t.length >= 0, detail: `${dirs.length} 个目录，共 ${t.length} 首` };
          } },
          { id: 'localLyrics', name: '本地歌词与封面提取', net: true, run: async () => {
            const t = e.local.tracks[0];
            if (!t) return { ok: true, detail: '曲库为空（跳过）' };
            const ly = await e.local.lyrics(t.file);
            const cv = await e.local.prepareCover(t.file);
            return { ok: true, detail: `《${t.name}》歌词来源=${ly.source}，封面=${cv ? '有' : '无'}` };
          } },
        ],
      },
    ];
  }
}

module.exports = { SelfTest };
