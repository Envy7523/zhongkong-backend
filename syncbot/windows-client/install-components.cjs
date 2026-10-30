'use strict';
// Native Windows registration, without PowerShell scripts or execution-policy changes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const HOST_KEY='HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.etaigong.delivery',TASK='EtaigongDeliveryCollector';
function run(file,args){const r=cp.spawnSync(file,args,{encoding:'utf8',windowsHide:true,shell:false});if(r.error||r.status!==0)throw Error('windows_registration_failed');return r.stdout||'';}
function xml(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}
function installHost({directory=__dirname,remove=false,execute=run}={}){
 if(remove){execute('reg.exe',['delete',HOST_KEY,'/f']);return {removed:true};}
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,'chrome-extension/manifest.json'))),id=[...crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
 if(id!=='ggbkmkegbhhaldlkiimgkpboodcnbldl')throw Error('extension_identity_mismatch');
 const launcher=path.join(directory,'native-host.cmd'),file=path.join(directory,'native-host-manifest.json');
 // ASCII batch source; expanded paths can contain Chinese characters and spaces.
 fs.writeFileSync(launcher,'@echo off\r\nsetlocal\r\nset "ETG_HOST_NODE=%~dp0..\\runtime\\node.exe"\r\nif exist "%ProgramFiles%\\nodejs\\node.exe" set "ETG_HOST_NODE=%ProgramFiles%\\nodejs\\node.exe"\r\n"%ETG_HOST_NODE%" "%~dp0native-host.cjs" %*\r\n','ascii');
 fs.writeFileSync(file,JSON.stringify({name:'com.etaigong.delivery',description:'Etaigong delivery collector bridge',path:launcher,type:'stdio',allowed_origins:['chrome-extension://'+id+'/']},null,2));
 execute('reg.exe',['add',HOST_KEY,'/ve','/t','REG_SZ','/d',file,'/f']);execute('reg.exe',['query',HOST_KEY,'/ve']);return {ok:true,extensionId:id};
}
function taskXml({directory,node,sid}){if(!/^S-\d(?:-\d+)+$/.test(sid))throw Error('windows_user_identity_invalid');return `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Collector"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Collector"><Exec><Command>${xml(node)}</Command><Arguments>&quot;${xml(path.join(directory,'bootstrap.cjs'))}&quot; --serve-only</Arguments><WorkingDirectory>${xml(directory)}</WorkingDirectory></Exec></Actions></Task>`;}
function installAutostart({directory=__dirname,node=process.execPath,remove=false,execute=run}={}){
 if(remove){execute('schtasks.exe',['/Delete','/TN',TASK,'/F']);return {removed:true};}
 const sid=execute('whoami.exe',['/user','/fo','csv','/nh']).match(/S-\d(?:-\d+)+/)?.[0];const contents=taskXml({directory,node,sid}),temp=fs.mkdtempSync(path.join(os.tmpdir(),'etg-task-')),file=path.join(temp,'task.xml');
 try{fs.writeFileSync(file,'\uFEFF'+contents,'utf16le');execute('schtasks.exe',['/Create','/TN',TASK,'/XML',file,'/F']);execute('schtasks.exe',['/Query','/TN',TASK]);}finally{fs.unlinkSync(file);fs.rmdirSync(temp);}return {ok:true};
}
function launcher(action){if(!['host','remove-host','autostart','remove-autostart'].includes(action))throw Error('installer_action_invalid');return '@echo off\r\nsetlocal\r\nset "ETG_SETUP_NODE=%ProgramFiles%\\nodejs\\node.exe"\r\nif not exist "%ETG_SETUP_NODE%" set "ETG_SETUP_NODE=%~dp0runtime\\node.exe"\r\n"%ETG_SETUP_NODE%" "%~dp0windows-client\\install-components.cjs" '+action+'\r\nif errorlevel 1 echo Installation failed. Keep the message above.\r\npause\r\n';}
if(require.main===module){try{if(process.platform!=='win32')throw Error('windows_required');const a=process.argv[2];if(a==='host'||a==='remove-host'){console.log(JSON.stringify(installHost({remove:a==='remove-host'})));console.log(a==='host'?'Chrome通信组件安装成功。请点击采集扩展图标重新连接。':'Chrome通信组件已移除。');}else if(a==='autostart'||a==='remove-autostart'){installAutostart({remove:a==='remove-autostart'});console.log(a==='autostart'?'登录后自动启动已设置。':'登录后自动启动已取消。');}else throw Error('installer_action_invalid');}catch(e){console.error('安装未完成：'+e.message);process.exitCode=1;}}
module.exports={installHost,installAutostart,taskXml,launcher};
