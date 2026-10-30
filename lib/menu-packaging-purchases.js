'use strict';
const seed = require('./menu-packaging-purchase-seed.json');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
function initialize(db) {
  db.run(`CREATE TABLE IF NOT EXISTS menu_packaging_purchases(material_id TEXT PRIMARY KEY,purchase_unit TEXT NOT NULL,units_per_purchase REAL NOT NULL,purchase_price REAL NOT NULL)`);
}
function list(db) {
  return db.queryAll(`SELECT m.*,p.purchase_unit,p.units_per_purchase,p.purchase_price FROM menu_packaging_materials m LEFT JOIN menu_packaging_purchases p ON p.material_id=m.id ORDER BY m.rowid`);
}
function prepare(body, current) {
  const fields = ['purchase_unit', 'units_per_purchase', 'purchase_price'];
  if (!fields.some(k => body[k] !== undefined && body[k] !== null && body[k] !== '')) {
    // Older clients can still maintain unconverted records. A converted record
    // cannot silently acquire a price inconsistent with its purchase specification.
    if (current?.purchase_unit) {
      if (body.unit_cost !== undefined && Number(body.unit_cost) !== current.unit_cost) fail('请修改采购价或每单位件数，单件成本会自动换算');
      return { purchase_unit: current.purchase_unit, units_per_purchase: current.units_per_purchase, purchase_price: current.purchase_price, unit_cost: current.unit_cost };
    }
    return null;
  }
  const unit = typeof body.purchase_unit === 'string' ? body.purchase_unit.trim() : '';
  if (!unit || unit.length > 12) fail('请填写采购单位，例如箱、包、件');
  const count = Number(body.units_per_purchase), price = Number(body.purchase_price);
  if (typeof body.units_per_purchase === 'boolean' || !Number.isInteger(count) || count < 1 || count > 1e8) fail('每采购单位件数必须是1至100000000的整数');
  if (body.purchase_price === null || body.purchase_price === '' || typeof body.purchase_price === 'boolean' || !Number.isFinite(price) || price < 0 || price > 1e8) fail('请填写有效的采购价，允许为0');
  return { purchase_unit: unit, units_per_purchase: count, purchase_price: price, unit_cost: price / count };
}
function save(db, id, purchase) {
  if (!purchase) return;
  db.run('INSERT OR REPLACE INTO menu_packaging_purchases(material_id,purchase_unit,units_per_purchase,purchase_price) VALUES(?,?,?,?)', [id, purchase.purchase_unit, purchase.units_per_purchase, purchase.purchase_price]);
}
function backfill(db) {
  if (!db.queryAll || !db.queryOne || !db.queryOne('SELECT hash FROM menu_packaging_imports WHERE hash=?', [seed.hash])) return;
  for (const p of seed.materials) {
    const current = db.queryOne('SELECT * FROM menu_packaging_materials WHERE id=?', [p.id]);
    if (!current || current.unit !== p.unit || Math.abs(current.unit_cost - p.unit_cost) > 1e-10 || db.queryOne('SELECT material_id FROM menu_packaging_purchases WHERE material_id=?', [p.id])) continue;
    save(db, p.id, p);
    // Fill only verified purchase facts; keep the reviewed unit cost at full precision.
    db.run("UPDATE menu_packaging_materials SET revision=revision+1,updated_at=datetime('now','localtime') WHERE id=?", [p.id]);
    const next = list(db).find(m => m.id === p.id);
    db.run('INSERT INTO menu_packaging_versions(material_id,payload_json) VALUES(?,?)', [p.id, JSON.stringify(next)]);
  }
}
module.exports = { initialize, list, prepare, save, backfill };
