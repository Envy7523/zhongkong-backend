// Merge independent daily operation and settlement sources by store/date.
// Never derive money from the operation workbook or repeat fee deductions.
module.exports = function getDouyinOperationReport(db, params = {}) {
  const filters = [], values = [];
  const ids = String(params.store_ids || params.store_id || '').split(',').map(Number).filter(id => Number.isInteger(id) && id > 0);
  if (ids.length) { filters.push(`store_id IN (${ids.map(() => '?').join(',')})`); values.push(...ids); }
  if (params.date_from) { filters.push('biz_date>=?'); values.push(params.date_from); }
  if (params.date_to) { filters.push('biz_date<=?'); values.push(params.date_to); }
  const where = filters.length ? ` AND ${filters.join(' AND ')}` : '';
  const operations = db.queryAll(`SELECT * FROM douyin_group_buy_operation_records WHERE match_status='matched'${where} ORDER BY biz_date`, values);
  const revenue = db.queryAll(`SELECT store_id,MAX(store_name) AS store_name,biz_date,
    SUM(gross_amount) AS gross_amount,SUM(actual_amount) AS actual_amount,SUM(order_count) AS order_count
    FROM business_revenue_records WHERE source_type='platform' AND channel='douyin_group'${where}
    GROUP BY store_id,biz_date ORDER BY biz_date`, values);
  const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  function aggregate(ops, money) {
    const latest = new Map();
    ops.forEach(row => latest.set(row.store_id, row));
    const snapshots = [...latest.values()];
    const visits = sum(ops, 'visit_users'), purchases = sum(ops, 'ordering_users');
    return {
      gross_amount: money.length ? sum(money, 'gross_amount') : null,
      actual_amount: money.length ? sum(money, 'actual_amount') : null,
      income_amount: money.length ? sum(money, 'actual_amount') : null,
      order_count: money.length ? sum(money, 'order_count') : null,
      visit_users: ops.length ? visits : null,
      ordering_users: ops.length ? purchases : null,
      order_rate: visits ? purchases / visits : null,
      store_rating: snapshots.length ? sum(snapshots, 'store_rating') / snapshots.length : null,
      review_count: snapshots.length ? sum(snapshots, 'review_count') : null,
      operation_days: new Set(ops.map(row => row.biz_date)).size,
      settlement_days: new Set(money.map(row => row.biz_date)).size,
    };
  }
  // A store with only a settlement still belongs in the financial view.
  const all = [...operations, ...revenue];
  const dates = [...new Set(all.map(row => row.biz_date))].sort();
  const storeIds = [...new Set(all.map(row => row.store_id))];
  return {
    totals: aggregate(operations, revenue), days: dates.length, stores_count: storeIds.length,
    operation_stores_count: new Set(operations.map(row => row.store_id)).size,
    trend: dates.map(date => ({date, ...aggregate(operations.filter(row => row.biz_date === date), revenue.filter(row => row.biz_date === date))})),
    stores: storeIds.map(id => ({store_id: id, store_name: all.find(row => row.store_id === id).store_name,
      ...aggregate(operations.filter(row => row.store_id === id), revenue.filter(row => row.store_id === id))})),
  };
};
