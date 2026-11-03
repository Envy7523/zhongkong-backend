'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {prepare}=require('../syncbot/windows-client/rejected-source.cjs');
for(const accepted of [false,true])test('failed source refresh preserves originals and journals; accepted='+accepted,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rejected-refresh-')),scope={version:'a'.repeat(64)},file='downloads/taobao_flash/2026-10-23/operating.xlsx',bytes=Buffer.concat([Buffer.from('PK'),Buffer.alloc(30)]),sha=crypto.createHash('sha256').update(bytes).digest('hex');
 const prior={id:crypto.randomUUID(),platform:'taobao_flash',date:'2026-10-23',reportType:'operating',status:'failed',code:'collector_no_active_source_rows',result:{file,sha256:sha}},job={...prior,id:crypto.randomUUID(),status:'running'};delete job.result;delete job.code;
 const journal=path.join(root,'flash-export-tests','2026-10-23-operating.json');fs.mkdirSync(path.dirname(journal),{recursive:true});fs.writeFileSync(journal,JSON.stringify({at:'2026-10-24T00:00:00Z'}));fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),bytes);fs.writeFileSync(path.join(root,file+'.json'),JSON.stringify({sha256:sha}));
 const c={root,history:[prior,job],saveHistory(){},cloud:{enabled:true,call:async(route,body)=>{assert.equal(route,'/diagnostic-source');assert.equal(body.sha256,sha);return {ok:true,accepted_for_import:false,sha256:sha,refresh_allowed:!accepted,refresh_policy_version:2};}}};
 try{assert.equal(await prepare(c,job,scope),!accepted);assert.equal(fs.existsSync(path.join(root,file)),accepted);assert.equal(fs.existsSync(journal),accepted);
 if(!accepted){const archived=path.join(root,'downloads/rejected-sources/taobao_flash/2026-10-23/operating',job.id);assert.equal(fs.readdirSync(archived).length,3);assert.deepEqual(fs.readFileSync(path.join(archived,'0-operating.xlsx')),bytes);assert.equal(await prepare(c,job,scope),false);}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('changed failed original cannot be discarded to force a new export',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rejected-change-')),file='downloads/taobao_flash/2026-10-23/operating.xlsx',scope={version:'a'.repeat(64)},prior={id:crypto.randomUUID(),platform:'taobao_flash',date:'2026-10-23',reportType:'operating',status:'failed',code:'collector_no_active_source_rows',rejectedSource:{sha256:'b'.repeat(64),file,scopeVersion:scope.version,refreshAllowed:true}},job={...prior,id:crypto.randomUUID(),status:'running'};
 fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'changed');try{await assert.rejects(prepare({root,history:[prior,job],saveHistory(){}},job,scope),/archive_changed/);assert.equal(fs.readFileSync(path.join(root,file),'utf8'),'changed');}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('legacy refresh permission is rechecked by the backend before any original or export journal is moved',async()=>{
 for(const receipt of [{refresh_allowed:false,refresh_policy_version:2},{refresh_allowed:true}]){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rejected-legacy-')),file='downloads/taobao_flash/2026-10-23/operating.xlsx',scope={version:'a'.repeat(64)},bytes=Buffer.concat([Buffer.from('PK'),Buffer.alloc(30)]),sha=crypto.createHash('sha256').update(bytes).digest('hex');
  const prior={id:crypto.randomUUID(),platform:'taobao_flash',date:'2026-10-23',reportType:'operating',status:'failed',code:'collector_no_active_source_rows',result:{file},rejectedSource:{sha256:sha,file,scopeVersion:scope.version,refreshAllowed:true}},job={id:crypto.randomUUID(),platform:'taobao_flash',date:prior.date,reportType:'operating',status:'running'};
  fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),bytes);let calls=0;
  const c={root,history:[prior,job],saveHistory(){},cloud:{enabled:true,call:async(route,body)=>{calls++;assert.equal(body.sha256,sha);return {ok:true,accepted_for_import:false,sha256:sha,...receipt};}}};
  try{assert.equal(await prepare(c,job,scope),false);assert.equal(calls,1);assert.deepEqual(fs.readFileSync(path.join(root,file)),bytes);assert.equal(prior.rejectedSource.refreshAllowed,false);}finally{fs.rmSync(root,{recursive:true,force:true});}
 }
});
