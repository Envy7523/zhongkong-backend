'use strict';
const A = require('./personnel-access');
const I = require('./store-manager-identity');

// One account may manage several stores or hold several manager roles. Each
// store still has only one formal manager, across roles and login channels.
function legacyConfig(db, user, roles) {
  const ids = roles ? roles.map(p => p.id) : [...new Set([
    ...db.queryAll('SELECT position_id FROM user_positions WHERE user_id=?', [user.id]).map(p => p.position_id),
    user.position_id,
  ].filter(Boolean))];
  return { employee_id: user.employee_id, channels: ['web', 'mini'], assignments: ids.map(position_id => ({
    position_id, mode: 'stores', store_ids: user.store_id ? [Number(user.store_id)] : [], region_ids: [],
  })) };
}
function storesFor(db, user, config, ps = A.positions(db)) {
  const c = config || A.config(db, user.id) || legacyConfig(db, user);
  const employeeId = c.employee_id || user.employee_id;
  if (employeeId && require('./employee-mini-context').departed(db.queryOne('SELECT * FROM employees WHERE id=?', [employeeId]))) return [];
  return A.union(c.assignments.flatMap(a => {
    const p = ps.find(p => p.id === a.position_id);
    return I.formal(p) && c.channels.some(ch => p.channels.includes(ch))
      ? [A.intersect(A.scopeIds(db, a), A.scopeIds(db, p))] : [];
  }));
}
function conflictError(db, storeId, users) {
  const store = db.queryOne('SELECT store_name FROM stores WHERE id=?', [storeId]);
  return Object.assign(new Error(`${store?.store_name || '门店' + storeId}已有正式店长：${users.map(u => u.display_name || u.username || '账号' + u.id).join('、')}。每家门店只能有一名正式店长，请先调整原店长职责，或通过“正式店长任命”完成交接。店员和储备店长可配置多人。`), {status: 409});
}
function assertPerson(db, user, next, options={}) {
  const employeeId=next.employee_id||user.employee_id;if(employeeId&&require('./staff-training').trainee(db.queryOne('SELECT * FROM employees WHERE id=?',[employeeId]))&&next.assignments.some(a=>I.formal(A.positions(db).find(p=>p.id===a.position_id)))&&!options.appointment)throw Object.assign(new Error('实习店长须通过正式店长任命审批，不能直接赋予正式店长账号权限'),{status:409});
  const ps = A.positions(db), scope = storesFor(db, user, next, ps);
  if (scope !== null && !scope.length) return;
  const stores = db.queryAll('SELECT id FROM stores');
  for (const other of db.queryAll('SELECT * FROM users')) {
    if (Number(other.id) === Number(user.id)) continue;
    const overlap = A.intersect(scope, storesFor(db, other, undefined, ps));
    const store = stores.find(s => A.allows(overlap, s.id));
    if (store) throw conflictError(db, store.id, [other]);
  }
}
function conflicts(db) {
  const ps = A.positions(db), people = db.queryAll('SELECT * FROM users').map(u => ({...u, scope: storesFor(db, u, undefined, ps)}));
  return db.queryAll('SELECT id,store_name FROM stores').flatMap(s => {
    const users = people.filter(u => A.allows(u.scope, s.id));
    return users.length > 1 ? [{store_id: s.id, store_name: s.store_name, users: users.map(({id, display_name, username}) => ({id, display_name, username}))}] : [];
  });
}
function pairs(rows) {
  return new Set(rows.flatMap(r => r.users.flatMap((a, i) => r.users.slice(i + 1).map(b => `${r.store_id}:${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`))));
}
// Check the complete result of scope/policy changes, while permitting existing
// conflicts to be reduced. A failed change must not leave partial writes behind.
function protect(db, change) {
  const before = pairs(conflicts(db));
  db.run('SAVEPOINT formal_manager_unique');
  try {
    const result = change();
    for (const row of conflicts(db)) {
      if ([...pairs([row])].some(key => !before.has(key))) throw conflictError(db, row.store_id, row.users);
    }
    db.run('RELEASE SAVEPOINT formal_manager_unique');
    return result;
  } catch (e) {
    db.run('ROLLBACK TO SAVEPOINT formal_manager_unique');
    db.run('RELEASE SAVEPOINT formal_manager_unique');
    throw e;
  }
}
module.exports = {legacyConfig, storesFor, assertPerson, conflicts, protect};
