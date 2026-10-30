'use strict';
const crypto = require('crypto');
const { parseWorkbook } = require('./menu-cost-workbook');
const food = require('./menu-shared-ingredients');
const packs = require('./menu-packaging-schemes');
const purchases = require('./menu-packaging-purchases');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const money = n => Math.round((n + Number.EPSILON) * 100) / 100;
function positive(value, label, allowZero = false) {
  if (value === null || value === '' || typeof value === 'boolean') fail(`${label}不能为空`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > 1e8) fail(`${label}必须是有效${allowZero ? '非负' : '正'}数`);
  return n;
}
function text(value, label, max = 120) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s || s.length > max) fail(`${label}须为1—${max}个字符`);
  return s;
}
function initialize(db) {
  food.initialize(db);
  packs.initialize(db);
  purchases.initialize(db);
  db.run('CREATE TABLE IF NOT EXISTS menu_dish_costs(menu_item_id INTEGER PRIMARY KEY,recipe_id TEXT UNIQUE NOT NULL)');
  db.run(`CREATE TABLE IF NOT EXISTS menu_cost_imports (hash TEXT PRIMARY KEY, filename TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.run(`CREATE TABLE IF NOT EXISTS menu_cost_recipes (id TEXT PRIMARY KEY, batch_hash TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, payload_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.run(`CREATE TABLE IF NOT EXISTS menu_packaging_materials (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, unit_cost REAL NOT NULL, note TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.run(`CREATE TABLE IF NOT EXISTS menu_cost_recipe_links (menu_item_id INTEGER PRIMARY KEY, recipe_id TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS menu_cost_recipe_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, recipe_id TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.run(`CREATE TABLE IF NOT EXISTS menu_packaging_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, material_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')))`);
  purchases.backfill(db);
}
function transaction(db, action) {
  db.run('BEGIN');
  let result;
  try { result = action(); db.run('COMMIT'); } catch (e) { db.run('ROLLBACK'); throw e; }
  db.save();
  return result;
}
function getRecipe(db, id, ingredients) {
  ingredients ||= food.list(db);
  const row = db.queryOne('SELECT * FROM menu_cost_recipes WHERE id=?', [id]);
  if (!row) fail('成本卡不存在', 404);
  const payload = JSON.parse(row.payload_json);
  return resolveRecipe(db, { ...payload, lines: food.hydrate(payload.lines, ingredients), revision: row.revision, updated_at: row.updated_at, batch_hash: row.batch_hash, menu_item_ids: db.queryAll('SELECT menu_item_id FROM menu_cost_recipe_links WHERE recipe_id=?', [id]).map(r => r.menu_item_id) });
}
function resolveRecipe(db, recipe) {
  if (!recipe.packaging_scheme_id) return recipe;
  const scheme = packs.list(db).find(s => s.id === recipe.packaging_scheme_id);
  return { ...recipe, packaging: [...recipe.packaging.filter(p => p.usage !== 'packed'), ...(scheme?.lines || [])], packaging_status: scheme?.complete ? 'configured' : 'pending' };
}
function importWorkbook(db, buffer, filename) {
  const data = parseWorkbook(buffer, filename);
  const priorImport = db.queryOne('SELECT metadata_json FROM menu_cost_imports WHERE hash=?', [data.hash]);
  if (priorImport) {
    const prior = JSON.parse(priorImport.metadata_json);
    // Add newly readable provenance to older local previews. Never replace
    // reviewed recipe edits, packaging prices or associations on reimport.
    if (!prior.yields) transaction(db, () => db.run('UPDATE menu_cost_imports SET metadata_json=? WHERE hash=?', [JSON.stringify({ ...prior, yields: data.yields }), data.hash]));
    return { imported: 0, existing: true, count: data.recipes.length };
  }
  return transaction(db, () => {
    const { recipes, packaging, ...meta } = data;
    db.run('INSERT INTO menu_cost_imports(hash,filename,metadata_json) VALUES(?,?,?)', [data.hash, data.filename, JSON.stringify(meta)]);
    for (const p of packaging) {
      const existing = db.queryOne('SELECT id FROM menu_packaging_materials WHERE id=?', [p.id]);
      db.run('INSERT OR IGNORE INTO menu_packaging_materials(id,name,unit,unit_cost,note) VALUES(?,?,?,?,?)', [p.id, p.name, p.unit, p.unit_cost, `${p.note}；来源${p.source}`]);
      if (!existing) db.run('INSERT INTO menu_packaging_versions(material_id,payload_json) VALUES(?,?)', [p.id, JSON.stringify(db.queryOne('SELECT * FROM menu_packaging_materials WHERE id=?', [p.id]))]);
    }
    for (const r of recipes) {
      db.run('INSERT INTO menu_cost_recipes(id,batch_hash,name,category,payload_json) VALUES(?,?,?,?,?)', [r.id, data.hash, r.name, r.category, JSON.stringify(r)]);
      db.run('INSERT INTO menu_cost_recipe_versions(recipe_id,revision,payload_json) VALUES(?,?,?)', [r.id, 1, JSON.stringify(r)]);
    }
    return { imported: recipes.length, existing: false, count: recipes.length };
  });
}
function calculateOrder(recipes, materials, { channel = 'dine_in', packed = false, items } = {}) {
  if (!['dine_in', 'group_buy', 'delivery'].includes(channel)) fail('请选择堂食、团购或外卖');
  if (typeof packed !== 'boolean') fail('打包状态必须是布尔值');
  if (!Array.isArray(items) || !items.length || items.length > 100) fail('请提供1—100项菜品');
  const isPacked = channel === 'delivery' || packed;
  const perOrder = new Map(), perDish = [], missing = [];
  let food = 0;
  // Aggregate repeated order lines before calculating packaging.
  const quantities = new Map();
  for (const item of items) quantities.set(item.recipe_id, (quantities.get(item.recipe_id) || 0) + positive(item.quantity, '菜品份数'));
  for (const [id, qty] of quantities) {
    const r = recipes.find(r => r.id === id);
    if (!r) fail('试算菜品不存在', 404);
    if (r.cost_mode === 'manual') {
      if (r.manual_food_cost == null || !Number.isFinite(r.manual_food_cost)) missing.push({recipe_id:id,name:r.name,reason:'单份食材成本待填写'});
      else food += r.manual_food_cost * qty;
    } else for (const l of r.lines) {
      if (l.unit_cost === null || !Number.isFinite(l.unit_cost)) missing.push({ recipe_id: id, name: r.name, reason: `${l.ingredient_name}的共用成本未补齐` });
      else food += l.quantity * l.unit_cost * qty;
    }
    if (isPacked && r.packaging_status === 'pending') missing.push({ recipe_id: id, name: r.name, reason: '打包方案待补齐' });
    for (const p of r.packaging) {
      if (p.usage === 'packed' && !isPacked) continue;
      const m = materials.find(m => m.id === p.material_id);
      if (!m) { missing.push({ recipe_id: id, name: r.name, reason: '关联包材已缺失' }); continue; }
      if (p.scope === 'order') {
        // Shared bag/material used by multiple dishes in ONE order counts once.
        // Max is the explicit configured amount for that material per order.
        const prior = perOrder.get(m.id);
        if (!prior || prior.quantity < p.quantity) perOrder.set(m.id, { material_id: m.id, name: m.name, unit: m.unit, quantity: p.quantity, unit_cost: m.unit_cost, scope: 'order' });
      } else perDish.push({ material_id: m.id, name: m.name, unit: m.unit, quantity: p.quantity * qty, unit_cost: m.unit_cost, scope: 'dish' });
    }
  }
  const details = [...perDish, ...perOrder.values()].map(p => ({ ...p, subtotal: money(p.quantity * p.unit_cost) }));
  const packaging = [...perDish, ...perOrder.values()].reduce((s, p) => s + p.quantity * p.unit_cost, 0);
  return { channel, packed: isPacked, food_cost: money(food), packaging_cost: money(packaging), known_cost: money(food + packaging), total_cost: missing.length ? null : money(food + packaging), complete: !missing.length, missing, packaging_details: details };
}
function list(db) {
  const ingredients = food.list(db);
  const materials = purchases.list(db);
  const recipes = db.queryAll('SELECT id FROM menu_cost_recipes ORDER BY rowid').map(r => {
    const recipe = getRecipe(db, r.id, ingredients);
    const base = calculateOrder([recipe], materials, { items: [{ recipe_id: recipe.id, quantity: 1 }] });
    return { ...recipe, food_cost: base.food_cost, base_cost: base.total_cost };
  });
  return { recipes, ingredients, packaging_materials: materials, packaging_schemes: packs.list(db, materials), packaging_import: packs.metadata(db), imports: db.queryAll('SELECT * FROM menu_cost_imports ORDER BY rowid DESC').map(r => ({ ...JSON.parse(r.metadata_json), created_at: r.created_at })), menu_items: db.queryAll('SELECT id,name,category,spec,skuid,cost,item_type FROM menu_items ORDER BY name,spec,id') };
}
function prepareRecipe(db, current, body) {
  const cost_mode = body.cost_mode || 'recipe';
  if (!['recipe','manual'].includes(cost_mode)) fail('请选择成本录入方式');
  const manual_food_cost = cost_mode === 'manual' ? positive(body.manual_food_cost, '单份食材成本', true) : numberOrNull(body.manual_food_cost);
  if (!Array.isArray(body.lines) || (cost_mode === 'recipe' && !body.lines.length) || body.lines.length > 100) fail('请录入1—100项材料');
  const ingredients = food.list(db);
  const lines = body.lines.map((line, i) => {
    const material = ingredients.find(m => m.id === line.material_id);
    if (!material) fail(`第${i + 1}项请选择通用食材`);
    if (line.unit && line.unit !== material.unit) fail('用量单位须与通用食材一致');
    return { material_id: material.id, ingredient_name: material.name, quantity: positive(line.quantity, `第${i + 1}项用量`), unit: material.unit, unit_cost: material.unit_cost, source: String(line.source || '').slice(0, 150), source_quantity: String(line.source_quantity || '').slice(0, 100), source_subtotal: numberOrNull(line.source_subtotal), basis: String(line.basis || '通用食材标准').slice(0, 80), note: String(line.note || '').slice(0, 500), formula: String(line.formula || '').slice(0, 500) };
  });
  if (!Array.isArray(body.packaging) || body.packaging.length > 40) fail('包材关联格式不正确');
  const seen = new Set();
  const schemeId = body.packaging_scheme_id || null;
  const scheme = schemeId ? packs.list(db).find(s => s.id === schemeId) : null;
  if (schemeId && !scheme) fail('打包方案不存在，请刷新后选择');
  const packaging = body.packaging.filter(p => !schemeId || p.usage !== 'packed').map(p => {
    if (!db.queryOne('SELECT id FROM menu_packaging_materials WHERE id=?', [p.material_id])) fail('请选择已建立的包材');
    if (!['dish', 'order'].includes(p.scope) || !['packed', 'always'].includes(p.usage)) fail('包材的计费范围或使用条件不正确');
    if (seen.has(p.material_id)) fail('同一菜品请合并同种包材，避免重复计算');
    seen.add(p.material_id);
    return { material_id: p.material_id, quantity: positive(p.quantity, '包材数量'), scope: p.scope, usage: p.usage };
  });
  if (!['pending', 'configured', 'none'].includes(body.packaging_status)) fail('请确认打包方案状态');
  if (body.packaging_status === 'configured' && !scheme?.complete && !packaging.some(p => p.usage === 'packed')) fail('请添加打包时使用的包材，或选择“已确认无需额外包材”');
  if (body.packaging_status === 'none' && (schemeId || packaging.some(p => p.usage === 'packed'))) fail('无需额外包材时，请先移除打包专用包材');
  if (!Array.isArray(body.menu_item_ids) || body.menu_item_ids.length > 200) fail('关联菜品格式不正确');
  const ids = [...new Set(body.menu_item_ids.map(n => positive(n, '菜品ID')))];
  for (const itemId of ids) {
    if (!db.queryOne('SELECT id FROM menu_items WHERE id=?', [itemId])) fail('关联菜品不存在');
    const link = db.queryOne('SELECT recipe_id FROM menu_cost_recipe_links WHERE menu_item_id=?', [itemId]);
    if (link && link.recipe_id !== current.id) fail('该规格已关联其他成本卡，请先解除原关联', 409);
  }
  return { ...current, cost_mode, manual_food_cost, lines, packaging, packaging_scheme_id:schemeId, packaging_status: body.packaging_status, menu_item_ids: ids };
}
function saveRecipe(db, id, body, options = {}) {
  const current = options.create || getRecipe(db, id);
  if (Number(body.revision) !== current.revision) fail('此成本卡已更新，请重新载入后修改', 409);
  const next = prepareRecipe(db, current, body), ids = next.menu_item_ids;
  // Association only. Existing SKU, prices, components and historical reports
  // are not overwritten by reviewing a new cost-card revision.
  return transaction(db, () => {
    if (options.create) db.run('INSERT INTO menu_cost_recipes(id,batch_hash,name,category,payload_json,revision) VALUES(?,?,?,?,?,1)',[id,'menu-owned',current.name,current.category,JSON.stringify(next)]);
    else db.run('UPDATE menu_cost_recipes SET payload_json=?,revision=revision+1,updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [JSON.stringify(next), id]);
    if (options.menuItemId) db.run('INSERT OR REPLACE INTO menu_dish_costs(menu_item_id,recipe_id) VALUES(?,?)',[options.menuItemId,id]);
    db.run('DELETE FROM menu_cost_recipe_links WHERE recipe_id=?', [id]);
    for (const itemId of ids) db.run('INSERT INTO menu_cost_recipe_links(menu_item_id,recipe_id) VALUES(?,?)', [itemId, id]);
    db.run('INSERT INTO menu_cost_recipe_versions(recipe_id,revision,payload_json) VALUES(?,?,?)', [id, current.revision + 1, JSON.stringify(next)]);
    return getRecipe(db, id);
  });
}
function numberOrNull(value) { return value === null || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null; }
function saveMaterial(db, body) {
  const name = text(body.name, '包材名称'), unit = text(body.unit, '单件单位', 12);
  const current = body.id ? purchases.list(db).find(m => m.id === body.id) : null;
  if (body.id && !current) fail('包材不存在', 404);
  if (current && Number(body.revision) !== current.revision) fail('包材已更新，请刷新后修改', 409);
  const purchase = purchases.prepare(body, current);
  const unitCost = purchase ? purchase.unit_cost : positive(body.unit_cost, '包材单位成本', true);
  const note = current?.note || '';
  if (current && current.unit !== unit && (db.queryAll('SELECT payload_json FROM menu_cost_recipes').some(r => JSON.parse(r.payload_json).packaging.some(p => p.material_id === current.id)) || packs.list(db).some(s => s.lines.some(p => p.material_id === current.id)))) fail('该包材已被使用，变更单位请新建包材，避免用量误算');
  const id = current?.id || crypto.randomUUID();
  return transaction(db, () => {
    if (current && !db.queryOne('SELECT id FROM menu_packaging_versions WHERE material_id=? LIMIT 1', [id])) db.run('INSERT INTO menu_packaging_versions(material_id,payload_json) VALUES(?,?)', [id, JSON.stringify(current)]);
    if (current) db.run('UPDATE menu_packaging_materials SET name=?,unit=?,unit_cost=?,note=?,revision=revision+1,updated_at=datetime(\'now\',\'localtime\') WHERE id=?', [name, unit, unitCost, note, id]);
    else db.run('INSERT INTO menu_packaging_materials(id,name,unit,unit_cost,note) VALUES(?,?,?,?,?)', [id, name, unit, unitCost, note]);
    purchases.save(db, id, purchase);
    const next = purchases.list(db).find(m => m.id === id);
    db.run('INSERT INTO menu_packaging_versions(material_id,payload_json) VALUES(?,?)', [id, JSON.stringify(next)]);
    return next;
  });
}
function createRouter({ db }) {
  const express = require('express'), router = express.Router();
  const wrap = fn => (req, res) => { try { res.json({ ok: true, ...fn(req) }); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
  router.get('/', wrap(() => list(db)));
  router.post('/ingredients', wrap(req => food.save(db, req.body)));
  router.post('/ingredients/:id/merge', wrap(req => food.merge(db, req.params.id, req.body)));
  const dishes = require('./menu-dish-costs');
  router.get('/dishes', wrap(() => dishes.list(db, module.exports)));
  router.get('/dishes/:id', wrap(req => dishes.get(db, Number(req.params.id), module.exports)));
  router.put('/dishes/:id', wrap(req => dishes.save(db, Number(req.params.id), req.body, module.exports)));
  router.post('/dishes/:id/quote', wrap(req => dishes.quote(db, Number(req.params.id), req.body, module.exports)));
  router.post('/schemes', wrap(req => ({scheme:packs.save(db,req.body)})));
  router.post('/packaging-import', express.raw({type:'application/octet-stream',limit:'12mb'}),wrap(req => { if(!Buffer.isBuffer(req.body))fail('请上传Excel原文件');return packs.importWorkbook(db,req.body,req.query.filename); }));
  router.get('/for-menu/:id', wrap(req => menuRecipe(db, req.params.id)));
  router.post('/for-menu/:id', wrap(req => bindMenuRecipe(db, req.params.id, req.body)));
  router.post('/import', express.raw({ type: 'application/octet-stream', limit: '12mb' }), wrap(req => {
    if (!Buffer.isBuffer(req.body)) fail('请上传Excel原文件');
    return importWorkbook(db, req.body, req.query.filename);
  }));
  router.put('/recipes/:id', wrap(req => ({ recipe: saveRecipe(db, req.params.id, req.body) })));
  router.post('/packaging', wrap(req => ({ material: saveMaterial(db, req.body) })));
  router.post('/quote', wrap(req => {
    const data = list(db);
    let recipes = data.recipes;
    // Unsaved edits can be tried without persisting them.
    if (req.body.draft) {
      const d = req.body.draft;
      const original = recipes.find(r => r.id === d.id);
      if (!original) fail('成本卡不存在', 404);
      if (!Array.isArray(d.lines) || !d.lines.length || d.lines.length > 100 || !Array.isArray(d.packaging) || d.packaging.length > 40) fail('试算构成不完整');
      const lines = food.hydrate(d.lines.map(l => {
        const material = data.ingredients.find(m => m.id === l.material_id);
        if (!material) fail('请选择有效的通用食材');
        if (l.unit_cost !== null && l.unit_cost !== undefined && Number(l.unit_cost) < 0) fail('单位成本不能为负数');
        if (l.unit && l.unit !== material.unit) fail('用量单位须与通用食材一致');
        return { ...l, quantity: positive(l.quantity, '用量') };
      }), data.ingredients);
      const packaging = d.packaging.map(p => {
        if (!['dish', 'order'].includes(p.scope) || !['always', 'packed'].includes(p.usage)) fail('包材条件不正确');
        return { ...p, quantity: positive(p.quantity, '包材用量') };
      });
      if (new Set(packaging.map(p => p.material_id)).size !== packaging.length) fail('同种包材请勿重复添加');
      if (!['pending', 'configured', 'none'].includes(d.packaging_status)) fail('打包方案状态不正确');
      if ((d.packaging_status === 'none' && packaging.some(p => p.usage === 'packed')) || (d.packaging_status === 'configured' && !packaging.some(p => p.usage === 'packed'))) fail('包材方案与确认状态不一致');
      recipes = recipes.map(r => r.id === d.id ? { ...original, lines, packaging, packaging_status: d.packaging_status } : r);
    }
    return { quote: calculateOrder(recipes, data.packaging_materials, req.body) };
  }));
  return router;
}
function menuRecipe(db, id, existingData) {
  const data = existingData || list(db), item = data.menu_items.find(m => m.id === Number(id));
  if (!item) fail('菜品不存在', 404);
  const linked = data.recipes.find(r => r.menu_item_ids.includes(item.id));
  const nameAliases = { '招牌叉鹅饭': '招牌烧鹅拼叉烧饭', '招牌鸡鹅饭': '招牌烧鹅拼咸鸡饭', '烧肉拼烧鹅饭': '招牌烧鹅拼烧肉饭', '叉鸡双拼饭': '叉烧拼咸鸡饭', '鸡鸭双拼饭': '招牌烧鸭拼咸鸡饭', '叉鸭双拼饭': '招牌烧鸭拼叉烧饭', '蜜汁叉烧饭': '秘制叉烧饭', '战斧大鹅翅饭': '烧鹅战斧饭', '招牌烧鹅腿饭': '招牌鹅肶（腿）饭', '金牌烧鸭腿饭': '招牌鸭肶（腿）饭', '咸香靓鸡腿饭': '咸鸡肶（腿）饭', '招牌烧鹅腿濑粉': '鹅肶汤濑粉', '烧鸭腿濑粉': '金牌烧鸭腿濑粉', '超爽柠檬茶': '柠檬茶', '泰国咸柠七': '咸柠七', '太公烧鹅三宝饭': '太公三宝饭', '斋濑粉': '斋濑汤粉' };
  let name = nameAliases[item.name] || item.name;
  if (item.spec === '面') name = ({ '鹅肶汤濑粉': '鹅肶捞面', '招牌烧鹅濑粉': '招牌烧鹅捞面', '战斧大鹅翅濑粉': '战斧大鹅翅捞面', '金牌烧鸭濑粉': '金牌烧鸭捞面', '金牌烧鸭腿濑粉': '金牌烧鸭腿捞面', '斋濑汤粉': '鹅汁捞面' })[name] || name;
  if (['上庄', '下庄', '半只'].includes(item.spec)) name = item.name === '太公烧鹅' ? '太公烧鹅' + item.spec : item.name === '金牌烧鸭' ? '现烤烧鸭' + item.spec : item.name === '咸香靓鸡' && item.spec === '半只' ? '咸鸡/半只' : name;
  const candidates = data.recipes.filter(r => r.batch_hash !== 'menu-owned' && r.name === name);
  return { item, linked_recipe: linked || null, candidates, recipes: data.recipes, ingredients: data.ingredients, packaging_materials: data.packaging_materials };
}
function bindMenuRecipe(db, menuId, body) {
  const item = db.queryOne('SELECT id FROM menu_items WHERE id=?', [menuId]);
  if (!item) fail('菜品不存在', 404);
  const recipe = getRecipe(db, body.recipe_id);
  if (recipe.revision !== Number(body.revision)) fail('配方已更新，请刷新后关联', 409);
  const current = db.queryOne('SELECT recipe_id FROM menu_cost_recipe_links WHERE menu_item_id=?', [item.id]);
  if ((current?.recipe_id || null) !== (body.current_recipe_id || null)) fail('此规格的配方关联已更新，请刷新核对', 409);
  if (current?.recipe_id === recipe.id) return { ok: true };
  const prior = current ? getRecipe(db, current.recipe_id) : null;
  return transaction(db, () => {
    db.run('DELETE FROM menu_cost_recipe_links WHERE menu_item_id=?', [item.id]);
    db.run('INSERT INTO menu_cost_recipe_links(menu_item_id,recipe_id) VALUES(?,?)', [item.id, recipe.id]);
    for (const r of [prior, recipe].filter(Boolean)) {
      db.run('UPDATE menu_cost_recipes SET revision=revision+1 WHERE id=?', [r.id]);
      db.run('INSERT INTO menu_cost_recipe_versions(recipe_id,revision,payload_json) VALUES(?,?,?)', [r.id, r.revision + 1, JSON.stringify({ ...r, menu_item_ids: r.id === recipe.id ? [...r.menu_item_ids, item.id] : r.menu_item_ids.filter(id => id !== item.id) })]);
    }
    return { ok: true };
  });
}
module.exports = { initialize, importWorkbook, getRecipe, list, saveRecipe, saveMaterial, calculateOrder, createRouter, menuRecipe, prepareRecipe, resolveRecipe };
