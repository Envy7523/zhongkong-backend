// 集团仅作为人事归属，不创建营业门店，也不改变员工表字段。
const GROUP_NAMES = ['永文总公司', '鹅太公连锁', '鹅太公品牌', '同盛'];
const LEGACY_GROUP_NAMES = ['集团', '深圳总部'];
function isGroupAffiliation(value) { return GROUP_NAMES.includes(String(value || '').trim()); }
function key(value) {
  return String(value || '').trim().replace(/[\s（）()·•]/g, '').replace(/^鹅太公烧鹅/, '').replace('景基御景', '京基御景');
}
function resolveAffiliation(value, stores) {
  const name = String(value || '').trim();
  // 历史“集团/深圳总部”归入永文总公司；新建和编辑时只能选择四个明确集团。
  if (LEGACY_GROUP_NAMES.includes(name)) return { store_name: '永文总公司', store_id: null };
  if (isGroupAffiliation(name)) return { store_name: name, store_id: null };
  const normalized = key(name === '未来店' ? '未来花园店' : name);
  if (!normalized) return null;
  const matches = stores.filter(store => key(store.store_name) === normalized);
  return matches.length === 1 ? { store_name: matches[0].store_name, store_id: matches[0].id } : null;
}
function normalizeStaffAffiliations(db) {
  const stores = db.queryAll('SELECT id,store_name FROM stores');
  let changed = 0;
  for (const employee of db.queryAll('SELECT id,store_id,store_name FROM employees')) {
    const affiliation = resolveAffiliation(employee.store_name, stores);
    if (!affiliation) continue;
    if (employee.store_name !== affiliation.store_name || employee.store_id !== affiliation.store_id) {
      db.run('UPDATE employees SET store_name=?,store_id=? WHERE id=?', [affiliation.store_name, affiliation.store_id, employee.id]);
      changed++;
    }
  }
  return changed;
}
module.exports = { GROUP_NAMES, LEGACY_GROUP_NAMES, isGroupAffiliation, resolveAffiliation, normalizeStaffAffiliations };
