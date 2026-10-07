'use strict';
const {isClosedStatus}=require('./store-lifecycle');
const FIRST='0001-01-01';
function date(value){const s=String(value||'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return '';const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s?s:'';}
function previousDay(value){const d=new Date(value+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);}
function initialize(db){
 db.run(`CREATE TABLE IF NOT EXISTS store_pos_code_bindings(id INTEGER PRIMARY KEY AUTOINCREMENT,store_id INTEGER NOT NULL,pos_store_code TEXT NOT NULL,valid_from TEXT NOT NULL,valid_to TEXT DEFAULT '',UNIQUE(store_id,pos_store_code,valid_from))`);
 db.run('CREATE INDEX IF NOT EXISTS idx_store_pos_bindings_code ON store_pos_code_bindings(pos_store_code,valid_from,valid_to)');
 db.run('DROP INDEX IF EXISTS idx_stores_pos_store_code');
 db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_active_pos_code ON stores(TRIM(pos_store_code)) WHERE TRIM(COALESCE(pos_store_code,''))<>'' AND status='正常营业'");
 for(const store of db.queryAll("SELECT * FROM stores WHERE TRIM(COALESCE(pos_store_code,''))<>''")){
  if(!db.queryOne('SELECT id FROM store_pos_code_bindings WHERE store_id=?',[store.id]))db.run('INSERT INTO store_pos_code_bindings(store_id,pos_store_code,valid_from,valid_to) VALUES(?,?,?,?)',[store.id,String(store.pos_store_code).trim(),FIRST,isClosedStatus(store.status)?date(store.closed_date):'']);
 }
}
function bindings(db,code){
 try{return db.queryAll('SELECT b.*,s.store_name,s.status FROM store_pos_code_bindings b JOIN stores s ON s.id=b.store_id WHERE b.pos_store_code=?',[code]);}
 catch(e){if(!/no such table/.test(e.message))throw e;return db.queryAll('SELECT * FROM stores WHERE pos_store_code=?',[code]).map(s=>({...s,store_id:s.id,valid_from:FIRST,valid_to:isClosedStatus(s.status)?date(s.closed_date):''}));}
}
function current(db,store){try{return db.queryOne('SELECT * FROM store_pos_code_bindings WHERE store_id=? AND pos_store_code=? ORDER BY valid_from DESC,id DESC LIMIT 1',[store.id,String(store.pos_store_code||'').trim()]);}catch(e){if(!/no such table/.test(e.message))throw e;return null;}}
function decorate(db,store){const b=current(db,store);return {...store,pos_code_start_date:b&&b.valid_from!==FIRST?b.valid_from:'',pos_code_end_date:b?.valid_to||''};}
function validate(db,store,{excludeIds=[]}={}){
 if(!['正常营业','筹建中','已闭店','闭店','迁址'].includes(store.status))throw Error('门店状态不正确');
 const code=String(store.pos_store_code||'').trim();if(!code)return;
 const other=db.queryAll('SELECT * FROM stores WHERE TRIM(pos_store_code)=? AND id<>?',[code,Number(store.id)||0]).filter(s=>!excludeIds.includes(Number(s.id)));
 if(store.status==='正常营业'){const occupied=other.find(s=>s.status==='正常营业');if(occupied)throw Error(`收银机构编码 ${code} 已被营业中的「${occupied.store_name}」使用`);}
 const existing=store.id?current(db,store):null;
 const raw=store.pos_code_start_date||existing?.valid_from||store.opening_date||'';
 if(raw && !date(raw))throw Error('收银编码启用日期不正确');
 const start=date(raw)||FIRST,end=isClosedStatus(store.status)?date(store.closed_date):'';
 if(end&&start>end)throw Error('编码启用日期不能晚于最后营业日');
 const history=bindings(db,code).filter(b=>Number(b.store_id)!==Number(store.id)&&!excludeIds.includes(Number(b.store_id)));
 if(history.length&&start===FIRST)throw Error('沿用已有收银编码时，必须填写编码启用日期');
 for(const b of history)if(start<=(b.valid_to||'9999-12-31')&&(end||'9999-12-31')>=b.valid_from)throw Error(`收银编码使用日期与「${b.store_name}」重叠，请核对旧店最后营业日和新店启用日期`);
}
function sync(db,storeId,{start='',forceNew=false}={}){
 const store=db.queryOne('SELECT * FROM stores WHERE id=?',[storeId]);const code=String(store.pos_store_code||'').trim();
 const open=db.queryAll("SELECT * FROM store_pos_code_bindings WHERE store_id=? AND valid_to='' ORDER BY valid_from DESC,id DESC",[storeId]);
 const same=open.find(b=>b.pos_store_code===code);
 if(same&&!forceNew){if(start&&start!==same.valid_from)throw Error('已有编码启用日期不能直接改写；请保留历史关联');return;}
 if(open.length&&!date(start))throw Error('更换或重启收银编码时必须填写启用日期');
 for(const b of open){if(start<=b.valid_from)throw Error('新编码启用日期必须晚于原编码启用日期');db.run('UPDATE store_pos_code_bindings SET valid_to=? WHERE id=?',[previousDay(start),b.id]);}
 if(code)db.run('INSERT INTO store_pos_code_bindings(store_id,pos_store_code,valid_from,valid_to) VALUES(?,?,?,?)',[storeId,code,date(start)||date(store.opening_date)||FIRST,isClosedStatus(store.status)?date(store.closed_date):'']);
}
function close(db,id,lastDate){if(!date(lastDate))throw Error('最后营业日不正确');if(db.queryOne('SELECT id FROM store_pos_code_bindings WHERE store_id=? AND valid_from>?',[id,lastDate]))throw Error('最后营业日不能早于编码启用日期');db.run("UPDATE store_pos_code_bindings SET valid_to=? WHERE store_id=? AND valid_to=''",[lastDate,id]);}
function resolveCode(db,code,businessDate){code=String(code||'').trim();if(!code)return null;const rows=bindings(db,code);if(!rows.length)return null;const day=date(businessDate);if(!day)throw Error('按收银编码识别门店必须提供营业日期');const hits=rows.filter(b=>b.valid_from<=day&&(!b.valid_to||b.valid_to>=day));const ids=[...new Set(hits.map(b=>Number(b.store_id)))];if(ids.length!==1)throw Error(ids.length?'收银编码日期归属不明确，已阻止串店导入':'营业日期不在收银编码使用期间，请检查门店关联');return {id:ids[0],store_name:hits[0].store_name};}
function resolveNamed(db,store,businessDate){if(!store)return null;const full=db.queryOne('SELECT * FROM stores WHERE id=?',[store.id]);return full?.pos_store_code?resolveCode(db,full.pos_store_code,businessDate):store;}
function nameMap(db,businessDate,normalize){
 const groups=new Map();for(const store of db.queryAll('SELECT * FROM stores')){const key=normalize(store.store_name);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(store);}
 const result=new Map();for(const [key,rows] of groups){let hit=rows[0];if(rows.length>1){const active=rows.filter(s=>(!date(s.opening_date)||s.opening_date<=businessDate)&&(!date(s.closed_date)||s.closed_date>=businessDate));if(active.length!==1)continue;hit=active[0];}try{result.set(key,resolveNamed(db,hit,businessDate));}catch(e){if(!/营业日期不在|收银编码日期归属/.test(e.message))throw e;}}return result;
}
function codesForDate(db,businessDate){return db.queryAll(`SELECT s.id,s.store_name,b.pos_store_code FROM store_pos_code_bindings b JOIN stores s ON s.id=b.store_id WHERE b.valid_from<=? AND (b.valid_to='' OR b.valid_to>=?) ORDER BY s.id`,[businessDate,businessDate]);}
module.exports={initialize,validate,sync,close,current,decorate,resolveCode,resolveNamed,codesForDate,nameMap,date,FIRST};
