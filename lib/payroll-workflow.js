const { GROUP_NAMES, isGroupAffiliation } = require('./staff-affiliation');
const { normalizePermissions } = require('./permissions');

const EDITABLE = new Set(['草稿', '已保存', '退回']);
const MONTHLY_FIELDS = ['personal_leave','sick_leave','join_leave','annual_leave','weekday_overtime_hours','restday_overtime_hours','part_time_hours','reward','penalty','late_early_deduction','other_deduction','social_insurance','income_tax','utilities_fee','uniform_deposit'];
const STANDARD_FIELDS = ['base_salary','position_allowance','performance_salary','attendance_bonus','housing_allowance','part_time_hourly_rate','weekday_overtime_rate','restday_overtime_rate'];
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function periodOf(value) { const period = String(value || ''); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail('请选择正确月份'); return period; }
function groupOf(value) { if (!['group','store'].includes(value)) fail('请选择集团员工或门店员工'); return value; }
function currentMonth() { return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date()); }
function calendarOf(value,period) {
  const count=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).getUTCDate();
  if (!Array.isArray(value) || value.length!==count) fail('请登记当月每一天的出勤、休息或放假安排');
  const dates=new Set();
  const calendar=value.map(row=> {
    const date=String(row.date || ''), day=Number(date.slice(8));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0,7)!==period || day<1 || day>count || dates.has(date)) fail('出勤日期重复或不属于所选月份');
    dates.add(date); if (!['work','rest','holiday'].includes(row.type)) fail('请选择工作、休息或放假');
    const start=String(row.start_time || ''),end=String(row.end_time || '');
    if (row.type==='work' && ((!!start!==!!end) || [start,end].some(time=>time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || (start && start===end))) fail('请填写有效的上下班时间；跨日班次请勾选次日');
    if (row.type==='work' && start && end<start && !row.next_day) fail('结束时间早于开始时间，请确认是否次日下班');
    return {date,type:row.type,start_time:row.type==='work'?start:'',end_time:row.type==='work'?end:'',next_day:row.type==='work' && !!row.next_day,note:String(row.note || '').trim().slice(0,200)};
  });
  return calendar.sort((a,b)=>a.date.localeCompare(b.date));
}
function numberOf(value, max = 10000000) { const number = Number(value); if (!['number','string'].includes(typeof value) || String(value).trim()==='' || !Number.isFinite(number) || number < 0 || number > max) fail('请输入有效的非负数值'); return number; }
function actorFor(db, req) {
  const user = db.queryOne(`SELECT u.id,u.username,u.display_name,u.store_id,p.permissions_json,s.store_name FROM users u LEFT JOIN position_settings p ON p.id=u.position_id LEFT JOIN stores s ON s.id=u.store_id WHERE u.id=?`, [req.user?.id]);
  if (!user) fail('账号不存在', 401);
  const permissions = normalizePermissions(user.permissions_json), can = code => permissions.includes('*') || permissions.includes(code);
  const ownOnly = can('staff.store.edit') && !permissions.includes('*');
  if (ownOnly && !user.store_name) fail('店长账号尚未绑定有效门店，请联系管理员', 403);
  return { ...user, ownOnly, can, canPrepare:can('payroll.prepare') || (!ownOnly && can('staff.view')), canAttendance:!ownOnly && can('payroll.attendance'), canReview:!ownOnly && can('payroll.review'), canView:can('payroll.view') || can('payroll.prepare') || can('payroll.review') || can('payroll.attendance') || (!ownOnly && can('staff.view')) };
}
function transaction(db, action) { db.run('BEGIN'); try { const result = action(); db.run('COMMIT'); db.save(); return result; } catch (error) { db.run('ROLLBACK'); throw error; } }
function userStoreBinding(db,positionId,value) {
  const position=db.queryOne('SELECT permissions_json FROM position_settings WHERE id=?',[positionId]);
  const permissions=normalizePermissions(position?.permissions_json),required=permissions.includes('staff.store.edit') && !permissions.includes('*');
  const id=value == null || value==='' ? null : Number(value);
  if ((id!==null && (!Number.isInteger(id) || !db.queryOne('SELECT id FROM stores WHERE id=?',[id]))) || (required && id===null)) fail(required?'店长账号必须绑定有效门店':'所选门店不存在');
  return id;
}

