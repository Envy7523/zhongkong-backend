import {test} from 'node:test';
import assert from 'node:assert/strict';
import {realRevenueComposition} from '../frontend/src/utils/real-revenue-composition.mjs';

test('会员行显示完整消费总额，原结算汇总字段保持本金扣费后金额',()=>{
  const data={totals:{confirmed:299.62},revenue_composition:[{category:'现金',amount:200},{category:'会员卡（本金）',amount:99.62,source:'会员交易流水'}],member_card_consumption:{available:true,ready:true,consumption:110,principal:100,gift:10,fee:.38,net:99.62}};
  const before=JSON.stringify(data),r=realRevenueComposition(data),member=r.rows.find(row=>row.memberConsumption);
  assert.equal(member.name,'会员卡消费');assert.equal(member.displayAmount,110);assert.equal(member.actual,99.62);assert.equal(member.ratio,99.62/299.62);assert.equal(r.sum,299.62);assert.equal(r.difference,0);
  assert.equal(r.rows.filter(row=>row.name.startsWith('会员')).length,1);assert.equal(JSON.stringify(data),before);
  data.member_card_consumption.ready=false;data.revenue_composition[1].member_missing_days=[{store_id:1,biz_date:'2026-10-16',reason:'营业日待关联'}];
  const partial=realRevenueComposition(data).rows.find(row=>row.memberConsumption);assert.equal(partial.platformMissing,true);assert.equal(partial.displayAmount,110);
  data.member_card_consumption.consumption=-22;data.revenue_composition[1].amount=-19.92;
  const refund=realRevenueComposition(data).rows.find(row=>row.memberConsumption);assert.equal(refund.displayAmount,-22);assert.equal(refund.actual,-19.92);
});

