/**
 * B站 WBI 签名
 * =============
 * 2026-09-25 实测：`getDanmuInfo` 不带 WBI 直接返回 -352（风控），
 * 签名后**完全免登录**返回 code:0 + token + host_list。
 * 因此 WBI 是本项目接入 B站的核心前置。
 *
 * 算法：
 *   1) GET /x/web-interface/nav → data.wbi_img.{img_url, sub_url}
 *   2) 取两个 URL 的文件名去掉扩展名，拼接成 raw
 *   3) 按固定 64 位置换表 MIXIN 重排 raw，取前 32 位 = mixin_key
 *   4) 参数按 key 排序 → urlencode → 拼 mixin_key → md5 = w_rid，并加 wts
 */
'use strict';

const crypto = require('crypto');

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

/** 从两个 URL 算出 mixin_key */
function mixinKeyFromUrls(imgUrl, subUrl) {
  const pick = (u) => String(u).split('/').pop().split('.')[0];
  const raw = pick(imgUrl) + pick(subUrl);
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

/** 对参数签名，返回可直接拼到 URL 的 query string */
function signParams(params, mixinKey, wts = Math.floor(Date.now() / 1000)) {
  const p = { ...params, wts: String(wts) };
  const query = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  p.w_rid = md5(query + mixinKey);
  return Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`)
    .join('&');
}

/**
 * 带缓存与失效重取的 WBI 签名器。
 * mixin_key 每天会变，这里用 TTL 兜住，遇到 -352/-403 可强制刷新。
 */
class WbiSigner {
  constructor({ ttl = 6 * 3600 * 1000, log = () => {} } = {}) {
    this.ttl = ttl;
    this.log = log;
    this.mixinKey = null;
    this.fetchedAt = 0;
  }

  async refresh() {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    });
    const json = await res.json();
    const img = json && json.data && json.data.wbi_img;
    if (!img || !img.img_url || !img.sub_url) throw new Error('nav 接口未返回 wbi_img：' + JSON.stringify(json).slice(0, 160));
    this.mixinKey = mixinKeyFromUrls(img.img_url, img.sub_url);
    this.fetchedAt = Date.now();
    this.log('[wbi] mixin_key 已刷新:', this.mixinKey);
    return this.mixinKey;
  }

  async key(force = false) {
    if (force || !this.mixinKey || Date.now() - this.fetchedAt > this.ttl) await this.refresh();
    return this.mixinKey;
  }

  /** 对 url+params 签名并返回完整 URL */
  async signUrl(baseUrl, params, force = false) {
    const k = await this.key(force);
    const qs = signParams(params, k);
    return baseUrl.includes('?') ? `${baseUrl}&${qs}` : `${baseUrl}?${qs}`;
  }
}

/** 通用 B站 JSON 请求（自动带 Referer/UA，解析 code） */
async function biliFetch(url, { headers = {}, timeout = 15000, raw = false, method = 'GET', body } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      body,
      signal: ac.signal,
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...headers },
      redirect: 'follow',
    });
    if (raw) return res;
    const json = await res.json();
    return { ok: json.code === 0, code: json.code, msg: json.message || json.msg, data: json.data, _json: json };
  } catch (e) {
    return { ok: false, code: -1, msg: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { WbiSigner, signParams, mixinKeyFromUrls, biliFetch, UA, MIXIN_TAB };
