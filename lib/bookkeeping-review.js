'use strict';
// Versioned daily source refresh. Unlinked manual entries are never deleted implicitly.
const crypto = require('crypto');
const source = require('./pos-bookkeeping-daily');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm = source.normalizedName;
const money = amount => Math.round(Number(amount) * 100);
function ensureSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS pos_bookkeeping_daily_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, business_date TEXT NOT NULL, review_key TEXT NOT NULL,
    file_sha256 TEXT NOT NULL, content_sha256 TEXT NOT NULL, before_json TEXT NOT NULL,
    after_json TEXT NOT NULL, differences_json TEXT NOT NULL, row_count INTEGER NOT NULL,
    total_cents INTEGER NOT NULL, status TEXT NOT NULL, imported_by INTEGER NOT NULL,
    checked_at TEXT NOT NULL, UNIQUE(business_date,review_key))`);
}
function migrateSchedule(db) {
  const key = 'bookkeeping_review_schedule_v1';
  if (db.queryOne('SELECT value FROM config WHERE key=?', [key])) return;
  const before = db.queryOne("SELECT * FROM report_sync_plans WHERE report_type='pos_bookkeeping_daily'");
  if (before && before.run_time !== '02:00') {
    const at = new Date().toISOString();
    db.run("UPDATE report_sync_plans SET run_time='02:00',version=version+1,updated_at=?,updated_by_name=? WHERE report_type='pos_bookkeeping_daily'",
      [at, '用户授权：记账本每日02:00及历史复核']);
    const after = db.queryOne("SELECT * FROM report_sync_plans WHERE report_type='pos_bookkeeping_daily'");
    db.insert('INSERT INTO report_sync_plan_audit (report_type,at,user_name,before_json,after_json) VALUES (?,?,?,?,?)',
      ['pos_bookkeeping_daily', at, '记账本复核上线', JSON.stringify(before), JSON.stringify(after)]);
  }
  db.run('INSERT INTO config (key,value) VALUES (?,?)', [key, 'applied']);
}
function canonical(rows) {
  const sums = new Map();
  for (const r of rows) {
    const key = JSON.stringify([Number(r.store_id), norm(r.category_name), norm(r.subcategory_name)]);
    sums.set(key, (sums.get(key) || 0) + (r.amount_cents === undefined ? money(r.amount) : r.amount_cents));
  }
  return [...sums].map(([key, amount]) => [...JSON.parse(key), amount])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function inspect(db, parsed, { adoptLegacy = false } = {}) {
  const stores = new Map();
  for (const s of db.queryAll('SELECT id,store_name,pos_store_code FROM stores')) {
    const k = norm(s.store_name);
    if (stores.has(k)) throw new Error('store_master_ambiguous');
    stores.set(k, s);
  }
  const entries = parsed.entries.map(r => {
    let s = stores.get(norm(r.store_name));
    if (!s && parsed.business_date === '2026-09-24' && r.store_name === '鹅太公（麓城店）'
      && r.amount_cents === 0) s = [...stores.values()].find(t => t.id === 29 && t.pos_store_code === 'MD00023');
    if (!s) throw new Error(`store_unmatched:${r.store_name}`);
    return { ...r, store_id: s.id, store_name: s.store_name };
  });
  const keys = entries.map(r => JSON.stringify([r.store_id, norm(r.category_name), norm(r.subcategory_name)]));
  if (new Set(keys).size !== keys.length) throw new Error('duplicate_source_category');
  const all = db.queryAll('SELECT * FROM bookkeeping_entries WHERE date=? ORDER BY id', [parsed.business_date]);
  const links = new Set(db.queryAll(`SELECT l.entry_id FROM pos_bookkeeping_daily_import_rows l
    JOIN pos_bookkeeping_daily_imports b ON b.id=l.batch_id WHERE b.business_date=?`, [parsed.business_date]).map(r => r.entry_id));
  const owned = all.filter(r => links.has(r.id));
  const manual = all.filter(r => !links.has(r.id));
  const legacy = adoptLegacy ? manual.filter(r => r.remark === '快捷录入' && (!r.images || r.images === '[]')) : [];
  if (adoptLegacy && legacy.length !== manual.length) throw new Error('legacy_provenance_ambiguous');
  const prior = db.queryOne('SELECT * FROM pos_bookkeeping_daily_reviews WHERE business_date=? ORDER BY id DESC LIMIT 1', [parsed.business_date]);
  // A human edit of previously verified robot data must not be silently overwritten.
  if (prior && hash(canonical(owned)) !== prior.content_sha256) throw new Error('verified_source_modified_locally');
  const before = [...owned, ...legacy];
  const previous = new Map(canonical(before).map(r => [JSON.stringify(r.slice(0, 3)), r[3]]));
  const current = new Map(canonical(entries).map(r => [JSON.stringify(r.slice(0, 3)), r[3]]));
  const differences = [];
  for (const k of new Set([...previous.keys(), ...current.keys()])) {
    const a = previous.has(k) ? previous.get(k) : null;
    const b = current.has(k) ? current.get(k) : null;
    if (a !== b) differences.push({ key: JSON.parse(k), before_cents: a, after_cents: b,
      change: a === null ? 'added' : b === null ? 'removed' : 'modified' });
  }
  const content = hash(canonical(entries));
  return { entries, owned, legacy, manual: manual.filter(r => !legacy.includes(r)),
    before, differences, content_sha256: content, expected_state: hash(all),
    status: differences.length ? 'changed' : 'unchanged', row_count: entries.length,
    total_cents: parsed.total_cents, business_date: parsed.business_date };
}
function commit(db, parsed, user, { reviewKey, expectedState, adoptLegacy = false, allowEmpty = false } = {}) {
  if (!/^[A-Za-z0-9._-]{3,100}$/.test(String(reviewKey || ''))) throw new Error('review_key_invalid');
  if (!Number.isInteger(Number(user?.id)) || Number(user.id) <= 0) throw new Error('import_user_invalid');
  if (!parsed.entries.length && !allowEmpty) throw new Error('empty_report_requires_confirmation');
  const done = db.queryOne('SELECT * FROM pos_bookkeeping_daily_reviews WHERE business_date=? AND review_key=?', [parsed.business_date, reviewKey]);
  if (done) {
    if (done.file_sha256 !== parsed.file_sha256) throw new Error('review_key_content_conflict');
    return { ok: true, already_reviewed: true, review_id: done.id, status: done.status,
      row_count: done.row_count, total_cents: done.total_cents, differences: JSON.parse(done.differences_json) };
  }
  db.run('BEGIN');
  try {
    const gate = inspect(db, parsed, { adoptLegacy });
    if (gate.expected_state !== expectedState) throw new Error('review_state_changed');
    const categories = new Map(db.queryAll('SELECT id,name FROM bookkeeping_categories').map(r => [norm(r.name), r]));
    const subs = new Map(db.queryAll('SELECT id,category_id,name FROM bookkeeping_subcategories').map(r => [`${r.category_id}:${norm(r.name)}`, r]));
    let batch = db.queryOne('SELECT id FROM pos_bookkeeping_daily_imports WHERE business_date=?', [parsed.business_date]);
    if (!batch) batch = { id: db.insert(`INSERT INTO pos_bookkeeping_daily_imports
      (business_date,file_sha256,row_count,store_count,total_cents,imported_by) VALUES (?,?,?,?,?,?)`,
    [parsed.business_date, parsed.file_sha256, gate.row_count, parsed.store_count, parsed.total_cents, user.id]) };
    const old = new Map(gate.before.map(r => [JSON.stringify([r.store_id, norm(r.category_name), norm(r.subcategory_name)]), r]));
    // Links are rebuilt explicitly; sql.js foreign-key enforcement cannot be assumed.
    db.run('DELETE FROM pos_bookkeeping_daily_import_rows WHERE batch_id=?', [batch.id]);
    const retained = new Set();
    for (const r of gate.entries) {
      const key = JSON.stringify([r.store_id, norm(r.category_name), norm(r.subcategory_name)]);
      let cat = categories.get(norm(r.category_name));
      if (!cat) { cat = { id: db.insert('INSERT INTO bookkeeping_categories (name,sort_order) VALUES (?,999)', [r.category_name]), name: r.category_name }; categories.set(norm(r.category_name), cat); }
      const subKey = `${cat.id}:${norm(r.subcategory_name)}`;
      let sub = subs.get(subKey);
      if (!sub) { sub = { id: db.insert('INSERT INTO bookkeeping_subcategories (category_id,name,sort_order) VALUES (?,?,999)', [cat.id, r.subcategory_name]), name: r.subcategory_name }; subs.set(subKey, sub); }
      const existing = old.get(key);
      let id;
      if (existing) {
        id = existing.id;
        if (money(existing.amount) !== r.amount_cents) db.run('UPDATE bookkeeping_entries SET amount=? WHERE id=?', [r.amount_cents / 100, id]);
      } else id = db.insert(`INSERT INTO bookkeeping_entries
        (store_id,store_name,user_id,user_name,date,category_id,category_name,subcategory_id,subcategory_name,amount,images,remark)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [r.store_id, r.store_name, user.id, user.display_name || user.username || 'syncbot',
        parsed.business_date, cat.id, cat.name, sub.id, sub.name, r.amount_cents / 100, '[]', `收银系统记账本复核 #${batch.id}`]);
      retained.add(id);
      db.insert('INSERT INTO pos_bookkeeping_daily_import_rows (batch_id,entry_id,source_line) VALUES (?,?,?)', [batch.id, id, r.line]);
    }
    for (const r of gate.before) if (!retained.has(r.id)) db.run('DELETE FROM bookkeeping_entries WHERE id=?', [r.id]);
    const verified = db.queryAll(`SELECT e.* FROM pos_bookkeeping_daily_import_rows l
      JOIN bookkeeping_entries e ON e.id=l.entry_id WHERE l.batch_id=? ORDER BY e.id`, [batch.id]);
    if (hash(canonical(verified)) !== gate.content_sha256) throw new Error('review_post_check_failed');
    const afterManual = db.queryAll(`SELECT * FROM bookkeeping_entries WHERE date=? AND id NOT IN
      (SELECT entry_id FROM pos_bookkeeping_daily_import_rows WHERE batch_id=?) ORDER BY id`, [parsed.business_date, batch.id]);
    if (hash(afterManual) !== hash(gate.manual)) throw new Error('manual_entries_changed');
    db.run('UPDATE pos_bookkeeping_daily_imports SET file_sha256=?,row_count=?,store_count=?,total_cents=? WHERE id=?',
      [parsed.file_sha256, gate.row_count, parsed.store_count, parsed.total_cents, batch.id]);
    const reviewId = db.insert(`INSERT INTO pos_bookkeeping_daily_reviews
      (business_date,review_key,file_sha256,content_sha256,before_json,after_json,differences_json,row_count,total_cents,status,imported_by,checked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [parsed.business_date, reviewKey, parsed.file_sha256, gate.content_sha256,
      JSON.stringify(gate.before), JSON.stringify(verified), JSON.stringify(gate.differences), gate.row_count,
      parsed.total_cents, gate.status, user.id, new Date().toISOString()]);
    db.run('COMMIT'); db.save();
    return { ok: true, review_id: reviewId, batch_id: batch.id, business_date: parsed.business_date,
      status: gate.status, row_count: gate.row_count, total_cents: parsed.total_cents,
      content_sha256: gate.content_sha256, manual_preserved: gate.manual.length,
      adopted_legacy: gate.legacy.length, differences: gate.differences };
  } catch (e) { try { db.run('ROLLBACK'); } catch {} throw e; }
}
module.exports = { ensureSchema, migrateSchedule, inspect, commit, canonical, hash };
