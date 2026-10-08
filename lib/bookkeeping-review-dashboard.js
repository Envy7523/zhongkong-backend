'use strict';
const fs = require('fs');
const path = require('path');
const plan = {
  shift(date, amount) { const value = new Date(date + 'T00:00:00Z'); value.setUTCDate(value.getUTCDate() + amount); return value.toISOString().slice(0, 10); },
  dateRange(from, to) { const days = []; for (let date = from; date <= to; date = this.shift(date, 1)) { days.push(date); if (days.length > 62) throw new Error('invalid_review_range'); } return days; },
};
function localDate(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function readManifest(root, key) {
  try {
    const file = path.join(root, key, 'meituan/pos_bookkeeping_daily/review-manifest.json');
    if (fs.statSync(file).size > 4 * 1024 * 1024) return { error: '记录过大，无法读取' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.run_key === key ? value : { error: '执行记录编号不一致' };
  } catch (e) {
    return e.code === 'ENOENT' ? null : { error: '执行记录不可读取' };
  }
}
function summarize(db, root, runDate, from, to, now, settings) {
  const key = `daily-${runDate}`, dates = plan.dateRange(from, to);
  const manifest = readManifest(root, key);
  const rows = db.queryAll(`SELECT business_date,status,row_count,total_cents,differences_json,checked_at
    FROM pos_bookkeeping_daily_reviews WHERE review_key=? AND business_date>=? AND business_date<=? ORDER BY business_date`, [key, from, to]);
  const byDate = new Map(rows.map(r => [r.business_date, r]));
  const failed = new Map((Array.isArray(manifest?.failed) ? manifest.failed : []).map(r => [r.business_date, r.reason]));
  const details = dates.map(date => {
    const row = byDate.get(date);
    let differences = null;
    if (row) { try { differences = JSON.parse(row.differences_json).length; } catch { /* Unknown remains unknown. */ } }
    const ok = row && ['changed', 'unchanged'].includes(row.status);
    return { date, status: ok ? 'success' : failed.has(date) ? 'failed' : 'missing',
      changed: row?.status === 'changed', differences, row_count: row?.row_count ?? null,
      checked_at: row?.checked_at || null, reason: failed.has(date) ? failureLabel(failed.get(date)) : null };
  });
  const completed = details.filter(r => r.status === 'success').length;
  const errors = details.filter(r => r.status === 'failed').length;
  let status = completed === dates.length && errors === 0 ? 'success' : errors ? 'partial' : completed ? 'partial' : 'missing';
  if (manifest?.status === 'running' && status !== 'success') status = 'running';
  if (manifest?.error) status = 'unknown';
  if (status === 'missing' && runDate === localDate(now)) {
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    if (!settings.enabled) status = 'disabled';
    else if (time < settings.run_time) status = 'pending';
  }
  return { run_date: runDate, from, to, status, expected: dates.length, completed, failed: errors,
    changed_days: details.filter(r => r.changed).length,
    differences: details.reduce((sum, r) => sum + (r.differences || 0), 0),
    started_at: manifest?.started_at || null, finished_at: manifest?.finished_at || null,
    last_checked_at: rows.map(r => r.checked_at).filter(Boolean).sort().at(-1) || null,
    warning: manifest?.error || (manifest?.status === 'success' && completed !== dates.length ? '执行记录标记成功，但复核落库记录不完整' : null), details };
}
function dashboard(db, { now = new Date(), root = path.join(process.env.SYNCBOT_ROOT || '/opt/zhongkong-sync-bot', 'state/tasks/reviews') } = {}) {
  const today = localDate(now);
  const row = db.queryOne("SELECT enabled,run_time FROM report_sync_plans WHERE report_type='pos_bookkeeping_daily'");
  const settings = { enabled: Number(row?.enabled) === 1, run_time: row?.run_time || '02:00', timezone: 'Asia/Shanghai' };
  const daily = summarize(db, root, today, plan.shift(today, -7), plan.shift(today, -1), now, settings);
  const first = today.slice(0, 7) + '-01', lastMonthEnd = plan.shift(first, -1);
  const monthly = summarize(db, root, first, lastMonthEnd.slice(0, 7) + '-01', lastMonthEnd, now, settings);
  const history = Array.from({ length: 7 }, (_, i) => {
    const date = plan.shift(today, -i);
    const { details, ...summary } = summarize(db, root, date, plan.shift(date, -7), plan.shift(date, -1), now, settings);
    return summary;
  });
  return { ok: true, today, settings, daily, monthly, history };
}
function failureLabel(reason) {
  const known = { verified_source_modified_locally: '已复核的来源明细被人工修改，需确认后处理',
    review_download_failed: '报表下载失败', review_start_failed: '复核启动失败',
    review_state_changed: '检查期间明细发生变化', review_archive_invalid: '报表文件校验失败',
    legacy_provenance_ambiguous: '历史明细来源不明确，需人工核实', review_login_failed: '导入账号登录失败' };
  return known[reason] || '复核失败，需查看运行记录处理';
}
module.exports = { dashboard, summarize, localDate };
