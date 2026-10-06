'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { summarize } = require('../lib/meituan-settlement');
const op = (date, income = 100) => ({ store_id: 1, store_name: '测试门店', biz_date: date, gross_amount: 200, income_amount: income, order_count: 2 });
const bill = (date, type, amount, store_id = 1) => ({ store_id, bill_date: date, bill_type: type, amount });
test('部分店日缺失不能将收入差额生成平台费用或伪造已到账', () => {
  const result = summarize([op('2026-09-29'),op('2026-09-30')], [bill('2026-09-30','外卖订单',102),bill('2026-09-30','保险',-2)]);
  assert.equal(result.complete,false);assert.equal(result.confirmed_amount,100);
  assert.deepEqual(result.missing_days.map(row=>row.date),['2026-09-29']);assert.equal(result.missing_operating_income,100);
  assert.equal(result.expense_total,null);assert.deepEqual(result.expense_items,[]);
  assert.deepEqual(result.fee_items,[{label:'保险',amount:2}]);
});
test('完整店日按原始交易类型拆分，充值和返款保留，费用合计不重复', () => {
  const result=summarize([op('2026-10-01')],[bill('2026-10-01','外卖订单',102),bill('2026-10-01','保险',-2),bill('2026-10-01','推广账户充值',-50),bill('2026-10-01','站外推广费-退款',5)]);
  assert.equal(result.complete,true);assert.equal(result.confirmed_amount,55);
  assert.equal(result.expense_total,145);
  assert.equal(result.expense_items.reduce((sum,row)=>sum+row.amount,0),145);
  assert.equal(result.expense_items.find(row=>row.label==='推广账户充值').amount,50);
  assert.equal(result.expense_items.find(row=>row.label==='站外推广费-退款').amount,-5);
  assert.equal(result.expense_items.some(row=>row.label==='其他结算调整'),false);
});
test('真实零到账不回退营业收入，负到账也保留', () => {
  assert.equal(summarize([op('2026-10-01')],[bill('2026-10-01','外卖订单',10),bill('2026-10-01','保险',-10)]).confirmed_amount,0);
  assert.equal(summarize([op('2026-10-01')],[bill('2026-10-01','外卖订单',10),bill('2026-10-01','推广账户充值',-50)]).confirmed_amount,-40);
});
test('门店与日期共同决定覆盖，保险记录不能替代订单结算记录', () => {
  const result=summarize([op('2026-10-01'),{...op('2026-10-01'),store_id:2}],[bill('2026-10-01','外卖订单',100),bill('2026-10-01','保险',-2,2)]);
  assert.equal(result.complete,false);assert.equal(result.missing_days[0].store_id,2);
});
test('有结算但缺营业日报时不反推优惠；零营业停业日无需凭空补结算', () => {
  const result=summarize([{...op('2026-10-01',0),gross_amount:0,order_count:0}], [bill('2026-10-02','外卖订单',100)]);
  assert.equal(result.missing_days.length,0);assert.equal(result.complete,false);
  assert.deepEqual(result.missing_operation_days,[{store_id:1,date:'2026-10-02'}]);
  assert.equal(summarize([],[]).complete,false);
});
