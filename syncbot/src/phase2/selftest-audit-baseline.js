'use strict';
/**
 * audit-baseline 自检（**纯本地 fixture**；不访问美团、不导出、不导入、不写真实 ROOT）
 *
 * 目的：证明「历史审计基线对比」工具真的能发现问题，而不是永远返回 ok。
 * 因此本测试必须同时包含：
 *   - 正向用例：内容未变 → ok（含 4 行、5 行两种历史规模，证明不硬编码行数）
 *   - 反向用例：追加 / 改写末条 / 截断 / 改动中间行 / 文件消失 / 基线缺失 → 必须 not ok
 * 若只有正向用例，测试是空洞的。
 *
 * 运行：node src/phase2/selftest-audit-baseline.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AB = require('./audit-baseline');

const results = [];
const ck = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbot-auditbase-'));
const F = path.join(TMP, 'downloads-meituan.jsonl');

// 模拟历史：3 条早期记录 + 第 4 条真实下载（与真实文件同构）
const HIST4 = [
  { event: 'download_saved', at: '2026-09-17T03:43:40.797Z', size: 28184 },
  { event: 'download_saved', at: '2026-09-17T03:44:05.322Z', size: 28184 },
  { event: 'download_saved', at: '2026-09-17T03:53:45.228Z', size: 24565 },
  { event: 'download_saved', at: '2026-09-18T16:03:18.561Z', size: 24952 },
];
const HIST5 = HIST4.concat([{ event: 'download_saved', at: '2026-09-19T10:00:00.000Z', size: 30000 }]);
const write = (rows) => fs.writeFileSync(F, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const rm = () => { try { fs.unlinkSync(F); } catch (_) {} };

// ---- 正向：不硬编码行数（4 行 / 5 行均 ok）----
for (const [label, rows] of [['4 行（含第 4 条真实下载）', HIST4], ['5 行（历史继续增长）', HIST5]]) {
  write(rows);
  const v = AB.verifyUnchanged(AB.snapshot(F), AB.snapshot(F));
  ck(`B1 ${label}：内容未变 → ok`, v.ok, AB.summarize(v));
}

// ---- B2 追加一行 → 必须 not ok ----
write(HIST4);
const base4 = AB.snapshot(F);
write(HIST5);
let v = AB.verifyUnchanged(base4, AB.snapshot(F));
ck('B2 追加记录 → not ok 且报 line_count_changed',
  !v.ok && v.problems.includes('line_count_changed(4->5)') && v.problems.includes('content_changed'),
  `problems=${v.problems.join(',')}`);

// ---- B3 改写末条（第 4 条真实下载）→ 必须 not ok ----
write(HIST4);
const base3 = AB.snapshot(F);
const tampered = HIST4.slice();
tampered[3] = Object.assign({}, HIST4[3], { size: 1 });
write(tampered);
v = AB.verifyUnchanged(base3, AB.snapshot(F));
ck('B3 改写末条真实下载记录 → not ok 且报 historical_tail_lost',
  !v.ok && v.problems.includes('historical_tail_lost') && v.problems.includes('content_changed'),
  `problems=${v.problems.join(',')}`);

// ---- B4 截断（删掉末条真实下载）→ 必须 not ok ----
write(HIST4);
const base4b = AB.snapshot(F);
write(HIST4.slice(0, 3));
v = AB.verifyUnchanged(base4b, AB.snapshot(F));
ck('B4 删除末条真实下载（截断）→ not ok 且报 historical_tail_lost',
  !v.ok && v.problems.includes('historical_tail_lost'),
  `problems=${v.problems.join(',')}`);

// ---- B5 改动中间行但保留末条 → 仍必须 not ok（逐字节比对）----
write(HIST4);
const base5 = AB.snapshot(F);
const midChanged = HIST4.slice();
midChanged[0] = Object.assign({}, HIST4[0], { size: 999 });
write(midChanged);
v = AB.verifyUnchanged(base5, AB.snapshot(F));
ck('B5 改动中间行、末条保留 → not ok（逐字节比对生效）',
  !v.ok && v.problems.includes('content_changed') && v.tail_preserved === true,
  `problems=${v.problems.join(',')} tail_preserved=${v.tail_preserved}`);

// ---- B6 变更后文件消失 → not ok ----
write(HIST4);
const base6 = AB.snapshot(F);
rm();
v = AB.verifyUnchanged(base6, AB.snapshot(F));
ck('B6 审计文件被删除 → not ok 且报 after_missing', !v.ok && v.problems.includes('after_missing'), `problems=${v.problems.join(',')}`);

// ---- B7 基线缺失（测试开始时文件就不存在）→ not ok ----
rm();
v = AB.verifyUnchanged(AB.snapshot(F), AB.snapshot(F));
ck('B7 基线缺失（开始时文件不存在）→ not ok 且报 baseline_missing',
  !v.ok && v.problems.includes('baseline_missing'), `problems=${v.problems.join(',')}`);

// ---- B8 snapshot 只读且如实反映 ----
write(HIST4);
const s = AB.snapshot(F);
ck('B8 snapshot 如实反映行数与末条', s.exists && s.line_count === 4 && /2026-09-18T16:03:18\.561Z/.test(s.tail), `lines=${s.line_count} tail=${String(s.tail).slice(0, 80)}`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, tmp_root: TMP, total: results.length, failed: results.filter((r) => !r.ok).length, results }, null, 2));
process.exit(ok ? 0 : 1);
