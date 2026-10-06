'use strict';
/** 定位 D1 失败项：打印完整 checks（不截断） */
const fs = require('fs');
const V = require('./report-a-file-validate');
const SAMPLE = '/opt/zhongkong-sync-bot/downloads/meituan/_incoming/鹅太公_综合营业统计_20260917_1153_1789617206572.xlsx';
const j = JSON.parse(fs.readFileSync('/opt/zhongkong-sync-bot/config/store-mapping.json', 'utf8'));
const names = Object.keys(j.mappings || {}).filter((k) => j.mappings[k] && j.mappings[k].confirmed === true);
console.log('sample exists:', fs.existsSync(SAMPLE));
console.log('mapping names:', names.length);
const r = V.validateReportAFile(SAMPLE, { businessDate: '2026-09-16', expectedStores: 22, expectedStoreNames: names });
console.log('ok=', r.ok, 'errors=', JSON.stringify(r.errors));
for (const [k, v] of Object.entries(r.checks)) {
  console.log(`  [${v.ok ? 'OK  ' : 'FAIL'}] ${k} :: ${v.detail}`);
}
console.log('store_count=', r.store_count);
console.log('sheet_names=', JSON.stringify(r.sheet_names));
console.log('--- store names from file (first 25) ---');
console.log(JSON.stringify(r.store_names, null, 1));
console.log('--- mapping names ---');
console.log(JSON.stringify(names, null, 1));
