'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../lib/db'),'utf8');
const saveSource=source.slice(source.indexOf('function save() {'),source.indexOf('/** 执行多条 SQL',source.indexOf('function save() {')));
function fixture(failure) {
  const files=new Map([['/data/database.sqlite',Buffer.from('previous valid database')]]);
  let attempts=0;
  const io={writeFileSync(path,data,options){assert.equal(options.mode,0o600);files.set(path,Buffer.from(data));attempts++;if(failure==='write'){files.set(path,Buffer.from('partial'));throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}},renameSync(from,to){if(failure==='rename')throw new Error('rename failed');files.set(to,files.get(from));files.delete(from);},existsSync:path=>files.has(path),unlinkSync:path=>files.delete(path)};
  const save=new Function('db','fs','DB_PATH','sleepSync',saveSource+';return save;')({export:()=>Buffer.from('new complete database')},io,'/data/database.sqlite',()=>{});
  return {files,save,attempts:()=>attempts};
}
test('数据库保存完成后替换原文件，临时文件不残留',()=>{const f=fixture();f.save();assert.equal(f.files.get('/data/database.sqlite').toString(),'new complete database');assert.equal(f.files.size,1);});
test('磁盘满或替换失败保留原数据库，重试失败后报告错误',()=>{for(const failure of ['write','rename']){const f=fixture(failure);assert.throws(f.save);assert.equal(f.files.get('/data/database.sqlite').toString(),'previous valid database');assert.equal(f.files.size,1);assert.equal(f.attempts(),3);}});
