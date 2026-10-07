const crypto=require('node:crypto');
const {actorFor}=require('./payroll-workflow');
const {isGroupAffiliation,GROUP_NAMES}=require('./staff-affiliation');
const {settle,dateAdd}=require('./roster-balance');
const todayNow=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
function fail(message,status=400){const error=new Error(message);error.status=status;throw error}
function dateOf(value){const date=String(value || '');if(!/^20\d{2}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)fail('日期无效');return date}
function weekOf(value){const date=dateOf(value);if(new Date(date+'T00:00:00Z').getUTCDay()!==1)fail('请选择周一作为排班起始日');return date}
function transaction(db,fn){db.run('BEGIN');try{const value=fn();db.run('COMMIT');db.save();return value}catch(error){db.run('ROLLBACK');throw error}}
function initialize(db,today=todayNow()){
  transaction(db,()=>{
    db.run('CREATE TABLE IF NOT EXISTS staff_roster_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.run("INSERT OR IGNORE INTO staff_roster_meta VALUES('active_from',?)",[today]);
    db.run("CREATE TABLE IF NOT EXISTS staff_roster_weeks (scope TEXT NOT NULL,week_start TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,rows_json TEXT NOT NULL,updated_by TEXT,updated_at TEXT,PRIMARY KEY(scope,week_start))");
    db.run("CREATE TABLE IF NOT EXISTS staff_roster_exceptions (employee_id INTEGER NOT NULL,date TEXT NOT NULL,decision TEXT NOT NULL DEFAULT 'pending',reason TEXT NOT NULL,hours REAL,version INTEGER NOT NULL DEFAULT 1,updated_by TEXT,updated_at TEXT,PRIMARY KEY(employee_id,date))");
    db.run('CREATE TABLE IF NOT EXISTS staff_leave_accounts (employee_id INTEGER PRIMARY KEY,version INTEGER NOT NULL DEFAULT 1,fingerprint TEXT NOT NULL,snapshot_json TEXT NOT NULL,updated_at TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS staff_leave_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT,employee_id INTEGER NOT NULL,version INTEGER NOT NULL,source TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS staff_roster_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT,week_start TEXT,employee_id INTEGER,action TEXT NOT NULL,actor_id INTEGER,actor_name TEXT,reason TEXT,snapshot_json TEXT,created_at TEXT)');
  });
}
function service(db,today=todayNow){
  const activeFrom=()=>db.queryOne("SELECT value FROM staff_roster_meta WHERE key='active_from'").value;
  function employee(id,actor){const row=db.queryOne('SELECT id,name,store_id,store_name,hire_type,entry_date,leave_date,status FROM employees WHERE id=?',[id]);if(!row || actor.ownOnly && Number(row.store_id)!==Number(actor.store_id))fail('员工不存在或不属于本店',404);return row}
  function compute(row){
    const date=today(),start=activeFrom(),from=start.slice(0,7)+'-01';
    const allSettings=db.queryAll('SELECT * FROM payroll_attendance_settings WHERE period>=?',[from.slice(0,7)]),group=isGroupAffiliation(row.store_name)?'group':'store';
    const settings=Object.fromEntries(allSettings.filter(s=>s.staff_group===group).map(s=>[s.period,s]));
    const plans=new Map();
    for(const week of db.queryAll("SELECT rows_json FROM staff_roster_weeks WHERE status='published' AND week_start>=?",[dateAdd(from,-6)])){
      const person=JSON.parse(week.rows_json).find(person=>Number(person.employee_id)===Number(row.id));if(person)for(const day of person.days)plans.set(day.date,day);
    }
    if(group==='group')for(const setting of Object.values(settings))for(const day of JSON.parse(setting.calendar_json || '[]'))if(!['leave','comp'].includes(plans.get(day.date)?.type))plans.set(day.date,{...day,reason:day.note || ''});
    const punches=new Map();for(const record of db.queryAll('SELECT work_date,check_time,check_type,time_result FROM dingtalk_attendance_records WHERE employee_id=? AND work_date>=? AND work_date<=? ORDER BY check_time',[row.id,from,date])){if(!punches.has(record.work_date))punches.set(record.work_date,[]);punches.get(record.work_date).push(record)}
    const exceptions=new Map(db.queryAll('SELECT * FROM staff_roster_exceptions WHERE employee_id=? AND date>=?',[row.id,from]).map(e=>[e.date,e]));
    const days=[];for(let day=from;day<=date;day=dateAdd(day,1)){
      if(row.entry_date && day<row.entry_date || row.leave_date && day>row.leave_date)continue;
      days.push({date:day,office:group==='group',plan:plans.get(day),records:punches.get(day) || [],exception:exceptions.get(day)});
    }
    const result=settle({days,settings,today:date,activeFrom:start,partTime:row.hire_type==='兼职'});
    return {...result,employee:{id:row.id,name:row.name,hire_type:row.hire_type},active_from:start,part_time_policy:'hourly_no_bank'};
  }
  function prepareAccount(row){
    const result=compute(row),snapshot=JSON.stringify(result),fingerprint=crypto.createHash('sha256').update(snapshot).digest('hex'),old=db.queryOne('SELECT version,fingerprint FROM staff_leave_accounts WHERE employee_id=?',[row.id]);
    return {row,result,snapshot,fingerprint,old,version:old?.fingerprint===fingerprint?old.version:(old?.version || 0)+1,changed:old?.fingerprint!==fingerprint};
  }
  function persist(item,source){
    const {row,result,snapshot,fingerprint,version}=item;
      db.run("INSERT INTO staff_leave_accounts(employee_id,version,fingerprint,snapshot_json,updated_at) VALUES(?,?,?,?,datetime('now','localtime')) ON CONFLICT(employee_id) DO UPDATE SET version=excluded.version,fingerprint=excluded.fingerprint,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at",[row.id,version,fingerprint,snapshot]);
      const {days,...ledger}=result;
      db.insert("INSERT INTO staff_leave_revisions(employee_id,version,source,snapshot_json,created_at) VALUES(?,?,?,?,datetime('now','localtime'))",[row.id,version,source,JSON.stringify(ledger)]);
  }
  function reconcile(row,source='自动核算'){const item=prepareAccount(row);if(item.changed)transaction(db,()=>persist(item,source));return {...item.result,version:item.version}}
  // One atomic save for the entire sweep, rather than exporting the large DB
  // separately for each employee. Unchanged sweeps perform no database write.
  const runAll=()=>{const items=db.queryAll('SELECT id,name,store_id,store_name,hire_type,entry_date,leave_date,status FROM employees').map(prepareAccount).filter(item=>item.changed);if(items.length)transaction(db,()=>{for(const item of items)persist(item,'自动核算')});return items.length};
  return {employee,compute,reconcile,runAll,activeFrom};
}
function mount({app,db,today=todayNow,readPayrollSheet,formatPayrollRow}){
  const engine=service(db,today);
  const wrap=fn=>(req,res)=>{try{const actor=actorFor(db,req);if(!(actor.ownOnly && actor.can('staff.store.edit')) && !actor.canAttendance)fail('排班仅开放给店长、人事与管理员',403);fn(req,res,actor)}catch(error){res.status(error.status || 400).json({error:error.message})}};
  const scopeFor=(value,actor)=>{if(actor.ownOnly){const scope=`store:${actor.store_id}`;if(value && value!==scope)fail('只能安排本店员工',403);return scope}if(value==='office')return value;if(!/^store:\d+$/.test(value || '') || !db.queryOne('SELECT id FROM stores WHERE id=?',[Number(value.split(':')[1])]))fail('请选择有效门店');return value};
  const people=(scope,week)=>db.queryAll('SELECT id,name,hire_type,store_id,store_name,entry_date,leave_date,status FROM employees WHERE '+(scope==='office'?'store_name IN (?,?,?,?)':'store_id=?')+' ORDER BY name',scope==='office'?GROUP_NAMES:[Number(scope.split(':')[1])]).filter(row=>(!row.entry_date || row.entry_date<=dateAdd(week,6)) && (!row.leave_date || row.leave_date>=week));
  function read(scope,week,actor){
    const saved=db.queryOne('SELECT * FROM staff_roster_weeks WHERE scope=? AND week_start=?',[scope,week]),rows=JSON.parse(saved?.rows_json || '[]');
    const dates=Array.from({length:7},(_,i)=>dateAdd(week,i));
    const settings=Object.fromEntries(db.queryAll('SELECT * FROM payroll_attendance_settings WHERE period IN (?,?) AND staff_group=?',[week.slice(0,7),dates[6].slice(0,7),scope==='office'?'group':'store']).map(s=>[s.period,s]));
    const employees=people(scope,week).map(row=>{
      const existing=rows.find(person=>person.employee_id===row.id),account=engine.compute(row),byDay=new Map(account.days.map(day=>[day.date,day]));
      const exceptions=new Map(db.queryAll('SELECT * FROM staff_roster_exceptions WHERE employee_id=? AND date>=? AND date<=?',[row.id,week,dates[6]]).map(e=>[e.date,e]));
      return {employee_id:row.id,name:row.name,hire_type:row.hire_type,days:dates.map(date=>{
        const officeDay=scope==='office'?JSON.parse(settings[date.slice(0,7)]?.calendar_json || '[]').find(day=>day.date===date):null;
        let plan=existing?.days.find(day=>day.date===date) || {date,type:officeDay?.type || 'unassigned',start_time:'',end_time:'',next_day:false,reason:''};
        if(officeDay && !['leave','comp'].includes(plan.type))plan={...plan,type:officeDay.type,start_time:officeDay.start_time || '',end_time:officeDay.end_time || '',next_day:!!officeDay.next_day,reason:officeDay.note || ''};
        const active=(!row.entry_date || date>=row.entry_date) && (!row.leave_date || date<=row.leave_date);
        return {...plan,office_type:officeDay?.type || 'unassigned',exception:exceptions.get(date) || {version:0,decision:'pending',reason:'',hours:null},actual:byDay.get(date),can_edit:active && date>=today() && (saved?.status!=='published' || row.hire_type==='兼职' || actor.canAttendance)};
      })};
    });
    return {scope,week_start:week,dates,status:saved?.status || 'draft',version:saved?.version || 0,employees,settings,today:today(),can_confirm:actor.canAttendance,can_submit:dates[6]>=today(),active_from:engine.activeFrom()};
  }
  const audit=(actor,scope,week,action,reason,snapshot,employeeId=null)=>db.insert("INSERT INTO staff_roster_audit(scope,week_start,employee_id,action,actor_id,actor_name,reason,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?,?,datetime('now','localtime'))",[scope,week,employeeId,action,actor.id,actor.display_name || actor.username,reason,JSON.stringify(snapshot)]);
  app.get('/api/staff-roster/context',wrap((req,res,actor)=>res.json({ok:true,own_only:actor.ownOnly,can_confirm:actor.canAttendance,today:today(),active_from:engine.activeFrom(),scopes:actor.ownOnly?[{value:`store:${actor.store_id}`,label:actor.store_name}]:[{value:'office',label:'办公室员工'},...db.queryAll('SELECT id,store_name FROM stores ORDER BY store_name').map(row=>({value:`store:${row.id}`,label:row.store_name}))]})));
  app.get('/api/staff-roster/week',wrap((req,res,actor)=>res.json({ok:true,week:read(scopeFor(req.query.scope,actor),weekOf(req.query.week_start),actor)})));
  app.put('/api/staff-roster/week',wrap((req,res,actor)=>{
    const scope=scopeFor(req.body.scope,actor),week=weekOf(req.body.week_start),current=read(scope,week,actor),reason=String(req.body.reason || '').trim().slice(0,500);
    if(Number(req.body.version)!==current.version)fail('排班已更新，请重新打开',409);
    if(dateAdd(week,6)<today())fail('历史周排班只读，考勤修订请交由人事',403);
    const input=req.body.employees;if(!Array.isArray(input) || input.length!==current.employees.length || new Set(input.map(p=>Number(p.employee_id))).size!==input.length)fail('员工排班不完整');
    const normalized=input.map(person=>{
      const original=current.employees.find(p=>p.employee_id===Number(person.employee_id));if(!original)fail('只能安排本店归属员工，不能安排支援员工',403);
      if(!Array.isArray(person.days) || person.days.length!==7 || new Set(person.days.map(d=>d.date)).size!==7)fail('请完整填写七天排班');
      const days=current.dates.map(date=>{
        const day=person.days.find(day=>day.date===date),old=original.days.find(day=>day.date===date);if(!day || !['unassigned','work','rest','leave','comp','overtime','holiday'].includes(day.type) || scope!=='office' && day.type==='holiday')fail('排班状态无效');
        const normalized={date,type:day.type,start_time:String(day.start_time || ''),end_time:String(day.end_time || ''),next_day:!!day.next_day,reason:String(day.reason || '').trim().slice(0,500)};
        if(scope==='office' && !['leave','comp'].includes(day.type) && day.type!==old.office_type)fail('办公室工作与休息日期请在月出勤管理统一设置');
        if(day.type==='leave' && !normalized.reason)fail('请假必须填写原因');
        if(!['work','overtime'].includes(day.type)){normalized.start_time='';normalized.end_time='';normalized.next_day=false}
        else if((!!normalized.start_time!==!!normalized.end_time) || [normalized.start_time,normalized.end_time].some(t=>t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || normalized.start_time && (normalized.start_time===normalized.end_time || normalized.end_time<normalized.start_time && !normalized.next_day))fail('上下班时间无效，跨日请勾选次日');

        const oldPlan=Object.fromEntries(Object.keys(normalized).map(key=>[key,old[key]])),changed=JSON.stringify(normalized)!==JSON.stringify(oldPlan);
        if(changed && !old.can_edit)fail('正式员工周排班已固定或日期已过去，请交由人事处理',403);
        if(changed && current.status==='published' && original.hire_type!=='兼职' && !reason)fail('修改已提交正式员工排班必须填写调整原因');
        return normalized;
      });return {employee_id:original.employee_id,days};
    });
    const status=req.body.publish || current.status==='published'?'published':'draft';
    if(status==='published' && normalized.some(person=>current.employees.find(row=>row.employee_id===person.employee_id)?.hire_type!=='兼职'))for(const period of new Set(current.dates.map(date=>date.slice(0,7))))if(!current.settings[period]?.published_at)fail('请先由人事提交该月份的应出勤天数');
    // Reserve future compensatory days against unexpired earned stock. No debit
    // happens until the day ends; all published weeks participate in reservation.
    for(const person of normalized){
      const old=current.employees.find(row=>row.employee_id===person.employee_id);
      if(!person.days.some(day=>day.type==='comp' && day.date>=today() && (old.days.find(d=>d.date===day.date)?.type!=='comp' || req.body.publish && current.status!=='published')))continue;
      const row=engine.employee(person.employee_id,actor),lots=engine.compute(row).lots.map(lot=>({...lot})),reserved=new Map();
      for(const other of db.queryAll("SELECT week_start,rows_json FROM staff_roster_weeks WHERE status='published'")){
        if(other.week_start===week)continue;
        const stored=JSON.parse(other.rows_json).find(p=>Number(p.employee_id)===person.employee_id);
        for(const day of stored?.days || [])if(day.type==='comp' && day.date>=today())reserved.set(day.date,day);
      }
      for(const day of person.days)if(day.type==='comp' && day.date>=today())reserved.set(day.date,day);
      for(const date of [...reserved.keys()].sort()){
        let needed=1;
        for(const lot of lots.filter(lot=>lot.remaining>0 && lot.expires_on>date).sort((a,b)=>a.expires_on.localeCompare(b.expires_on) || a.date.localeCompare(b.date))){const used=Math.min(needed,lot.remaining);lot.remaining-=used;needed-=used;if(!needed)break}
        if(needed>0)fail(`${row.name} 在 ${date} 的可用存假余额不足，不能安排调休`);
      }
    }
    const previous=db.queryOne('SELECT rows_json FROM staff_roster_weeks WHERE scope=? AND week_start=?',[scope,week]);
    const preserved=JSON.parse(previous?.rows_json || '[]').filter(person=>!normalized.some(row=>row.employee_id===person.employee_id));
    transaction(db,()=>{db.run("INSERT INTO staff_roster_weeks(scope,week_start,status,version,rows_json,updated_by,updated_at) VALUES(?,?,?,?,?,?,datetime('now','localtime')) ON CONFLICT(scope,week_start) DO UPDATE SET status=excluded.status,version=excluded.version,rows_json=excluded.rows_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at",[scope,week,status,current.version+1,JSON.stringify([...normalized,...preserved]),actor.display_name || actor.username]);audit(actor,scope,week,status==='published'?'提交或调整周排班':'保存排班草稿',reason,normalized)});
    res.json({ok:true,week:read(scope,week,actor)});
  }));
  app.put('/api/staff-roster/employees/:id/exceptions/:date',wrap((req,res,actor)=>{
    const row=engine.employee(Number(req.params.id),actor),date=dateOf(req.params.date),old=db.queryOne('SELECT * FROM staff_roster_exceptions WHERE employee_id=? AND date=?',[row.id,date]),reason=String(req.body.reason || '').trim().slice(0,500);
    if(Number(req.body.version)!==(old?.version || 0))fail('考勤确认已更新，请重新读取',409);
    if(!reason)fail('请填写请假或考勤修订原因');
    if(row.entry_date && date<row.entry_date || row.leave_date && date>row.leave_date)fail('日期不在员工在职期间');
    const decision=String(req.body.decision || 'pending');if(!['pending','leave','absent','work'].includes(decision))fail('确认类型无效');
    if(['absent','work'].includes(decision) && date>=today())fail('仅可认定已结束日期的旷工或补录实际工时');
    if(!actor.canAttendance && (decision!=='pending' || req.body.hours!==undefined && req.body.hours!==null || old && old.decision!=='pending'))fail('请假批准、旷工认定和工时修订仅供人事及管理员',403);
    const hours=req.body.hours===null || req.body.hours===undefined || req.body.hours===''?null:Number(req.body.hours);
    if(hours!==null && (!['string','number'].includes(typeof req.body.hours) || !Number.isFinite(hours) || hours<0 || hours>24))fail('工时须在 0 至 24 小时之间');
    if(decision==='work' && hours===null)fail('确认出勤须填写经核实的实际工时');
    transaction(db,()=>{db.run("INSERT INTO staff_roster_exceptions(employee_id,date,decision,reason,hours,version,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,datetime('now','localtime')) ON CONFLICT(employee_id,date) DO UPDATE SET decision=excluded.decision,reason=excluded.reason,hours=excluded.hours,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at",[row.id,date,decision,reason,hours,(old?.version || 0)+1,actor.display_name || actor.username]);audit(actor,row.store_id?`store:${row.store_id}`:'office',date,'考勤与请假确认',reason,{decision,hours},row.id)});
    res.json({ok:true,account:engine.reconcile(row,'考勤确认后重算')});
  }));
  app.get('/api/staff-roster/employees/:id/balance',wrap((req,res,actor)=>{
    const row=engine.employee(Number(req.params.id),actor),account=engine.reconcile(row,'排班库存查询自动结算');
    const revisions=db.queryAll('SELECT version,source,created_at FROM staff_leave_revisions WHERE employee_id=? ORDER BY id DESC LIMIT 20',[row.id]);res.json({ok:true,account,revisions});
  }));
  function payrollPreview(id,actor){
    const sheet=db.queryOne('SELECT * FROM payroll_sheets WHERE id=?',[id]);
    if(!sheet || actor.ownOnly && Number(sheet.store_id)!==Number(actor.store_id))fail('工资表不存在或无权访问',404);
    if(!actor.canPrepare || !['草稿','已保存','退回'].includes(sheet.status))fail('仅可带入有制作权限的草稿工资表',403);
    if(!readPayrollSheet || !formatPayrollRow)fail('工资核对服务未配置',503);
    const rows=readPayrollSheet(sheet).items.map(item=>{
      const result={id:item.id,employee_id:item.employee_id,name:item.name,old_paid_days:item.actual_days,eligible:false};
      if(item.hire_type==='兼职')return {...result,reason:'兼职按实际工时计薪，保留原工时工资'};
      if(item.is_dispatch_support || Number(item.dispatch_out_days)>0 || Number(item.support_days)>0)return {...result,reason:'跨店支援工资须核对分摊，保留原明细'};
      const employee=engine.employee(item.employee_id,actor),account=engine.compute(employee),month=account.months.find(month=>month.period===sheet.period),days=account.days.filter(day=>day.date.startsWith(sheet.period+'-'));
      const dispatch=db.queryOne("SELECT id FROM employee_store_dispatches WHERE employee_id=? AND status='有效' AND ((dispatch_mode='selected' AND dispatch_dates_json LIKE ?) OR (dispatch_mode!='selected' AND start_date<=? AND end_date>=?))",[item.employee_id,'%'+sheet.period+'-%',sheet.period+'-31',sheet.period+'-01']);
      if(dispatch)return {...result,reason:'员工有支援登记，须人工核对工资分摊'};
      if(sheet.period>=today().slice(0,7))return {...result,reason:'本月尚未结束，仅展示排班及库存暂算'};
      if(!month || !days.length || sheet.period<account.active_from.slice(0,7))return {...result,reason:'该月在排班库存启用之前，保留原工资'};
      if(days.some(day=>day.status==='pending' || day.status==='planned'))return {...result,reason:'存在待核考勤，须先由人事确认'};
      return {...result,eligible:true,paid_days:month.paid_days,actual_work_days:month.actual_work_days,banked:month.credited,used:month.used,leave_days:month.leave_days,absent_days:month.absent_days};
    });return {sheet,rows,source_token:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
  }
  app.get('/api/staff-roster/payroll/:id/preview',wrap((req,res,actor)=>{const {sheet,rows,source_token}=payrollPreview(req.params.id,actor);res.json({ok:true,version:sheet.version,rows,source_token})}));
  app.post('/api/staff-roster/payroll/:id/apply',wrap((req,res,actor)=>{
    const {sheet,rows,source_token}=payrollPreview(req.params.id,actor);if(Number(req.body.version)!==sheet.version || req.body.source_token!==source_token)fail('工资或考勤来源已更新，请重新预览',409);
    const eligible=rows.filter(row=>row.eligible);if(!eligible.length)fail('暂无可带入的已核实考勤');
    const saved=readPayrollSheet(sheet).items;
    transaction(db,()=>{
      for(const row of eligible){const old=saved.find(item=>item.id===row.id),salary_overrides={...(old.salary_overrides || {})};
        for(const key of ['actual_base_salary','actual_position_allowance','actual_performance_salary','actual_attendance_bonus','actual_housing_allowance'])delete salary_overrides[key];
        Object.assign(salary_overrides,{actual_days:row.paid_days,weekday_overtime_pay:0,restday_overtime_pay:0});
        const data=formatPayrollRow({...old,personal_leave:row.leave_days,weekday_overtime_hours:0,restday_overtime_hours:0,salary_overrides,roster_settlement:{as_of:today(),...row}},sheet.scheduled_days);
        db.run("UPDATE payroll_sheet_items SET data=?,updated_at=datetime('now','localtime') WHERE id=? AND sheet_id=?",[JSON.stringify(data),row.id,sheet.id]);
      }
      db.run("UPDATE payroll_sheets SET status='已保存',version=version+1,updated_at=datetime('now','localtime') WHERE id=?",[sheet.id]);
      const fresh=db.queryOne('SELECT * FROM payroll_sheets WHERE id=?',[sheet.id]);
      db.insert("INSERT INTO payroll_sheet_events(sheet_id,action,actor_id,actor_name,version,note,snapshot_json) VALUES(?,?,?,?,?,?,?)",[sheet.id,'带入排班与调休考勤',actor.id,actor.display_name || actor.username,fresh.version,'超额出勤存假不重复计加班工资；跨店及待核人员跳过',JSON.stringify(readPayrollSheet(fresh))]);
    });res.json({ok:true,applied_count:eligible.length});
  }));
  return engine;
}
module.exports={initialize,mount,service,todayNow,dateOf,weekOf};
