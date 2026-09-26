#!/usr/bin/env node
/**
 * 网易云请求对照探针（对比不同系统/网络环境下同一请求的返回差异）
 * 用法: node tools/diag-netease.js
 */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const URL_S = 'https://music.163.com/api/search/get/web?s=%E5%AD%A4%E5%8B%87%E8%80%85&type=1&limit=1';

async function probe(label, headers) {
  const t0 = Date.now();
  try {
    const r = await fetch(URL_S, { headers });
    const text = await r.text();
    let short = text.slice(0, 120);
    try { const j = JSON.parse(text); short = `code=${j.code} msg=${j.message || j.msg || ''} songs=${(j.result && j.result.songs || []).length}`; } catch { /* 原样 */ }
    console.log(`${label.padEnd(22)} HTTP ${r.status} ${Date.now() - t0}ms  ${short}`);
  } catch (e) {
    console.log(`${label.padEnd(22)} 异常 ${Date.now() - t0}ms  ${e.message}`);
  }
}

(async () => {
  console.log('平台:', process.platform, '| Node:', process.versions.node);
  console.log('URL :', URL_S);
  console.log('');
  await probe('裸请求', { 'User-Agent': UA });
  await probe('+Referer', { 'User-Agent': UA, Referer: 'https://music.163.com/' });
  await probe('+Referer+Origin', { 'User-Agent': UA, Referer: 'https://music.163.com/', Origin: 'https://music.163.com' });
  await probe('+Cookie(我们发的)', {
    'User-Agent': UA, Referer: 'https://music.163.com/', Origin: 'https://music.163.com',
    Cookie: 'os=pc; appver=2.10.6; osver=; deviceId=nekofm',
  });
  console.log('');
  // 隔 2 秒再打一次，看是否纯限流（时间维度）
  await new Promise((r) => setTimeout(r, 2000));
  await probe('2 秒后重试', { 'User-Agent': UA, Referer: 'https://music.163.com/' });
})();
