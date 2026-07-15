/**
 * SQLite 数据库模块 — 基于 sql.js (纯 JS/WASM，无需编译)
 * 持久化文件：data/database.sqlite
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'database.sqlite');

let SQL = null;
let db = null;

/** 确保 data 目录存在 */
function ensureDir() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
}

/** 初始化数据库（创建表） */
async function init() {
  if (SQL) return; // 已初始化
  SQL = await initSqlJs();

  ensureDir();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');

  createTables();
  save();
}

/** 建表 */
function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_name TEXT NOT NULL,
      status TEXT DEFAULT '正常营业',
      store_type TEXT DEFAULT '直营店',
      legal_person TEXT,
      payment_type TEXT DEFAULT '法人收款',
      region TEXT,
      province TEXT,
      city TEXT,
      district TEXT,
      address TEXT,
      phone TEXT,
      business_hours TEXT,
      opening_date TEXT,
      table_2person INTEGER DEFAULT 0,
      table_4person INTEGER DEFAULT 0,
      store_size TEXT,
      lat REAL,
      lng REAL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 兼容旧库：缺字段时自动补齐
  try { db.run('ALTER TABLE stores ADD COLUMN legal_person TEXT'); } catch {}
  try { db.run('ALTER TABLE stores ADD COLUMN payment_type TEXT DEFAULT \'法人收款\''); } catch {}
  try { db.run('ALTER TABLE stores ADD COLUMN lat REAL'); } catch {}
  try { db.run('ALTER TABLE stores ADD COLUMN lng REAL'); } catch {}
  try { db.run('ALTER TABLE stores ADD COLUMN remark TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE stores ADD COLUMN radius INTEGER DEFAULT 3000'); } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS store_platforms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      platform_name TEXT NOT NULL,
      platform_id TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT DEFAULT '在职',
      hire_date TEXT,
      hire_type TEXT DEFAULT '全职',
      position TEXT,
      salary REAL DEFAULT 0,
      leave_date TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS store_fixed_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      cost_type TEXT NOT NULL,
      amount REAL DEFAULT 0,
      period TEXT DEFAULT '月度',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS store_operating_costs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      store_name TEXT,
      date TEXT,
      item TEXT,
      amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT,
      price REAL DEFAULT 0,
      cost REAL DEFAULT 0,
      expiry_days INTEGER,
      status TEXT DEFAULT '在售',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER,
      store_name TEXT,
      date TEXT NOT NULL,
      revenue REAL DEFAULT 0,
      actual_revenue REAL DEFAULT 0,
      order_count INTEGER DEFAULT 0,
      instore REAL DEFAULT 0,
      pickup REAL DEFAULT 0,
      mt_waimai REAL DEFAULT 0,
      tb_flash REAL DEFAULT 0,
      jd_waimai REAL DEFAULT 0,
      mt_pay REAL DEFAULT 0,
      mt_tuan REAL DEFAULT 0,
      dy_tuan REAL DEFAULT 0,
      stored_value REAL DEFAULT 0,
      coupon REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      discount_rate TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cost_accounting (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      period_type TEXT DEFAULT '日',
      revenue REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      actual_revenue REAL DEFAULT 0,
      fixed_daily_cost REAL DEFAULT 0,
      food_cost REAL DEFAULT 0,
      other_cost REAL DEFAULT 0,
      net_profit REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS push_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      push_type TEXT,
      target TEXT,
      content_preview TEXT,
      status TEXT DEFAULT 'success',
      error_msg TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS store_supplies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      store_name TEXT,
      date TEXT NOT NULL,
      item TEXT NOT NULL,
      quantity REAL DEFAULT 1,
      unit TEXT DEFAULT '个',
      unit_price REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT '客服',
      display_name TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS map_pins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lng REAL NOT NULL,
      lat REAL NOT NULL,
      name TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      color TEXT DEFAULT '#409EFF',
      radius INTEGER DEFAULT 3000,
      shape TEXT DEFAULT 'circle',
      created_by TEXT DEFAULT '',
      store_id INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('ALTER TABLE map_pins ADD COLUMN shape TEXT DEFAULT \'circle\''); } catch {}
}

/** 持久化到磁盘 — 以原始二进制写入，避免编码转换污染 SQLite 数据 */
function save() {
  if (!db) return;
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buf, { encoding: 'binary' });
}

/** 执行多条 SQL（事务内） */
function exec(sql, params = []) {
  db.run(sql, params);
}

/** 查询多行 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/** 查询单行 */
function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

