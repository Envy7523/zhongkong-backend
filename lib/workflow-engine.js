'use strict';
// Business adapters supply authorization and execution; this module owns transitions.
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})},now=()=>new Date().toISOString();
function initialize(db){
 db.run('CREATE TABLE IF NOT EXISTS workflow_templates(id INTEGER PRIMARY KEY,name TEXT,business TEXT,revision INTEGER,enabled INTEGER,config_json TEXT,updated_at TEXT)');
 db.run('CREATE TABLE IF NOT EXISTS workflow_instances(id INTEGER PRIMARY KEY,business TEXT,employee_id INTEGER,store_id INTEGER,created_by INTEGER,status TEXT,execution_status TEXT,stage INTEGER,revision INTEGER,template_json TEXT,payload_json TEXT,created_at TEXT,updated_at TEXT)');
 db.run('CREATE TABLE IF NOT EXISTS workflow_events(id INTEGER PRIMARY KEY,instance_id INTEGER,stage INTEGER,actor_id INTEGER,action TEXT,note TEXT,created_at TEXT)');
 db.run("CREATE UNIQUE INDEX IF NOT EXISTS workflow_employee_pending ON workflow_instances(business,employee_id) WHERE status='pending' OR (status='approved' AND execution_status<>'done')");
}
function load(db,id){const r=db.queryOne('SELECT * FROM workflow_instances WHERE id=?',[Number(id)]);if(!r)fail('申请不存在',404);return {...r,template:JSON.parse(r.template_json),payload:JSON.parse(r.payload_json)}}
function event(db,r,u,action,note=''){db.run('INSERT INTO workflow_events(instance_id,stage,actor_id,action,note,created_at) VALUES(?,?,?,?,?,?)',[r.id,r.stage,u.id,action,note,now()])}
function pending(r){return r.template.nodes[r.stage]}
function canReview(db,r,u){return r.status==='pending'&&u.id!==r.created_by&&pending(r).user_ids.includes(u.id)&&!db.queryOne("SELECT id FROM workflow_events WHERE instance_id=? AND stage=? AND actor_id=? AND action='approve'",[r.id,r.stage,u.id])}
function create(db,business,payload,template,u){const id=db.insert("INSERT INTO workflow_instances(business,employee_id,store_id,created_by,status,execution_status,stage,revision,template_json,payload_json,created_at,updated_at) VALUES(?,?,?,?,'pending','waiting',0,1,?,?,?,?)",[business,payload.employee_id,payload.store_id,u.id,JSON.stringify(template),JSON.stringify(payload),now(),now()]);const r=load(db,id);event(db,r,u,'submit',payload.reason);return r}
function decide(db,r,body,u){
 if(Number(body.revision)!==r.revision)fail('申请已更新，请刷新',409);
 const action=body.action,note=String(body.note||'').trim();if(note.length>1000)fail('意见最多1000字');
 if(action==='cancel'){if(r.created_by!==u.id||r.status!=='pending')fail('只能撤回自己的待审批申请',403)}
 else {if(!canReview(db,r,u))fail('当前节点无审批权限或已处理',403);if(!['approve','reject'].includes(action))fail('操作无效');if(action==='reject'&&!note)fail('驳回必须填写原因')}
 event(db,r,u,action,note);
 let status=action==='cancel'?'cancelled':action==='reject'?'rejected':'pending',stage=r.stage;
 if(action==='approve'){const n=pending(r),count=db.queryOne("SELECT COUNT(DISTINCT actor_id) n FROM workflow_events WHERE instance_id=? AND stage=? AND action='approve'",[r.id,r.stage]).n;if(n.mode==='any'||count===n.user_ids.length){stage++;if(stage===r.template.nodes.length)status='approved'}}
 db.run('UPDATE workflow_instances SET status=?,stage=?,revision=revision+1,updated_at=? WHERE id=?',[status,stage,now(),r.id]);return load(db,r.id);
}
module.exports={initialize,load,event,pending,canReview,create,decide,fail,now};
