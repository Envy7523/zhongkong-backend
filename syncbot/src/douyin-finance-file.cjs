'use strict';
const XLSX=require('xlsx'),crypto=require('crypto');
const {restoreUsedRange}=require('./workbook-used-range.cjs');
const {assertDate}=require('./meituan-finance-dates.cjs');
const money=value=>{const text=String(value??'').trim().replaceAll(',','');if(!/^-?\d+(?:\.\d+)?$/.test(text))throw Error('douyin_amount_invalid');return Math.round(Number(text)*100);};
const day=value=>{const d=String(value||'').slice(0,10).replaceAll('/','-');assertDate(d);return d;};
function analyze(workbook,from,to){
 if(from){assertDate(from);assertDate(to);if(from>to)throw Error('douyin_range_invalid');}
 const rows=name=>{const s=workbook.Sheets[name];if(!s)return null;return XLSX.utils.sheet_to_json(restoreUsedRange(s),{defval:''});};
 const daily=rows('日账单'),stores=rows('按门店'),positive=rows('分账明细-正向-团购'),refund=rows('分账明细-退款-团购');
 if(!daily?.length||!stores?.length||!positive)throw Error('douyin_bill_sheets_missing');
 const counts={positive:0,refund:0},dates={},ids=new Set();let saleCents=0,merchantCents=0;
 const summary={merchantCents:0,positiveCount:0,refundCount:0};const expectedDays=new Set();
 for(const r of daily){const a=day(r['开始日期']),b=day(r['结束日期']);if(a!==b||from&&(a<from||a>to))throw Error('douyin_summary_date_mismatch');if(expectedDays.has(a))throw Error('douyin_summary_duplicate_date');expectedDays.add(a);summary.merchantCents+=money(r['商家应得']);summary.positiveCount+=Number(r['核销数量']);summary.refundCount+=Number(r['退款数量']);if(money(r['其他金额'])!==0)throw Error('douyin_other_amount_requires_mapping');}
 if(from){for(let d=from;d<=to;d=new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10))if(!expectedDays.has(d))throw Error('douyin_summary_date_missing');}
 if(!refund&&summary.refundCount!==0)throw Error('douyin_refund_sheet_missing');
 for(const [kind,items] of [['positive',positive],['refund',refund||[]]])for(const r of items){
  const d=day(kind==='refund'?r['退款时间']:r['核销时间']);if(!expectedDays.has(d))throw Error('douyin_detail_date_mismatch');const id=String(r['核销门店ID']||'');if(!/^\d+$/.test(id)||!String(r['订单编号']||''))throw Error('douyin_detail_identity_invalid');
  const sign=kind==='refund'?-1:1;saleCents+=sign*Math.abs(money(r['券售卖金额']??r['售卖金额']));merchantCents+=sign*Math.abs(money(r['商家应得']??r['到手金额']));counts[kind]++;ids.add(id);dates[d]=(dates[d]||0)+1;
 }
 if(counts.positive!==summary.positiveCount||counts.refund!==summary.refundCount||merchantCents!==summary.merchantCents)throw Error('douyin_daily_detail_mismatch');
 const storeTotal=stores.reduce((n,r)=>n+money(r['商家应得']),0);if(storeTotal!==merchantCents)throw Error('douyin_store_summary_mismatch');
 return {rowCount:counts.positive+counts.refund,counts,dates,coverageDates:[...expectedDays].sort(),storeIds:[...ids],storeCount:ids.size,saleCents,merchantCents,emptyRefundAllowed:summary.refundCount===0};
}
function parseFinance(buffer,from,to){const wb=XLSX.read(buffer,{type:'buffer'});return {...analyze(wb,from,to),sha256:crypto.createHash('sha256').update(buffer).digest('hex')};}
module.exports={parseFinance,analyze,money,day};
