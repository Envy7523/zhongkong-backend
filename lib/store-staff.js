const {actorFor} = require('./payroll-workflow');
const FIELDS = ['name','phone','gender','entry_date','hire_type','position','id_card_number','bank_name','bank_branch','bank_account_name','bank_card_number','emergency_contact','emergency_phone','contact_address','remark'];
function mount({app,db,validateStaffFields}) {
  const wrap = action => (req,res) => { try { const actor=actorFor(db,req); if (!actor.ownOnly || !actor.can('staff.store.edit')) return res.status(403).json({error:'此入口仅供绑定门店的店长使用'}); action(req,res,actor); } catch(error) { res.status(error.status || 400).json({error:error.message}); } };
  const read = (id,actor) => db.queryOne(`SELECT id,store_id,store_name,status,salary,updated_at,${FIELDS.join(',')} FROM employees WHERE id=? AND store_id=?`,[id,actor.store_id]);
  app.get('/api/store-staff',wrap((req,res,actor)=>res.json({ok:true,store_name:actor.store_name,employees:db.queryAll(`SELECT id,store_id,store_name,status,salary,updated_at,${FIELDS.join(',')} FROM employees WHERE store_id=? ORDER BY status,name`,[actor.store_id])})));
  const save=(req,res,actor)=> {
    const old=req.params.id?read(req.params.id,actor):null;
    if (req.params.id && !old) return res.status(404).json({error:'员工不存在或不属于本店'});
    if (old && String(req.body.updated_at || '')!==String(old.updated_at || '')) return res.status(409).json({error:'员工资料已被更新，请刷新后再编辑'});
    const data={};
    for (const key of Object.keys(req.body)) if (!FIELDS.includes(key) && key!=='updated_at') return res.status(400).json({error:'店长不能修改员工归属、薪酬或系统字段'});
    for (const key of FIELDS) data[key]=String(req.body[key] ?? old?.[key] ?? '').trim().slice(0,key==='remark'?1000:200);
    if (!data.name || !['全职','兼职'].includes(data.hire_type)) return res.status(400).json({error:'请填写姓名并选择用工类型'});
    if (data.entry_date && (!/^\d{4}-\d{2}-\d{2}$/.test(data.entry_date) || Number.isNaN(Date.parse(data.entry_date)))) return res.status(400).json({error:'入职日期无效'});
    const errors=validateStaffFields(data); if (errors && (Array.isArray(errors)?errors.length:true)) return res.status(400).json({error:Array.isArray(errors)?errors.join('；'):String(errors)});
    db.run('BEGIN'); let id;
    try {
      if (old) { id=old.id; db.run(`UPDATE employees SET ${FIELDS.map(key=>`${key}=?`).join(',')},updated_at=? WHERE id=? AND store_id=?`,[...FIELDS.map(key=>data[key]),new Date().toISOString(),id,actor.store_id]); }
      else id=db.insert(`INSERT INTO employees(store_id,store_name,${FIELDS.join(',')},updated_at) VALUES(${new Array(FIELDS.length+3).fill('?').join(',')})`,[actor.store_id,actor.store_name,...FIELDS.map(key=>data[key]),new Date().toISOString()]);
      db.insert("INSERT INTO employee_lifecycle_events(employee_id,event_type,event_date,note,source,details_json) VALUES(?,?,date('now','localtime'),?,?,?)",[id,old?'资料变更':'入职',old?'店长更新本店员工基础信息':'店长录入本店员工，固定薪酬待人事维护',actor.display_name || actor.username,JSON.stringify({actor_id:actor.id,changes:FIELDS.filter(key=>old?.[key]!==data[key]).map(key=>({field:key,old:old?.[key] || '',new:data[key]}))})]);
      db.run('COMMIT'); db.save();
    } catch(error) { db.run('ROLLBACK'); throw error; }
    res.json({ok:true,employee:read(id,actor)});
  };
  app.post('/api/store-staff',wrap(save)); app.put('/api/store-staff/:id',wrap(save));
}
module.exports={mount,FIELDS};