function initialize(db) {
  const columns = new Set(db.queryAll('PRAGMA table_info(payroll_sheets)').map(row => row.name));
  const additions = { store_id:'INTEGER', staff_group:"TEXT DEFAULT 'store'", version:'INTEGER DEFAULT 1', setting_version:'INTEGER DEFAULT 0', submitted_by:'INTEGER', submitted_at:'TEXT', reviewed_by:'INTEGER', reviewed_at:'TEXT', review_reason:"TEXT DEFAULT ''" };
  transaction(db, () => {
    for (const [name, type] of Object.entries(additions)) if (!columns.has(name)) db.run(`ALTER TABLE payroll_sheets ADD COLUMN ${name} ${type}`);
    db.run(`CREATE TABLE IF NOT EXISTS payroll_attendance_settings (period TEXT NOT NULL,staff_group TEXT NOT NULL CHECK(staff_group IN ('group','store')),scheduled_days REAL NOT NULL,version INTEGER NOT NULL DEFAULT 1,published_by TEXT DEFAULT '',published_at TEXT,PRIMARY KEY(period,staff_group))`);
    if (!db.queryAll('PRAGMA table_info(payroll_attendance_settings)').some(row=>row.name==='calendar_json')) db.run("ALTER TABLE payroll_attendance_settings ADD COLUMN calendar_json TEXT DEFAULT '[]'");
    db.run(`CREATE TABLE IF NOT EXISTS payroll_attendance_events (id INTEGER PRIMARY KEY AUTOINCREMENT,period TEXT NOT NULL,staff_group TEXT NOT NULL,actor_id INTEGER NOT NULL,actor_name TEXT,version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now','localtime')))`);
    // Preserve the established HR role while making attendance an explicit permission.
    if (db.queryAll('PRAGMA table_info(position_settings)').some(row=>row.name==='name')) for (const role of db.queryAll("SELECT id,permissions_json FROM position_settings WHERE name='人事'")) {
      const rights=normalizePermissions(role.permissions_json);
      if (!rights.includes('*') && !rights.includes('payroll.attendance')) db.run('UPDATE position_settings SET permissions_json=? WHERE id=?',[JSON.stringify([...rights,'payroll.attendance']),role.id]);
    }
    db.run(`CREATE TABLE IF NOT EXISTS payroll_sheet_events (id INTEGER PRIMARY KEY AUTOINCREMENT,sheet_id INTEGER NOT NULL,action TEXT NOT NULL,actor_id INTEGER NOT NULL,actor_name TEXT,version INTEGER,note TEXT DEFAULT '',snapshot_json TEXT DEFAULT '{}',created_at TEXT DEFAULT (datetime('now','localtime')))`);
    // Preserve the existing monthly baseline in BOTH populations; HR can subsequently change either independently.
    for (const group of ['group','store']) db.run(`INSERT OR IGNORE INTO payroll_attendance_settings(period,staff_group,scheduled_days,published_by,published_at) SELECT period,?,scheduled_days,updated_by,updated_at FROM payroll_month_settings`, [group]);
    if (!columns.has('staff_group')) for (const sheet of db.queryAll('SELECT id,store_name,period FROM payroll_sheets')) {
      const stores = db.queryAll('SELECT id FROM stores WHERE store_name=?', [sheet.store_name]);
      db.run('UPDATE payroll_sheets SET staff_group=?,store_id=? WHERE id=?', [isGroupAffiliation(sheet.store_name) ? 'group' : 'store', stores.length === 1 ? stores[0].id : null, sheet.id]);
      db.run('UPDATE payroll_sheets SET setting_version=COALESCE((SELECT version FROM payroll_attendance_settings a WHERE a.period=payroll_sheets.period AND a.staff_group=payroll_sheets.staff_group),0) WHERE id=?',[sheet.id]);
    }
  });
}

