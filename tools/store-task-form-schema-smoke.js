'use strict';
const assert=require('node:assert/strict'),service=require('../lib/store-tasks');
(async()=>{
 const {toDesignerRule,fromDesignerRules,questionNumber}=await import('../frontend/src/utils/store-task-form-schema.mjs');
 assert.equal(questionNumber(0),'01');assert.equal(questionNumber(9),'10');
 const qs=[{id:'multi',title:'检查项目',type:'multiple',required:true,options:['烤箱','冰箱','餐具']},{id:'select',title:'区域',type:'dropdown',required:true,options:['厨房','前厅']},{id:'day',title:'检查日期',type:'date',required:true},{id:'phone',title:'手机号',type:'text',required:true,maxLength:11,format:'phone',multiline:false},{id:'count',title:'数量',type:'number',required:true,lower:0,upper:10,precision:0}];
 const mapped=fromDesignerRules(qs.map(toDesignerRule));assert.equal(mapped[0].type,'multiple');assert.equal(mapped[3].format,'phone');assert.equal(mapped[4].precision,0);
 assert.throws(()=>fromDesignerRules([{...toDesignerRule(qs[0]),type:'html',on:{click:'arbitrary'}}]));
 const {db,raw}=await require('./store-tasks-fixture')();
 try{
 const admin={id:1,username:'admin',position_permissions:['*']},a={id:2,username:'A',store_id:1,position_permissions:['store-tasks.execute']},b={...a,id:3,username:'B'};
 const id=service.saveTemplate(db,{title:'完整题型',questions:mapped},admin).id;
 service.dispatch(db,{template_id:id,store_ids:[1],from:'2026-10-08',to:'2026-10-08',frequency:'once',due_time:'10:00'},admin,null);
 const task=service.list(db,{from:'2026-10-08',to:'2026-10-08'},1)[0].id;
 const detail=()=>service.detail(db,task,1);
 const write=(qid,value,user=a)=>service.writeAnswer(db,task,{question_id:qid,value,revision:detail().revision},user,1);
 const bad=(qid,v)=>assert.throws(()=>write(qid,v),e=>e.status===400);
 bad('multi',['不存在']);write('multi',['冰箱','烤箱']);write('multi',['烤箱','冰箱'],b);assert.equal(detail().results[0].conflict,false);write('multi',['餐具'],b);assert.equal(detail().results[0].conflict,true);write('multi',['烤箱','冰箱'],b);
 bad('select','其他');write('select','厨房');bad('day','2026-02-30');write('day','2026-10-08');bad('phone','123');write('phone','13800138000');bad('count','1.5');bad('count','-1');bad('count','11');write('count','0');
 assert.equal(detail().completed,5);service.submit(db,task,{revision:detail().revision},a,1);assert.equal(detail().status,'pending');
 const stored=service.templates(db)[0].questions;assert.equal(stored[3].maxLength,11);assert.equal(stored[4].upper,10);
 console.log('PASS: numbering from 01; designer/schema round trip; unsupported rules rejected; multiple/dropdown/date; phone and numeric rules; shared multi-select conflicts; immutable submission');
 }finally{raw.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
