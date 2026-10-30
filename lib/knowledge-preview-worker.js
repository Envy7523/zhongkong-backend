'use strict';
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
(async()=>{
 const [file,dir,ext]=process.argv.slice(2);let result={pages:[],images:[],note:''};
 if(ext==='pdf'){
  const bundled=path.join(process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData/Local'),'../..','.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/Library/bin');
  const executable=name=>process.env.KNOWLEDGE_POPPLER_DIR?path.join(process.env.KNOWLEDGE_POPPLER_DIR,name+(process.platform==='win32'?'.exe':'')):process.platform==='win32'&&fs.existsSync(path.join(bundled,name+'.exe'))?path.join(bundled,name+'.exe'):name;
  const info=execFileSync(executable('pdfinfo'),[file],{encoding:'utf8',timeout:15000,windowsHide:true});const count=Number(info.match(/Pages:\s+(\d+)/)?.[1]);if(!count||count>200)throw Error('PDF预览支持最多200页');
  execFileSync(executable('pdftoppm'),['-jpeg','-jpegopt','quality=88','-scale-to-x','1600','-scale-to-y','-1',file,path.join(dir,'page')],{timeout:150000,windowsHide:true,maxBuffer:1024*1024});
  result.images=fs.readdirSync(dir).filter(n=>/^page-\d+\.jpg$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));if(result.images.length!==count)throw Error('PDF页面生成不完整');
  result.pages=result.images.map((_,i)=>({title:'第 '+(i+1)+' 页',image_index:i}));result.layout='full-page';
 }
 else if(['docx','pptx'].includes(ext))result=JSON.parse(execFileSync(process.platform==='win32'?'python':'python3',[path.join(__dirname,'knowledge-office-preview.py'),file,dir,ext],{encoding:'utf8',timeout:25000,maxBuffer:4*1024*1024,windowsHide:true}));
 else if(['xls','xlsx'].includes(ext)){
  const XLSX=require('xlsx'),workbook=XLSX.readFile(file,{cellFormula:false,cellHTML:false,sheetRows:201});
  for(const name of workbook.SheetNames.slice(0,30)){const rows=XLSX.utils.sheet_to_json(workbook.Sheets[name],{header:1,raw:false,defval:''}).slice(0,200);for(let i=0;i<rows.length;i+=8)result.pages.push({title:name+' · 第'+(i+1)+'至'+Math.min(i+8,rows.length)+'行',table:rows.slice(i,i+8).map(row=>row.slice(0,30).map(v=>String(v).slice(0,80)))})}result.note='每表预览前200行、30列，每格最多80字。完整数据及公式请查看原文件。';
 }else if(['jpg','jpeg','png','webp'].includes(ext)){fs.copyFileSync(file,path.join(dir,'media-0.'+ext));result.images=['media-0.'+ext]}
 else if(ext==='txt'){const text=fs.readFileSync(file,'utf8');result.pages=Array.from({length:Math.min(100,Math.ceil(text.length/4500))},(_,i)=>({title:'第 '+(i+1)+' 段',text:text.slice(i*4500,i*4500+4500)}))}
 else result.note='请使用“查看原文件”阅读完整资料。';
 const sharp=require('sharp');if(result.layout!=='full-page'){for(let i=0;i<result.images.length;i++){const name=result.images[i];await sharp(path.join(dir,name),{limitInputPixels:60000000}).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toFile(path.join(dir,'preview-'+i+'.jpg'))}result.images=result.images.map((_,i)=>'preview-'+i+'.jpg')}
 fs.writeFileSync(path.join(dir,'preview.json'),JSON.stringify(result));process.stdout.write('ready');
 if(['jpg','jpeg','png','webp'].includes(ext))await sharp(file).rotate().resize({width:480,height:360,fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toFile(path.join(dir,'cover-thumbnail.jpg'));
})().catch(e=>{process.stderr.write(e.message);process.exitCode=1});
