'use strict';
const cents = value => Math.round(Number(value || 0) * 100);
const amount = value => value / 100;
function summarize(operations, bills) {
  const operationDays = new Map(operations.map(row => [`${row.store_id}|${row.biz_date}`, row]));
  const orderDays = new Set();
  const feeTypes = new Map();
  let confirmed = 0, orders = 0;
  for (const bill of bills) {
    const value = cents(bill.amount); confirmed += value;
    if (bill.bill_type === '外卖订单') {
      orders += value; orderDays.add(`${bill.store_id}|${bill.bill_date}`);
    } else feeTypes.set(bill.bill_type || '未分类交易', (feeTypes.get(bill.bill_type || '未分类交易') || 0) - value);
  }
  const missing = [...operationDays.entries()].filter(([key, row]) =>
    (cents(row.gross_amount) !== 0 || cents(row.income_amount) !== 0 || Number(row.order_count) > 0) && !orderDays.has(key))
    .map(([, row]) => ({ store_id: row.store_id, store_name: row.store_name, date: row.biz_date, operating_income: Number(row.income_amount || 0) }));
  const missingOperations = [...orderDays].filter(key => !operationDays.has(key)).map(key => {
    const [store_id, date] = key.split('|'); return { store_id: Number(store_id), date };
  });
  const complete = bills.length > 0 && missing.length === 0 && missingOperations.length === 0;
  const gross = operations.reduce((sum, row) => sum + cents(row.gross_amount), 0);
  const feeItems = [...feeTypes].filter(([, value]) => value !== 0).map(([label, value]) => ({ label, amount: amount(value) }));
  return {
    complete, has_bills: bills.length > 0, missing_days: missing, missing_operation_days: missingOperations,
    missing_operating_income: amount(missing.reduce((sum, row) => sum + cents(row.operating_income), 0)),
    confirmed_amount: amount(confirmed), order_receivable: amount(orders),
    fee_items: feeItems,
    // 订单应收已扣订单内费用，这项仅解释差额，不声称全部是客户优惠。
    expense_items: complete ? [{ label: '订单内优惠及扣费（差额）', amount: amount(gross - orders) }, ...feeItems] : [],
    expense_total: complete ? amount(gross - confirmed) : null,
  };
}
module.exports = { summarize };
