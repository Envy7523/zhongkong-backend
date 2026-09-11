/**
 * 菜品核算 —— 禽类消耗反推
 *
 * 目的：选门店 + 时间段 → 拿菜品销量 → 反推这段时间大概消耗了多少只鹅/鸭/鸡。
 *
 * 三层模型（均为「只」为最终锚点）：
 *   ① poultry_birds        禽类档案      一只禽：品种、单只净重、单只成本
 *   ② poultry_yields       整只出成拆解  一只禽出哪些部位、每个部位出几个
 *   ③ poultry_dish_usage   菜品耗用      每份该菜品吃掉几个该部位
 *
 * 公式：消耗只数 = Σ( 菜品销量 × 每份耗用部位数 ÷ 一只出该部位数 )
 *       折合重量 = 只数 × 单只净重
 *       理论成本 = 只数 × 单只成本
 *
 * 口径约定（与产品确认一致）：
 *   - 退款行整体排除：refunded IN ('部分退','是','1') 不计入
 *   - 渠道由 dish_sales.payment_detail 关键字判定，优先级 团购 > 外卖 > 堂食 > 其他
 *     （pos 报表里「店内销售|收银POS|POS|抖音团购」属于团购核销，不是纯堂食）
 *   - 只数保留 2 位小数，全程保留精度、只在输出时取整
 */
const db = require('./db');

const ANIMALS = ['鹅', '鸭', '鸡'];
const REFUND_EXCLUDED = ['部分退', '是', '1'];

// 部位类别：身体（同一块身体的不同卖法，互相抢鸟 → 需求相加）
//           副产品（随鸟附带产出，不额外占鸟 → 需求取最大）
const PART_KINDS = ['身体', '副产品'];
const BYPRODUCT_HINTS = ['翅', '战斧', '头', '颈', '掌', '爪', '杂', '肝', '肠', '汁', '血'];

/** 部位类别归一化：留空时按部位名预判，减少手工填写 */
function normalizePartKind(value, partName = '') {
  const raw = String(value || '').trim();
  if (PART_KINDS.includes(raw)) return raw;
  const name = String(partName || '').trim();
  return BYPRODUCT_HINTS.some(hint => name.includes(hint)) ? '副产品' : '身体';
}

/**
 * 清掉指向「已被删除菜品」的孤儿耗用行。
 * 背景：本项目 db.js 里的 PRAGMA foreign_keys=ON 实际未生效，所有 ON DELETE CASCADE 都不会执行
 * （同样的问题也造成过 dish_sales_mappings 的 10 条孤儿绑定）。所以这里不依赖外键，显式清理，
 * 否则删掉菜品后残留的行会让 deleteBird 报「已被 N 个菜品引用」（其实那菜品已经不存在）。
 */
function purgeOrphanUsage() {
  const removed = db.run(`DELETE FROM poultry_dish_usage
    WHERE menu_item_id NOT IN (SELECT id FROM menu_items)`);
  return removed || 0;
}

