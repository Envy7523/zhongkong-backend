const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveAffiliation, normalizeStaffAffiliations } = require('../lib/staff-affiliation');
const stores = [{ id: 27, store_name: '鹅太公烧鹅（未来花园店）' }, { id: 33, store_name: '鹅太公烧鹅（杭州西溪天街店）' }];
test('门店别名、括号格式和集团归属', () => {
  assert.deepEqual(resolveAffiliation('未来店', stores), { store_name: stores[0].store_name, store_id: 27 });
  assert.deepEqual(resolveAffiliation('鹅太公烧鹅（杭州西溪天街店)', stores), { store_name: stores[1].store_name, store_id: 33 });
  for (const name of ['集团', '深圳总部']) assert.deepEqual(resolveAffiliation(name, stores), { store_name: '集团', store_id: null });
  assert.equal(resolveAffiliation('不存在的店', stores), null);
  assert.equal(resolveAffiliation('', stores), null);
  assert.equal(resolveAffiliation('未来店', [...stores, { id: 99, store_name: stores[0].store_name }]), null);
});
test('修复旧关联，保留未分配档案和其他字段，重复执行不修改数据', () => {
  const employees = [{ id: 1, store_name: '未来店', store_id: null, photo_url: 'unchanged' }, { id: 2, store_name: '深圳总部', store_id: 27 }, { id: 3, store_name: '', store_id: null }];
  const db = { queryAll: sql => sql.includes('FROM stores') ? stores : employees,
    run: (sql, [store_name, store_id, id]) => Object.assign(employees.find(e => e.id === id), { store_name, store_id }) };
  assert.equal(normalizeStaffAffiliations(db), 2);
  assert.equal(employees[0].store_id, 27);
  assert.equal(employees[0].photo_url, 'unchanged');
  assert.equal(employees[1].store_id, null);
  assert.equal(employees[1].store_name, '集团');
  assert.equal(employees[2].store_name, '');
  assert.equal(normalizeStaffAffiliations(db), 0);
});
