'use strict';
const dependencies={income:['dine','memberConsumption','meituan','taobao','jd','meituanGroup','douyinGroup','fee','memberGift'],cost:['factoryFood','factoryMaterial','food','material'],expense:['rent','utilities','salary','welfare','daily','promotion'],profit:['income','cost','expense','tax']};
const ratios={foodRate:['factoryFood','food'],materialRate:['factoryMaterial','material'],grossRate:['income','cost'],rentRate:['rent'],utilitiesRate:['utilities'],laborRate:['salary','welfare'],dailyRate:['daily'],promotionRate:['promotion'],expenseRate:['expense'],profitRate:['profit']};
const platforms={meituan:['美团外卖','外卖订单'],taobao:['淘宝闪购','外卖'],jd:['京东外卖','正向订单'],meituanGroup:['美团团购',''],douyinGroup:['抖音团购','']};
function build({values,sources,entries,fixed,efficiency,from,to,title,definitions,classify,problems,revenue}){
 const labels=Object.fromEntries(definitions.map(d=>[d[1],d[2]])),result={};
 const within=(r,key)=>r[key]>=from&&r[key]<=to;
 const sourceName={bookkeeping:'记账本',operating_previous:'运营成本上月数据',operating_current:'运营成本本月数据'};
 const item=(label,amount,source,date,record)=>({label,amount,source,date,record_id:record?.id||null,batch_id:record?.batch_id||null});
 const revenues=revenue||require('./store-finance-daily-member').split(require('./store-finance-revenue').calculate(sources,from,to),sources,from,to);
 for(const [,key]of definitions){let formula='',items=[];
  if(key==='dine'){
   formula='堂食外带＝现金＋扫码支付＋美团/大众点评普通支付；会员卡消费已单列，不包含在此行；收款手续费在扣减行计一次';
   const payment=require('./dine-payment-composition').read(sources.composition.filter(r=>within(r,'biz_date')));
   items=Object.entries(payment.parts).filter(([key])=>key!=='member').flatMap(([key,p])=>p.rows.map(r=>item(require('./pos-group-payments').isDinePayment(r.category)?r.category:({cash:'现金',scan:'扫码支付'})[key],Number(r.amount),'收银付款构成',r.biz_date,r)));
   for(const day of sources.closed_dates||[])if(day>=from&&day<=to)items.push(item('已确认休息日',0,'门店休息登记',day));
  }else if(['memberConsumption','memberGift'].includes(key)){
   const m=revenues.member_split;
   formula={memberConsumption:'会员卡消费＝消费本金＋消费赠金，消费与退单按营业日净额统计；充值不计收入；赠金在下方扣减，本金手续费并入手续费合计，仅扣一次',memberGift:'会员消费赠金不属于门店实收：按消费赠金记负数，退单反冲；不对赠金收取本金手续费',memberFee:'会员本金手续费＝每笔消费本金×0.0038，逐笔取分后合计；退单反冲，赠金不收费；此为测算，非实际提现账单'}[key];
   items=key==='memberConsumption'?[item('会员消费本金',m.principal,'会员消费及退单流水',title),item('会员消费赠金',m.gift,'会员消费及退单流水',title)]:revenues.details.filter(r=>r.category===(key==='memberGift'?'member_gift':'member_fee')).map(r=>({...item(r.label,r.amount===null?null:-r.amount,r.source,r.date),fee_actual:r.fee_actual}));
  }else if(platforms[key]){
   const [platform,revenueType]=platforms[key];formula='真实平台实收＋已扣第三方费用＋推广加回；缺少真实收入时为0';
   if(sources.bills[key]){
    const s=revenues.delivery[key];formula='外卖收入＝平台实收＋已扣第三方手续费加回＋已扣推广费加回；霸王餐等未从平台扣除的开销只在对应费用中扣一次，不加回收入';
    items=[{...item('平台实收',s.actual,platform+'账单净收支',from===to?from:from+' 至 '+to),children:s.actual_rows},{...item('第三方手续费（已扣加回）',s.third_party-s.outside_platform.third_party,'平台原始费用（退款冲减）',from===to?from:from+' 至 '+to),children:s.third_party_rows.filter(r=>r.add_back!==false)},{...item('推广费（已扣加回）',s.promotion-s.outside_platform.promotion,'平台推广及充值',from===to?from:from+' 至 '+to),children:s.promotion_rows.filter(r=>r.add_back!==false)}];
   }else{
    formula='真实平台结算到账＋平台费用（团购费用均归第三方）';
    const channel=key==='meituanGroup'?'meituan_group':'douyin_group';
    for(const r of sources.platform.filter(r=>within(r,'biz_date')&&r.channel===channel)){items.push(item('实际结算到账',Number(r.actual_amount),platform+'结算记录',r.biz_date,r));for(const field of ['service_fee','insurance_fee','promotion_fee','refund_amount'])if(Number(r[field]))items.push(item('加回平台费用：'+({service_fee:'服务费',insurance_fee:'保险',promotion_fee:'原始促销/推广',refund_amount:'退款费用'})[field],Number(r[field]),platform+'结算记录',r.biz_date,r));}
   }
  }else if(['fee','promotion'].includes(key)){
   formula=key==='fee'?'堂食收款手续费＋会员本金手续费＋外卖第三方手续费＋团购手续费，支出记负数、退款冲减；会员本金逐笔×0.0038测算，仅扣一次，赠金不收费且单列扣减，不是实际提现账单':'推广费按自动充值（扣余额）、手动充值（扫码支付）分别核对；霸王餐归推广费，未从平台扣除的开销不加回收入；支出记负数、退款冲减，金额可超过平台实收';
   const category={fee:'third_party',promotion:'promotion'}[key];
   items=key==='promotion'?require('./finance-promotion-breakdown').group(revenues.details,from,to):revenues.details.filter(r=>r.category===category||key==='fee'&&r.category==='member_fee').map(r=>({...item(r.platform+' · '+r.label,-r.amount,r.source||'平台账单/额外开销',r.date),payment_fee:r.payment_fee}));
   if(key==='fee')for(const r of revenues.details.filter(r=>r.payment_fee?.warning))items.push(item(r.payment_fee.warning,0,'堂食手续费核对',r.date));
  }else if(['rent','utilities','salary'].includes(key)){
   formula=fixed.details.some(r=>r.key===key&&r.tag_policy==='manual')?'记账本均摊项按日报月份分摊；实支及总部项按实际发生日计入，平台项不重复扣减':'月度基数按日报所属月天数分摊；当日＝当日累计应计－前日累计应计（处理分摊尾差）';
   const rows=fixed.details.filter(r=>r.key===key);
   items=rows.map(r=>({...item('月度基数',r.monthly_amount,sourceName[r.source],r.reference_month),days_in_month:r.days_in_month}));
   for(const r of rows)items.push(...(r.source_rows||[]).map(entry=>item('原始登记：'+entry.label,entry.amount,sourceName[r.source],entry.date,entry)));
   items.push(item('本期分摊金额',values[key],'日应计分摊',from===to?from:from+' 至 '+to));
  }else if(dependencies[key]){formula=dependencies[key].map(k=>labels[k]).join('＋');items=dependencies[key].map(k=>item(labels[k],values[k],'日报计算',title));}
  else if(ratios[key]){const keys=ratios[key];formula=(['grossRate','profitRate'].includes(key)?'':'取成本支出相反数：')+'（'+keys.map(k=>labels[k]).join('＋')+'）÷收入合计×100%；收入为0时留空';items=[...keys.map(k=>item(labels[k],values[k],'日报计算',title)),item('收入合计（分母）',values.income,'日报计算',title)];}
  else if(key==='efficiency'){formula='出勤人员工资÷收银店内销售×100%；有打卡计出勤，兼职按完整计划时长计薪，不执行迟到早退扣减，与月经营看板相同';items=efficiency?.items||[];}
  else{formula='按记账本业务日期累计该项目，保留支出及退款符号';items=entries.filter(r=>classify(r)===key).map(r=>item(r.category_name+' / '+r.subcategory_name,Number(r.amount),'记账本',r.date,r));}
  const availability=revenues.availability?.[key];
  result[key]={title,from,to,formula,value:values[key],items,promotion_structure:key==='promotion',delivery_structure:revenues.delivery[key],unavailable:values[key]===null,availability,notes:key==='efficiency'?efficiency?.notes||[]:values[key]===null?problems.filter(p=>p.includes(labels[key])||p.includes('暂留空')||p.includes('待确认')):availability?[availability.note]:[]};
 }
 return result;
}
module.exports={build};
