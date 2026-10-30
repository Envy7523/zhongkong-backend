'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),XLSX=require('xlsx');
const cache=new Map();
const fields={quantity:'销售数量',sales_amount:'销售金额(元)',discount_amount:'优惠金额(元)',gift_quantity:'赠送数量',gift_amount:'赠送金额(元)',income_amount:'品项收入(元)'};
const text=v=>String(v??'').trim();
function number(v){if(v==null||v==='')return 0;const n=Number(String(v).replace(/[¥￥,%\s,]/g,''));if(!Number.isFinite(n))throw Error('invalid_number');return n;}
function date(v){if(typeof v==='number'){const s=String(Math.trunc(v));if(/^\d{8}$/.test(s))return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6);const d=XLSX.SSF.parse_date_code(v);return d?`${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`:'';}const s=text(v).replace(/[./]/g,'-'),m=s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);return m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:/^\d{8}$/.test(s)?s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6):'';}
const key=r=>JSON.stringify([r.pos_store_code,r.biz_date,r.order_id,r.product_code,r.product_name,r.sales_mode]);
const proofRoot=()=>process.env.SYNCBOT_ITEM_PROOF_ROOT||path.join(__dirname,'../data/item-update-proofs');
function saveProof(batch,day,buffer){
 if(!Number.isSafeInteger(Number(batch.id))||Number(batch.id)<=0)throw Error('proof_batch_invalid');
 const source=parse(buffer,day),sha=crypto.createHash('sha256').update(buffer).digest('hex');
 if(source.sourceRows!==Number(batch.row_count)||!source.rows.length)throw Error('proof_rows_invalid');
 fs.mkdirSync(proofRoot(),{recursive:true,mode:0o700});
 const file=path.join(proofRoot(),batch.id+'.json');
 fs.writeFileSync(file+'.tmp',JSON.stringify({version:1,batch_id:Number(batch.id),day,file_name:batch.file_name,sha,source}),{mode:0o600});fs.renameSync(file+'.tmp',file);
 return file;
}
function parse(buffer,day){
 const book=XLSX.read(buffer,{type:'buffer',cellDates:false}),maps=[];
 for(const sheet of book.SheetNames){
  const grid=XLSX.utils.sheet_to_json(book.Sheets[sheet],{header:1,defval:'',raw:true});
  const i=grid.findIndex(r=>['营业日期','订单号','品项名称','机构编码'].every(h=>r.map(text).includes(h)));
  if(i<0)continue;
  const header=grid[i].map(text),get=(r,h)=>r[header.indexOf(h)],map=new Map();let sourceRows=0;
  for(const r of grid.slice(i+1)){
   if(text(get(r,'城市'))==='合计'||r.every(v=>v==null||v===''))continue;
   const row={pos_store_code:text(get(r,'机构编码')),biz_date:date(get(r,'营业日期')),order_id:text(get(r,'订单号')),product_code:text(get(r,'菜品编码')),product_name:text(get(r,'品项名称')),sales_mode:text(get(r,'销售方式'))};
   if(row.biz_date!==day||!row.pos_store_code||!row.order_id||!row.product_name||row.product_name==='--')throw Error('source_scope_invalid');
   const k=key(row),old=map.get(k)||{...row,...Object.fromEntries(Object.keys(fields).map(f=>[f,0]))};
   for(const [field,h] of Object.entries(fields)){if(!header.includes(h))throw Error('source_header_missing');old[field]+=number(get(r,h));}
   map.set(k,old);sourceRows++;
  }
  maps.push({rows:[...map.values()],sourceRows});
 }
 if(maps.length!==1)throw Error('source_sheet_not_unique');return maps[0];
}
function loadSource(batch,day,run){
 const name=text(batch.file_name);if(!name||path.basename(name)!==name||/[\\/]/.test(name)||!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('archive_identity_invalid');
 const proofFile=path.join(proofRoot(),Number(batch.id)+'.json');
 if(fs.existsSync(proofFile)){
  const stat=fs.statSync(proofFile),stamp=stat.size+':'+stat.mtimeMs+':'+stat.ctimeMs;let hit=cache.get(proofFile);
  if(!hit||hit.stamp!==stamp){hit={stamp,data:JSON.parse(fs.readFileSync(proofFile,'utf8'))};if(cache.size>=16)cache.delete(cache.keys().next().value);cache.set(proofFile,hit);}
  const p=hit.data,prefix=text(run?.sha256_prefix);
  if(p.version!==1||p.batch_id!==Number(batch.id)||p.day!==day||p.file_name!==name||!/^[0-9a-f]{12,64}$/i.test(prefix)||!p.sha?.startsWith(prefix.toLowerCase())||!Array.isArray(p.source?.rows))throw Error('proof_identity_invalid');
  return p.source;
 }
 const base=process.env.SYNCBOT_ITEM_ARCHIVE_ROOT||'/opt/zhongkong-sync-bot/downloads/meituan/item_sales_detail';
 const file=path.join(base,day,name),stat=fs.statSync(file),stamp=stat.size+':'+stat.mtimeMs+':'+stat.ctimeMs;
 let entry=cache.get(file);
 if(!entry||entry.stamp!==stamp){const bytes=fs.readFileSync(file);entry={stamp,sha:crypto.createHash('sha256').update(bytes).digest('hex'),proof:parse(bytes,day)};if(cache.size>=16)cache.delete(cache.keys().next().value);cache.set(file,entry);}
 const prefix=text(run?.sha256_prefix);if(!/^[0-9a-f]{12,64}$/i.test(prefix)||!entry.sha.startsWith(prefix.toLowerCase()))throw Error('archive_hash_unverified');
 return entry.proof;
}
function evidence(db,day,run,scope,load=loadSource){
 const actual=db.queryAll('SELECT * FROM pos_product_sale_details WHERE biz_date=?',[day]);
 const base={ok:false,unverified:true,count:actual.length,expected:scope?.length??null,actual:new Set(actual.map(r=>r.store_id)).size,missing:[]};
 const batch=run?.import_batch_id&&db.queryOne('SELECT * FROM business_import_batches WHERE id=?',[run.import_batch_id]);
 if(!batch||batch.source_type!=='pos'||batch.platform!=='收银机品项销售明细'||batch.date_from!==day||batch.date_to!==day)return {...base,reason:'缺少与该营业日关联的品项原始导入批次'};
 let source;try{source=load(batch,day,run)}catch{return {...base,reason:'品项原始归档或文件哈希暂时无法核验'};}
 if(source.sourceRows!==Number(batch.row_count)||!source.rows.length)return {...base,reason:'品项原始行数与导入批次不一致'};
 if(source.rows.length!==actual.length)return {...base,reason:'品项源文件合并后条数与库内明细不一致'};
 const saved=new Map(actual.map(r=>[key(r),r]));
 if(saved.size!==actual.length)return {...base,reason:'品项库内存在重复业务键'};
 for(const row of source.rows){const hit=saved.get(key(row));if(!hit||Number(hit.batch_id)!==Number(batch.id)||!hit.store_id||!scope?.some(s=>Number(s.id)===Number(hit.store_id))||Object.keys(fields).some(f=>!Number.isFinite(row[f])||!Number.isFinite(Number(hit[f]))||Math.abs(row[f]-Number(hit[f]))>1e-6))return {...base,reason:'品项源文件与库内逐项数量、金额或批次不一致'};}
 return {...base,ok:true,unverified:false,reason:`原始${source.sourceRows}行合并为${actual.length}条，逐项数量与金额核对通过`};
}
module.exports={parse,evidence,loadSource,saveProof};
