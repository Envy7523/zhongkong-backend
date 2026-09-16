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
const businessAnalytics = require('./business-analytics');

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

// ==================== 资源约束模型（2026-09-12 升级）====================
// 旧模型：身体类相加 + 副产品取最大 → N = max(身体合计, 最大副产品)
//   缺陷：副产品只「取最大」过于宽松 —— 例如一只鹅 2 只翅，战斧卖 120 份本需 60 只鹅，
//         但当身体需求更大时，翅的约束就被完全忽略。
// 新模型：把一只禽看成若干「资源池」，每池容量固定，各自算需求只数，最终取 MAX：
//   ① 身体（份量）：整只 1 / 半只 1/2 / 上庄 1/4 / 下庄 1/4 / 腿 1/8 / 切片肉 1/N … 相加
//   ② 腿：每只 2 条 —— 下庄（自带 1 条）、腿饭（1 条）、半只（1 条）、整只（2 条）
//   ③ 翅：每只 2 只 —— 上庄（自带 1 只）、战斧（1 只）、半只（1 只）、整只（2 只）
//   ④ 头颈：每只 1 个 —— 头颈菜品、整只（半只不含头颈）
// 用户确认的口径：卖 2 个下庄 + 2 份腿饭 = 消耗 4 条腿 = 2 只鹅
//   （「下庄可拆成鹅肉和鹅腿，但鹅腿不能反推成下庄」→ 腿与下庄共享同一限量资源，需求相加）
const ZONE_CODES = ['whole', 'half', 'upper', 'lower', 'leg', 'wing', 'head_neck', 'belly', 'meat', 'other'];

/** 每个区域「一份该部位的菜」会额外消耗的限量资源件数（身体份量另按 parts_per_bird 折算） */
const ZONE_LIMITED_CONSUME = {
  whole: { leg: 2, wing: 2, head_neck: 1 },  // 整只：含 2 腿 + 2 翅 + 1 头颈
  half: { leg: 1, wing: 1 },                 // 半只：含 1 腿 + 1 翅（**不含头颈**，用户口径）
  upper: { wing: 1 },                        // 上庄自带 1 只翅
  lower: { leg: 1 },                         // 下庄自带 1 条腿
  leg: { leg: 1 },                           // 腿饭：一整条腿
  wing: { wing: 1 },                         // 战斧（大鹅翅）：1 只翅
  head_neck: { head_neck: 1 },
  belly: {},
  meat: {},
  other: {},
};

/** 一只禽各限量资源的容量 */
const RESOURCE_CAPACITY = { leg: 2, wing: 2, head_neck: 1 };
const RESOURCE_LABELS = { body: '身体', leg: '腿', wing: '翅', head_neck: '头颈' };

// 父子资源关系：同一菜品同时配置「父」与「子」部位 = 重复计量
//   （腿已含在下庄里、翅已含在上庄里、整只含全部）
// 例外：确实把腿/翅当"额外加料"的情况 → 只报警不拦截
const ZONE_CHILDREN = {
  whole: ['half', 'upper', 'lower', 'leg', 'wing', 'head_neck', 'belly', 'meat'],
  half: ['upper', 'lower', 'leg', 'wing', 'meat'],   // 半只不含头颈（用户口径）
  upper: ['wing'],
  lower: ['leg'],
  leg: [], wing: [], head_neck: [], belly: [], meat: [], other: [],
};
const ZONE_LABELS = {
  whole: '整只', half: '半只', upper: '上庄', lower: '下庄', leg: '腿',
  wing: '翅', head_neck: '头颈', belly: '腩', meat: '切片肉', other: '其他',
};

/**
 * 检测同一菜品耗用行里的「父子部位同时出现」冲突。
 * @param rows [{ yield_id, usage_qty }]
 * @param yieldZoneById 可选：预先构建的 yieldId → { part_name, zone_code } 映射（核算主流程里复用，避免逐行查库）
 * @returns [{ type, parent, child, message }]
 */
function findUsageConflicts(rows = [], yieldZoneById = null) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const lookup = (yieldId) => {
    const id = Number(yieldId);
    if (yieldZoneById && yieldZoneById.has(id)) {
      const y = yieldZoneById.get(id);
      return { part_name: y.part_name, zone_code: normalizeZoneCode(y.zone_code, y.part_name) };
    }
    const y = db.queryOne('SELECT part_name, zone_code FROM poultry_yields WHERE id=?', [id]);
    return y ? { part_name: y.part_name, zone_code: normalizeZoneCode(y.zone_code, y.part_name) } : null;
  };
  const zones = new Map();   // zone_code → part_name
  for (const row of rows) {
    const hit = lookup(row.yield_id);
    if (hit && !zones.has(hit.zone_code)) zones.set(hit.zone_code, hit.part_name);
  }
  const conflicts = [];
  for (const [zone, partName] of zones.entries()) {
    for (const child of (ZONE_CHILDREN[zone] || [])) {
      if (!zones.has(child)) continue;
      conflicts.push({
        type: 'parent_child_conflict',
        parent: partName, parent_zone: zone,
        child: zones.get(child), child_zone: child,
        message: `同时配置了「${partName}（${ZONE_LABELS[zone]}）」与「${zones.get(child)}（${ZONE_LABELS[child]}）」`
          + ` —— ${ZONE_LABELS[child]}通常已包含在${ZONE_LABELS[zone]}之内，可能重复计量；若是额外加料可忽略`,
      });
    }
  }
  return conflicts;
}

/** 区域代码归一化：优先用库里存的 zone_code（用户可改），缺失时按部位名兜底推断 */
function normalizeZoneCode(zoneCode, partName = '') {
  const raw = String(zoneCode || '').trim();
  if (ZONE_CODES.includes(raw)) return raw;
  const name = String(partName || '').trim();
  if (/头|颈/.test(name)) return 'head_neck';
  if (/翅|战斧/.test(name)) return 'wing';
  if (/上庄/.test(name)) return 'upper';
  if (/下庄/.test(name)) return 'lower';
  if (/腩/.test(name)) return 'belly';
  if (/腿|肶/.test(name)) return 'leg';
  if (/半只/.test(name)) return 'half';
  if (/整只|一只/.test(name)) return 'whole';
  if (/肉|小料|双拼|三宝|片|单份|三拼|拼量/.test(name)) return 'meat';
  return 'other';
}

/**
 * 出成口径模式归一化：把「一只出几份」的语义显性化
 *   fraction 份量型：一只可出 N 份（一份占整只 1/N）—— 上庄 4 / 半只 2 / 整只 1
 *   count    件数型：一只物理产出 N 件 —— 头颈 1 / 翅 2 / 下庄 2
 *   weight   重量型  ：一只可出 N 克（三期做切片肉池时启用）
 * ⚠️ fraction 与 count 的计算公式相同（需求 ÷ N），所以本字段不影响任何现有结果，只把语义说清楚。
 */
