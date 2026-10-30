const fs = require('fs');
const path = require('path');
// Legacy source alias 麓城店 → 万科麓城店 confirmed by the operator on 2026-10-20.
// Exact store suffixes only: do not fuzzy-match or attach unregistered stores.
const aliases = { '合正方洲店': '方洲店', '麦地总店': '麦地店', '溪尾店': '普宁溪尾店', '麓城店': '万科麓城店' };
// Verified from the platform's store review URL on 2026-10-10.
// Resolve through the registered platform ID rather than a guessed name alias.
const verifiedSourceIds = { '鹅太公(发到家店)': '7548349918924097551' };
function suffix(name) {
  const hit = String(name || '').match(/[（(]([^()（）]+)[)）]\s*$/);
  return hit ? aliases[hit[1]] || hit[1] : String(name || '').trim();
}
let cached, cachedMtime;
function snapshot(file) {
  try {
    const stat = fs.statSync(file);
    if (!cached || cachedMtime !== stat.mtimeMs) { cached = JSON.parse(fs.readFileSync(file, 'utf8')); cachedMtime = stat.mtimeMs; }
    return cached;
  } catch (error) { if (error.code === 'ENOENT') return {stores: [], datasets: {}}; throw error; }
}
function storeBinding(db) {
  const stores = db.queryAll("SELECT id,store_name FROM stores");
  const bySuffix = new Map();
  for (const store of stores) { const key=suffix(store.store_name); bySuffix.set(key, [...(bySuffix.get(key)||[]), store]); }
  const platformBindings = db.queryAll("SELECT store_id,platform_id FROM store_platforms WHERE platform_name='抖音团购'");
  // Platform IDs are strings: Douyin IDs exceed Number's safe integer range.
  // An explicit unknown/ambiguous ID must never fall back to a similar name.
  const bind = item => {
    const name=item.storeName;
    const supplied=item.platformStoreId ?? item.poiId ?? item.poi_id ?? item.store_id;
    if(typeof supplied==='number' && !Number.isSafeInteger(supplied))return null;
    const platformId=supplied!=null && String(supplied).trim()!=='' ? String(supplied).trim() : verifiedSourceIds[name];
    if(platformId){
      const hits=platformBindings.filter(item=>String(item.platform_id)===platformId);
      return hits.length===1 ? stores.find(store=>store.id===Number(hits[0].store_id)) || null : null;
    }
    const hits=bySuffix.get(suffix(name)) || []; return hits.length===1 ? hits[0] : null;
  };
  return bind;
}
function mediaAllowed(db,data,name,scope) {
  if(scope===null)return true;
  if(!Array.isArray(scope)||!scope.length)return false;
  const bind=storeBinding(db);
  return Object.values(data.datasets||{}).some(dataset=>(dataset?.reviews||[]).some(review=>
    (review.mediaFiles||[]).includes(name)&&scope.includes(Number(bind(review)?.id))));
}
function report(db, query, data) {
  const bind=storeBinding(db);
  const rawIds=String(query.store_ids || query.store_id || '').split(',').filter(Boolean);
  if (rawIds.some(id=>!/^\d+$/.test(id)||Number(id)<=0)) throw Error('门店筛选无效');
  const ids=new Set(rawIds.map(Number));
  const selected=store=>store && (!ids.size || ids.has(store.id));
  const mode=query.mode==='full'?'full':'recent7';
  const endDate=String(query.date_to || '');
  if(mode==='recent7' && (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !Number.isFinite(Date.parse(endDate+'T00:00:00Z')) || new Date(endDate+'T00:00:00Z').toISOString().slice(0,10)!==endDate))throw Error('请先选择有效的查询结束日期并点击查询');
  const startDate=mode==='recent7'?new Date(Date.parse(endDate+'T00:00:00Z')-6*86400000).toISOString().slice(0,10):null;
  // Historical seven-day queries must use the complete archive, not the latest collection window.
  const dataset=mode==='recent7'?(data.datasets.full || data.datasets.recent7):data.datasets.full;
  const metrics=data.stores.flatMap(item=>{const store=bind(item);return selected(store)?[{...item,storeId:store.id,storeName:store.store_name,platformStoreName:item.storeName}]:[];});
  const reviews=(dataset?.reviews || []).filter(item=>{const day=item.publishedDate || item.publishedDisplay;return mode==='full' || (day>=startDate && day<=endDate);}).flatMap(item=>{const store=bind(item);return selected(store)?[{...item,storeId:store.id,storeName:store.store_name}]:[];});
  const rating=String(query.rating || 'all');
  const ratingLabel=String(query.rating_label || '').trim();
  const textOnly=query.text_only==='1' || query.text_only===true;
  const ratingLabels=[...new Set(reviews.map(item=>item.ratingLabel).filter(Boolean))].sort();
  const positive=r=>['超赞','推荐','满意','好评'].includes(r.ratingLabel),negative=r=>['一般','不满意','很差','较差','非常差','差评','中评'].includes(r.ratingLabel);
  const summary={total:reviews.length,positive:reviews.filter(positive).length,negative:reviews.filter(negative).length,unrated:reviews.filter(r=>!positive(r)&&!negative(r)).length,textCount:reviews.filter(r=>String(r.text||'').trim()).length,replied:reviews.filter(r=>r.merchantReplies?.length).length,mediaCount:reviews.filter(r=>r.media?.length).length,labels:ratingLabels.map(label=>({label,count:reviews.filter(r=>r.ratingLabel===label).length}))};
  const labels=query.rating_labels==null?null:String(query.rating_labels).split(',');
  const ratings=query.ratings==null?null:String(query.ratings).split(',').filter(Boolean).map(Number);
  if(ratings?.some(r=>!Number.isFinite(r)||r<.5||r>5||!Number.isInteger(r*2)))throw Error('评价星级无效');
  const numericRating=item=>item.rating!=null&&Number.isFinite(Number(item.rating))&&Number(item.rating)>0?Number(item.rating):null;
  const filtered=reviews.filter(item=>
    (!textOnly || String(item.text || '').trim().length>0) &&
    (!ratingLabel || item.ratingLabel===ratingLabel) &&
    (!labels || labels.includes(item.ratingLabel)) &&
    (!ratings || (numericRating(item)===null?query.include_unrated==='1':ratings.includes(numericRating(item)))) &&
    (rating==='all'||(rating==='negative'?['一般','不满意','很差','较差','非常差','差评','中评'].includes(item.ratingLabel):['超赞','推荐','满意','好评'].includes(item.ratingLabel)))
  );
  const pageSize=[10,20,50,100].includes(Number(query.page_size))?Number(query.page_size):20, pages=Math.max(1,Math.ceil(filtered.length/pageSize));
  const page=Math.min(pages,Math.max(1,parseInt(query.page,10)||1));
  return {updatedAt:data.updatedAt||null,mode,available:!!dataset,collectedAt:dataset?.collectedAt||null,dateRange:mode==='recent7'?`${startDate} 至 ${endDate}`:null,
    stores:metrics,summary,ratingLabels,total:filtered.length,page,pageSize,reviews:filtered.slice((page-1)*pageSize,page*pageSize),
    unmatchedStores:ids.size?[]:data.stores.filter(item=>!bind(item)).map(item=>item.storeName)};
}
function mount({app,db}) {
  const file=process.env.DOUYIN_REVIEW_SNAPSHOT || (process.platform === 'win32' ? path.join(__dirname,'../data/douyin-review-display-snapshot.json') : '/opt/zhongkong-sync-bot/state/reviews/display-snapshot.json');
  app.get('/api/business-analytics/douyin-reviews',(req,res)=>{
    try {
      const user=require('./user-positions').enrich(db,db.queryOne('SELECT u.id,u.position_id,p.permissions_json FROM users u LEFT JOIN position_settings p ON p.id=u.position_id WHERE u.id=?',[req.user.id]));
      if (!require('./permissions').can(user?.permissions_json,'analysis.view')) return res.status(403).json({error:'无数据分析查看权限'});
      res.json(report(db,req.query,snapshot(file)));
    } catch(error){res.status(400).json({error:error.message});}
  });
  app.get('/api/business-analytics/douyin-review-media/:name',(req,res)=>{try{
    const user=require('./user-positions').enrich(db,db.queryOne('SELECT u.id,u.position_id,p.permissions_json FROM users u LEFT JOIN position_settings p ON p.id=u.position_id WHERE u.id=?',[req.user.id]));
    if(!require('./permissions').can(user?.permissions_json,'analysis.view'))return res.status(403).json({error:'无数据分析查看权限'});
    const name=req.params.name;if(!/^[a-f0-9]{64}\.(jpg|png|webp|gif)$/.test(name))return res.status(400).json({error:'图片标识无效'});
    let scope=req.accessStoreScope;
    if(scope===undefined)scope=require('./personnel-access').effective(db,user.id,'web','analysis.view');
    if(scope===undefined)scope=req.user.store_id?[Number(req.user.store_id)]:null;
    if(!mediaAllowed(db,snapshot(file),name,scope))return res.status(403).json({error:'无权查看此门店的评价图片'});
    const directory=process.env.DOUYIN_REVIEW_MEDIA_DIR||path.join(path.dirname(file),'media'),image=path.join(directory,name);
    if(!fs.existsSync(image))return res.status(404).json({error:'图片未缓存，请重新采集'});res.sendFile(image);
  }catch(error){res.status(400).json({error:error.message});}});
}
module.exports={mount,report,suffix,mediaAllowed};
