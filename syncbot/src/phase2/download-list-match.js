'use strict';
/**
 * 下载清单「目标行」匹配（**纯函数**，无 I/O，便于 fixture 离线测试）
 *
 * 唯一匹配条件（全部必须满足）：
 *   业务模块 == 报表中心
 *   申请内容 含指定报表名称（默认「综合营业统计」）且含目标业务日期
 *   申请人 == 期望申请人（当前登录账号，由调用方显式传入）
 *   申请时间 > 本次任务启动时间（严格晚于）
 * 仅当状态列精确等于「导出完成」才判定 ready。
 * 命中数 0 → wait（继续轮询）；>1 → fail（歧义，绝不猜）；状态异常 → fail。
 */

const DOWNLOAD_ACTION = '下载';
const READY_STATUS = '导出完成';
const FAIL_STATUSES = ['导出失败', '生成失败', '失败', '已过期'];

function norm(s) { return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim(); }

/** 解析 "2026/9/17 13:29:11" / "2026-09-17 13:29:11" → epoch ms（失败返回 NaN） */
function parseApplyTime(s) {
  const t = norm(s);
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se || 0)).getTime();
}

/** 申请内容里是否含目标业务日期（兼容 2026/09/17、2026/9/17、2026-09-17 三种写法） */
function contentHasBusinessDate(content, businessDate) {
  const c = norm(content);
  const [y, m, d] = String(businessDate).split('-');
  return c.includes(`${y}/${m}/${d}`) || c.includes(`${y}/${Number(m)}/${Number(d)}`) || c.includes(`${y}-${m}-${d}`);
}

/** 行 rect 是否包含控件 rect（保证「下载」控件属于该行） */
function rectContains(rowRect, ctlRect) {
  if (!rowRect || !ctlRect) return false;
  return ctlRect.x >= rowRect.x - 2 && ctlRect.y >= rowRect.y - 2
    && (ctlRect.x + ctlRect.w) <= (rowRect.x + rowRect.w) + 2
    && (ctlRect.y + ctlRect.h) <= (rowRect.y + rowRect.h) + 2;
}

/** 表头列索引解析（按表头文案定位，避免硬编码列号） */
function columnIndexes(headerCells) {
  const h = (headerCells || []).map(norm);
  return {
    module: h.findIndex((x) => x === '业务模块'),
    content: h.findIndex((x) => x === '申请内容'),
    applicant: h.findIndex((x) => x === '申请人'),
    applyTime: h.findIndex((x) => x === '申请时间'),
    updateTime: h.findIndex((x) => x === '更新时间'),
    status: h.findIndex((x) => x === '状态'),
    action: h.findIndex((x) => x === '操作'),
  };
}

/**
 * @param {{rows:Array}} fixture  readDownloadRows 的输出（rows 含 cells/controls/rect）
 * @param {{businessDate:string, taskStartedAt:number, applicant:string, reportName?:string}} criteria
 * @returns {{outcome:'wait'|'ready'|'fail', reason:string, ...}}
 */
