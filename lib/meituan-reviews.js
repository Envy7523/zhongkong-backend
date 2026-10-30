'use strict';
const fs=require('fs'),path=require('path');
function metricDetails(metric={}){
 const text=metric.rawText||'',dimensions={};for(const label of ['口味','环境','服务','性价比']){const m=text.match(new RegExp(label+'\\s*([0-5](?:\\.\\d+)?)'));if(m)dimensions[label]=Number(m[1]);}
 return {...metric,dimensions,scoreChange:text.match(/较昨日\s*([^\n]+)/)?.[1]||null};
}
function reviewDate(value,reference){
 const match=String(value||'').match(/^(?:(\d{4})[/-])?(\d{2})[/-](\d{2})/);if(!match)return null;
 let year=match[1]||reference.slice(0,4),date=`${year}-${match[2]}-${match[3]}`;
 if(!match[1]&&date>reference){year=String(Number(year)-1);date=`${year}-${match[2]}-${match[3]}`;}
 const parsed=new Date(date+'T00:00:00Z');if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)return null;
 return date;
}
function report(db,query,data){
 const raw=String(query.store_ids||query.store_id||'').split(',').filter(Boolean);
 if(!raw.length||raw.some(x=>!/^\d+$/.test(x)||Number(x)<=0))throw Error('请先选择门店并点击查询');
 const ids=new Set(raw.map(Number)),ignored=new Set(data.ignoredPlatformStoreIds||[]);
 const links=db.queryAll("SELECT p.platform_id,s.id,s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id WHERE p.platform_name='美团团购' AND p.platform_id<>''");
 const byPlatform=new Map();for(const link of links){const key=String(link.platform_id);byPlatform.set(key,[...(byPlatform.get(key)||[]),link]);}
 const bind=sid=>{if(ignored.has(String(sid)))return null;const hits=byPlatform.get(String(sid))||[];return hits.length===1?hits[0]:null;};
 const selected=sid=>{const hit=bind(sid);return hit&&ids.has(hit.id)?hit:null;};
 const stores=(data.stores||[]).flatMap(s=>{const hit=selected(s.platformStoreId);return hit?[{...s,storeId:hit.id,platformStoreName:s.storeName,storeName:hit.store_name}]:[];});
 const source=String(query.source||'all');if(!['all','美团评价','点评评价'].includes(source))throw Error('评价来源无效');
 const rating=String(query.rating||'all');if(!['all','positive','negative',...Array.from({length:10},(_,i)=>String((i+1)/2))].includes(rating))throw Error('评价星级筛选无效');
 const ratings=query.ratings==null?null:String(query.ratings).split(',').filter(Boolean).map(Number);
 if(ratings?.some(value=>!Number.isFinite(value)||value<0.5||value>5||!Number.isInteger(value*2)))throw Error('评价星级筛选无效');
 const mode=String(query.mode||'full');if(!['full','recent7'].includes(mode))throw Error('评价时间筛选无效');
 const endDate=String(query.date_to||'');
 if(mode==='recent7'&&(!/^\d{4}-\d{2}-\d{2}$/.test(endDate)||reviewDate(endDate,endDate)!==endDate))throw Error('请先选择有效的查询结束日期并点击查询');
 const startDate=mode==='recent7'?new Date(Date.parse(endDate+'T00:00:00Z')-6*86400000).toISOString().slice(0,10):null;
 const collectedDate=data.updatedAt?new Date(Date.parse(data.updatedAt)+8*3600000).toISOString().slice(0,10):(endDate||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
 const scopedReviews=(data.reviews||[]).flatMap(r=>{const hit=selected(r.platformStoreId);return hit?[{...r,storeId:hit.id,storeName:hit.store_name}]:[];}).filter(r=>(source==='all'||r.source===source)&&(mode==='full'||(()=>{const date=reviewDate(r.publishedDisplay,collectedDate);return date&&date>=startDate&&date<=endDate;})()));
 const stats=rows=>{const positive=rows.filter(r=>r.rating>=4).length,negative=rows.filter(r=>r.rating>0&&r.rating<=3.5).length,replied=rows.filter(r=>r.merchantReplies?.length).length;return {total:rows.length,positive,negative,unrated:rows.length-positive-negative,textCount:rows.filter(r=>String(r.text||'').trim()).length,replied,replyRate:rows.length?Number((replied/rows.length*100).toFixed(1)):null,stars:Array.from({length:10},(_,i)=>({rating:(i+1)/2,count:rows.filter(r=>Number(r.rating)===(i+1)/2).length}))};};
 const summary=stats(scopedReviews);
 const storeStats=stores.map(s=>({...s,sources:Object.fromEntries(Object.entries(s.sources||{}).map(([name,value])=>[name,{...value,metrics:metricDetails(value.metrics)}])),...stats(scopedReviews.filter(r=>r.storeId===s.storeId))}));
 const reviews=scopedReviews.filter(r=>(!(query.text_only==='1')||String(r.text||'').trim())&&(ratings?ratings.includes(Number(r.rating)):(rating==='all'||(rating==='positive'?r.rating>=4:rating==='negative'?r.rating>0&&r.rating<=3.5:Number(r.rating)===Number(rating))))).sort((a,b)=>String(reviewDate(b.publishedDisplay,collectedDate)||'').localeCompare(String(reviewDate(a.publishedDisplay,collectedDate)||''))||String(b.publishedDisplay).localeCompare(String(a.publishedDisplay)));
 const pageSize=query.page_size==null?20:Number(query.page_size);if(![10,20,50,100].includes(pageSize))throw Error('每页条数无效');
 const page=Math.min(Math.max(1,Math.ceil(reviews.length/pageSize)),Math.max(1,parseInt(query.page,10)||1));
 return {available:!!data.runId,updatedAt:data.updatedAt||null,runId:data.runId||null,mode,dateRange:mode==='recent7'?`${startDate} 至 ${endDate}`:null,stores:storeStats,summary,total:reviews.length,page,pageSize,reviews:reviews.slice((page-1)*pageSize,page*pageSize)};
}
function mount({app,db}){
 const file=process.env.MEITUAN_REVIEW_SNAPSHOT||(process.platform==='win32'?path.join(__dirname,'../data/meituan-review-display-snapshot.json'):'/opt/zhongkong-sync-bot/state/reviews/meituan-display-snapshot.json');let cached,mtime;
 app.get('/api/business-analytics/meituan-reviews',(req,res)=>{try{
  const user=require('./user-positions').enrich(db,db.queryOne('SELECT u.id,u.position_id,p.permissions_json FROM users u LEFT JOIN position_settings p ON p.id=u.position_id WHERE u.id=?',[req.user.id]));
  if(!require('./permissions').can(user?.permissions_json,'analysis.view'))return res.status(403).json({error:'无数据分析查看权限'});
  let data={};if(fs.existsSync(file)){const stat=fs.statSync(file);if(!cached||mtime!==stat.mtimeMs){cached=JSON.parse(fs.readFileSync(file,'utf8'));mtime=stat.mtimeMs;}data=cached;}res.json(report(db,req.query,data));
 }catch(e){res.status(400).json({error:e.message});}});
}
module.exports={mount,report,reviewDate};
