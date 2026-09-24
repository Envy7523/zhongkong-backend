#!/usr/bin/env node
'use strict';
/**
 * 仅生成候选 server.js，不写入输入文件、更不部署。
 * 每次必须对实时取回的 server.js 重新生成，借唯一 route anchor 避免对漂移版本盲打补丁。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const input = arg('--input');
const outputDir = arg('--output-dir');
if (!input || !outputDir || process.argv.length !== 6) {
  console.error('usage: node prepare-syncbot-coverage-patch.js --input <server.js> --output-dir <dir>');
  process.exit(2);
}
const source = fs.readFileSync(input, 'utf8');
const anchor = "app.post('/api/internal/syncbot/events', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {";
const count = source.split(anchor).length - 1;
if (count !== 1) {
  console.error(JSON.stringify({ ok: false, reason: count === 0 ? 'anchor_missing' : 'anchor_not_unique', anchor_count: count }));
  process.exit(3);
}
if (source.includes("require('./lib/syncbot-coverage')")) {
  console.error(JSON.stringify({ ok: false, reason: 'ALREADY_PATCHED', anchor_count: count }));
  process.exit(4);
}
const block = `// Stage 1: coverage-only internal route. No schedule, webhook, timer, write, or task execution.\ntry {\n  const { mountCoverage } = require('./lib/syncbot-coverage');\n  mountCoverage({ app, express, db, audit: syncJobAudit });\n} catch (e) {\n  console.error('[syncbot-coverage] mount failed:', e.message);\n}\n\n`;
const patched = source.replace(anchor, block + anchor);
fs.mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, 'server.coverage-candidate.js');
fs.writeFileSync(output, patched, 'utf8');
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const result = {
  ok: true,
  source_bytes: Buffer.byteLength(source), source_sha256: sha(source),
  candidate_bytes: Buffer.byteLength(patched), candidate_sha256: sha(patched),
  added_lines: block.trimEnd().split('\n').length, anchor_count: count,
  candidate: path.basename(output), deployment_performed: false,
};
fs.writeFileSync(path.join(outputDir, 'coverage-server-patch.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(result));
