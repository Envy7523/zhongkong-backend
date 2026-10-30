'use strict';
// Manual recovery of package boundaries only. Stable updater/bootstrap, parent
// package.json, accounts, credentials, downloads, and task states are untouched.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const allowed=['windows-client/package.json','src/meituan-delivery/package.json','src/jd-delivery/package.json','src/taobao-flash/package.json'];
function repair({directory,envelope,publicKey}){
 const client=fs.realpathSync(directory),install=path.dirname(client);
 if(path.basename(client)!=='windows-client')throw Error('repair_installation_invalid');
 const installedKey=fs.readFileSync(path.join(client,'update-public-key.pem'));
 if(!installedKey.equals(publicKey))throw Error('repair_trust_mismatch');
 const bytes=Buffer.from(envelope.payload,'base64');if(!crypto.verify(null,bytes,installedKey,Buffer.from(envelope.signature,'base64')))throw Error('repair_signature_invalid');
 const release=JSON.parse(bytes);const changes=[];
 for(const relative of allowed){
  const matches=release.files.filter(f=>f.path===relative);if(matches.length!==1)throw Error('repair_package_missing');
  const f=matches[0],data=Buffer.from(f.data,'base64'),spec=JSON.parse(data);
  if(data.length!==f.size||crypto.createHash('sha256').update(data).digest('hex')!==f.sha256||spec.type!=='commonjs'||spec.private!==true||Object.keys(spec).some(k=>!['name','private','type'].includes(k)))throw Error('repair_package_invalid');
  const target=path.join(install,...relative.split('/')),parent=path.dirname(target);
  if(fs.realpathSync(parent)!==parent||!parent.startsWith(install+path.sep))throw Error('repair_path_invalid');
  if(fs.existsSync(target)){
   if(fs.lstatSync(target).isSymbolicLink())throw Error('repair_path_invalid');
   const old=JSON.parse(fs.readFileSync(target,'utf8'));if(old.type==='commonjs')continue;
   throw Error('repair_existing_package_conflict');
  }
  changes.push({relative,target,data});
 }
 // All signatures, hashes and target conflicts are checked before the first write.
 for(const f of changes){const temp=f.target+'.repair-'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,f.data,{flag:'wx'});fs.renameSync(temp,f.target)}finally{if(fs.existsSync(temp))fs.unlinkSync(temp)}}
 return {version:release.version,changed:changes.map(f=>f.relative)};
}
if(require.main===module){
 (async()=>{
  const directory=path.resolve(process.argv[2]||''),envelope=JSON.parse(fs.readFileSync(path.join(__dirname,'signed-update.json'),'utf8')),publicKey=fs.readFileSync(path.join(__dirname,'update-public-key.pem'));
  const result=repair({directory,envelope,publicKey});
  console.log('已校验原有签名信任链。模块边界修复：'+result.changed.length+' 项。');
  console.log('未修改上层 package.json、授权、登录资料、原件或任务状态。');
  await require(path.join(directory,'open-client.cjs')).open({directory});
 })().catch(e=>{console.error('修复／启动诊断：'+e.message);process.exitCode=1});
}
module.exports={repair,allowed};
