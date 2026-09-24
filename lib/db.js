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
  // 历史遗留自愈：本项目的 ON DELETE CASCADE 实际不生效（见 PROJECT_CHANGES「顺带修掉项目级隐患」），
  // 删除门店会留下孤儿关联行 —— 表现为「闭店门店组显示 1 家、点进去却没人」。
  // 启动时幂等清理一次，比在每个删除入口逐一补救更可靠。
  try {
    const orphanRegion = run('DELETE FROM store_region_members WHERE store_id NOT IN (SELECT id FROM stores)');
    const orphanManager = run('DELETE FROM store_manager_assignments WHERE store_id NOT IN (SELECT id FROM stores)');
    if (Number(orphanRegion) || Number(orphanManager)) {
      console.log(`[db] 已清理门店孤儿关联行：区域归属 ${orphanRegion} 行、店长绑定 ${orphanManager} 行`);
    }
  } catch (e) { console.warn('[db] 清理门店孤儿关联行失败：' + e.message); }
  require('./staff-affiliation').normalizeStaffAffiliations({ queryAll, run });
  require('./staff-age').refreshStaffAges({ queryAll, run });
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
  // 收银系统导出的“机构编码”是稳定门店标识；名称变更后仍可据此匹配。
  try { db.run("ALTER TABLE stores ADD COLUMN pos_store_code TEXT DEFAULT ''"); } catch {}
  try { db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_pos_store_code ON stores (pos_store_code) WHERE pos_store_code IS NOT NULL AND pos_store_code != ''"); } catch {}
  // ===== 闭店 / 迁址 =====
  // 口径（2026-09-22 与业务确认）：
  //   · status 只保留三态：筹建中 / 正常营业 / 已闭店。「迁址」是闭店原因，归入 closed_type，不再当状态用。
  //   · 迁址 = 老店按「已闭店(迁址)」结束 + 新建门店记录 + 双向指针互指；收银机构编码会变，故历史数据不合并，
  //     只保留“关联凭证”（谁迁到哪里），报表仍按点位各算各的。
  //   · 换法人但门店未停业 ≠ 闭店，只在门店生命线里记一条“法人变更”。
  try { db.run("ALTER TABLE stores ADD COLUMN closed_date TEXT DEFAULT ''"); } catch {}
  try { db.run("ALTER TABLE stores ADD COLUMN closed_type TEXT DEFAULT ''"); } catch {}
  try { db.run("ALTER TABLE stores ADD COLUMN closed_reason TEXT DEFAULT ''"); } catch {}
  try { db.run("ALTER TABLE stores ADD COLUMN relocated_to_store_id INTEGER"); } catch {}
  try { db.run("ALTER TABLE stores ADD COLUMN relocated_from_store_id INTEGER"); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_stores_relocated_to ON stores (relocated_to_store_id)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_stores_relocated_from ON stores (relocated_from_store_id)'); } catch {}

  // 门店生命线：不可覆写的门店事件留痕，模式与 employee_lifecycle_events 一致。
  // event_type：开业 / 闭店 / 重开 / 迁址迁出 / 迁址迁入 / 更名 / 法人变更 / 店型变更 / 区域调整 / 店长变更 / 资料变更
  // details_json：迁址时放 { from_store_id, from_store_name, to_store_id, to_store_name } 等结构化补充
  db.run(`
    CREATE TABLE IF NOT EXISTS store_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_date TEXT NOT NULL,
      old_value TEXT DEFAULT '',
      new_value TEXT DEFAULT '',
      note TEXT DEFAULT '',
      source TEXT DEFAULT '本地维护',
      attachment_url TEXT DEFAULT '',
      attachment_name TEXT DEFAULT '',
      details_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_store_lifecycle_store ON store_lifecycle_events (store_id, event_date, id)'); } catch {}

  // 门店级看板设置：目前用于「每日均摊成本」里工资 / 房租物业 / 水电各项的取数来源。
  // 必须**按门店**保存 —— 它是口径而不是个人偏好：同一家店如果两个人看到不同的均摊基数，
  // 看板数字就对不上了。放在 store 维度，保证所有人看同一家店得到同一口径。
  // 存 JSON 是为了后续加设置项时不用再建表。
  db.run(`
    CREATE TABLE IF NOT EXISTS store_dashboard_settings (
      store_id INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
      settings_json TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      updated_by TEXT DEFAULT ''
    )
  `);

  // 门店 GLB 模型：文件本身落在磁盘（data/uploads/store-models/<sha256>.glb），
  // 库里只存元数据。理由见 lib/store-models.js 顶部注释：sql.js 每次 save() 都全量重写
  // 整个库文件（现约 282MB），GLB 动辄 100MB+，绝不能作为 BLOB 入库。
  // 同一门店换模型 = 插新版本并把旧版 is_active 置 0，历史留痕、不覆盖。
  db.run(`
    CREATE TABLE IF NOT EXISTS store_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      bytes INTEGER DEFAULT 0,
      sha256 TEXT DEFAULT '',
      version INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      uploaded_by INTEGER,
      uploaded_by_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_store_models_store ON store_models (store_id, is_active)'); } catch {}
  // 同一个文件（内容一致）只落一份磁盘副本，多个门店可共用同一 stored_name。
  try { db.run('CREATE INDEX IF NOT EXISTS idx_store_models_sha ON store_models (sha256)'); } catch {}

  // 三维空间标注独立保存，不污染 GLB 文件。标注绑定到具体模型版本：模型升级后旧标注仍可追溯、复制或微调。
  db.run(`
    CREATE TABLE IF NOT EXISTS store_model_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_model_id INTEGER NOT NULL REFERENCES store_models(id) ON DELETE CASCADE,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      zone_key TEXT DEFAULT '',
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      node_name TEXT DEFAULT '',
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      position_z REAL NOT NULL,
      normal_x REAL DEFAULT 0,
      normal_y REAL DEFAULT 1,
      normal_z REAL DEFAULT 0,
      status TEXT DEFAULT '待完善',
      created_by_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_store_model_annotations_model ON store_model_annotations (store_model_id, id)'); } catch {}

  // 自定义门店区域：支持省/市/片区等多层分组，同一门店可同时归属多个分组。
  db.run(`
    CREATE TABLE IF NOT EXISTS store_regions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES store_regions(id) ON DELETE SET NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS store_region_members (
      region_id INTEGER NOT NULL REFERENCES store_regions(id) ON DELETE CASCADE,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (region_id, store_id)
    )
  `);
  // 「闭店门店」系统分组：全国统一的独立分组（顶级、末级、不挂在任何省市区下）。
  // 闭店时把门店移入此组，因此它自然从原区域树里消失；原区域记在门店生命线里，便于回溯与重开时归位。
  // ⚠️ 顺序很重要：code 列的 ALTER 必须紧跟在**本表建表之后**。
  //    早先把它放在 stores 段（本表建表之前）时，对全新库会因“表不存在”而失败，
  //    随后 seed 里的 SELECT 引用不存在的列同样失败 —— 两处都被 try/catch 静默吞掉，
  //    结果是「列在、种子行永远不出现」。这里改为就地 ALTER，且失败时打印告警。
  try {
    db.run("ALTER TABLE store_regions ADD COLUMN code TEXT DEFAULT ''");
  } catch (e) {
    if (!/duplicate column/i.test(String(e.message || ''))) console.warn('[db] store_regions.code 迁移失败：' + e.message);
  }
  try { db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_store_regions_code ON store_regions (code) WHERE code IS NOT NULL AND code != ''"); } catch (e) { console.warn('[db] store_regions.code 唯一索引创建失败：' + e.message); }
  try {
    // 注意：本文件内部 queryOne/insert 是**模块级包装函数**（文件末尾定义），
    // 而 `db` 是 sql.js 的原生 Database，没有 queryOne 方法 —— 写成 db.queryOne 会抛
    // “db.queryOne is not a function”（曾因 catch {} 静默吞掉，导致系统分组一直没建出来）。
    const hasClosed = queryOne("SELECT id FROM store_regions WHERE code='closed'");
    if (!hasClosed) {
      // 排序值给一个很大的数，保证它固定出现在区域树最后
      insert("INSERT INTO store_regions (name,parent_id,sort_order,code) VALUES ('闭店门店',NULL,9999,'closed')");
      console.log('[db] 已建立系统分组「闭店门店」（code=closed）');
    }
  } catch (e) { console.warn('[db] 建立「闭店门店」系统分组失败：' + e.message); }

  db.run(`
    CREATE TABLE IF NOT EXISTS store_platforms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      platform_name TEXT NOT NULL,
      platform_id TEXT,
      setup_status TEXT DEFAULT '未上线',
      online_date TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run("ALTER TABLE store_platforms ADD COLUMN setup_status TEXT DEFAULT '未上线'"); } catch {}
  try { db.run('ALTER TABLE store_platforms ADD COLUMN online_date TEXT'); } catch {}
  try { db.run('ALTER TABLE store_platforms ADD COLUMN updated_at TEXT'); } catch {}

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
  // 扩展字段：兼容旧库
  try { db.run('ALTER TABLE employees ADD COLUMN phone TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN gender TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN age INTEGER DEFAULT 0'); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN store_name TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN entry_date TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN remark TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN role TEXT DEFAULT \'店员\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN smartsheet_record_id TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN updated_at TEXT DEFAULT \'\''); } catch {}
  // 人事档案必备字段。证件和银行卡资料只在档案编辑页使用，不在普通员工列表展示。
  try { db.run('ALTER TABLE employees ADD COLUMN manager_name TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN onboarding_status TEXT DEFAULT \'已入职\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN id_card_number TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN id_card_front_url TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN id_card_back_url TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN bank_name TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN bank_branch TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN bank_account_name TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN bank_card_number TEXT DEFAULT \'\''); } catch {}
  // 银行卡正反面照片：与身份证/健康证同一口径，只存上传后的受保护文件地址，不存 base64
  try { db.run('ALTER TABLE employees ADD COLUMN bank_card_front_url TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN bank_card_back_url TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN probation_date TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN emergency_contact TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN emergency_phone TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN health_certificate_url TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN health_certificate_expiry TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN photo_url TEXT DEFAULT \'\''); } catch {}
  // 钉钉员工 ID 仅用于将考勤打卡记录精确映射到本地员工，不保存钉钉密钥。
  try { db.run('ALTER TABLE employees ADD COLUMN dingtalk_user_id TEXT DEFAULT \'\''); } catch {}
  // 人事档案扩展：教育信息仅面向集团员工；调岗与薪资变化由员工生命线留档。
  try { db.run('ALTER TABLE employees ADD COLUMN job_level TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN native_place TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN household_registration TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN contact_address TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN labor_relation TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN contract_start_date TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN contract_end_date TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN social_security_number TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN household_type TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN education_school TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN education_level TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN graduation_date TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employees ADD COLUMN major TEXT DEFAULT \'\''); } catch {}
  // 员工生命线：档案字段变化形成不可覆写的事件记录，薪酬数值不在普通员工列表展示。
  db.run(`
    CREATE TABLE IF NOT EXISTS employee_lifecycle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_date TEXT NOT NULL,
      old_value TEXT DEFAULT '',
      new_value TEXT DEFAULT '',
      note TEXT DEFAULT '',
      source TEXT DEFAULT '本地维护',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('ALTER TABLE employee_lifecycle_events ADD COLUMN attachment_url TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employee_lifecycle_events ADD COLUMN attachment_name TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE employee_lifecycle_events ADD COLUMN details_json TEXT DEFAULT \'{}\''); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_employee_lifecycle_employee ON employee_lifecycle_events (employee_id, event_date, id)'); } catch {}
  // 员工多岗位：一个员工可同时担任多个岗位，其中一个为主岗位。
  // employees.position 继续保存主岗位（员工列表、工资表、人效看板都读它），本表用于展示全部岗位。
  db.run(`
    CREATE TABLE IF NOT EXISTS employee_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      position TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(employee_id, position)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_employee_positions_employee ON employee_positions (employee_id, sort_order, id)'); } catch {}
  // 消息通知：一条通知可发给多个后台账号，每个收件人各自维护状态。
  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      kind TEXT DEFAULT 'notice',
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      dedupe_key TEXT DEFAULT '',
      related_employee_id INTEGER,
      payload_json TEXT DEFAULT '{}',
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // kind：notice=通知（确认/稍后处理）、task=任务（稍后处理/马上查看，预留，本期未启用）
  try { db.run("ALTER TABLE notifications ADD COLUMN kind TEXT DEFAULT 'notice'"); } catch {}
  // source：system=规则自动生成、manual=人工创建。publish_at 为空表示立即生效。
  try { db.run("ALTER TABLE notifications ADD COLUMN source TEXT DEFAULT 'system'"); } catch {}
  try { db.run("ALTER TABLE notifications ADD COLUMN publish_at TEXT DEFAULT ''"); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_notifications_publish ON notifications (publish_at)'); } catch {}
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications (dedupe_key) WHERE dedupe_key <> \'\''); } catch {}
  db.run(`
    CREATE TABLE IF NOT EXISTS notification_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      status TEXT DEFAULT '待处理',
      later_at TEXT DEFAULT '',
      archived_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(notification_id, user_id)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_notification_recipients_user ON notification_recipients (user_id, status, id)'); } catch {}
  // popup_at：该收件人已弹窗展示过的时间。用于「每条新通知只自动弹一次」。
  try { db.run("ALTER TABLE notification_recipients ADD COLUMN popup_at TEXT DEFAULT ''"); } catch {}
  // 跨店支援：不改变劳动归属、岗位或薪资，只记录工资归集的目标门店和日期。
  db.run(`
    CREATE TABLE IF NOT EXISTS employee_store_dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      origin_store_id INTEGER NOT NULL,
      origin_store_name TEXT NOT NULL,
      support_store_id INTEGER NOT NULL,
      support_store_name TEXT NOT NULL,
      dispatch_mode TEXT NOT NULL DEFAULT 'continuous',
      start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '',
      dispatch_dates_json TEXT DEFAULT '[]',
      reason TEXT DEFAULT '',
      attachment_url TEXT DEFAULT '',
      attachment_name TEXT DEFAULT '',
      status TEXT DEFAULT '有效',
      created_by TEXT DEFAULT '本地维护',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_dispatch_employee_dates ON employee_store_dispatches (employee_id, start_date, end_date)'); } catch {}
  // C 级薪酬档案：按工资表的构成保存标准项与默认扣缴项，不在员工普通列表中暴露。
  db.run(`
    CREATE TABLE IF NOT EXISTS employee_salary_profiles (
      employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
      base_salary REAL DEFAULT 0,
      position_allowance REAL DEFAULT 0,
      performance_salary REAL DEFAULT 0,
      attendance_bonus REAL DEFAULT 0,
      housing_allowance REAL DEFAULT 0,
      weekday_overtime_rate REAL DEFAULT 0,
      restday_overtime_rate REAL DEFAULT 0,
      part_time_hourly_rate REAL DEFAULT 0,
      default_reward REAL DEFAULT 0,
      default_penalty REAL DEFAULT 0,
      late_early_deduction REAL DEFAULT 0,
      other_deduction REAL DEFAULT 0,
      social_insurance REAL DEFAULT 0,
      income_tax REAL DEFAULT 0,
      utilities_fee REAL DEFAULT 0,
      uniform_deposit REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 月度工资工作表：薪酬构成以当月快照保存，避免后续档案变更改写历史工资。
  db.run(`
    CREATE TABLE IF NOT EXISTS payroll_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_name TEXT NOT NULL,
      period TEXT NOT NULL,
      scheduled_days REAL DEFAULT 26,
      status TEXT DEFAULT '草稿',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(store_name, period)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS payroll_sheet_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id INTEGER NOT NULL REFERENCES payroll_sheets(id) ON DELETE CASCADE,
      employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      sort_order INTEGER DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(sheet_id, employee_id)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_payroll_sheet_items_sheet ON payroll_sheet_items (sheet_id, sort_order)'); } catch {}
  // 月度考勤基准：同一月份仅维护一份全门店统一的应出勤天数，工资表和人效都从这里读取。
  db.run(`
    CREATE TABLE IF NOT EXISTS payroll_month_settings (
      period TEXT PRIMARY KEY,
      scheduled_days REAL NOT NULL DEFAULT 26,
      updated_by TEXT DEFAULT '本地维护',
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 钉钉考勤原始记录：保留每一次上下班打卡，可重跑同步而不重复入库。
  db.run(`
    CREATE TABLE IF NOT EXISTS dingtalk_attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      dingtalk_user_id TEXT NOT NULL,
      work_date TEXT NOT NULL,
      check_time TEXT NOT NULL,
      check_type TEXT DEFAULT '',
      time_result TEXT DEFAULT '',
      location_result TEXT DEFAULT '',
      source_data TEXT DEFAULT '{}',
      synced_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(dingtalk_user_id, check_time, check_type)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_dingtalk_attendance_employee_date ON dingtalk_attendance_records (employee_id, work_date)'); } catch {}
  db.run(`
    CREATE TABLE IF NOT EXISTS dingtalk_attendance_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      status TEXT NOT NULL,
      record_count INTEGER DEFAULT 0,
      matched_count INTEGER DEFAULT 0,
      unmatched_count INTEGER DEFAULT 0,
      message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 数据迁移：已有员工的 hire_date → entry_date
  try { db.run("UPDATE employees SET entry_date=hire_date WHERE entry_date='' AND hire_date IS NOT NULL AND hire_date!=''"); } catch {}
  // 历史档案首次启用生命线时，以入职日期补建第一条，而不是以本次系统升级日期作为起点。
  try { db.run(`INSERT INTO employee_lifecycle_events (employee_id,event_type,event_date,old_value,new_value,note,source)
    SELECT e.id,'入职',COALESCE(NULLIF(e.entry_date,''), NULLIF(e.hire_date,''), date(e.created_at)), '',
      TRIM(COALESCE(e.name,'') || CASE WHEN COALESCE(e.position,'')!='' THEN ' · ' || e.position ELSE '' END),
      '历史档案补建','历史档案'
    FROM employees e
    WHERE NOT EXISTS (SELECT 1 FROM employee_lifecycle_events l WHERE l.employee_id=e.id AND l.event_type='入职')`); } catch {}
  // 已登记离职日期的历史档案，补建离职事件，避免生命线只显示入职而遗漏已发生的离职。
  try { db.run(`INSERT INTO employee_lifecycle_events (employee_id,event_type,event_date,old_value,new_value,note,source)
    SELECT e.id,'离职',e.leave_date,'在职','离职','历史档案补建','历史档案'
    FROM employees e
    WHERE e.status='离职' AND COALESCE(e.leave_date,'')!=''
      AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events l WHERE l.employee_id=e.id AND l.event_type='离职')`); } catch {}
  // 数据迁移：已有员工的 role 根据 position 推断（含"厨师"→"厨师长"无此逻辑，保持默认）
  try { db.run("UPDATE employees SET role='店长' WHERE position LIKE '%经理%' OR position LIKE '%店长%'"); } catch {}
  // 数据迁移：已有员工的 store_name 从 stores 表补全
  try { db.run("UPDATE employees SET store_name=(SELECT store_name FROM stores WHERE stores.id=employees.store_id) WHERE store_name='' AND store_id IS NOT NULL"); } catch {}

  // 门店店长由独立绑定维护，不再依赖员工档案中的自由文本“归属店长”。
  db.run(`
    CREATE TABLE IF NOT EXISTS store_manager_assignments (
      store_id INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
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
      method TEXT,
      spec TEXT,
      price REAL DEFAULT 0,
      cost REAL DEFAULT 0,
      expiry_days INTEGER,
      status TEXT DEFAULT '在售',
      item_type TEXT DEFAULT 'dish',
      spuid TEXT DEFAULT '',
      skuid TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run("ALTER TABLE menu_items ADD COLUMN item_type TEXT DEFAULT 'dish'"); } catch {}
  try { db.run("ALTER TABLE menu_items ADD COLUMN spuid TEXT DEFAULT ''"); } catch {}
  try { db.run("ALTER TABLE menu_items ADD COLUMN skuid TEXT DEFAULT ''"); } catch {}
  try { db.run('DROP INDEX IF EXISTS idx_menu_items_spuid'); } catch {}
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_menu_items_skuid ON menu_items (skuid) WHERE skuid IS NOT NULL AND skuid != \'\''); } catch {}
  // 老数据推断：名称带【套餐】的自动标记为套餐，避免手工逐条调整
  try { db.run("UPDATE menu_items SET item_type='combo' WHERE item_type='dish' AND name LIKE '【套餐】%'"); } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS menu_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0,
      remark TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 迁移：把菜单中已使用的历史分类收录进分类表，保证旧数据可见可管理
  try {
    const usedCategories = queryAll("SELECT DISTINCT category FROM menu_items WHERE category IS NOT NULL AND category != ''");
    usedCategories.forEach(({ category }, i) => {
      if (category && !queryOne('SELECT id FROM menu_categories WHERE name=?', [category])) {
        run('INSERT INTO menu_categories (name, sort_order) VALUES (?,?)', [category, (i + 1) * 10]);
      }
    });
  } catch {}

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

  // ===== 经营数据分析：导入批次、渠道营收、商品销量 =====
  db.run(`
    CREATE TABLE IF NOT EXISTS business_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      platform TEXT DEFAULT '',
      file_name TEXT DEFAULT '',
      row_count INTEGER DEFAULT 0,
      date_from TEXT,
      date_to TEXT,
      imported_by INTEGER,
      imported_by_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS business_revenue_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      store_name TEXT DEFAULT '',
      biz_date TEXT NOT NULL,
      source_type TEXT NOT NULL,
      platform TEXT DEFAULT '',
      channel_group TEXT NOT NULL,
      channel TEXT NOT NULL,
      recorded_amount REAL DEFAULT 0,
      gross_amount REAL DEFAULT 0,
      platform_income_amount REAL DEFAULT 0,
      actual_amount REAL DEFAULT 0,
      service_fee REAL DEFAULT 0,
      insurance_fee REAL DEFAULT 0,
      promotion_fee REAL DEFAULT 0,
      refund_amount REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      order_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('ALTER TABLE business_revenue_records ADD COLUMN discount_amount REAL DEFAULT 0'); } catch {}
  // 淘宝闪购日报中的“收入”（扣客户优惠、未扣平台费用）单独存放，不能再与营业额或实际到账混用。
  try { db.run('ALTER TABLE business_revenue_records ADD COLUMN platform_income_amount REAL DEFAULT 0'); } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS business_revenue_compositions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      store_name TEXT DEFAULT '',
      biz_date TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(store_id, biz_date, category)
    )
  `);

  // 外卖平台无法通过原始报表统一导出的额外支出（霸王餐、第三方推广）。
  // 仅作为门店经营利润的人工台账，不回写或覆盖任何平台原始结算数据。
  db.run(`
    CREATE TABLE IF NOT EXISTS delivery_external_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      expense_date TEXT NOT NULL,
      expense_type TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      remark TEXT DEFAULT '',
      created_by INTEGER,
      created_by_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_delivery_external_expenses_lookup ON delivery_external_expenses (store_id, platform, expense_date)');

  db.run(`
    CREATE TABLE IF NOT EXISTS business_ai_diagnoses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      perspective_key TEXT NOT NULL,
      filter_signature TEXT NOT NULL,
      perspective_title TEXT DEFAULT '',
      date_from TEXT DEFAULT '',
      date_to TEXT DEFAULT '',
      result_json TEXT NOT NULL,
      created_by INTEGER,
      created_by_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(perspective_key, filter_signature)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS business_product_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      store_name TEXT DEFAULT '',
      biz_date TEXT NOT NULL,
      source_type TEXT NOT NULL,
      platform TEXT DEFAULT '',
      channel TEXT DEFAULT '',
      product_name TEXT NOT NULL,
      platform_product_id TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      sales_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 收银机“品项销售明细”：保留订单来源与原始品项，供总数据视角按本地 SKU 汇总、展开追溯。
  // 该表只承载收银机原始明细，绝不改写第三方平台的营业或结算数据。
  db.run(`
    CREATE TABLE IF NOT EXISTS pos_product_sale_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
      store_name TEXT DEFAULT '',
      pos_store_code TEXT DEFAULT '',
      biz_date TEXT NOT NULL,
      order_id TEXT NOT NULL,
      product_code TEXT DEFAULT '',
      product_name TEXT NOT NULL,
      related_product_name TEXT DEFAULT '',
      product_type TEXT DEFAULT '',
      dish_type TEXT DEFAULT '',
      spec TEXT DEFAULT '',
      method TEXT DEFAULT '',
      addons TEXT DEFAULT '',
      channel TEXT DEFAULT '',
      order_class TEXT DEFAULT '',
      order_source TEXT DEFAULT '',
      new_order_source TEXT DEFAULT '',
      order_sub_source TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      sales_amount REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      gift_quantity REAL DEFAULT 0,
      gift_amount REAL DEFAULT 0,
      income_amount REAL DEFAULT 0,
      sales_mode TEXT DEFAULT '',
      order_time TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(store_id,biz_date,order_id,product_code,product_name,sales_mode)
    )
  `);
  // 源报表带「下单时间」：老库补列（新库建表时已含），供时段类分析使用。
  try { db.run("ALTER TABLE pos_product_sale_details ADD COLUMN order_time TEXT DEFAULT ''"); } catch {}
  // 源报表带「赠送数量/赠送金额」：赠品已含在销量与金额内（再全额优惠），这里只留存用于标注。
  try { db.run('ALTER TABLE pos_product_sale_details ADD COLUMN gift_quantity REAL DEFAULT 0'); } catch {}
  try { db.run('ALTER TABLE pos_product_sale_details ADD COLUMN gift_amount REAL DEFAULT 0'); } catch {}
  db.run('CREATE INDEX IF NOT EXISTS idx_pos_product_sale_details_lookup ON pos_product_sale_details (store_id,biz_date,channel)');
  db.run(`
    CREATE TABLE IF NOT EXISTS pos_product_mappings (
      product_code TEXT PRIMARY KEY,
      product_name TEXT DEFAULT '',
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 美团外卖全门店营业日报：按美团门店 ID 保存原始记录，再精确关联本地门店。
  // 未在第三方平台档案登记 ID 的记录也会保留，待补齐绑定后可重新导入生效。
  db.run(`
    CREATE TABLE IF NOT EXISTS meituan_delivery_daily_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      biz_date TEXT NOT NULL,
      meituan_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      source_province TEXT DEFAULT '',
      source_city TEXT DEFAULT '',
      source_district TEXT DEFAULT '',
      gross_amount REAL DEFAULT 0,
      actual_amount REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      order_count INTEGER DEFAULT 0,
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(meituan_store_id, biz_date)
    )
  `);

  // 美团外卖商品销量报表：保留原始门店 ID 与商品数据，关联成功后同步进通用菜品销售分析。
  db.run(`
    CREATE TABLE IF NOT EXISTS meituan_delivery_product_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      biz_date TEXT NOT NULL,
      meituan_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      source_city TEXT DEFAULT '',
      product_name TEXT NOT NULL,
      platform_product_id TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      sales_amount REAL DEFAULT 0,
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(meituan_store_id, biz_date, product_name)
    )
  `);

  // 京东外卖全门店营业日报：结构与美团原始日报一致，按京东门店 ID 精确关联本地门店。
  db.run(`
    CREATE TABLE IF NOT EXISTS jd_delivery_daily_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      biz_date TEXT NOT NULL,
      jd_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      source_city TEXT DEFAULT '',
      gross_amount REAL DEFAULT 0,
      actual_amount REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      order_count INTEGER DEFAULT 0,
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(jd_store_id, biz_date)
    )
  `);

  // 京东“真实到账收入”结算明细：X 列应结金额已包含所有流水的最终结算结果；
  // 同时保留 H/I 的订单类型明细，以展示实际发生的第三方费用，不能仅保留汇总到账。
  db.run(`
    CREATE TABLE IF NOT EXISTS jd_delivery_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      jd_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      bill_date TEXT NOT NULL,
      bill_type TEXT NOT NULL,
      amount REAL DEFAULT 0,
      transaction_count INTEGER DEFAULT 0,
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      raw_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(jd_store_id, bill_date, bill_type)
    )
  `);

  // 京东外卖商品销量报表：保留原始京东门店 ID；匹配成功后同步到通用菜品销售分析表。
  db.run(`
    CREATE TABLE IF NOT EXISTS jd_delivery_product_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      biz_date TEXT NOT NULL,
      jd_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      source_city TEXT DEFAULT '',
      product_name TEXT NOT NULL,
      platform_product_id TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      sales_amount REAL DEFAULT 0,
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(jd_store_id, biz_date, product_name)
    )
  `);

  // 平台商品标识（外卖=商品id/菜品编码，团购=项目ID/套餐ID）：旧库补列
  try { db.run("ALTER TABLE business_product_sales ADD COLUMN platform_product_id TEXT DEFAULT ''"); } catch {}
  try { db.run("ALTER TABLE meituan_delivery_product_records ADD COLUMN platform_product_id TEXT DEFAULT ''"); } catch {}
  try { db.run("ALTER TABLE jd_delivery_product_records ADD COLUMN platform_product_id TEXT DEFAULT ''"); } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS business_product_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      channel_group TEXT NOT NULL,
      external_product_name TEXT NOT NULL,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(platform, external_product_name)
    )
  `);

  // 美团团购“收益明细”：逐行保留结算流水。售价、商家应得、顾客支付与 U:AO 的全部平台费用
  // 互相独立保存，既可按收益时间重建日账，也不会把美团补贴误作商家成本。
  db.run(`
    CREATE TABLE IF NOT EXISTS meituan_group_buy_benefit_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      source_row_key TEXT NOT NULL UNIQUE,
      meituan_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      income_date TEXT NOT NULL,
      income_time TEXT DEFAULT '',
      order_no TEXT DEFAULT '',
      voucher_no TEXT DEFAULT '',
      project_id TEXT DEFAULT '',
      project_name TEXT DEFAULT '',
      transaction_type TEXT DEFAULT '',
      sale_mode TEXT DEFAULT '',
      sale_price REAL DEFAULT 0,
      merchant_income REAL DEFAULT 0,
      customer_promotion REAL DEFAULT 0,
      customer_paid REAL DEFAULT 0,
      third_party_fee REAL DEFAULT 0,
      fee_breakdown_json TEXT DEFAULT '{}',
      raw_json TEXT DEFAULT '{}',
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_meituan_group_benefit_date_store ON meituan_group_buy_benefit_records (income_date, store_id)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_meituan_group_benefit_platform_store ON meituan_group_buy_benefit_records (meituan_store_id, income_date)'); } catch {}

  // 美团团购“门店基础数据”：只保留平台经营指标；实际到账仍以收益明细生成的日账为准。
  db.run(`
    CREATE TABLE IF NOT EXISTS meituan_group_buy_operation_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      meituan_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      biz_date TEXT NOT NULL,
      gross_amount REAL DEFAULT 0,
      income_amount REAL DEFAULT 0,
      order_count REAL DEFAULT 0,
      impression_users REAL DEFAULT 0,
      visit_users REAL DEFAULT 0,
      ordering_users REAL DEFAULT 0,
      meituan_rating REAL DEFAULT 0,
      dianping_rating REAL DEFAULT 0,
      review_count REAL DEFAULT 0,
      raw_json TEXT DEFAULT '{}',
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(meituan_store_id, biz_date)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_meituan_group_operation_date_store ON meituan_group_buy_operation_records (biz_date, store_id)'); } catch {}
  db.run(`CREATE TABLE IF NOT EXISTS douyin_group_buy_operation_records (id INTEGER PRIMARY KEY AUTOINCREMENT,batch_id INTEGER,douyin_store_id TEXT NOT NULL,source_store_name TEXT,biz_date TEXT NOT NULL,visit_users REAL DEFAULT 0,ordering_users REAL DEFAULT 0,store_rating REAL DEFAULT 0,review_count REAL DEFAULT 0,raw_json TEXT DEFAULT '{}',store_id INTEGER,store_name TEXT,match_status TEXT DEFAULT 'unmatched',UNIQUE(douyin_store_id,biz_date))`);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_douyin_group_operation_date_store ON douyin_group_buy_operation_records (biz_date,store_id)'); } catch {}
  // 团购每日总结：门店闭店后由运营录入。任务目标按“今晚填写、次日执行”保存。
  db.run(`
    CREATE TABLE IF NOT EXISTS group_buy_daily_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      biz_date TEXT NOT NULL,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      store_name TEXT DEFAULT '',
      lighting_actual REAL DEFAULT 0,
      checkin_actual REAL DEFAULT 0,
      douyin_review_actual REAL DEFAULT 0,
      meituan_review_actual REAL DEFAULT 0,
      meituan_rating REAL DEFAULT NULL,
      meituan_negative_reviews INTEGER DEFAULT 0,
      meituan_negative_reason TEXT DEFAULT '',
      douyin_rating REAL DEFAULT NULL,
      douyin_negative_reviews INTEGER DEFAULT 0,
      douyin_negative_reason TEXT DEFAULT '',
      next_lighting_target REAL DEFAULT 0,
      next_checkin_target REAL DEFAULT 0,
      next_douyin_review_target REAL DEFAULT 0,
      next_meituan_review_target REAL DEFAULT 0,
      created_by INTEGER DEFAULT NULL,
      created_by_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(biz_date, store_id)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_group_buy_daily_summary_store_date ON group_buy_daily_summaries (store_id,biz_date)'); } catch {}
  // 抖音团购“分账明细-正向/退款-团购”：按核销时间、订单编号和核销门店 ID 保留原始流水。
  // BK 到手金额是最终结算口径；X:BI 只作为第三方费用明细展示和分类，不再重复扣减。
  db.run(`
    CREATE TABLE IF NOT EXISTS douyin_group_buy_settlement_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      source_row_key TEXT NOT NULL UNIQUE,
      douyin_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      income_date TEXT NOT NULL,
      order_no TEXT DEFAULT '',
      record_type TEXT DEFAULT '正向',
      product_name TEXT DEFAULT '',
      sale_amount REAL DEFAULT 0,
      net_amount REAL DEFAULT 0,
      third_party_fee REAL DEFAULT 0,
      fee_breakdown_json TEXT DEFAULT '{}',
      raw_json TEXT DEFAULT '{}',
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_douyin_group_settlement_date_store ON douyin_group_buy_settlement_records (income_date, store_id)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_douyin_group_settlement_platform_store ON douyin_group_buy_settlement_records (douyin_store_id, income_date)'); } catch {}

  // 淘宝闪购结算账单汇总（平台真实到账）：保留原始行（含整行 JSON 快照，未来新增列自动收录），
  // 每(门店, 账单日, 账单类型)一行；匹配门店后按“当日全部类型金额之和”计算真实实收，覆盖写入 business_revenue_records。
  db.run(`
    CREATE TABLE IF NOT EXISTS taobao_flash_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      account_id TEXT DEFAULT '',
      platform_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      bill_date TEXT NOT NULL,
      amount REAL DEFAULT 0,
      settle_date TEXT DEFAULT '',
      bill_type TEXT DEFAULT '',
      raw_json TEXT DEFAULT '',
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(platform_store_id, bill_date, bill_type)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_taobao_flash_bills_date ON taobao_flash_bills (bill_date)'); } catch {}

  // 美团外卖结算账单（平台真实到账，来自美团“订单明细”导出的 D交易类型 / R商家应收款）：
  // 每(美团门店, 账单日, 交易类型)一行（ΣR、交易笔数）；匹配门店后按“当日全部类型金额之和”计算真实实收，
  // 覆盖写入 business_revenue_records（source_type='platform'），保留收银机记录供双向核对。
  db.run(`
    CREATE TABLE IF NOT EXISTS meituan_delivery_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      meituan_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      bill_date TEXT NOT NULL,
      bill_type TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      transaction_count INTEGER DEFAULT 0,
      description_sample TEXT DEFAULT '',
      raw_json TEXT DEFAULT '',
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(meituan_store_id, bill_date, bill_type)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_meituan_delivery_bills_date ON meituan_delivery_bills (bill_date)'); } catch {}

  // 平台同名商品的“规格拆分”配置（可编辑数据，不含成本写死）：
  // 每个规格关联一个本地菜品 SKU（menu_item_id，成本实时取自 menu_items.cost），platform_price 为该规格平台售价。
  // 反解时用 (销量,销售额,platform_price) 整数求解各规格数量 → 成本 = Σ(规格数量 × 对应SKU成本)。
  try {
    const specCols = queryAll('PRAGMA table_info(business_product_spec_links)').map(c => c.name);
    if (specCols.length && !specCols.includes('menu_item_id')) {
      db.run('DROP TABLE IF EXISTS business_product_spec_links'); // 旧版含写死成本的表结构直接重建
    }
  } catch {}
  db.run(`
    CREATE TABLE IF NOT EXISTS business_product_spec_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT '美团外卖',
      external_product_name TEXT NOT NULL,
      menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
      platform_price REAL NOT NULL,
      sort_order INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(platform, external_product_name, menu_item_id)
    )
  `);

  // 仅有“当日总销量 + 总销售额”的平台（淘宝闪购）在存在多个规格组合时，
  // 由人工确认每个规格的数量。覆盖记录优先于自动反解，且只影响对应门店/日期/商品。
  db.run(`
    CREATE TABLE IF NOT EXISTS business_product_spec_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      biz_date TEXT NOT NULL,
      external_product_name TEXT NOT NULL,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(platform, store_id, biz_date, external_product_name, menu_item_id)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_product_spec_overrides_lookup ON business_product_spec_overrides(platform,store_id,biz_date,external_product_name)'); } catch {}

  // 美团外卖门店经营日报（含流量/转化指标：曝光/入店/下单、入店转化率、下单转化率）。
  // 求和字段与比率字段分开存储；聚合展示时 金额/人数/次数求和，转化率按加权口径重算（Σ入店÷Σ曝光等）。
  db.run(`
    CREATE TABLE IF NOT EXISTS meituan_delivery_operation_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      biz_date TEXT NOT NULL,
      meituan_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      source_province TEXT DEFAULT '',
      source_city TEXT DEFAULT '',
      source_district TEXT DEFAULT '',
      income_amount REAL DEFAULT 0,
      gross_amount REAL DEFAULT 0,
      order_count INTEGER DEFAULT 0,
      impression_users INTEGER DEFAULT 0,
      visit_users INTEGER DEFAULT 0,
      visit_rate REAL DEFAULT 0,
      order_rate REAL DEFAULT 0,
      impression_count INTEGER DEFAULT 0,
      ordering_users INTEGER DEFAULT 0,
      store_rating REAL DEFAULT 0,
      raw_json TEXT DEFAULT '',
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(meituan_store_id, biz_date)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_meituan_delivery_op_date_store ON meituan_delivery_operation_records (biz_date, store_id)'); } catch {}
  // 美团外卖「综合体验分」：5 分制，按门店/日期保存，范围查询时取每店最后一个有分数的日期。
  try { db.run('ALTER TABLE meituan_delivery_operation_records ADD COLUMN store_rating REAL DEFAULT 0'); } catch {}

  // 淘宝闪购、京东外卖运营日报：统一承接营业额、流量与转化字段；淘宝特有的打包、配送、索赔等构成单独留存。
  db.run(`
    CREATE TABLE IF NOT EXISTS delivery_operation_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      platform TEXT NOT NULL,
      biz_date TEXT NOT NULL,
      platform_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '', source_city TEXT DEFAULT '',
      income_amount REAL DEFAULT 0, gross_amount REAL DEFAULT 0, order_count INTEGER DEFAULT 0,
      product_sales_amount REAL DEFAULT 0, packing_fee REAL DEFAULT 0, delivery_fee REAL DEFAULT 0,
      claim_amount REAL DEFAULT 0, other_gross_amount REAL DEFAULT 0,
      impression_users INTEGER DEFAULT 0, visit_users INTEGER DEFAULT 0, ordering_users INTEGER DEFAULT 0, impression_count INTEGER DEFAULT 0,
      visit_rate REAL, order_rate REAL,
      store_rating REAL DEFAULT 0,
      raw_json TEXT DEFAULT '', store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL, store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(platform, platform_store_id, biz_date)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_delivery_operation_platform_date_store ON delivery_operation_records (platform,biz_date,store_id)'); } catch {}
  // 淘宝闪购「店铺评分」：与美团综合体验分同样是 5 分制；京东留空，不强行伪造评分。
  try { db.run('ALTER TABLE delivery_operation_records ADD COLUMN store_rating REAL DEFAULT 0'); } catch {}

  // 淘宝闪购“营业额收入单量”日报：账单汇总只提供费用和最终到账，日报才是营业额/优惠后收入/订单量的来源。
  // 保留两套原始数据后，可重复导入任一文件而不互相覆盖。
  db.run(`
    CREATE TABLE IF NOT EXISTS taobao_flash_daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES business_import_batches(id) ON DELETE SET NULL,
      platform_store_id TEXT NOT NULL,
      source_store_name TEXT DEFAULT '',
      biz_date TEXT NOT NULL,
      gross_amount REAL DEFAULT 0,
      product_sales_amount REAL DEFAULT 0,
      income_amount REAL DEFAULT 0,
      order_count INTEGER DEFAULT 0,
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
      store_name TEXT DEFAULT '',
      match_status TEXT DEFAULT 'unmatched',
      raw_json TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(platform_store_id, biz_date)
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_taobao_flash_daily_reports_date ON taobao_flash_daily_reports (biz_date)'); } catch {}
  try { db.run("ALTER TABLE taobao_flash_daily_reports ADD COLUMN product_sales_amount REAL DEFAULT 0"); } catch {}

  // ===== AI 自动导报表运行审计（与营业收入/订单/门店等业务表完全隔离）=====
  // 只承载 syncbot 结构化运行事件与运行汇总，不参与任何营收口径计算，也不被业务表引用。
  // 事件通过 /api/internal/syncbot/events（本机回环 + HMAC）写入；event_id 唯一 → 重复上报幂等。
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_key TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'meituan',
      report_type TEXT NOT NULL,
      business_date TEXT NOT NULL,
      phase TEXT DEFAULT '',
      status TEXT DEFAULT 'running',
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      failure_reason TEXT DEFAULT '',
      original_filename TEXT DEFAULT '',
      file_size INTEGER,
      sha256_prefix TEXT DEFAULT '',
      import_batch_id INTEGER,
      raw_store_count INTEGER,
      matched_store_count INTEGER,
      ready_to_push INTEGER DEFAULT 0,
      push_status TEXT DEFAULT '',
      imported INTEGER DEFAULT 0,
      pushed INTEGER DEFAULT 0,
      is_backfill INTEGER DEFAULT 0,
      reconstructed INTEGER DEFAULT 0,
      not_a_realtime_success INTEGER DEFAULT 0,
      evidence_json TEXT DEFAULT '{}',
      validation_json TEXT DEFAULT '{}',
      screenshot_count INTEGER DEFAULT 0,
      event_count INTEGER DEFAULT 0,
      first_event_at TEXT,
      last_event_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      run_id INTEGER REFERENCES sync_job_runs(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      platform TEXT DEFAULT 'meituan',
      report_type TEXT NOT NULL,
      business_date TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT DEFAULT '',
      at TEXT NOT NULL,
      seq INTEGER,
      detail_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_sync_job_runs_date ON sync_job_runs (business_date, report_type)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_sync_job_runs_status ON sync_job_runs (status, business_date)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_sync_job_runs_task ON sync_job_runs (task_id)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_sync_job_events_run ON sync_job_events (run_id, id)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_sync_job_events_task ON sync_job_events (task_id, id)'); } catch {}
  // 测试 fixture 标记：生产真实上报不得携带 is_test；清理能力只按 (is_test, test_run_id) 精确删除。
  try { db.run('ALTER TABLE sync_job_runs ADD COLUMN is_test INTEGER DEFAULT 0'); } catch {}
  try { db.run("ALTER TABLE sync_job_runs ADD COLUMN test_run_id TEXT DEFAULT ''"); } catch {}
  try { db.run('ALTER TABLE sync_job_events ADD COLUMN is_test INTEGER DEFAULT 0'); } catch {}
  try { db.run("ALTER TABLE sync_job_events ADD COLUMN test_run_id TEXT DEFAULT ''"); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_sync_job_runs_test ON sync_job_runs (is_test, test_run_id)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_sync_job_events_test ON sync_job_events (is_test, test_run_id)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_sync_job_events_date ON sync_job_events (business_date, report_type)'); } catch {}

  // 菜品销售明细：收银系统菜品销售流水（门店/菜品/数量/金额/优惠/收入/下单时间/退款）
  db.run(`
    CREATE TABLE IF NOT EXISTS dish_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_name TEXT DEFAULT '',
      product_code TEXT DEFAULT '',
      product_name TEXT DEFAULT '',
      spec TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      unit TEXT DEFAULT '',
      amount_total REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      income_amount REAL DEFAULT 0,
      order_time TEXT DEFAULT '',
      refunded TEXT DEFAULT '',
      order_no TEXT DEFAULT '',
      payment_detail TEXT DEFAULT '',
      refund_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 兼容旧库：清洗版新增字段自动补齐（订单编号/结账方式/退款金额）
  try { db.run('ALTER TABLE dish_sales ADD COLUMN order_no TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE dish_sales ADD COLUMN payment_detail TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE dish_sales ADD COLUMN refund_amount REAL DEFAULT 0'); } catch {}
  // 精简：移除后台不需要的字段（机构编码/取餐号/桌牌号/做法/加料/备注）
  try {
    const dishCols = queryAll('PRAGMA table_info(dish_sales)').map(c => c.name);
    for (const col of ['org_code', 'pickup_no', 'table_no', 'method', 'extra', 'remark']) {
      if (dishCols.includes(col)) run(`ALTER TABLE dish_sales DROP COLUMN ${col}`);
    }
  } catch {}
  db.run('CREATE INDEX IF NOT EXISTS idx_dish_sales_order_time ON dish_sales (order_time)');
  db.run('CREATE INDEX IF NOT EXISTS idx_dish_sales_store ON dish_sales (store_name)');
  db.run('CREATE INDEX IF NOT EXISTS idx_dish_sales_product ON dish_sales (product_code)');
  db.run('CREATE INDEX IF NOT EXISTS idx_dish_sales_refunded ON dish_sales (refunded)');
  db.run('CREATE INDEX IF NOT EXISTS idx_dish_sales_order_no ON dish_sales (order_no)');

  // 堂食菜品绑定：dish_sales 菜品（编码+名称+规格）关联本地菜品，用于抓取成本；规格参与唯一键，避免上庄/下庄混绑
  db.run(`
    CREATE TABLE IF NOT EXISTS dish_sales_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_code TEXT NOT NULL,
      product_name TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '',
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(product_code, product_name, spec)
    )
  `);
  // 迁移：旧版 (product_code, product_name) 唯一 → 新版加入 spec 参与唯一（规格区分）
  try {
    const oldSql = queryOne("SELECT sql FROM sqlite_master WHERE type='table' AND name='dish_sales_mappings'")?.sql || '';
    if (oldSql.includes('UNIQUE(product_code, product_name)') && !oldSql.includes('UNIQUE(product_code, product_name, spec)')) {
      run('ALTER TABLE dish_sales_mappings RENAME TO dish_sales_mappings_old');
      run(`
        CREATE TABLE dish_sales_mappings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_code TEXT NOT NULL,
          product_name TEXT NOT NULL,
          spec TEXT NOT NULL DEFAULT '',
          menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
          created_at TEXT DEFAULT (datetime('now','localtime')),
          updated_at TEXT DEFAULT (datetime('now','localtime')),
          UNIQUE(product_code, product_name, spec)
        )
      `);
      run(`INSERT INTO dish_sales_mappings (product_code, product_name, spec, menu_item_id, created_at, updated_at)
        SELECT product_code, COALESCE(NULLIF(product_name,''), product_code), COALESCE(NULLIF(spec,'--'), ''), menu_item_id, created_at, updated_at FROM dish_sales_mappings_old`);
      run('DROP TABLE dish_sales_mappings_old');
    }
  } catch {}

  db.run('CREATE INDEX IF NOT EXISTS idx_business_revenue_date_store ON business_revenue_records (biz_date, store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_business_revenue_source_channel ON business_revenue_records (source_type, channel, biz_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_business_composition_date_store ON business_revenue_compositions (biz_date, store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_business_ai_diagnosis_lookup ON business_ai_diagnoses (perspective_key, filter_signature)');
  db.run('CREATE INDEX IF NOT EXISTS idx_business_sales_date_store ON business_product_sales (biz_date, store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_business_mapping_platform ON business_product_mappings (platform, external_product_name)');
  db.run('CREATE INDEX IF NOT EXISTS idx_meituan_delivery_date_store ON meituan_delivery_daily_records (biz_date, store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_meituan_delivery_platform_store ON meituan_delivery_daily_records (meituan_store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_meituan_delivery_product_date_store ON meituan_delivery_product_records (biz_date, store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_meituan_delivery_product_platform_store ON meituan_delivery_product_records (meituan_store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_jd_delivery_date_store ON jd_delivery_daily_records (biz_date, store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_jd_delivery_platform_store ON jd_delivery_daily_records (jd_store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_jd_delivery_bill_date_store ON jd_delivery_bills (bill_date, store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_jd_delivery_product_date_store ON jd_delivery_product_records (biz_date, store_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_jd_delivery_product_platform_store ON jd_delivery_product_records (jd_store_id)');

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

  // ===== 自动同步与日报计划（默认全部 disabled；配置表 + 每业务日期幂等账本）=====
  db.run(`
    CREATE TABLE IF NOT EXISTS schedule_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sync_enabled   INTEGER NOT NULL DEFAULT 0,
      sync_time      TEXT    NOT NULL DEFAULT '01:05',
      report_enabled INTEGER NOT NULL DEFAULT 0,
      report_time    TEXT    NOT NULL DEFAULT '09:00',
      timezone       TEXT    NOT NULL DEFAULT 'Asia/Shanghai',
      version        INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT,
      updated_by     INTEGER,
      updated_by_name TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS schedule_config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      user_id INTEGER,
      user_name TEXT,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      note TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS schedule_job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job TEXT NOT NULL,
      business_date TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      send_attempts INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      detail_json TEXT,
      requested_at TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT,
      worker_id TEXT,
      UNIQUE (job, business_date)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_schedule_job_runs_status ON schedule_job_runs(status, job, business_date)');
  db.run(`
    INSERT OR IGNORE INTO schedule_config (id, sync_enabled, sync_time, report_enabled, report_time, timezone, version)
    VALUES (1, 0, '01:05', 0, '09:00', 'Asia/Shanghai', 1)
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
      phone TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('ALTER TABLE users ADD COLUMN phone TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE users ADD COLUMN store_id INTEGER DEFAULT NULL'); } catch {}
  try { db.run('ALTER TABLE users ADD COLUMN position_id INTEGER DEFAULT NULL'); } catch {}

  // 岗位是账号唯一的角色与权限来源；role 列仅兼容旧模块。
  db.run(`
    CREATE TABLE IF NOT EXISTS position_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      permissions_json TEXT DEFAULT '[]',
      is_system INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 可维护的推送通道：不同业务模块可以各自使用一套机器人、文案与图片配置。
  db.run(`
    CREATE TABLE IF NOT EXISTS push_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      webhook TEXT DEFAULT '',
      webhook_name TEXT DEFAULT '',
      content_template TEXT DEFAULT '',
      image_template TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`INSERT OR IGNORE INTO push_profiles (code,name,description,content_template,image_template,enabled)
    VALUES ('group_buy_daily','团购每日总结日报','数据分析 · 团购视角 · 每日总结专用日报。未填写独立机器人时，沿用企业设置中的默认机器人。','## {{title}}\n> 日期：{{date}}　|　已汇报门店：**{{store_count}}** 家\n\n{{body}}','',1)`);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_users_position_id ON users(position_id)'); } catch {}

  // 记账分类
  db.run(`
    CREATE TABLE IF NOT EXISTS bookkeeping_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS bookkeeping_subcategories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES bookkeeping_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 记账记录
  db.run(`
    CREATE TABLE IF NOT EXISTS bookkeeping_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL,
      store_name TEXT DEFAULT '',
      user_id INTEGER NOT NULL,
      user_name TEXT DEFAULT '',
      date TEXT NOT NULL,
      category_id INTEGER,
      category_name TEXT DEFAULT '',
      subcategory_id INTEGER,
      subcategory_name TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      images TEXT DEFAULT '[]',
      remark TEXT DEFAULT '',
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
      user_id INTEGER,
      visibility TEXT DEFAULT 'public',
      province TEXT DEFAULT '',
      city TEXT DEFAULT '',
      district TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('ALTER TABLE map_pins ADD COLUMN shape TEXT DEFAULT \'circle\''); } catch {}
  try { db.run('ALTER TABLE map_pins ADD COLUMN user_id INTEGER'); } catch {}
  try { db.run('ALTER TABLE map_pins ADD COLUMN visibility TEXT DEFAULT \'public\''); } catch {}
  try { db.run('ALTER TABLE map_pins ADD COLUMN province TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE map_pins ADD COLUMN city TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE map_pins ADD COLUMN district TEXT DEFAULT \'\''); } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS pin_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pin_id INTEGER NOT NULL,
      user_id INTEGER,
      username TEXT DEFAULT '',
      content TEXT NOT NULL,
      parent_id INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('ALTER TABLE pin_comments ADD COLUMN parent_id INTEGER DEFAULT NULL'); } catch {}
  try { db.run('ALTER TABLE pin_comments ADD COLUMN reply_to_name TEXT DEFAULT \'\''); } catch {}
  try { db.run('ALTER TABLE menu_items ADD COLUMN method TEXT'); } catch {}
  try { db.run('ALTER TABLE menu_items ADD COLUMN spec TEXT'); } catch {}
  try { db.run('ALTER TABLE menu_items ADD COLUMN dine_in_price REAL DEFAULT 0'); } catch {}
  try { db.run('ALTER TABLE menu_items ADD COLUMN member_price REAL DEFAULT 0'); } catch {}
  try { db.run('ALTER TABLE menu_items ADD COLUMN takeout_price REAL DEFAULT 0'); } catch {}
  try { db.run('ALTER TABLE menu_items ADD COLUMN spec_unit TEXT DEFAULT \'份\''); } catch {}
  try { db.run('ALTER TABLE menu_items ADD COLUMN spec_weight TEXT DEFAULT \'\''); } catch {}
  // 数据迁移：将旧 price 复制到 dine_in_price（仅对价格>0且堂食价为0的记录）
  try { db.run("UPDATE menu_items SET dine_in_price=price, spec_unit='份' WHERE price>0 AND dine_in_price=0"); } catch {}

  // 菜品成本构成：每行材料按用量 × 单位成本计算小计，汇总回写 menu_items.cost
  db.run(`
    CREATE TABLE IF NOT EXISTS menu_cost_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      ingredient_name TEXT NOT NULL,
      quantity REAL DEFAULT 1,
      unit TEXT DEFAULT '份',
      unit_cost REAL DEFAULT 0,
      subtotal REAL DEFAULT 0,
      component_menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('ALTER TABLE menu_cost_components ADD COLUMN component_menu_item_id INTEGER'); } catch {}
  try { db.run("ALTER TABLE menu_cost_components ADD COLUMN choice_group TEXT DEFAULT ''"); } catch {}
  try { db.run('ALTER TABLE menu_cost_components ADD COLUMN choice_min INTEGER DEFAULT 1'); } catch {}
  try { db.run('ALTER TABLE menu_cost_components ADD COLUMN choice_max INTEGER DEFAULT 1'); } catch {}

  // ===== 菜品核算（禽类消耗反推）=====
  // 三层模型：禽类档案（一只禽）→ 整只出成拆解（一只禽出什么部位各几个）→ 菜品耗用（每份菜吃掉几个部位）
  // 消耗只数 = Σ( 菜品销量 × 每份耗用部位数 ÷ 一只出该部位数 )
  db.run(`
    CREATE TABLE IF NOT EXISTS poultry_birds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      animal TEXT NOT NULL DEFAULT '鹅',
      breed_name TEXT NOT NULL,
      net_weight_kg REAL DEFAULT 0,
      unit_cost REAL DEFAULT 0,
      status TEXT DEFAULT '启用',
      remark TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS poultry_yields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bird_id INTEGER NOT NULL REFERENCES poultry_birds(id) ON DELETE CASCADE,
      part_name TEXT NOT NULL,
      parts_per_bird REAL DEFAULT 1,
      part_weight_g REAL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      remark TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_poultry_yields_bird ON poultry_yields (bird_id)');
  // 部位类别：决定它在核算里怎么参与 ——
  //   身体(body)：上庄/下庄/腿/腩/肉 等，都是同一块身体的不同卖法，互相抢鸟，需求要「相加」
  //   副产品(byproduct)：翅/头颈/掌/杂 等，一只鸟同时附带产出，不额外占鸟，需求取「最大」（超出身体需求时才成为瓶颈）
  try { db.run("ALTER TABLE poultry_yields ADD COLUMN part_kind TEXT DEFAULT '身体'"); } catch {}
  // 迁移：按部位名预判类别，避免历史数据全部落成「身体」导致口径突变；用户在页面上可随时改正
  try {
    db.run(`UPDATE poultry_yields SET part_kind='副产品'
      WHERE COALESCE(part_kind,'') <> '副产品'
        AND (part_name LIKE '%翅%' OR part_name LIKE '%战斧%' OR part_name LIKE '%头%'
             OR part_name LIKE '%颈%' OR part_name LIKE '%掌%' OR part_name LIKE '%爪%'
             OR part_name LIKE '%杂%' OR part_name LIKE '%肝%' OR part_name LIKE '%肠%'
             OR part_name LIKE '%汁%')`);
  } catch {}

  // 图示区域 / 资源角色（2026-09-12 引入）
  // 为什么落库而不是运行时猜：核算要知道一个部位消耗哪些「限量资源」（每只禽的腿/翅/头颈件数固定），
  // 靠部位名正则猜既不稳、改名就失效。落库后正则只用于「新增部位时推荐区域」，用户可随时改。
  //   whole 整只 / half 半只 / upper 上庄 / lower 下庄 / leg 腿 / wing 翅(战斧)
  //   head_neck 头颈 / belly 腩 / meat 切片肉 / other 其他
  try { db.run("ALTER TABLE poultry_yields ADD COLUMN zone_code TEXT DEFAULT ''"); } catch {}
  try {
    db.run(`UPDATE poultry_yields SET zone_code = CASE
      WHEN part_name LIKE '%头%' OR part_name LIKE '%颈%' THEN 'head_neck'
      WHEN part_name LIKE '%翅%' OR part_name LIKE '%战斧%' THEN 'wing'
      WHEN part_name LIKE '%上庄%' THEN 'upper'
      WHEN part_name LIKE '%下庄%' THEN 'lower'
      WHEN part_name LIKE '%腩%' THEN 'belly'
      WHEN part_name LIKE '%腿%' OR part_name LIKE '%肶%' THEN 'leg'
      WHEN part_name LIKE '%半只%' THEN 'half'
      WHEN part_name LIKE '%整只%' OR part_name LIKE '%一只%' THEN 'whole'
      WHEN part_name LIKE '%肉%' OR part_name LIKE '%小料%' OR part_name LIKE '%双拼%'
        OR part_name LIKE '%三宝%' OR part_name LIKE '%片%'
        OR part_name LIKE '%单份%' OR part_name LIKE '%三拼%' OR part_name LIKE '%拼量%'
        THEN 'meat'
      ELSE 'other' END
      WHERE COALESCE(zone_code,'') = ''`);
  } catch {}

  // 出成口径模式（2026-09-12 引入）：把「一只出几份」的语义显性化，避免运营混淆
  //   fraction 份量型：一只可出 N 份（一份占整只 1/N）—— 上庄 4 / 半只 2 / 整只 1
  //   count    件数型：一只物理产出 N 件 —— 头颈 1 / 翅 2 / 下庄 2
  //   weight   重量型  ：一只可出 N 克（三期做切片肉池时启用）
  // 注意：fraction 与 count 的计算公式相同（需求 ÷ N），引入本字段不改变任何现有结果，只把语义说清楚。
  try { db.run("ALTER TABLE poultry_yields ADD COLUMN yield_mode TEXT DEFAULT ''"); } catch {}
  try {
    db.run(`UPDATE poultry_yields SET yield_mode = CASE
      WHEN COALESCE(part_kind,'') = '副产品' THEN 'count'
      ELSE 'fraction' END
      WHERE COALESCE(yield_mode,'') = ''`);
  } catch {}

  // 菜品耗用：一个菜品可挂多条（双拼/套餐天然支持），UNIQUE 保证同一部位不重复挂
  db.run(`
    CREATE TABLE IF NOT EXISTS poultry_dish_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      yield_id INTEGER NOT NULL REFERENCES poultry_yields(id) ON DELETE CASCADE,
      usage_qty REAL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(menu_item_id, yield_id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_poultry_usage_menu ON poultry_dish_usage (menu_item_id)');

  // 实际消耗只数：手动录入，按「门店 + 日期 + 禽类」唯一，用于理论 vs 实际消耗对比与校准。
  //
  // 口径演进（2026-09-15）：
  //   ① 「按月」→「按天」：消耗逐日发生；按天录入后对比直接按起止日期精确求和，不再有"非整月口径不对齐"；
  //   ② 「采购」→「消耗」：采购量（进货）受库存进出影响（实际消耗 = 期初剩余 + 采购 − 期末剩余），
  //      与「理论消耗」口径不一致，只能当参考；真正参与对比/校准的是「实际消耗只数」。
  //
  // 旧表 poultry_purchases 里只有孤儿残留（禽类已删的 12,000 只幽灵采购），无真实数据，直接弃用重建。
  try { db.run('DROP TABLE IF EXISTS poultry_purchases'); } catch {}
  db.run(`
    CREATE TABLE IF NOT EXISTS poultry_consumption (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL,
      store_name TEXT DEFAULT '',
      date TEXT NOT NULL,
      bird_id INTEGER NOT NULL REFERENCES poultry_birds(id) ON DELETE CASCADE,
      quantity REAL DEFAULT 0,
      remark TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(store_id, date, bird_id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_poultry_consumption_date ON poultry_consumption (date)');

  // ===== 禽类菜范围（覆盖率分母的判定依据，用户可维护）=====
  // 背景：覆盖率原来的分母是「全部销量」，包含柠檬茶 / 白米饭 / 打包盒等永远不需要配禽类系数的品类，
  //       所以永远到不了 90%，不适合当风控可信度门槛。现在拆成两个数：
  //         ① 禽类菜品覆盖率（分母 = 禽类菜销量）—— 风控可信度看这个
  //         ② 全量覆盖率（保留作参考）
  // 「哪些菜算禽类菜」的判定做成可维护配置，避免为边界情况（如咸鸭蛋含「鸭」其实是蛋制品）改代码：
  //   poultry_scope_keywords  关键词表：include = 算禽类菜 / exclude = 不算（exclude 优先）
  //   poultry_scope_dishes    显式名单：逐个菜品指定，优先级高于关键词
  db.run(`
    CREATE TABLE IF NOT EXISTS poultry_scope_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'include',
      enabled INTEGER DEFAULT 1,
      note TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(keyword, kind)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS poultry_scope_dishes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL,
      in_scope INTEGER DEFAULT 1,
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(menu_item_id)
    )
  `);
  // 首次初始化默认关键词；表非空时不动（用户维护过的配置优先，避免每次启动被覆盖）
  try {
    const scopeInit = db.exec('SELECT COUNT(*) FROM poultry_scope_keywords');
    const scopeTotal = scopeInit.length && scopeInit[0].values.length ? Number(scopeInit[0].values[0][0]) : 0;
    if (!scopeTotal) {
      db.run(`INSERT INTO poultry_scope_keywords (keyword, kind, note) VALUES
        ('鹅', 'include', ''),
        ('鸭', 'include', ''),
        ('鸡', 'include', ''),
        ('蛋', 'exclude', '蛋制品（咸鸭蛋 / 鸡蛋）不参与禽类消耗，无需配系数')`);
    }
  } catch {}

  // 菜品模板
  db.run(`
    CREATE TABLE IF NOT EXISTS menu_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      remark TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS menu_template_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL REFERENCES menu_templates(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT,
      dine_in_price REAL DEFAULT 0,
      member_price REAL DEFAULT 0,
      takeout_price REAL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS store_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL,
      user_id INTEGER,
      username TEXT DEFAULT '',
      content TEXT NOT NULL,
      parent_id INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('ALTER TABLE store_comments ADD COLUMN parent_id INTEGER DEFAULT NULL'); } catch {}
  try { db.run('ALTER TABLE store_comments ADD COLUMN reply_to_name TEXT DEFAULT \'\''); } catch {}

  // ===== 协同事项管理 =====
  db.run(`
    CREATE TABLE IF NOT EXISTS collab_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_no TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      deadline TEXT,
      start_time TEXT,
      participants TEXT DEFAULT '[]',
      participants_name TEXT DEFAULT '[]',
      status TEXT DEFAULT '待开始',
      completion_note TEXT DEFAULT '',
      completed_at TEXT,
      created_by INTEGER NOT NULL,
      created_by_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 迁移旧表：添加新列（忽略已存在的列错误）
  try { db.run("ALTER TABLE collab_issues ADD COLUMN start_time TEXT"); } catch {}
  try { db.run("ALTER TABLE collab_issues ADD COLUMN participants TEXT DEFAULT '[]'"); } catch {}
  try { db.run("ALTER TABLE collab_issues ADD COLUMN participants_name TEXT DEFAULT '[]'"); } catch {}
  // 将旧的 assignee_id/assignee_name 迁移到 participants
  try {
    db.run(`UPDATE collab_issues SET participants = CASE WHEN assignee_id IS NOT NULL THEN '['||assignee_id||']' ELSE '[]' END WHERE participants = '[]'`);
    db.run(`UPDATE collab_issues SET participants_name = CASE WHEN assignee_name IS NOT NULL AND assignee_name != '' THEN '["'||assignee_name||'"]' ELSE '[]' END WHERE participants_name = '[]'`);
  } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS collab_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES collab_issues(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      user_name TEXT DEFAULT '',
      content TEXT NOT NULL,
      images TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run("ALTER TABLE collab_replies ADD COLUMN reply_type TEXT DEFAULT 'progress'"); } catch {}
  try { db.run("ALTER TABLE collab_replies ADD COLUMN parent_id INTEGER"); } catch {}
  try { db.run("ALTER TABLE collab_replies ADD COLUMN reply_to_user_id INTEGER"); } catch {}
  try { db.run("ALTER TABLE collab_replies ADD COLUMN reply_to_name TEXT DEFAULT ''"); } catch {}
  try { db.run("ALTER TABLE collab_replies ADD COLUMN completion_status TEXT DEFAULT ''"); } catch {}
  try { db.run("ALTER TABLE collab_replies ADD COLUMN reviewed_by INTEGER"); } catch {}
  try { db.run("ALTER TABLE collab_replies ADD COLUMN reviewed_at TEXT"); } catch {}
  try { db.run("ALTER TABLE collab_replies ADD COLUMN review_note TEXT DEFAULT ''"); } catch {}
  try { db.run("ALTER TABLE collab_replies ADD COLUMN edited_at TEXT"); } catch {}
  try { db.run("ALTER TABLE collab_issues ADD COLUMN terminated_at TEXT"); } catch {}
  try { db.run("ALTER TABLE collab_issues ADD COLUMN visibility TEXT DEFAULT 'public'"); } catch {}
  try { db.run("ALTER TABLE collab_issues ADD COLUMN archived_at TEXT"); } catch {}
  try { db.run("ALTER TABLE collab_issues ADD COLUMN participants_history TEXT DEFAULT '[]'"); } catch {}

  db.run(`CREATE TABLE IF NOT EXISTS collab_extensions (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL, old_deadline TEXT, new_deadline TEXT NOT NULL, reason TEXT NOT NULL, created_by INTEGER NOT NULL, created_by_name TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')))`);

  // ===== 小程序（/api/mp）专用表 =====
  // 身份映射：一个业务账号可挂多个身份源（password / openid / wxwork），便于个人测试期切企业微信免登
  db.run(`
    CREATE TABLE IF NOT EXISTS mp_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_type TEXT NOT NULL,
      identity_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      union_id TEXT DEFAULT '',
      nickname TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      store_id INTEGER,
      status TEXT DEFAULT 'active',
      last_login_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_mp_identities_type_id ON mp_identities(identity_type, identity_id)'); } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_mp_identities_user ON mp_identities(user_id)'); } catch {}

  // 小程序操作审计（移动端写入留痕）
  db.run(`
    CREATE TABLE IF NOT EXISTS mp_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      identity_type TEXT DEFAULT '',
      action TEXT DEFAULT '',
      target TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
}

/** 同步短等待（ms）— 用于 Windows 文件锁冲突时的退避重试 */
function sleepSync(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* 忙等，保持 save 同步语义 */ }
}

/** 持久化到磁盘 — 以原始二进制写入，避免编码转换污染 SQLite 数据 */
function save() {
  if (!db) return;
  const data = db.export();
  const buf = Buffer.from(data);
  // Windows 上防病毒/索引服务可能瞬时锁定数据库文件，写入失败时短暂退避重试
  for (let attempt = 1; ; attempt++) {
    try {
      fs.writeFileSync(DB_PATH, buf, { encoding: 'binary' });
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      sleepSync(250 * attempt);
    }
  }
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
    { name: '陈志强', role: '店长', status: '在职', phone: '13800138001', gender: '男', age: 35, entry_date: '2024-03-15', hire_date: '2024-03-15', hire_type: '全职', position: '店长', salary: 12000, remark: '创始店长' },
    { name: '张三', role: '店员', status: '在职', phone: '13800138002', gender: '男', age: 28, entry_date: '2024-03-15', hire_date: '2024-03-15', hire_type: '全职', position: '厨师', salary: 8000, remark: '' },
    { name: '李四', role: '店员', status: '在职', phone: '13800138003', gender: '女', age: 24, entry_date: '2024-03-20', hire_date: '2024-03-20', hire_type: '全职', position: '服务员', salary: 5000, remark: '' },
    { name: '王五', role: '店员', status: '在职', phone: '13800138004', gender: '女', age: 22, entry_date: '2024-06-01', hire_date: '2024-06-01', hire_type: '兼职', position: '服务员', salary: 3000, remark: '' },
    { name: '赵六', role: '店员', status: '离职', phone: '13800138005', gender: '男', age: 32, entry_date: '2024-05-01', hire_date: '2024-05-01', hire_type: '全职', position: '厨师', salary: 7500, leave_date: '2025-12-31', remark: '回老家发展' },
  ]},
  { store_name: '鹅太公烧鹅（坂田店）', employees: [
    { name: '林伟明', role: '店长', status: '在职', phone: '13800138011', gender: '男', age: 33, entry_date: '2024-06-01', hire_date: '2024-06-01', hire_type: '全职', position: '店长', salary: 11000, remark: '' },
    { name: '钱七', role: '店员', status: '在职', phone: '13800138012', gender: '男', age: 27, entry_date: '2024-06-01', hire_date: '2024-06-01', hire_type: '全职', position: '厨师', salary: 7500, remark: '' },
    { name: '孙八', role: '店员', status: '在职', phone: '13800138013', gender: '女', age: 23, entry_date: '2024-07-15', hire_date: '2024-07-15', hire_type: '全职', position: '服务员', salary: 4800, remark: '' },
    { name: '周小红', role: '店员', status: '离职', phone: '13800138014', gender: '女', age: 20, entry_date: '2024-08-01', hire_date: '2024-08-01', hire_type: '兼职', position: '收银员', salary: 3500, leave_date: '2025-02-28', remark: '返校读书' },
  ]},
  { store_name: '鹅太公烧鹅（欧景花园店）', employees: [
    { name: '黄海龙', role: '店长', status: '在职', phone: '13800138021', gender: '男', age: 36, entry_date: '2024-08-20', hire_date: '2024-08-20', hire_type: '全职', position: '店长', salary: 11000, remark: '' },
    { name: '刘芳', role: '店员', status: '在职', phone: '13800138022', gender: '女', age: 26, entry_date: '2024-08-20', hire_date: '2024-08-20', hire_type: '全职', position: '厨师', salary: 7800, remark: '' },
    { name: '吴明', role: '店员', status: '在职', phone: '13800138023', gender: '男', age: 22, entry_date: '2024-09-01', hire_date: '2024-09-01', hire_type: '全职', position: '服务员', salary: 4800, remark: '' },
    { name: '郑丽', role: '店员', status: '在职', phone: '13800138024', gender: '女', age: 25, entry_date: '2024-10-15', hire_date: '2024-10-15', hire_type: '全职', position: '收银员', salary: 5000, remark: '' },
  ]},
  { store_name: '鹅太公烧鹅（普宁溪尾店）', employees: [
    { name: '陈文斌', role: '店长', status: '在职', phone: '13800138031', gender: '男', age: 34, entry_date: '2024-11-01', hire_date: '2024-11-01', hire_type: '全职', position: '店长', salary: 10000, remark: '' },
    { name: '许美玲', role: '店员', status: '在职', phone: '13800138032', gender: '女', age: 29, entry_date: '2024-11-01', hire_date: '2024-11-01', hire_type: '全职', position: '厨师', salary: 7200, remark: '' },
    { name: '马小军', role: '店员', status: '在职', phone: '13800138033', gender: '男', age: 21, entry_date: '2024-11-15', hire_date: '2024-11-15', hire_type: '全职', position: '服务员', salary: 4500, remark: '' },
  ]},
  { store_name: '鹅太公烧鹅（博罗店）', employees: [
    { name: '何志远', role: '店长', status: '在职', phone: '13800138041', gender: '男', age: 37, entry_date: '2025-01-10', hire_date: '2025-01-10', hire_type: '全职', position: '店长', salary: 10500, remark: '' },
    { name: '吕佳慧', role: '店员', status: '在职', phone: '13800138042', gender: '女', age: 25, entry_date: '2025-01-10', hire_date: '2025-01-10', hire_type: '全职', position: '厨师', salary: 7500, remark: '' },
    { name: '施大伟', role: '店员', status: '在职', phone: '13800138043', gender: '男', age: 23, entry_date: '2025-01-15', hire_date: '2025-01-15', hire_type: '全职', position: '服务员', salary: 4600, remark: '' },
    { name: '张丽丽', role: '店员', status: '在职', phone: '13800138044', gender: '女', age: 27, entry_date: '2025-02-01', hire_date: '2025-02-01', hire_type: '全职', position: '洗碗工', salary: 4200, remark: '' },
  ]},
  { store_name: '鹅太公烧鹅（江北旺岗店）', employees: [
    { name: '谢国栋', role: '店长', status: '在职', phone: '13800138051', gender: '男', age: 32, entry_date: '2025-03-01', hire_date: '2025-03-01', hire_type: '全职', position: '店长', salary: 11500, remark: '' },
    { name: '韩雪', role: '店员', status: '在职', phone: '13800138052', gender: '女', age: 26, entry_date: '2025-03-01', hire_date: '2025-03-01', hire_type: '全职', position: '厨师', salary: 8000, remark: '' },
    { name: '唐俊杰', role: '店员', status: '在职', phone: '13800138053', gender: '男', age: 24, entry_date: '2025-03-10', hire_date: '2025-03-10', hire_type: '全职', position: '服务员', salary: 5000, remark: '' },
    { name: '冯晓燕', role: '店员', status: '在职', phone: '13800138054', gender: '女', age: 22, entry_date: '2025-04-01', hire_date: '2025-04-01', hire_type: '全职', position: '切配工', salary: 5500, remark: '' },
  ]},
  { store_name: '鹅太公烧鹅（麦地店）', employees: [
    { name: '董建国', role: '店长', status: '在职', phone: '13800138061', gender: '男', age: 38, entry_date: '2025-06-01', hire_date: '2025-06-01', hire_type: '全职', position: '店长', salary: 10000, remark: '筹建负责人' },
    { name: '程海燕', role: '店员', status: '在职', phone: '13800138062', gender: '女', age: 28, entry_date: '2025-06-15', hire_date: '2025-06-15', hire_type: '全职', position: '厨师', salary: 7000, remark: '开业前培训中' },
  ]},
  { store_name: '鹅太公烧鹅（下埔店）', employees: [
    { name: '蔡明辉', role: '店长', status: '在职', phone: '13800138071', gender: '男', age: 40, entry_date: '2025-07-01', hire_date: '2025-07-01', hire_type: '全职', position: '店长', salary: 10000, remark: '筹建负责人' },
  ]},
];

const SEED_MENU = [
  { name: '招牌烧鹅', category: '烧腊', price: 68, dine_in_price: 68, member_price: 58, takeout_price: 72, cost: 28, expiry_days: 2, spec_unit: '份', spec_weight: '100g' },
  { name: '蜜汁叉烧', category: '烧腊', price: 48, dine_in_price: 48, member_price: 40, takeout_price: 52, cost: 18, expiry_days: 2, spec_unit: '份', spec_weight: '100g' },
  { name: '白切鸡', category: '烧腊', price: 58, dine_in_price: 58, member_price: 48, takeout_price: 62, cost: 22, expiry_days: 1, spec_unit: '份', spec_weight: '100g' },
  { name: '烧鸭', category: '烧腊', price: 45, dine_in_price: 45, member_price: 38, takeout_price: 48, cost: 16, expiry_days: 2, spec_unit: '份', spec_weight: '100g' },
  { name: '鹅腿饭', category: '快餐', price: 35, dine_in_price: 35, member_price: 30, takeout_price: 38, cost: 14, expiry_days: 1, spec_unit: '份', spec_weight: '60g' },
  { name: '叉烧饭', category: '快餐', price: 28, dine_in_price: 28, member_price: 24, takeout_price: 32, cost: 11, expiry_days: 1, spec_unit: '份', spec_weight: '60g' },
  { name: '烧鹅濑粉', category: '粉面', price: 25, dine_in_price: 25, member_price: 22, takeout_price: 28, cost: 9, expiry_days: 1, spec_unit: '碗', spec_weight: '' },
  { name: '老火靓汤', category: '汤品', price: 18, dine_in_price: 18, member_price: 15, takeout_price: 20, cost: 5, expiry_days: 1, spec_unit: '盅', spec_weight: '' },
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
        `INSERT INTO employees (store_id,name,role,status,phone,gender,age,entry_date,hire_date,hire_type,position,salary,leave_date,remark,store_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sid, e.name, e.role || '店员', e.status, e.phone || '', e.gender || '', e.age || 0,
         e.entry_date || e.hire_date || '', e.hire_date, e.hire_type, e.position, e.salary,
         e.leave_date || null, e.remark || '', se.store_name]
      );
    }
  }

  // 菜品（关联到龙岗万科店）
  const sid1 = storeMap['鹅太公烧鹅（龙岗万科店）'];
  if (sid1) {
    for (const m of SEED_MENU) {
      insert(`INSERT INTO menu_items (store_id,name,category,price,dine_in_price,member_price,takeout_price,cost,expiry_days,spec_unit,spec_weight) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [sid1, m.name, m.category, m.price, m.dine_in_price, m.member_price, m.takeout_price, m.cost, m.expiry_days, m.spec_unit, m.spec_weight]);
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

/** 重新播种员工测试数据（删除旧数据再插入） */
function reseedStaff() {
  db.run('DELETE FROM employees');
  // 重建 store_name → store_id 映射
  const stores = queryAll('SELECT id, store_name FROM stores');
  const storeMap = {};
  for (const s of stores) storeMap[s.store_name] = s.id;

  let count = 0;
  for (const se of SEED_EMPLOYEES) {
    const sid = storeMap[se.store_name];
    if (!sid) continue;
    for (const e of se.employees) {
      insert(
        `INSERT INTO employees (store_id,name,role,status,phone,gender,age,entry_date,hire_date,hire_type,position,salary,leave_date,remark,store_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [sid, e.name, e.role || '店员', e.status, e.phone || '', e.gender || '', e.age || 0,
         e.entry_date || e.hire_date || '', e.hire_date, e.hire_type, e.position, e.salary,
         e.leave_date || null, e.remark || '', se.store_name]
      );
      count++;
    }
  }
  save();
  return count;
}

module.exports = { init, save, exec, queryAll, queryOne, insert, run, close, seed, reseedStaff };
