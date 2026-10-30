const XLSX = require('xlsx');

// 抖音“门店基础数据”曾使用“访问人数 / 购买人数”，新版改为“门店页访问人数 / 门店页成交人数”。
// 统一在这里解析，避免新版文件被误判为分账明细而直接拒绝。
const HEADER_ALIASES = {
  id: ['门店ID'], date: ['天', '日期', '统计日期'], visits: ['访问人数', '门店页访问人数'],
  purchases: ['门店意向成交人数', '购买人数', '门店页成交人数'], rating: ['门店评分'], reviews: ['累计评价数'], name: ['门店名称'],
  click_users: ['商品点击人数'], purchase_amount: ['门店意向成交金额'],
  consume_amount: ['门店核销金额'], consume_users: ['门店核销人数'],
  refund_amount: ['门店意向退款金额'], refund_users: ['门店意向退款人数'], light_count: ['门店点亮数'],
};
function columnIndex(headers, key) { return headers.findIndex(value => HEADER_ALIASES[key].includes(String(value).trim())); }
function detect(workbook) {
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: true });
    const headers = (rows[0] || []).map(value => String(value).trim());
    if (['id', 'date', 'visits', 'purchases', 'rating', 'reviews'].every(key => columnIndex(headers, key) >= 0)) return { rows, headers };
  }
  return null;
}
function importReport(db, report, params, user) {
  const records = [], seen = new Set(),excluded=require('./platform-source-exclusions').load(db,'抖音团购');
  for (const [i, row] of report.rows.slice(1).entries()) {
    if (row.every(value => value === '')) continue;
    const get = key => row[columnIndex(report.headers, key)];
    const id = String(get('id')).trim();
    if (typeof get('id') === 'number' && !Number.isSafeInteger(get('id'))) throw Error('门店ID必须为文本，避免长数字精度丢失');
    let date = String(get('date')).replaceAll('/', '-');
    if (typeof get('date') === 'number') {
      const parsed = XLSX.SSF.parse_date_code(get('date'));
      date = parsed ? String(parsed.y) + '-' + String(parsed.m).padStart(2, '0') + '-' + String(parsed.d).padStart(2, '0') : '';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !id) throw Error('第' + (i + 2) + '行日期或ID无效');
    const metrics = ['visits', 'purchases', 'rating', 'reviews'].map(key => {
      const number = Number(get(key));
      if (!Number.isFinite(number) || number < 0) throw Error('第' + (i + 2) + '行' + HEADER_ALIASES[key][0] + '无效');
      return number;
    });
    if (metrics[2] > 5) throw Error('门店评分超出范围');
    const uniqueKey = id + '|' + date;
    if (seen.has(uniqueKey)) throw Error('门店日期重复：' + uniqueKey);
    seen.add(uniqueKey);
    const isExcluded=excluded(String(get('name')||''));
    const store = isExcluded?null:db.queryOne("SELECT s.id,s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id WHERE p.platform_name='抖音团购' AND p.platform_id=?", [id]);
    const extra = {};
    for (const key of ['click_users','purchase_amount','consume_amount','consume_users','refund_amount','refund_users','light_count']) {
      if (columnIndex(report.headers,key) < 0) continue;
      const value = Number(String(get(key)).replaceAll(',', '').replace(/^¥|^￥/, ''));
      if (!Number.isFinite(value) || value < 0) throw Error('第'+(i+2)+'行'+HEADER_ALIASES[key][0]+'无效');
      extra[key]=value;
    }
    records.push({ id, date, metrics, extra, store, excluded:isExcluded, name: String(get('name') || '') });
  }
  if (!records.length) throw Error('没有有效经营数据');
  db.run('BEGIN');
  try {
    const batch = db.insert('INSERT INTO business_import_batches(source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES(?,?,?,?,?,?)', ['platform', '抖音团购', params.file_name || '', records.length, user?.id || null, user?.display_name || '']);
    for (const record of records) {
      db.run('DELETE FROM douyin_group_buy_operation_records WHERE douyin_store_id=? AND biz_date=?', [record.id, record.date]);
      db.run('INSERT INTO douyin_group_buy_operation_records(batch_id,douyin_store_id,source_store_name,biz_date,visit_users,ordering_users,store_rating,review_count,raw_json,store_id,store_name,match_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [batch, record.id, record.name, record.date, ...record.metrics, JSON.stringify(record.extra), record.store?.id || null, record.store?.store_name || '', record.store ? 'matched' : record.excluded?'excluded':'unmatched']);
    }
    const dates = records.map(record => record.date).sort();
    db.run('UPDATE business_import_batches SET date_from=?,date_to=? WHERE id=?', [dates[0], dates.at(-1), batch]);
    db.run('COMMIT'); db.save();
    const unmatched = records.filter(record => !record.store&&!record.excluded);
    return { batch_id: batch, data_kind: 'douyin_group_operation', imported: records.filter(r=>r.store).length, excluded:records.filter(r=>r.excluded).length, raw_imported: records.length, unmatched: unmatched.length, matched_stores: new Set(records.filter(record => record.store).map(record => record.store.id)).size, date_from: dates[0], date_to: dates.at(-1), errors: [...new Set(unmatched.map(record => '未关联抖音门店ID：' + record.id))] };
  } catch (error) { db.run('ROLLBACK'); throw error; }
}
const getReport = require('./douyin-operation-report');
module.exports = { detect, importReport, getReport, HEADER_ALIASES, columnIndex };
