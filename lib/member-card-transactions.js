'use strict';
// Member financial movements only. Names, phone/card numbers and remarks never leave the parser.
const XLSX = require('xlsx');
const crypto = require('crypto');
const zlib = require('zlib');
const TYPE = 'member_card_transactions';
const MAX_FILE = 64 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024;
const HEADERS = ['交易流水号', '交易单号', '操作类型', '储值余额变动', '储值本金变动', '储值赠金变动',
  '储值消费金额', '储值消费金额_本金', '储值消费金额_赠金', '交易时间', '结账时间', '操作门店机构编码', '操作门店'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function money(v, { blank = false } = {}) {
  if (blank && (v == null || ['', '-', '--'].includes(String(v).trim()))) return 0;
  const s = String(v ?? '').trim().replace(/,/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw Error('会员金额缺失或格式不正确');
  const n = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw Error('会员金额超出范围');
  return m[1] ? -n : n;
}
function date(v) {
  const s = String(v || '').replace(/\//g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw Error('会员报表日期格式不正确');
  const d = new Date(s + 'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw Error('会员报表日期不存在');
  return s;
}
function timestamp(v) {
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) throw Error('会员交易时间格式不正确');
    v = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')} ${[d.H,d.M,d.S].map(n => String(n).padStart(2, '0')).join(':')}`;
  }
  const s = String(v || '').trim().replace(/\//g, '-').replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) throw Error('会员交易时间格式不正确');
  date(s.slice(0, 10));
  if (s.slice(11, 13) > '23' || s.slice(14, 16) > '59' || s.slice(17, 19) > '59') throw Error('会员交易时间超出范围');
  return s;
}
function crc32(buffer) {
  let n = 0xffffffff;
  for (const b of buffer) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0); }
  return (n ^ 0xffffffff) >>> 0;
}
// Inspect central sizes before inflation; extract in memory, never to an entry-controlled path.
function zipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_TOTAL || buffer.length < 22) throw Error('会员压缩包大小不正确');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw Error('会员ZIP目录缺失或不支持分卷压缩');
  const count = buffer.readUInt16LE(end + 10), start = buffer.readUInt32LE(end + 16), directorySize = buffer.readUInt32LE(end + 12);
  if (count > 4096 || start + directorySize > end) throw Error('会员ZIP目录超出限制');
  const out = []; let at = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== 0x02014b50) throw Error('会员ZIP目录损坏');
    const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10), crc = buffer.readUInt32LE(at + 16);
    const compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24), len = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32), offset = buffer.readUInt32LE(at + 42);
    if (at + 46 + len + extra + comment > start + directorySize) throw Error('会员ZIP文件名损坏');
    const nameBytes = buffer.subarray(at + 46, at + 46 + len);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'gb18030', { fatal: true }).decode(nameBytes).replace(/\\/g, '/');
    if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw Error('会员ZIP包含不安全路径');
    if (flags & 1 || ![0, 8].includes(method)) throw Error('会员ZIP加密或压缩方法不受支持');
    total += size;
    if (size > MAX_FILE || total > MAX_TOTAL || offset + 30 > start) throw Error('会员ZIP解压大小超出限制');
    out.push({ name, size, compressed, method, crc, offset }); at += 46 + len + extra + comment;
  }
  if (at !== start + directorySize) throw Error('会员ZIP目录长度不符');
  return out.map(e => ({ ...e, read() {
    const local = e.offset;
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw Error('会员ZIP文件头损坏');
    const begin = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (begin + e.compressed > start) throw Error('会员ZIP文件内容越界');
    const data = buffer.subarray(begin, begin + e.compressed);
    const result = e.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: MAX_FILE });
    if (result.length !== e.size || crc32(result) !== e.crc) throw Error('会员ZIP文件校验失败');
    return result;
  } }));
}
function restoreRange(sheet) {
  let range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  for (const [address, cell] of Object.entries(sheet)) {
    if (!/^[A-Z]+[1-9]\d*$/.test(address) || !cell || cell.v == null) continue;
    const p = XLSX.utils.decode_cell(address);
    if (!range) range = { s: { ...p }, e: { ...p } };
    else { range.s.r = Math.min(range.s.r, p.r); range.s.c = Math.min(range.s.c, p.c); range.e.r = Math.max(range.e.r, p.r); range.e.c = Math.max(range.e.c, p.c); }
  }
  if (range) sheet['!ref'] = XLSX.utils.encode_range(range);
  return sheet;
}
function parseWorkbook(buffer, fileName) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const records = [], summaries = []; let found = false;
  for (const sheetName of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(restoreRange(wb.Sheets[sheetName]), { header: 1, defval: '', raw: true });
    const header = grid.slice(0, 8).findIndex(r => HEADERS.every(h => r.includes(h)));
    if (header < 0) continue;
    found = true; const cols = grid[header], col = h => cols.indexOf(h);
    if (new Set(cols.filter(Boolean)).size !== cols.filter(Boolean).length) throw Error('会员表头存在同名列');
    const sum = { total: 0, principal: 0, gift: 0 }; let footer = null;
    for (let index = header + 1; index < grid.length; index++) {
      const row = grid[index]; if (!row.some(v => String(v).trim())) continue;
      const v = h => row[col(h)], id = String(v('交易流水号') || '').trim(), operation = String(v('操作类型') || '').trim();
      const values = { total: money(v('储值消费金额'), { blank: ['充值','充值退款','活动赠积分','积分兑换','期初导入'].includes(operation) }),
        principal: money(v('储值消费金额_本金')), gift: money(v('储值消费金额_赠金')) };
      if (values.total !== values.principal + values.gift) throw Error(`会员报表第${index + 1}行本金赠金不平`);
      if (['-', '合计', '汇总', ''].includes(id) && ['-', '合计', '汇总', ''].includes(operation)) {
        if (footer) throw Error('会员报表存在多个汇总行'); footer = values; continue;
      }
      if (footer) throw Error('会员报表汇总行后仍有交易');
      if (!/^[A-Za-z0-9_-]{6,80}$/.test(id) || typeof v('交易流水号') === 'number' && !Number.isSafeInteger(v('交易流水号'))) throw Error('会员交易流水号缺失或精度受损');
      const change = money(v('储值余额变动')), principalChange = money(v('储值本金变动')), giftChange = money(v('储值赠金变动'));
      if (change !== principalChange + giftChange) throw Error(`会员报表第${index + 1}行余额变动不平`);
      if (['消费', '未结账'].includes(operation) && (values.total > 0 || values.principal > 0 || values.gift > 0)) throw Error('会员消费扣款符号不正确');
      if (['退单', '未结账撤销'].includes(operation) && (values.total < 0 || values.principal < 0 || values.gift < 0)) throw Error('会员退单返还符号不正确');
      if (!['消费', '退单', '未结账', '未结账撤销'].includes(operation) && values.total !== 0) throw Error('会员消费操作类型未支持，未推测金额归属');
      // Unsettled deductions and their reversals are asset movements, not completed sales.
      const settled = ['消费', '退单'].includes(operation);
      const record = { transaction_id: id, order_id: String(v('交易单号') || '').trim(), operation,
        transaction_time: timestamp(v('交易时间')), settled_at: timestamp(v('结账时间')),
        store_code: String(v('操作门店机构编码') || '').trim(), source_store_name: String(v('操作门店') || '').trim(),
        balance_change_cents: change, principal_change_cents: principalChange, gift_change_cents: giftChange,
        consumption_cents: settled ? -values.total : 0, principal_cents: settled ? -values.principal : 0, gift_cents: settled ? -values.gift : 0 };
      if (!record.store_code || !record.source_store_name || !operation) throw Error('会员交易归属字段缺失');
      if (typeof v('交易单号') === 'number' && !Number.isSafeInteger(v('交易单号'))) throw Error('会员交易单号精度受损');
      record.row_sha256 = sha(JSON.stringify(record));
      records.push(record); for (const key of Object.keys(sum)) sum[key] += values[key];
    }
    if (!footer) throw Error('会员报表缺少汇总控制行');
    for (const key of Object.keys(sum)) if (sum[key] !== footer[key]) throw Error('会员报表汇总与明细不符');
    summaries.push({ sheet: sheetName, ...sum });
  }
  if (!found) throw Error('文件不是含本金赠金明细的会员交易报表');
  return { records, summaries, file_name: fileName };
}
function parse(buffer, options = {}) {
  const entries = zipEntries(buffer);
  const isWorkbook = entries.some(e => e.name === 'xl/workbook.xml');
  const files = isWorkbook ? [{ name: options.file_name || 'member.xlsx', read: () => buffer }] : entries.filter(e => /\.xlsx$/i.test(e.name));
  if (!files.length || files.length > 30) throw Error('会员ZIP没有XLSX分片或分片过多');
  const seen = new Map(), parts = []; let duplicateRows = 0, sourceRows = 0;
  for (const file of files) {
    const part = parseWorkbook(file.read(), file.name); sourceRows += part.records.length;
    for (const row of part.records) {
      const old = seen.get(row.transaction_id);
      if (old && old.row_sha256 !== row.row_sha256) throw Error('会员交易流水重复且内容冲突');
      if (old) duplicateRows++; else seen.set(row.transaction_id, row);
    }
    parts.push({ name: file.name, rows: part.records.length, summaries: part.summaries });
  }
  const records = [...seen.values()];
  if (options.expected_count !== undefined && sourceRows !== Number(options.expected_count)) throw Error('会员导出行数与查询记录数不一致');
  const from = options.date_from ? date(options.date_from) : null, to = options.date_to ? date(options.date_to) : null;
  if (!!from !== !!to || from && from > to) throw Error('会员查询日期范围不正确');
  for (const row of records) if (from && (row.transaction_time.slice(0, 10) < from || row.transaction_time.slice(0, 10) > to)) throw Error('会员交易超出查询范围');
  return { type: TYPE, sha256: sha(buffer), records, parts, source_rows: sourceRows, duplicate_rows: duplicateRows,
    date_from: from, date_to: to, totals: records.reduce((n, r) => { for (const k of Object.keys(n)) n[k] += r[k]; return n; }, { consumption_cents: 0, principal_cents: 0, gift_cents: 0 }) };
}
function initialize(db) {
  db.run(`CREATE TABLE IF NOT EXISTS pos_member_transactions (
    transaction_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, operation TEXT NOT NULL,
    transaction_time TEXT NOT NULL, transaction_date TEXT NOT NULL, settled_at TEXT NOT NULL,
    store_code TEXT NOT NULL, source_store_name TEXT NOT NULL, store_id INTEGER,
    biz_date TEXT NOT NULL DEFAULT '', date_basis TEXT NOT NULL,
    balance_change_cents INTEGER NOT NULL, principal_change_cents INTEGER NOT NULL, gift_change_cents INTEGER NOT NULL,
    consumption_cents INTEGER NOT NULL, principal_cents INTEGER NOT NULL, gift_cents INTEGER NOT NULL,
    row_sha256 TEXT NOT NULL, batch_id INTEGER NOT NULL)`);
  db.run('CREATE INDEX IF NOT EXISTS idx_member_store_date ON pos_member_transactions(store_id,biz_date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_member_transaction_date ON pos_member_transactions(transaction_date)');
  db.run(`CREATE TABLE IF NOT EXISTS pos_member_imports (
    sha256 TEXT PRIMARY KEY, batch_id INTEGER NOT NULL, date_from TEXT, date_to TEXT,
    complete_scope INTEGER NOT NULL, source_rows INTEGER NOT NULL, distinct_rows INTEGER NOT NULL,
    principal_cents INTEGER NOT NULL, gift_cents INTEGER NOT NULL, parts_json TEXT NOT NULL)`);
}
// Called inside the importing transaction. Never infer a business date from a
// timestamp; another store's order or an ambiguous order must remain pending.
function relinkPending(db) {
  for (const table of ['pos_member_transactions', 'pos_channel_orders']) {
    if (!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table])) return 0;
  }
  const rows = db.queryAll(`SELECT m.transaction_id,MIN(o.biz_date) biz_date
    FROM pos_member_transactions m JOIN pos_channel_orders o
      ON o.store_id=m.store_id AND o.order_id=m.order_id
    WHERE m.biz_date='' AND m.consumption_cents<>0 AND o.biz_date<>''
    GROUP BY m.transaction_id HAVING COUNT(DISTINCT o.biz_date)=1`);
  for (const row of rows) db.run("UPDATE pos_member_transactions SET biz_date=?,date_basis='pos_order' WHERE transaction_id=? AND biz_date=''", [row.biz_date,row.transaction_id]);
  return rows.length;
}
function relinkAndSave(db) {
  db.run('BEGIN');
  try {
    const count = relinkPending(db);
    db.run('COMMIT');
    if (count) db.save();
    return count;
  } catch (error) { db.run('ROLLBACK'); throw error; }
}
function importBuffer(db, buffer, params = {}, user = {}) {
  const report = parse(buffer, params);
  const complete = params.complete_scope === true;
  if (complete && (!report.date_from || params.expected_count === undefined || report.duplicate_rows
    || params.filters?.date_basis !== 'transaction_time' || params.filters?.operation !== 'all' || params.filters?.stores !== 'all'))
    throw Error('完整会员覆盖必须有日期、全部筛选及查询条数证据');
  initialize(db);
  const prior = db.queryOne('SELECT * FROM pos_member_imports WHERE sha256=?', [report.sha256]);
  if (prior) {
    if (complete && (!prior.complete_scope || prior.date_from !== report.date_from || prior.date_to !== report.date_to))
      throw Error('已有文件的覆盖证据不同，未自动升级完整状态');
    return { data_kind: TYPE, batch_id: prior.batch_id, imported: 0, source_rows: prior.source_rows, duplicate: true, relinked: relinkAndSave(db), totals: report.totals };
  }
  const identity = require('./store-pos-identity');
  const orderTable = !!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='pos_channel_orders'");
  const priorRows = new Map(db.queryAll('SELECT transaction_id,row_sha256 FROM pos_member_transactions').map(r=>[r.transaction_id,r]));
  const pending = db.queryAll("SELECT transaction_id,order_id,store_id FROM pos_member_transactions WHERE biz_date='' AND store_id IS NOT NULL AND consumption_cents<>0");
  const wanted = new Set(report.records.map(r=>r.order_id).concat(pending.map(r=>r.order_id)));
  const orderDates = new Map(), stores = new Map();
  if(orderTable)for(const row of db.queryAll('SELECT store_id,order_id,biz_date FROM pos_channel_orders')) {
    if(!wanted.has(row.order_id))continue;
    const key=row.store_id+'|'+row.order_id;
    if(!orderDates.has(key))orderDates.set(key,new Set());orderDates.get(key).add(row.biz_date);
  }
  const datesFor=(id,order)=>[...(orderDates.get(id+'|'+order)||[])];
  const resolved = report.records.map(row => {
    const existing = priorRows.get(row.transaction_id);
    if (existing && existing.row_sha256 !== row.row_sha256) throw Error('已有会员流水内容冲突，已阻止覆盖');
    const day = row.transaction_time.slice(0, 10),key=row.store_code+'|'+day;
    if(!stores.has(key))stores.set(key,identity.resolveCode(db,row.store_code,day));
    const store=stores.get(key),orders=store?datesFor(store.id,row.order_id):[];
    if (orders.length > 1) throw Error('会员交易单号对应多个营业日，需核对');
    return { ...row, store_id: store?.id || null, transaction_date: day,
      biz_date: orders[0] || '', date_basis: orders.length ? 'pos_order' : 'unmatched_order', existing: !!existing };
  });
  db.run('BEGIN');
  let batch, imported = 0, relinked = 0;
  try {
    batch = db.insert(`INSERT INTO business_import_batches
      (source_type,platform,file_name,row_count,imported_by,imported_by_name,date_from,date_to) VALUES (?,?,?,?,?,?,?,?)`,
    ['pos', '收银会员交易流水', params.file_name || '会员交易报表', report.records.length, user.id || null,
      user.display_name || user.username || '', report.date_from, report.date_to]);
    // Later POS imports may complete older transaction dates; only fill verified date metadata.
    relinked = relinkPending(db);
    const fields = ['transaction_id','order_id','operation','transaction_time','transaction_date','settled_at','store_code','source_store_name','store_id','biz_date','date_basis',
      'balance_change_cents','principal_change_cents','gift_change_cents','consumption_cents','principal_cents','gift_cents','row_sha256'];
    for (const row of resolved) {
      if (row.existing) continue;
      db.run('INSERT INTO pos_member_transactions (' + fields.join(',') + ',batch_id) VALUES (' + fields.map(() => '?').join(',') + ',?)', fields.map(k => row[k]).concat(batch));
      imported++;
    }
    db.run('INSERT INTO pos_member_imports VALUES (?,?,?,?,?,?,?,?,?,?)', [report.sha256, batch, report.date_from, report.date_to,
      complete ? 1 : 0, report.source_rows, report.records.length, report.totals.principal_cents, report.totals.gift_cents, JSON.stringify(report.parts)]);
    db.run('COMMIT'); db.save();
  } catch (error) { db.run('ROLLBACK'); throw error; }
  return { data_kind: TYPE, batch_id: batch, imported, relinked, source_rows: report.source_rows, distinct_rows: report.records.length,
    duplicate_rows: report.duplicate_rows, existing_rows: report.records.length - imported,
    matched_stores: new Set(resolved.filter(r => r.store_id).map(r => r.store_id)).size,
    unmatched_store_rows: resolved.filter(r => !r.store_id).length,
    unmatched_order_rows: resolved.filter(r => r.consumption_cents && !r.biz_date).length,
    date_from: report.date_from, date_to: report.date_to, complete_scope: complete, totals: report.totals,
    fees_actual: false, income_applied: false };
}
function coverage(db, from, to = from) {
  date(from); date(to); if (from > to) throw Error('会员覆盖日期范围不正确');
  if (!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='pos_member_imports'"))
    return { ok: true, report_type: TYPE, covered: false, date_from: from, date_to: to };
  const batches = db.queryAll('SELECT sha256,batch_id,date_from,date_to,source_rows,distinct_rows FROM pos_member_imports WHERE complete_scope=1 AND date_from<=? AND date_to>=?', [from, to]);
  const summary = db.queryOne(`SELECT COUNT(*) n,SUM(consumption_cents) consumption_cents,SUM(principal_cents) principal_cents,SUM(gift_cents) gift_cents,
    SUM(CASE WHEN store_id IS NULL THEN 1 ELSE 0 END) unmatched_stores,
    SUM(CASE WHEN consumption_cents<>0 AND biz_date='' THEN 1 ELSE 0 END) unmatched_orders
    FROM pos_member_transactions WHERE transaction_date BETWEEN ? AND ?`, [from, to]);
  return { ok: true, report_type: TYPE, date_from: from, date_to: to, covered: batches.length > 0,
    import_batches: batches, summary };
}
module.exports = { TYPE, HEADERS, money, date, timestamp, crc32, zipEntries, restoreRange, parseWorkbook, parse, initialize, relinkPending, relinkAndSave, importBuffer, coverage };
