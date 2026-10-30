const E=require('./workflow-engine'),M=require('./store-messages');
function initialize(db){
 db.run('CREATE TABLE IF NOT EXISTS store_report_round_timing(workflow_id INTEGER PRIMARY KEY,report_id INTEGER,submitted_at TEXT NOT NULL,submitted_revision INTEGER,processed_at TEXT,processed_by INTEGER)');
 db.run('CREATE TABLE IF NOT EXISTS store_report_round_reads(workflow_id INTEGER,user_id INTEGER,read_at TEXT,kind TEXT,PRIMARY KEY(workflow_id,user_id))');
 db.run('INSERT OR IGNORE INTO store_report_round_timing(workflow_id,report_id,submitted_at,submitted_revision) SELECT rr.workflow_id,rr.report_id,COALESCE(w.created_at,r.created_at),CASE WHEN (SELECT COUNT(*) FROM store_report_rounds x WHERE x.report_id=r.id)=1 THEN 1 ELSE r.revision END FROM store_report_rounds rr JOIN store_reports r ON r.id=rr.report_id JOIN workflow_instances w ON w.id=rr.workflow_id');
 // Existing reads are used only when the receiver can be identified in this round's first node.
 // Never infer read times from approval, update, archive or sender/CC activity.
 for(const t of db.queryAll('SELECT t.*,w.template_json,r.created_by FROM store_report_round_timing t JOIN store_reports r ON r.workflow_id=t.workflow_id JOIN workflow_instances w ON w.id=t.workflow_id WHERE t.processed_at IS NULL')){
  const ids=JSON.parse(t.template_json).nodes?.[0]?.user_ids||[];if(!ids.length)continue;
  const reads=db.queryAll("SELECT * FROM store_report_people WHERE report_id=? AND kind='handler' AND read_at IS NOT NULL",[t.report_id]).filter(p=>p.user_id!==t.created_by&&ids.includes(p.user_id)&&Date.parse(p.read_at)>=Date.parse(t.submitted_at)).sort((a,b)=>Date.parse(a.read_at)-Date.parse(b.read_at));
  if(reads.length)db.run('UPDATE store_report_round_timing SET processed_at=?,processed_by=? WHERE workflow_id=? AND processed_at IS NULL',[reads[0].read_at,reads[0].user_id,t.workflow_id]);
 }
}
function begin(db,r,w,revision){db.run('INSERT OR IGNORE INTO store_report_round_timing(workflow_id,report_id,submitted_at,submitted_revision) VALUES(?,?,?,?)',[w.id,r.id,revision===1?r.created_at:(w.created_at||r.created_at),revision]);}
function metadata(db,r){const t=db.queryOne('SELECT * FROM store_report_round_timing WHERE workflow_id=?',[r.workflow_id]);return {submitted_at:t?.submitted_at||r.created_at,processed_at:t?.processed_at||null,processed_by:t?.processed_by||null,processing_state:t?.processed_at?'processing':'pending',processing_label:t?.processed_at?'处理中':'待处理',round_count:db.queryOne('SELECT COUNT(*) n FROM store_report_rounds WHERE report_id=?',[r.id])?.n||1};}
function read(db,r,u,event=null,at=E.now()){
 const p=db.queryOne('SELECT * FROM store_report_people WHERE report_id=? AND user_id=?',[r.id,u.id]);if(!p)return;
 const w=E.load(db,r.workflow_id),t=db.queryOne('SELECT * FROM store_report_round_timing WHERE workflow_id=?',[r.workflow_id]);if(!t)return;
 if(event){const payload=JSON.parse(event.payload_json||'{}');if(payload.workflow_id?payload.workflow_id!==r.workflow_id:metadata(db,r).round_count!==1)return;if(Number(payload.revision)<Number(t.submitted_revision)||!payload.user_ids?.includes(u.id))return;}
 const timestamp=Number.isFinite(Date.parse(at))&&Date.parse(at)>=Date.parse(t.submitted_at)?at:E.now();
 db.run('UPDATE store_report_people SET read_at=COALESCE(read_at,?) WHERE report_id=? AND user_id=?',[timestamp,r.id,u.id]);
 db.run('INSERT OR IGNORE INTO store_report_round_reads(workflow_id,user_id,read_at,kind) VALUES(?,?,?,?)',[w.id,u.id,timestamp,p.kind]);
 const node=w.template.nodes[w.stage],eligible=p.kind==='handler'&&u.id!==r.created_by&&node?.user_ids.includes(u.id)&&require('./staff-role-workflow').allUsers(db).some(x=>x.id===u.id)&&require('./staff-role-workflow').reviewer(db,u,node,r.store_id);
 if(!eligible||event&&JSON.parse(event.payload_json||'{}').handler_ids&&!JSON.parse(event.payload_json||'{}').handler_ids.includes(u.id))return;
 db.run('UPDATE store_report_round_timing SET processed_at=COALESCE(processed_at,?),processed_by=CASE WHEN processed_at IS NULL THEN ? ELSE processed_by END WHERE workflow_id=?',[timestamp,u.id,w.id]);
}
function readMessage(db,event,u,at){const r=db.queryOne('SELECT * FROM store_reports WHERE id=?',[event.target_id]);if(!r||!require('./store-reports').visible(db,r,u))return;read(db,r,u,event,at);}
module.exports={initialize,begin,metadata,read,readMessage};
