'use strict';
/** 共享筛选校验模块 · 回归测试（纯离线，无网络） */
const FC = require('./filter-check');
const out = [];
const ck = (n, ok, d) => out.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

const ITEMS = [
  { no: 1, key: 'store_region_city', group: '门店区域', expect_selected: ['城市'], type: 'checkbox_group' },
  { no: 2, key: 'store_region_store_name', group: '门店区域', expect_selected: ['门店名称'], type: 'checkbox_group' },
  { no: 3, key: 'stat_period', group: '统计周期', expect_selected: ['日期'], type: 'radio_group' },
  { no: 4, key: 'time_segment', group: '时段餐段', expect_selected: ['不分时段'], type: 'radio_group' },
  { no: 5, key: 'meal_segment_stat_mode', group: '餐时段统计方式', expect_selected: ['下单时间'], type: 'radio_group', verify_source: 'export_file_row2_query_params', belongs_to: '报表A导出文件第2行' },
  { no: 11, key: 'week', control_text: '星期', expect_value: '全部', type: 'value_control' },
  { no: 12, key: 'poi', control_text: '门店', expect_value: '全部', type: 'value_control' },
];
const G = (group, checked, determinate = true) => ({ group, checked_texts: checked, determinate, options: [] });
const ROWS = [
  { text: '营业日期 2026/09/17 - 2026/09/17', cls: 'x', checked_texts: [] },
  { text: '星期 全部', cls: 'WeekSelect_1', checked_texts: [] },
  { text: '门店 全部 高级', cls: 'PoiSelector_5', checked_texts: [] },
];
const baseGroups = [G('门店区域', ['城市', '门店名称']), G('统计周期', ['日期']), G('时段餐段', ['不分时段'])];

// R1 城市+门店名称同时选中 → 通过
{
  const r = FC.checkFilterItems(ITEMS, { groups: baseGroups, dateRowItems: ROWS });
  ck('R1 门店区域多选（城市+门店名称）→ 通过', r.ok === true && r.mismatches.length === 0, `ok=${r.ok} mismatches=${JSON.stringify(r.mismatches)}`);
  ck('R1b 第5项标记 deferred_to_file_validation', r.results.find((x) => x.no === 5).status === 'deferred_to_file_validation', '');
  ck('R1c 页面校验项=6（12-1+... 按本案 7 项减 1 项延后）', r.page_checked_count === ITEMS.length - 1, `page=${r.page_checked_count}`);
}
// R2 少选一项 → 失败并说明缺失
{
  const r = FC.checkFilterItems(ITEMS, { groups: [G('门店区域', ['城市']), G('统计周期', ['日期']), G('时段餐段', ['不分时段'])], dateRowItems: ROWS });
  ck('R2 门店区域少选「门店名称」→ 失败且说明缺失', r.ok === false && r.mismatches.some((m) => /门店名称/.test(m) && /缺失/.test(m)), JSON.stringify(r.mismatches));
}
// R3 多选一项 → 失败并说明多余
{
  const r = FC.checkFilterItems(ITEMS, { groups: [G('门店区域', ['城市', '门店名称', '地区']), G('统计周期', ['日期']), G('时段餐段', ['不分时段'])], dateRowItems: ROWS });
  ck('R3 门店区域多选「地区」→ 失败且说明多余', r.ok === false && r.mismatches.some((m) => /地区/.test(m) && /多余/.test(m)), JSON.stringify(r.mismatches));
}
// R4 value_control 正确读取 → 通过
{
  const r = FC.checkFilterItems(ITEMS, { groups: baseGroups, dateRowItems: ROWS });
  const w = r.results.find((x) => x.no === 11); const p = r.results.find((x) => x.no === 12);
  ck('R4 星期 value_control 读取=全部 → 通过', w.status === 'match' && w.actual === '全部', `${w.status}/${w.actual}`);
  ck('R4b 门店 value_control 读取=全部（剥离「高级」）→ 通过', p.status === 'match' && p.actual === '全部', `${p.status}/${p.actual}`);
  ck('R4c value_control 未用 group 到维度组查找', !/undefined/.test(JSON.stringify(r.mismatches)) && !/undefined/.test(JSON.stringify(r.unreadable)), JSON.stringify(r.unreadable));
}
// R5 value_control 缺失 → 失败
{
  const r = FC.checkFilterItems(ITEMS, { groups: baseGroups, dateRowItems: [{ text: '营业日期 x' }] });
  ck('R5 星期/门店 控件缺失 → 失败(unreadable)且不报 undefined', r.ok === false && r.unreadable.length === 2 && !r.unreadable.some((x) => /undefined/.test(x)), JSON.stringify(r.unreadable));
}
// R6 value_control 非「全部」→ 失败
{
  const rows = [{ text: '星期 周一', cls: 'w' }, { text: '门店 全部', cls: 'p' }];
  const r = FC.checkFilterItems(ITEMS, { groups: baseGroups, dateRowItems: rows });
  ck('R6 星期=周1 → 失败', r.ok === false && r.mismatches.some((m) => /#11/.test(m) && /周一/.test(m)), JSON.stringify(r.mismatches));
}
// R7 单选组不符 → 失败
{
  const r = FC.checkFilterItems(ITEMS, { groups: [G('门店区域', ['城市', '门店名称']), G('统计周期', ['自定义周期']), G('时段餐段', ['不分时段'])], dateRowItems: ROWS });
  ck('R7 统计周期=自定义周期 → 失败', r.ok === false && r.mismatches.some((m) => /统计周期/.test(m)), JSON.stringify(r.mismatches));
}
// R8 组不确定 → indeterminate 计为失败
{
  const r = FC.checkFilterItems(ITEMS, { groups: [G('门店区域', ['城市', '门店名称'], false), G('统计周期', ['日期']), G('时段餐段', ['不分时段'])], dateRowItems: ROWS });
  ck('R8 组选中态不确定 → 失败(indeterminate)', r.ok === false && r.unreadable.some((x) => /indeterminate/.test(x)), JSON.stringify(r.unreadable));
}
// R9 纯函数性：不修改入参
{
  const snapshot = JSON.stringify(ITEMS);
  FC.checkFilterItems(ITEMS, { groups: baseGroups, dateRowItems: ROWS });
  ck('R9 纯函数：不修改入参', JSON.stringify(ITEMS) === snapshot, '');
}
// R10 共享性：dryrun 与适配器必须引用同一模块
{
  const fs = require('fs');
  const path = require('path');
  const dr = fs.readFileSync(path.join(__dirname, 'dryrun.js'), 'utf8');
  const ad = fs.readFileSync(path.join(__dirname, 'real-download-adapters.js'), 'utf8');
  const qf = fs.readFileSync(path.join(__dirname, 'report-a-query-flow.js'), 'utf8');
  ck('R10 dryrun 引用共享校验模块', /require\('\.\/filter-check'\)/.test(dr), '');
  ck('R10b 共享查询流程引用共享校验模块', /require\('\.\/filter-check'\)/.test(qf) && /checkFilterItems/.test(qf), '');
  ck('R10c dryrun 与共享流程均调用 checkFilterItems', /checkFilterItems/.test(dr) && /checkFilterItems/.test(qf), '');
  ck('R10d 适配器委托共享流程（不再自留 filter 比较逻辑）', /navigateAndQueryReportA\(/.test(ad) && !/groupUnion/.test(ad), '');
}

const ok = out.every((r) => r.ok);
console.log(JSON.stringify({ ok, total: out.length, failed: out.filter((x) => !x.ok).length, results: out }, null, 2));
process.exit(ok ? 0 : 1);
