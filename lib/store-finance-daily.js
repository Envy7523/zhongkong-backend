'use strict';

const crypto = require('node:crypto');
const financeRevenue = require('./store-finance-revenue');
const fixedCosts = require('./store-finance-fixed-costs');
const breakdown = require('./store-finance-breakdown');
const definitions = [
  ['收入','dine','堂食/外带'], ['收入','memberConsumption','会员卡消费（含赠金）'], ['收入','meituan','美团外卖'], ['收入','taobao','淘宝闪购'], ['收入','jd','京东秒送'], ['收入','meituanGroup','美团团购'], ['收入','douyinGroup','抖音团购'], ['收入','fee','手续费扣减'], ['收入','memberGift','会员消费赠金扣减'], ['收入','income','收入合计',true],
  ['成本','factoryFood','食材成本（粤宏潮出货）'], ['成本','factoryMaterial','耗材成本（粤宏潮出货）'], ['成本','food','食材成本（门店自采）'], ['成本','material','耗材成本（门店自采）'],
  ['成本','foodRate','食材成本率','rate','参考值35%-45%'], ['成本','materialRate','耗材成本率','rate','参考值3%-8%'], ['成本','cost','成本合计',true], ['成本','grossRate','毛利率','rate'],
  ['经营费用','rent','租金'], ['经营费用','rentRate','租金成本率','rate','参考值8%-15%'], ['经营费用','utilities','水电费'], ['经营费用','utilitiesRate','水电成本率','rate','参考值3%-6%'],
  ['经营费用','salary','工资'], ['经营费用','welfare','员工福利'], ['经营费用','laborRate','人力成本率','rate','参考值17%-20%'], ['经营费用','daily','楼面/明档/厨房费用'], ['经营费用','dailyRate','费用比','rate','参考值3%-8%'],
  ['经营费用','promotion','推广费用'], ['经营费用','promotionRate','推广占比','rate','参考值2%'], ['经营费用','expense','费用合计',true], ['经营费用','expenseRate','费用率','rate'],
  ['税费','tax','所得税'], ['利润','profit','净利润',true], ['利润','profitRate','净利润率','rate','8%-20%'], ['效率','efficiency','人效','rate'],
];
function classify(entry) {
  const c = entry.category_name || '', s = entry.subcategory_name || '';
  if (/员工餐|伙食|福利|工衣/.test(s)) return 'welfare';
  if (/^(职工工资|员工工资|工资|兼职工资)$/.test(s)) return 'salary';
  // 暂按用户口径：工厂出货统一计食材，保留原始名称供以后拆分。
  if (/^(粤宏潮耗材|工厂耗材|粤宏潮出货耗材)$/.test(s)) return 'factoryFood';
  if (/^(粤宏潮|粤宏潮出货|工厂出货|工厂来货|原材料工厂)$/.test(s)) return 'factoryFood';
  if (/包装物|耗材/.test(s)) return 'material';
  if (['零星食材类','月结食材类','原材料'].includes(c) && !/租赁|月结洗碗|洗碗机/.test(s)) return 'food';
  if (/^(店租|房租|店租及物业费|物业费|上排店物业费)$/.test(s)) return 'rent';
  if (/^(水费|电费|水电费)$/.test(s)) return 'utilities';
  if (/^(楼面日常报销|楼面日常费用|楼面费用报销|明档日常报销|明档费用报销|厨房日常报销|日常费用报销)$/.test(s)) return 'daily';
  if (/^(推广费|线上平台推广|线上推广费|线下推广活动|线下推广费|营销费|外卖推广费|广告费|线上推广|线下推广)$/.test(s)) return 'promotion';
  if (/^(外卖服务费|平台手续费|手续费|手续费支出|扫码支付手续)$/.test(s)) return 'fee';
  if (/^(经营所得税|个人经营所得|企业所得税)$/.test(s)) return 'tax';
  return null;
}
function dateBefore(date) { return new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10); }
function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) throw new Error('请选择有效的业务日期');
}
function buildPreview(db, storeId, date, costSources) {
  validateDate(date);
  if (!Number.isSafeInteger(Number(storeId)) || Number(storeId)<=0) throw new Error('请选择门店');
  const store = db.queryOne('SELECT id,store_name FROM stores WHERE id=?',[Number(storeId)]);
  if (!store) throw new Error('门店不存在');
  const selectedSources=costSources?fixedCosts.normalize(costSources):fixedCosts.settings(db,store.id);
  const monthStart = date.slice(0,7)+'-01', yesterday = dateBefore(date), start = yesterday<monthStart ? yesterday : monthStart;
  const sources = financeRevenue.loadSources(db,store.id,start,date);
  const ledger = db.queryAll('SELECT rowid AS id,date,category_name,subcategory_name,amount FROM bookkeeping_entries WHERE store_id=? AND date BETWEEN ? AND ?',[store.id,start,date]);
  const problems = [], missing = new Set(), unmapped = new Map(), feeDetails=[],fixedDetails=[];
  function aggregate(from,to,title) {
    const v = Object.fromEntries(definitions.map(d=>[d[1],0]));
    const e = ledger.filter(r=>r.date>=from&&r.date<=to), settlement=financeRevenue.calculate(sources,from,to);
    const revenue=require('./store-finance-daily-member').split(settlement,sources,from,to);
    Object.assign(v,revenue.values);problems.push(...revenue.problems);if(!revenue.ready)missing.add(title);
    if(title==='当日')feeDetails.push(...revenue.details);
    let hasUnmapped=false;
    for(const r of e) {
      if(require('./offline-payment-fees').isLedgerFee(r))continue;
      if (['销售收入','会员','其他收入'].includes(r.category_name)) continue;
      if(sources.fee_rules?.ledger_enabled&&require('./delivery-fee-rules').ledgerType(r,sources.fee_rules)==='platform')continue;
      const key=classify(r);
      // Platform costs come from actual bills/external expenses, never deducted again from ledger mirrors.
      if(['rent','utilities','salary'].includes(key))continue;
      if(key && !['fee','promotion'].includes(key)) v[key]+=Number(r.amount);
      else if(['fee','promotion'].includes(key)) {if(Number(r.amount)!==0){problems.push(`记账本「${r.subcategory_name}」需核对是否与平台费用重复，暂不叠加。`);hasUnmapped=true;}continue;}
      else if(Number(r.amount)!==0) {unmapped.set(`${r.category_name}/${r.subcategory_name}`,true);hasUnmapped=true;}
    }
    if (!e.length) {
      problems.push(`${title}没有记账记录，支出暂留空，请检查记账本。`);
      for(const k of ['factoryFood','factoryMaterial','food','material','rent','utilities','salary','welfare','daily','tax']) v[k]=null;
    }
    const sum=(...keys)=>keys.every(k=>v[k]!==null)?Math.round(keys.reduce((n,k)=>n+v[k],0)*100)/100:null;
    const fixed=fixedCosts.calculate(db,store.id,from,to,selectedSources,classify,date);
    Object.assign(v,fixed.values);problems.push(...fixed.problems);if(!fixed.ready)missing.add(title);
    if(title==='当日')fixedDetails.push(...fixed.details);
    const ratio=(amount,negative=true)=>amount!==null&&v.income!==null&&v.income!==0 ? (negative?-amount:amount)/v.income : null;
    if(!revenue.classified)v.fee=v.promotion=null;
    v.income=sum('dine','memberConsumption','meituan','taobao','jd','meituanGroup','douyinGroup','fee','memberGift');v.cost=sum('factoryFood','factoryMaterial','food','material');
    v.expense=sum('rent','utilities','salary','welfare','daily','promotion');
    v.foodRate=ratio(sum('factoryFood','food'));v.materialRate=ratio(sum('factoryMaterial','material'));
    v.grossRate=ratio(sum('income','cost'),false);
    for(const k of ['rent','utilities','daily','promotion','expense']) v[k+'Rate']=ratio(v[k]);
    v.laborRate=ratio(sum('salary','welfare'));
    v.profit=sum('income','cost','expense','tax');v.profitRate=ratio(v.profit,false);
    const efficiency=require('./store-finance-efficiency').calculate(db,store.id,from,to);v.efficiency=efficiency.value;problems.push(...efficiency.notes);
    if(hasUnmapped) {v.expense=v.expenseRate=v.profit=v.profitRate=null;}
    return {values:v,payment_fees:settlement.details.filter(r=>r.payment_fee).map(r=>({...r.payment_fee,store_id:store.id})),breakdowns:breakdown.build({values:v,sources,entries:e,fixed,efficiency,from,to,title,definitions,classify,problems,revenue})};
  }
  const day=aggregate(date,date,'当日'), month=aggregate(monthStart,date,'本月累计'), previous=aggregate(yesterday,yesterday,'昨日');
  if(unmapped.size) problems.push(`记账项目尚未归类：${[...unmapped.keys()].join('、')}；费用及利润暂留空。`);
  const data={store_id:store.id,store_name:store.store_name,business_date:date,yesterday,month:date.slice(0,7),last_month:dateBefore(monthStart).slice(0,7),problems:[...new Set(problems)],ready:missing.size===0,fee_details:feeDetails,cost_sources:selectedSources,fixed_cost_details:fixedDetails,
    rows:definitions.map(([group,key,label,style,reference])=>({group,key,label,rate:style==='rate',subtotal:style===true||['grossRate','expenseRate','profitRate'].includes(key),reference:reference||'',values:[day.values[key],month.values[key],previous.values[key],null],breakdowns:[day.breakdowns[key],month.breakdowns[key],previous.breakdowns[key],{title:'上月',formula:'上月财务利润表暂未同步',value:null,items:[],unavailable:true,notes:[]}]}))};
  data.offline_payment_fee={daily_amount:day.payment_fees.reduce((n,r)=>n+r.fee_cents,0)/100,cumulative_amount:month.payment_fees.reduce((n,r)=>n+r.fee_cents,0)/100,actual_days:month.payment_fees.filter(r=>r.actual).length,order_days:month.payment_fees.filter(r=>r.order_based).length,estimated_days:month.payment_fees.filter(r=>!r.actual&&!r.order_based).length};
  if(sources.member_card_consumption?.available){
    const summarize=require('./member-consumption-policy').summarize;
    data.member_card_consumption=summarize(sources.member_card_consumption.days,monthStart,date);
    data.member_card_consumption.daily=summarize(sources.member_card_consumption.days,date,date);
  }
  data.fingerprint=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return data;
}
module.exports={buildPreview,classify,definitions};
