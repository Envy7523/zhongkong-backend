'use strict';

const aliases = {
  meituan_delivery: ['美团外卖'], taobao_flash: ['淘宝闪购', '淘宝外卖', '饿了么'],
  jd_delivery: ['京东外卖', '京东秒送'], meituan_group: ['美团团购', '美团/大众点评团购'],
  douyin_group: ['抖音团购', '抖音'],
};
const key = row => `${row.store_id}|${row.biz_date}|${row.channel}`;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// Only exempt known normal zero days. An absent import with sales evidence must
// remain visible even when platform registration dates are incomplete or wrong.
function missingDays(db, candidates, records) {
  if (!candidates.length) return [];
  const ids = [...new Set(candidates.map(r => Number(r.store_id)).filter(id => id > 0))];
  const accounts = db.queryAll(`SELECT store_id,platform_name,platform_id,setup_status,online_date FROM store_platforms WHERE store_id IN (${ids.map(() => '?').join(',')})`, ids);
  const closed = new Map(db.queryAll(`SELECT key,value FROM config WHERE key IN (${ids.map(() => '?').join(',')})`, ids.map(id => `store_finance_closed_days:${id}`)).map(row => {
    let dates = [];
    try { const parsed = JSON.parse(row.value); if (Array.isArray(parsed)) dates = parsed; } catch {}
    return [Number(row.key.split(':')[1]), new Set(dates)];
  }));
  const evidence = new Set(records.filter(r => r.source_type === 'pos'
    && (Number(r.recorded_amount || 0) !== 0 || Number(r.gross_amount || 0) !== 0 || Number(r.order_count || 0) !== 0)).map(key));
  const explicitZeros = new Set(records.filter(r => r.source_type === 'pos'
    && r.recorded_amount != null && r.gross_amount != null && r.order_count != null
    && Number(r.recorded_amount) === 0 && Number(r.gross_amount) === 0 && Number(r.order_count) === 0).map(key));
  const deliveryNames = ['meituan_delivery','taobao_flash','jd_delivery'].flatMap(c => aliases[c]);
  const history = new Set(db.queryAll(`SELECT DISTINCT store_id,channel FROM business_revenue_records
    WHERE source_type='platform' AND store_id IN (${ids.map(() => '?').join(',')})`, ids).map(r => `${r.store_id}|${r.channel}`));
  return candidates.filter(row => {
    if (evidence.has(key(row))) return true;
    if (closed.get(Number(row.store_id))?.has(row.biz_date)) return false;
    // With no group payment/orders, no group transaction file is expected.
    if (['meituan_group', 'douyin_group'].includes(row.channel)) return false;
    const registrations = accounts.filter(a => Number(a.store_id) === Number(row.store_id) && aliases[row.channel]?.includes(a.platform_name));
    const storeAccounts = accounts.filter(a => Number(a.store_id) === Number(row.store_id));
    // A configured dine-in-only store with explicit POS zero and no historical
    // platform import is a normal zero, not an endlessly missing delivery file.
    if (explicitZeros.has(key(row)) && storeAccounts.length
      && !storeAccounts.some(a => deliveryNames.includes(a.platform_name))
      && !history.has(`${row.store_id}|${row.channel}`)) return false;
    const onlineDates = registrations.map(a => a.online_date).filter(validDate).sort();
    if (onlineDates.length && row.biz_date < onlineDates[0]) return false;
    if (registrations.length && registrations.every(a => a.setup_status === '未上线' && !String(a.platform_id || '').trim())) return false;
    return true;
  });
}

module.exports = { missingDays };
