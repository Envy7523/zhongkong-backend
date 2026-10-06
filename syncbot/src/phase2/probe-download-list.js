'use strict';
/**
 * 下载清单页结构探测 + 目标行唯一识别（**只读**：不提交导出、不点击下载）
 *   node src/phase2/probe-download-list.js --date=2026-09-17
 * 输出：行/状态/操作三要素是否可唯一识别；不可识别即非零退出（调用方据此不得提交导出）。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const client = require('./client');
const flow = require('./meituan-flow');
const selectors = require('./selectors');
const config = require('../config');
const TC = require('../task-context');
const { createTaskLogger } = require('../logger');

const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
const BUSINESS_DATE = String(args.date || '');
if (!/^\d{4}-\d{2}-\d{2}$/.test(BUSINESS_DATE)) { console.error('用法: node src/phase2/probe-download-list.js --date=YYYY-MM-DD'); process.exit(2); }
const TASK_ID = `probe-dl-${Date.now().toString(36)}`;
const CTX = TC.createContext('cashier_composite', { platform: 'meituan', taskId: TASK_ID, businessDate: BUSINESS_DATE });
const logger = createTaskLogger('phase2-probe-download-list', { reportType: CTX.reportType, platform: CTX.platform, taskId: TASK_ID, businessDate: BUSINESS_DATE });
const sel = selectors.load();
const S = (k) => selectors.get(sel, k);
const rules = config.load('meituan-rules');

(async () => {
  const out = { task_id: TASK_ID, business_date: BUSINESS_DATE, report_type: CTX.reportType, read_only: true, clicked_export: false, clicked_download: false };
  const dl = rules.download_list_locator || {};
  const target = dl.url_assertion && dl.url_assertion.full_url ? dl.url_assertion.full_url : dl.url;

  // 仅为本 task 临时开启 download_list；无论成败在 finally 复位
  const apFile = path.join(P.runtime, 'approvals.json');
  const apBefore = JSON.parse(fs.readFileSync(apFile, 'utf8'));
  out.approvals_before = { export_submit: apBefore.export_submit, download_list: apBefore.download_list, download_file: apBefore.download_file };
  fs.writeFileSync(apFile, JSON.stringify(Object.assign({}, apBefore, { download_list: true, updated_at: new Date().toISOString().slice(0, 10), temporary_for_task: TASK_ID }), null, 2));
  out.approvals_temp = { download_list: true };
  await client.taskBegin(TASK_ID, { owner: 'probe-download-list', report_type: CTX.reportType, business_date: BUSINESS_DATE });
  try {
    const g = await flow.gotoAndAssert({ url: target, expectFullUrl: target, purpose: 'download_list', businessDate: BUSINESS_DATE, taskId: TASK_ID, nn: '01', step: 'download-list', reportType: CTX.reportType });
    out.goto = { ok: g.ok, url: g.url, url_assert: g.url_assert };
    logger.info('probe.download_list.goto', { ok: g.ok, url: g.url });
    await flow.waitForContent({ texts: ['下载'], timeoutMs: 30000, label: 'dl_ready' }).catch(() => {});
    const rows = await client.call('downloadRows', { maxRows: 60 }, { timeoutMs: 60000 });
    const best = rows && rows.best ? rows.best : null;
    out.frame_count = rows ? rows.frameCount : 0;
    out.row_count = best ? best.row_count : 0;
    out.header_hint = best ? best.header_hint : null;
    out.page_has_export_done = best ? best.page_has_export_done : null;
    out.page_text_head = best ? best.page_text_head : null;
    out.rows = best ? best.rows.map((r) => ({ cells: r.cells, text: r.text.slice(0, 160), control_texts: r.control_texts, rect: r.rect })) : [];
    // 目标行候选：含报表名 + 目标日期
    const d1 = BUSINESS_DATE, d2 = BUSINESS_DATE.replace(/-/g, '/');
    const cand = (best ? best.rows : []).filter((r) => /综合营业统计/.test(r.text) && (r.text.includes(d1) || r.text.includes(d2)));
    out.candidates = cand.length;
    out.candidate_rows = cand.map((r) => ({ cells: r.cells, control_texts: r.control_texts }));
    const statusWords = ['导出完成', '导出中', '生成中', '等待中', '失败', '已过期'];
    out.status_words_present = statusWords.filter((w) => (best ? best.page_text_head : '').includes(w) || (best ? best.rows.some((r) => r.text.includes(w)) : false));
    out.action_present = best ? best.rows.some((r) => r.control_texts.includes('下载')) : false;
    out.unique_row_identifiable = cand.length === 1;
    out.ok = !!(g.ok && best && cand.length >= 1 && out.action_present !== undefined);
    out.verdict = {
      three_elements: {
        row: cand.length >= 1 ? `可识别（候选 ${cand.length} 行）` : '未识别到含「综合营业统计 + 目标日期」的行',
        status: out.status_words_present.length ? `可识别（出现状态词：${out.status_words_present.join('、')}）` : '未识别到状态文案',
        action: (best && best.rows.some((r) => r.control_texts.includes('下载'))) ? '可识别（行内存在「下载」操作）' : '未识别到行内「下载」操作',
      },
      can_proceed_to_export: !!(best && (best.rows.some((r) => r.control_texts.includes('下载')) || out.status_words_present.length > 0)),
    };
  } catch (e) {
    out.error = e.message;
    out.error_stack = String(e.stack || '').split('\n').slice(0, 6);
    logger.error('probe.download_list.failed', { error: out.error });
    try { await flow.screenshot(CTX, '99', 'probe-download-list-failed'); } catch (_) {}
  } finally {
    await client.taskEnd(TASK_ID).catch(() => {});
    // 无条件复位 download_list
    try {
      const ap = JSON.parse(fs.readFileSync(apFile, 'utf8'));
      fs.writeFileSync(apFile, JSON.stringify(Object.assign({}, ap, { export_submit: false, download_list: false, download_file: false, updated_at: new Date().toISOString().slice(0, 10), temporary_for_task: null }), null, 2));
      out.approvals_after = { export_submit: false, download_list: false, download_file: false };
    } catch (e2) { out.approvals_reset_error = e2.message; }
  }
  const dir = path.join(P.state, 'selectors-dump');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `probe-download-list-${TASK_ID}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log('DUMP=' + file);
  process.exit(out.ok ? 0 : 1);
})().catch((e) => { console.error('PROBE_FAILED', e.message); process.exit(2); });
