// Mobile read-only projection of the existing merged POS/legacy dish analytics.
const analytics=require('../business-analytics');
const {validDate}=require('./bookkeeping');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const r=(v,n=2)=>Math.round((Number(v)||0)*10**n)/10**n;
const VIEWS={all:'总视角','dine-in':'堂食','group-buy':'团购',delivery:'外卖'};
function list(db,user,scope,q){
  if(!(user.position_permissions||[]).some(p=>p==='*'||p==='analysis.view'))fail('当前人员没有菜品销量查询权限',403);
  const id=Number(q.store_id);if(!Number.isInteger(id)||id<=0)fail('请选择有效门店');
  if(!require('../personnel-access').allows(scope,id))fail('无权查看此门店数据',403);
  const store=db.queryOne('SELECT id,store_name FROM stores WHERE id=?',[id]);if(!store)fail('门店不存在',404);
  const from=String(q.date_from||''),to=String(q.date_to||'');
  if(!validDate(from)||!validDate(to)||from>to||(Date.parse(to)-Date.parse(from))/86400000>365)fail('请选择有效日期范围，最多366天');
  const view=String(q.view||'all'),sort=String(q.sort||'quantity'),direction=String(q.direction||'desc'),keyword=String(q.keyword||'').trim();
  if(!Object.hasOwn(VIEWS,view)||!['quantity','amount','income'].includes(sort)||!['asc','desc'].includes(direction)||keyword.length>80)fail('菜品筛选或排序参数无效');
  const page=Number(q.page||1),size=Number(q.page_size||20);
  if(!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(size)||size<1||size>100)fail('分页参数无效');
  const group={'dine-in':'offline','group-buy':'group_buy',delivery:'delivery'}[view];
  const platforms=group?Object.values(analytics.CHANNELS).filter(c=>c.group===group).map(c=>c.label).join(','):'';
  // Only validated, explicitly selected store/date/view filters reach analytics. Ignore injected store_ids/platforms.
  const source=analytics.getMergedDishSalesAnalytics(db,{store_id:id,date_from:from,date_to:to,platforms});
  let rows=[...(source.dishes||[]).map(x=>({...x,bound:true})),...(source.unbound||[]).map(x=>({...x,bound:false}))].map((x,i)=>({
    key:(x.bound?'dish:':'unbound:')+(x.dish_key||[x.product_code,x.product_name,x.spec,i].join('|')),
    name:x.dish_name||x.product_name||'未命名菜品',spec:x.bound?(x.specs||[]).join(' / '):(x.spec==='--'?'':x.spec||''),
    spec_rows:(x.sku_breakdown||[]).map((s,j)=>({key:String(s.menu_item_id||j)+':'+s.spec,spec:s.spec||'标准规格',quantity:r(s.quantity,3),sales_amount:r(s.sales_amount),income_amount:s.income_amount==null?null:r(s.income_amount)})),
    quantity:r(x.quantity,3),sales_amount:r(x.sales_amount),income_amount:x.income_amount==null?null:r(x.income_amount),bound:x.bound
  }));
  if(keyword)rows=rows.filter(x=>(x.name+' '+x.spec).toLowerCase().includes(keyword.toLowerCase()));
  const field={quantity:'quantity',amount:'sales_amount',income:'income_amount'}[sort],sign=direction==='desc'?-1:1;
  rows.sort((a,b)=>{if(a[field]==null&&b[field]!=null)return 1;if(b[field]==null&&a[field]!=null)return -1;return sign*((a[field]||0)-(b[field]||0))||a.name.localeCompare(b.name,'zh-CN')||a.key.localeCompare(b.key)});
  const summary={quantity:r(rows.reduce((s,x)=>s+x.quantity,0),3),sales_amount:r(rows.reduce((s,x)=>s+x.sales_amount,0)),income_amount:r(rows.reduce((s,x)=>s+(x.income_amount||0),0)),income_pending:rows.some(x=>x.income_amount==null),dish_count:rows.length,unbound_count:rows.filter(x=>!x.bound).length};
  return {ok:true,rows:rows.slice((page-1)*size,page*size),summary,total:rows.length,page,page_size:size,view,view_name:VIEWS[view],sort,direction,store,date_from:from,date_to:to,
    note:'按收银菜品明细统计，实收为品项实收；堂食采用后台线下渠道口径（含自提）。未绑定菜品保留原名称，包装耗材不计入。'};
}
module.exports={list};
