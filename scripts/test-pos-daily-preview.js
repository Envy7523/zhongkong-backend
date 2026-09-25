'use strict';

const assert = require('node:assert/strict');
const { buildPosDailyPreview } = require('../lib/pos-daily-preview');

function fakeDb({ records, compositions = [], stores = [{ id: 1, store_name: '甲店' }] }) {
  return { queryAll(sql, params) {
    if (sql.includes('FROM stores')) return stores;
    if (sql.includes('FROM business_revenue_records')) {
      assert.match(sql, /source_type='pos'/);
      assert.deepEqual(params, ['2026-09-24']);
      return records;
    }
    if (sql.includes('FROM business_revenue_compositions')) return compositions;
    throw new Error('unexpected_query');
  } };
}
const record = (channel, group, gross, recorded, orders = 1) => ({
  store_id: 1, store_name: '甲店', channel, channel_group: group,
  gross_amount: gross, recorded_amount: recorded, order_count: orders,
});

const preview = buildPosDailyPreview(fakeDb({
  records: [record('store_sales', 'offline', 100, 80, 2), record('meituan_delivery', 'delivery', 20, 15), record('meituan_group', 'group_buy', 30, 30)],
  compositions: [{ store_id: 1, category: '现金', amount: 80 }, { store_id: 1, category: '外卖', amount: 15 }],
}), '2026-09-24');
assert.equal(preview.ready, false);
assert.match(preview.problems.join('|'), /至少 9 家/);
assert.equal(preview.totals.gross_amount, 120);
assert.equal(preview.totals.recorded_amount, 95);
assert.equal(preview.totals.discount_amount, 25);
assert.equal(preview.totals.order_count, 3);
assert.equal(preview.totals.channels.meituan_delivery, 15);
assert.equal(preview.totals.compositions['现金'], 80);
assert.equal(preview.data_scope.includes('不是第三方平台结算实收'), true);
assert.deepEqual(preview.excluded, ['菜品销量', '第三方平台结算实收']);

const missing = buildPosDailyPreview(fakeDb({ records: [] }), '2026-09-24');
assert.equal(missing.ready, false);
assert.match(missing.problems.join('|'), /缺少店内销售/);

const duplicate = buildPosDailyPreview(fakeDb({ records: [record('store_sales', 'offline', 100, 80), record('store_sales', 'offline', 100, 80)] }), '2026-09-24');
assert.equal(duplicate.ready, false);
assert.match(duplicate.problems.join('|'), /重复/);
assert.equal(duplicate.totals.gross_amount, 100);

assert.throws(() => buildPosDailyPreview(fakeDb({ records: [] }), '2026-02-30'), /business_date_invalid/);
assert.throws(() => buildPosDailyPreview(fakeDb({ records: [] }), '9999-99-99'), /business_date_invalid/);
const scoped = buildPosDailyPreview(fakeDb({
  stores: [{ id: 1, store_name: '甲店' }, { id: 13, store_name: '坂田店' }],
  records: [record('store_sales', 'offline', 100, 80)],
  compositions: [{ store_id: 1, category: '现金', amount: 80 }],
}), '2026-09-24', { excludedStores: { 13: '已停业' } });
assert.equal(scoped.ready, false);
assert.deepEqual(scoped.excluded_stores, [{ store_id: 13, store_name: '坂田店', reason: '已停业' }]);
const twenty = buildPosDailyPreview(fakeDb({
  stores: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, store_name: `门店${i + 1}` })),
  records: Array.from({ length: 20 }, (_, i) => ({ store_id: i + 1, store_name: `门店${i + 1}`, channel: 'store_sales', channel_group: 'offline', gross_amount: 200 - i, recorded_amount: 100, order_count: 1 })),
  compositions: Array.from({ length: 20 }, (_, i) => ({ store_id: i + 1, category: '现金', amount: 100 })),
}), '2026-09-24');
assert.equal(twenty.ready, true);
assert.deepEqual(twenty.focus_groups.map(group => group.rows.map(row => row.rank_label)),
  [['TOP1', 'TOP2', 'TOP3'], ['9', '10', '11'], ['最差3', '最差2', '最差1']]);
console.log('pos-daily-preview: 19 assertions passed');