function selectTargetRow(fixture, criteria) {
  const rows = (fixture && fixture.rows) || [];
  const { businessDate, taskStartedAt, applicant } = criteria || {};
  const reportName = criteria && criteria.reportName === undefined ? '综合营业统计' : norm(criteria && criteria.reportName);
  if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return { outcome: 'fail', reason: `非法业务日期：${businessDate}` };
  if (!applicant) return { outcome: 'fail', reason: '缺少期望申请人（当前登录账号），拒绝猜测' };
  if (!Number.isFinite(taskStartedAt)) return { outcome: 'fail', reason: '缺少任务启动时间，无法判断「申请时间晚于本次启动」' };
  if (!reportName) return { outcome: 'fail', reason: '缺少报表名称，拒绝跨报表匹配' };

  const headerRow = rows.find((r) => (r.cells || []).some((c) => norm(c) === '业务模块'));
  if (!headerRow) return { outcome: 'fail', reason: '未找到表头行（业务模块 列缺失）' };
  const idx = columnIndexes(headerRow.cells);
  if (idx.module < 0 || idx.content < 0 || idx.applicant < 0 || idx.applyTime < 0 || idx.status < 0) {
    return { outcome: 'fail', reason: `表头列缺失：${JSON.stringify(idx)}` };
  }

  const dataRows = rows.filter((r) => r !== headerRow && (r.cells || []).length > idx.status && /^\d+$/.test(norm((r.cells || [])[0])));
  const evaluated = [];
  const matched = [];
  for (const r of dataRows) {
    const c = r.cells.map(norm);
    const module = c[idx.module];
    const content = c[idx.content];
    const who = c[idx.applicant];
    const applyRaw = c[idx.applyTime];
    const applyMs = parseApplyTime(applyRaw);
    const status = c[idx.status];
    const reasons = [];
    if (module !== '报表中心') reasons.push(`业务模块=${module}`);
    if (!content.includes(reportName)) reasons.push(`申请内容不含「${reportName}」`);
    if (!contentHasBusinessDate(content, businessDate)) reasons.push('申请内容不含目标日期');
    if (who !== applicant) reasons.push(`申请人=${who}`);
    if (!Number.isFinite(applyMs)) reasons.push(`申请时间无法解析=${applyRaw}`);
    else if (applyMs <= taskStartedAt) reasons.push('申请时间不晚于任务启动时间');
    const isTarget = reasons.length === 0;
    const rec = { row: r, cells: c, module, content, applicant: who, applyTimeRaw: applyRaw, applyMs, status, reasons, isTarget };
    evaluated.push(rec);
    if (isTarget) matched.push(rec);
  }

  if (matched.length === 0) {
    const statuses = evaluated.map((e) => e.status).filter(Boolean);
    return {
      outcome: 'wait',
      reason: `未出现符合条件的目标行（候选数据行 ${dataRows.length}，状态集合 ${JSON.stringify(Array.from(new Set(statuses)))}）`,
      evaluated: evaluated.map((e) => ({ status: e.status, why: e.reasons })),
    };
  }
  if (matched.length > 1) {
    return {
      outcome: 'fail',
      reason: `命中 ${matched.length} 行，无法唯一确定目标行（拒绝猜测，不下载）`,
      matched: matched.map((m) => ({ applyTime: m.applyTimeRaw, status: m.status })),
    };
  }
  const m = matched[0];
  if (FAIL_STATUSES.includes(m.status)) return { outcome: 'fail', reason: `目标行状态为失败态：${m.status}`, target: { applyTime: m.applyTimeRaw, status: m.status } };
  if (m.status !== READY_STATUS) {
    return { outcome: 'wait', reason: `目标行已唯一命中，但状态尚未「导出完成」：${m.status}`, target: { applyTime: m.applyTimeRaw, status: m.status } };
  }
  // 下载控件必须属于该目标行
  const ctl = (m.row.controls || []).find((x) => norm(x.text) === DOWNLOAD_ACTION && rectContains(m.row.rect, x.rect));
  if (!ctl) {
    const loose = (m.row.controls || []).filter((x) => norm(x.text) === DOWNLOAD_ACTION);
    return {
      outcome: 'fail',
      reason: loose.length ? '存在「下载」控件但不在目标行范围内（拒绝误点其它行）' : '目标行内未找到「下载」操作控件',
      target: { applyTime: m.applyTimeRaw, status: m.status },
      loose_controls: loose.map((x) => x.rect),
    };
  }
  return {
    outcome: 'ready',
    reason: '唯一命中目标行且状态为「导出完成」，下载控件属于该行',
    target: { applyTime: m.applyTimeRaw, updateTime: norm(m.cells[idx.updateTime]), status: m.status, content: m.content, applicant: m.applicant },
    download_control: { text: DOWNLOAD_ACTION, selector: ctl.selector, rect: ctl.rect, row_rect: m.row.rect },
  };
}

module.exports = { selectTargetRow, parseApplyTime, contentHasBusinessDate, columnIndexes, rectContains, DOWNLOAD_ACTION, READY_STATUS, FAIL_STATUSES };
