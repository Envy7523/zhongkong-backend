const deliveryChannels=[['meituan_delivery','美团外卖'],['taobao_flash','淘宝闪购'],['jd_delivery','京东外卖']];
const deliveryNames=new Set(['外卖','美团外卖','淘宝闪购','京东外卖','京东秒送']);
const baseNames=['现金','扫码支付','会员卡','美团团购','抖音团购'];
const cents=value=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))?null:Math.round(Number(value)*100);
function sourceLabel(source,status){
  if(status==='platform_missing_fallback_pos'||source==='mixed')return '平台数据待更新';
  if(status==='platform_missing_zero'||status==='platform_incomplete')return '第三方平台';
  if(source==='platform')return '第三方平台';
  return source==='pos'?'收银机':source||'未提供';
}
function collect(data={}){
  if(!data.revenue_composition?.length&&!data.channel_breakdown?.length)return [];
  const rows=new Map();
  for(const item of data.revenue_composition||[]){
    const name=String(item.category||'').trim();
    // These are overlapping summaries. Their three channel amounts are listed once below.
    if(!name||deliveryNames.has(name))continue;
    const amount=cents(item.amount),old=rows.get(name);
    const combined=amount===null||old?.amountCents===null?null:(old?.amountCents||0)+amount;
    rows.set(name,{key:'income/'+name,name,kind:/团购/.test(name)?'团购平台':'支付方式',actual:combined===null?null:combined/100,amountCents:combined,source:sourceLabel(item.source),gross:null});
  }
  for(const name of baseNames)if(!rows.has(name)&&!(name==='会员卡'&&rows.has('会员卡（本金）')))rows.set(name,{key:'income/'+name,name,kind:/团购/.test(name)?'团购平台':'支付方式',actual:null,source:'未提供',gross:null});
  const checks=data.meituan_oneclick_reconciliation,meituan=rows.get('美团团购');
  if(Array.isArray(checks)&&checks.length&&meituan?.actual!==null&&['第三方平台','收银机','收银经营日报'].includes(meituan?.source)){
    const platform=meituan.source==='第三方平台';
    const tailCents=checks.reduce((sum,row)=>sum+(cents(platform?row.merchant_income:row.pos_tail)||0),0);
    // The backend Meituan amount includes this independently imported subset.
    // Split it for display, never add the POS tail to that platform total again.
    for(const name of rows.keys())if(/^一键买单/.test(name))rows.delete(name);
    meituan.actual=(cents(meituan.actual)-tailCents)/100;
    meituan.oneclickSeparated=true;
    rows.set('一键买单（尾款）',{key:'income/一键买单（尾款）',name:'一键买单（尾款）',kind:'买单尾款',actual:tailCents/100,source:platform?'第三方平台':'收银经营日报',gross:null,oneclickRecords:[...checks].sort((a,b)=>String(a.biz_date).localeCompare(String(b.biz_date))||String(a.store_name).localeCompare(String(b.store_name))),oneclickPlatform:platform});
  }
  const payments=[...rows.values()].sort((a,b)=>{
    const order=name=>{const i=baseNames.indexOf(name==='会员卡（本金）'?'会员卡':name);return i<0?3:i<3?i:i+100};
    return order(a.name)-order(b.name)||a.name.localeCompare(b.name,'zh-CN');
  });
  const channels=new Map((data.channel_breakdown||[]).map(r=>[r.channel,r]));
  return payments.concat(deliveryChannels.map(([channel,name])=>{
    const item=channels.get(channel),legacyMixed=item?.source_used==='mixed'||item?.source_status==='platform_missing_fallback_pos',amount=legacyMixed?null:cents(item?.amount);
    return {key:'channel/'+channel,name,kind:'外卖平台',actual:amount===null?null:amount/100,source:sourceLabel(item?.source_used,item?.source_status),gross:legacyMixed||cents(item?.gross_amount)===null?null:cents(item.gross_amount)/100,grossPending:!!item?.gross_pending};
  }));
}
function fullAmounts(data,rows){
  const platforms=new Map((data.platform_income_composition||[]).map(p=>[p.channel,p]));
  const tail=rows.find(r=>r.oneclickRecords);
  const tailValues=tail?.oneclickRecords.map(r=>cents(tail.oneclickPlatform?r.platform_tail:r.pos_tail))||[];
  const tailCents=tailValues.length&&!tailValues.some(v=>v!==null)?null:tailValues.reduce((sum,v)=>sum+(v||0),0);
  const tailPending=tailValues.some(v=>v===null);
  return new Map(rows.map(row=>{
    let amount=cents(row.actual),pending=row.platformMissing||false;
    if(row.name==='会员卡（本金）'||row.name==='会员卡消费'){
      amount=data.member_card_consumption?.available?cents(data.member_card_consumption.consumption):null;
      pending=pending||data.member_card_consumption?.ready===false;
    }else if(row.oneclickRecords){amount=tailCents;pending=pending||tailPending;}
    else if(row.key.startsWith('channel/')){amount=cents(row.gross);pending=pending||row.grossPending;}
    else if(['美团团购','抖音团购'].includes(row.name)&&row.source==='第三方平台'){
      const platform=platforms.get(row.name==='美团团购'?'meituan_group':'douyin_group');
      amount=cents(platform?.gross);pending=pending||platform?.ready===false;
      if(amount!==null&&row.name==='美团团购'&&row.oneclickSeparated){amount=tailCents===null?null:amount-tailCents;pending=pending||tailPending;}
    }
    return [row.key,{amount:amount===null?null:amount/100,pending}];
  }));
}
export function realRevenueComposition(data={},previous={}){
  const prior=new Map(collect(previous).map(r=>[r.key,r]));
  const totalCents=cents(data.totals?.confirmed),rows=collect(data).map(row=>{
    const channel=row.key.startsWith('channel/')?row.key.slice(8):({'美团团购':'meituan_group','抖音团购':'douyin_group','一键买单（尾款）':row.oneclickRecords?'meituan_group':undefined})[row.name];
    const item=channel&&row.key.startsWith('channel/')?(data.channel_breakdown||[]).find(r=>r.channel===channel):(data.revenue_composition||[]).find(r=>r.category===row.name);
    const applies=day=>day.channel===channel&&(row.oneclickRecords?row.oneclickPlatform&&day.source_part==='oneclick':!row.oneclickSeparated||day.source_part!=='oneclick');
    const missingDays=[...(item?.missing_platform_days||[]).filter(applies),...(data.missing_platform_days||[]).filter(applies)].map(r=>({...r,reason:r.source_part==='oneclick'?'一键买单尾款未导入':'收益/账单未导入'}));
    missingDays.push(...(item?.member_missing_days||[]));
    if(row.oneclickPlatform)missingDays.push(...row.oneclickRecords.filter(r=>r.source_status==='missing'&&Number(r.pos_tail)!==0).map(r=>({...r,reason:'一键买单尾款未导入'})));
    missingDays.push(...(item?.missing_gross_days||[]).map(r=>({...r,reason:'营业日报未导入'})));
    const uniqueMissing=[...new Map(missingDays.map(r=>[[r.store_id,r.biz_date,r.reason].join('|'),r])).values()].sort((a,b)=>String(a.biz_date).localeCompare(String(b.biz_date))||String(a.store_name).localeCompare(String(b.store_name)));
    const legacyMixed=item?.source_used==='mixed'||item?.source_status==='platform_missing_fallback_pos';
    if(legacyMixed){row.actual=null;row.gross=null;}
    const beforeRow=prior.get(row.key),before=beforeRow?.source===row.source?beforeRow.actual:null;
    const rate=row.actual===null||before==null||before===0?(before===0&&row.actual===0?0:null):(row.actual-before)/before;
    const platformMissing=uniqueMissing.length>0||legacyMixed||['platform_missing_zero','platform_incomplete'].includes(item?.source_status);
    const member=row.name==='会员卡（本金）'&&data.member_card_consumption?.available?data.member_card_consumption:null;
    return {...row,...(member?{name:'会员卡消费',memberConsumption:true,displayAmount:cents(member.consumption)===null?null:cents(member.consumption)/100}:{}),missingDays:uniqueMissing,platformMissing,ratio:row.actual===null||!totalCents?null:Math.round(row.actual*100)/totalCents,compareRate:rate,sourceTone:platformMissing?'danger':row.actual===null||row.source==='未提供'||/缺失|\+/.test(row.source)?'warning':row.source==='第三方平台'?'success':'info'};
  });
  const sumCents=rows.reduce((n,r)=>n+(cents(r.actual)||0),0);
  const currentFull=fullAmounts(data,rows),previousFull=fullAmounts(previous,collect(previous));
  const fullPositiveCents=rows.reduce((sum,row)=>sum+Math.max(0,cents(currentFull.get(row.key).amount)||0),0);
  for(const row of rows){
    const full=currentFull.get(row.key),before=prior.get(row.key)?.source===row.source?previousFull.get(row.key)?.amount:null;
    row.fullAmount=full.amount;row.fullPending=full.pending;
    row.fullRatio=full.amount===null||!fullPositiveCents?null:cents(full.amount)/fullPositiveCents;
    row.fullCompareRate=full.amount===null||before==null||before===0?(before===0&&full.amount===0?0:null):(full.amount-before)/before;
  }
  return {rows,total:totalCents===null?null:totalCents/100,sum:sumCents/100,difference:totalCents===null?null:(sumCents-totalCents)/100,missingCount:rows.filter(r=>r.actual===null).length,
    fullSum:rows.reduce((sum,row)=>sum+(cents(row.fullAmount)||0),0)/100,fullMissingCount:rows.filter(r=>r.fullAmount===null).length,fullPendingCount:rows.filter(r=>r.fullPending).length};
}
