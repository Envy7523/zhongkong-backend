const db=require('../lib/db');
db.init().then(()=>{
  const c=db.queryOne("SELECT COUNT(*) as cnt FROM stores WHERE lat IS NOT NULL AND lat!='' AND lat!=0");
  console.log('Has lat:',c.cnt);
  const all=db.queryAll("SELECT id,lat,lng FROM stores ORDER BY id");
  all.forEach(r=>console.log(r.id,typeof r.lat, r.lat, typeof r.lng, r.lng));
  db.close();
});
