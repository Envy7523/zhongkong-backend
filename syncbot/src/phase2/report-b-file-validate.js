'use strict';
/** 收银系统「品项销售明细」文件的离线闸门；不访问浏览器、网络或中控数据库。 */
const fs = require('fs');
const path = require('path');
const SMC = require('./store-mapping-coverage');

const REPORT_TYPE = 'item_sales_detail';
const SHEET_NAME = '品项销售明细';
const HEADERS = [
  '城市', '机构编码', '门店名称', '营业日期', '下单时间所属餐段', '出品部门',
  '菜品大类', '菜品小类', '菜品编码', '品项名称', '关联菜品名称', '商品别名',
  '品项类型', '菜品类型', '菜品标签', '规格', '单位', '关联做法', '关联加料',
  '关联餐盒', '销售方式', '订单号', '销售数量', '赠送数量', '销售金额(元)',
  '赠送金额(元)', '优惠金额(元)', '品项收入(元)', '点菜时间', '下单时间',
  '接单/结账/退菜时间', '收银员', '点菜员', '下单人', '订单分类', '订单来源',
  '新订单来源', '订单子来源', '桌台区域', '取餐号', '桌牌号', '订单金额(元)',
  '营业额(元)', '订单优惠(元)', '订单收入(元)', '标记', '退菜数量',
  '退菜金额(元)', '敏感操作类型', '单品备注',
];
const SUM_COLUMNS = [
  ['销售数量', 22, 0.001], ['赠送数量', 23, 0.001],
  ['销售金额(元)', 24, 0.01], ['赠送金额(元)', 25, 0.01],
  ['优惠金额(元)', 26, 0.01], ['品项收入(元)', 27, 0.01],
  ['退菜数量', 46, 0.001], ['退菜金额(元)', 47, 0.01],
];
const text = (v) => String(v === undefined || v === null ? '' : v).trim();
const dateKey = (v) => {
  const m = text(v).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
};
const finiteNumber = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));
const checkMetadata = (metadata, businessDate) => {
  const compact = text(metadata).replace(/\s+/g, '');
  const target = businessDate.replace(/-/g, '/');
  const required = [
    ['营业日期', `营业日期【${target}-${target}】`],
    ['门店', '门店【全部】'],
    ['加料单独统计', '加料(配菜)单独统计【未选中】'],
    ['餐盒单独统计', '堂食餐盒单独统计【未选中】'],
    ['销售方式', '销售方式【销售,退菜】'],
    ['品项类型', '品项类型【菜品(含菜品绑定的做法加料及餐盒)】'],
    ['菜品类型', '菜品类型【单品+套餐明细】'],
  ];
  return required.map(([name, pattern]) => ({ name, ok: compact.includes(pattern) }));
};

