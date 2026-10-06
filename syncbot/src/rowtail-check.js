'use strict';
// 只读：核查数据区末行是否为「合计」行，并给出每行的门店标识与前几列取值
const fs = require('fs');
const XLSX = require('xlsx');
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('用法: node rowtail-check.js <xlsx>'); process.exit(2); }
const wb = XLSX.readFile(file, { cellDates: false, raw: true });
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
console.log('工作表:', wb.SheetNames[0], ' range:', ws['!ref'], ' 总行数:', rows.length);
console.log('--- 表头块 row1..row5 的前 13 列（A..M）---');
for (let i = 0; i < 5; i++) {
  console.log(` row${i + 1}: ` + (rows[i] || []).slice(0, 13).map((v, c) => `${'ABCDEFGHIJKLM'[c]}=${v === '' ? '·' : v}`).join(' '));
}
console.log('--- 数据区逐行（A城市 / B门店名称 / C营业日期 / H营业额 / L订单量）---');
for (let i = 5; i < rows.length; i++) {
  const r = rows[i] || [];
  console.log(` row${String(i + 1).padStart(2)}: A=${JSON.stringify(r[0])} B=${JSON.stringify(r[1])} C=${JSON.stringify(r[2])} H=${r[7]} L=${r[11]}`);
}
const last = rows[rows.length - 1] || [];
const isTotal = /合计|总计|汇总|total/i.test(String(last[0] || '') + String(last[1] || '') + String(last[2] || ''));
console.log('--- 判定 ---');
console.log(' 末行标识 A/B/C:', JSON.stringify(last[0]), JSON.stringify(last[1]), JSON.stringify(last[2]));
console.log(' 末行是否"合计"行:', isTotal);
console.log(' 门店数据行数(排除可能的合计行):', isTotal ? rows.length - 5 - 1 : rows.length - 5);
