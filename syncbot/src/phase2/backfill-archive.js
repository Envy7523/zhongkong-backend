'use strict';
/**
 * 历史文件补录归档（独立补录任务；**不改写失败的实时任务状态**）
 *   node src/phase2/backfill-archive.js --report-type=cashier_composite --date=2026-09-17 --sha256=<sha> --confirm-backfill
 * 约束：仅复制、不移动/删除/改名源文件；按 SHA-256 幂等；同名绝不覆盖；不导入/不写库/不推送/不建 timer。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../paths');
const TC = require('../task-context');
const config = require('../config');
const V = require('./report-a-file-validate');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
const REPORT_TYPE = String(args['report-type'] || '');
const BD = String(args.date || '');
const EXPECT_SHA = String(args.sha256 || '');
const SRC = String(args.src || '/opt/zhongkong-sync-bot/downloads/meituan/_incoming/鹅太公_综合营业统计_20260919_0003_1789747388617.xlsx');
if (!args['confirm-backfill']) { console.log(JSON.stringify({ ok: false, refused: true, reason: '缺少 --confirm-backfill' }, null, 2)); process.exit(2); }
if (REPORT_TYPE !== 'cashier_composite' || BD !== '2026-09-17' || !/^[0-9a-f]{64}$/.test(EXPECT_SHA)) {
  console.log(JSON.stringify({ ok: false, refused: true, reason: '参数不精确：需 --report-type=cashier_composite --date=2026-09-17 --sha256=<64hex>' }, null, 2)); process.exit(2);
}
const ctx = TC.createContext(REPORT_TYPE, { platform: 'meituan', taskId: 'backfill-manual', businessDate: BD });
const out = { mode: 'historical_backfill', report_type: REPORT_TYPE, business_date: BD, source_path: SRC, expected_sha256: EXPECT_SHA };
try {
  if (!fs.existsSync(SRC)) throw new Error(`源文件不存在：${SRC}`);
  const st = fs.statSync(SRC);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(SRC)).digest('hex');
  out.source = { size: st.size, mtime: st.mtime.toISOString(), sha256: sha };
  if (sha !== EXPECT_SHA) throw new Error(`源文件 SHA-256 不匹配：实际 ${sha} ≠ 期望 ${EXPECT_SHA}`);

  // 完整文件校验（业务日期以 Excel 内营业日期与第2行元数据为准）
  const mp = JSON.parse(fs.readFileSync(path.join(P.config, 'store-mapping.json'), 'utf8')).mappings || {};
  const names = Object.keys(mp).filter((k) => mp[k] && mp[k].confirmed === true);
  // 动态口径：历史样本也不再比对固定门店数；唯一有效门店数由文件自报（>=1）+ 台账精确映射判定
  const v = V.validateReportAFile(SRC, {
    businessDate: BD, expectedStores: null, declaredDynamic: null,
    expectedStoreNames: names.length ? names : undefined,
    storeMapping: { status: 'confirmed', mappings: mp },
  });
  out.validation = { ok: v.ok, errors: v.errors, store_count: v.store_count, row2_items: (v.row2_items || []).map((x) => `${x.ok ? 'OK' : 'FAIL'}:${x.name}`) };
  if (!v.ok) throw new Error(`文件校验未通过：${JSON.stringify(v.errors)}`);

  const destDir = P.dayDownloads('meituan', REPORT_TYPE, BD);
  const metaFile = P.archiveMetaFile('meituan', REPORT_TYPE, BD);
  const bfFile = path.join(P.root, 'state', 'backfills', 'meituan', REPORT_TYPE, BD, `${sha}.json`);
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(path.dirname(metaFile), { recursive: true });
  fs.mkdirSync(path.dirname(bfFile), { recursive: true });

  // 幂等：该 sha 已登记 → 直接返回
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) {}
  const already = (meta.backfills || []).find((b) => b.sha256 === sha);
  if (already || fs.existsSync(bfFile)) {
    out.ok = true; out.idempotent = true; out.archived = already || { note: 'backfill 状态文件已存在' };
    console.log(JSON.stringify(out, null, 2)); process.exit(0);
  }

  // 仅复制；同名绝不覆盖
  const baseName = path.basename(SRC);
  let dest = path.join(destDir, baseName);
  if (fs.existsSync(dest)) {
    const same = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === sha;
    if (!same) {
      const ext = path.extname(baseName), stem = baseName.slice(0, baseName.length - ext.length);
      const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
      dest = path.join(destDir, `${stem}.backfill.${ts}${ext}`);
      let n = 1;
      while (fs.existsSync(dest)) { dest = path.join(destDir, `${stem}.backfill.${ts}-${n}${ext}`); n += 1; }
    }
  }
  if (!fs.existsSync(dest)) fs.copyFileSync(SRC, dest);
  const dst = fs.statSync(dest);
  const dstSha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  out.archived = { path: dest, size: dst.size, sha256: dstSha, sha_matches_source: dstSha === sha, copied: true };

  const rec = {
    mode: 'historical_backfill', provenance: 'passive_export_after_submit',
    not_a_realtime_success: true, ready_to_push: false, task_id: null,
    report_type: REPORT_TYPE, business_date: BD,
    source_path: SRC, source_size: st.size, source_mtime: st.mtime.toISOString(),
    sha256: sha, archived_path: dest, archived_size: dst.size,
    validation: { ok: v.ok, store_count: v.store_count, errors: v.errors },
    backfilled_at: new Date().toISOString(),
    note: '导出后被动落盘的真实文件；原实时任务在后续阶段失败并保持 FAILED，本记录不代表实时成功',
  };
  fs.writeFileSync(bfFile, JSON.stringify(rec, null, 2));
  meta.backfills = (meta.backfills || []).concat([rec]);
  meta.updated_at = rec.backfilled_at;
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  out.backfill_state_file = bfFile;
  out.archive_meta_file = metaFile;
  out.ok = true;
} catch (e) {
  out.ok = false; out.error = e.message;
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
