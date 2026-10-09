const fs = require('fs');
const path = require('path');
// Exact store suffixes only: do not fuzzy-match or attach unregistered stores.
const aliases = { '合正方洲店': '方洲店', '麦地总店': '麦地店', '溪尾店': '普宁溪尾店' };
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
function report(db, query, data) {
  const stores = db.queryAll("SELECT id,store_name FROM stores");
  const bySuffix = new Map();
  for (const store of stores) { const key=suffix(store.store_name); bySuffix.set(key, [...(bySuffix.get(key)||[]), store]); }
  const bind = name => { const hits=bySuffix.get(suffix(name)) || []; return hits.length===1 ? hits[0] : null; };
  const rawIds=String(query.store_ids || query.store_id || '').split(',').filter(Boolean);
  if (rawIds.some(id=>!/^\d+$/.test(id)||Number(id)<=0)) throw Error('门店筛选无效');
  const ids=new Set(rawIds.map(Number));
  const selected=store=>store && (!ids.size || ids.has(store.id));
  const mode=query.mode==='full'?'full':'recent7';
  const dataset=data.datasets[mode];
  const metrics=data.stores.flatMap(item=>{const store=bind(item.storeName);return selected(store)?[{...item,storeId:store.id,storeName:store.store_name,platformStoreName:item.storeName}]:[];});
  const reviews=(dataset?.reviews || []).flatMap(item=>{const store=bind(item.storeName);return selected(store)?[{...item,storeId:store.id,storeName:store.store_name}]:[];});
  const rating=String(query.rating || 'all');
  const ratingLabel=String(query.rating_label || '').trim();
  const textOnly=query.text_only==='1' || query.text_only===true;
  const ratingLabels=[...new Set(reviews.map(item=>item.ratingLabel).filter(Boolean))].sort();
  const filtered=reviews.filter(item=>
    (!textOnly || String(item.text || '').trim().length>0) &&
    (!ratingLabel || item.ratingLabel===ratingLabel) &&
    (rating==='all'||(rating==='negative'?['一般','不满意','很差','较差','非常差','差评','中评'].includes(item.ratingLabel):['超赞','推荐','满意','好评'].includes(item.ratingLabel)))
  );
  const pageSize=20, pages=Math.max(1,Math.ceil(filtered.length/pageSize));
  const page=Math.min(pages,Math.max(1,parseInt(query.page,10)||1));
  return {updatedAt:data.updatedAt||null,mode,available:!!dataset,collectedAt:dataset?.collectedAt||null,dateRange:dataset?.metadata?.dateRange||null,
    stores:metrics,ratingLabels,total:filtered.length,page,pageSize,reviews:filtered.slice((page-1)*pageSize,page*pageSize),
    unmatchedStores:ids.size?[]:data.stores.filter(item=>!bind(item.storeName)).map(item=>item.storeName)};
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
}
module.exports={mount,report,suffix};
