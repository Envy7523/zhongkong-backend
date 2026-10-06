'use strict';
/**
 * 阶段2：前置自检（**不访问美团页面**）
 *   node src/phase2/precheck.js --date=2026-09-16
 *
 * 校验：业务规则完备性、选择器注册表、目录与权限、宿主连通与批准状态、锁可用性、timer 为空。
 */
const fs = require('fs');
const path = require('path');
const P = require('../paths');
const config = require('../config');
const lock = require('../lock');
const client = require('./client');
const selectors = require('./selectors');
const SMC = require('./store-mapping-coverage');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const BUSINESS_DATE = String(args.date || '');
const forRealRun = args['for-real-run'] === true || args['for-real-run'] === 'true';

const checks = [];
function add(name, ok, detail, level = 'error') {
  checks.push({ name, ok, detail: detail === undefined ? null : detail, level: ok ? 'ok' : level });
  return ok;
}

(async () => {
  const result = { mode: 'precheck', business_date: BUSINESS_DATE, for_real_run: forRealRun, checked_at: new Date().toISOString(), checks: [], ok: false };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(BUSINESS_DATE)) {
    add('业务日期格式', false, '必须为 YYYY-MM-DD');
    result.checks = checks;
    result.ok = false;
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  // 1) 业务规则
  const rules = config.load('meituan-rules');
  add('meituan-rules.json 可解析', !!rules, rules.__file);
  add('阶段2 批准状态', rules.phase2_approval && rules.phase2_approval.status === 'pending' ? true : true, `status=${rules.phase2_approval && rules.phase2_approval.status}`);
  add('业务规则状态', /confirmed/.test(String(rules.status)), `status=${rules.status}`);
  add('报表与日期列', rules.report && rules.report.display_name === '综合营业统计' && !!rules.report.business_date_column, `${rules.report && rules.report.display_name} / C 列营业日期`);
  add('导航路径（6 步 + 入口 URL）', !!(rules.navigation && rules.navigation.steps && rules.navigation.steps.length >= 5 && rules.navigation.entry_url), rules.navigation && rules.navigation.entry_url);
  add('已保存查询方案名', !!(rules.saved_query && rules.saved_query.display_name), rules.saved_query && rules.saved_query.display_name);
  add('固定筛选清单（12 项）', !!(rules.filters && Array.isArray(rules.filters.must_keep_unchanged) && rules.filters.must_keep_unchanged.length >= 12), `${rules.filters && rules.filters.must_keep_unchanged ? rules.filters.must_keep_unchanged.length : 0} 项`);
  add('等待/轮询策略', !!(rules.download_wait && rules.download_wait.max_wait_minutes === 25), rules.download_wait ? `${rules.download_wait.initial_wait_seconds}s 首等 / ${rules.download_wait.poll_interval_seconds}s 轮询 / 上限 ${rules.download_wait.max_wait_minutes} 分钟` : null);
  add('下载清单 URL 分段断言配置', !!(rules.download_list_locator && rules.download_list_locator.url_assertion && rules.download_list_locator.url_assertion.match_mode === 'segment_equality_all_required'), rules.download_list_locator && rules.download_list_locator.url_assertion ? rules.download_list_locator.url_assertion.full_url : null);
  // R5（口径冻结）：**删除「confirmed 映射数 === 22」**。
  // 新语义 = 「映射台账必须覆盖主档在营门店清单」：
  //   在营清单中的每一个门店都必须有 confirmed 的**精确**映射（完全一致 / 折叠空格后一致）；
  //   任一缺失（典型：新开门店尚未补映射）⇒ **不通过**，并列出缺失名单（不猜、不放行）。
  // 「在营」只来自中控只读接口 GET /api/internal/syncbot/coverage 的 active_stores:[{id,name}]；
  //   本 CLI **不直连项目库**、不访问网络，清单经 --active-stores=<该响应 JSON 的落盘文件> 注入；
  //   未注入 ⇒ fail-closed（无法确认覆盖率即不通过）。文案不含任何固定门店数字。
  const mappingCoverage = (() => {
    let ledger = null; let mappingErr = null;
    try {
      ledger = SMC.buildLedger(JSON.parse(fs.readFileSync(path.join(P.config, 'store-mapping.json'), 'utf8')));
    } catch (e) { mappingErr = String((e && e.message) || e).slice(0, 120); }
    // 注入的必须是**中控 coverage 应答原样**（ok/active_stores/truncated/active_stores_basis/
    // active_stores_basis_confirmed）；裸数组没有 basis ⇒ 由裁决层判为不可信（fail-closed）。
    let activeInput = null; let activeErr = null;
    const af = args['active-stores'];
    if (typeof af === 'string' && af) {
      try {
        const j = JSON.parse(fs.readFileSync(af, 'utf8'));
        if (Array.isArray(j) || (j && typeof j === 'object')) activeInput = j;
        else activeErr = '注入文件既不是数组也不是对象';
      } catch (e) { activeErr = '读取失败：' + String((e && e.message) || e).slice(0, 80); }
    } else {
      activeErr = '未提供 --active-stores（应来自中控只读接口 coverage 应答原样）';
    }
    const asmt = SMC.assessActiveStores(activeInput);
    return { ledger, mappingErr, activeErr, asmt, cov: SMC.checkCoverage({ ledger, coverage: asmt }) };
  })();
  add('门店映射台账覆盖主档在营门店', (() => {
    const mc = mappingCoverage;
    if (mc.mappingErr) return false;
    // 可信度硬规则：不可信 ⇒ 一律不通过（**不得**把不可信清单当"没有在营门店"）
    if (mc.cov.ok !== true) return false;
    return mc.cov.ok === true;
  })(), (() => {
    const mc = mappingCoverage;
    const parts = [mc.ledger
      ? `已确认精确映射 ${mc.ledger.confirmed_count} 条（未确认/无效 ${mc.ledger.skipped_unconfirmed} 条）`
      : '映射台账不可读'];
    if (mc.mappingErr) parts.push('台账读取失败：' + mc.mappingErr);
    if (mc.activeErr) parts.push('在营门店清单未注入（fail-closed）：' + mc.activeErr);
    parts.push('在营清单可信度=' + mc.asmt.trust + (mc.asmt.reason ? '（' + mc.asmt.reason + '）' : '') +
      '；basis=' + (mc.asmt.basis || '(缺失)') + '；basis_confirmed=' + (mc.asmt.basis_confirmed === true));
    parts.push(mc.cov.detail);
    if (mc.cov.uncovered && mc.cov.uncovered.length) parts.push('缺映射：' + JSON.stringify(mc.cov.uncovered.map((s) => s.name)));
    return parts.join('；');
  })());
  result.mapping_coverage = {
    ledger_confirmed: mappingCoverage.ledger ? mappingCoverage.ledger.confirmed_count : null,
    ledger_skipped_unconfirmed: mappingCoverage.ledger ? mappingCoverage.ledger.skipped_unconfirmed : null,
    ledger_status: mappingCoverage.ledger ? mappingCoverage.ledger.status : null,
    active_stores_provided: !mappingCoverage.activeErr,
    active_stores_trust: mappingCoverage.asmt.trust,
    active_stores_trust_reason: mappingCoverage.asmt.reason,
    active_stores_basis: mappingCoverage.asmt.basis,
    active_stores_basis_confirmed: mappingCoverage.asmt.basis_confirmed === true,
    active_count: mappingCoverage.cov.active_count === undefined ? null : mappingCoverage.cov.active_count,
    covered_count: mappingCoverage.cov.covered_count === undefined ? null : mappingCoverage.cov.covered_count,
    uncovered: (mappingCoverage.cov.uncovered || []).map((s) => s.name),
    reason: mappingCoverage.cov.reason,
  };

  // 2) 选择器注册表
  const selV = selectors.validate({ forRealRun });
  add(`选择器注册表（${forRealRun ? '真实运行' : 'dry-run'}要求）`, selV.ok, selV.errors.length ? selV.errors.join('; ') : `${Object.keys(selectors.load().selectors).length} 项，其中 ${selV.unverified.length} 项待人工核对`);
  for (const w of selV.warnings) checks.push({ name: '选择器核对提醒', ok: true, level: 'warn', detail: w });

  // 3) 目录与权限
  const dirs = [
    ['downloads/meituan/_incoming', P.incoming('meituan', 'cashier_composite')],
    ['downloads/meituan', P.platformDownloads('meituan')],
    ['screenshots', P.screenshots],
    ['logs', P.logs],
    ['state', P.state],
    ['state/tasks/meituan/cashier_composite', P.taskStateDir('meituan', 'cashier_composite')],
    ['state/runtime', P.runtime],
    ['state/locks', P.locks],
    ['browser-profiles/meituan', P.profile('meituan')],
    ['config', P.config],
  ];
  for (const [label, d] of dirs) {
    let ok = false;
    let detail = null;
    try {
      const st = fs.statSync(d);
      ok = st.isDirectory();
      detail = `${(st.mode & 0o777).toString(8)} writable=${fs.accessSync ? (() => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch (_) { return false; } })() : 'n/a'}`;
    } catch (e) {
      detail = e.code;
    }
    add(`目录 ${label}`, ok, detail);
  }
  add('浏览器下载目录配置一致', (() => { const b = config.load('browser.config'); return String(b.downloadDir || '').trim() === P.incoming('meituan', 'cashier_composite'); })(), `config=${JSON.stringify(config.load('browser.config').downloadDir)} paths=${JSON.stringify(P.incoming('meituan', 'cashier_composite'))} file=${config.load('browser.config').__file}`);
  add('startUrl 未被改成美团路径', (() => { const b = config.load('browser.config'); return String(b.startUrl || '').includes('about:blank'); })(), `startUrl=${config.load('browser.config').startUrl}`);

  // 4) 宿主连通与批准状态
  try {
    const h = await client.health();
    add('宿主 socket 连通', true, h.url);
    add('宿主无人工占用', !(h.human_busy && h.human_busy.present && !h.human_busy.expired && h.human_busy.owner === 'human'), JSON.stringify(h.human_busy));
    add('导出申请批准（真实运行才需要）', forRealRun ? h.approvals.export_submit === true : true, `export_submit=${h.approvals.export_submit}`);
    add('下载清单批准（真实运行才需要）', forRealRun ? h.approvals.download_list === true : true, `download_list=${h.approvals.download_list}`);
    result.host = h;
  } catch (e) {
    add('宿主 socket 连通', false, `${e.message}（请确认 syncbot-browser.service 运行中）`);
  }

  // 5) 锁可用
  try {
    const lk = lock.acquire('meituan-download', 'cashier_composite', { meta: { purpose: 'precheck' } });
    lk.release();
    add('任务锁可用（未被占用）', true, 'meituan-download');
  } catch (e) {
    add('任务锁可用（未被占用）', false, e.message);
  }

  // 6) timer 必须为空
  try {
    const { execSync } = require('child_process');
    const t = execSync("systemctl list-timers --all --no-legend --no-pager 2>/dev/null | grep -ci syncbot || true", { encoding: 'utf8' }).trim();
    add('syncbot timer 为 0', t === '0', `count=${t}`);
  } catch (e) {
    add('syncbot timer 为 0', true, `(无法检测: ${e.message.split('\n')[0]})`, 'warn');
  }

  result.checks = checks;
  const errors = checks.filter((c) => !c.ok && c.level === 'error');
  result.error_count = errors.length;
  result.warn_count = checks.filter((c) => !c.ok && c.level === 'warn').length;
  result.ok = errors.length === 0;

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
})();
