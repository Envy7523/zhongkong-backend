const error = (message, status = 400) => Object.assign(new Error(message), { status });
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function scopeFilter(scope, selected) {
  const store = selected === undefined || selected === '' ? null : Number(selected);
  if (store !== null && (!Number.isInteger(store) || store <= 0)) throw error('门店参数无效');
  if (scope !== null && store !== null && scope !== store) throw error('无权查看此门店记账', 403);
  const effective = scope !== null ? scope : store;
  return effective === null ? { sql: '1=1', params: [] } : { sql: 'store_id=?', params: [effective] };
}
function options(db, scope) {
  const f = scopeFilter(scope);
  return {
    stores: db.queryAll(`SELECT id,store_name,status FROM stores ${scope === null ? '' : 'WHERE id=?'} ORDER BY id`, scope === null ? [] : [scope]),
    categories: db.queryAll(`SELECT DISTINCT category_name AS name FROM bookkeeping_entries WHERE ${f.sql} AND category_name<>'' ORDER BY category_name`, f.params),
    latest_date: db.queryOne(`SELECT MAX(date) AS date FROM bookkeeping_entries WHERE ${f.sql}`, f.params)?.date || null,
  };
}
function list(db, scope, query) {
  const f = scopeFilter(scope, query.store_id);
  const from = String(query.date_from || ''); const to = String(query.date_to || '');
  if (!validDate(from) || !validDate(to)) throw error('请选择有效开始和结束日期');
  if (from > to) throw error('开始日期不能晚于结束日期');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 365) throw error('单次最多查询366天，请缩小日期范围');
  const category = String(query.category || '').trim();
  const keyword = String(query.keyword || '').trim();
  if (category.length > 100 || keyword.length > 100) throw error('筛选内容过长');
  const conditions = [f.sql, 'date>=?', 'date<=?']; const params = [...f.params, from, to];
  if (category) { conditions.push('category_name=?'); params.push(category); }
  if (keyword) {
    conditions.push("(remark LIKE ? ESCAPE '\\' OR subcategory_name LIKE ? ESCAPE '\\' OR user_name LIKE ? ESCAPE '\\')");
    const pattern = '%' + keyword.replace(/[\\%_]/g, x => '\\' + x) + '%'; params.push(pattern, pattern, pattern);
  }
  const where = conditions.join(' AND ');
  const page = Math.min(100000, Math.max(1, Math.floor(Number(query.page) || 1)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.page_size) || 30)));
  const summary = db.queryOne(`SELECT COUNT(*) AS count,ROUND(COALESCE(SUM(amount),0),2) AS amount,COUNT(DISTINCT store_id) AS store_count,COUNT(DISTINCT date) AS day_count FROM bookkeeping_entries WHERE ${where}`, params);
  const entries = db.queryAll(`SELECT id,store_id,store_name,date,category_name,subcategory_name,amount,remark,user_name,created_at FROM bookkeeping_entries WHERE ${where} ORDER BY date DESC,id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  const categories = db.queryAll(`SELECT category_name AS name,ROUND(COALESCE(SUM(amount),0),2) AS amount,COUNT(*) AS count FROM bookkeeping_entries WHERE ${where} GROUP BY category_name ORDER BY amount DESC`, params);
  const stores = db.queryAll(`SELECT store_id,store_name,ROUND(COALESCE(SUM(amount),0),2) AS amount,COUNT(*) AS count FROM bookkeeping_entries WHERE ${where} GROUP BY store_id,store_name ORDER BY amount DESC`, params);
  return { entries, summary, categories, stores, total: summary.count, page, page_size: pageSize, date_from: from, date_to: to };
}
module.exports = { list, options, validDate, scopeFilter };
