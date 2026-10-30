'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const FOLDER='{374DE290-123F-4565-9164-39C4925E467B}';
function registryValue(){
 const r=cp.spawnSync('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders','/v',FOLDER],{windowsHide:true,shell:false});if(r.status!==0)return null;
 const b=r.stdout||Buffer.alloc(0);let text;
 if(b[0]===255&&b[1]===254)text=b.subarray(2).toString('utf16le');else{try{text=new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{const code=cp.spawnSync('cmd.exe',['/d','/c','chcp'],{encoding:'ascii',windowsHide:true}).stdout||'';const number=code.match(/\d{3,5}/)?.[0];text=new TextDecoder(number==='936'?'gb18030':number==='950'?'big5':number==='932'?'shift_jis':'windows-1252').decode(b);}}
 return text.split(/\r?\n/).map(line=>line.match(/\sREG_(?:EXPAND_)?SZ\s+(.+)$/)?.[1]?.trim()).filter(Boolean)[0]||null;
}
function resolveDownloadDirectory(config={},options={}){
 const platform=options.platform||process.platform,env=options.env||process.env,exists=options.exists||fs.existsSync,realpath=options.realpath||fs.realpathSync;
 let value=config.downloadDirectory;
 if(!value&&platform==='win32')value=(options.readRegistry||registryValue)();
 if(value)value=value.replace(/%([^%]+)%/g,(all,key)=>Object.entries(env).find(([k])=>k.toLowerCase()===key.toLowerCase())?.[1]||all);
 else value=path.join(options.homedir||os.homedir(),'Downloads');
 if(typeof value!=='string'||value.includes('%')||!path.isAbsolute(value)||!exists(value))throw Error('client_download_directory_missing');
 try{const directory=realpath(value);if(!options.exists&&!fs.statSync(directory).isDirectory())throw Error('not_directory');return directory;}catch{throw Error('client_download_directory_missing');}
}
module.exports={resolveDownloadDirectory,registryValue};
