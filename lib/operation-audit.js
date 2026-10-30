'use strict';
const ledger=require('./business-ledger');
const TABLES={users:'users',positions:'position_settings',stores:'stores',employees:'employees','payroll-sheets':'payroll_sheets'};
function middleware(db) {
  return (req,res,next)=>{
    if(!/^\/api\//.test(req.path)||!['POST','PUT','PATCH','DELETE'].includes(req.method)||/^\/api\/(?:business-ledger|mp\/business-ledger|internal|auth\/login)(?:\/|$)/.test(req.path))return next();
    const m=req.path.match(/^\/api\/(?:db\/)?(users|positions|stores|employees|payroll-sheets)\/(\d+)(?:\/|$)/),table=m&&TABLES[m[1]];
    let before=null;try{if(table)before=db.queryOne(`SELECT * FROM ${table} WHERE id=?`,[Number(m[2])]);}catch{}
    const send=res.json.bind(res);let recorded=false;
    res.json=body=>{
      const user=req.mpUser||req.user;
      if(!recorded&&user?.id&&res.statusCode<400&&!body?.error){
        recorded=true;
        try {
          const actor=ledger.actorFor(db,user,req.mpUser?'mini':'web');
          const after=table?db.queryOne(`SELECT * FROM ${table} WHERE id=?`,[Number(m[2])]):null;
          const changed=table?[...new Set([...Object.keys(before||{}),...Object.keys(after||{})])].filter(k=>JSON.stringify(before?.[k])!==JSON.stringify(after?.[k])):Object.keys(req.body||{});
          ledger.transaction(db,()=>ledger.audit(db,actor,req.method+' '+req.path,table?`${m[1]}:${m[2]}`:req.path,before,{record:after,changed_fields:changed,submitted:req.body}));
        }catch(e){console.error('[operation-audit] 写入失败，原操作可能已完成：',e.message);res.setHeader('X-Operation-Audit','failed');}
      }
      return send(body);
    };
    next();
  };
}
function mount(app,db) {
  app.get('/api/operation-audit',(req,res)=>{
    try{
      const actor=ledger.actorFor(db,req.user);if(!actor.admin)return res.status(403).json({error:'仅管理员可查看全站操作日志'});
      const conditions=[],args=[];
      for(const [key,column] of [['actor_id','actor_id'],['action','action'],['resource','resource']])if(req.query[key]){conditions.push(column+(key==='actor_id'?'=?':' LIKE ?'));args.push(key==='actor_id'?Number(req.query[key]):'%'+String(req.query[key]).slice(0,100)+'%');}
      for(const [key,op] of [['from','>='],['to','<=']])if(req.query[key]){if(!/^\d{4}-\d{2}-\d{2}$/.test(req.query[key]))throw new Error('日期格式错误');conditions.push('created_at'+op+'?');args.push(new Date(req.query[key]+(key==='to'?'T23:59:59.999+08:00':'T00:00:00.000+08:00')).toISOString());}
      const where=conditions.length?' WHERE '+conditions.join(' AND '):'',page=Math.max(1,Math.floor(Number(req.query.page)||1));
      res.json({ok:true,page,total:db.queryOne('SELECT COUNT(*) n FROM operation_audit'+where,args).n,items:db.queryAll('SELECT * FROM operation_audit'+where+' ORDER BY id DESC LIMIT 50 OFFSET ?',[...args,(page-1)*50])});
    }catch(e){res.status(e.status||400).json({error:e.message});}
  });
}
module.exports={middleware,mount};
