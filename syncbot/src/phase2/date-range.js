'use strict';
/**
 * 日期区间设置 · 单一受测动作（precheck-set-date 与 real-download 适配器**共用**）
 *
 * 硬规则（实测得出）：
 *  - **只打开日期面板一次**；中途**不得**再次点击开始日期输入框（会重置区间起点，导致终点永远设不上）；
 *  - 在同一面板内**连续点击目标日期单元格两次**（起点 → 终点）；
 *  - 每次点击后读取控件值；
 *  - 最终必须严格读回两个目标值，否则失败。
 *
 * 依赖注入：{ client, readDates }，便于离线用 fake 回归测试。
 */

function sameBoth(values, target) {
  return Array.isArray(values) && values.filter((v) => v === target).length >= 2;
}

// 先在已打开的面板内切换月份，再连续选择起止；不重开输入框。
async function revealDate(client, iso) {
  for (let step = 0; step <= 24; step += 1) {
    const pk = await client.picker({ maxCells: 80 }, { timeoutMs: 60000 });
    const cells = (pk && pk.best && pk.best.cells) || [];
    const cell = cells.find((c) => c.date === iso && !/disabled/.test(c.cls || '') && c.aria_disabled !== 'true');
    if (cell) return { ok: true };
    const sample = cells.find((c) => c.selector && c.selector.includes(' > div.saas-picker-body'));
    if (!sample || step === 24) return { ok: false, reason: `日历未找到 ${iso}` };
    const panel = sample.selector.split(' > div.saas-picker-body')[0];
    const region = await client.region(panel, { maxDepth: 4 }, { timeoutMs: 30000 });
    const header = region && (region.children || []).find((n) => (n.attrs || {}).class === 'saas-picker-header');
    const view = header && (header.children || []).find((n) => (n.attrs || {}).class === 'saas-picker-header-view');
    const labels = view && (view.children || []).map((n) => n.text).join(' ');
    const match = labels && labels.match(/(\d{4})年\s*(\d{1,2})月/);
    if (!match) return { ok: false, reason: '无法验证日历当前月份' };
    const current = Number(match[1]) * 12 + Number(match[2]);
    const wanted = Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
    if (current === wanted) return { ok: false, reason: `目标日期不可选择：${iso}` };
    const cls = current > wanted ? 'saas-picker-header-prev-btn' : 'saas-picker-header-next-btn';
    const button = (header.children || []).find((n) => n.tag === 'button' && (n.attrs || {}).class === cls);
    if (!button) return { ok: false, reason: '未找到已验证的月份切换按钮' };
    const control = await client.inspect(`${panel} > div.saas-picker-header > button.${cls}`, {}, { timeoutMs: 30000 });
    if (!control || !control.visible || !control.enabled || !control.rect) return { ok: false, reason: '月份切换按钮不可用' };
    await client.mouse({ action: 'click', x: control.rect.x + Math.round(control.rect.w / 2), y: control.rect.y + Math.round(control.rect.h / 2), settleMs: 500 }, { timeoutMs: 30000 });
  }
}

/**
 * @param {object} p
 *   client       —— 需提供 mouse/click/picker/press
 *   readDates    —— async () => {values, inputs, formItems}
 *   startSelector—— 开始日期输入框选择器（仅用于 Escape 关闭面板）
 *   targetInput  —— 'YYYY/MM/DD'
 *   iso          —— 'YYYY-MM-DD'
 *   maxCellClicks—— 同一面板内最多点几次（默认 2）
 * @returns {{ok, reopened_at?, values_after, clicks:[], reason?}}
 */
async function setDateRangeExact({ client, readDates, startSelector, targetInput, iso, maxCellClicks = 2 }) {
  if (!targetInput || !/^\d{4}\/\d{2}\/\d{2}$/.test(targetInput)) throw new Error(`非法目标日期：${targetInput}`);
  const before = await readDates();
  // ---- 打开面板一次 ----
  const target = (before.inputs || []).find((x) => /开始/.test(x.placeholder || '')) || (before.inputs || [])[0];
  if (!target || !target.rect) return { ok: false, reason: '未取得日期输入框坐标', values_after: before.values, clicks: [] };
  await client.mouse({ action: 'click', x: target.rect.x + Math.round(target.rect.w / 2), y: target.rect.y + Math.round(target.rect.h / 2), settleMs: 1600 }, { timeoutMs: 30000 });
  const clicks = [];
  let reopenedAt = null;
  for (let i = 0; i < maxCellClicks; i += 1) {
    // 开始日选定后，控件可能自动转到旧结束日所在月份；仍在同一面板内切回来。
    const revealed = await revealDate(client, iso);
    if (!revealed.ok) return { ...revealed, values_after: (await readDates()).values, clicks, reopened_at: reopenedAt };
    const pk = await client.picker({ maxCells: 80 }, { timeoutMs: 60000 });
    const cells = (pk && pk.best && pk.best.cells) || [];
    const cell = cells.find((c) => c.date === iso);
    if (!cell) return { ok: false, reason: `面板未出现或未找到 ${iso}（distinct=${pk && pk.best ? pk.best.distinct_dates : 0}）`, values_after: (await readDates()).values, clicks, reopened_at: reopenedAt };
    await client.mouse({ action: 'click', x: cell.rect.x + Math.round(cell.rect.w / 2), y: cell.rect.y + Math.round(cell.rect.h / 2), settleMs: 1400 }, { timeoutMs: 30000 });
    const now = await readDates();
    clicks.push({ i, date: cell.date, values_after: now.values });
    if (sameBoth(now.values, targetInput)) break;
    // 若面板已关闭，视为需要重开 → 记录为错误交互（不允许静默重开输入框）
    const pk2 = await client.picker({ maxCells: 80 }, { timeoutMs: 30000 }).catch(() => null);
    const stillOpen = !!(pk2 && pk2.best && pk2.best.distinct_dates > 0);
    if (!stillOpen) { reopenedAt = { at_click: i, reason: '面板已关闭，需重开面板/输入框 → 视为错误交互' }; break; }
  }
  if (startSelector) await client.press(startSelector, 'Escape', { timeoutMs: 20000 }).catch(() => {});
  const after = await readDates();
  const ok = sameBoth(after.values, targetInput);
  return {
    ok,
    values_after: after.values,
    clicks,
    reopened_at: reopenedAt,
    reason: ok ? '起止均为目标日期' : `读回 ${JSON.stringify(after.values)}，未同时等于 ${targetInput}${reopenedAt ? `（${reopenedAt.reason}）` : ''}`,
  };
}

/** 截图统一封装：失败必须显式标记，不得用空数组伪装 */
async function captureScreenshot({ flow, ctx, nn, step, sink }) {
  try {
    const s = await flow.screenshot(ctx, nn, step);
    const file = s && (s.file || s.path);
    if (!file) { const rec = { nn, step, ok: false, reason: '截图返回结构缺少 file/path', raw: s && Object.keys(s) }; if (sink) sink.push(rec); return rec; }
    const rec = { nn, step, ok: true, file };
    if (sink) sink.push(rec);
    return rec;
  } catch (e) {
    const rec = { nn, step, ok: false, reason: e.message };
    if (sink) sink.push(rec);
    return rec;
  }
}

module.exports = { setDateRangeExact, captureScreenshot, sameBoth, revealDate };
