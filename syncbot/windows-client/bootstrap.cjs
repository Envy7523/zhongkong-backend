'use strict';
// Kept outside the remotely replaceable file set, so a broken app can still recover after a reboot.
const path=require('node:path'),fs=require('node:fs');
const root=process.env.ETG_COLLECTOR_HOME||path.join(process.env.LOCALAPPDATA,'EtaigongDeliveryCollector');
fs.mkdirSync(root,{recursive:true});
const stateFile=path.join(root,'update-state.json');
if(!fs.existsSync(stateFile)){const v=JSON.parse(fs.readFileSync(path.join(__dirname,'version.json')));require('./update-worker.cjs').atomic(stateFile,{version:v.version,sequence:v.sequence||0,channel:'stable',status:'current'});}
require('./update-worker.cjs').recover(root,path.resolve(__dirname,'..'));
const journal=require('./update-worker.cjs').read(path.join(root,'updates/journal.json'),null);
if(journal&&['applying','checking'].includes(journal.phase)&&!process.argv.includes('--update-probe')){console.log('软件正在升级，请稍后。');process.exit(0);}
require('./app.cjs').main().catch(e=>{console.error(e.message);process.exitCode=1;});
