/**
 * 从企业微信智能表格同步员工档案（机器人身份，wecom-cli）
 *
 * 背景：企微「智能机器人」通过 CLI/MCP 以机器人身份代真人执行——
 *       真人（授权用户）创建/拥有的表格可以读取，因此无需自建应用 wedoc 权限。
 *
 * 安全约束（skill: wecom-unified 安全条款）：
 *   只读取员工管理必需的业务字段，**绝不读取/导入**身份证号、银行卡号、健康证、
 *   身份证照片等可识别具体自然人的隐私字段（SQL 投影里已排除）。
 */
const { execFile } = require('child_process');
const path = require('path');

const CLI_CANDIDATES = [
  path.join(process.env.APPDATA || '', 'npm', 'wecom-cli.cmd'),
  path.join(process.env.APPDATA || '', 'npm', 'wecom-cli.ps1'),
  'wecom-cli',
];

/** 允许同步的业务字段（不含任何隐私字段） */
const QUERY_FIELDS = [
  '名字', '性别', '岗位', '在职状态', '入职状态',
  '入职日期', '转正时间', '离职时间',
  '手机号', '归属门店', '归属店长', '所属店长',
  '员工工资', '紧急联系人', '紧急联系电话', '备注',
];

function buildSql(sheetTitle, limit = 500) {
  const cols = QUERY_FIELDS.map(f => '`' + f + '`').join(', ');
  return `SELECT RECORD_ID, ${cols} FROM \`${sheetTitle}\` LIMIT ${limit}`;
}

function runCli(args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const cli = CLI_CANDIDATES[0];
    const child = execFile('cmd.exe', ['/c', cli, ...args], { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && !stdout) return reject(new Error(`wecom-cli 执行失败: ${error.message}${stderr ? ' / ' + String(stderr).slice(0, 200) : ''}`));
        resolve(String(stdout || ''));
      });
    child.on('error', reject);
  });
}

/** 从 CLI 输出中提取 JSON（跳过 json repair 等提示行） */
function extractJson(text) {
  const idx = text.indexOf('{"errcode"');
  const start = idx >= 0 ? idx : text.indexOf('{"extra_identity_context"');
  const from = start >= 0 ? start : text.indexOf('{');
  if (from < 0) throw new Error('wecom-cli 未返回 JSON');
  return JSON.parse(text.slice(from));
}

/** Excel 序列号 → YYYY-MM-DD */
function excelDate(serial) {
  const value = Number(serial);
  if (!Number.isFinite(value) || value <= 0) return '';
  const ms = Date.UTC(1899, 11, 30) + Math.round(value * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(v => (v && typeof v === 'object') ? (v.name || v.text || '') : String(v)).filter(Boolean).join('、');
  }
  if (typeof value === 'object') return value.name || value.text || '';
  return String(value).trim();
}

/** 岗位 → 本地角色 */
function roleOf(position) {
  if (!position) return '';
  if (position.includes('店长')) return '店长';
  if (position.includes('兼职')) return '其他';
  return '店员';
}

/**
 * 拉取企微员工信息表并同步到本地 employees。
 * @param {object} db 数据库封装
 * @param {{docid:string, sheetTitle:string, limit?:number}} options
 */
async function syncEmployeesFromWecom(db, options = {}) {
  const docid = String(options.docid || '').trim();
  const sheetTitle = String(options.sheetTitle || '员工信息表').trim();
  if (!docid) throw new Error('缺少企微文档 ID（请在 config.json 配置 staffSmartSheetDocId）');
  const stdout = await runCli(['smartsheet', 'records', 'query', '--docid', docid, '--sql', buildSql(sheetTitle, options.limit || 500)]);
  const json = extractJson(stdout);
  if (json.errcode !== 0) throw new Error(`企微返回错误：${json.errmsg || json.errcode}`);
  const sqlValues = json.values || [];
  const first = typeof sqlValues[0] === 'string' ? JSON.parse(sqlValues[0]) : sqlValues[0];
  const rows = (first && first.rows) || [];
  if (!rows.length) return { total: 0, created: 0, updated: 0, skipped: 0, sheet_title: sheetTitle };

  const result = { total: rows.length, created: 0, updated: 0, skipped: 0, sheet_title: sheetTitle, errors: [] };
  db.run('BEGIN');
  try {
    rows.forEach(row => {
      const name = textOf(row['名字']);
      if (!name) { result.skipped++; return; }
      const payload = {
        name,
        phone: textOf(row['手机号']),
        gender: textOf(row['性别']),
        position: textOf(row['岗位']),
        role: roleOf(textOf(row['岗位'])),
        status: textOf(row['在职状态']) || '在职',
        onboarding_status: textOf(row['入职状态']),
        store_name: textOf(row['归属门店']),
        manager_name: textOf(row['归属店长']) || textOf(row['所属店长']),
        salary: Number(row['员工工资']) || 0,
        entry_date: excelDate(row['入职日期']),
        probation_date: excelDate(row['转正时间']),
        leave_date: excelDate(row['离职时间']),
        emergency_contact: textOf(row['紧急联系人']),
        emergency_phone: textOf(row['紧急联系电话']),
        remark: textOf(row['备注']),
        smartsheet_record_id: textOf(row['RECORD_ID']),
      };
      let target = payload.smartsheet_record_id
        ? db.queryOne('SELECT id FROM employees WHERE smartsheet_record_id=?', [payload.smartsheet_record_id])
        : null;
      if (!target && payload.phone) target = db.queryOne('SELECT id FROM employees WHERE name=? AND phone=?', [payload.name, payload.phone]);
      if (!target) {
        const same = db.queryAll('SELECT id FROM employees WHERE name=?', [payload.name]);
        if (same.length === 1) target = same[0];
      }
      const values = [payload.name, payload.phone, payload.gender, payload.position, payload.role, payload.status,
        payload.onboarding_status, payload.store_name, payload.manager_name, payload.salary,
        payload.entry_date, payload.probation_date, payload.leave_date,
        payload.emergency_contact, payload.emergency_phone, payload.remark, payload.smartsheet_record_id];
      if (target) {
        db.run(`UPDATE employees SET name=?, phone=?, gender=?, position=?, role=?, status=?, onboarding_status=?,
                store_name=?, manager_name=?, salary=?, entry_date=?, probation_date=?, leave_date=?,
                emergency_contact=?, emergency_phone=?, remark=?, smartsheet_record_id=?,
                updated_at=datetime('now','localtime') WHERE id=?`, [...values, target.id]);
        result.updated++;
      } else {
        db.insert(`INSERT INTO employees (name, phone, gender, position, role, status, onboarding_status,
                    store_name, manager_name, salary, entry_date, probation_date, leave_date,
                    emergency_contact, emergency_phone, remark, smartsheet_record_id, store_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...values, 0]);
        result.created++;
      }
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  db.save();
  return result;
}

module.exports = { syncEmployeesFromWecom, QUERY_FIELDS, excelDate };
