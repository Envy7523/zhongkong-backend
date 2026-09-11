/**
 * 员工表格导入：把 Excel/CSV（企微机器人收到的文件，或本地文件）解析为员工档案并写入 employees。
 * 字段与企业微信「员工档案」表保持一致：姓名 / 手机号 / 性别 / 年龄 / 所属门店 / 职位 / 角色 / 入职日期 / 状态 / 备注
 * 去重规则：先按「姓名 + 手机号」精确匹配，其次按姓名唯一匹配；匹配到则更新，否则新增。
 */
const XLSX = require('xlsx');

const FIELD_ALIASES = {
  name: ['姓名', '员工姓名', '名字', '员工', 'employee', 'name'],
  phone: ['手机号', '手机号码', '手机', '电话', '联系电话', '联系方式', 'phone', 'mobile'],
  gender: ['性别', 'gender'],
  age: ['年龄', 'age'],
  store_name: ['所属门店', '门店', '门店名称', '店铺', '所在门店', 'store', 'storename'],
  position: ['职位', '岗位', '职务', 'position', 'job'],
  role: ['角色', '身份', '人员类型', 'role'],
  entry_date: ['入职日期', '入职时间', '入职', '到岗日期', 'joindate', 'entrydate'],
  status: ['状态', '在职状态', '员工状态', 'status'],
  remark: ['备注', '说明', '其他', 'remark', 'note'],
};

/** 归一化表头：去空格、括号、标点、全角冒号，转小写 */
function normKey(text) {
  return String(text || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）()［］\[\]【】:：,，.。/\\|*#]/g, '')
    .toLowerCase();
}

/** 依据表头挑选每列对应的目标字段 */
function buildColumnMap(headers) {
  const map = {};
  headers.forEach((header) => {
    const key = normKey(header);
    if (!key) return;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (map[field]) continue;
      if (aliases.some(alias => normKey(alias) === key)) { map[field] = header; return; }
    }
    // 包含式兜底（如“员工姓名/手机号码(必填)”）
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (map[field]) continue;
      if (aliases.some(alias => key.includes(normKey(alias)) && normKey(alias).length >= 2)) { map[field] = header; return; }
    }
  });
  return map;
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function readWorkbookRows(buffer, filename = '') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const lower = String(filename || '').toLowerCase();
  const sheetNames = lower.endsWith('.csv') || workbook.SheetNames.length === 1
    ? workbook.SheetNames
    : workbook.SheetNames;
  for (const sheetName of sheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false });
    if (rows.length) return { sheetName, rows };
  }
  return { sheetName: workbook.SheetNames[0] || '', rows: [] };
}

/**
 * 把表格中的员工行导入 employees。
 * @param {object} db 数据库封装（queryAll/queryOne/insert/run/save）
 * @param {Buffer} buffer 文件内容
 * @param {string} filename 文件名（用于展示与判断格式）
 * @returns {{sheet_name:string,total:number,created:number,updated:number,skipped:number,mapped:object,missingName:number,errors:string[]}}
 */
function importStaffWorkbook(db, buffer, filename = '') {
  const { sheetName, rows } = readWorkbookRows(buffer, filename);
  if (!rows.length) throw new Error('文件里没有可读取的员工数据（请确认含表头与数据行）');
  const headers = Object.keys(rows[0]);
  const colMap = buildColumnMap(headers);
  if (!colMap.name) {
    throw new Error(`未识别到“姓名”列。当前表头：${headers.join('、') || '（空）'}`);
  }
  const result = {
    sheet_name: sheetName, total: rows.length, created: 0, updated: 0, skipped: 0,
    missingName: 0, mapped: colMap, errors: [],
  };
  db.run('BEGIN');
  try {
    rows.forEach((row, index) => {
      const name = cellText(row[colMap.name]);
      if (!name) { result.missingName++; result.skipped++; return; }
      const phone = cellText(colMap.phone ? row[colMap.phone] : '');
      const payload = {
        name,
        phone,
        gender: cellText(colMap.gender ? row[colMap.gender] : ''),
        age: parseInt(cellText(colMap.age ? row[colMap.age] : ''), 10) || 0,
        store_name: cellText(colMap.store_name ? row[colMap.store_name] : ''),
        position: cellText(colMap.position ? row[colMap.position] : ''),
        role: cellText(colMap.role ? row[colMap.role] : '') || '店员',
        entry_date: cellText(colMap.entry_date ? row[colMap.entry_date] : ''),
        status: cellText(colMap.status ? row[colMap.status] : '') || '在职',
        remark: cellText(colMap.remark ? row[colMap.remark] : ''),
      };
      let target = null;
      if (phone) target = db.queryOne('SELECT id FROM employees WHERE name=? AND phone=?', [name, phone]);
      if (!target) {
        const sameName = db.queryAll('SELECT id FROM employees WHERE name=?', [name]);
        if (sameName.length === 1) target = sameName[0];
      }
      if (target) {
        db.run(`UPDATE employees SET name=?, phone=?, gender=?, age=?, store_name=?, position=?, role=?, entry_date=?, status=?, remark=?,
                updated_at=datetime('now','localtime') WHERE id=?`,
          [payload.name, payload.phone, payload.gender, payload.age, payload.store_name,
            payload.position, payload.role, payload.entry_date, payload.status, payload.remark, target.id]);
        result.updated++;
      } else {
        db.insert(`INSERT INTO employees (name,phone,gender,age,store_name,status,entry_date,position,role,remark,store_id,smartsheet_record_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [payload.name, payload.phone, payload.gender, payload.age, payload.store_name,
            payload.status, payload.entry_date, payload.position, payload.role, payload.remark, 0, '']);
        result.created++;
      }
      // 单行错误不影响整批导入
      if (!colMap.phone && index === 0) result.errors.push('未识别到“手机号”列，将仅按姓名去重');
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  db.save();
  return result;
}

/** 生成给企业微信机器人回复的文本 */
function formatImportReply(result, filename = '') {
  const mappedFields = Object.keys(result.mapped || {}).length;
  const lines = [
    `✅ 员工表导入完成${filename ? `（${filename}）` : ''}`,
    `识别列：${mappedFields} 列 · 数据 ${result.total} 行`,
    `新增 ${result.created} 人 · 更新 ${result.updated} 人 · 跳过 ${result.skipped} 行（缺姓名 ${result.missingName}）`,
  ];
  const mappedNames = Object.entries(result.mapped || {}).map(([f, h]) => `${f}←${h}`).join('、');
  if (mappedNames) lines.push(`字段映射：${mappedNames}`);
  if (result.errors?.length) lines.push(`提示：${result.errors.slice(0, 3).join('；')}`);
  return lines.join('\n');
}

module.exports = { importStaffWorkbook, formatImportReply, buildColumnMap, normKey };
