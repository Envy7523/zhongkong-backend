const {isGroupAffiliation}=require('./staff-affiliation');
function initialize(db){db.run('CREATE TABLE IF NOT EXISTS staff_supervisor_assignments (employee_id INTEGER PRIMARY KEY,store_id INTEGER NOT NULL,updated_at TEXT)');}
function assignment(db,id){try{return db.queryOne('SELECT a.*,s.store_name FROM staff_supervisor_assignments a JOIN stores s ON s.id=a.store_id WHERE employee_id=?',[id]);}catch(e){if(/no such table/.test(e.message))return null;throw e;}}
function effective(db,row){const a=assignment(db,row.id);return a?{...row,store_id:a.store_id,store_name:a.store_name,payroll_group_name:row.payroll_group_name || row.store_name,supervisor:true}:row;}
function validate(db,employee,storeId,positions){
 if(storeId===null || storeId==='')return null;
 const id=Number(storeId);if(!Number.isInteger(id)||!db.queryOne('SELECT id FROM stores WHERE id=?',[id]))throw Error('请选择有效的兼任门店');
 if(!isGroupAffiliation(employee.store_name) || !String(employee.position || '').includes('督导'))throw Error('兼任门店特例只用于集团主岗位为督导的员工');
 if(!positions.some(p=>p.position.includes('店长')))throw Error('兼任门店须同时登记店长岗位');
 return id;
}
function save(db,id,storeId){if(storeId===null)db.run('DELETE FROM staff_supervisor_assignments WHERE employee_id=?',[id]);else db.run("INSERT INTO staff_supervisor_assignments VALUES(?,?,datetime('now','localtime')) ON CONFLICT(employee_id) DO UPDATE SET store_id=excluded.store_id,updated_at=excluded.updated_at",[id,storeId]);}
module.exports={initialize,assignment,effective,validate,save};
