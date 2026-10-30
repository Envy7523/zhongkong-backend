'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
test('安装在上层 type:module 目录中仍能启动采集器，四个显式包边界随签名文件白名单下发',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'delivery-esm-parent-'));try{
  fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');const install=path.join(root,'download','collector');
  const dirs=['windows-client','src/meituan-delivery','src/jd-delivery','src/taobao-flash'];
  for(const dir of dirs)fs.cpSync(path.resolve('syncbot',dir),path.join(install,dir),{recursive:true});
  const script="require('./windows-client/core.cjs');require('./windows-client/extension-broker.cjs');require('./windows-client/open-client.cjs');require('./src/meituan-delivery/operating-file.js');require('./src/jd-delivery/source-file.js');require('./src/taobao-flash/source-file.js');console.log('commonjs-startup-ok')";
  fs.writeFileSync(path.join(install,'probe.cjs'),script);
  const opts={cwd:install,encoding:'utf8',env:{...process.env,NODE_PATH:process.env.NODE_PATH||path.resolve('node_modules')}};
  let r=cp.spawnSync(process.execPath,['probe.cjs'],opts);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/commonjs-startup-ok/);
  const worker=require('../syncbot/windows-client/update-worker.cjs');for(const dir of dirs)assert.equal(worker.target(install,dir+'/package.json'),path.join(install,dir,'package.json'));
  fs.unlinkSync(path.join(install,'src/meituan-delivery/package.json'));r=cp.spawnSync(process.execPath,['probe.cjs'],opts);assert.notEqual(r.status,0);assert.match(r.stderr,/ES module|require is not defined/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