/** 可注入 grid，便于离线契约测试；生产入口统一调用 validateReportBFile。 */
function validateGrid(grid, { businessDate, storeMapping, storeCodesCoverage = null, requireStoreCodes = false } = {}) {
  const errors = [];
  const add = (message) => { if (errors.length < 20) errors.push(message); };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(businessDate))) add('业务日期必须为 YYYY-MM-DD');
  if (!Array.isArray(grid) || grid.length < 5) add('工作表不足 5 行，缺少明细或合计');
  if (errors.length) return { ok: false, report_type: REPORT_TYPE, errors };

  const metadata = checkMetadata((grid[1] || [])[0], businessDate);
  for (const item of metadata) if (!item.ok) add(`查询参数不符合已确认口径：${item.name}`);
  const header = (grid[2] || []).map(text);
  const mismatch = HEADERS.map((name, i) => header[i] === name ? null : `${i + 1}:${name}`).filter(Boolean);
  if (header.length !== HEADERS.length || mismatch.length) add(`第三行 50 列表头不符：${mismatch.slice(0, 8).join(',') || '列数变化'}`);
  const total = grid[grid.length - 1] || [];
  if (text(total[0]) !== '合计') add('最后一行不是唯一的「合计」行');

  const ledger = SMC.buildLedger(storeMapping || null);
  if (!ledger.available || ledger.status !== 'confirmed') add('门店精确映射台账缺失或未确认');
  const codesReady = storeCodesCoverage && storeCodesCoverage.ok === true
    && storeCodesCoverage.business_date === businessDate && storeCodesCoverage.report_type === REPORT_TYPE
    && storeCodesCoverage.store_codes_complete === true && Array.isArray(storeCodesCoverage.store_codes);
  if (requireStoreCodes && !codesReady) add('中控收银机构编码清单缺失或不完整');
  const codeIds = new Map(codesReady ? storeCodesCoverage.store_codes.map(x => [text(x.pos_store_code), Number(x.id)]) : []);
  const rows = grid.slice(3, -1).filter(row => Array.isArray(row) && row.some(v => text(v)));
  if (!rows.length) add('没有品项明细行');
  const stores = new Map();
  const orders = new Set();
  const sums = Object.fromEntries(SUM_COLUMNS.map(([name]) => [name, 0]));
  let salesRows = 0; let refundRows = 0;
  rows.forEach((row, i) => {
    const n = i + 4;
    if (text(row[0]) === '合计') { add(`第 ${n} 行提前出现合计`); return; }
    const code = text(row[1]);
    const name = text(row[2]);
    if (!code || !name || !text(row[8]) || !text(row[9]) || !text(row[21])) add(`第 ${n} 行缺少机构编码、门店、菜品或订单身份字段`);
    if (dateKey(row[3]) !== businessDate) add(`第 ${n} 行营业日期与目标日期不一致`);
    const mapped = SMC.matchStoreName(name, ledger);
    if (!mapped.ok) add(`第 ${n} 行门店无法精确映射：${name.slice(0, 40)}（${mapped.reason}）`);
    if (codesReady && mapped.ok && (!codeIds.has(code) || codeIds.get(code) !== mapped.id))
      add(`第 ${n} 行机构编码 ${code} 与中控门店 ID 不一致`);
    if (code && name) {
      const prior = stores.get(code);
      if (prior && prior !== name) add(`第 ${n} 行机构编码对应多个门店名称`);
      stores.set(code, name);
    }
    const mode = text(row[20]);
    if (mode === '销售') salesRows += 1;
    else if (mode === '退菜') refundRows += 1;
    else add(`第 ${n} 行销售方式不是「销售/退菜」`);
    if (code && text(row[21])) orders.add(`${code}|${text(row[21])}`);
    for (const [field, col] of SUM_COLUMNS) {
      if (!finiteNumber(row[col])) { add(`第 ${n} 行 ${field} 不是有限数字`); continue; }
      sums[field] += Number(row[col]);
    }
  });
  for (const [field, col, tolerance] of SUM_COLUMNS) {
    if (!finiteNumber(total[col]) || Math.abs(sums[field] - Number(total[col])) > tolerance + 1e-8)
      add(`合计行 ${field} 与明细求和不一致`);
  }
  const amounts = Object.fromEntries(SUM_COLUMNS.map(([name]) => [name, Number(sums[name].toFixed(name.includes('数量') ? 3 : 2))]));
  return {
    ok: errors.length === 0, report_type: REPORT_TYPE, business_date: businessDate,
    worksheet_name: SHEET_NAME, header_columns: HEADERS.length, source_rows: rows.length,
    store_count: stores.size, order_count: orders.size, sales_rows: salesRows, refund_rows: refundRows,
    amounts, metadata_checks: metadata, errors,
  };
}

function validateReportBFile(file, opts = {}) {
  const name = path.basename(String(file || ''));
  let stat;
  try { stat = fs.lstatSync(file); } catch { return { ok: false, report_type: REPORT_TYPE, errors: ['文件不存在'] }; }
  if (!stat.isFile() || stat.size <= 0 || !/\.xlsx$/i.test(name) || /\.crdownload$/i.test(name))
    return { ok: false, report_type: REPORT_TYPE, errors: ['文件不是非空的完整 XLSX'] };
  let workbook;
  try { workbook = require('xlsx').readFile(file, { cellDates: false }); }
  catch { return { ok: false, report_type: REPORT_TYPE, errors: ['无法解析 XLSX'] }; }
  if (!workbook.SheetNames.includes(SHEET_NAME))
    return { ok: false, report_type: REPORT_TYPE, errors: ['未找到「品项销售明细」工作表'] };
  const grid = require('xlsx').utils.sheet_to_json(workbook.Sheets[SHEET_NAME], { header: 1, raw: true, defval: '' });
  return { ...validateGrid(grid, opts), file_size: stat.size };
}

module.exports = { REPORT_TYPE, SHEET_NAME, HEADERS, SUM_COLUMNS, checkMetadata, validateGrid, validateReportBFile };
