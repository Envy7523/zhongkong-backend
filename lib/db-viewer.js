/**
 * 数据库查看器（开发辅助工具）
 * 挂载点：/api/db-viewer/*
 *
 * 设计原则：
 *   1. **只读**：所有接口只发 SELECT；不提供任何写操作。
 *   2. **标识符白名单**：表名/字段名必须先在 sqlite_master / PRAGMA 里校验存在，再拼进 SQL；
 *      值一律走参数绑定 —— 从根上避免注入。
 *   3. **文件访问越界防护**：解析真实路径后必须仍在项目目录内，且屏蔽 .git / node_modules /
 *      config.json（含企业微信凭据）/ 私钥 / 数据库二进制本身。
 *   4. **SQL 控制台**：仅允许单条 SELECT/WITH，屏蔽一切写与 DDL/PRAGMA，并强制加 LIMIT。
 *
 * 提供的接口：
 *   GET  /api/db-viewer/overview              库文件信息 + 表总览
 *   GET  /api/db-viewer/tables                全部表（行数、字段数、索引、分类）
 *   GET  /api/db-viewer/table/:name           单表结构 + 分页数据（支持排序/关键字过滤）
 *   GET  /api/db-viewer/refs?table=X          某表被哪些代码/接口引用（静态扫描）
 *   GET  /api/db-viewer/feature-map           功能→接口→数据 的完整链路
 *   GET  /api/db-viewer/files?dir=            文件浏览器
 *   GET  /api/db-viewer/file?path=            单个文件内容/下载
 *   POST /api/db-viewer/query                 只读 SQL 控制台
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.ZK_DB_PATH ? path.resolve(process.env.ZK_DB_PATH) : path.join(ROOT, 'data', 'database.sqlite');

const MAX_PAGE_SIZE = 200;
const MAX_SQL_ROWS = 1000;
const MAX_INLINE_FILE = 2 * 1024 * 1024; // 2MB 以内可在线预览

// 文件浏览器允许的根目录（相对项目根）
const FILE_ROOTS = ['data', 'tools', 'docs', 'lib', 'frontend/src', 'miniprogram/src', 'demo'];
// 永不暴露的文件/目录
const FILE_DENY = [
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
  /config\.json$/i,
  /_prodkey/i,
  /\.sqlite(-wal|-shm)?$/i,
  /\.env/i,
  /SERVER_ACCESS/i,
];

// ==================== 工具 ====================

function tableNames() {
  return db.queryAll("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name);
}
function tableExists(name) {
  return !!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
}
function columnsOf(table) {
  return db.queryAll('PRAGMA table_info("' + table + '")');
}
function indexesOf(table) {
  return db.queryAll("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", [table]);
}
function rowCount(table) {
  try { return Number(db.queryOne('SELECT COUNT(*) c FROM "' + table + '"').c); } catch { return -1; }
}

/** 按前缀猜业务分类，便于在界面上分组 */
function classify(name) {
  const rules = [
    [/^poultry_/, '鸡鸭鹅核算'],
    [/^business_revenue/, '营收（对账口径）'],
    [/^business_product/, '商品映射'],
    [/^business_import/, '导入批次'],
    [/^business_ai/, 'AI 诊断'],
    [/^pos_/, '收银机数据'],
    [/^(meituan|douyin|jd|taobao)_/, '第三方平台'],
    [/^delivery_/, '外卖运营'],
    [/^bookkeeping/, '记账本'],
    [/^collab_/, '协同事项'],
    [/^mp_/, '小程序'],
    [/^menu_/, '菜品'],
    [/^(store|stores)/, '门店'],
    [/^cost_/, '成本核算'],
    [/^daily_/, '日报'],
    [/^dish_/, '菜品销售'],
    [/^users?$/, '账号'],
    [/^(push_logs|map_pins|pin_comments|employees)$/, '其他业务'],
  ];
  for (const [re, label] of rules) if (re.test(name)) return label;
  return '其他';
}