/** 规格归一化：与 server.js / dish_sales_mappings 唯一键口径保持一致 */
function normalizeDishSpec(value) {
  const text = String(value || '').trim();
  return (text === '' || text === '--') ? '' : text;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

/** 渠道判定：优先级 团购 > 外卖 > 堂食 > 其他（payment_detail 无渠道信息时归入「其他」） */
const CHANNEL_SQL = `
  CASE
    WHEN COALESCE(d.payment_detail,'') LIKE '%团购%' THEN 'group'
    WHEN COALESCE(d.payment_detail,'') LIKE '%淘宝闪购%'
      OR COALESCE(d.payment_detail,'') LIKE '%京东%'
      OR COALESCE(d.payment_detail,'') LIKE '%外卖%' THEN 'delivery'
    WHEN COALESCE(d.payment_detail,'') LIKE '%店内销售%'
      OR COALESCE(d.payment_detail,'') LIKE '%收银POS%'
      OR COALESCE(d.payment_detail,'') LIKE '%扫码点餐%'
      OR COALESCE(d.payment_detail,'') LIKE '%小程序%'
      OR COALESCE(d.payment_detail,'') LIKE '%堂食%' THEN 'dine_in'
    ELSE 'other'
  END`;

const CHANNEL_LABELS = { dine_in: '堂食', group: '团购', delivery: '外卖', other: '其他/未分类' };

// ==================== ① 禽类档案 ====================

function listBirds() {
  // 统计只算「还存在的菜品」的引用：菜品被删后耗用行可能残留（外键未生效），不能让它虚增挂菜数
  return db.queryAll(`
    SELECT b.*,
      (SELECT COUNT(*) FROM poultry_yields y WHERE y.bird_id=b.id) AS yield_count,
      (SELECT COUNT(DISTINCT u.menu_item_id) FROM poultry_dish_usage u
         JOIN poultry_yields y2 ON y2.id=u.yield_id
         JOIN menu_items m ON m.id=u.menu_item_id
         WHERE y2.bird_id=b.id) AS dish_count,
      (SELECT COUNT(*) FROM poultry_purchases p WHERE p.bird_id=b.id) AS purchase_count
    FROM poultry_birds b
    ORDER BY CASE b.animal WHEN '鹅' THEN 1 WHEN '鸭' THEN 2 WHEN '鸡' THEN 3 ELSE 9 END, b.id
  `).map(row => ({
    ...row,
    net_weight_kg: Number(row.net_weight_kg) || 0,
    unit_cost: Number(row.unit_cost) || 0,
    yield_count: Number(row.yield_count) || 0,
    dish_count: Number(row.dish_count) || 0,
    purchase_count: Number(row.purchase_count) || 0,
  }));
}

function createBird(body = {}) {
  const animalRaw = String(body.animal || '').trim();
  if (animalRaw && !ANIMALS.includes(animalRaw)) throw new Error('禽类只能是 鹅 / 鸭 / 鸡');
  const animal = ANIMALS.includes(animalRaw) ? animalRaw : '鹅';
  const breedName = String(body.breed_name || '').trim();
  if (!breedName) throw new Error('品种名称不能为空');
  const dup = db.queryOne('SELECT id FROM poultry_birds WHERE breed_name=?', [breedName]);
  if (dup) throw new Error(`品种「${breedName}」已存在（id=${dup.id}）`);
  const netWeight = Number(body.net_weight_kg);
  const unitCost = Number(body.unit_cost);
  const id = db.insert(
    'INSERT INTO poultry_birds (animal,breed_name,net_weight_kg,unit_cost,status,remark) VALUES (?,?,?,?,?,?)',
    [animal, breedName, Number.isFinite(netWeight) ? netWeight : 0, Number.isFinite(unitCost) ? unitCost : 0,
      body.status === '停用' ? '停用' : '启用', String(body.remark || '').trim()]
  );
  db.save();
  return { id };
}

function updateBird(id, body = {}) {
  const current = db.queryOne('SELECT * FROM poultry_birds WHERE id=?', [id]);
  if (!current) throw new Error('禽类档案不存在');
  const sets = [];
  const params = [];
  if (body.animal !== undefined) {
    const animal = String(body.animal).trim();
    if (!ANIMALS.includes(animal)) throw new Error('禽类只能是 鹅 / 鸭 / 鸡');
    sets.push('animal=?'); params.push(animal);
  }
  if (body.breed_name !== undefined) {
    const breedName = String(body.breed_name).trim();
    if (!breedName) throw new Error('品种名称不能为空');
    const dup = db.queryOne('SELECT id FROM poultry_birds WHERE breed_name=? AND id!=?', [breedName, id]);
    if (dup) throw new Error(`品种「${breedName}」已被 id=${dup.id} 使用`);
    sets.push('breed_name=?'); params.push(breedName);
  }
  for (const field of ['net_weight_kg', 'unit_cost']) {
    if (body[field] !== undefined) {
      const value = Number(body[field]);
      if (!Number.isFinite(value) || value < 0) throw new Error('数值不能为负');
      sets.push(`${field}=?`); params.push(value);
    }
  }
  if (body.status !== undefined) { sets.push('status=?'); params.push(body.status === '停用' ? '停用' : '启用'); }
  if (body.remark !== undefined) { sets.push('remark=?'); params.push(String(body.remark).trim()); }
  if (!sets.length) throw new Error('没有要更新的字段');
  sets.push("updated_at=datetime('now','localtime')");
  params.push(id);
  db.run(`UPDATE poultry_birds SET ${sets.join(',')} WHERE id=?`, params);
  db.save();
  return { ok: true };
}

function deleteBird(id) {
  const bird = db.queryOne('SELECT * FROM poultry_birds WHERE id=?', [id]);
  if (!bird) throw new Error('禽类档案不存在');
  // 先清掉指向已删菜品的孤儿耗用行（外键未生效），否则会被「已不存在的菜品」挡住删除
  const purged = purgeOrphanUsage();
  const usage = db.queryOne(`
    SELECT COUNT(*) AS n FROM poultry_dish_usage u
    JOIN poultry_yields y ON y.id=u.yield_id WHERE y.bird_id=?`, [id]).n;
  if (Number(usage) > 0) throw new Error(`该品种已被 ${usage} 条菜品耗用引用，请先解除菜品耗用关系`);
  db.run('DELETE FROM poultry_yields WHERE bird_id=?', [id]);
  db.run('DELETE FROM poultry_birds WHERE id=?', [id]);
  db.save();
  return { ok: true, purged_orphans: purged };
}

// ==================== ② 整只出成拆解 ====================

function listYields(birdId) {
  const where = birdId ? 'WHERE y.bird_id=?' : '';
  const params = birdId ? [birdId] : [];
  return db.queryAll(`
    SELECT y.*, b.animal, b.breed_name,
      (SELECT COUNT(*) FROM poultry_dish_usage u WHERE u.yield_id=y.id) AS usage_count
    FROM poultry_yields y
    JOIN poultry_birds b ON b.id=y.bird_id
    ${where}
    ORDER BY b.id, y.sort_order, y.id`, params).map(row => ({
    ...row,
    parts_per_bird: Number(row.parts_per_bird) || 0,
    part_weight_g: Number(row.part_weight_g) || 0,
    part_kind: normalizePartKind(row.part_kind, row.part_name),
    usage_count: Number(row.usage_count) || 0,
  }));
}

/** 整表替换某只禽的出成明细（前端按行编辑后整体提交，避免逐行 diff） */
function saveYields(birdId, rows) {
  const bird = db.queryOne('SELECT * FROM poultry_birds WHERE id=?', [birdId]);
  if (!bird) throw new Error('禽类档案不存在');
  if (!Array.isArray(rows)) throw new Error('出成明细格式不正确');
  if (rows.length > 200) throw new Error('单个品种的出成部位最多 200 条');

  const prepared = rows.map((row, index) => {
    const partName = String(row?.part_name || '').trim();
    if (!partName) throw new Error(`第 ${index + 1} 行请填写部位名称`);
    const perBird = Number(row?.parts_per_bird);
    if (!Number.isFinite(perBird) || perBird <= 0) throw new Error(`第 ${index + 1} 行「一只出成数量」必须大于 0`);
    const partWeight = Number(row?.part_weight_g);
    return {
      part_name: partName,
      parts_per_bird: perBird,
      part_weight_g: Number.isFinite(partWeight) && partWeight > 0 ? partWeight : 0,
      part_kind: normalizePartKind(row?.part_kind, partName),
      sort_order: index,
      remark: String(row?.remark || '').trim(),
    };
  });
  const seen = new Set();
  prepared.forEach(row => {
    if (seen.has(row.part_name)) throw new Error(`部位「${row.part_name}」重复，请合并为一行`);
    seen.add(row.part_name);
  });

  // 出成明细被替换后，指向被删部位的菜品耗用关系会失效，需一并清理并回报给前端
  const keepNames = prepared.map(row => row.part_name);
  let droppedUsage = 0;
  db.exec('BEGIN');
  try {
    const staleRows = db.queryAll(
      `SELECT y.id, y.part_name FROM poultry_yields y
       WHERE y.bird_id=? AND (${keepNames.map(() => 'y.part_name<>?').join(' AND ')})`,
      [Number(birdId), ...keepNames]
    );
    for (const stale of staleRows) {
      droppedUsage += Number(db.queryOne('SELECT COUNT(*) AS n FROM poultry_dish_usage WHERE yield_id=?', [stale.id]).n) || 0;
    }
    db.run(`DELETE FROM poultry_dish_usage WHERE yield_id IN (
      SELECT id FROM poultry_yields WHERE bird_id=? AND (${keepNames.map(() => 'part_name<>?').join(' AND ')}))`,
      [Number(birdId), ...keepNames]);
    db.run(`DELETE FROM poultry_yields WHERE bird_id=? AND (${keepNames.map(() => 'part_name<>?').join(' AND ')})`,
      [Number(birdId), ...keepNames]);

    for (const row of prepared) {
      const existing = db.queryOne('SELECT id FROM poultry_yields WHERE bird_id=? AND part_name=?', [birdId, row.part_name]);
      if (existing) {
        db.run(`UPDATE poultry_yields SET parts_per_bird=?, part_weight_g=?, part_kind=?, sort_order=?, remark=?,
                updated_at=datetime('now','localtime') WHERE id=?`,
          [row.parts_per_bird, row.part_weight_g, row.part_kind, row.sort_order, row.remark, existing.id]);
      } else {
        db.insert(
          'INSERT INTO poultry_yields (bird_id,part_name,parts_per_bird,part_weight_g,part_kind,sort_order,remark) VALUES (?,?,?,?,?,?,?)',
          [birdId, row.part_name, row.parts_per_bird, row.part_weight_g, row.part_kind, row.sort_order, row.remark]);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.save();
  return { ok: true, count: prepared.length, dropped_usage: droppedUsage };
}

function deleteYield(id) {
  const row = db.queryOne('SELECT * FROM poultry_yields WHERE id=?', [id]);
  if (!row) throw new Error('出成部位不存在');
  purgeOrphanUsage();
  const usage = db.queryOne('SELECT COUNT(*) AS n FROM poultry_dish_usage WHERE yield_id=?', [id]).n;
  if (Number(usage) > 0) throw new Error(`该部位已被 ${usage} 个菜品引用，请先解除菜品耗用关系`);
  db.run('DELETE FROM poultry_yields WHERE id=?', [id]);
  db.save();
  return { ok: true };
}

// ==================== ③ 菜品耗用 ====================

function listUsageByMenu(menuItemId) {
  const item = db.queryOne('SELECT id,name,spec,method,spec_unit,category FROM menu_items WHERE id=?', [menuItemId]);
  if (!item) throw new Error('菜品不存在');
  const rows = db.queryAll(`
    SELECT u.id, u.menu_item_id, u.yield_id, u.usage_qty, u.sort_order,
      y.part_name, y.parts_per_bird, y.part_weight_g, y.part_kind,
      b.id AS bird_id, b.animal, b.breed_name
    FROM poultry_dish_usage u
    JOIN poultry_yields y ON y.id=u.yield_id
    JOIN poultry_birds b ON b.id=y.bird_id
    WHERE u.menu_item_id=? ORDER BY u.sort_order, u.id`, [menuItemId]);
  return {
    item,
    rows: rows.map(row => ({
      ...row,
      usage_qty: Number(row.usage_qty) || 0,
      parts_per_bird: Number(row.parts_per_bird) || 0,
      part_kind: normalizePartKind(row.part_kind, row.part_name),
    })),
  };
}

function saveUsageForMenu(menuItemId, rows) {
  const item = db.queryOne('SELECT id FROM menu_items WHERE id=?', [menuItemId]);
  if (!item) throw new Error('菜品不存在');
  if (!Array.isArray(rows)) throw new Error('耗用明细格式不正确');
  if (rows.length > 30) throw new Error('单个菜品最多挂 30 条禽类耗用关系');

  const prepared = rows.map((row, index) => {
    const yieldId = Number(row?.yield_id);
    if (!Number.isInteger(yieldId) || yieldId <= 0) throw new Error(`第 ${index + 1} 行请选择部位`);
    const usage = Number(row?.usage_qty);
    if (!Number.isFinite(usage) || usage <= 0) throw new Error(`第 ${index + 1} 行「每份耗用数量」必须大于 0`);
    const target = db.queryOne('SELECT id FROM poultry_yields WHERE id=?', [yieldId]);
    if (!target) throw new Error(`第 ${index + 1} 行引用的部位不存在`);
    return { yield_id: yieldId, usage_qty: usage, sort_order: index };
  });
  const seen = new Set();
  prepared.forEach(row => {
    if (seen.has(row.yield_id)) throw new Error('同一部位重复挂载，请合并为一行');
    seen.add(row.yield_id);
  });

  db.exec('BEGIN');
  try {
    db.run('DELETE FROM poultry_dish_usage WHERE menu_item_id=?', [menuItemId]);
    prepared.forEach(row => db.insert(
      'INSERT INTO poultry_dish_usage (menu_item_id,yield_id,usage_qty,sort_order) VALUES (?,?,?,?)',
      [menuItemId, row.yield_id, row.usage_qty, row.sort_order]));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.save();
  return { ok: true, count: prepared.length };
}

/**
 * 全菜品耗用总览：用于「菜品耗用」维护页。
 * 支持按分组（菜品分类）筛选 —— 同分组的菜通常用同一套部位耗用，按组挑菜再批量关联，
 * 比在 160 个菜品里逐个点快得多，所以同时返回每个分组的「已配置/总数」进度。
 */
function listUsageOverview(params = {}) {
  const keyword = String(params.keyword || '').trim();
  const categoryFilter = String(params.category || '').trim();
  const onlyUnset = params.filter === 'unset';
  const onlySet = params.filter === 'set';

  const all = db.queryAll(`SELECT m.id, m.name, m.spec, m.method, m.category, m.status, m.cost
    FROM menu_items m
    ORDER BY CASE WHEN m.category IS NULL OR m.category='' THEN 1 ELSE 0 END, m.category, m.name, m.spec, m.id`);

  const countByMenu = new Map(db.queryAll(
    'SELECT menu_item_id, COUNT(*) AS n FROM poultry_dish_usage GROUP BY menu_item_id'
  ).map(row => [row.menu_item_id, Number(row.n) || 0]));

  // 分组进度基于全部菜品统计（不受关键词/分组筛选影响），让分组条始终显示稳定的全局进度
  const categoryMap = new Map();
  for (const item of all) {
    const key = String(item.category || '').trim();
    const bucket = categoryMap.get(key) || { name: key, total: 0, configured: 0 };
    bucket.total += 1;
    if (countByMenu.get(item.id)) bucket.configured += 1;
    categoryMap.set(key, bucket);
  }
  const categories = [...categoryMap.values()].sort((a, b) => {
    if (!a.name) return 1;
    if (!b.name) return -1;
    return b.total - a.total || a.name.localeCompare(b.name, 'zh');
  });

  const lowerKeyword = keyword.toLowerCase();
  const items = all.filter(item => {
    const count = countByMenu.get(item.id) || 0;
    if (categoryFilter && String(item.category || '').trim() !== categoryFilter) return false;
    if (onlyUnset && count > 0) return false;
    if (onlySet && count === 0) return false;
    if (lowerKeyword && !`${item.name} ${item.category} ${item.spec}`.toLowerCase().includes(lowerKeyword)) return false;
    return true;
  }).map(item => ({ ...item, usage_count: countByMenu.get(item.id) || 0 }));

  const usageRows = db.queryAll(`
    SELECT u.menu_item_id, u.usage_qty, y.part_name, y.parts_per_bird, y.part_kind,
      b.animal, b.breed_name
    FROM poultry_dish_usage u
    JOIN poultry_yields y ON y.id=u.yield_id
    JOIN poultry_birds b ON b.id=y.bird_id
    ORDER BY u.menu_item_id, u.sort_order, u.id`);
  const grouped = new Map();
  for (const row of usageRows) {
    const list = grouped.get(row.menu_item_id) || [];
    list.push({
      animal: row.animal, breed_name: row.breed_name, part_name: row.part_name,
      part_kind: normalizePartKind(row.part_kind, row.part_name),
      usage_qty: Number(row.usage_qty) || 0, parts_per_bird: Number(row.parts_per_bird) || 0,
      per_portion_birds: round4((Number(row.usage_qty) || 0) / (Number(row.parts_per_bird) || 1)),
    });
    grouped.set(row.menu_item_id, list);
  }
  return {
    items: items.map(row => ({ ...row, usage: grouped.get(row.id) || [] })),
    total: items.length,
    all_total: all.length,
    categories,
    configured: countByMenu.size,
  };
}

/**
 * 批量关联：把同一套「部位 × 每份耗用」应用到多个菜品。
 * mode=replace 覆盖（先清空这些菜品的原有配置，适合整组用同一套部位）
 * mode=append  追加（保留原有配置，适合给已有配置的菜再加一条双拼部位）
 */
function batchSaveUsage(body = {}) {
  const ids = Array.isArray(body.menu_item_ids)
    ? [...new Set(body.menu_item_ids.map(Number).filter(n => Number.isInteger(n) && n > 0))]
    : [];
  if (!ids.length) throw new Error('请先勾选要关联的菜品');
  if (ids.length > 300) throw new Error('单次最多批量关联 300 个菜品');
  const mode = body.mode === 'append' ? 'append' : 'replace';
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new Error('请至少配置一条禽类耗用');
  if (rows.length > 30) throw new Error('单次最多配置 30 条耗用关系');

  const prepared = rows.map((row, index) => {
    const yieldId = Number(row?.yield_id);
    if (!Number.isInteger(yieldId) || yieldId <= 0) throw new Error(`第 ${index + 1} 行请选择部位`);
    const usage = Number(row?.usage_qty);
    if (!Number.isFinite(usage) || usage <= 0) throw new Error(`第 ${index + 1} 行「每份耗用数量」必须大于 0`);
    if (!db.queryOne('SELECT id FROM poultry_yields WHERE id=?', [yieldId])) throw new Error(`第 ${index + 1} 行引用的部位不存在`);
    return { yield_id: yieldId, usage_qty: usage, sort_order: index };
  });
  const seen = new Set();
  prepared.forEach(row => {
    if (seen.has(row.yield_id)) throw new Error('同一部位重复配置，请合并为一行');
    seen.add(row.yield_id);
  });

  const placed = db.queryAll(`SELECT id FROM menu_items WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  if (placed.length !== ids.length) throw new Error(`有 ${ids.length - placed.length} 个菜品已不存在，请刷新后重试`);

  // 覆盖模式会丢掉原有配置，先把会丢掉的条数算出来回报给前端，避免静默删掉用户手工配的关系
  let removed = 0;
  let replacedDishes = 0;
  if (mode === 'replace') {
    const keep = new Set(prepared.map(row => row.yield_id));
    for (const id of ids) {
      const currentRows = db.queryAll('SELECT yield_id FROM poultry_dish_usage WHERE menu_item_id=?', [id]);
      if (currentRows.length) replacedDishes += 1;
      for (const row of currentRows) if (!keep.has(row.yield_id)) removed += 1;
    }
  }

  db.exec('BEGIN');
  try {
    for (const id of ids) {
      if (mode === 'replace') db.run('DELETE FROM poultry_dish_usage WHERE menu_item_id=?', [id]);
      for (const row of prepared) {
        db.run(`INSERT INTO poultry_dish_usage (menu_item_id,yield_id,usage_qty,sort_order) VALUES (?,?,?,?)
          ON CONFLICT(menu_item_id, yield_id) DO UPDATE SET usage_qty=excluded.usage_qty,
            sort_order=excluded.sort_order, updated_at=datetime('now','localtime')`,
        [id, row.yield_id, row.usage_qty, row.sort_order]);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.save();
  return { ok: true, dishes: ids.length, rows: prepared.length, mode, removed, replaced_dishes: replacedDishes };
}

/** 已配置耗用关系的菜品（供核算明细下钻时快速选择） */
function listConfiguredMenus() {
  return db.queryAll(`
    SELECT m.id, m.name, m.spec, m.category,
      (SELECT COUNT(*) FROM poultry_dish_usage u WHERE u.menu_item_id=m.id) AS usage_count
    FROM menu_items m
    WHERE EXISTS (SELECT 1 FROM poultry_dish_usage u WHERE u.menu_item_id=m.id)
    ORDER BY m.category, m.name, m.spec, m.id`).map(row => ({ ...row, usage_count: Number(row.usage_count) || 0 }));
}

// ==================== ④ 核算主流程 ====================

/** 解析门店筛选：dish_sales 只有 store_name，必须由 store_id 换名称 */
function resolveStoreNames({ store_id, store_ids }) {
  const ids = [];
  if (store_id && Number(store_id) > 0) ids.push(Number(store_id));
  if (store_ids) {
    String(store_ids).split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).forEach(n => {
      if (!ids.includes(n)) ids.push(n);
    });
  }
  if (!ids.length) return { names: [], ids: [] };
  const names = db.queryAll(
    `SELECT id, store_name FROM stores WHERE id IN (${ids.map(() => '?').join(',')})`, ids
  ).map(row => row.store_name);
  return { names, ids };
}

function calculate(params = {}) {
  const dateFrom = String(params.date_from || '').trim();
  const dateTo = String(params.date_to || '').trim();
  const channel = ['all', 'dine_in', 'group', 'delivery', 'other'].includes(String(params.channel)) ? String(params.channel) : 'all';
  const animalFilter = String(params.animal || '').trim();

  const { names: storeNames, ids: storeIds } = resolveStoreNames(params);

  const where = ["COALESCE(d.refunded,'') NOT IN ('部分退','是','1')"];
  const args = [];
  if (dateFrom) { where.push('d.order_time>=?'); args.push(dateFrom); }
  if (dateTo) { where.push('d.order_time<=?'); args.push(`${dateTo} 23:59:59`); }
  if (storeNames.length) {
    where.push(`d.store_name IN (${storeNames.map(() => '?').join(',')})`);
    args.push(...storeNames);
  }
  if (channel !== 'all') { where.push(`${CHANNEL_SQL} = ?`); args.push(channel); }
  const whereSql = where.join(' AND ');

  const dataRange = db.queryOne(
    "SELECT MIN(substr(order_time,1,10)) AS min_date, MAX(substr(order_time,1,10)) AS max_date FROM dish_sales"
  ) || {};

  // 1) 销量聚合：按 (编码, 名称, 规格) 分组，与 dish_sales_mappings 唯一键同粒度
  const salesRows = db.queryAll(`
    SELECT d.product_code, d.product_name, d.spec,
      SUM(d.quantity) AS quantity,
      SUM(d.income_amount) AS income_amount,
      COUNT(DISTINCT d.order_no) AS order_count
    FROM dish_sales d
    WHERE ${whereSql}
    GROUP BY d.product_code, d.product_name, d.spec
    ORDER BY quantity DESC`, args);

  const totalQuantity = salesRows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);

  // 2) 渠道构成（单独统计，供页面提示「其他/未分类」占比）
  const channelRows = db.queryAll(`
    SELECT ${CHANNEL_SQL} AS channel, SUM(d.quantity) AS quantity, COUNT(*) AS rows
    FROM dish_sales d WHERE ${whereSql}
    GROUP BY channel ORDER BY quantity DESC`, args);

  const channelBreakdown = channelRows.map(row => ({
    channel: row.channel,
    label: CHANNEL_LABELS[row.channel] || row.channel,
    quantity: round2(row.quantity),
    rows: Number(row.rows) || 0,
  }));

  const emptyResult = (extra = {}) => ({
    ok: true,
    stores: storeIds.length ? db.queryAll(`SELECT id, store_name FROM stores WHERE id IN (${storeIds.map(() => '?').join(',')})`, storeIds) : [],
    period: { date_from: dateFrom, date_to: dateTo, channel },
    data_range: { min_date: dataRange.min_date || '', max_date: dataRange.max_date || '' },
    summary: {
      total_quantity: 0, covered_quantity: 0, covered_rate: 0,
      birds: [], parts: [], total_birds: 0, total_birds_linear: 0, total_weight_kg: 0, total_cost: 0,
    },
    dishes: [], parts: [], coverage: { unbound: [], no_usage: [], warnings: [], unbound_quantity: 0, no_usage_quantity: 0 },
    channel_breakdown: channelBreakdown,
    ...extra,
  });

  if (!salesRows.length) return emptyResult();

  // 3) 一次载入档案，避免逐行查库
  const birds = listBirds();
  const birdById = new Map(birds.map(row => [row.id, row]));
  const yields = db.queryAll('SELECT * FROM poultry_yields').map(row => ({
    ...row, parts_per_bird: Number(row.parts_per_bird) || 0, part_weight_g: Number(row.part_weight_g) || 0,
    part_kind: normalizePartKind(row.part_kind, row.part_name),
  }));
  const yieldById = new Map(yields.map(row => [row.id, row]));

  const usageByMenu = new Map();
  db.queryAll('SELECT * FROM poultry_dish_usage ORDER BY sort_order, id').forEach(row => {
    const list = usageByMenu.get(row.menu_item_id) || [];
    list.push({ ...row, usage_qty: Number(row.usage_qty) || 0 });
    usageByMenu.set(row.menu_item_id, list);
  });

  const mappingRows = db.queryAll('SELECT * FROM dish_sales_mappings');
  const mappingByKey = new Map(mappingRows.map(row => [
    `${row.product_code}|${row.product_name}|${normalizeDishSpec(row.spec)}`, row.menu_item_id,
  ]));

  const menuItems = db.queryAll('SELECT id,name,spec,category FROM menu_items');
  const menuById = new Map(menuItems.map(row => [row.id, row]));
  // 名称 + 归一化规格 → 菜品（兜底匹配：报表菜名与本地档案同名但没走过绑定）
  // 档案里名称为空的记录不进入索引，避免被空菜名的报表行命中。
  const menuByKey = new Map();
  const menuByName = new Map();
  for (const item of menuItems) {
    const nameKey = String(item.name || '').trim();
    if (!nameKey) continue;
    const key = `${nameKey}|${normalizeDishSpec(item.spec)}`;
    if (!menuByKey.has(key)) menuByKey.set(key, item.id);
    const list = menuByName.get(nameKey) || [];
    list.push(item);
    menuByName.set(nameKey, list);
  }

  const dishes = [];
  // 按「禽 + 部位」汇总需求：料篮模型的基础数据（原来直接按禽累加只数，等于每个菜品各买一只鸟）
  const partTotals = new Map();     // `${birdId}|${yieldId}` → { demand, linear_birds, ... }
  const unbound = [];
  const noUsageMap = new Map();     // menu_item_id → 聚合后的未配出成缺口
  const warnings = [];
  let coveredQuantity = 0;
  let weightByPartKg = 0;
  let hasPartWeight = false;

  for (const row of salesRows) {
    const quantity = Number(row.quantity) || 0;
    const spec = normalizeDishSpec(row.spec);
    const productName = String(row.product_name || '').trim();

    // 三级匹配：① 绑定表 → ② 名称+规格直配 → ③ 名称唯一命中 → ④ 计入未覆盖
    // 报表里存在菜品名为空的行（赠品/杂项），空名不能参与任何名称匹配，否则会误挂到同名档案上。
    let menuItemId = mappingByKey.get(`${row.product_code}|${row.product_name}|${spec}`) || null;
    // 历史遗留的孤儿绑定（dish_sales_mappings 指向已被删除的菜品）不能算「已绑定」，
    // 否则缺口清单里会出现没有菜品名、也无法去配置的空行；这里退回名称兜底，兜不住就按未绑定报出。
    if (menuItemId && !menuById.has(menuItemId)) menuItemId = null;
    if (!menuItemId && productName) menuItemId = menuByKey.get(`${productName}|${spec}`) || null;
    if (!menuItemId && productName) {
      const sameName = menuByName.get(productName) || [];
      if (sameName.length === 1) menuItemId = sameName[0].id;
    }

    if (!menuItemId) {
      unbound.push({
        product_code: row.product_code, product_name: productName, spec,
        quantity: round2(quantity), income_amount: round2(row.income_amount),
      });
      continue;
    }

    const usages = usageByMenu.get(menuItemId) || [];
    if (!usages.length) {
      const menu = menuById.get(menuItemId);
      // 同一菜品可能对应多个收银分组（不同编码/规格写法），按菜品聚合，只报一行「去配置」更可用
      const key = menuItemId;
      const existing = noUsageMap.get(key);
      if (existing) {
        existing.quantity = round2(existing.quantity + quantity);
        existing.income_amount = round2(existing.income_amount + (Number(row.income_amount) || 0));
        existing.sales_group_count += 1;
        if (row.product_name && !existing.product_names.includes(row.product_name)) existing.product_names.push(row.product_name);
      } else {
        noUsageMap.set(key, {
          menu_item_id: menuItemId,
          menu_name: menu ? menu.name : '',
          menu_spec: menu ? normalizeDishSpec(menu.spec) : '',
          product_name: productName, spec,
          product_names: productName ? [productName] : [],
          quantity: round2(quantity), income_amount: round2(row.income_amount),
          sales_group_count: 1,
        });
      }
      continue;
    }

    coveredQuantity += quantity;
    const menu = menuById.get(menuItemId);
    for (const usage of usages) {
      const yieldRow = yieldById.get(usage.yield_id);
      if (!yieldRow) continue;
      const bird = birdById.get(yieldRow.bird_id);
      if (!bird) continue;
      if (animalFilter && bird.animal !== animalFilter) continue;
      if (!(yieldRow.parts_per_bird > 0)) {
        warnings.push({
          type: 'invalid_yield',
          bird: `${bird.animal}·${bird.breed_name}`,
          part_name: yieldRow.part_name,
          message: `「${bird.breed_name}」的「${yieldRow.part_name}」出成数量为 0，该部位已跳过计算`,
        });
        continue;
      }
      if (bird.status === '停用') continue;

      const consumedParts = quantity * usage.usage_qty;
      const linearBirds = consumedParts / yieldRow.parts_per_bird;
      if (!Number.isFinite(linearBirds) || linearBirds <= 0) continue;

      const partKind = normalizePartKind(yieldRow.part_kind, yieldRow.part_name);
      const partKey = `${bird.id}|${yieldRow.id}`;
      const partBucket = partTotals.get(partKey) || {
        bird_id: bird.id, yield_id: yieldRow.id,
        part_name: yieldRow.part_name, part_kind: partKind,
        parts_per_bird: yieldRow.parts_per_bird, part_weight_g: yieldRow.part_weight_g,
        demand: 0, linear_birds: 0, dish_count: 0,
      };
      partBucket.demand += consumedParts;
      partBucket.linear_birds += linearBirds;
      partBucket.dish_count += 1;
      partTotals.set(partKey, partBucket);

      if (yieldRow.part_weight_g > 0) {
        hasPartWeight = true;
        weightByPartKg += consumedParts * yieldRow.part_weight_g / 1000;
      }

      const perPortionBirds = usage.usage_qty / yieldRow.parts_per_bird;
      const dishRow = {
        menu_item_id: menuItemId,
        menu_name: menu ? menu.name : '',
        menu_spec: menu ? normalizeDishSpec(menu.spec) : '',
        category: menu ? menu.category : '',
        animal: bird.animal,
        breed_name: bird.breed_name,
        bird_id: bird.id,
        part_name: yieldRow.part_name,
        part_kind: partKind,
        usage_qty: round4(usage.usage_qty),
        parts_per_bird: round4(yieldRow.parts_per_bird),
        per_portion_birds: round4(perPortionBirds),
        quantity: round2(quantity),
        income_amount: round2(row.income_amount),
        birds_count: round2(linearBirds),
      };
      dishes.push(dishRow);

      // 单份就吃掉 1 只以上整禽，几乎都是配置错误（或名称本身含多只），标出来让人复核
      if (perPortionBirds > 1) {
        warnings.push({
          type: 'per_portion_over_one',
          bird: `${bird.animal}·${bird.breed_name}`,
          part_name: yieldRow.part_name,
          menu_name: dishRow.menu_name,
          menu_spec: dishRow.menu_spec,
          per_portion_birds: round4(perPortionBirds),
          message: `「${dishRow.menu_name}」每份折合 ${round4(perPortionBirds)} 只${bird.animal}，请复核出成与耗用配置`,
        });
      }
    }
  }

  dishes.sort((a, b) => b.birds_count - a.birds_count);
  // 明细表的占比按「线性口径」算（各菜品独立折鸟），这样每行占比加总=100%，便于看谁贡献大
  const totalLinearBirds = [...partTotals.values()].reduce((sum, p) => sum + p.linear_birds, 0);
  dishes.forEach(row => { row.share = totalLinearBirds > 0 ? round4(row.birds_count / totalLinearBirds) : 0; });

  // ===== 料篮模型 =====
  // 一只鸟身上同时产出多个部位，所以：
  //   身体部位（同一块身体的不同卖法，互相抢鸟）→ 需求相加
  //   副产品（随鸟附带产出，不额外占鸟）        → 需求取最大，只有超过身体需求时才成为瓶颈
  //   只数 = max(身体合计, 副产品瓶颈)
  const parts = [...partTotals.values()].map(p => {
    const birds = p.parts_per_bird > 0 ? p.demand / p.parts_per_bird : 0;
    const bird = birdById.get(p.bird_id);
    return {
      yield_id: p.yield_id,
      bird_id: p.bird_id,
      animal: bird ? bird.animal : '',
      breed_name: bird ? bird.breed_name : '',
      part_name: p.part_name,
      part_kind: p.part_kind,
      parts_per_bird: round4(p.parts_per_bird),
      part_weight_g: p.part_weight_g,
      demand: round2(p.demand),
      birds: round2(birds),
      linear_birds: round2(p.linear_birds),
      dish_count: p.dish_count,
    };
  }).sort((a, b) => b.birds - a.birds);

  const perBird = new Map();     // bird_id → { body, bodyParts[], byproductParts[] }
  for (const p of parts) {
    const bucket = perBird.get(p.bird_id) || { body: 0, bodyParts: [], byproductParts: [] };
    if (p.part_kind === '副产品') bucket.byproductParts.push(p);
    else { bucket.body += p.birds; bucket.bodyParts.push(p); }
    perBird.set(p.bird_id, bucket);
  }
  // 标记瓶颈：整体最大的部位，以及各禽内部真正的瓶颈
  const governingPartId = new Map();
  for (const [birdId, bucket] of perBird.entries()) {
    const topBody = bucket.bodyParts.slice().sort((a, b) => b.birds - a.birds)[0];
    const topByproduct = bucket.byproductParts.slice().sort((a, b) => b.birds - a.birds)[0];
    bucket.topBody = topBody;
    bucket.topByproduct = topByproduct;
    const byproductBirds = topByproduct ? topByproduct.birds : 0;
    const governing = bucket.body >= byproductBirds ? topBody : topByproduct;
    if (governing) governingPartId.set(birdId, governing.yield_id);
  }
  parts.forEach(p => { p.is_bottleneck = governingPartId.get(p.bird_id) === p.yield_id; });

  const summaryBirds = [...perBird.entries()].map(([birdId, bucket]) => {
    const bird = birdById.get(birdId);
    const byproductBirds = bucket.topByproduct ? bucket.topByproduct.birds : 0;
    const usesByproduct = byproductBirds > bucket.body;
    // 先定稿只数（2 位小数），再由它推算折重与成本，保证页面上「只数 × 单只净重/成本」能对得上
    const birdsCount = round2(Math.max(bucket.body, byproductBirds));
    const linearBirds = [...partTotals.values()].filter(p => p.bird_id === birdId)
      .reduce((sum, p) => sum + p.linear_birds, 0);
    const netWeight = Number(bird.net_weight_kg) || 0;
    const unitCost = Number(bird.unit_cost) || 0;
    const weightKg = round2(birdsCount * netWeight);
    const cost = round2(birdsCount * unitCost);

    // ===== 食材去向对账（风控）=====
    // 一只禽固定产出 1 个头颈 / 2 只翅 / 一整只身体的肉，三者必须互相吻合。
    // 以模型只数 N 为基准：某个渠道实际记录到的份量低于应有值，差额就是「去向不明」
    // （报损、员工餐、赠送、没进 POS，或该渠道的菜品没绑定/没配系数）。
    const bodyGap = round2(birdsCount - bucket.body);
    const byproductChecks = bucket.byproductParts.slice().sort((a, b) => b.birds - a.birds).map(p => {
      const expected = round2(birdsCount * p.parts_per_bird);
      const gap = round2(expected - p.demand);
      return {
        part_name: p.part_name,
        parts_per_bird: p.parts_per_bird,
        demand: p.demand,
        expected,
        gap,
        gap_rate: expected > 0 ? round4(gap / expected) : 0,
        implied_birds: p.birds,
      };
    });
    const implied = byproductChecks.map(p => p.implied_birds);
    const byproductSpread = implied.length > 1 ? round2(Math.max(...implied) - Math.min(...implied)) : 0;
    const risk = {
      processed_birds: birdsCount,
      body_recorded: round2(bucket.body),
      body_gap: bodyGap,
      body_gap_rate: birdsCount > 0 ? round4(bodyGap / birdsCount) : 0,
      byproducts: byproductChecks,
      byproduct_spread: byproductSpread,
      // 副产品之间也应当互相吻合，差异大说明某一方的菜品没绑全/没记录
      byproduct_conflict: byproductSpread > Math.max(2, Math.max(0, ...implied) * 0.1),
    };

    return {
      bird_id: birdId,
      animal: bird.animal,
      breed_name: bird.breed_name,
      net_weight_kg: netWeight,
      unit_cost: unitCost,
      birds_count: birdsCount,
      // 参考值：按「每个菜品各自买一只鸟」的口径（旧算法），只高不低，用于对照
      birds_count_linear: round2(linearBirds),
      body_birds: round2(bucket.body),
      byproduct_birds: round2(byproductBirds),
      governing: usesByproduct ? '副产品' : '身体',
      governing_part: usesByproduct
        ? (bucket.topByproduct ? bucket.topByproduct.part_name : '')
        : (bucket.topBody ? bucket.topBody.part_name : ''),
      weight_kg: weightKg,
      cost,
      weight_by_part_kg: hasPartWeight ? round2(weightByPartKg) : null,
      weight_diff_rate: hasPartWeight && weightKg > 0
        ? round4((weightByPartKg - weightKg) / weightKg)
        : null,
      risk,
      share: 0,
    };
  }).sort((a, b) => {
    const order = { '鹅': 1, '鸭': 2, '鸡': 3 };
    return (order[a.animal] || 9) - (order[b.animal] || 9) || b.birds_count - a.birds_count;
  });

  const totalBirds = summaryBirds.reduce((sum, row) => sum + row.birds_count, 0);
  summaryBirds.forEach(row => { row.share = totalBirds > 0 ? round4(row.birds_count / totalBirds) : 0; });

  unbound.sort((a, b) => b.quantity - a.quantity);
  const noUsage = [...noUsageMap.values()].sort((a, b) => b.quantity - a.quantity);

  return {
    ok: true,
    stores: storeIds.length
      ? db.queryAll(`SELECT id, store_name FROM stores WHERE id IN (${storeIds.map(() => '?').join(',')})`, storeIds)
      : [],
    period: { date_from: dateFrom, date_to: dateTo, channel },
    data_range: { min_date: dataRange.min_date || '', max_date: dataRange.max_date || '' },
    summary: {
      total_quantity: round2(totalQuantity),
      covered_quantity: round2(coveredQuantity),
      covered_rate: totalQuantity > 0 ? round4(coveredQuantity / totalQuantity) : 0,
      birds: summaryBirds,
      total_birds: round2(totalBirds),
      total_birds_linear: round2(totalLinearBirds),
      total_weight_kg: round2(summaryBirds.reduce((sum, row) => sum + row.weight_kg, 0)),
      total_cost: round2(summaryBirds.reduce((sum, row) => sum + row.cost, 0)),
      dish_row_count: dishes.length,
      configured_dish_count: [...usageByMenu.keys()].filter(id => menuById.has(id)).length,
      // 风控判断可信度用：覆盖率低时「身体差额」主要由菜品未绑定造成，不能当损耗读
      uncovered_quantity: round2(totalQuantity - coveredQuantity),
    },
    dishes,
    parts,
    coverage: {
      unbound,
      no_usage: noUsage,
      unbound_quantity: round2(unbound.reduce((sum, row) => sum + row.quantity, 0)),
      no_usage_quantity: round2(noUsage.reduce((sum, row) => sum + row.quantity, 0)),
      warnings: warnings.slice(0, 100),
      warning_count: warnings.length,
    },
    channel_breakdown: channelBreakdown,
  };
}

// ==================== ⑤ 实际采购只数 ====================

function listPurchases(params = {}) {
  const month = String(params.month || '').trim();
  const storeId = Number(params.store_id) || 0;
  let sql = `SELECT p.*, b.animal, b.breed_name,
      COALESCE(NULLIF(p.store_name,''), s.store_name, '') AS resolved_store_name
    FROM poultry_purchases p
    JOIN poultry_birds b ON b.id=p.bird_id
    LEFT JOIN stores s ON s.id=p.store_id
    WHERE 1=1`;
  const args = [];
  if (month) { sql += ' AND p.month=?'; args.push(month); }
  if (storeId) { sql += ' AND p.store_id=?'; args.push(storeId); }
  sql += ' ORDER BY p.month DESC, s.store_name, b.id';
  return db.queryAll(sql, args).map(row => ({
    ...row,
    quantity: Number(row.quantity) || 0,
    amount: Number(row.amount) || 0,
  }));
}

function savePurchase(body = {}) {
  const storeId = Number(body.store_id);
  if (!Number.isInteger(storeId) || storeId <= 0) throw new Error('请选择门店');
  const month = String(body.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式应为 YYYY-MM');
  const birdId = Number(body.bird_id);
  if (!Number.isInteger(birdId) || birdId <= 0) throw new Error('请选择禽类品种');
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('采购只数不能为负');
  const amount = Number(body.amount);
  const store = db.queryOne('SELECT id, store_name FROM stores WHERE id=?', [storeId]);
  if (!store) throw new Error('门店不存在');
  const bird = db.queryOne('SELECT id FROM poultry_birds WHERE id=?', [birdId]);
  if (!bird) throw new Error('禽类品种不存在');

  const existing = db.queryOne('SELECT id FROM poultry_purchases WHERE store_id=? AND month=? AND bird_id=?', [storeId, month, birdId]);
  if (existing) {
    db.run(`UPDATE poultry_purchases SET quantity=?, amount=?, remark=?, store_name=?,
            updated_at=datetime('now','localtime') WHERE id=?`,
      [quantity, Number.isFinite(amount) ? amount : 0, String(body.remark || '').trim(), store.store_name, existing.id]);
  } else {
    db.insert(
      'INSERT INTO poultry_purchases (store_id,store_name,month,bird_id,quantity,amount,remark) VALUES (?,?,?,?,?,?,?)',
      [storeId, store.store_name, month, birdId, quantity, Number.isFinite(amount) ? amount : 0, String(body.remark || '').trim()]);
  }
  db.save();
  return { ok: true };
}

function deletePurchase(id) {
  const row = db.queryOne('SELECT id FROM poultry_purchases WHERE id=?', [id]);
  if (!row) throw new Error('采购记录不存在');
  db.run('DELETE FROM poultry_purchases WHERE id=?', [id]);
  db.save();
  return { ok: true };
}

/**
 * 理论用量 vs 实际采购对比。
 * 核算区间通常不整月，这里按区间覆盖到的月份求采购合计，并显式回报「是否整月」，避免把半个月的
 * 理论量拿去和整月采购量比。
 */
function purchaseComparison(params = {}) {
  const dateFrom = String(params.date_from || '').trim();
  const dateTo = String(params.date_to || '').trim();
  if (!dateFrom || !dateTo) throw new Error('请先选择起止日期');
  const calc = calculate(params);

  const months = [];
  const cursor = new Date(`${dateFrom}T00:00:00`);
  const end = new Date(`${dateTo}T00:00:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) throw new Error('日期格式不正确');
  while (cursor <= end) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    if (!months.includes(key)) months.push(key);
    cursor.setDate(cursor.getDate() + 1);
  }
  const monthKeys = months;
  const isWholeMonth = months.length === 1 && dateFrom === `${months[0]}-01` && (() => {
    const year = Number(months[0].slice(0, 4));
    const month = Number(months[0].slice(5, 7));
    const lastDay = new Date(year, month, 0).getDate();
    return dateTo === `${months[0]}-${String(lastDay).padStart(2, '0')}`;
  })();

  const { names: storeNames } = resolveStoreNames(params);
  // poultry_purchases.month 存的是 'YYYY-MM'，这里必须按同格式匹配，不能拼成月初日期
  let sql = `SELECT p.bird_id, SUM(p.quantity) AS quantity, SUM(p.amount) AS amount
    FROM poultry_purchases p WHERE p.month IN (${monthKeys.map(() => '?').join(',')})`;
  const args = [...monthKeys];
  if (storeNames.length) {
    sql += ` AND (p.store_id IN (SELECT id FROM stores WHERE store_name IN (${storeNames.map(() => '?').join(',')})))`;
    args.push(...storeNames);
  }
  sql += ' GROUP BY p.bird_id';
  const purchaseRows = db.queryAll(sql, args);
  const purchaseByBird = new Map(purchaseRows.map(row => [row.bird_id, row]));

  const birds = listBirds();
  const comparison = birds.map(bird => {
    const theoretical = (calc.summary.birds || []).find(row => row.bird_id === bird.id);
    const purchased = purchaseByBird.get(bird.id);
    const theoreticalBirds = theoretical ? theoretical.birds_count : 0;
    const purchasedBirds = purchased ? round2(purchased.quantity) : 0;
    return {
      bird_id: bird.id,
      animal: bird.animal,
      breed_name: bird.breed_name,
      theoretical_birds: theoreticalBirds,
      theoretical_cost: theoretical ? theoretical.cost : 0,
      purchased_birds: purchasedBirds,
      purchased_amount: purchased ? round2(purchased.amount) : 0,
      diff_birds: round2(theoreticalBirds - purchasedBirds),
      diff_rate: purchasedBirds > 0 ? round4((theoreticalBirds - purchasedBirds) / purchasedBirds) : null,
      has_purchase: !!purchased,
      purchase_count: Number(bird.purchase_count) || 0,
    };
  }).filter(row => row.theoretical_birds > 0 || row.has_purchase);

  return {
    ok: true,
    months,
    is_whole_month: isWholeMonth,
    period: calc.period,
    comparison,
    totals: {
      theoretical_birds: round2(comparison.reduce((sum, row) => sum + row.theoretical_birds, 0)),
      purchased_birds: round2(comparison.reduce((sum, row) => sum + row.purchased_birds, 0)),
      theoretical_cost: round2(comparison.reduce((sum, row) => sum + row.theoretical_cost, 0)),
      purchased_amount: round2(comparison.reduce((sum, row) => sum + row.purchased_amount, 0)),
    },
  };
}

// ==================== ⑥ Excel 模板与导入 ====================

const TEMPLATE_SHEETS = {
  birds: '① 禽类档案',
  yields: '② 整只出成',
  usage: '③ 菜品耗用',
};

function buildTemplateWorkbook() {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();

  const existingBirds = listBirds();
  const birdSheet = existingBirds.length
    ? existingBirds.map(row => ({
      '禽类(鹅/鸭/鸡)': row.animal, '品种名称': row.breed_name,
      '单只净重(kg)': row.net_weight_kg, '单只成本(元)': row.unit_cost,
      '状态': row.status, '备注': row.remark,
    }))
    : [
      { '禽类(鹅/鸭/鸡)': '鹅', '品种名称': '清远黑鬃鹅', '单只净重(kg)': '', '单只成本(元)': '', '状态': '启用', '备注': '示例行，请按实际填写' },
      { '禽类(鹅/鸭/鸡)': '鸭', '品种名称': '白鸭', '单只净重(kg)': '', '单只成本(元)': '', '状态': '启用', '备注': '示例行，请按实际填写' },
      { '禽类(鹅/鸭/鸡)': '鸡', '品种名称': '三黄鸡', '单只净重(kg)': '', '单只成本(元)': '', '状态': '启用', '备注': '示例行，请按实际填写' },
    ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(birdSheet), TEMPLATE_SHEETS.birds);

  const existingYields = listYields();
  const yieldSheet = existingYields.length
    ? existingYields.map(row => ({
      '品种名称': row.breed_name, '部位名称': row.part_name,
      '部位类别': row.part_kind, '一只出成数量': row.parts_per_bird,
      '单份克重(g)': row.part_weight_g || '', '备注': row.remark,
    }))
    : [
      { '品种名称': '清远黑鬃鹅', '部位名称': '上庄', '部位类别': '身体', '一只出成数量': '', '单份克重(g)': '', '备注': '示例：一只鹅出 2 份上庄就填 2' },
      { '品种名称': '清远黑鬃鹅', '部位名称': '下庄', '部位类别': '身体', '一只出成数量': '', '单份克重(g)': '', '备注': '身体：和上庄/整只抢同一块肉，需求相加' },
      { '品种名称': '清远黑鬃鹅', '部位名称': '鹅腿', '部位类别': '身体', '一只出成数量': '', '单份克重(g)': '', '备注': '' },
      { '品种名称': '清远黑鬃鹅', '部位名称': '鹅肉', '部位类别': '身体', '一只出成数量': '', '单份克重(g)': '', '备注': '切片做饭/粉，一只出多少份' },
      { '品种名称': '清远黑鬃鹅', '部位名称': '鹅头带颈', '部位类别': '副产品', '一只出成数量': '', '单份克重(g)': '', '备注': '副产品：随鸟附带产出，不额外算鸟' },
      { '品种名称': '清远黑鬃鹅', '部位名称': '战斧(鹅翅)', '部位类别': '副产品', '一只出成数量': '', '单份克重(g)': '', '备注': '' },
      { '品种名称': '清远黑鬃鹅', '部位名称': '鹅掌', '部位类别': '副产品', '一只出成数量': '', '单份克重(g)': '', '备注': '' },
    ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(yieldSheet), TEMPLATE_SHEETS.yields);

  // 菜品行预填本地菜品档案，后厨只需补「品种/部位/每份耗用」，不用手打 160 个菜名
  const menus = db.queryAll("SELECT id, name, spec, category FROM menu_items ORDER BY category, name, id");
  const existingUsage = new Map();
  db.queryAll(`
    SELECT u.menu_item_id, u.usage_qty, y.part_name, b.breed_name
    FROM poultry_dish_usage u
    JOIN poultry_yields y ON y.id=u.yield_id
    JOIN poultry_birds b ON b.id=y.bird_id ORDER BY u.menu_item_id`).forEach(row => {
    const list = existingUsage.get(row.menu_item_id) || [];
    list.push(row);
    existingUsage.set(row.menu_item_id, list);
  });
  const usageSheet = [];
  menus.forEach(menu => {
    const configured = existingUsage.get(menu.id) || [];
    if (configured.length) {
      configured.forEach(row => usageSheet.push({
        '菜品名称': menu.name, '规格': normalizeDishSpec(menu.spec), '分类': menu.category || '',
        '品种名称': row.breed_name, '部位名称': row.part_name, '每份耗用数量': row.usage_qty,
      }));
    } else {
      usageSheet.push({
        '菜品名称': menu.name, '规格': normalizeDishSpec(menu.spec), '分类': menu.category || '',
        '品种名称': '', '部位名称': '', '每份耗用数量': '',
      });
    }
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(usageSheet.length ? usageSheet : [{ '菜品名称': '', '规格': '', '分类': '', '品种名称': '', '部位名称': '', '每份耗用数量': '' }]), TEMPLATE_SHEETS.usage);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function pickCell(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return row[key];
  }
  return '';
}

/**
 * Excel 导入：三个 sheet 依次 upsert。
 * 逐行容错 —— 缺字段/找不到菜品的行记录下来回报，不中断整批导入。
 */
function importWorkbook(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const result = { birds: 0, yields: 0, usage: 0, errors: [] };

  const findSheet = (name) => {
    const hit = wb.SheetNames.find(sheet => String(sheet).includes(name));
    return hit ? wb.Sheets[hit] : null;
  };
  const readRows = (name) => {
    const sheet = findSheet(name);
    return sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '' }) : [];
  };

  // ① 禽类档案：按品种名称 upsert
  for (const [index, row] of readRows('禽类档案').entries()) {
    const breedName = String(pickCell(row, ['品种名称', '品种', 'breed_name'])).trim();
    if (!breedName) { result.errors.push({ sheet: '禽类档案', row: index + 2, message: '品种名称为空，已跳过' }); continue; }
    const animalRaw = String(pickCell(row, ['禽类(鹅/鸭/鸡)', '禽类', 'animal'])).trim();
    if (animalRaw && !ANIMALS.includes(animalRaw)) {
      // 明确填了非法禽类时不能悄悄改写成鹅，否则会凭空多出一只不存在的禽类档案
      result.errors.push({ sheet: '禽类档案', row: index + 2, message: `禽类「${animalRaw}」不在 鹅/鸭/鸡 之内，已跳过` });
      continue;
    }
    // 禽类列留空时，按品种名里的关键字推断，减少手工填写
    const animal = ANIMALS.includes(animalRaw) ? animalRaw : (/鸭/.test(breedName) ? '鸭' : /鸡/.test(breedName) ? '鸡' : '鹅');
    const netWeight = Number(pickCell(row, ['单只净重(kg)', '单只净重', 'net_weight_kg'])) || 0;
    const unitCost = Number(pickCell(row, ['单只成本(元)', '单只成本', 'unit_cost'])) || 0;
    const status = String(pickCell(row, ['状态', 'status'])).trim() === '停用' ? '停用' : '启用';
    const remark = String(pickCell(row, ['备注', 'remark'])).trim();
    const existing = db.queryOne('SELECT id FROM poultry_birds WHERE breed_name=?', [breedName]);
    if (existing) {
      db.run(`UPDATE poultry_birds SET animal=?, net_weight_kg=?, unit_cost=?, status=?, remark=?,
              updated_at=datetime('now','localtime') WHERE id=?`,
        [animal, netWeight, unitCost, status, remark, existing.id]);
    } else {
      db.insert('INSERT INTO poultry_birds (animal,breed_name,net_weight_kg,unit_cost,status,remark) VALUES (?,?,?,?,?,?)',
        [animal, breedName, netWeight, unitCost, status, remark]);
    }
    result.birds++;
  }

  // ② 整只出成：按（品种, 部位）upsert
  const birdByName = new Map(listBirds().map(row => [row.breed_name, row]));
  for (const [index, row] of readRows('整只出成').entries()) {
    const breedName = String(pickCell(row, ['品种名称', '品种', 'breed_name'])).trim();
    const partName = String(pickCell(row, ['部位名称', '部位', 'part_name'])).trim();
    if (!breedName || !partName) {
      result.errors.push({ sheet: '整只出成', row: index + 2, message: '品种名称或部位名称为空，已跳过' });
      continue;
    }
    const bird = birdByName.get(breedName);
    if (!bird) {
      result.errors.push({ sheet: '整只出成', row: index + 2, message: `品种「${breedName}」不存在，请先在「禽类档案」里建立` });
      continue;
    }
    const perBird = Number(pickCell(row, ['一只出成数量', '一只出成', 'parts_per_bird']));
    if (!Number.isFinite(perBird) || perBird <= 0) {
      result.errors.push({ sheet: '整只出成', row: index + 2, message: `「${breedName}·${partName}」一只出成数量必须大于 0，已跳过` });
      continue;
    }
    const partWeight = Number(pickCell(row, ['单份克重(g)', '单份克重', 'part_weight_g'])) || 0;
    const partKindRaw = String(pickCell(row, ['部位类别', '类别', 'part_kind'])).trim();
    if (partKindRaw && !PART_KINDS.includes(partKindRaw)) {
      result.errors.push({ sheet: '整只出成', row: index + 2, message: `部位类别「${partKindRaw}」只能是 身体 / 副产品，已按部位名自动判断` });
    }
    const partKind = normalizePartKind(partKindRaw, partName);
    const remark = String(pickCell(row, ['备注', 'remark'])).trim();
    const existing = db.queryOne('SELECT id FROM poultry_yields WHERE bird_id=? AND part_name=?', [bird.id, partName]);
    if (existing) {
      db.run(`UPDATE poultry_yields SET parts_per_bird=?, part_weight_g=?, part_kind=?, remark=?,
              updated_at=datetime('now','localtime') WHERE id=?`, [perBird, partWeight, partKind, remark, existing.id]);
    } else {
      db.insert('INSERT INTO poultry_yields (bird_id,part_name,parts_per_bird,part_weight_g,part_kind,remark) VALUES (?,?,?,?,?,?)',
        [bird.id, partName, perBird, partWeight, partKind, remark]);
    }
    result.yields++;
  }

  // ③ 菜品耗用：按（菜品, 规格, 部位）upsert
  const yields = listYields();
  const yieldIndex = new Map(yields.map(row => [`${row.breed_name}|${row.part_name}`, row.id]));
  for (const [index, row] of readRows('菜品耗用').entries()) {
    const menuName = String(pickCell(row, ['菜品名称', '菜品', 'menu_name'])).trim();
    const breedName = String(pickCell(row, ['品种名称', '品种', 'breed_name'])).trim();
    const partName = String(pickCell(row, ['部位名称', '部位', 'part_name'])).trim();
    // 预填的行只有菜名、没填品种部位：属于未配置，安静跳过而不是报错
    if (!menuName) continue;
    if (!breedName && !partName) continue;
    if (!breedName || !partName) {
      result.errors.push({ sheet: '菜品耗用', row: index + 2, message: `「${menuName}」品种名称与部位名称需同时填写，已跳过` });
      continue;
    }
    const menuSpec = normalizeDishSpec(pickCell(row, ['规格', 'spec']));
    const quantity = Number(pickCell(row, ['每份耗用数量', '每份耗用', 'usage_qty']));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      result.errors.push({ sheet: '菜品耗用', row: index + 2, message: `「${menuName}」每份耗用数量必须大于 0，已跳过` });
      continue;
    }
    const yieldId = yieldIndex.get(`${breedName}|${partName}`);
    if (!yieldId) {
      result.errors.push({ sheet: '菜品耗用', row: index + 2, message: `「${breedName}·${partName}」出成关系不存在，请先在「整只出成」里建立` });
      continue;
    }
    let menu = db.queryOne('SELECT id FROM menu_items WHERE name=? AND COALESCE(NULLIF(spec,\'--\'),\'\')=?', [menuName, menuSpec]);
    if (!menu) menu = db.queryOne('SELECT id FROM menu_items WHERE name=?', [menuName]);
    if (!menu) {
      result.errors.push({ sheet: '菜品耗用', row: index + 2, message: `本地菜品「${menuName}${menuSpec ? ' · ' + menuSpec : ''}」不存在，请先在「菜品总览」建档` });
      continue;
    }
    db.run(`INSERT INTO poultry_dish_usage (menu_item_id,yield_id,usage_qty) VALUES (?,?,?)
      ON CONFLICT(menu_item_id, yield_id) DO UPDATE SET usage_qty=excluded.usage_qty, updated_at=datetime('now','localtime')`,
      [menu.id, yieldId, quantity]);
    result.usage++;
  }

  db.save();
  return { ok: true, ...result, error_count: result.errors.length };
}

module.exports = {
  ANIMALS,
  PART_KINDS,
  normalizePartKind,
  normalizeDishSpec,
  purgeOrphanUsage,
  listBirds, createBird, updateBird, deleteBird,
  listYields, saveYields, deleteYield,
  listUsageByMenu, saveUsageForMenu, batchSaveUsage, listUsageOverview, listConfiguredMenus,
  calculate, purchaseComparison,
  listPurchases, savePurchase, deletePurchase,
  buildTemplateWorkbook, importWorkbook,
};