/** 插入并返回 id */
function insert(sql, params = []) {
  db.run(sql, params);
  return queryOne('SELECT last_insert_rowid() as id').id;
}

/** 执行变更（INSERT/UPDATE/DELETE），返回影响行数 */
function run(sql, params = []) {
  db.run(sql, params);
  return db.getRowsModified();
}

/** 关闭数据库 */
function close() {
  if (db) { save(); db.close(); db = null; }
}

// 种子数据
const SEED_STORES = [
  { store_name: '鹅太公烧鹅（龙岗万科店）', status: '正常营业', store_type: '直营店', region: '华南', province: '广东省', city: '深圳市', district: '龙岗区', address: '龙岗区龙翔大道万科广场B1层', table_2person: 12, table_4person: 8, store_size: '150㎡', opening_date: '2024-03-15' },
  { store_name: '鹅太公烧鹅（坂田店）', status: '正常营业', store_type: '直营店', region: '华南', province: '广东省', city: '深圳市', district: '龙岗区', address: '龙岗区坂田街道坂雪岗大道', table_2person: 8, table_4person: 6, store_size: '100㎡', opening_date: '2024-06-01' },
  { store_name: '鹅太公烧鹅（欧景花园店）', status: '正常营业', store_type: '联营店', region: '华南', province: '广东省', city: '深圳市', district: '龙岗区', address: '龙岗区龙城街道欧景花园', table_2person: 10, table_4person: 4, store_size: '120㎡', opening_date: '2024-08-20' },
  { store_name: '鹅太公烧鹅（普宁溪尾店）', status: '正常营业', store_type: '加盟店', region: '华南', province: '广东省', city: '揭阳市', district: '普宁市', address: '普宁市溪尾街道', table_2person: 6, table_4person: 4, store_size: '80㎡', opening_date: '2024-11-01' },
  { store_name: '鹅太公烧鹅（博罗店）', status: '正常营业', store_type: '加盟店', region: '华南', province: '广东省', city: '惠州市', district: '博罗县', address: '博罗县罗阳街道', table_2person: 8, table_4person: 5, store_size: '90㎡', opening_date: '2025-01-10' },
  { store_name: '鹅太公烧鹅（江北旺岗店）', status: '正常营业', store_type: '直营店', region: '华南', province: '广东省', city: '惠州市', district: '惠城区', address: '惠城区江北旺岗路', table_2person: 10, table_4person: 6, store_size: '110㎡', opening_date: '2025-03-01' },
  { store_name: '鹅太公烧鹅（麦地店）', status: '筹建中', store_type: '直营店', region: '华南', province: '广东省', city: '惠州市', district: '惠城区', address: '惠城区麦地路', table_2person: 0, table_4person: 0, store_size: '130㎡' },
  { store_name: '鹅太公烧鹅（下埔店）', status: '筹建中', store_type: '联营店', region: '华南', province: '广东省', city: '惠州市', district: '惠城区', address: '惠城区下埔路', table_2person: 0, table_4person: 0, store_size: '100㎡' },
];

const SEED_PLATFORMS = [
  { store_name: '鹅太公烧鹅（龙岗万科店）', platforms: [{ name: '美团外卖', id: 'MT001' }, { name: '淘宝闪购', id: 'TB001' }, { name: '京东外卖', id: 'JD001' }, { name: '美团', id: 'MT_TUAN_001' }, { name: '抖音', id: 'DY001' }] },
  { store_name: '鹅太公烧鹅（坂田店）', platforms: [{ name: '美团外卖', id: 'MT002' }, { name: '美团', id: 'MT_TUAN_002' }] },
  { store_name: '鹅太公烧鹅（欧景花园店）', platforms: [{ name: '美团外卖', id: 'MT003' }, { name: '抖音', id: 'DY003' }] },
];

const SEED_EMPLOYEES = [
  { store_name: '鹅太公烧鹅（龙岗万科店）', employees: [
    { name: '张三', status: '在职', hire_date: '2024-03-15', hire_type: '全职', position: '厨师', salary: 8000 },
    { name: '李四', status: '在职', hire_date: '2024-03-20', hire_type: '全职', position: '服务员', salary: 5000 },
    { name: '王五', status: '在职', hire_date: '2024-06-01', hire_type: '兼职', position: '服务员', salary: 3000 },
    { name: '赵六', status: '离职', hire_date: '2024-05-01', hire_type: '全职', position: '厨师', salary: 7500, leave_date: '2025-12-31' },
  ]},
  { store_name: '鹅太公烧鹅（坂田店）', employees: [
    { name: '钱七', status: '在职', hire_date: '2024-06-01', hire_type: '全职', position: '厨师', salary: 7500 },
    { name: '孙八', status: '在职', hire_date: '2024-07-15', hire_type: '全职', position: '服务员', salary: 4800 },
  ]},
];