/** 安全分页参数 */
function pageArgs(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize, 10) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// ==================== 代码扫描：功能 → 接口 → 数据 ====================

let _scanCache = null;
let _scanAt = 0;
const SCAN_TTL = 30 * 1000;

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

/** 收集项目内的源码文件（后端 + 前端） */
function sourceFiles() {
  const out = [];
  const push = (p, kind) => { if (fs.existsSync(p)) out.push({ path: p, kind }); };
  push(path.join(ROOT, 'server.js'), 'backend-route');
  // lib 递归（含 lib/mp/ 等子目录，否则子目录里的表引用会被漏掉）
  const walkJs = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkJs(full);
      else if (e.name.endsWith('.js')) out.push({ path: full, kind: 'backend-lib' });
    }
  };
  walkJs(path.join(ROOT, 'lib'));
  const apiIndex = path.join(ROOT, 'frontend', 'src', 'api', 'index.js');
  push(apiIndex, 'frontend-api');
  const walkVue = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkVue(full);
      else if (e.name.endsWith('.vue')) out.push({ path: full, kind: 'frontend-view' });
    }
  };
  walkVue(path.join(ROOT, 'frontend', 'src', 'views'));
  walkVue(path.join(ROOT, 'frontend', 'src', 'components'));
  return out;
}

