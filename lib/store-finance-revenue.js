'use strict';
const cents=v=>Math.round(Number(v||0)*100);
const platformStatus=require('./store-finance-platform-status');
const PLATFORMS={meituan:['美团外卖','meituan_delivery_bills','外卖订单'],taobao:['淘宝闪购','taobao_flash_bills','外卖'],jd:['京东外卖','jd_delivery_bills','正向订单']};
function feeCategory(platform,name){
  if (platform === '美团外卖' && ['流量助手节省转入广告','流量助手节省转入广告退款'].includes(name)) return 'third_party';
  if (platform === '淘宝闪购' && name === '爆单红包增量出资') return 'promotion';
  if (/推广账户充值|余额变动/.test(name)) return 'promotion';
  if (/保险|保障/.test(name) && !/赔付|理赔/.test(name)) return 'third_party';
  if (name==='闪购联盟推广' || /代运营佣金|配送服务费|补送配送费|补发配送费|配送小费/.test(name)) return 'third_party';
  if (/订单退款|订单部分退款|部分退款冲抵|售后订单|取消餐损|赔付|理赔|餐损/.test(name)) return 'refund_adjustment';
  return 'unconfirmed';
}
function loadSources(db,id,from,to){
 const read=(table,field)=>db.queryAll(`SELECT * FROM ${table} WHERE store_id=? AND ${field} BETWEEN ? AND ?`,[id,from,to]);
 const revenue=read('business_revenue_records','biz_date');
 const rest=db.queryOne('SELECT value FROM config WHERE key=?',['store_finance_closed_days:'+Number(id)]);
 const closedDates=rest?normalizeClosedDates(JSON.parse(rest.value)):[];
 const paymentPolicy=require('./offline-payment-fees').build(db,[id],from,to);
 return {member_card_consumption:paymentPolicy.member_card_consumption,payment_policies:paymentPolicy.policies,pos:revenue.filter(r=>r.source_type==='pos'),platform:revenue.filter(r=>r.source_type==='platform'),
  closed_dates:closedDates,
  accounts:db.queryAll('SELECT * FROM store_platforms WHERE store_id=?',[id]),
  fee_rules:require('./delivery-fee-rules').read(db),
  composition:read('business_revenue_compositions','biz_date'),external:read('delivery_external_expenses','expense_date'),
  bills:Object.fromEntries(Object.entries(PLATFORMS).map(([key,[,table]])=>[key,read(table,'bill_date').filter(r=>r.match_status==='matched')]))};
}
function calculate(sources,from,to){
 const v={dine:0,meituan:0,taobao:0,jd:0,meituanGroup:0,douyinGroup:0,fee:0,promotion:0},details=[],problems=[],available=new Set(),availability={},delivery={};
 const inRange=(r,field)=>r[field]>=from&&r[field]<=to;
 let complete=true,classified=true,allClosed=true;
 for(let day=from;day<=to;day=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10)){
  const pos=sources.pos.filter(r=>r.biz_date===day),comp=sources.composition.filter(r=>r.biz_date===day);
  const sales=pos.filter(r=>['store_sales','pickup'].includes(r.channel));
  const payment=require('./dine-payment-composition').read(comp);
  const closed=(sources.closed_dates||[]).includes(day);
  if(closed && !sales.some(r=>cents(r.recorded_amount)!==0) && !comp.some(r=>cents(r.amount)!==0))continue;
  allClosed=false;
  if(closed){complete=false;problems.push(`${day}已登记休息，但收银存在营业记录，请核对。`);}
  if(!payment.complete){complete=false;problems.push(`${day}现金、扫码支付或会员卡付款构成缺失，堂食金额暂留空。`);}
  else {const member=sources.member_card_consumption?.days.find(r=>r.biz_date===day);
   const dine=payment.total_cents+(member?.delta_cents||0);v.dine+=dine;
   if(member&&!member.ready){complete=false;problems.push(`${day}${member.reason}，会员实收待核对。`);}
   const paymentFee=[...(sources.payment_policies?.values()||[])].find(p=>p.date===day)||require('./offline-payment-fees').forDay({day,dineCents:dine,composition:comp});
   v.fee-=paymentFee.fee_cents;
   details.push({platform:'堂食/外带',date:day,label:paymentFee.member_fee_cents?'收款手续费（含会员本金测算）':paymentFee.order_based?'收款手续费（逐笔计算）':'收款手续费（理论估算）',category:'third_party',amount:paymentFee.fee_cents/100,source:paymentFee.source,payment_fee:paymentFee});
  }
 }
 if(!complete)v.dine=null;
 for(const [key,[platform,,revenueType]] of Object.entries(PLATFORMS)){
  const status=platformStatus.review(sources,key,from,to);availability[key]=status;if(status.abnormal){complete=false;problems.push(status.note);}
  const bills=sources.bills[key].filter(r=>inRange(r,'bill_date'));
  const structure=delivery[key]={platform,actual:0,third_party:0,promotion:0,income:0,available:false,outside_platform:{third_party:0,promotion:0},actual_rows:[],third_party_rows:[],promotion_rows:[],unconfirmed_rows:[]};
  // Missing platform source is deliberately zero; POS delivery income never fills it.
  if(!bills.some(r=>r.bill_type===revenueType || r.bill_type.startsWith(revenueType+' ·')))continue;
  available.add(key);
  structure.available=true;
  let net=0,promotion=0,third=0,unknown=0;
  const actualByDate=new Map();
  const sourceItem=(r,amount)=>({label:r.bill_type,amount:amount/100,source:platform+'原始账单',date:r.bill_date,record_id:r.id||null,batch_id:r.batch_id||null});
  for(const r of bills){const label=String(r.bill_type||'').trim(),amount=cents(r.amount);if(label===revenueType||label.startsWith(revenueType+' ·')){net+=amount;actualByDate.set(r.bill_date,(actualByDate.get(r.bill_date)||0)+amount);continue;}
   const category=require('./delivery-fee-rules').classify(sources.fee_rules,platform,'bill',label)||feeCategory(platform,label),expense=-amount;
   if(key==='taobao'&&label==='余额变动'){if(category==='promotion'){promotion+=expense;structure.promotion_rows.push(sourceItem(r,expense));}else{classified=false;unknown++;problems.push('淘宝闪购余额变动须人工确认为推广充值，收入暂留空。');}details.push({platform,date:r.bill_date,label,category,amount:expense/100,source_kind:'bill',source:platform+'原始账单',record_id:r.id||null,batch_id:r.batch_id||null});continue;}
   net+=amount;
   actualByDate.set(r.bill_date,(actualByDate.get(r.bill_date)||0)+amount);
   if(category==='refund_adjustment'){details.push({platform,date:r.bill_date,label,category,amount:expense/100,source_kind:'bill',source:platform+'原始账单',record_id:r.id||null,batch_id:r.batch_id||null});continue;}
   if(category==='promotion'){promotion+=expense;structure.promotion_rows.push(sourceItem(r,expense));}
   else if(category==='third_party'){third+=expense;structure.third_party_rows.push(sourceItem(r,expense));}
   else {unknown++;structure.unconfirmed_rows.push(sourceItem(r,expense));classified=false;problems.push(`${platform}「${label}」费用分类待确认，外卖收入暂留空。`);}
   details.push({platform,date:r.bill_date,label,category,amount:expense/100,source_kind:'bill',source:platform+'原始账单',record_id:r.id||null,batch_id:r.batch_id||null});
  }
  // Only these three named components determine delivery income.
  structure.actual=net;structure.third_party=third;structure.promotion=promotion;
  structure.actual_rows=[...actualByDate].map(([date,amount])=>({label:'平台实收（已含费用扣减及退款）',date,amount:amount/100,source:platform+'当日账单收支合计'}));
  v[key]=unknown?null:net+third+promotion;
  v.promotion-=promotion;v.fee-=third;
 }
 for(const r of sources.external.filter(r=>inRange(r,'expense_date'))){const amount=cents(r.amount);
  const category=require('./delivery-fee-rules').classify(sources.fee_rules,r.platform,'external',r.expense_type)||'promotion';
  // 霸王餐 is an original expense name, not an accounting category. It was
  // paid outside platform settlement, so moving it to promotion must not add
  // it back to sales and cancel the cost. This also preserves refund signs.
  const outsidePlatform=r.expense_type==='霸王餐';
  if(['promotion','third_party'].includes(category)){
   v[category==='promotion'?'promotion':'fee']-=amount;const key=Object.entries(PLATFORMS).find(([,p])=>p[0]===r.platform)?.[0];if(key){const s=delivery[key];if(available.has(key)&&!outsidePlatform&&v[key]!==null)v[key]+=amount;s[category]+=amount;if(outsidePlatform)s.outside_platform[category]+=amount;s[category==='promotion'?'promotion_rows':'third_party_rows'].push({label:r.expense_type,amount:amount/100,date:r.expense_date,source:'额外开销',add_back:!outsidePlatform,record_id:r.id||null});}
  }else{classified=false;problems.push(`${r.platform}额外开销「${r.expense_type}」待人工分类。`);}
  details.push({platform:r.platform,date:r.expense_date,label:r.expense_type,category,amount:amount/100,source_kind:'external',outside_platform:outsidePlatform,source:'额外开销登记',record_id:r.id||null});
 }
 for(const [channel,key]of [['meituan_group','meituanGroup'],['douyin_group','douyinGroup']]){
  const status=platformStatus.review(sources,key,from,to);availability[key]=status;if(status.abnormal){complete=false;problems.push(status.note);}
  const rows=sources.platform.filter(r=>r.channel===channel&&inRange(r,'biz_date'));
  for(const r of rows){const third=cents(r.service_fee)+cents(r.insurance_fee)+cents(r.promotion_fee)+cents(r.refund_amount);v[key]+=cents(r.actual_amount)+third;v.fee-=third;
   details.push({platform:channel==='meituan_group'?'美团团购':'抖音团购',date:r.biz_date,label:'平台原始费用合计',category:'third_party',amount:third/100});}
 }
 for(const [key,s]of Object.entries(delivery)){s.income=v[key];for(const field of ['actual','third_party','promotion','income'])s[field]=s[field]===null?null:s[field]/100;for(const category of ['third_party','promotion'])s.outside_platform[category]/=100;}
 return {values:Object.fromEntries(Object.entries(v).map(([k,n])=>[k,n===null?null:n/100])),details,problems,ready:complete&&classified,classified,availability,delivery};
}
function normalizeClosedDates(dates){
 if(!Array.isArray(dates)||dates.length>3660)throw Error('休息日期格式无效');
 for(const date of dates)if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('休息日期无效');
 return [...new Set(dates)].sort();
}
module.exports={loadSources,calculate,feeCategory,normalizeClosedDates};