// A narrowly scoped account must not reach legacy login-only APIs via a manually constructed request.
function scopeGuard(db) {
  return (req,res,next) => {
    if (!req.user || !req.path.startsWith('/api/') || req.path.startsWith('/api/mp/')) return next();
    try {
      const actor = actorFor(db, req);
      if (!actor.ownOnly) return next();
      const allowed = /^\/api\/(payroll-context|payroll-sheets(?:\/.*)?|store-staff(?:\/\d+)?|payroll-month-settings\/\d{4}-\d{2})$/.test(req.path) || (req.method === 'GET' && req.path === '/api/auth/me') || (req.method === 'PUT' && req.path === '/api/auth/profile');
      if (!allowed) return res.status(403).json({error:'店长账号仅开放本店员工信息与工资表制作'});
      next();
    } catch (error) { res.status(error.status || 403).json({error:error.message}); }
  };
}

function mount({app,db,readPayrollSheet,payrollTemplateRows,formatPayrollRow,payrollWorkbook,XLSX,monthNow=currentMonth}) {
  const wrap = action => (req,res) => { try { const actor = actorFor(db,req); action(req,res,actor); } catch(error) { res.status(error.status || 400).json({error:error.message}); } };
  const requireRight = (right, message) => { if (!right) fail(message,403); };
  const getSetting = (period,group) => db.queryOne('SELECT * FROM payroll_attendance_settings WHERE period=? AND staff_group=?',[period,group]) || {period,staff_group:group,scheduled_days:26,version:0,published_at:null};
  const presentSetting = setting => ({...setting,calendar:JSON.parse(setting.calendar_json || '[]'),can_edit:setting.period>=monthNow()});
  const getSheet = (id,actor) => {
    const sheet = db.queryOne('SELECT * FROM payroll_sheets WHERE id=?',[id]);
    if (!sheet || (actor.ownOnly && Number(sheet.store_id) !== Number(actor.store_id))) fail('工资表不存在或无权访问',404);
    if (actor.ownOnly && db.queryOne('SELECT i.id FROM payroll_sheet_items i LEFT JOIN employees e ON e.id=i.employee_id WHERE i.sheet_id=? AND (e.id IS NULL OR e.store_id IS NULL OR e.store_id!=?) LIMIT 1',[sheet.id,actor.store_id])) fail('此历史工资表含其他门店支援员工，请由人事处理',403);
    requireRight(actor.canView,'没有工资表权限'); return sheet;
  };
  const present = (sheet,actor) => ({...readPayrollSheet(sheet),can_edit:actor.canPrepare && EDITABLE.has(sheet.status),can_submit:actor.canPrepare && EDITABLE.has(sheet.status),can_review:actor.canReview && sheet.status==='待审核' && Number(sheet.submitted_by)!==Number(actor.id),events:db.queryAll('SELECT action,actor_name,note,version,created_at FROM payroll_sheet_events WHERE sheet_id=? ORDER BY id',[sheet.id])});
  const assertEditable = (sheet,actor,body) => { requireRight(actor.canPrepare,'没有工资表制作权限'); if (!EDITABLE.has(sheet.status)) fail('待审核或已审核工资表已锁定',409); if (Number(body.version)!==Number(sheet.version)) fail('工资表已被更新，请重新打开后再保存',409); };
  const event = (sheet,actor,action,note='') => db.insert('INSERT INTO payroll_sheet_events(sheet_id,action,actor_id,actor_name,version,note,snapshot_json) VALUES(?,?,?,?,?,?,?)',[sheet.id,action,actor.id,actor.display_name || actor.username,sheet.version,note,JSON.stringify(readPayrollSheet(sheet))]);
  const refresh = id => db.queryOne('SELECT * FROM payroll_sheets WHERE id=?',[id]);
  app.get('/api/payroll-context',wrap((req,res,actor) => {
    requireRight(actor.canView || actor.can('staff.store.edit'),'没有人事权限');
    res.json({ok:true,context:{own_only:actor.ownOnly,can_prepare:actor.canPrepare,can_attendance:actor.canAttendance,can_review:actor.canReview,can_standard:false,current_month:monthNow(),stores:actor.ownOnly ? [{id:actor.store_id,store_name:actor.store_name}] : db.queryAll('SELECT id,store_name,status FROM stores ORDER BY store_name'),group_names:actor.ownOnly ? [] : GROUP_NAMES}});
  }));
  app.get('/api/payroll-attendance-settings',wrap((req,res,actor)=> {
    requireRight(actor.canAttendance,'月出勤管理仅开放给管理员和人事');
    res.json({ok:true,current_month:monthNow(),settings:db.queryAll('SELECT * FROM payroll_attendance_settings ORDER BY period DESC,staff_group').map(presentSetting)});
  }));
  app.get('/api/payroll-month-settings/:period',wrap((req,res,actor) => {
    requireRight(actor.canView,'没有工资表权限'); const period=periodOf(req.params.period);
    res.json({ok:true,current_month:monthNow(),settings:{group:presentSetting(getSetting(period,'group')),store:presentSetting(getSetting(period,'store'))},setting:presentSetting(getSetting(period,'store'))});
  }));
  app.put('/api/payroll-month-settings/:period',wrap((req,res,actor) => {
    requireRight(actor.canAttendance,'应出勤天数由人事维护'); const period=periodOf(req.params.period),group=groupOf(req.body.staff_group),days=numberOf(req.body.scheduled_days,31);
    if (period<monthNow()) fail('上个月及之前的出勤安排已锁定，只可查看',403);
    if (days < 1 || days>new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).getUTCDate()) fail('应出勤天数须在 1 天至当月天数之间');
    const current=getSetting(period,group); if (Number(req.body.version)!==Number(current.version)) fail('出勤设置已更新，请重新读取',409);
    const calendar=Object.hasOwn(req.body,'calendar')?calendarOf(req.body.calendar,period):JSON.parse(current.calendar_json || '[]');
    if (calendar.length && calendar.filter(day=>day.type==='work').length!==days) fail('应出勤天数须与日历中的工作天数一致');
    const affected=[];
    transaction(db,() => {
      db.run(`INSERT INTO payroll_attendance_settings(period,staff_group,scheduled_days,version,published_by,published_at) VALUES(?,?,?,?,?,datetime('now','localtime')) ON CONFLICT(period,staff_group) DO UPDATE SET scheduled_days=excluded.scheduled_days,version=excluded.version,published_by=excluded.published_by,published_at=excluded.published_at`,[period,group,days,current.version+1,actor.display_name || actor.username]);
      db.run('UPDATE payroll_attendance_settings SET calendar_json=? WHERE period=? AND staff_group=?',[JSON.stringify(calendar),period,group]);
      db.insert('INSERT INTO payroll_attendance_events(period,staff_group,actor_id,actor_name,version,snapshot_json) VALUES(?,?,?,?,?,?)',[period,group,actor.id,actor.display_name || actor.username,current.version+1,JSON.stringify(getSetting(period,group))]);
      for (const sheet of db.queryAll("SELECT * FROM payroll_sheets WHERE period=? AND staff_group=? AND status IN ('草稿','已保存','退回')",[period,group])) {
        db.run("UPDATE payroll_sheets SET scheduled_days=?,setting_version=?,version=version+1,updated_at=datetime('now','localtime') WHERE id=?",[days,current.version+1,sheet.id]);
        event(refresh(sheet.id),actor,'更新应出勤',`${group==='group'?'集团':'门店'}：${sheet.scheduled_days} → ${days} 天`); affected.push(sheet.id);
      }
    });
    res.json({ok:true,setting:presentSetting(getSetting(period,group)),affected_sheet_ids:affected});
  }));
  app.get('/api/payroll-sheets',wrap((req,res,actor) => {
    requireRight(actor.canView,'没有工资表权限');
    res.json({ok:true,sheets:db.queryAll(`SELECT s.*,COUNT(i.id) AS employee_count FROM payroll_sheets s LEFT JOIN payroll_sheet_items i ON i.sheet_id=s.id ${actor.ownOnly?'WHERE s.store_id=?':''} GROUP BY s.id ORDER BY s.period DESC,s.updated_at DESC`,actor.ownOnly?[actor.store_id]:[])});
  }));
  app.post('/api/payroll-sheets/prepare',wrap((req,res,actor) => {
    requireRight(actor.canPrepare,'没有工资表制作权限'); const period=periodOf(req.body.period),name=String(req.body.store_name || '').trim();
    const store=db.queryOne('SELECT id,store_name FROM stores WHERE store_name=?',[name]),group=isGroupAffiliation(name)?'group':'store';
    if (!store && group!=='group') fail('门店或集团不存在');
    if (actor.ownOnly && Number(store?.id)!==Number(actor.store_id)) fail('只能制作本店工资表',403);
    let sheet=db.queryOne('SELECT * FROM payroll_sheets WHERE store_name=? AND period=?',[name,period]);
    if (sheet) { sheet=getSheet(sheet.id,actor); if (!EDITABLE.has(sheet.status)) return res.json({ok:true,sheet:present(sheet,actor)}); }
    const setting=getSetting(period,group); if (!setting.published_at) fail('请先由人事提交该月份的应出勤天数');
    const rows=payrollTemplateRows(name,period,setting.scheduled_days);
    if (actor.ownOnly && rows.some(row=>row.is_dispatch_support)) fail('本月存在跨店支援，请先由人事处理支援工资',403);
    transaction(db,() => {
      if (!sheet) sheet=refresh(db.insert("INSERT INTO payroll_sheets(store_name,store_id,staff_group,period,scheduled_days,setting_version,status) VALUES(?,?,?,?,?,?,'草稿')",[name,store?.id || null,group,period,setting.scheduled_days,setting.version]));
      if (Number(sheet.setting_version)!==Number(setting.version)) {
        db.run("UPDATE payroll_sheets SET scheduled_days=?,setting_version=?,version=version+1,updated_at=datetime('now','localtime') WHERE id=?",[setting.scheduled_days,setting.version,sheet.id]);
        event(refresh(sheet.id),actor,'同步应出勤');
      }
      const existing=new Set(db.queryAll('SELECT employee_id FROM payroll_sheet_items WHERE sheet_id=?',[sheet.id]).map(row=>Number(row.employee_id)));
      let sort=Number(db.queryOne('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM payroll_sheet_items WHERE sheet_id=?',[sheet.id]).n);
      let changed=false;
      for (const row of rows) if (!existing.has(Number(row.employee_id))) { db.insert('INSERT INTO payroll_sheet_items(sheet_id,employee_id,sort_order,data) VALUES(?,?,?,?)',[sheet.id,row.employee_id,sort++,JSON.stringify(row)]); changed=true; }
      if (changed) { db.run("UPDATE payroll_sheets SET version=version+1,updated_at=datetime('now','localtime') WHERE id=?",[sheet.id]); event(refresh(sheet.id),actor,'生成员工快照'); }
    });
    res.json({ok:true,sheet:present(refresh(sheet.id),actor)});
  }));
  app.get('/api/payroll-sheets/:id',wrap((req,res,actor)=>res.json({ok:true,sheet:present(getSheet(req.params.id,actor),actor)})));
  app.put('/api/payroll-sheets/:id',wrap((req,res,actor) => {
    const sheet=getSheet(req.params.id,actor); assertEditable(sheet,actor,req.body);
    const saved=readPayrollSheet(sheet).items,items=req.body.items;
    if (!Array.isArray(items) || items.length!==saved.length || new Set(items.map(row=>Number(row.id))).size!==saved.length) fail('工资明细不完整，请重新打开');
    // Validate the whole payload before writing any row; identity and employee ownership are server-owned.
    const updates=items.map(item=> {
      const original=saved.find(row=>Number(row.id)===Number(item.id)); if (!original || Number(item.employee_id)!==Number(original.employee_id)) fail('不能添加或替换工资表员工',403);
      const data={...original};
      for (const key of MONTHLY_FIELDS) if (Object.hasOwn(item,key)) data[key]=numberOf(item[key], /leave$/.test(key)?31:10000000);
      for (const key of STANDARD_FIELDS) if (Object.hasOwn(item,key)) {
        const value=numberOf(item[key]);
        if (value!==Number(original[key])) fail('标准工资不可在工资表中修改，请在人事薪酬档案维护',403);
        data[key]=value;
      }
      return {id:original.id,data:formatPayrollRow(data,sheet.scheduled_days)};
    });
    transaction(db,()=> {
      for (const item of updates) db.run("UPDATE payroll_sheet_items SET data=?,updated_at=datetime('now','localtime') WHERE id=? AND sheet_id=?",[JSON.stringify(item.data),item.id,sheet.id]);
      db.run("UPDATE payroll_sheets SET status='已保存',version=version+1,updated_at=datetime('now','localtime') WHERE id=?",[sheet.id]); event(refresh(sheet.id),actor,'保存明细');
    });
    res.json({ok:true,sheet:present(refresh(sheet.id),actor)});
  }));
  app.post('/api/payroll-sheets/:id/submit',wrap((req,res,actor)=> {
    const sheet=getSheet(req.params.id,actor); assertEditable(sheet,actor,req.body); if (!readPayrollSheet(sheet).items.length) fail('空工资表不能提交');
    const setting=getSetting(sheet.period,sheet.staff_group); if (!setting.published_at || Number(sheet.setting_version)!==Number(setting.version)) fail('应出勤设置已更新，请重新生成工资表',409);
    transaction(db,()=> { db.run("UPDATE payroll_sheets SET status='待审核',submitted_by=?,submitted_at=datetime('now','localtime'),reviewed_by=NULL,reviewed_at=NULL,review_reason='',version=version+1,updated_at=datetime('now','localtime') WHERE id=?",[actor.id,sheet.id]); event(refresh(sheet.id),actor,'提交审核'); });
    res.json({ok:true,sheet:present(refresh(sheet.id),actor)});
  }));
  app.post('/api/payroll-sheets/:id/review',wrap((req,res,actor)=> {
    requireRight(actor.canReview,'没有工资审核权限'); const sheet=getSheet(req.params.id,actor);
    if (sheet.status!=='待审核' || Number(req.body.version)!==Number(sheet.version)) fail('工资表状态已变化，请重新打开',409);
    if (Number(sheet.submitted_by)===Number(actor.id)) fail('提交人不能审核自己的工资表',403);
    if (!['approve','return'].includes(req.body.action)) fail('请选择通过或退回');
    const note=String(req.body.note || '').trim().slice(0,1000); if (req.body.action==='return' && !note) fail('请填写退回原因');
    transaction(db,()=> {
      const returned=req.body.action==='return',setting=getSetting(sheet.period,sheet.staff_group);
      db.run("UPDATE payroll_sheets SET status=?,reviewed_by=?,reviewed_at=datetime('now','localtime'),review_reason=?,scheduled_days=?,setting_version=?,version=version+1,updated_at=datetime('now','localtime') WHERE id=?",[returned?'退回':'已审核',actor.id,note,returned?setting.scheduled_days:sheet.scheduled_days,returned?setting.version:sheet.setting_version,sheet.id]); event(refresh(sheet.id),actor,returned?'退回':'审核通过',note);
    });
    res.json({ok:true,sheet:present(refresh(sheet.id),actor)});
  }));
  app.get('/api/payroll-sheets/:id/export',wrap((req,res,actor)=> {
    const sheet=getSheet(req.params.id,actor),draft=sheet.status!=='已审核';
    if (draft && req.query.draft!=='1') fail('正式工资表须审核通过；可先下载未审核预览');
    const name=`${sheet.store_name}-${sheet.period}${draft?'草稿-未审核':'已审核'}工资表.xlsx`.replace(/[\\/:*?"<>|]/g,'_');
    const buffer=XLSX.write(payrollWorkbook({...readPayrollSheet(sheet),export_label:draft?'草稿 · 未审核':'已审核'}),{bookType:'xlsx',type:'buffer',cellStyles:true});
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(name)}`); res.send(buffer);
  }));
}
module.exports={initialize,mount,scopeGuard,actorFor,userStoreBinding,MONTHLY_FIELDS,STANDARD_FIELDS};
