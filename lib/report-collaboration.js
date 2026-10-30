'use strict';
// A link and a live summary, never a second copy of the report's processing state.
const {fail,now}=require('./workflow-engine'),messages=require('./store-messages');
const canCollaborate=u=>messages.can(u,'collab.manage');
function initialize(db){db.run('CREATE TABLE IF NOT EXISTS store_report_collaborations(report_id INTEGER PRIMARY KEY,issue_id INTEGER NOT NULL UNIQUE,created_by INTEGER NOT NULL,created_at TEXT NOT NULL)')}
function link(db,issueId){return db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='store_report_collaborations'")?db.queryOne('SELECT * FROM store_report_collaborations WHERE issue_id=?',[Number(issueId)]):null}
function member(issue,u){let ids=[];try{ids=JSON.parse(issue.participants||'[]')}catch{}return canCollaborate(u)&&(Number(issue.created_by)===Number(u.id)||ids.map(Number).includes(Number(u.id)))}
function summary(db,reportId,u){const l=db.queryOne('SELECT issue_id FROM store_report_collaborations WHERE report_id=?',[reportId]);if(!l)return null;const issue=db.queryOne('SELECT * FROM collab_issues WHERE id=?',[l.issue_id]);if(!issue)return null;return {id:issue.id,issue_no:issue.issue_no,title:issue.title,status:issue.status,deadline:issue.deadline||'',updated_at:issue.updated_at,completion_note:issue.completion_note||'',can_open:member(issue,u)}}
function requireHandler(db,id,u,web=false){const p=require('./store-reports').present(db,id,u,web);if(!p.can_review||!canCollaborate(u))fail('仅当前处理人且具有协同事项权限时可发起协作',403);return p}
function options(db,id,u,web=false){const p=requireHandler(db,id,u,web);return {title:(p.type_name+' · '+p.store_name).slice(0,100),description:p.description,people:require('./staff-role-workflow').allUsers(db).filter(p=>p.id!==u.id&&canCollaborate(p)).map(p=>({id:p.id,name:p.display_name||p.username}))}}
function date(value){if(!value)return null;const s=String(value),d=new Date(s+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s)fail('请选择有效日期');return s}
function create(db,id,b,u,web=false){
 const p=requireHandler(db,id,u,web),existing=summary(db,p.id,u);if(existing)return {collaboration:existing,record:p,created:false};
 if(Number(b.revision)!==p.revision)fail('申报已更新，请刷新后重试',409);
 const title=String(b.title||'').trim(),description=String(b.description||'').trim(),start=date(b.start_time),deadline=date(b.deadline);
 if(!title||title.length>100||!description||description.length>5000)fail('请填写协作标题及说明，标题最多100字，说明最多5000字');
 if(start&&deadline&&deadline<start)fail('截止日期不能早于开始时间');
 if(!Array.isArray(b.participants)||!b.participants.length||b.participants.length>30||b.participants.some(v=>!Number.isSafeInteger(v)||v<=0))fail('请选择1至30位协作参与人');
 const ids=[...new Set(b.participants)],people=options(db,id,u,web).people;if(ids.some(id=>!people.some(p=>p.id===id)))fail('参与人已失效或没有协同事项权限，请重新选择',403);
 db.run('BEGIN');try{
  const issue=require('./collab-repository').createIssue({title,description,start_time:start,deadline,participants:ids,participants_name:ids.map(id=>people.find(p=>p.id===id).name),visibility:'internal',created_by:u.id,created_by_name:u.display_name||u.username||''},db);
  db.run('INSERT INTO store_report_collaborations VALUES(?,?,?,?)',[p.id,issue.id,u.id,now()]);
  db.run('INSERT INTO store_report_updates(report_id,actor_id,action,content,created_at) VALUES(?,?,?,?,?)',[p.id,u.id,'collaboration','发起关联协作：'+issue.issue_no+' '+title,now()]);
  db.run('UPDATE store_reports SET revision=revision+1,updated_at=? WHERE id=?',[now(),p.id]);
  db.run('COMMIT');
 }catch(e){db.run('ROLLBACK');throw e}
 db.save();
 return {collaboration:summary(db,p.id,u),record:require('./store-reports').present(db,p.id,u,web),created:true};
}
function source(db,issueId,u,web=false){const l=link(db,issueId);if(!l)return null;const reports=require('./store-reports'),r=db.queryOne('SELECT * FROM store_reports WHERE id=?',[l.report_id]);return {type:'store-report',report_id:l.report_id,label:'问题申报 #'+l.report_id,can_open:!!r&&reports.visible(db,r,u,web)}}
module.exports={initialize,link,summary,options,create,source,canCollaborate};
