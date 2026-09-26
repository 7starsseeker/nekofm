/**
 * 网易云 weapi/eapi 加密层（零依赖，只用 Node 内置 crypto）
 * ======================================================
 * weapi 流程：
 *   1) 明文 JSON → 用固定 nonce key 做一次 AES-128-CBC → 得到 hex
 *   2) 再用随机 16 字符 secretKey 做一次 AES-128-CBC → 得到 params
 *   3) 把 secretKey 反转后做 RSA(no padding) → 得到 encSecKey
 *   4) POST form: { params, encSecKey }
 *
 * eapi 流程（部分新接口如 lyric/v1 的加密版、歌曲详情 v3 用它）：
 *   digest = md5(`nobody${url}use${json}md5forencrypt`)
 *   data   = `${url}-36cd479b6b5-${json}-36cd479b6b5-${digest}`
 *   params = AES-128-ECB(key='e82ckenh8dichen8', data).hex
 *
 * 两个都实现，运行时按接口选择。
 */
'use strict';

const crypto = require('crypto');

const NONCE = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const PUB_KEY = '010001';
const MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4' +
  'ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813' +
  'cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const EAPI_KEY = 'e82ckenh8dichen8';

function aesCbc(text, key) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(IV, 'utf8'));
  return Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]).toString('hex');
}

/** RSA 无填充（网易云用的是裸幂运算，等价于 no-padding） */
function rsaNoPad(text, pubKey, modulus) {
  const reversed = Buffer.from(text, 'utf8').reverse().toString('hex');
  const m = BigInt('0x' + modulus);
  const e = BigInt('0x' + pubKey);
  const base = BigInt('0x' + reversed);
  let out = 1n;
  let b = base % m;
  let exp = e;
  while (exp > 0n) {
    if (exp & 1n) out = (out * b) % m;
    b = (b * b) % m;
    exp >>= 1n;
  }
  return out.toString(16).padStart(256, '0');
}

function randomSecret(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  const buf = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
  return s;
}

/** 生成 weapi 表单字段 */
function weapi(params) {
  const text = JSON.stringify(params);
  const secret = randomSecret(16);
  const paramsEnc = aesCbc(aesCbc(text, NONCE), secret);
  const encSecKey = rsaNoPad(secret, PUB_KEY, MODULUS);
  return { params: paramsEnc, encSecKey };
}

/** 生成 eapi 表单字段；url 必须是 /api/... 形态的接口路径 */
function eapi(url, params) {
  const json = JSON.stringify(params);
  const digest = crypto.createHash('md5').update(`nobody${url}use${json}md5forencrypt`).digest('hex');
  const data = `${url}-36cd479b6b5-${json}-36cd479b6b5-${digest}`;
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(EAPI_KEY, 'utf8'), null);
  const paramsEnc = Buffer.concat([c.update(Buffer.from(data, 'utf8')), c.final()]).toString('hex');
  return { params: paramsEnc, eapi: true };
}

/** eapi 响应解密（返回体是 AES-ECB 密文） */
function eapiDecrypt(hex) {
  const c = crypto.createDecipheriv('aes-128-ecb', Buffer.from(EAPI_KEY, 'utf8'), null);
  return Buffer.concat([c.update(Buffer.from(hex, 'hex')), c.final()]).toString('utf8');
}

module.exports = { weapi, eapi, eapiDecrypt, aesCbc, rsaNoPad, randomSecret };