test('整张构成表全额统一口径，平台尾款只拆一次，环比和占比采用全额',()=>{
  const d=withTail();d.platform_income_composition=[{channel:'meituan_group',gross:83,net:62.99,ready:true},{channel:'douyin_group',gross:60,net:40,ready:true}];
  d.revenue_composition=d.revenue_composition.filter(r=>r.category!=='会员卡');d.revenue_composition.push({category:'会员卡（本金）',source:'会员交易流水',amount:99.62});
  d.member_card_consumption={available:true,ready:false,consumption:110};
  const previous=structuredClone(d);previous.channel_breakdown.find(r=>r.channel==='meituan_delivery').gross_amount=40;
  const unchanged=JSON.stringify(d),r=realRevenueComposition(d,previous),get=n=>r.rows.find(row=>row.name===n);
  assert.equal(get('美团团购').fullAmount,80);assert.equal(get('一键买单（尾款）').fullAmount,3);assert.equal(get('抖音团购').fullAmount,60);
  assert.equal(get('会员卡消费').fullAmount,110);assert.equal(get('会员卡消费').fullPending,true);assert.equal(get('美团外卖').fullAmount,80);assert.equal(get('美团外卖').fullCompareRate,1);
  assert.equal(get('美团外卖').actual,60);assert.equal(get('一键买单（尾款）').actual,2.99);assert.equal(get('会员卡消费').actual,99.62);
  assert.equal(r.fullSum,723);assert.equal(get('美团外卖').fullRatio,80/723);assert.equal(JSON.stringify(d),unchanged);
});
test('缺少平台营业全额不使用结算金额补充，缺失尾款不假装为零',()=>{
  const d=withTail();let r=realRevenueComposition(d);assert.equal(r.rows.find(r=>r.name==='美团团购').fullAmount,null);
  d.platform_income_composition=[{channel:'meituan_group',gross:83,ready:true}];d.meituan_oneclick_reconciliation[0].platform_tail=null;
  r=realRevenueComposition(d);assert.equal(r.rows.find(r=>r.oneclickRecords).fullAmount,null);assert.equal(r.rows.find(r=>r.name==='美团团购').fullAmount,null);
  delete d.channel_breakdown.find(r=>r.channel==='meituan_delivery').gross_amount;
  assert.equal(realRevenueComposition(d).rows.find(r=>r.name==='美团外卖').fullAmount,null);
});
function sample(){return {totals:{confirmed:520},revenue_composition:[['现金',100],['扫码支付',200],['会员卡',0],['美团团购',50],['抖音团购',40],['外卖',120],['一键买单（尾款）',10]].map(([category,amount])=>({category,amount,source:/团购/.test(category)?'第三方平台':'收银经营日报'})),channel_breakdown:[{channel:'store_sales',amount:9999},{channel:'pickup',amount:888},{channel:'meituan_delivery',amount:60,gross_amount:80,source_used:'platform'},{channel:'taobao_flash',amount:40,gross_amount:60,source_used:'platform',source_status:'platform_incomplete',missing_platform_days:[{store_id:1,store_name:'验证门店',biz_date:'2026-10-01',channel:'taobao_flash'}]},{channel:'jd_delivery',amount:20,gross_amount:30,source_used:'platform'}]}}
test('支付方式与平台逐项展开，不重复叠加店内/自提/外卖合计，零字段保留',()=>{const d=sample(),r=realRevenueComposition(d);assert.equal(r.rows.length,9);assert.equal(r.sum,520);assert.equal(r.difference,0);assert.equal(r.missingCount,0);assert(!r.rows.some(r=>['外卖','店内销售','自提销售'].includes(r.name)));assert.equal(r.rows.find(r=>r.name==='会员卡').actual,0);assert.equal(r.rows.find(r=>r.name==='现金').gross,null);assert.equal(r.rows.find(r=>r.name==='美团外卖').gross,80);assert.equal(r.rows.find(r=>r.name==='美团外卖').ratio,60/520);assert.equal(r.rows.find(r=>r.name==='淘宝闪购').source,'第三方平台');assert.equal(r.rows.find(r=>r.name==='一键买单（尾款）').actual,10)});
test('只拆分显示，不修改原始数据，已提供平台字段不会与外卖合计重复',()=>{const d=sample();d.revenue_composition.push({category:'美团外卖',amount:60});const before=JSON.stringify(d);const r=realRevenueComposition(d);assert.equal(r.rows.filter(r=>r.name==='美团外卖').length,1);assert.equal(r.sum,520);assert.equal(JSON.stringify(d),before)});
test('缺少记录与明确零分别显示，不用汇总反推缺失字段，差额保留待核',()=>{const d=sample();d.channel_breakdown=d.channel_breakdown.filter(r=>r.channel!=='jd_delivery');d.revenue_composition=d.revenue_composition.filter(r=>r.category!=='现金');const r=realRevenueComposition(d);assert.equal(r.rows.find(r=>r.name==='现金').actual,null);assert.equal(r.rows.find(r=>r.name==='京东外卖').actual,null);assert.equal(r.rows.find(r=>r.name==='会员卡').actual,0);assert.equal(r.missingCount,2);assert.equal(r.sum,400);assert.equal(r.difference,-120)});
test('退款/冲减保留符号，原始支付字段不合并，零收入不制造占比',()=>{const d={totals:{confirmed:0},revenue_composition:[{category:'现金',amount:1.01},{category:'员工餐记账',amount:-1.01}],channel_breakdown:[]};const r=realRevenueComposition(d);assert.equal(r.sum,0);assert.equal(r.rows.find(r=>r.name==='员工餐记账').actual,-1.01);assert(r.rows.every(r=>r.ratio===null));assert.equal(realRevenueComposition({}).rows.length,0)});
test('环比按同一个支付字段/平台匹配，前期缺失不当零处理',()=>{const d=sample(),previous=sample();previous.revenue_composition.find(r=>r.category==='现金').amount=50;previous.channel_breakdown.find(r=>r.channel==='meituan_delivery').amount=30;previous.revenue_composition=previous.revenue_composition.filter(r=>r.category!=='抖音团购');const r=realRevenueComposition(d,previous);assert.equal(r.rows.find(r=>r.name==='现金').compareRate,1);assert.equal(r.rows.find(r=>r.name==='美团外卖').compareRate,1);assert.equal(r.rows.find(r=>r.name==='会员卡').compareRate,0);assert.equal(r.rows.find(r=>r.name==='抖音团购').compareRate,null)});

test('部分日期缺失保持平台金额，缺失元数据去重并定位门店日期，仅对应行标红',()=>{
  const d=sample(),day={store_id:1,store_name:'验证门店',biz_date:'2026-10-01',channel:'taobao_flash'};
  d.missing_platform_days=[day,day];
  const rows=realRevenueComposition(d).rows,taobao=rows.find(r=>r.name==='淘宝闪购');
  assert.equal(taobao.actual,40);assert.equal(taobao.source,'第三方平台');
  assert.equal(taobao.platformMissing,true);assert.equal(taobao.sourceTone,'danger');
  assert.equal(taobao.missingDays.length,1);assert.equal(taobao.missingDays[0].biz_date,'2026-10-01');
  assert.equal(rows.find(r=>r.name==='会员卡').platformMissing,false);
  assert.equal(rows.find(r=>r.name==='京东外卖').platformMissing,false);
});

