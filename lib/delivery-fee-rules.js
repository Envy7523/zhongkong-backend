'use strict';
const express=require('express');
const platforms={ '美团外卖':['meituan_delivery_bills','外卖订单'], '淘宝闪购':['taobao_flash_bills','外卖'], '京东外卖':['jd_delivery_bills','正向订单'] };
const categories={third_party:'第三方费用',promotion:'推广费用',refund_adjustment:'实收退款／赔付调整',fake_orders:'刷单费用／霸王餐',ignore:'不计费用',unconfirmed:'待确认'};
const ledgerTypes={actual:'实支',accrual:'均摊',headquarters:'总部',platform:'平台'};
const key=(platform,source,name)=>JSON.stringify([platform,source,platform?name:String(name||'').replace(/[\r\n]+/g,' ').trim()]);
function read(db){const row=db.queryOne("SELECT value FROM config WHERE key='delivery_fee_manual_rules'");return row?JSON.parse(row.value):{revision:0,enabled:false,rules:{},ledger:{}};}
function classify(rules,platform,source,name){return rules?.enabled?(rules.rules[key(platform,source,name)]||'unconfirmed'):null;}
function ledgerType(row,rules){
 const name=String(row.subcategory_name||row.subcategory||'').replace(/[\r\n]+/g,' ').trim(),category=row.category_name||row.category||'';
 const saved=rules?.ledger?.[key('',category,name)];if(saved)return saved;
 if(/线下|雇主保险|社会保险|社保|福利|员工餐|招聘|工衣/.test(name))return 'actual';
 if(/房租|店租|物业|水费|电费|水电|工资|薪资|薪酬|日应计/.test(name))return 'accrual';
 if(/管理服务费|总部|外卖运营|^外卖服务费$/.test(name))return 'headquarters';
 if(/平台.*费|外卖服务费|推广|保险|佣金|支付手续费|保障/.test(name))return 'platform';
 return 'actual';
}
function catalog(db){
 const state=read(db),rows=[];
 for(const [platform,[table,revenue]]of Object.entries(platforms)){
  const bills=db.queryAll(`SELECT bill_type name,COUNT(*) records FROM ${table} WHERE match_status='matched' GROUP BY bill_type`);
  const external=db.queryAll('SELECT expense_type name,COUNT(*) records FROM delivery_external_expenses WHERE platform=? GROUP BY expense_type',[platform]);
  // Match the two types accepted by the expense-entry API. Keep real historical
  // names above, but do not invent extra promotion rows without any records.
  for(const name of ['霸王餐','第三方推广'])if(!external.some(r=>r.name===name))external.push({name,records:0});
  for(const [source,list]of [['bill',bills],['external',external]])for(const r of list){
   const isRevenue=source==='bill'&&(r.name===revenue||r.name.startsWith(revenue+' ·'));
   const isRefund=source==='bill'&&/订单退款|订单部分退款|售后订单|赔付|理赔|餐损/.test(r.name);
   rows.push({...r,platform,source,key:key(platform,source,r.name),fixed:isRevenue,suggested:isRefund?'refund_adjustment':null,category:isRevenue?'revenue':state.rules[key(platform,source,r.name)]||(isRefund?'refund_adjustment':'unconfirmed')});
  }
 }
 const ledger=db.queryAll('SELECT category_name,subcategory_name,COUNT(*) records FROM bookkeeping_entries WHERE amount<0 GROUP BY category_name,subcategory_name').map(r=>({...r,key:key('',r.category_name,r.subcategory_name),type:ledgerType(r,state),can_accrue:/房租|店租|物业|水费|电费|水电|工资|薪资|薪酬/.test(r.subcategory_name)}));
 if(db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='bookkeeping_subcategories'"))for(const r of db.queryAll('SELECT c.name category_name,s.name subcategory_name FROM bookkeeping_subcategories s JOIN bookkeeping_categories c ON c.id=s.category_id')){
  if(['销售收入','会员','其他收入'].includes(r.category_name)||ledger.some(x=>x.category_name===r.category_name&&x.subcategory_name===r.subcategory_name))continue;
  ledger.push({...r,records:0,key:key('',r.category_name,r.subcategory_name),type:ledgerType(r,state),can_accrue:/房租|店租|物业|水费|电费|水电|工资|薪资|薪酬/.test(r.subcategory_name)});
 }
 for(const row of ledger)row.deprecated=/[*./\-]/.test(row.subcategory_name||'')||/^[*./\-]+$/.test(row.category_name||'');
 ledger.sort((a,b)=>Number(a.deprecated)-Number(b.deprecated)||a.category_name.localeCompare(b.category_name,'zh-CN')||a.subcategory_name.localeCompare(b.subcategory_name,'zh-CN'));
 return {...state,rows,ledger_rows:ledger,categories,ledger_types:ledgerTypes};
}
function router(db,scope='delivery'){const r=express.Router();
 const response=()=>{const c=catalog(db);if(scope==='ledger'){delete c.rows;delete c.rules;delete c.categories;}else{delete c.ledger_rows;delete c.ledger;delete c.ledger_types;}return {ok:true,...c};};
 r.get('/',(req,res)=>{try{res.json(response())}catch(e){res.status(500).json({error:e.message})}});
 r.put('/',(req,res)=>{try{
  const old=read(db),all=catalog(db),body=req.body||{};if(body.revision!==old.revision)return res.status(409).json({error:'分类已被其他人修改，请重新读取后保存'});
  if(scope==='delivery'&&body.ledger_rows?.length||scope==='ledger'&&body.rows?.length)throw Error('外卖费用与记账本标签请分别保存');
  const rules={},ledger={};
  for(const row of body.rows||[]){const found=all.rows.find(r=>r.key===row.key&&!r.fixed);if(!found||!Object.hasOwn(categories,row.category)||found.source==='bill'&&row.category==='fake_orders'||found.source==='external'&&row.category==='refund_adjustment')throw Error('费用字段或分类无效；霸王餐按额外开销登记');rules[row.key]=row.category;}
  for(const row of body.ledger_rows||[]){const found=all.ledger_rows.find(r=>r.key===row.key);if(!found||!Object.hasOwn(ledgerTypes,row.type)||row.type==='accrual'&&!found.can_accrue)throw Error('账本标签无效；食材及日常费用不允许均摊');ledger[row.key]=row.type;}
  const next={...old,revision:old.revision+1,enabled:scope==='delivery'?true:old.enabled,ledger_enabled:scope==='ledger'?true:old.ledger_enabled,rules:{...old.rules,...rules},ledger:{...old.ledger,...ledger},updated_by:req.user?.display_name||req.user?.username||'',updated_at:new Date().toISOString()};
  db.run('INSERT OR REPLACE INTO config(key,value) VALUES(?,?)',['delivery_fee_manual_rules',JSON.stringify(next)]);db.save();res.json(response());
 }catch(e){res.status(400).json({error:e.message})}});return r;
}
module.exports={read,classify,ledgerType,ledgerTypes,catalog,router};
