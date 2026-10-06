'use strict';
/**
 * 页面筛选校验 · 共享纯函数模块（dryrun 与 real-download-adapters **共用同一实现**，防止规则漂移）
 *
 * 规则要点：
 *  - 多选组（checkbox_group，如「门店区域」）：期望值是**组的选中集合**，做集合比较并输出缺失/多余；
 *    **不得**把同一组的选中集合逐项与单值做完全相等比较。
 *  - 单选组（radio_group）：期望集合通常为单值。
 *  - value_control（如「星期」「门店」）：**无 group 字段**，从日期行/form_item 的显示值读取，
 *    **不得**用 group=undefined 去维度组里查找。
 *  - verify_source === 'export_file_row2_query_params'（如「餐时段统计方式」）：
 *    页面侧跳过，标记 deferred_to_file_validation。
 *
 * 纯函数：不读文件、不访问网络、不依赖全局状态。
 */

const STATUS = {
  MATCH: 'match',
  MISMATCH: 'mismatch',
  UNREADABLE: 'unreadable',
  INDETERMINATE: 'indeterminate',
  DEFERRED: 'deferred_to_file_validation',
};

function setDiff(expected, actual) {
  const e = new Set(expected);
  const a = new Set(actual);
  return { missing: expected.filter((x) => !a.has(x)), extra: actual.filter((x) => !e.has(x)) };
}

/**
 * @param {Array} items meituan-rules.filter_value_checks.items
 * @param {object} read
 *   groups         —— client.filterState().best.groups：[{group, checked_texts, determinate, options}]
 *   dateRowItems   —— client.dateRow().best.block.form_items：[{text, cls, checked_texts}]
 * @returns {{ok, expected_count, matched, results, mismatches, unreadable, deferred}}
 */
function checkFilterItems(items, read = {}) {
  const list = items || [];
  const groups = (read && read.groups) || [];
  const rows = (read && read.dateRowItems) || [];
  const groupOf = (name) => groups.find((g) => g.group === name) || null;

  // 1) 先按「组」聚合期望（多选组取并集，单选组取单值）
  const groupExpected = {};
  for (const it of list) {
    if (it.type === 'value_control' || it.verify_source) continue;
    if (!it.group) continue;
    groupExpected[it.group] = (groupExpected[it.group] || []).concat(it.expect_selected || []);
  }
  const groupVerdict = {};
  for (const [g, expected] of Object.entries(groupExpected)) {
    const actualGroup = groupOf(g);
    if (!actualGroup) { groupVerdict[g] = { status: STATUS.UNREADABLE, reason: `未找到「${g}」维度组`, expected }; continue; }
    if (actualGroup.determinate === false) {
      groupVerdict[g] = { status: STATUS.INDETERMINATE, reason: `「${g}」组选中态不确定`, expected, actual: actualGroup.checked_texts || [] };
      continue;
    }
    const actual = actualGroup.checked_texts || [];
    const d = setDiff(expected, actual);
    groupVerdict[g] = d.missing.length === 0 && d.extra.length === 0
      ? { status: STATUS.MATCH, expected, actual, detail: `集合一致：${actual.join('、')}` }
      : { status: STATUS.MISMATCH, expected, actual, missing: d.missing, extra: d.extra, detail: `缺失=${JSON.stringify(d.missing)} 多余=${JSON.stringify(d.extra)}` };
  }

  // 2) 逐项产出（组项继承组判定；value_control 单独读取；文件元数据项延后）
  const results = [];
  for (const it of list) {
    const base = { no: it.no, key: it.key, type: it.type, group: it.group || null, expect: it.expect_value !== undefined ? it.expect_value : (it.expect_selected || []).join('、') };
    if (it.verify_source === 'export_file_row2_query_params') {
      results.push({ ...base, verify_source: it.verify_source, actual: null, status: STATUS.DEFERRED, ok: true, read_evidence: `归属导出文件第2行查询参数元数据校验（阶段3），页面侧不校验；${it.belongs_to || ''}` });
      continue;
    }
    if (it.type === 'value_control') {
      const row = rows.find((r) => r.text === it.control_text || String(r.text || '').startsWith(`${it.control_text} `));
      if (!row) {
        results.push({ ...base, group: it.control_text, verify_source: 'value_control', actual: null, status: STATUS.UNREADABLE, ok: false, read_evidence: `未在日期行/form_item 中找到控件「${it.control_text}」` });
        continue;
      }
      const value = String(row.text).replace(new RegExp(`^${it.control_text}\\s*`), '').replace(/\s*高\s*级\s*$/, '').trim();
      const ok = value === it.expect_value;
      results.push({ ...base, group: it.control_text, verify_source: 'value_control', actual: value, status: ok ? STATUS.MATCH : STATUS.MISMATCH, ok, read_evidence: `日期行 form_item「${row.text}」（class=${row.cls}）解析值=「${value}」` });
      continue;
    }
    const v = it.group ? groupVerdict[it.group] : null;
    if (!v) {
      results.push({ ...base, actual: null, status: STATUS.UNREADABLE, ok: false, read_evidence: '规则项缺少 group 且非 value_control' });
      continue;
    }
    const selectedOwn = (v.actual || []).includes((it.expect_selected || [])[0]);
    const ok = v.status === STATUS.MATCH && selectedOwn;
    results.push({
      ...base,
      verify_source: 'page_filter_state',
      expected_set: (groupExpected[it.group] || []).join('、'),
      actual: (v.actual || []).join('、') || null,
      missing: v.missing || [],
      extra: v.extra || [],
      status: v.status,
      ok,
      read_evidence: `${v.detail || v.reason}（组期望集合=${(groupExpected[it.group] || []).join('、')}）`,
    });
  }

  const page = results.filter((r) => r.verify_source !== 'export_file_row2_query_params');
  const mismatches = page.filter((r) => r.status === STATUS.MISMATCH).map((r) => `#${r.no} ${r.group}: 期望「${r.expect}」实际「${r.actual}」${r.missing && r.missing.length ? ` 缺失=${JSON.stringify(r.missing)}` : ''}${r.extra && r.extra.length ? ` 多余=${JSON.stringify(r.extra)}` : ''}`);
  const unreadable = page.filter((r) => r.status === STATUS.UNREADABLE || r.status === STATUS.INDETERMINATE).map((r) => `#${r.no} ${r.group}: ${r.status}`);
  const deferred = results.filter((r) => r.status === STATUS.DEFERRED).map((r) => `#${r.no} ${r.group}: ${r.read_evidence}`);
  return {
    ok: mismatches.length === 0 && unreadable.length === 0,
    expected_count: list.length,
    page_checked_count: page.length,
    matched: page.filter((r) => r.ok).length,
    results, mismatches, unreadable, deferred,
  };
}

module.exports = { checkFilterItems, STATUS, setDiff };