/** 扫描：表 → 引用点；接口 → 表；页面 → 接口 */
function buildScan() {
  const now = Date.now();
  if (_scanCache && now - _scanAt < SCAN_TTL) return _scanCache;

  const tables = tableNames();
  const tableSet = new Set(tables);
  const tableRefs = {};   // 表 → [{file,line,scope,snippet}]
  const endpointRefs = {}; // 接口 → {file,line,tables:Set}
  const apiPaths = {};     // 前端 api 函数名 → 路径
  const viewApis = {};     // 页面文件 → [api 函数名]

  for (const t of tables) tableRefs[t] = [];

  // ---- 前端：api/index.js 的方法名 → 路径 ----
  const apiFile = sourceFiles().find(f => f.kind === 'frontend-api');
  if (apiFile) {
    const txt = readSafe(apiFile.path);
    const re = /export\s+const\s+(\w+)\s*=\s*\([^)]*\)\s*=>\s*[\s\S]{0,200}?['"`](\/api[^'"`]*)['"`]/g;
    let m;
    while ((m = re.exec(txt))) {
      apiPaths[m[1]] = m[2].split('?')[0].replace(/\$\{[^}]+\}/g, ':id').replace(/\/+$/, '');
    }
  }

  // ---- 前端：页面里调用了哪些 api 函数 ----
  for (const f of sourceFiles()) {
    if (f.kind !== 'frontend-view') continue;
    const txt = readSafe(f.path);
    const called = new Set();
    for (const name of Object.keys(apiPaths)) {
      if (new RegExp('\\b' + name + '\\s*\\(').test(txt)) called.add(name);
    }
    if (called.size) viewApis[path.relative(ROOT, f.path).replace(/\\/g, '/')] = [...called];
  }

  // ---- 后端：按路由切块，统计每个接口用到的表 ----
  const srvPath = path.join(ROOT, 'server.js');
  const srv = readSafe(srvPath);
  const lines = srv.split(/\r?\n/);
  const routeRe = /app\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/;
  const marks = [];
  lines.forEach((l, i) => { const m = routeRe.exec(l); if (m) marks.push({ i, method: m[1].toUpperCase(), path: m[2] }); });
  marks.forEach((mk, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1].i : lines.length;
    const body = lines.slice(mk.i, Math.min(end, mk.i + 400)).join('\n');
    const used = new Set();
    const tre = /(?:FROM|INTO|UPDATE|JOIN)\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/g;
    let m;
    while ((m = tre.exec(body))) if (tableSet.has(m[1])) used.add(m[1]);
    if (!used.size) return;
    const key = mk.method + ' ' + mk.path;
    endpointRefs[key] = { file: 'server.js', line: mk.i + 1, tables: [...used] };
    for (const t of used) {
      tableRefs[t].push({ file: 'server.js', line: mk.i + 1, scope: key, snippet: lines[mk.i].trim().slice(0, 160) });
    }
  });

  // ---- 后端 lib 模块（含子目录）：函数级引用 ----
  for (const f of sourceFiles()) {
    if (f.kind !== 'backend-lib') continue;
    const rel = path.relative(ROOT, f.path).replace(/\\/g, '/');
    const txt = readSafe(f.path);
    if (!txt) continue;
    const fl = txt.split(/\r?\n/);
    const fnRe = /^(?:async\s+)?function\s+(\w+)|^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/;
    const fmarks = [];
    fl.forEach((l, i) => { const m = fnRe.exec(l); if (m) fmarks.push({ i, name: m[1] || m[2] }); });
    fmarks.forEach((fm, idx) => {
      const end = idx + 1 < fmarks.length ? fmarks[idx + 1].i : fl.length;
      const body = fl.slice(fm.i, end).join('\n');
      const used = new Set();
      const tre = /(?:FROM|INTO|UPDATE|JOIN)\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?/g;
      let m;
      while ((m = tre.exec(body))) if (tableSet.has(m[1])) used.add(m[1]);
      for (const t of used) {
        tableRefs[t].push({ file: rel, line: fm.i + 1, scope: fm.name + '()', snippet: fl[fm.i].trim().slice(0, 160) });
      }
    });
  }

  _scanCache = { at: new Date().toISOString(), tables, tableRefs, endpointRefs, apiPaths, viewApis };
  _scanAt = now;
  return _scanCache;
}

// ==================== 文件浏览 ====================

function safeResolve(rel) {
  const cleaned = String(rel || '').replace(/^[\\/]+/, '');
  const abs = path.resolve(ROOT, cleaned);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;      // 越界
  const relNorm = path.relative(ROOT, abs).replace(/\\/g, '/');
  for (const re of FILE_DENY) if (re.test(relNorm) || re.test(abs)) return null;
  return { abs, rel: relNorm };
}

function listFiles(rel) {
  const target = safeResolve(rel || '');
  if (!target) return { error: '路径不允许访问' };
  if (!fs.existsSync(target.abs)) return { error: '路径不存在: ' + target.rel };
  const st = fs.statSync(target.abs);
  if (!st.isDirectory()) return { error: '不是目录: ' + target.rel };
  const entries = fs.readdirSync(target.abs, { withFileTypes: true }).map(e => {
    const child = path.join(target.rel, e.name).replace(/\\/g, '/');
    const ok = !!safeResolve(child);
    if (!ok) return null;
    let size = 0, mtime = null;
    try { const s = fs.statSync(path.join(ROOT, child)); size = s.size; mtime = s.mtime.toISOString(); } catch {}
    return { name: e.name, path: child, dir: e.isDirectory(), size, mtime };
  }).filter(Boolean).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { root: target.rel || '(项目根)', entries };
}

// ==================== 路由 ====================

const express = require('express');
const router = express.Router();

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message || String(e) });

/** 库文件信息 + 表总览 */
router.get('/overview', (req, res) => {
  try {
    const st = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : null;
    const tables = tableNames();
    const detail = tables.map(t => ({ name: t, rows: rowCount(t), category: classify(t) }));
    const totalRows = detail.reduce((s, x) => s + Math.max(0, x.rows), 0);
    const byCategory = {};
    for (const d of detail) byCategory[d.category] = (byCategory[d.category] || 0) + Math.max(0, d.rows);
    ok(res, {
      db: {
        path: path.relative(ROOT, DB_PATH).replace(/\\/g, '/'),
        sizeMB: st ? Math.round(st.size / 1048576 * 10) / 10 : null,
        mtime: st ? st.mtime.toISOString() : null,
      },
      tableCount: tables.length,
      totalRows,
      byCategory,
      emptyTables: detail.filter(d => d.rows === 0).map(d => d.name),
    });
  } catch (e) { fail(res, e); }
});

/** 全部表：行数 / 字段数 / 索引数 / 被引用次数 */
router.get('/tables', (req, res) => {
  try {
    const scan = buildScan();
    const list = tableNames().map(t => ({
      name: t,
      rows: rowCount(t),
      columnCount: columnsOf(t).length,
      indexCount: indexesOf(t).length,
      category: classify(t),
      refCount: (scan.tableRefs[t] || []).length,
    }));
    ok(res, { tables: list, scanAt: scan.at });
  } catch (e) { fail(res, e); }
});

/** 单表：结构 + 分页数据（支持排序与关键字过滤） */
router.get('/table/:name', (req, res) => {
  try {
    const name = req.params.name;
    if (!tableExists(name)) return res.status(404).json({ error: '表不存在: ' + name });

    const cols = columnsOf(name);
    const colNames = cols.map(c => c.name);
    const { page, pageSize, offset } = pageArgs(req.query);

    // 排序字段必须在真实字段白名单内
    let orderSql = '';
    const orderBy = String(req.query.orderBy || '');
    if (orderBy && colNames.includes(orderBy)) {
      orderSql = ' ORDER BY "' + orderBy + '" ' + (String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC');
    }

    // 关键字过滤：在 TEXT 字段上做 OR LIKE，值走参数绑定
    const where = [];
    const params = [];
    const q = String(req.query.q || '').trim();
    if (q) {
      const textCols = cols.filter(c => /TEXT|CHAR|CLOB|''/i.test(c.type || '') || !c.type);
      const use = (textCols.length ? textCols : cols).map(c => c.name).slice(0, 12);
      for (const c of use) { where.push(`IFNULL("${c}",'') LIKE ?`); params.push('%' + q + '%'); }
    }
    const whereSql = where.length ? ' WHERE (' + where.join(' OR ') + ')' : '';

    const total = Number(db.queryOne('SELECT COUNT(*) c FROM "' + name + '"' + whereSql, params).c);
    const rows = db.queryAll(
      'SELECT rowid AS __rowid__, * FROM "' + name + '"' + whereSql + orderSql + ' LIMIT ? OFFSET ?',
      [...params, pageSize, offset]
    );

    const scan = buildScan();
    ok(res, {
      table: name,
      category: classify(name),
      columns: cols.map(c => ({ name: c.name, type: c.type, notnull: !!c.notnull, pk: !!c.pk, dflt: c.dflt_value })),
      indexes: indexesOf(name).map(i => ({ name: i.name, sql: i.sql })),
      total, page, pageSize, rows,
      refs: scan.tableRefs[name] || [],
    });
  } catch (e) { fail(res, e); }
});

/** 某表被哪些代码/接口引用 */
router.get('/refs', (req, res) => {
  try {
    const table = String(req.query.table || '');
    const scan = buildScan();
    if (table) {
      if (!tableExists(table)) return res.status(404).json({ error: '表不存在: ' + table });
      return ok(res, { table, refs: scan.tableRefs[table] || [], endpoints: Object.entries(scan.endpointRefs).filter(([, v]) => v.tables.includes(table)).map(([k, v]) => ({ endpoint: k, ...v })) });
    }
    ok(res, { tableRefs: scan.tableRefs, scanAt: scan.at });
  } catch (e) { fail(res, e); }
});

/** 功能 → 接口 → 数据 的完整链路 */
router.get('/feature-map', (req, res) => {
  try {
    const scan = buildScan();
    // 页面 → api 函数 → 路径 → 表
    const views = Object.entries(scan.viewApis).map(([view, apis]) => ({
      view,
      apis: apis.map(name => {
        const p = scan.apiPaths[name] || '';
        // 路径匹配接口（忽略 :id 之类占位差异）
        const norm = s => String(s).replace(/:[^/]+/g, ':id').replace(/\/$/, '');
        const hit = Object.entries(scan.endpointRefs).find(([ep]) => {
          const epPath = norm(ep.replace(/^[A-Z]+ /, ''));
          return norm(p) && (epPath === norm(p) || epPath.startsWith(norm(p) + '/'));
        });
        return { fn: name, path: p, endpoint: hit ? hit[0] : null, tables: hit ? hit[1].tables : [] };
      }),
    }));

    // 表 → 接口（反查）
    const tableToEndpoints = {};
    for (const t of scan.tables) tableToEndpoints[t] = [];
    for (const [ep, info] of Object.entries(scan.endpointRefs)) {
      for (const t of info.tables) if (tableToEndpoints[t]) tableToEndpoints[t].push(ep);
    }

    // 没有任何代码引用的表（可能是遗留表或动态拼接的表名）
    const orphans = scan.tables.filter(t => !(scan.tableRefs[t] || []).length);

    ok(res, { scanAt: scan.at, views, endpoints: scan.endpointRefs, tableToEndpoints, orphans, apiPaths: scan.apiPaths });
  } catch (e) { fail(res, e); }
});

/** 文件浏览器 */
router.get('/files', (req, res) => {
  try {
    const dir = String(req.query.dir || '');
    const r = listFiles(dir);
    if (r.error) return res.status(400).json({ error: r.error });
    ok(res, { ...r, roots: FILE_ROOTS });
  } catch (e) { fail(res, e); }
});

/** 读取单个文件（raw=1 直接输出原文件，便于图片预览） */
router.get('/file', (req, res) => {
  try {
    const target = safeResolve(String(req.query.path || ''));
    if (!target) return res.status(403).json({ error: '路径不允许访问' });
    if (!fs.existsSync(target.abs) || fs.statSync(target.abs).isDirectory()) return res.status(404).json({ error: '文件不存在' });
    const st = fs.statSync(target.abs);
    if (String(req.query.raw) === '1') return res.sendFile(target.abs);

    // data=1：图片/小文件返回 data URL，便于前端 <img> 直接预览（<img src> 无法携带 token）
    if (String(req.query.data) === '1') {
      if (st.size > MAX_INLINE_FILE) return res.status(400).json({ error: '文件超过 2MB，无法内联预览' });
      const ext = (target.rel.split('.').pop() || '').toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' }[ext];
      if (!mime) return res.status(400).json({ error: '该类型不支持内联预览，请用 raw=1 下载' });
      const b64 = fs.readFileSync(target.abs).toString('base64');
      return ok(res, { path: target.rel, size: st.size, mtime: st.mtime.toISOString(), dataUrl: `data:${mime};base64,${b64}` });
    }

    const isText = /\.(js|json|vue|md|txt|css|html|sql|yml|yaml|ps1|py|sh|csv|tsv|log)$/i.test(target.rel);
    const info = { path: target.rel, size: st.size, mtime: st.mtime.toISOString(), text: isText };
    if (!isText) return ok(res, { ...info, content: null, note: '二进制文件，请用 raw=1 下载' });
    if (st.size > MAX_INLINE_FILE) return ok(res, { ...info, content: null, note: '文件超过 2MB，未内联返回' });
    ok(res, { ...info, content: fs.readFileSync(target.abs, 'utf-8') });
  } catch (e) { fail(res, e); }
});

// ==================== 数据体检 ====================
//
// 目标：把"哪个平台缺哪张表""哪次导入其实一行没进""哪张表建了从没用过"
//      "同一门店同日同渠道只有单侧数据（无法交叉验证）"自动算出来。
// 设计：平台与表**自动发现**（按命名约定），不写死表名 —— 这样云端/办公电脑
//      数据不一致、或将来新增平台，都照常能用。

/** 表名 → 角色（按命名后缀） */
const ROLE_RULES = [
  [/^(.*)_bills?$/, '账单（结算）'],
  [/^(.*)_product_records$/, '商品明细'],
  [/^(.*)_daily_records$/, '运营日报'],
  [/^(.*)_daily_reports$/, '运营日报'],
  [/^(.*)_operation_records$/, '运营记录'],
  [/^(.*)_settlement_records$/, '结算记录'],
  [/^(.*)_benefit_records$/, '权益/优惠'],
];
/** 平台前缀 → 显示名 */
const PLATFORM_RULES = [
  [/^meituan_delivery/, '美团外卖', 'delivery'],
  [/^jd_delivery/, '京东外卖', 'delivery'],
  [/^taobao_flash/, '淘宝闪购', 'delivery'],
  [/^meituan_group/, '美团团购', 'group_buy'],
  [/^douyin_group/, '抖音团购', 'group_buy'],
];

function dateColFor(table) {
  const cols = columnsOf(table).map(c => c.name);
  return ['biz_date', 'bill_date', 'settle_date', 'stat_date', 'date'].find(c => cols.includes(c)) || null;
}

/** 某表在日期区间内每天的行数（一次分组查询，避免逐天 COUNT） */
function dailyCounts(table, dateCol, from) {
  const map = {};
  try {
    for (const r of db.queryAll('SELECT "' + dateCol + '" d, COUNT(*) c FROM "' + table + '" WHERE "' + dateCol + '" >= ? GROUP BY "' + dateCol + '"', [from])) {
      map[String(r.d).slice(0, 10)] = Number(r.c);
    }
  } catch { /* 表结构异常时忽略 */ }
  return map;
}

const HEALTH_CACHE = { at: 0, days: 0, data: null };

router.get('/data-health', (req, res) => {
  try {
    const days = Math.min(60, Math.max(3, parseInt(req.query.days, 10) || 14));
    const diffThreshold = Math.max(0, Number(req.query.diffThreshold) || 1);
    if (HEALTH_CACHE.data && HEALTH_CACHE.days === days && Date.now() - HEALTH_CACHE.at < 15000) {
      return ok(res, HEALTH_CACHE.data);
    }

    const today = new Date();
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const from = dates[0];
    const all = tableNames();

    // ---- 1) 平台专属表覆盖矩阵（自动发现）----
    const groupsMap = new Map();
    for (const t of all) {
      const p = PLATFORM_RULES.find(([re]) => re.test(t));
      if (!p) continue;
      const role = ROLE_RULES.map(([re, label]) => (re.test(t) ? label : null)).find(Boolean);
      if (!role) continue;
      const dateCol = dateColFor(t);
      if (!dateCol) continue;
      if (!groupsMap.has(p[1])) groupsMap.set(p[1], { label: p[1], channelGroup: p[2], columns: [] });
      const counts = dailyCounts(t, dateCol, from);
      groupsMap.get(p[1]).columns.push({
        table: t, role, dateCol, total: rowCount(t),
        cells: dates.map(d => (counts[d] || 0)),
      });
    }
    const coverage = { dates, groups: [...groupsMap.values()] };

    // ---- 2) 通用层覆盖（按 platform 维度）----
    const generic = [];
    for (const [table, label] of [['business_product_sales', '商品明细（通用层）'], ['business_revenue_records', '营收记录（对账口径）']]) {
      if (!all.includes(table)) continue;
      const rows = db.queryAll(
        'SELECT biz_date d, IFNULL(NULLIF(platform,\'\'),\'(空)\') p, COUNT(*) c FROM "' + table + '" WHERE biz_date >= ? GROUP BY d, p',
        [from]
      );
      const platforms = [...new Set(rows.map(r => r.p))].sort();
      const cellMap = {};
      for (const r of rows) cellMap[String(r.d).slice(0, 10) + '|' + r.p] = Number(r.c);
      generic.push({
        table, label, platforms,
        rows: dates.map(d => ({ date: d, cells: platforms.map(p => cellMap[d + '|' + p] || 0) })),
      });
    }

    // ---- 3) 导入异常 ----
    const batches = all.includes('business_import_batches')
      ? db.queryAll('SELECT id, platform, file_name, row_count, date_from, date_to, created_at FROM business_import_batches ORDER BY id DESC').map(b => ({ ...b, row_count: Number(b.row_count) || 0 }))
      : [];
    const zeroRow = batches.filter(b => b.row_count === 0).slice(0, 20);
    const lastByPlatform = {};
    for (const b of batches) {
      const k = b.platform || '(空)';
      if (!lastByPlatform[k]) lastByPlatform[k] = b;
    }

    // ---- 4) 空表 ----
    const emptyTables = all.filter(t => rowCount(t) === 0);

    // ---- 5) 对账体检：同门店同日同渠道，POS 侧 vs 平台侧 ----
    //
    // 注意（重要）：两侧记录的**不是同一个口径**，因此本工具**不下"漏单"结论**，
    //   只做两件事：① 指出确定性的缺口（某一侧完全没有数据）；② 把两侧数字并排摆出来，
    //   并给出三条候选规则的命中情况，由使用者自行判断（口径关系需业务确认）。
    //   实测口径差：POS 原价 664.10 − POS 优惠 329.29 = 334.81 = 平台原价
    //   → 即"收银侧记原价、平台侧记结算口径"，属已知差异来源。
    const recon = { rows: [], summary: { missingPlatform: 0, missingPos: 0, bothSidesPresent: 0, matchedByRule: 0, needReview: 0, ignoredPlaceholder: 0 } };
    if (all.includes('business_revenue_records')) {
      const raw = db.queryAll(
        `SELECT biz_date, store_name, channel_group, channel,
                SUM(CASE WHEN source_type='pos' THEN 1 ELSE 0 END) pos_rows,
                SUM(CASE WHEN source_type='platform' THEN 1 ELSE 0 END) plat_rows,
                SUM(CASE WHEN source_type='pos' THEN IFNULL(actual_amount,0) ELSE 0 END) pos_amt,
                SUM(CASE WHEN source_type='platform' THEN IFNULL(actual_amount,0) ELSE 0 END) plat_amt,
                SUM(CASE WHEN source_type='pos' THEN IFNULL(gross_amount,0) ELSE 0 END) pos_gross,
                SUM(CASE WHEN source_type='platform' THEN IFNULL(gross_amount,0) ELSE 0 END) plat_gross,
                SUM(CASE WHEN source_type='pos' THEN IFNULL(discount_amount,0) ELSE 0 END) pos_disc,
                SUM(CASE WHEN source_type='platform' THEN IFNULL(discount_amount,0) ELSE 0 END) plat_disc,
                SUM(CASE WHEN source_type='pos' THEN IFNULL(order_count,0) ELSE 0 END) pos_orders,
                SUM(CASE WHEN source_type='platform' THEN IFNULL(order_count,0) ELSE 0 END) plat_orders
         FROM business_revenue_records WHERE biz_date >= ?
         GROUP BY biz_date, store_id, channel_group, channel`,
        [from]
      );
      const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
      for (const r of raw) {
        const cg = String(r.channel_group || '');
        if (cg !== 'delivery' && cg !== 'group_buy') continue;   // 线下只有 POS 侧，不参与对账
        const pos = Number(r.pos_rows) || 0, plat = Number(r.plat_rows) || 0;
        const pg = r2(r.pos_gross), pd = r2(r.pos_disc), pa = r2(r.pos_amt), po = Number(r.pos_orders) || 0;
        const lg = r2(r.plat_gross), ld = r2(r.plat_disc), la = r2(r.plat_amt), lo = Number(r.plat_orders) || 0;
        const posActive = pos > 0 && (pg > 0 || pa > 0 || po > 0);

        if (!posActive && plat === 0) { recon.summary.ignoredPlaceholder++; continue; }

        // 三条候选规则（命中即为"可能是同一笔业务"）
        const posNet = r2(pg - pd);
        const rules = {
          净额等于平台原价: Math.abs(posNet - lg) <= diffThreshold,   // POS(原价-优惠) == 平台原价
          实收一致: pa > 0 && la > 0 && Math.abs(pa - la) <= diffThreshold,
          单量一致: po > 0 && lo > 0 && po === lo,
        };
        const ruleHits = Object.entries(rules).filter(([, v]) => v).map(([k]) => k);

        let status;
        if (posActive && plat === 0) { status = '缺平台侧'; recon.summary.missingPlatform++; }
        else if (plat > 0 && !posActive) { status = '缺收银侧'; recon.summary.missingPos++; }
        else {
          recon.summary.bothSidesPresent++;
          if (ruleHits.length) { status = '两侧都在（规则命中）'; recon.summary.matchedByRule++; }
          else { status = '两侧都在（需人工核对）'; recon.summary.needReview++; }
        }

        recon.rows.push({
          date: String(r.biz_date), store: r.store_name, channelGroup: cg, channel: r.channel || '',
          status, ruleHits, rules,
          pos: { rows: pos, gross: pg, discount: pd, net: posNet, actual: pa, orders: po },
          plat: { rows: plat, gross: lg, discount: ld, actual: la, orders: lo },
        });
      }
      recon.rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      recon.total = recon.rows.length;
      recon.rows = recon.rows.slice(0, 300);
      recon.note = '两侧口径不同（实测：POS 原价−优惠 = 平台原价），因此"规则命中"只表示可能是同一笔业务，不代表已确认；请结合业务确认口径后再定判定标准。';
    }

    const data = {
      generatedAt: new Date().toISOString(),
      dbPath: path.relative(ROOT, DB_PATH).replace(/\\/g, '/'),
      days, from, dates,
      coverage,
      generic,
      issues: { zeroRowBatches: zeroRow, lastByPlatform, emptyTables, batchTotal: batches.length },
      recon,
    };
    HEALTH_CACHE.at = Date.now(); HEALTH_CACHE.days = days; HEALTH_CACHE.data = data;
    ok(res, data);
  } catch (e) { fail(res, e); }
});

/** 只读 SQL 控制台 */router.post('/query', (req, res) => {
  try {
    let sql = String((req.body && req.body.sql) || '').trim().replace(/;+\s*$/, '');
    if (!sql) return res.status(400).json({ error: 'SQL 不能为空' });
    if (sql.includes(';')) return res.status(400).json({ error: '只允许执行单条语句' });
    if (!/^(select|with)\b/i.test(sql)) return res.status(400).json({ error: '只允许 SELECT / WITH 查询' });
    if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|trigger)\b/i.test(sql)) {
      return res.status(400).json({ error: '检测到写操作或 DDL 关键字，已拒绝执行' });
    }
    if (!/\blimit\b/i.test(sql)) sql += ' LIMIT ' + MAX_SQL_ROWS;

    const t0 = Date.now();
    const rows = db.queryAll(sql);
    const ms = Date.now() - t0;
    const truncated = rows.length >= MAX_SQL_ROWS;
    ok(res, {
      sql,
      ms,
      rowCount: rows.length,
      truncated,
      columns: rows.length ? Object.keys(rows[0]) : [],
      rows: rows.slice(0, MAX_SQL_ROWS),
    });
  } catch (e) { fail(res, e); }
});

module.exports = {
  router,
  ROOT, DB_PATH, MAX_PAGE_SIZE, MAX_SQL_ROWS, MAX_INLINE_FILE, FILE_ROOTS, FILE_DENY,
  tableNames, tableExists, columnsOf, indexesOf, rowCount, classify, pageArgs,
  buildScan, safeResolve, listFiles, readSafe,
};