const SEED_MENU = [
  { name: '招牌烧鹅', category: '烧腊', price: 68, cost: 28, expiry_days: 2 },
  { name: '蜜汁叉烧', category: '烧腊', price: 48, cost: 18, expiry_days: 2 },
  { name: '白切鸡', category: '烧腊', price: 58, cost: 22, expiry_days: 1 },
  { name: '烧鸭', category: '烧腊', price: 45, cost: 16, expiry_days: 2 },
  { name: '鹅腿饭', category: '快餐', price: 35, cost: 14, expiry_days: 1 },
  { name: '叉烧饭', category: '快餐', price: 28, cost: 11, expiry_days: 1 },
  { name: '烧鹅濑粉', category: '粉面', price: 25, cost: 9, expiry_days: 1 },
  { name: '老火靓汤', category: '汤品', price: 18, cost: 5, expiry_days: 1 },
];

const SEED_USERS = [
  { username: 'admin', password_hash: '0192023a7bbd73250516f069df18b500', role: '管理员', display_name: '系统管理员' },
  { username: 'agent', password_hash: 'e19d5cd5af0378da05f63f891c7467af', role: '专员', display_name: '数据专员' },
];

/** 写入种子数据 */
function seed() {
  const count = queryOne('SELECT COUNT(*) as cnt FROM stores').cnt;
  if (count > 0) return; // 已有数据，不重复播种

  // 门店
  const storeMap = {};
  for (const s of SEED_STORES) {
    const id = insert(
      `INSERT INTO stores (store_name,status,store_type,region,province,city,district,address,table_2person,table_4person,store_size,opening_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [s.store_name, s.status, s.store_type, s.region, s.province, s.city, s.district, s.address, s.table_2person, s.table_4person, s.store_size, s.opening_date || null]
    );
    storeMap[s.store_name] = id;
  }

  // 固定成本（每家门店）
  for (const [name, id] of Object.entries(storeMap)) {
    insert(`INSERT INTO store_fixed_costs (store_id,cost_type,amount) VALUES (?,?,?)`, [id, '房租', 15000 + Math.floor(Math.random() * 10000)]);
    insert(`INSERT INTO store_fixed_costs (store_id,cost_type,amount) VALUES (?,?,?)`, [id, '水电', 3000 + Math.floor(Math.random() * 2000)]);
  }

  // 平台ID
  for (const sp of SEED_PLATFORMS) {
    const sid = storeMap[sp.store_name];
    if (!sid) continue;
    for (const p of sp.platforms) {
      insert(`INSERT INTO store_platforms (store_id,platform_name,platform_id) VALUES (?,?,?)`, [sid, p.name, p.id]);
    }
  }

  // 员工
  for (const se of SEED_EMPLOYEES) {
    const sid = storeMap[se.store_name];
    if (!sid) continue;
    for (const e of se.employees) {
      insert(
        `INSERT INTO employees (store_id,name,status,hire_date,hire_type,position,salary,leave_date) VALUES (?,?,?,?,?,?,?,?)`,
        [sid, e.name, e.status, e.hire_date, e.hire_type, e.position, e.salary, e.leave_date || null]
      );
    }
  }

  // 菜品（关联到龙岗万科店）
  const sid1 = storeMap['鹅太公烧鹅（龙岗万科店）'];
  if (sid1) {
    for (const m of SEED_MENU) {
      insert(`INSERT INTO menu_items (store_id,name,category,price,cost,expiry_days) VALUES (?,?,?,?,?,?)`,
        [sid1, m.name, m.category, m.price, m.cost, m.expiry_days]);
    }
  }

  // 用户
  for (const u of SEED_USERS) {
    insert(`INSERT INTO users (username,password_hash,role,display_name) VALUES (?,?,?,?)`,
      [u.username, u.password_hash, u.role, u.display_name]);
  }

  // 种子推送日志
  insert(`INSERT INTO push_logs (push_type,target,content_preview,status) VALUES (?,?,?,?)`,
    ['webhook', '日报推送群', '✅ 中控后台连接测试成功', 'success']);
  insert(`INSERT INTO push_logs (push_type,target,content_preview,status) VALUES (?,?,?,?)`,
    ['report', '日报推送群', '📊 门店日报推送（龙岗万科店）', 'success']);

  save();
}

module.exports = { init, save, exec, queryAll, queryOne, insert, run, close, seed };