test('团购缺失与营业日报缺失分别标红，真实零平台记录不误标',()=>{
  const d=sample(),day={store_id:2,store_name:'第二门店',biz_date:'2026-10-02'};
  d.revenue_composition.find(r=>r.category==='抖音团购').missing_platform_days=[{...day,channel:'douyin_group'}];
  d.channel_breakdown.find(r=>r.channel==='meituan_delivery').missing_gross_days=[{...day,channel:'meituan_delivery'}];
  d.channel_breakdown.find(r=>r.channel==='jd_delivery').amount=0;
  const rows=realRevenueComposition(d).rows;
  assert.equal(rows.find(r=>r.name==='抖音团购').platformMissing,true);
  assert.equal(rows.find(r=>r.name==='美团外卖').missingDays[0].reason,'营业日报未导入');
  assert.equal(rows.find(r=>r.name==='京东外卖').platformMissing,false);
});

test('旧缓存里的混合/回退金额不伪装成第三方金额，前期旧口径也不用于环比',()=>{
  const d=sample(),old=sample();old.channel_breakdown.find(r=>r.channel==='jd_delivery').source_used='mixed';
  let row=realRevenueComposition(d,old).rows.find(r=>r.name==='京东外卖');assert.equal(row.compareRate,null);
  row=realRevenueComposition(old).rows.find(r=>r.name==='京东外卖');assert.equal(row.actual,null);assert.equal(row.platformMissing,true);
});

function withTail(){
  const d=sample();d.totals.confirmed=522.99;
  d.revenue_composition=d.revenue_composition.filter(r=>!r.category.startsWith('一键买单'));
  d.revenue_composition.find(r=>r.category==='美团团购').amount=62.99;
  d.meituan_oneclick_reconciliation=[{store_id:1,store_name:'验证门店',biz_date:'2026-10-11',pos_tail:3,platform_tail:3,merchant_income:2.99,fees:.01,difference:0,source_status:'imported'}];
  return d;
}

test('平台尾款单列商家应得，从美团合计拆出只计一次，核对保留实付及手续费',()=>{
  const d=withTail(),before=JSON.stringify(d),r=realRevenueComposition(d),tail=r.rows.find(r=>r.name==='一键买单（尾款）');
  assert.equal(tail.actual,2.99);assert.equal(tail.source,'第三方平台');assert.equal(tail.oneclickRecords[0].platform_tail,3);
  assert.equal(tail.oneclickRecords[0].fees,.01);assert.equal(tail.oneclickRecords[0].difference,0);
  assert.equal(r.rows.find(r=>r.name==='美团团购').actual,60);assert.equal(r.sum,522.99);assert.equal(r.difference,0);
  assert.equal(JSON.stringify(d),before);
});

test('尾款部分日期缺采只合计已导入，缺失提示归尾款行并保留具体原因',()=>{
  const d=withTail(),day={store_id:2,store_name:'第二门店',biz_date:'2026-10-12',channel:'meituan_group',source_part:'oneclick'};
  d.missing_platform_days=[day];d.revenue_composition.find(r=>r.category==='美团团购').missing_platform_days=[day];
  d.meituan_oneclick_reconciliation.push({...day,pos_tail:7,platform_tail:null,merchant_income:null,fees:null,difference:null,source_status:'missing'});
  const r=realRevenueComposition(d),tail=r.rows.find(r=>r.name==='一键买单（尾款）');
  assert.equal(tail.actual,2.99);assert.equal(tail.platformMissing,true);assert.equal(tail.missingDays.length,1);
  assert.equal(tail.missingDays[0].reason,'一键买单尾款未导入');assert.equal(r.rows.find(r=>r.name==='美团团购').platformMissing,false);
});

test('尾款真实零与退款保留，不新增POS尾款；显式收银来源按收银尾款拆分',()=>{
  const d=withTail();Object.assign(d.meituan_oneclick_reconciliation[0],{pos_tail:0,platform_tail:0,merchant_income:0,fees:0,source_status:'verified_zero'});
  let tail=realRevenueComposition(d).rows.find(r=>r.name==='一键买单（尾款）');assert.equal(tail.actual,0);assert.equal(tail.platformMissing,false);
  Object.assign(d.meituan_oneclick_reconciliation[0],{pos_tail:-3,platform_tail:-3,merchant_income:-2.99,fees:-.01,source_status:'imported'});
  tail=realRevenueComposition(d).rows.find(r=>r.name==='一键买单（尾款）');assert.equal(tail.actual,-2.99);
  d.revenue_composition.find(r=>r.category==='美团团购').source='收银机';
  tail=realRevenueComposition(d).rows.find(r=>r.name==='一键买单（尾款）');assert.equal(tail.actual,-3);assert.equal(tail.source,'收银经营日报');assert.equal(tail.platformMissing,false);
});
