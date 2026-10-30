'use strict';

// Read-only order-time analysis. Never add platform settlement reports to POS
// orders: they describe the same sales using different clocks and amounts.
const CHANNELS = Object.freeze({store_sales:'店内销售',pickup:'自提销售',scan_pay:'扫码支付',cash:'现金',mini_stored:'小程序储值消费',other_offline:'其他线下',meituan_group:'美团团购',douyin_group:'抖音团购',free_trial:'免费试',meituan_delivery:'美团外卖',taobao_flash:'淘宝闪购',jd_delivery:'京东外卖',mixed:'跨渠道订单',other:'其他／未分类'});
function fail(message,status=400){throw Object.assign(new Error(message),{status})}
function date(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('请选择有效日期');
  return value;
}
function clock(value,end=false){
  const text=String(value??(end?'24:00':'00:00'));
  if(end&&text==='24:00')return 1440;
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text))fail('时段格式应为 HH:mm');
  return Number(text.slice(0,2))*60+Number(text.slice(3));
}
function ids(value){
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'&&typeof value!=='number')fail('门店参数无效');
  const parts=String(value).split(',');
  if(parts.length>500||parts.some(v=>!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)<1))fail('门店参数无效');
  return [...new Set(parts.map(Number))];
}
function options(query={}){
  const from=date(query.date_from),to=date(query.date_to),days=(Date.parse(to)-Date.parse(from))/86400000+1;
  if(days<1||days>93)fail('单次查询日期范围需在 1 至 93 天以内');
  const start=clock(query.time_from),end=clock(query.time_to,true);
  if(start===end)fail('起止时刻不能相同；全天请选择 00:00 至 24:00');
  const channels=String(query.channels||'').split(',').filter(Boolean);
  if(channels.some(c=>!Object.hasOwn(CHANNELS,c))||channels.length>Object.keys(CHANNELS).length)fail('平台参数无效');
  const page=Number(query.page??1),size=Number(query.page_size??20);
  if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(size)||size<1||size>100)fail('分页参数无效');
  const keyword=String(query.keyword||'').trim();if(keyword.length>100)fail('搜索内容过长');
  return {from,to,days,start,end,full:start===0&&end===1440,storeIds:ids(query.store_ids||query.store_id),channels:[...new Set(channels)],page,size,keyword};
}
function source(db,o){
  const tables=new Set(db.queryAll("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pos_product_sale_details','dish_sales','pos_order_coverage')").map(r=>r.name));
  const scope=o.storeIds?` AND p.store_id IN (${o.storeIds.map(()=>'?').join(',')})`:'';
  const params=[o.from,o.to,...(o.storeIds||[])];
  const empty="SELECT NULL store_id,NULL biz_date,NULL order_id,NULL order_time,NULL channel,NULL product_code,NULL product_name,NULL spec,0 quantity,0 sales_amount,0 income_amount WHERE 0";
  const pos=tables.has('pos_product_sale_details')?`SELECT p.store_id,p.biz_date,TRIM(COALESCE(p.order_id,'')) order_id,p.order_time,
    CASE WHEN p.channel IN (${Object.keys(CHANNELS).map(c=>`'${c}'`).join(',')}) THEN p.channel ELSE 'other' END channel,
    COALESCE(p.product_code,'') product_code,COALESCE(p.product_name,'') product_name,COALESCE(p.spec,'') spec,
    COALESCE(p.quantity,0) quantity,COALESCE(p.sales_amount,0) sales_amount,COALESCE(p.income_amount,0) income_amount
    FROM pos_product_sale_details p WHERE p.biz_date BETWEEN ? AND ?${scope}`:empty;
  if(!tables.has('pos_product_sale_details'))params.length=0;
  const legacyScope=o.storeIds?` AND s.id IN (${o.storeIds.map(()=>'?').join(',')})`:'';
  // Legacy names must resolve to exactly one store; no fuzzy/first-match binding.
  const legacy=tables.has('dish_sales')?`SELECT s.id,SUBSTR(d.order_time,1,10),TRIM(COALESCE(d.order_no,'')),d.order_time,
    CASE WHEN d.payment_detail LIKE '%京东%' THEN 'jd_delivery'
      WHEN d.payment_detail LIKE '%淘宝%' OR d.payment_detail LIKE '%饿了么%' THEN 'taobao_flash'
      WHEN d.payment_detail LIKE '%美团外卖%' THEN 'meituan_delivery'
      WHEN d.payment_detail LIKE '%抖音%' THEN 'douyin_group'
      WHEN d.payment_detail LIKE '%美团%团购%' OR d.payment_detail LIKE '%美团点评团购%' THEN 'meituan_group'
      WHEN d.payment_detail LIKE '%自提%' THEN 'pickup'
      WHEN d.payment_detail LIKE '%堂食%' OR d.payment_detail LIKE '%现金%' OR d.payment_detail LIKE '%微信%' OR d.payment_detail LIKE '%扫码%' OR d.payment_detail LIKE '%会员%' OR d.payment_detail LIKE '%支付宝%' THEN 'store_sales'
      ELSE 'other' END,
    COALESCE(d.product_code,''),COALESCE(d.product_name,''),COALESCE(d.spec,''),COALESCE(d.quantity,0),COALESCE(d.amount_total,0),COALESCE(d.income_amount,0)
    FROM dish_sales d JOIN (SELECT MIN(id) id,store_name FROM stores GROUP BY store_name HAVING COUNT(*)=1) s ON s.store_name=d.store_name
    WHERE d.order_time>=? AND d.order_time<?${legacyScope}
      AND NOT EXISTS (SELECT 1 FROM pos_days p WHERE p.store_id=s.id AND p.biz_date=SUBSTR(d.order_time,1,10))`:empty;
  if(tables.has('dish_sales'))params.push(o.from,new Date(Date.parse(o.to)+86400000).toISOString().slice(0,10),...(o.storeIds||[]));
  // Materialize only the small store/day key set. Without this boundary SQLite
  // can scan an entire month's POS rows for each historical dish when all stores
  // are selected, despite the source table's existing store/day index.
  const sql=`WITH pos AS (${pos}), pos_days AS MATERIALIZED (SELECT DISTINCT store_id,biz_date FROM pos), base AS (SELECT * FROM pos UNION ALL ${legacy}),
    lines AS (SELECT *,CASE WHEN LENGTH(order_time)>=16 AND SUBSTR(REPLACE(order_time,'T',' '),12,5) GLOB '[0-2][0-9]:[0-5][0-9]' AND SUBSTR(order_time,12,2)<'24' THEN SUBSTR(order_time,12,5) END clock FROM base),
    orders AS (SELECT store_id,biz_date,order_id,MIN(clock) clock,
      CASE WHEN COUNT(DISTINCT channel)>1 THEN 'mixed' ELSE MIN(channel) END channel,
      SUM(quantity) quantity,SUM(sales_amount) sales_amount,SUM(income_amount) income_amount
      FROM lines WHERE order_id<>'' GROUP BY store_id,biz_date,order_id)`;
  return {sql,params,tables};
}
function selected(o,alias='o'){
  const params=[],parts=[];
  if(o.channels.length){parts.push(`${alias}.channel IN (${o.channels.map(()=>'?').join(',')})`);params.push(...o.channels)}
  if(!o.full){parts.push(`(${alias}.clock IS NOT NULL AND (${alias}.clock ${o.start<o.end?'>= ? AND '+alias+'.clock < ?':'>= ? OR '+alias+'.clock < ?'}))`);params.push(toClock(o.start),toClock(o.end))}
  return {sql:parts.length?' WHERE '+parts.join(' AND '):'',params};
}
function toClock(minutes){return String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0')}
function getInsights(db,query={}){
  const o=options(query),s=source(db,o),selection=selected(o),stores=o.storeIds||db.queryAll('SELECT id FROM stores').map(r=>Number(r.id));
  const stats=db.queryAll(s.sql+` SELECT biz_date,channel,clock,SUM(CASE WHEN quantity>0 OR sales_amount>0 OR income_amount>0 THEN 1 ELSE 0 END) order_count FROM orders GROUP BY biz_date,channel,clock`,s.params);
  const coverage=db.queryAll(s.sql+` SELECT store_id,biz_date,COUNT(*) line_count,SUM(CASE WHEN clock IS NULL THEN 1 ELSE 0 END) untimed_lines,SUM(CASE WHEN order_id='' THEN 1 ELSE 0 END) unidentified_lines FROM lines GROUP BY store_id,biz_date`,s.params);
  const dishSql=s.sql+`, grouped AS (SELECT o.channel,l.product_code,l.product_name,l.spec,SUM(l.quantity) quantity,ROUND(SUM(l.sales_amount),2) sales_amount,ROUND(SUM(l.income_amount),2) income_amount
    FROM lines l JOIN orders o ON o.store_id=l.store_id AND o.biz_date=l.biz_date AND o.order_id=l.order_id${selection.sql}${selection.sql?' AND ':' WHERE '} (?='' OR INSTR(l.product_name,?)>0 OR INSTR(l.product_code,?)>0)
    GROUP BY o.channel,l.product_code,l.product_name,l.spec)`;
  const dishParams=[...s.params,...selection.params,o.keyword,o.keyword,o.keyword];
  const totalRows=db.queryAll(dishSql+` SELECT *,COUNT(*) OVER() total_rows FROM grouped ORDER BY quantity DESC,sales_amount DESC,channel,product_name,spec,product_code LIMIT ? OFFSET ?`,[...dishParams,o.size,(o.page-1)*o.size]);
  const dishTotal=totalRows[0]?.total_rows??(o.page>1?db.queryOne(dishSql+' SELECT COUNT(*) n FROM grouped',dishParams).n:0);
  const coveredDays=new Map();
  function cover(store,day){if(!coveredDays.has(day))coveredDays.set(day,new Set());coveredDays.get(day).add(Number(store))}
  for(const row of coverage)cover(row.store_id,row.biz_date);
  if(s.tables.has('pos_order_coverage')){
    const zeroScope=stores.length?` AND store_id IN (${stores.map(()=>'?').join(',')})`:' AND 0';
    for(const row of db.queryAll(`SELECT DISTINCT store_id,biz_date FROM pos_order_coverage WHERE biz_date BETWEEN ? AND ? AND order_count=0${zeroScope}`,[o.from,o.to,...stores]))cover(row.store_id,row.biz_date);
  }
  const inWindow=clock=>o.full||clock&&(o.start<o.end?clock>=toClock(o.start)&&clock<toClock(o.end):clock>=toClock(o.start)||clock<toClock(o.end));
  const scoped=stats.filter(r=>(!o.channels.length||o.channels.includes(r.channel))&&inWindow(r.clock));
  const platforms=[...new Set([...stats.map(r=>r.channel),...o.channels])].sort().map(key=>({key,label:CHANNELS[key]||CHANNELS.other}));
  const visible=platforms.filter(p=>!o.channels.length||o.channels.includes(p.key));
  const hourly=Array.from({length:24},(_,hour)=>({period:String(hour).padStart(2,'0')+':00',total:null,channels:Object.fromEntries(visible.map(p=>[p.key,null]))}));
  const hasTimed=stats.some(r=>r.clock)||coveredDays.size>0&&!coverage.length,hourEnabled=h=>o.full||(o.start<o.end?h*60<o.end&&(h+1)*60>o.start:h*60<o.end||(h+1)*60>o.start);
  for(let hour=0;hour<24;hour++)if(hasTimed&&hourEnabled(hour)){hourly[hour].total=0;for(const p of visible)hourly[hour].channels[p.key]=0}
  const daily=Array.from({length:o.days},(_,i)=>{
    const day=new Date(Date.parse(o.from)+i*86400000).toISOString().slice(0,10),known=coveredDays.has(day);
    return {period:day,total:known?0:null,channels:Object.fromEntries(visible.map(p=>[p.key,known?0:null]))};
  });
  const byDay=new Map(daily.map(r=>[r.period,r]));let orderCount=0,untimedOrders=0;
  for(const row of scoped){
    const n=Number(row.order_count);orderCount+=n;const day=byDay.get(row.biz_date);day.total=(day.total||0)+n;day.channels[row.channel]=(day.channels[row.channel]||0)+n;
    if(row.clock){const hour=hourly[Number(row.clock.slice(0,2))];hour.total=(hour.total||0)+n;hour.channels[row.channel]=(hour.channels[row.channel]||0)+n}else untimedOrders+=n;
  }
  return {ok:true,period:{date_from:o.from,date_to:o.to,time_from:toClock(o.start),time_to:toClock(o.end)},platforms,hourly,daily,
    totals:{orders:orderCount,timed_orders:orderCount-untimedOrders,untimed_orders:untimedOrders},
    coverage:{source:'收银品项下单记录；缺少品项的门店营业日使用历史菜品明细',source_days:coveredDays.size,untimed_lines:coverage.reduce((n,r)=>n+Number(r.untimed_lines||0),0),unidentified_lines:coverage.reduce((n,r)=>n+Number(r.unidentified_lines||0),0),unknown_days:daily.filter(r=>r.total===null).map(r=>r.period),missing_store_days:daily.reduce((sum,r)=>sum+Math.max(0,stores.length-(coveredDays.get(r.period)?.size||0)),0)},
    dishes:{rows:totalRows.map(({total_rows,...r})=>({...r,channel_label:CHANNELS[r.channel]||CHANNELS.other})),total:Number(dishTotal),page:o.page,page_size:o.size},
    notes:['订单按门店、营业日、订单号去重；一单多菜仅计一单，纯退款单不计新订单。','按下单时刻筛选，结束时刻不包含；跨午夜按所选营业日内的钟点统计。缺少下单时刻的订单仅计入全天的按日统计。','仅统计已导入的记录，不与平台核销、结算记录叠加。0 表示已导入范围无匹配订单；空白日期表示没有可核实记录。','菜品保留原编码、名称及规格，数量和金额包含退菜冲减；缺少订单号的明细不混入统计。']};
}
function mount({app,db,getUser}){
  app.get('/api/business-analytics/order-insights',(req,res)=>{
    try{
      const user=getUser(req.user?.id);if(!user)fail('请先登录',401);
      const rights=user.position_permissions||[];if(!rights.includes('*')&&!rights.includes('analysis.view'))fail('没有数据分析权限',403);
      const query={...req.query};const requested=ids(query.store_ids||query.store_id);
      const scope=req.accessStoreScope!==undefined?req.accessStoreScope:(!rights.includes('*')&&user.store_id?[Number(user.store_id)]:null);
      if(scope!==null){if(!scope.length||requested?.some(id=>!scope.includes(id)))fail('无权查询所选门店',403);query.store_ids=(requested||scope).join(',')}
      res.json(getInsights(db,query));
    }catch(e){if(!e.status)console.error('Order insights query failed:',e.message);res.status(e.status||500).json({error:e.status?e.message:'订单分析查询失败，请稍后重试'})}
  });
}
module.exports={CHANNELS,options,getInsights,mount};
