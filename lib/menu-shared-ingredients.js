'use strict';
const crypto = require('crypto');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
function positive(value, name, zero = false) { const n = Number(value); if (!finite(value) || n < 0 || (!zero && !n) || n > 1e8) fail(`${name}须为有效${zero ? '非负' : '正'}数`); return n; }
function initialize(db) {
  db.run(`CREATE TABLE IF NOT EXISTS menu_food_materials(id TEXT PRIMARY KEY,standard_key TEXT UNIQUE,name TEXT NOT NULL,unit TEXT NOT NULL,payload_json TEXT NOT NULL,revision INTEGER DEFAULT 1,status TEXT DEFAULT 'active',merged_into TEXT,updated_at TEXT DEFAULT(datetime('now','localtime')))`);
  db.run(`CREATE TABLE IF NOT EXISTS menu_food_material_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,material_id TEXT NOT NULL,revision INTEGER NOT NULL,payload_json TEXT NOT NULL,created_at TEXT DEFAULT(datetime('now','localtime')))`);
  db.run('CREATE TABLE IF NOT EXISTS menu_cost_migrations(key TEXT PRIMARY KEY)');
}
function transaction(db, fn) { db.run('BEGIN'); let result; try { result = fn(); db.run('COMMIT'); } catch (e) { db.run('ROLLBACK'); throw e; } db.save(); return result; }
function alias(name) {
  return ({ '鹅胸肉＋鹅骨肉': '烧鹅', 鹅肉: '烧鹅', '鸭胸肉＋鸭骨肉': '烧鸭', 鸭肉: '烧鸭', 蜜汁叉烧: '叉烧', 化皮烧肉: '烧肉', 蜜汁鸡翅: '鸡翅', 鹅肶: '鹅腿', 鸭肶: '鸭腿', 大烧鹅翅: '战斧鹅翅', 酸梅酱: '酸梅汁', 葱蒜蓉汁: '葱蓉酱', 叉烧汁: '烧汁', 濑粉高汤: '生地汤', 濑粉: '粉', '滑蛋饭蛋液/约323g': '鸡蛋液', 炒酸菜: '咸菜', 手剥蒜: '蒜米', 蒜: '蒜米' })[name] || name;
}
function normalizeLine(line) {
  let name = alias(line.ingredient_name), quantity = Number(line.quantity), unit = line.unit || '份', cost = Number(line.unit_cost);
  if (name === '.' && /出成率校准!\$J\$31/.test(line.formula || '')) name = '叉烧';
  const dual = String(line.source_quantity || '').match(/^([\d.]+)\/([\d.]+)(块|片)\/克$/);
  if (dual && Number(dual[1]) > 0) { const ratio = Number(dual[2]) / Number(dual[1]); quantity *= ratio; cost /= ratio; unit = '克'; }
  const legWeight = name === '鸭腿' && unit === '个' && String(line.formula || '').match(/\*(\d+(?:\.\d+)?)\/150$/);
  if (legWeight) { quantity *= Number(legWeight[1]); cost /= Number(legWeight[1]); unit = '克'; }
  const weight = { g: 1, 克: 1, 斤: 500, kg: 1000, 千克: 1000, 公斤: 1000 };
  const volume = { ml: 1, 毫升: 1, L: 1000, 升: 1000 };
  if (weight[unit]) { quantity *= weight[unit]; cost /= weight[unit]; unit = '克'; }
  else if (volume[unit]) { quantity *= volume[unit]; cost /= volume[unit]; unit = '毫升'; }
  return { name, quantity, unit, unit_cost: cost };
}
function rawRows(db) { return db.queryAll('SELECT * FROM menu_food_materials ORDER BY rowid').map(r => ({ ...JSON.parse(r.payload_json), id: r.id, name: r.name, unit: r.unit, revision: r.revision, status: r.status, merged_into: r.merged_into, updated_at: r.updated_at })); }
function resolve(rows) {
  const map = new Map(rows.map(r => [r.id, r])), result = new Map();
  function one(id, path = []) {
    if (result.has(id)) return result.get(id);
    if (path.includes(id)) fail('通用食材配方不能循环引用');
    const r = map.get(id);
    if (!r) return { unit_cost: null, complete: false };
    if (r.status === 'merged') return one(r.merged_into, [...path, id]);
    let price = r.unit_cost, complete = finite(price);
    if (r.pricing_mode === 'recipe') {
      complete = r.components.length > 0 && finite(r.output_quantity) && r.output_quantity > 0;
      price = 0;
      for (const c of r.components) { const child = one(c.material_id, [...path, id]); if (!child.complete) complete = false; else price += child.unit_cost * c.quantity; }
      price = complete ? price / r.output_quantity : null;
    }
    const value = { ...r, unit_cost: complete ? Number(price) : null, complete, manual_unit_cost: r.unit_cost };
    result.set(id, value); return value;
  }
  for (const r of rows) one(r.id);
  return { map, result, one };
}
function migrate(db) {
  const rows = db.queryAll('SELECT * FROM menu_cost_recipes ORDER BY rowid');
  const missing = rows.filter(r => JSON.parse(r.payload_json).lines.some(l => !l.material_id));
  const seedPrep = !db.queryOne("SELECT key FROM menu_cost_migrations WHERE key='shared-food-v1'");
  if (!missing.length && !seedPrep) return;
  transaction(db, () => {
    const seededIds = new Set();
    function add(name, unit, price, extra = {}) {
      const key = `${name}|${unit}|${finite(price) ? Number(Number(price).toFixed(8)) : 'pending'}`;
      const id = 'food-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
      if (!db.queryOne('SELECT id FROM menu_food_materials WHERE id=?', [id])) {
        const value = { id, name, unit, unit_cost: finite(price) ? Number(price) : null, spec: '', kind: '食材', note: '由原卡分项成本与标准用量折算；多道菜引用同一标准。', pricing_mode: 'manual', output_quantity: 1, components: [], ...extra };
        db.run('INSERT INTO menu_food_materials(id,standard_key,name,unit,payload_json) VALUES(?,?,?,?,?)', [id, key, name, unit, JSON.stringify(value)]);
        db.run('INSERT INTO menu_food_material_versions(material_id,revision,payload_json) VALUES(?,?,?)', [id, 1, JSON.stringify(value)]);
        seededIds.add(id);
      }
      return id;
    }
    for (const row of missing) {
      const recipe = JSON.parse(row.payload_json);
      recipe.lines = recipe.lines.map(l => {
        if (l.material_id) return l;
        const n = normalizeLine(l);
        const kind = /汁|酱|汤|米饭|鸡蛋液/.test(n.name) ? '半成品' : '食材';
        const material_id = add(n.name, n.unit, n.unit_cost, { kind });
        return { ...l, original_ingredient_name: l.ingredient_name, ingredient_name: n.name, quantity: n.quantity, unit: n.unit, material_id };
      });
      db.run('UPDATE menu_cost_recipes SET payload_json=? WHERE id=?', [JSON.stringify(recipe), row.id]);
    }
    if (seedPrep) for (const batch of db.queryAll('SELECT metadata_json FROM menu_cost_imports')) {
      const meta = JSON.parse(batch.metadata_json);
      for (const prep of meta.preparations || []) {
        const yieldMatch = String(prep.yield || '').match(/^([\d.]+)\s*(kg|g|斤|克|千克)$/i);
        if (!yieldMatch || !finite(prep.total)) continue;
        const output = Number(yieldMatch[1]) * ({ kg: 1000, g: 1, 斤: 500, 克: 1, 千克: 1000 }[yieldMatch[2].toLowerCase()]);
        const components = [];
        for (const l of prep.lines) {
          const q = Number(String(l.quantity).split('/')[0]), unit = String(l.unit || '份').split('/')[0];
          if (!Number.isFinite(q) || q <= 0) continue;
          const n = normalizeLine({ ingredient_name: l.name, quantity: q, unit, unit_cost: finite(l.subtotal) ? l.subtotal / q : null });
          const id = add(n.name, n.unit, finite(l.subtotal) ? n.unit_cost : null, { kind: '食材', note: `原卡半成品用料标准；来源${l.source}。` });
          components.push({ material_id: id, quantity: n.quantity });
        }
        const price = prep.total / output, name = alias(prep.name);
        const id = add(name, '克', price, { kind: '半成品' });
        const row = db.queryOne('SELECT * FROM menu_food_materials WHERE id=?', [id]);
        const value = { ...JSON.parse(row.payload_json), kind: '半成品', pricing_mode: 'recipe', output_quantity: output, components, note: `共用批次配方；原卡出品${prep.yield}，批次成本${prep.total.toFixed(4)}元。` };
        // Only adopt a complete batch recipe that reproduces its saved cost.
        const trial = rawRows(db).map(r => r.id === id ? { ...r, ...value } : r), calculated = resolve(trial).one(id);
        if (!calculated.complete || Math.abs(calculated.unit_cost - price) > 0.0000001) value.pricing_mode = 'manual';
        db.run('UPDATE menu_food_materials SET payload_json=? WHERE id=?', [JSON.stringify(value), id]);
      }
    }
    const all = rawRows(db), groups = new Map();
    for (const r of all) { const k = r.name + '|' + r.unit; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    for (const g of groups.values()) if (g.length > 1) g.forEach((r, index) => {
      if (!r.spec) { r.spec = r.name === '烧鹅' ? (r.unit_cost > 0.07 ? '净肉及部位分摊' : '斩料熟重分摊') : `原卡标准 ${index + 1}`; r.note += ' 同名原料在原卡存在不同标准，未自动覆盖价格；可核对后合并。'; db.run('UPDATE menu_food_materials SET payload_json=? WHERE id=?', [JSON.stringify(r), r.id]); }
    });
    // Snapshot the final seeded spec and batch composition, not the temporary
    // manual price used while the dependency graph was being assembled.
    for (const id of seededIds) {
      const row = db.queryOne('SELECT payload_json FROM menu_food_materials WHERE id=?', [id]);
      db.run('UPDATE menu_food_material_versions SET payload_json=? WHERE material_id=? AND revision=1', [row.payload_json, id]);
    }
    db.run("INSERT OR IGNORE INTO menu_cost_migrations(key) VALUES('shared-food-v1')");
  });
}
function list(db) {
  migrate(db);
  const rows = rawRows(db), graph = resolve(rows), uses = new Map();
  for (const row of db.queryAll('SELECT id,payload_json FROM menu_cost_recipes')) for (const l of JSON.parse(row.payload_json).lines) {
    const id = graph.one(l.material_id).id || l.material_id;
    if (!uses.has(id)) uses.set(id, new Set()); uses.get(id).add(row.id);
  }
  return rows.filter(r => r.status === 'active').map(r => ({ ...graph.one(r.id), usage_count: uses.get(r.id)?.size || 0, dependent_count: rows.filter(n => n.status === 'active' && n.components.some(c => c.material_id === r.id)).length }));
}
function hydrate(lines, ingredients) {
  const map = new Map(ingredients.map(r => [r.id, r]));
  return lines.map(l => { const m = map.get(l.material_id); return { ...l, ingredient_name: m?.name || l.ingredient_name, material_spec: m?.spec || '', unit: m?.unit || l.unit, unit_cost: m?.complete ? m.unit_cost : null, cost_complete: !!m?.complete }; });
}
function save(db, body) {
  migrate(db);
  const currentRow = body.id ? db.queryOne('SELECT * FROM menu_food_materials WHERE id=? AND status=?', [body.id, 'active']) : null;
  if (body.id && !currentRow) fail('通用食材不存在', 404);
  if (currentRow && Number(body.revision) !== currentRow.revision) fail('食材标准已被更新，请刷新后修改', 409);
  const name = String(body.name || '').trim(), unit = String(body.unit || '').trim();
  if (!name || name.length > 80 || !unit || unit.length > 12) fail('请填写食材名称与最小计量单位');
  const id = currentRow?.id || 'food-' + crypto.randomUUID();
  const all = rawRows(db);
  if (currentRow && unit !== currentRow.unit && (db.queryAll('SELECT payload_json FROM menu_cost_recipes').some(r => JSON.parse(r.payload_json).lines.some(l => l.material_id === id)) || all.some(r => r.components.some(c => c.material_id === id)))) fail('该食材已被引用，更换单位请新建标准，避免原配方用量误算');
  if (!['manual', 'recipe'].includes(body.pricing_mode)) fail('请选择直接维护单位成本或通用配方计算');
  if (!Array.isArray(body.components) || body.components.length > 100) fail('通用配方格式不正确');
  const components = body.components.map(c => {
    if (!all.some(r => r.id === c.material_id && r.status === 'active')) fail('通用配方引用的原料不存在');
    return { material_id: c.material_id, quantity: positive(c.quantity, '组成原料用量') };
  });
  const value = { id, name, unit, spec: String(body.spec || '').slice(0, 80), kind: body.kind === '半成品' ? '半成品' : '食材', note: String(body.note || '').slice(0, 1000), pricing_mode: body.pricing_mode, output_quantity: positive(body.output_quantity || 1, '批次出品数量'), components, unit_cost: body.pricing_mode === 'manual' ? positive(body.manual_unit_cost ?? body.unit_cost, '单位成本', true) : null };
  if (value.pricing_mode === 'recipe' && !components.length) fail('请添加通用配方原料');
  const trial = [...all.filter(r => r.id !== id), { ...value, status: 'active' }];
  const calculated = resolve(trial).one(id);
  if (!calculated.complete) fail('组成原料成本尚未补齐，请先维护原料标准');
  return transaction(db, () => {
    const rev = (currentRow?.revision || 0) + 1;
    if (currentRow) db.run("UPDATE menu_food_materials SET name=?,unit=?,payload_json=?,revision=?,updated_at=datetime('now','localtime') WHERE id=?", [name, unit, JSON.stringify(value), rev, id]);
    else db.run('INSERT INTO menu_food_materials(id,name,unit,payload_json,revision) VALUES(?,?,?,?,?)', [id, name, unit, JSON.stringify(value), rev]);
    db.run('INSERT INTO menu_food_material_versions(material_id,revision,payload_json) VALUES(?,?,?)', [id, rev, JSON.stringify(value)]);
    return { ingredient: { ...calculated, revision: rev } };
  });
}
function merge(db, id, body) {
  migrate(db);
  const all = rawRows(db), source = all.find(r => r.id === id && r.status === 'active'), target = all.find(r => r.id === body.target_id && r.status === 'active');
  if (!source || !target || source.id === target.id) fail('请选择两个不同的有效食材标准');
  if (source.revision !== Number(body.revision) || target.revision !== Number(body.target_revision)) fail('标准已更新，请刷新后重新合并', 409);
  if (source.unit !== target.unit) fail('仅可合并相同计量单位的标准');
  const trial = all.map(r => ({ ...r, components: r.components.map(c => ({ ...c, material_id: c.material_id === id ? target.id : c.material_id })) }));
  resolve(trial.filter(r => r.id !== id));
  return transaction(db, () => {
    for (const r of trial.filter(r => r.id !== id && JSON.stringify(r.components) !== JSON.stringify(all.find(a => a.id === r.id).components))) {
      db.run('UPDATE menu_food_materials SET payload_json=?,revision=revision+1 WHERE id=?', [JSON.stringify(r), r.id]);
      db.run('INSERT INTO menu_food_material_versions(material_id,revision,payload_json) VALUES(?,?,?)', [r.id, r.revision + 1, JSON.stringify(r)]);
    }
    for (const row of db.queryAll('SELECT * FROM menu_cost_recipes')) {
      const r = JSON.parse(row.payload_json);
      if (!r.lines.some(l => l.material_id === id)) continue;
      r.lines = r.lines.map(l => l.material_id === id ? { ...l, material_id: target.id } : l);
      db.run('UPDATE menu_cost_recipes SET payload_json=?,revision=revision+1 WHERE id=?', [JSON.stringify(r), row.id]);
      db.run('INSERT INTO menu_cost_recipe_versions(recipe_id,revision,payload_json) VALUES(?,?,?)', [row.id, row.revision + 1, JSON.stringify(r)]);
    }
    db.run("UPDATE menu_food_materials SET status='merged',merged_into=?,revision=revision+1 WHERE id=?", [target.id, id]);
    db.run('INSERT INTO menu_food_material_versions(material_id,revision,payload_json) VALUES(?,?,?)', [id, source.revision + 1, JSON.stringify({ ...source, merged_into: target.id, status: 'merged' })]);
    return { ok: true };
  });
}
module.exports = { initialize, migrate, list, hydrate, save, merge, resolve, normalizeLine };