const YIELD_MODES = ['fraction', 'count', 'weight'];
function normalizeYieldMode(value, partKind = '', zoneCode = '') {
  const raw = String(value || '').trim();
  if (YIELD_MODES.includes(raw)) return raw;
  if (zoneCode === 'wing' || zoneCode === 'head_neck') return 'count';
  return partKind === '副产品' ? 'count' : 'fraction';
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

/**
 * 清掉指向「已被删除禽类品种」的孤儿消耗行。
 * 背景：与 purgeOrphanUsage 同源（外键未生效）；但消耗行的危害更大 ——
 * listConsumption 原本用 JOIN poultry_birds，孤儿行在列表里直接消失，
 * 于是「删品种」会静默留下一批看不见的消耗只数（曾一次留下 15 条 = 12000 只幽灵采购，
 * 是验证脚本先删品种再回收造成的）。现在两头都堵：删品种时顺带清，列表也改成 LEFT JOIN 暴露。
 */
function purgeOrphanConsumption() {
  const removed = db.run(`DELETE FROM poultry_consumption
    WHERE bird_id NOT IN (SELECT id FROM poultry_birds)`);
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
      (SELECT COUNT(*) FROM poultry_consumption p WHERE p.bird_id=b.id) AS consumption_count
    FROM poultry_birds b
    ORDER BY CASE b.animal WHEN '鹅' THEN 1 WHEN '鸭' THEN 2 WHEN '鸡' THEN 3 ELSE 9 END, b.id
  `).map(row => ({
    ...row,
    net_weight_kg: Number(row.net_weight_kg) || 0,
    unit_cost: Number(row.unit_cost) || 0,
    yield_count: Number(row.yield_count) || 0,
    dish_count: Number(row.dish_count) || 0,
    consumption_count: Number(row.consumption_count) || 0,
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
  // 该品种名下的消耗行随品种一起回收：外键级联不生效，不显式删就会变成看不见的孤儿消耗
  const purgedConsumption = db.run('DELETE FROM poultry_consumption WHERE bird_id=?', [id]) || 0;
  const usage = db.queryOne(`
    SELECT COUNT(*) AS n FROM poultry_dish_usage u
    JOIN poultry_yields y ON y.id=u.yield_id WHERE y.bird_id=?`, [id]).n;
  if (Number(usage) > 0) throw new Error(`该品种已被 ${usage} 条菜品耗用引用，请先解除菜品耗用关系`);
  db.run('DELETE FROM poultry_yields WHERE bird_id=?', [id]);
  db.run('DELETE FROM poultry_birds WHERE id=?', [id]);
  db.save();
  return { ok: true, purged_orphans: purged, purged_consumption: purgedConsumption };
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
    const partKind = normalizePartKind(row?.part_kind, partName);
    const zoneCode = normalizeZoneCode(row?.zone_code, partName);
    return {
      part_name: partName,
      parts_per_bird: perBird,
      part_weight_g: Number.isFinite(partWeight) && partWeight > 0 ? partWeight : 0,
      part_kind: partKind,
      zone_code: zoneCode,
      yield_mode: normalizeYieldMode(row?.yield_mode, partKind, zoneCode),
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
        db.run(`UPDATE poultry_yields SET parts_per_bird=?, part_weight_g=?, part_kind=?, zone_code=?, yield_mode=?, sort_order=?, remark=?,
                updated_at=datetime('now','localtime') WHERE id=?`,
          [row.parts_per_bird, row.part_weight_g, row.part_kind, row.zone_code, row.yield_mode, row.sort_order, row.remark, existing.id]);
      } else {
        db.insert(
          'INSERT INTO poultry_yields (bird_id,part_name,parts_per_bird,part_weight_g,part_kind,zone_code,yield_mode,sort_order,remark) VALUES (?,?,?,?,?,?,?,?,?)',
          [birdId, row.part_name, row.parts_per_bird, row.part_weight_g, row.part_kind, row.zone_code, row.yield_mode, row.sort_order, row.remark]);
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
  // 保存后回报「父子部位同时出现」的疑似重复计量（只提示、不拦截 —— 可能是额外加料）
  return { ok: true, count: prepared.length, warnings: findUsageConflicts(prepared) };
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
  // 按禽类筛选（从「① 禽类档案」点某个禽类的「配置耗用」进来的场景）：
  //   animal=鸡 + filter=set   → 只看已配了鸡类部位的菜
  //   animal=鸡 + filter=unset → 只看还没配鸡类部位的菜（补配置用）
  const animalFilter = String(params.animal || '').trim();

  const all = db.queryAll(`SELECT m.id, m.name, m.spec, m.method, m.category, m.status, m.cost
    FROM menu_items m
    ORDER BY CASE WHEN m.category IS NULL OR m.category='' THEN 1 ELSE 0 END, m.category, m.name, m.spec, m.id`);

  const countByMenu = new Map(db.queryAll(
    'SELECT menu_item_id, COUNT(*) AS n FROM poultry_dish_usage GROUP BY menu_item_id'
  ).map(row => [row.menu_item_id, Number(row.n) || 0]));

  // 每个菜品配了哪些禽类（用于按禽类筛选与展示「鹅+鸡」这类混搭）
  const animalsByMenu = new Map();
  db.queryAll(`SELECT DISTINCT u.menu_item_id, b.animal
    FROM poultry_dish_usage u
    JOIN poultry_yields y ON y.id = u.yield_id
    JOIN poultry_birds b ON b.id = y.bird_id`).forEach(row => {
    const set = animalsByMenu.get(row.menu_item_id) || new Set();
    set.add(row.animal);
    animalsByMenu.set(row.menu_item_id, set);
  });

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
    if (animalFilter) {
      const has = animalsByMenu.get(item.id)?.has(animalFilter);
      if (onlyUnset) { if (has) return false; }
      else if (onlySet) { if (!has) return false; }
      else if (!has) return false;
    }
    if (lowerKeyword && !`${item.name} ${item.category} ${item.spec}`.toLowerCase().includes(lowerKeyword)) return false;
    return true;
  }).map(item => ({
    ...item,
    usage_count: countByMenu.get(item.id) || 0,
    animals: [...(animalsByMenu.get(item.id) || [])],
  }));

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
  // 批量套用同一套部位时最容易出现父子重复（例如同时套了「下庄」和「腿」）—— 回报给前端提示
  return { ok: true, dishes: ids.length, rows: prepared.length, mode, removed, replaced_dishes: replacedDishes,
    warnings: findUsageConflicts(prepared) };
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

// ==================== ③.5 禽类菜范围（覆盖率分母口径，用户可维护）====================
// 为什么需要：覆盖率原本 = 已配系数销量 ÷ 全部销量，分母含柠檬茶 / 白米饭 / 打包盒等
// 永远不需要配禽类系数的品类，所以永远到不了 90%，拿它当风控可信度门槛没有意义。
// 现在拆两个数：① 禽类菜品覆盖率（分母 = 禽类菜销量）② 全量覆盖率（保留作参考）。
// 「哪些菜算禽类菜」不写死在代码里 —— 关键词表 + 显式名单都可在页面维护。

const SCOPE_KINDS = ['include', 'exclude'];
const DEFAULT_SCOPE_INCLUDE = ['鹅', '鸭', '鸡'];

/** 关键词表（含停用项，供页面回显） */
function listScopeKeywords() {
  return db.queryAll('SELECT * FROM poultry_scope_keywords ORDER BY kind, sort_order, id')
    .map(row => ({ ...row, enabled: Number(row.enabled) !== 0 }));
}

/** 生效的判定规则 */
function resolveScopeRules() {
  const rows = listScopeKeywords().filter(row => row.enabled);
  const include = rows.filter(row => row.kind === 'include').map(row => String(row.keyword || '').trim()).filter(Boolean);
  const exclude = rows.filter(row => row.kind === 'exclude').map(row => String(row.keyword || '').trim()).filter(Boolean);
  return {
    include: include.length ? include : DEFAULT_SCOPE_INCLUDE.slice(),
    exclude,
    // 关键词表被清空/全部停用时的回退标记，页面要提示用户
    fallback: !include.length,
  };
}

/** 名称判定：true=算禽类菜 / false=明确不算（命中排除词）/ null=空名（不参与判定） */
function judgePoultryName(name, rules) {
  const text = String(name || '').trim();
  if (!text) return null;
  if (rules.exclude.some(word => text.includes(word))) return false;
  return rules.include.some(word => text.includes(word)) ? true : null;
}

/** 保存关键词表（整表替换，语义与出成保存一致：页面提交什么就是什么） */
function saveScopeKeywords(rows) {
  if (!Array.isArray(rows)) throw new Error('关键词列表格式不正确');
  if (rows.length > 500) throw new Error('关键词最多 500 条');
  const prepared = rows.map((row, index) => {
    const keyword = String(row?.keyword || '').trim();
    if (!keyword) throw new Error(`第 ${index + 1} 行关键词不能为空`);
    const kind = SCOPE_KINDS.includes(String(row?.kind)) ? String(row.kind) : 'include';
    const enabled = (row?.enabled === false || row?.enabled === 0) ? 0 : 1;
    return { keyword, kind, enabled, note: String(row?.note || '').trim(), sort_order: index };
  });
  const seen = new Set();
  prepared.forEach(row => {
    const key = `${row.kind}|${row.keyword}`;
    if (seen.has(key)) throw new Error(`关键词「${row.keyword}」重复，请合并为一条`);
    seen.add(key);
  });
  // 一条 include 都不留会让分母归零，直接在保存时拦住（比事后看到 0% 再排查友好）
  if (!prepared.some(row => row.kind === 'include' && row.enabled)) {
    throw new Error('至少要保留一条启用中的「算作禽类菜」关键词，否则无法判定分母');
  }

  db.exec('BEGIN');
  try {
    db.run('DELETE FROM poultry_scope_keywords');
    for (const row of prepared) {
      db.insert('INSERT INTO poultry_scope_keywords (keyword,kind,enabled,note,sort_order) VALUES (?,?,?,?,?)',
        [row.keyword, row.kind, row.enabled, row.note, row.sort_order]);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.save();
  return { ok: true, count: prepared.length };
}

/** 显式名单（逐个菜品的强制判定，优先级高于关键词） */
function listScopeDishes() {
  return db.queryAll(`
    SELECT s.id, s.menu_item_id, s.in_scope, s.note, m.name AS menu_name, m.category AS menu_category
    FROM poultry_scope_dishes s
    LEFT JOIN menu_items m ON m.id = s.menu_item_id
    ORDER BY s.menu_item_id`).map(row => ({ ...row, in_scope: Number(row.in_scope) !== 0 }));
}

/**
 * 批量标记菜品是否算禽类菜。
 * in_scope: true=强制算 / false=强制不算 / null=清除标记（回退到关键词判定）
 */
function saveScopeDishes(body = {}) {
  const ids = Array.isArray(body.menu_item_ids)
    ? [...new Set(body.menu_item_ids.map(Number).filter(n => Number.isInteger(n) && n > 0))]
    : [];
  if (!ids.length) throw new Error('请先选择菜品');
  if (ids.length > 500) throw new Error('单次最多标记 500 个菜品');
  const exist = db.queryAll(`SELECT id FROM menu_items WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  if (exist.length !== ids.length) throw new Error('存在已删除的菜品，请刷新后重试');

  const raw = body.in_scope;
  const mode = (raw === null || raw === undefined || raw === '') ? 'clear' : (raw ? 'include' : 'exclude');

  db.exec('BEGIN');
  try {
    for (const id of ids) {
      db.run('DELETE FROM poultry_scope_dishes WHERE menu_item_id=?', [id]);
      if (mode !== 'clear') {
        db.insert('INSERT INTO poultry_scope_dishes (menu_item_id,in_scope,note) VALUES (?,?,?)',
          [id, mode === 'include' ? 1 : 0, String(body.note || '').trim()]);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.save();
  return { ok: true, count: ids.length, mode };
}

/**
 * 组装判定器。判定优先级固定如下（配置可改，这个顺序不可改）：
 *   ① 显式名单 in_scope=1  → 算禽类菜
 *   ② 显式名单 in_scope=0  → 不算（用户明确意志，压过关键词与已配状态）
 *   ③ 已配禽类耗用          → 算（它确实在消耗禽类；否则覆盖率分子可能大于分母）
 *   ④ 名称命中 include 关键词且不含 exclude 关键词 → 算
 *      档案名与报表名任一命中即可；任一名命中排除词则否掉（咸鸭蛋即便档案名不同也不算）
 *   ⑤ 其余 → 不算
 */
function buildScopeJudge(options = {}) {
  const rules = resolveScopeRules();
  const scopeRows = listScopeDishes();
  const forced = new Set(scopeRows.filter(row => row.in_scope).map(row => Number(row.menu_item_id)));
  const blocked = new Set(scopeRows.filter(row => !row.in_scope).map(row => Number(row.menu_item_id)));
  const configuredIds = options.configuredIds || new Set();
  const menuById = options.menuById || new Map();

  function judge({ menuItemId, productName }) {
    const id = menuItemId ? Number(menuItemId) : null;
    if (id && forced.has(id)) return { in_scope: true, reason: 'manual' };
    if (id && blocked.has(id)) return { in_scope: false, reason: 'manual_exclude' };
    if (id && configuredIds.has(id)) return { in_scope: true, reason: 'configured' };
    const menu = id ? menuById.get(id) : null;
    const menuHit = judgePoultryName(menu ? menu.name : '', rules);
    const salesHit = judgePoultryName(productName, rules);
    if (menuHit === false || salesHit === false) return { in_scope: false, reason: 'keyword_excluded' };
    if (menuHit === true || salesHit === true) return { in_scope: true, reason: 'keyword' };
    return { in_scope: false, reason: 'not_matched' };
  }

  return { rules, judge, forced, blocked };
}

/**
 * 规则预览：不依赖时间段，用「全部菜品 + 全区间销量」展示当前规则会把哪些菜算成禽类菜，
 * 让用户改完关键词立刻看到效果（核算主流程仍由 calculate 用同一条判定器计算）。
 * 销量按菜品名匹配（不做三级兜底），仅用于核对规则，返回 matched_by 标注口径。
 */
function scopePreview() {
  const rules = resolveScopeRules();
  const menuItems = db.queryAll('SELECT id,name,category FROM menu_items ORDER BY id');
  const menuById = new Map(menuItems.map(row => [row.id, row]));
  const configuredIds = new Set(db.queryAll('SELECT DISTINCT menu_item_id FROM poultry_dish_usage')
    .map(row => Number(row.menu_item_id)).filter(id => menuById.has(id)));
  const { judge } = buildScopeJudge({ configuredIds, menuById });

  const salesRows = db.queryAll(`
    SELECT product_name, SUM(quantity) AS quantity
    FROM dish_sales
    WHERE COALESCE(refunded,'') NOT IN ('部分退','是','1')
    GROUP BY product_name`);
  const salesByName = new Map(salesRows.map(row => [String(row.product_name || '').trim(), Number(row.quantity) || 0]));

  const dishes = menuItems.map(item => {
    const verdict = judge({ menuItemId: item.id, productName: item.name });
    return {
      menu_item_id: item.id,
      menu_name: item.name,
      category: item.category || '',
      configured: configuredIds.has(item.id),
      in_scope: verdict.in_scope,
      reason: verdict.reason,
      quantity: round2(salesByName.get(String(item.name || '').trim()) || 0),
    };
  });

  const reasonLabels = {
    manual: '手动标记为禽类菜',
    manual_exclude: '手动标记为不算',
    configured: '已配禽类耗用（自动计入）',
    keyword: '名称命中关键词',
    keyword_excluded: '命中排除词',
    not_matched: '名称未命中',
  };
  dishes.forEach(row => { row.reason_label = reasonLabels[row.reason] || row.reason; });
  dishes.sort((a, b) => (b.in_scope - a.in_scope) || (b.quantity - a.quantity));

  const inScope = dishes.filter(row => row.in_scope);
  return {
    ok: true,
    rules: { ...rules, kinds: SCOPE_KINDS },
    summary: {
      dish_total: dishes.length,
      scope_dish_count: inScope.length,
      scope_quantity: round2(inScope.reduce((sum, row) => sum + row.quantity, 0)),
      sales_quantity: round2(dishes.reduce((sum, row) => sum + row.quantity, 0)),
      scope_source: {
        manual: dishes.filter(row => row.reason === 'manual').length,
        configured: dishes.filter(row => row.reason === 'configured').length,
        keyword: dishes.filter(row => row.reason === 'keyword').length,
        excluded: dishes.filter(row => row.reason === 'keyword_excluded').length,
      },
    },
    dishes,
  };
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

/**
 * 菜品核算与「总数据 → 菜品销售分析」共用同一份销量口径：
 *   - POS 品项明细开始日之前取 dish_sales；开始日及之后取 POS 明细，避免重叠翻倍；
 *   - 先由总数据模块完成本地 SKU 识别，再把可精确定位 SKU 的来源行交给禽类模型。
 *
 * 这里刻意不重新写一遍两张表的 SQL。两处销量口径一旦分叉，采购反推就会再次出现
 * “总数据是 7 份、核算却是 14 份”这种无法解释的结果。
 */
function getUnifiedAccountingSales(params = {}) {
  const analytics = businessAnalytics.getMergedDishSalesAnalytics(db, {
    store_id: params.store_id || '',
    store_ids: params.store_ids || '',
    date_from: params.date_from || '',
    date_to: params.date_to || '',
  });

  const rows = [];
  const add = (source, extra = {}) => {
    const label = String(source.platform || extra.platform || '其他/未分类');
    rows.push({
      product_code: (source.platform_product_codes || [source.product_code || ''])[0] || '',
      product_name: String(source.platform_product_name || source.product_name || '').trim(),
      spec: String(source.spec || '').trim(),
      menu_item_id: Number(source.menu_item_id || extra.menu_item_id) || null,
      channel: label,
      quantity: Number(source.quantity) || 0,
      income_amount: Number(source.income_amount) || 0,
      order_count: Number(source.order_count) || 0,
    });
  };

  // 已识别的标准菜：sources 保留了平台原名、规格及精确 menu_item_id。
  (analytics.dishes || []).forEach(dish => (dish.sources || []).forEach(source => add(source, dish)));
  // 未绑定但名称命中禽类范围的菜必须仍出现在缺口里，不能静默丢弃。
  (analytics.unbound || []).forEach(item => (item.sources || []).forEach(source => add(source, item)));

  const labels = new Map();
  for (const row of rows) labels.set(row.channel, (labels.get(row.channel) || 0) + row.quantity);
  return {
    rows,
    channel_breakdown: [...labels.entries()].map(([label, quantity]) => ({
      channel: classifyAccountingChannel(label), label, quantity: round2(quantity), rows: 0,
    })).sort((a, b) => b.quantity - a.quantity),
    source_note: analytics.source_note || '',
    pos_from: analytics.summary?.pos_from || '',
  };
}

/** 将精确平台标签归并为页面上的堂食 / 团购 / 外卖 / 其他筛选。 */
function classifyAccountingChannel(label) {
  const text = String(label || '');
  if (text.includes('团购')) return 'group';
  if (/外卖|闪购|饿了么/.test(text)) return 'delivery';
  if (/店内|自提|扫码|小程序|堂食/.test(text)) return 'dine_in';
  return 'other';
}

function calculate(params = {}) {
  const dateFrom = String(params.date_from || '').trim();
  const dateTo = String(params.date_to || '').trim();
  const channel = ['all', 'dine_in', 'group', 'delivery', 'other'].includes(String(params.channel)) ? String(params.channel) : 'all';
  const animalFilter = String(params.animal || '').trim();

  const { ids: storeIds } = resolveStoreNames(params);
  const unified = getUnifiedAccountingSales(params);
  // 只在统一来源行上做渠道筛选，避免 POS 与旧表各自按不同关键词解释“外卖/团购”。
  const salesRows = unified.rows
    .filter(row => channel === 'all' || classifyAccountingChannel(row.channel) === channel)
    .filter(row => Math.abs(Number(row.quantity) || 0) > 0)
    .sort((a, b) => Number(b.quantity) - Number(a.quantity));
  const totalQuantity = salesRows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const channelBreakdown = unified.channel_breakdown
    .filter(row => channel === 'all' || row.channel === channel);
  const dataRange = db.queryOne(`
    SELECT MIN(day) AS min_date, MAX(day) AS max_date FROM (
      SELECT substr(order_time,1,10) AS day FROM dish_sales
      UNION ALL
      SELECT biz_date AS day FROM pos_product_sale_details
    ) WHERE COALESCE(day,'')<>''
  `) || {};

  const scopeRulesNow = resolveScopeRules();
  const emptyScopeBlock = {
    covered_rate: 0, covered_quantity: 0, scope_quantity: 0, uncovered_quantity: 0,
    unbound_quantity: 0, no_usage_quantity: 0,
    include_keywords: scopeRulesNow.include, exclude_keywords: scopeRulesNow.exclude, fallback: scopeRulesNow.fallback,
    source_summary: { manual: 0, configured: 0, keyword: 0, excluded: 0 },
    unbound: [], no_usage: [], dishes: [],
  };

  const emptyResult = (extra = {}) => ({
    ok: true,
    stores: storeIds.length ? db.queryAll(`SELECT id, store_name FROM stores WHERE id IN (${storeIds.map(() => '?').join(',')})`, storeIds) : [],
    period: { date_from: dateFrom, date_to: dateTo, channel },
    source: 'dish_sales + pos_product_sale_details',
    source_note: unified.source_note,
    data_range: { min_date: dataRange.min_date || '', max_date: dataRange.max_date || '' },
    summary: {
      total_quantity: 0, covered_quantity: 0, covered_rate: 0,
      poultry_covered_quantity: 0, poultry_scope_quantity: 0, poultry_uncovered_quantity: 0, poultry_covered_rate: 0,
      birds: [], parts: [], total_birds: 0, total_birds_linear: 0, total_weight_kg: 0, total_cost: 0,
    },
    dishes: [], parts: [],
    coverage: {
      unbound: [], no_usage: [], warnings: [], unbound_quantity: 0, no_usage_quantity: 0,
      poultry_scope: emptyScopeBlock,
    },
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
  // 父子部位冲突检测用的预建映射（避免逐行查库）
  const yieldZoneById = new Map(yields.map(row => [Number(row.id), { part_name: row.part_name, zone_code: row.zone_code }]));
  const conflictCache = new Map();   // menuItemId → conflicts[]（同一菜品多行销量只检测一次）

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

  // 禽类菜范围判定 —— 覆盖率分母口径（详见 §9.1 与交接文档）
  // 分母只算「禽类菜」销量，把柠檬茶 / 白米饭 / 打包盒这类永远不用配系数的品类排除在外，
  // 否则覆盖率永远到不了 90%，没法当风控可信度门槛。
  const configuredIds = new Set([...usageByMenu.keys()].filter(id => menuById.has(id)));
  const scopeJudge = buildScopeJudge({ configuredIds, menuById });
  let poultryScopeQuantity = 0;       // 禽类菜销量（分母）
  let poultryCoveredQuantity = 0;     // 其中已配系数销量（分子）
  let poultryUncoveredQuantity = 0;   // 其中未覆盖销量
  const poultryUnbound = [];          // 禽类菜范围内、但没匹配到本地菜品
  const poultryNoUsageMap = new Map(); // 禽类菜范围内、已匹配但没配系数（按菜品聚合）
  const scopeMenuQuantity = new Map(); // menu_item_id → 当期匹配销量（菜品级下钻用）
  const scopeReasonCount = { manual: 0, configured: 0, keyword: 0, excluded: 0 };

  for (const row of salesRows) {
    const quantity = Number(row.quantity) || 0;
    const spec = normalizeDishSpec(row.spec);
    const productName = String(row.product_name || '').trim();

    // 三级匹配：① 绑定表 → ② 名称+规格直配 → ③ 名称唯一命中 → ④ 计入未覆盖
    // 报表里存在菜品名为空的行（赠品/杂项），空名不能参与任何名称匹配，否则会误挂到同名档案上。
    // 统一销量模块已能给出精确本地 SKU 时直接采用；历史 dish_sales 仍保留原来的三级兜底，
    // 这样新导入 POS 数据和旧期间数据均能落到同一套禽类耗用配置。
    let menuItemId = Number(row.menu_item_id) || mappingByKey.get(`${row.product_code}|${row.product_name}|${spec}`) || null;
    // 历史遗留的孤儿绑定（dish_sales_mappings 指向已被删除的菜品）不能算「已绑定」，
    // 否则缺口清单里会出现没有菜品名、也无法去配置的空行；这里退回名称兜底，兜不住就按未绑定报出。
    if (menuItemId && !menuById.has(menuItemId)) menuItemId = null;
    if (!menuItemId && productName) menuItemId = menuByKey.get(`${productName}|${spec}`) || null;
    if (!menuItemId && productName) {
      const sameName = menuByName.get(productName) || [];
      if (sameName.length === 1) menuItemId = sameName[0].id;
    }

    // 禽类菜范围判定：必须放在 menuItemId 解析之后 —— 判定要看档案名与「已配禽类耗用」状态
    const scopeVerdict = scopeJudge.judge({ menuItemId, productName });
    if (menuItemId) scopeMenuQuantity.set(menuItemId, (scopeMenuQuantity.get(menuItemId) || 0) + quantity);
    if (scopeVerdict.in_scope) {
      poultryScopeQuantity += quantity;
      if (scopeVerdict.reason === 'manual') scopeReasonCount.manual += 1;
      else if (scopeVerdict.reason === 'configured') scopeReasonCount.configured += 1;
      else scopeReasonCount.keyword += 1;
    } else if (scopeVerdict.reason === 'keyword_excluded') {
      scopeReasonCount.excluded += 1;
    }

    if (!menuItemId) {
      unbound.push({
        product_code: row.product_code, product_name: productName, spec,
        quantity: round2(quantity), income_amount: round2(row.income_amount),
      });
      // 禽类菜范围内却没匹配到本地菜品的，单独记一份 —— 这才是「该去绑定」的真实缺口
      if (scopeVerdict.in_scope) {
        poultryUncoveredQuantity += quantity;
        poultryUnbound.push({
          product_code: row.product_code, product_name: productName, spec,
          quantity: round2(quantity), income_amount: round2(row.income_amount),
          reason: scopeVerdict.reason,
        });
      }
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
      // 禽类菜范围内「已绑定但没配出成」的销量 —— 进禽类覆盖率分母，同时计入未覆盖
      if (scopeVerdict.in_scope) {
        poultryUncoveredQuantity += quantity;
        const pending = poultryNoUsageMap.get(key);
        if (pending) {
          pending.quantity = round2(pending.quantity + quantity);
          pending.income_amount = round2(pending.income_amount + (Number(row.income_amount) || 0));
          pending.sales_group_count += 1;
          if (row.product_name && !pending.product_names.includes(row.product_name)) pending.product_names.push(row.product_name);
        } else {
          poultryNoUsageMap.set(key, {
            menu_item_id: menuItemId,
            menu_name: menu ? menu.name : '',
            menu_spec: menu ? normalizeDishSpec(menu.spec) : '',
            category: menu ? menu.category : '',
            product_name: productName, spec,
            product_names: productName ? [productName] : [],
            quantity: round2(quantity), income_amount: round2(row.income_amount),
            sales_group_count: 1,
            reason: scopeVerdict.reason,
          });
        }
      }
      continue;
    }

    coveredQuantity += quantity;
    // 已配禽类耗用的菜按定义就属于禽类菜，所以它同时进分子与分母（覆盖率不会超过 100%）
    if (scopeVerdict.in_scope) poultryCoveredQuantity += quantity;
    const menu = menuById.get(menuItemId);
    // 父子部位重复计量检测（腿含在下庄里、翅含在上庄里）：只报警不拦截 —— 确实存在"额外加料"的合法场景
    let conflicts = conflictCache.get(menuItemId);
    if (conflicts === undefined) {
      conflicts = findUsageConflicts(usages, yieldZoneById);
      conflictCache.set(menuItemId, conflicts);
    }
    for (const conflict of conflicts) {
      warnings.push({
        ...conflict,
        menu_name: menu ? menu.name : '',
        menu_spec: menu ? normalizeDishSpec(menu.spec) : '',
      });
    }
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
      const zoneCode = normalizeZoneCode(yieldRow.zone_code, yieldRow.part_name);
      const limitedPerPortion = ZONE_LIMITED_CONSUME[zoneCode] || {};
      const partKey = `${bird.id}|${yieldRow.id}`;
      const partBucket = partTotals.get(partKey) || {
        bird_id: bird.id, yield_id: yieldRow.id,
        part_name: yieldRow.part_name, part_kind: partKind, zone_code: zoneCode,
        parts_per_bird: yieldRow.parts_per_bird, part_weight_g: yieldRow.part_weight_g,
        demand: 0, linear_birds: 0, dish_count: 0, limited: {},
      };
      partBucket.demand += consumedParts;
      partBucket.linear_birds += linearBirds;
      partBucket.dish_count += 1;
      // 限量资源（腿/翅/头颈）按件数累加：该部位每份菜消耗几件
      for (const [resource, perPortion] of Object.entries(limitedPerPortion)) {
        partBucket.limited[resource] = (partBucket.limited[resource] || 0) + consumedParts * perPortion;
      }
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

  // ===== 资源约束模型 =====
  // 每个部位先算自己的「折鸟数」和「对限量资源的件数消耗」，再按禽汇总成若干资源池约束，取 MAX 作为只数。
  const parts = [...partTotals.values()].map(p => {
    const birds = p.parts_per_bird > 0 ? p.demand / p.parts_per_bird : 0;
    const bird = birdById.get(p.bird_id);
    const isByproduct = p.part_kind === '副产品';
    return {
      yield_id: p.yield_id,
      bird_id: p.bird_id,
      animal: bird ? bird.animal : '',
      breed_name: bird ? bird.breed_name : '',
      part_name: p.part_name,
      part_kind: p.part_kind,
      zone_code: p.zone_code || normalizeZoneCode('', p.part_name),
      parts_per_bird: round4(p.parts_per_bird),
      part_weight_g: p.part_weight_g,
      demand: round2(p.demand),
      // 该部位自身的折鸟数（= 总需求 ÷ 一只出成）—— 保持原义，明细与风控对账仍用它
      birds: round2(birds),
      linear_birds: round2(p.linear_birds),
      dish_count: p.dish_count,
      is_byproduct: isByproduct,
      // 对「身体」资源的贡献：副产品（翅 / 头颈）随鸟附带、不占身体份量 → 记 0
      body_birds: isByproduct ? 0 : round2(birds),
      // 对限量资源（腿 / 翅 / 头颈）的件数消耗
      limited: { ...(p.limited || {}) },
    };
  }).sort((a, b) => b.birds - a.birds);

  const perBird = new Map();     // bird_id → { body, resources, parts[] }
  for (const p of parts) {
    const bucket = perBird.get(p.bird_id) || { body: 0, resources: {}, parts: [] };
    bucket.body += p.body_birds;
    bucket.parts.push(p);
    for (const [resource, count] of Object.entries(p.limited)) {
      bucket.resources[resource] = (bucket.resources[resource] || 0) + count;
    }
    perBird.set(p.bird_id, bucket);
  }
  // 每只禽：各资源池分别算需求只数，取最大者作为总只数（瓶颈就是那个资源池）
  const governingPartId = new Map();
  for (const [birdId, bucket] of perBird.entries()) {
    const constraints = { body: bucket.body };
    for (const [resource, capacity] of Object.entries(RESOURCE_CAPACITY)) {
      constraints[resource] = capacity > 0 ? (bucket.resources[resource] || 0) / capacity : 0;
    }
    bucket.constraints = constraints;
    const ranked = Object.entries(constraints).sort((a, b) => b[1] - a[1]);
    const [governingResource, governingBirds] = ranked[0] || ['body', 0];
    bucket.governingResource = governingResource;
    bucket.governingBirds = governingBirds;
    bucket.ranked = ranked;
    // 瓶颈部位 = 该资源池下贡献最大的那个部位
    const governingPart = governingResource === 'body'
      ? (bucket.parts.filter(p => !p.is_byproduct).sort((a, b) => b.body_birds - a.body_birds)[0] || null)
      : (bucket.parts.filter(p => (p.limited[governingResource] || 0) > 0)
          .sort((a, b) => (b.limited[governingResource] || 0) - (a.limited[governingResource] || 0))[0] || null);
    bucket.governingPart = governingPart;
    if (governingPart) governingPartId.set(birdId, governingPart.yield_id);
  }
  parts.forEach(p => { p.is_bottleneck = governingPartId.get(p.bird_id) === p.yield_id; });

  const summaryBirds = [...perBird.entries()].map(([birdId, bucket]) => {
    const bird = birdById.get(birdId);
    const constraints = bucket.constraints || { body: bucket.body };
    const governingResource = bucket.governingResource || 'body';
    const birdsCount = round2(bucket.governingBirds || 0);
    // 旧口径参考值：按「每个菜品各自买一只鸟」线性相加（只高不低，用于对照）
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
    const byproductParts = bucket.parts.filter(p => p.is_byproduct);
    const byproductChecks = byproductParts.slice().sort((a, b) => b.birds - a.birds).map(p => {
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
      // 各资源池的约束只数（取最大者即总只数，瓶颈就是那个资源池）
      constraint_birds: {
        body: round2(constraints.body || 0),
        leg: round2(constraints.leg || 0),
        wing: round2(constraints.wing || 0),
        head_neck: round2(constraints.head_neck || 0),
      },
      resource_demand: {
        leg: round2(bucket.resources.leg || 0),
        wing: round2(bucket.resources.wing || 0),
        head_neck: round2(bucket.resources.head_neck || 0),
      },
      governing_resource: governingResource,
      governing_resource_label: RESOURCE_LABELS[governingResource] || governingResource,
      governing: RESOURCE_LABELS[governingResource] || governingResource,
      governing_part: bucket.governingPart ? bucket.governingPart.part_name : '',
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

  // 禽类菜口径（菜品级明细，供页面核对「当前规则把哪些菜算成了禽类菜」）
  const scopeReasonLabels = {
    manual: '手动标记为禽类菜',
    manual_exclude: '手动标记为不算',
    configured: '已配禽类耗用（自动计入）',
    keyword: '名称命中关键词',
    keyword_excluded: '命中排除词',
    not_matched: '名称未命中',
  };
  const scopeDishes = [...scopeMenuQuantity.entries()].map(([id, qty]) => {
    const menu = menuById.get(id);
    const verdict = scopeJudge.judge({ menuItemId: id, productName: menu ? menu.name : '' });
    return {
      menu_item_id: id,
      menu_name: menu ? menu.name : '',
      menu_spec: menu ? normalizeDishSpec(menu.spec) : '',
      category: menu ? menu.category : '',
      quantity: round2(qty),
      in_scope: verdict.in_scope,
      reason: verdict.reason,
      reason_label: scopeReasonLabels[verdict.reason] || verdict.reason,
      configured: configuredIds.has(id),
    };
  }).sort((a, b) => (b.in_scope - a.in_scope) || (b.quantity - a.quantity));
  poultryUnbound.sort((a, b) => b.quantity - a.quantity);
  const poultryNoUsage = [...poultryNoUsageMap.values()].sort((a, b) => b.quantity - a.quantity);
  const poultryCoveredRate = poultryScopeQuantity > 0 ? round4(poultryCoveredQuantity / poultryScopeQuantity) : 0;

  return {
    ok: true,
    stores: storeIds.length
      ? db.queryAll(`SELECT id, store_name FROM stores WHERE id IN (${storeIds.map(() => '?').join(',')})`, storeIds)
      : [],
    period: { date_from: dateFrom, date_to: dateTo, channel },
    source: 'dish_sales + pos_product_sale_details',
    source_note: unified.source_note,
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
      // 两个覆盖率口径（详见交接文档 §9.1）：
      //   ① poultry_covered_rate 禽类菜品覆盖率 —— 分母只算禽类菜，风控可信度看这个
      //   ② covered_rate 全量覆盖率 —— 分母含饮品/主食/包材，永远偏低，保留作参考
      poultry_covered_quantity: round2(poultryCoveredQuantity),
      poultry_scope_quantity: round2(poultryScopeQuantity),
      poultry_uncovered_quantity: round2(poultryUncoveredQuantity),
      poultry_covered_rate: poultryCoveredRate,
      poultry_scope_dish_count: scopeDishes.filter(row => row.in_scope).length,
      poultry_scope_rules: {
        include: scopeJudge.rules.include,
        exclude: scopeJudge.rules.exclude,
        fallback: scopeJudge.rules.fallback,
      },
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
      // 禽类菜口径的完整下钻数据：规则、来源构成、菜品级判定、以及真正的禽类缺口清单
      poultry_scope: {
        covered_rate: poultryCoveredRate,
        covered_quantity: round2(poultryCoveredQuantity),
        scope_quantity: round2(poultryScopeQuantity),
        uncovered_quantity: round2(poultryUncoveredQuantity),
        include_keywords: scopeJudge.rules.include,
        exclude_keywords: scopeJudge.rules.exclude,
        fallback: scopeJudge.rules.fallback,
        source_summary: { ...scopeReasonCount },
        // 缺口构成按份数拆分：未绑定 = 报表菜名没关联到本地菜品；已绑未配 = 关联了但没配部位系数
        unbound_quantity: round2(poultryUnbound.reduce((sum, row) => sum + row.quantity, 0)),
        no_usage_quantity: round2(poultryNoUsage.reduce((sum, row) => sum + row.quantity, 0)),
        dishes: scopeDishes,
        unbound: poultryUnbound,
        no_usage: poultryNoUsage,
      },
    },
    channel_breakdown: channelBreakdown,
  };
}

// ==================== ⑤ 实际消耗只数 ====================

function listConsumption(params = {}) {
  const date = String(params.date || '').trim();
  const dateFrom = String(params.date_from || '').trim();
  const dateTo = String(params.date_to || '').trim();
  const storeId = Number(params.store_id) || 0;
  // LEFT JOIN + is_orphan：品种被删后残留的消耗行必须「看得见」，否则会静默虚增只数（也清不掉）
  let sql = `SELECT p.*, b.animal, b.breed_name,
      CASE WHEN b.id IS NULL THEN 1 ELSE 0 END AS is_orphan,
      COALESCE(NULLIF(p.store_name,''), s.store_name, '') AS resolved_store_name
    FROM poultry_consumption p
    LEFT JOIN poultry_birds b ON b.id=p.bird_id
    LEFT JOIN stores s ON s.id=p.store_id
    WHERE 1=1`;
  const args = [];
  if (date) { sql += ' AND p.date=?'; args.push(date); }
  if (dateFrom) { sql += ' AND p.date>=?'; args.push(dateFrom); }
  if (dateTo) { sql += ' AND p.date<=?'; args.push(dateTo); }
  if (storeId) { sql += ' AND p.store_id=?'; args.push(storeId); }
  sql += ' ORDER BY p.date DESC, s.store_name, b.id';
  return db.queryAll(sql, args).map(row => ({
    ...row,
    quantity: Number(row.quantity) || 0,
  }));
}

function saveConsumption(body = {}) {
  const storeId = Number(body.store_id);
  if (!Number.isInteger(storeId) || storeId <= 0) throw new Error('请选择门店');
  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
  const birdId = Number(body.bird_id);
  if (!Number.isInteger(birdId) || birdId <= 0) throw new Error('请选择禽类品种');
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error('消耗只数不能为负');
  const store = db.queryOne('SELECT id, store_name FROM stores WHERE id=?', [storeId]);
  if (!store) throw new Error('门店不存在');
  const bird = db.queryOne('SELECT id FROM poultry_birds WHERE id=?', [birdId]);
  if (!bird) throw new Error('禽类品种不存在');

  const existing = db.queryOne('SELECT id FROM poultry_consumption WHERE store_id=? AND date=? AND bird_id=?', [storeId, date, birdId]);
  if (existing) {
    db.run(`UPDATE poultry_consumption SET quantity=?, remark=?, store_name=?,
            updated_at=datetime('now','localtime') WHERE id=?`,
      [quantity, String(body.remark || '').trim(), store.store_name, existing.id]);
  } else {
    db.insert(
      'INSERT INTO poultry_consumption (store_id,store_name,date,bird_id,quantity,remark) VALUES (?,?,?,?,?,?)',
      [storeId, store.store_name, date, birdId, quantity, String(body.remark || '').trim()]);
  }
  db.save();
  return { ok: true };
}

function deleteConsumption(id) {
  const row = db.queryOne('SELECT id FROM poultry_consumption WHERE id=?', [id]);
  if (!row) throw new Error('消耗记录不存在');
  db.run('DELETE FROM poultry_consumption WHERE id=?', [id]);
  db.save();
  return { ok: true };
}

/**
 * 理论用量 vs 实际消耗对比。
 * 消耗按天录入，这里直接按核算区间的起止日期求和，与理论口径完全对齐；
 * months 仅用于面板标题展示覆盖到的月份。
 */
function consumptionComparison(params = {}) {
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

  const { names: storeNames } = resolveStoreNames(params);
  // 消耗只数按天存（date = 'YYYY-MM-DD'），直接夹在起止日期之间求和
  let sql = `SELECT p.bird_id, SUM(p.quantity) AS quantity
    FROM poultry_consumption p WHERE p.date BETWEEN ? AND ?`;
  const args = [dateFrom, dateTo];
  if (storeNames.length) {
    sql += ` AND (p.store_id IN (SELECT id FROM stores WHERE store_name IN (${storeNames.map(() => '?').join(',')})))`;
    args.push(...storeNames);
  }
  sql += ' GROUP BY p.bird_id';
  const consumptionRows = db.queryAll(sql, args);
  const consumptionByBird = new Map(consumptionRows.map(row => [row.bird_id, row]));

  const birds = listBirds();
  const comparison = birds.map(bird => {
    const theoretical = (calc.summary.birds || []).find(row => row.bird_id === bird.id);
    const consumed = consumptionByBird.get(bird.id);
    const theoreticalBirds = theoretical ? theoretical.birds_count : 0;
    const consumedBirds = consumed ? round2(consumed.quantity) : 0;
    return {
      bird_id: bird.id,
      animal: bird.animal,
      breed_name: bird.breed_name,
      theoretical_birds: theoreticalBirds,
      theoretical_cost: theoretical ? theoretical.cost : 0,
      consumed_birds: consumedBirds,
      diff_birds: round2(theoreticalBirds - consumedBirds),
      diff_rate: consumedBirds > 0 ? round4((theoreticalBirds - consumedBirds) / consumedBirds) : null,
      has_consumption: !!consumed,
      consumption_count: Number(bird.consumption_count) || 0,
    };
  }).filter(row => row.theoretical_birds > 0 || row.has_consumption);

  return {
    ok: true,
    months,
    is_whole_month: true, // 按天录入后求和与区间完全对齐；保留字段避免破坏既有消费方
    period: calc.period,
    comparison,
    totals: {
      theoretical_birds: round2(comparison.reduce((sum, row) => sum + row.theoretical_birds, 0)),
      consumed_birds: round2(comparison.reduce((sum, row) => sum + row.consumed_birds, 0)),
      theoretical_cost: round2(comparison.reduce((sum, row) => sum + row.theoretical_cost, 0)),
    },
  };
}

// ==================== ⑥ Excel 模板与导入 ====================

/**
 * 消耗校准：把「模型理论只数」与「门店录入的实际消耗只数」按月对比，算偏差与 MAPE。
 *
 * 为什么需要它：评价参数好坏不该靠「腿占下庄 15%~80%」这类经验阈值，而该看
 * **历史数据拟合**——改完系数后如果滚动 MAPE 从 7.8% 降到 2.6%，才算真的改善。
 * 数据来源：`poultry_consumption`（门店实际消耗只数，手动录入，UNIQUE(store_id, date, bird_id)）。
 * 消耗按天录入，但校准样本仍以「门店 × 月份 × 禽类」为单位：把每日 SUM 起来再与当月理论量比。
 *
 * ⚠️ 每条都要跑一次完整核算（重查销量聚合），所以限制组合数避免接口变慢。
 */
function calibrationReport(params = {}) {
  const limit = Math.min(60, Math.max(1, Number(params.limit) || 12));
  const storeFilter = Number(params.store_id) || 0;
  const where = [];
  const args = [];
  if (storeFilter) { where.push('p.store_id = ?'); args.push(storeFilter); }
  // 消耗按天录入，校准样本以「门店 × 月份 × 禽类」聚合：每日 SUM 后再与当月理论量比
  const consumption = db.queryAll(`
    SELECT p.store_id, MAX(p.store_name) AS store_name, p.bird_id,
           substr(p.date, 1, 7) AS month,
           SUM(p.quantity) AS quantity,
           MAX(b.animal) AS animal, MAX(b.breed_name) AS breed_name
    FROM poultry_consumption p
    LEFT JOIN poultry_birds b ON b.id = p.bird_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY p.store_id, substr(p.date, 1, 7), p.bird_id
    HAVING SUM(p.quantity) > 0
    ORDER BY month DESC, p.store_id
    LIMIT ?`, [...args, limit]);

  const rows = [];
  let skippedInvalid = 0;
  for (const p of consumption) {
    const month = String(p.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) { skippedInvalid += 1; continue; }
    // 孤儿记录（bird 已被删 → animal 为空）不参与校准：它们无法对应任何禽类，只会污染 MAPE
    if (!p.animal) { skippedInvalid += 1; continue; }
    const storeName = p.store_name || (db.queryOne('SELECT store_name FROM stores WHERE id=?', [p.store_id]) || {}).store_name || `门店#${p.store_id}`;
    let theoryBirds = 0;
    let governing = '';
    try {
      // 该月区间：用 YYYY-MM-01 ~ YYYY-MM-31（字符串比较，31 足以覆盖任意月份）
      const theory = calculate({ store_id: p.store_id, date_from: `${month}-01`, date_to: `${month}-31`, animal: p.animal });
      const birdRow = (theory.summary.birds || []).find(b => b.animal === p.animal) || null;
      theoryBirds = birdRow ? birdRow.birds_count : 0;
      governing = birdRow ? `${birdRow.governing_resource_label || birdRow.governing || ''}·${birdRow.governing_part || ''}` : '';
    } catch {
      theoryBirds = 0;
    }
    const actual = Number(p.quantity) || 0;
    const deviation = actual > 0 ? (theoryBirds - actual) / actual : 0;
    rows.push({
      month,
      store_id: p.store_id,
      store_name: storeName,
      animal: p.animal || '',
      breed_name: p.breed_name || '',
      theory_birds: round2(theoryBirds),
      actual_birds: round2(actual),
      gap: round2(theoryBirds - actual),
      deviation: round4(deviation),
      governing,
    });
  }

  const valid = rows.filter(r => r.actual_birds > 0);
  const mape = valid.length ? round4(valid.reduce((sum, r) => sum + Math.abs(r.deviation), 0) / valid.length) : 0;
  const avgDeviation = valid.length ? round4(valid.reduce((sum, r) => sum + r.deviation, 0) / valid.length) : 0;
  const sortedAbs = valid.map(r => Math.abs(r.deviation)).sort((a, b) => a - b);
  const medianAbs = sortedAbs.length
    ? (sortedAbs.length % 2 ? sortedAbs[(sortedAbs.length - 1) / 2] : (sortedAbs[sortedAbs.length / 2 - 1] + sortedAbs[sortedAbs.length / 2]) / 2)
    : 0;
  // 分层评价：<5% 良好 / <10% 可接受 / ≥10% 需校准（按评审建议的经营意义阈值）
  const level = !valid.length ? 'no_data' : mape < 0.05 ? 'good' : mape < 0.1 ? 'fair' : 'poor';

  return {
    ok: true,
    summary: {
      sample_count: valid.length,
      mape: round4(mape),
      avg_deviation: avgDeviation,
      median_abs_deviation: round4(medianAbs),
      level,
      level_label: { no_data: '还没有录入实际只数', good: '拟合良好（MAPE < 5%）', fair: '尚可（MAPE < 10%）', poor: '偏差偏大，建议校准系数' }[level],
    },
    rows,
    truncated: consumption.length >= limit,
    skipped_invalid: skippedInvalid,
    notes: skippedInvalid
      ? `已跳过 ${skippedInvalid} 条无效记录（所属禽类已被删除的历史遗留消耗行，无法参与校准）`
      : '',
  };
}

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
  purgeOrphanConsumption,
  listBirds, createBird, updateBird, deleteBird,
  listYields, saveYields, deleteYield,
  listUsageByMenu, saveUsageForMenu, batchSaveUsage, listUsageOverview, listConfiguredMenus,
  // 父子部位重复计量检测（腿含在下庄里、翅含在上庄里）
  findUsageConflicts, ZONE_CHILDREN,
  // 禽类菜范围（覆盖率分母口径，用户可维护）
  listScopeKeywords, saveScopeKeywords, listScopeDishes, saveScopeDishes,
  resolveScopeRules, scopePreview,
  calculate, consumptionComparison, calibrationReport,
  listConsumption, saveConsumption, deleteConsumption,
  buildTemplateWorkbook, importWorkbook,
};
