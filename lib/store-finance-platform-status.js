'use strict';
const META={meituan:['美团外卖','meituan_delivery','外卖订单'],taobao:['淘宝闪购','taobao_flash','外卖'],jd:['京东外卖','jd_delivery','正向订单'],meituanGroup:['美团团购','meituan_group',''],douyinGroup:['抖音团购','douyin_group','']};
const aliases={meituan:['美团外卖'],taobao:['淘宝闪购','淘宝外卖','饿了么'],jd:['京东外卖','京东秒送'],meituanGroup:['美团团购','美团/大众点评团购'],douyinGroup:['抖音团购','抖音']};
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
function review(sources,key,from,to){
 const [platform,channel,type]=META[key],registrations=(sources.accounts||[]).filter(r=>aliases[key].includes(r.platform_name));
 const dates=registrations.filter(r=>validDate(r.online_date)).map(r=>r.online_date).sort(),onlineDate=dates[0]||null;
 const hasAccount=registrations.some(r=>r.setup_status==='已上线'||(!r.setup_status&&String(r.platform_id||'').trim()));
 const missing=[],normalZero=[],hasData=[];
 for(let day=from;day<=to;day=new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10)){
  const bill=(sources.bills[key]||[]).some(r=>r.bill_date===day&&(r.bill_type===type||r.bill_type.startsWith(type+' ·')));
  const record=(sources.platform||[]).find(r=>r.channel===channel&&r.biz_date===day);
  const zeroRecord=record&&Number(record.actual_amount)===0&&Number(record.platform_income_amount)===0&&Number(record.order_count)===0;
  const groupData=type===''&&Boolean(record);
  if(bill||zeroRecord||groupData){hasData.push(day);continue;}
  const cashEvidence=(sources.pos||[]).some(r=>r.channel===channel&&r.biz_date===day&&(Number(r.recorded_amount)!==0||Number(r.order_count)>0))||(sources.composition||[]).some(r=>r.biz_date===day&&aliases[key].includes(r.category)&&Number(r.amount)!==0);
  if((onlineDate&&day<onlineDate)||(!onlineDate&&!hasAccount)||(sources.closed_dates||[]).includes(day)||(type===''&&!cashEvidence))normalZero.push(day);
  else missing.push(day);
 }
 let note;
 if(missing.length)note=`${platform}${onlineDate?'已于'+onlineDate+'开通':'已登记账号但开通日期未填写'}，缺少真实数据：${missing.join('、')}；暂显示0，不使用收银替代。`;
 else if(normalZero.length)note=`${platform}${onlineDate?'开通日期为'+onlineDate+'，开通前或休息日':'未登记已开通账号'}，无营业数据按正常0处理。`;
 else note=`${platform}已有真实来源记录，金额为0也属于有效数据。`;
 return {platform,online_date:onlineDate,missing_dates:missing,normal_zero_dates:normalZero,data_dates:hasData,note,abnormal:missing.length>0};
}
module.exports={review};
