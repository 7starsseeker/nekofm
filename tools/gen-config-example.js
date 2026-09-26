#!/usr/bin/env node
/**
 * 从源码生成 `config.example.json`
 * ================================
 * 配置项一旦改代码就会漂移，手写一份示例必然过期。所以示例**从
 * `src/core/config.js` 的 DEFAULT_CONFIG 直接生成**，改完配置跑一下即可。
 *
 * 同时做脱敏：一切"使用者自己的东西"（cookie / 密钥 / 设备 / 直播间号）
 * 一律清空，并给需要用户自己填的项加上显式占位说明。
 *
 * 用法：
 *   node tools/gen-config-example.js            # 写 config.example.json
 *   node tools/gen-config-example.js --check     # 只比对，不写盘（CI 用）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'config.example.json');
const CHECK = process.argv.includes('--check');

const { DEFAULT_CONFIG } = require(path.join(ROOT, 'src', 'core', 'config.js'));

/** 深拷贝 + 清掉一切属于使用者的值（保留结构与默认值） */
const SECRET_KEYS = new Set([
  'cookie', 'accessKeyId', 'accessKeySecret', 'appId', 'roomOwnerAuthCode',
  'deviceId', 'deviceLabel', 'playlistId',
]);

function sanitize(node, keyPath = '') {
  if (Array.isArray(node)) return node.map((v, i) => sanitize(v, `${keyPath}[${i}]`));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = sanitize(v, keyPath ? `${keyPath}.${k}` : k);
    return out;
  }
  if (typeof node === 'string' && SECRET_KEYS.has(keyPath.split('.').pop())) return '';
  return node;
}

const example = sanitize(DEFAULT_CONFIG);

// 需要使用者自己填的地方给个可读占位（不是默认值，纯粹方便照抄）
example.bilibili.roomId = '';
example.local.dirs = [];
example.overlay.infoBar = example.overlay.infoBar || {};

const text = JSON.stringify(example, null, 2) + '\n';

if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== text) {
    console.error('config.example.json 与 src/core/config.js 的 DEFAULT_CONFIG 不一致。');
    console.error('跑 `npm run config:example` 重新生成。');
    process.exit(1);
  }
  console.log('config.example.json 与 DEFAULT_CONFIG 一致 ✓');
  process.exit(0);
}

fs.writeFileSync(OUT, text);
console.log(`已生成 ${path.relative(ROOT, OUT)}（来自 src/core/config.js 的 DEFAULT_CONFIG，敏感字段已清空）`);
