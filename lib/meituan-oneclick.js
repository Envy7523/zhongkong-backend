'use strict';
const contract=require('../syncbot/src/meituan-oneclick-file.cjs');
function initialize(db){
 // Existing rows are group settlements; new buy rows use a separate replacement scope.
 try{db.run("ALTER TABLE meituan_group_buy_benefit_records ADD COLUMN benefit_kind TEXT NOT NULL DEFAULT 'group'");}catch(e){if(!/duplicate column/i.test(e.message))throw e;}
 db.run(`CREATE TABLE IF NOT EXISTS meituan_oneclick_coverage(income_date TEXT PRIMARY KEY,batch_id INTEGER NOT NULL,sha256 TEXT NOT NULL,verified_at TEXT DEFAULT (datetime('now','localtime')))`);
}
function importWorkbook(db,params,user,rebuild,options={}){
 const parsed=contract.parseFinance(contract.decode(params.data),params.from,params.to);
 const dates=Object.keys(parsed.dates).sort(),from=params.from||dates[0],to=params.to||dates.at(-1),all=options.allStores===true;
 if(!from||!to)throw Error('oneclick_empty_scope_unverified');
 if(Date.parse(to)-Date.parse(from)>31*86400000)throw Error('oneclick_range_too_large');
 if(all&&(!params.from||!params.to))throw Error('oneclick_scope_invalid');
 const bindings=db.queryAll("SELECT p.platform_id,s.id,s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id WHERE p.platform_name='美团团购'");
 const mapping=new Map();for(const id of parsed.storeIds){const matches=bindings.filter(r=>String(r.platform_id)===id);if(matches.length!==1)throw Error('oneclick_binding_invalid');mapping.set(id,matches[0]);}
 const resultFor=batch=>({batch_id:batch,data_kind:'meituan_oneclick',imported:new Set(parsed.rows.map(r=>r.storeId+'|'+r.date)).size,date_from:from,date_to:to,raw_imported:parsed.rowCount,source_rows:parsed.sourceRowCount,excluded_rows:parsed.sourceRowCount-parsed.rowCount,type_inventory:parsed.inventory,matched_stores:parsed.storeCount,unmatched:0,skipped:0,gross_total:parsed.selected.tailCents/100,net_total:parsed.selected.merchantCents/100,fee_total:(parsed.selected.serviceCents+parsed.selected.otherCents)/100,refund_total:parsed.selected.refundCents/100,verified:true,sha256:parsed.sha256});
 const coverage=all?db.queryAll('SELECT * FROM meituan_oneclick_coverage WHERE income_date>=? AND income_date<=?',[from,to]):[];
 const dayCount=(Date.parse(to)-Date.parse(from))/86400000+1;
 if(all&&coverage.length===dayCount&&coverage.every(r=>r.sha256===parsed.sha256&&r.batch_id===coverage[0].batch_id)){
  const saved=db.queryAll("SELECT source_row_key,raw_json FROM meituan_group_buy_benefit_records WHERE benefit_kind='oneclick' AND income_date>=? AND income_date<=?",[from,to]);
  if(saved.length!==parsed.rowCount||parsed.rows.some(row=>!saved.some(r=>r.source_row_key===row.key&&r.raw_json===JSON.stringify(row.raw))))throw Error('oneclick_prior_import_changed');
  db.save();
  return {...resultFor(coverage[0].batch_id),reused:true};
 }
 const targets=new Map(),mark=(storeId,date)=>targets.set(storeId+'|'+date,{storeId,incomeDate:date});
 const scopes=[...new Set(parsed.rows.map(r=>r.storeId+'|'+r.date))].map(k=>k.split('|'));
 const old=all?db.queryAll("SELECT DISTINCT store_id,income_date FROM meituan_group_buy_benefit_records WHERE benefit_kind='oneclick' AND income_date>=? AND income_date<=?",[from,to]):scopes.flatMap(([id,date])=>db.queryAll("SELECT DISTINCT store_id,income_date FROM meituan_group_buy_benefit_records WHERE benefit_kind='oneclick' AND meituan_store_id=? AND income_date=?",[id,date]));
 for(const r of old)if(r.store_id)mark(r.store_id,r.income_date);
 db.run('BEGIN');
 try{
  const batch=db.insert('INSERT INTO business_import_batches(source_type,platform,file_name,row_count,date_from,date_to,imported_by,imported_by_name) VALUES(?,?,?,?,?,?,?,?)',['platform','美团团购',params.file_name||'',parsed.rowCount,from,to,user?.id||null,user?.display_name||user?.username||'']);
  if(all)db.run("DELETE FROM meituan_group_buy_benefit_records WHERE benefit_kind='oneclick' AND income_date>=? AND income_date<=?",[from,to]);
  else for(const [id,date]of scopes){db.run("DELETE FROM meituan_group_buy_benefit_records WHERE benefit_kind='oneclick' AND meituan_store_id=? AND income_date=?",[id,date]);db.run('DELETE FROM meituan_oneclick_coverage WHERE income_date=?',[date]);}
  for(const row of parsed.rows){const store=mapping.get(row.storeId),raw=row.raw,a=row.amount;
   // Refunds reduce the tail itself. They are not a fee to add back in the finance daily report.
   const service=contract.money(raw['服务费（平台实际扣除）'])/100,support=contract.money(raw.合作商商业支持费用,true)/100;
   const fees={service_fee:(a.serviceCents+a.otherCents)/100,insurance_fee:0,promotion_fee:0,refund_amount:0,raw:{'服务费（平台实际扣除）':service,'合作商商业支持费用':support,'公益捐款':a.otherCents/100},raw_entries:[{name:'服务费（平台实际扣除）',amount:service},{name:'合作商商业支持费用',amount:support},{name:'公益捐款',amount:a.otherCents/100}]};
   db.run(`INSERT INTO meituan_group_buy_benefit_records(batch_id,source_row_key,meituan_store_id,source_store_name,income_date,income_time,order_no,project_id,project_name,transaction_type,sale_mode,sale_price,merchant_income,customer_paid,third_party_fee,fee_breakdown_json,raw_json,store_id,store_name,match_status,benefit_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[batch,row.key,row.storeId,raw.美团门店名称||'',row.date,raw.收益时间,row.order,raw.项目ID||'','一键买单（尾款）',row.transaction,'一键买单尾款',row.tailCents/100,a.merchantCents/100,row.tailCents/100,(a.serviceCents+a.otherCents)/100,JSON.stringify(fees),JSON.stringify(raw),store.id,store.store_name,'matched','oneclick']);mark(store.id,row.date);
  }
  for(const target of targets.values()){
   const count=db.queryOne("SELECT count(*) n FROM meituan_group_buy_benefit_records WHERE store_id=? AND income_date=? AND match_status='matched'",[target.storeId,target.incomeDate]);
   if(count.n)rebuild(db,{batchId:batch,...target});else db.run("DELETE FROM business_revenue_records WHERE source_type='platform' AND channel='meituan_group' AND store_id=? AND biz_date=?",[target.storeId,target.incomeDate]);
  }
  if(all)for(let day=from;day<=to;day=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10))db.run("INSERT OR REPLACE INTO meituan_oneclick_coverage(income_date,batch_id,sha256) VALUES(?,?,?)",[day,batch,parsed.sha256]);
  const actual=db.queryOne("SELECT count(*) n,round(coalesce(sum(sale_price),0)*100) tail,round(coalesce(sum(merchant_income),0)*100) merchant FROM meituan_group_buy_benefit_records WHERE batch_id=? AND benefit_kind='oneclick'",[batch]);
  if(actual.n!==parsed.rowCount||actual.tail!==parsed.selected.tailCents||actual.merchant!==parsed.selected.merchantCents)throw Error('oneclick_database_readback_failed');
  db.run('COMMIT');db.save();
  return resultFor(batch);
 }catch(e){try{db.run('ROLLBACK');}catch{}throw e;}
}
function reconcile(db,params={}){
 const ids=(Array.isArray(params.store_ids)?params.store_ids:String(params.store_ids||params.store_id||'').split(',')).map(Number).filter(n=>Number.isInteger(n)&&n>0);
 const from=params.date_from||'0000-01-01',to=params.date_to||'9999-12-31',scope=ids.length?' AND store_id IN ('+ids.map(()=>'?').join(',')+')':'',args=[from,to,...ids];
 const platform=db.queryAll("SELECT store_id,store_name,income_date,round(sum(sale_price)*100) tail,round(sum(merchant_income)*100) merchant,round(sum(third_party_fee)*100) fees FROM meituan_group_buy_benefit_records WHERE benefit_kind='oneclick' AND match_status='matched' AND income_date>=? AND income_date<=?"+scope+' GROUP BY store_id,income_date',args);
 const pos=db.queryAll("SELECT store_id,store_name,biz_date,round(sum(amount)*100) tail FROM business_revenue_compositions WHERE category LIKE '一键买单%' AND biz_date>=? AND biz_date<=?"+scope+' GROUP BY store_id,biz_date',args);
 const covered=new Set(db.queryAll('SELECT income_date FROM meituan_oneclick_coverage WHERE income_date>=? AND income_date<=?',[from,to]).map(r=>r.income_date));
 const map=new Map();for(const r of pos)map.set(r.store_id+'|'+r.biz_date,{store_id:r.store_id,store_name:r.store_name,biz_date:r.biz_date,pos_tail:r.tail/100,platform_tail:null,merchant_income:null,fees:null,source_status:'missing'});
 for(const r of platform){const key=r.store_id+'|'+r.income_date;map.set(key,{...map.get(key),store_id:r.store_id,store_name:r.store_name,biz_date:r.income_date,platform_tail:r.tail/100,merchant_income:r.merchant/100,fees:r.fees/100,source_status:'imported'});}
 return [...map.values()].map(r=>{if(r.source_status==='missing'&&covered.has(r.biz_date))Object.assign(r,{platform_tail:0,merchant_income:0,fees:0,source_status:'verified_zero'});return {...r,difference:r.platform_tail==null||r.pos_tail==null?null:Math.round((r.platform_tail-r.pos_tail)*100)/100};});
}
function composition(rows,policy){
 // Real Meituan channel revenue already includes the independent buy-tail settlement.
 // The cashier view retains its original payment fields; real view must not append a POS tail a second time.
 return policy.data_view==='real'?rows.filter(row=>!require('./pos-group-payments').isOneClick(row.category)):rows;
}
function markCoverage(db,resolved,params){
 if(resolved.policy.data_view!=='real'||params.channel_group==='delivery'||params.platform&&params.platform!=='美团团购')return;
 const wanted=new Map(resolved.rows.filter(r=>r.channel==='meituan_group'&&r.source_used==='platform').map(r=>[r.store_id+'|'+r.biz_date,r]));
 if(!wanted.size)return;
 for(const check of reconcile(db,params)){
  const key=check.store_id+'|'+check.biz_date,row=wanted.get(key);
  if(!row||check.source_status!=='missing'||!check.pos_tail)continue;
  row.oneclick_pending=true;
  if(!resolved.missing_platform_days.some(r=>r.store_id===check.store_id&&r.biz_date===check.biz_date&&r.channel==='meituan_group'))resolved.missing_platform_days.push({store_id:check.store_id,store_name:check.store_name,biz_date:check.biz_date,channel:'meituan_group',source_part:'oneclick'});
 }
}
module.exports={initialize,importWorkbook,reconcile,composition,markCoverage,isWorkbook:contract.isWorkbook};
