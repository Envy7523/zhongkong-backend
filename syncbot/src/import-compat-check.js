'use strict';
/**
 * 阶段1 只读「导入相容性预检」
 *   node src/import-compat-check.js <xlsx文件>
 *
 * 目的：在不调用导入、不写数据库的前提下，**忠实复现**现有项目
 *   lib/business-analytics.js 中 cashierCompositeReportSheet() 的识别判定，
 * 判断这份报表能否被现有 /api/business-analytics/import 识别为「综合营业统计」。
 *
 * 关键做法：判定用到的渠道名与指标名字面量**直接从项目源码中提取**，
 * 而不是由本工具转写，从而避免因全角/半角括号、空格等差异产生误判。
 *
 * 声明：本工具只读；结论是"按项目现有代码逻辑推演"，真实导入结果以项目自身执行为准。
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const PROJECT_SRC =
  process.env.PROJECT_SRC || '/home/ubuntu/app/lib/business-analytics.js';
const sampleFile = process.argv[2];
if (!sampleFile || !fs.existsSync(sampleFile)) {
  console.error('用法: node src/import-compat-check.js <xlsx文件>   （需要能读取项目源码）');
  process.exit(2);
}

const src = fs.readFileSync(PROJECT_SRC, 'utf8');

// ---- 1. 从项目源码提取真实字面量 ----
function extractChannelDefinitions() {
  const block = src.match(/const channelDefinitions = \[([\s\S]*?)\];/);
  if (!block) throw new Error('项目源码中未找到 channelDefinitions');
  const out = [];
  const re = /\{\s*code:\s*'([^']+)'\s*,\s*names:\s*\[([^\]]*)\]\s*\}/g;
  let m;
  while ((m = re.exec(block[1]))) {
    out.push({ code: m[1], names: [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]) });
  }
  return out;
}
function extractColumnOfLabels() {
  // 注意：columnOf 的定义与调用在同一段代码里，必须全文搜索调用点，
  // 只截取定义行会得到空列表，从而在空对象上 every() 恒真 → 假阳性。
  const labels = [...src.matchAll(/columnOf\('([^']*)'\)/g)].map((x) => x[1]);
  return [...new Set(labels)];
}
function extractCleanKeyImpl() {
  const m = src.match(/function cleanKey\(value\)\s*\{\s*return([\s\S]*?);\s*\}/);
  return m ? m[1].trim() : '(未提取到)';
}

const channelDefinitions = extractChannelDefinitions();
const columnOfLabels = extractColumnOfLabels();
const cleanKeyImpl = extractCleanKeyImpl();

// 复现 cleanKey（与项目实现一致：去空白/下划线/全半角括号 + 小写）
const cleanKey = (value) => String(value == null ? '' : value).trim().replace(/[\s_（）()]/g, '').toLowerCase();
// 复现 fillMergedHeader（水平向右填充）
function fillMergedHeader(row = []) {
  let current = '';
  return row.map((value) => {
    if (value !== '' && value != null) current = String(value).trim();
    return current;
  });
}
const cp = (s) => [...String(s)].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');

// ---- 2. 读取样本并复现判定 ----
const wb = XLSX.readFile(sampleFile, { cellDates: false, raw: true });
const report = {
  sample: path.basename(sampleFile),
  project_source: PROJECT_SRC,
  extracted: { channelDefinitions, columnOfLabels, cleanKey_impl: cleanKeyImpl },
  sheets: [],
};

for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true });
  const s = { sheet: name, row_count: rows.length, checks: {}, resolved: null };

  const compact =
    String(rows?.[0]?.[0] || '').trim() === '城市' &&
    ['门店', '门店名称'].includes(String(rows?.[0]?.[1] || '').trim()) &&
    ['营业日', '营业日期'].includes(String(rows?.[0]?.[2] || '').trim());
  const offset = compact ? 0 : 2;
  const [identityHeader = [], channelHeader = [], metricHeader = []] = rows.slice(offset, offset + 3);
  const topSections = fillMergedHeader(identityHeader);
  const channels = fillMergedHeader(channelHeader);
  const metrics = fillMergedHeader(metricHeader);

  const validIdentity =
    compact ||
    (String(identityHeader[0] || '').trim() === '城市' &&
      ['门店', '门店名称'].includes(String(identityHeader[1] || '').trim()) &&
      ['营业日', '营业日期'].includes(String(identityHeader[2] || '').trim()));

  s.checks.compact_layout_detected = compact;
  s.checks.header_offset_used = offset;
  s.checks.identity_header_row_1based = offset + 1;
  s.checks.identity_header_cells_0_1_2 = [identityHeader[0], identityHeader[1], identityHeader[2]];
  s.checks.identityHeader_0_is_城市 = String(identityHeader[0] || '').trim() === '城市';
  s.checks.identityHeader_1_in_门店_门店名称 = ['门店', '门店名称'].includes(String(identityHeader[1] || '').trim());
  s.checks.identityHeader_2_in_营业日_营业日期 = ['营业日', '营业日期'].includes(String(identityHeader[2] || '').trim());
  s.checks.validIdentity = validIdentity;

  // 逐渠道定位列号（复现 columnOf）
  const colOf = {};
  for (const def of channelDefinitions) {
    const isChannel = (v) => def.names.some((nm) => cleanKey(v) === cleanKey(nm));
    const columnOf = (label) => metrics.findIndex((metric, index) => isChannel(channels[index]) && metric === label);
    colOf[def.code] = { channel_names_in_project: def.names, columns: {} };
    for (const label of columnOfLabels) colOf[def.code].columns[label] = columnOf(label);
  }
  s.resolved_columns = colOf;

  // 字面量比对：样本叶子表头 vs 项目源码中的字面量
  const metricSet = new Set(metrics.filter((m) => m !== ''));
  s.literal_check = columnOfLabels.map((label) => {
    const exact = metricSet.has(label);
    const near = [...metricSet].find((m) => cleanKey(m) === cleanKey(label));
    return {
      project_literal: label,
      project_codepoints: cp(label),
      present_exact_in_leaf_headers: exact,
      closest_by_cleanKey: near === undefined ? null : near,
      closest_codepoints: near === undefined ? null : cp(near),
      note: exact ? '完全一致' : near ? '字面量不同（cleanKey 归一化后相同，但项目用的是严格 === 比较，会判定不匹配）' : '样本中不存在',
    };
  });

  const resolvedChannels = Object.entries(colOf)
    .filter(([, v]) => {
      const vals = Object.values(v.columns);
      // 必须真的解析出列号：空对象不得视为通过（否则 every() 恒真导致假阳性）
      return vals.length > 0 && vals.every((i) => i >= 0);
    })
    .map(([code]) => code);
  s.checks.column_of_labels_extracted = columnOfLabels.length;
  s.checks.resolved_channels = resolvedChannels;
  s.checks.resolved_channel_count = resolvedChannels.length;
  s.checks.sheet_valid = validIdentity && columnOfLabels.length > 0 && resolvedChannels.length > 0;
  s.data_start_row_1based = offset + 3 + 1;
  s.data_row_count = Math.max(0, rows.length - (offset + 3));

  report.sheets.push(s);
}

const picked = report.sheets.find((x) => x.checks.sheet_valid);
report.verdict = {
  recognized_as_cashier_composite: !!picked,
  picked_sheet: picked ? picked.sheet : null,
  resolved_channels: picked ? picked.checks.resolved_channels : [],
  reason: picked
    ? `按项目现有逻辑可被识别为「综合营业统计」（identityHeader 三列校验通过，${picked.checks.resolved_channel_count} 个渠道组列号全部解析成功）`
    : '按项目现有逻辑【不会被识别】：identityHeader 或渠道组列号校验未通过',
};

console.log(JSON.stringify(report, null, 2));
