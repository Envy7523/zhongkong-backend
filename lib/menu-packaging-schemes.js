'use strict';
const XLSX = require('xlsx'), crypto = require('crypto');
const purchases = require('./menu-packaging-purchases');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const numeric = (v, label, zero = false) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) || Number(v) < 0 || (!zero && !Number(v)) || Number(v) > 1e8) fail(`${label}须为有效${zero ? '非负' : '正'}数`);
  return Number(v);
};
function initialize(db) {
  db.run(`CREATE TABLE IF NOT EXISTS menu_packaging_schemes(id TEXT PRIMARY KEY,code TEXT,name TEXT NOT NULL,payload_json TEXT NOT NULL,revision INTEGER DEFAULT 1,updated_at TEXT DEFAULT(datetime('now','localtime')))`);
  db.run(`CREATE TABLE IF NOT EXISTS menu_packaging_scheme_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,scheme_id TEXT,revision INTEGER,payload_json TEXT,created_at TEXT DEFAULT(datetime('now','localtime')))`);
  db.run(`CREATE TABLE IF NOT EXISTS menu_packaging_imports(hash TEXT PRIMARY KEY,filename TEXT,metadata_json TEXT,created_at TEXT DEFAULT(datetime('now','localtime')))`);
}
function transaction(db, fn) { db.run('BEGIN'); let r; try { r = fn(); db.run('COMMIT'); } catch(e) { db.run('ROLLBACK'); throw e; } db.save(); return r; }
function list(db, materials) {
  materials ||= db.queryAll('SELECT * FROM menu_packaging_materials');
  return db.queryAll('SELECT * FROM menu_packaging_schemes ORDER BY code,id').map(r => {
    const s = { ...JSON.parse(r.payload_json), id: r.id, code: r.code, name: r.name, revision: r.revision };
    const complete = s.lines.every(l => materials.some(m => m.id === l.material_id));
    return { ...s, complete, unit_cost: complete ? s.lines.reduce((sum,l) => sum + l.quantity * materials.find(m => m.id === l.material_id).unit_cost, 0) : null };
  });
}
function save(db, body) {
  const current = body.id ? db.queryOne('SELECT * FROM menu_packaging_schemes WHERE id=?', [body.id]) : null;
  if (body.id && !current) fail('打包方案不存在',404);
  if (current && Number(body.revision) !== current.revision) fail('打包方案已更新，请刷新后修改',409);
  const name = String(body.name || '').trim();
  if (!name || name.length > 80) fail('请填写打包方案名称');
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 40) fail('请填写1—40项包材');
  const seen = new Set();
  const lines = body.lines.map(l => {
    if (!db.queryOne('SELECT id FROM menu_packaging_materials WHERE id=?',[l.material_id])) fail('包材不存在');
    if (seen.has(l.material_id)) fail('请合并重复包材'); seen.add(l.material_id);
    if (!['dish','order'].includes(l.scope)) fail('请指定每份或每单用量');
    return { material_id:l.material_id, quantity:numeric(l.quantity,'包材用量'), scope:l.scope, usage:'packed' };
  });
  const value = { id:current?.id || crypto.randomUUID(), name, code:current?.code || '', lines, note:String(body.note || '').slice(0,1000) };
  return transaction(db, () => {
    const revision = (current?.revision || 0) + 1;
    if (current) db.run("UPDATE menu_packaging_schemes SET name=?,payload_json=?,revision=?,updated_at=datetime('now','localtime') WHERE id=?",[name,JSON.stringify(value),revision,value.id]);
    else db.run('INSERT INTO menu_packaging_schemes(id,code,name,payload_json,revision) VALUES(?,?,?,?,?)',[value.id,value.code,name,JSON.stringify(value),revision]);
    db.run('INSERT INTO menu_packaging_scheme_versions(scheme_id,revision,payload_json) VALUES(?,?,?)',[value.id,revision,JSON.stringify(value)]);
    return list(db).find(s => s.id === value.id);
  });
}
function parse(buffer, filename) {
  const w = XLSX.read(buffer,{type:'buffer',cellFormula:true});
  for (const name of ['包材单价','打包盒搭配','菜品包装对照','包材方案汇总']) if (!w.Sheets[name]) fail(`缺少“${name}”子表`);
  const at = (name,c,r) => w.Sheets[name][c+r]?.v;
  const materials = [], schemes = [], mappings = [], checks = [];
  for(let r=10;r<=21;r++) {
    const code=at('包材单价','A',r), price=numeric(at('包材单价','I',r),`${code}单价`,true);
    const base=numeric(at('包材单价','F',r),`${code}来货价`,true), count=numeric(at('包材单价','G',r),`${code}箱规`);
    if(Math.abs(base/count-price)>1e-8) fail(`${code}采购价与箱规折算不一致`);
    const purchase = purchases.prepare({purchase_unit:at('包材单价','C',r),units_per_purchase:count,purchase_price:base});
    materials.push({id:'package-'+code,code,name:at('包材单价','B',r),unit:at('包材单价','H',r),...purchase,unit_cost:price,note:`${at('包材单价','J',r)}；${at('包材单价','K',r)}；包材单价!I${r}`});
  }
  const codeColumns = { E:['P01'],F:['P02'],G:['P03'],H:['P04'],I:['P05','P06'],J:['P07'],K:['P08'],L:['P09'],M:['P10'],N:['P11'],O:['P12'] };
  for(let r=26;r<=43;r++) {
    const code=at('包材方案汇总','A',r), lines=[];
    for(const [col,codes] of Object.entries(codeColumns)) {
      const q=numeric(at('包材方案汇总',col,r),`${code}用量`,true);
      if(q) for(const material of codes) lines.push({material_id:'package-'+material,quantity:q,scope:'dish',usage:'packed'});
    }
    const cost=lines.reduce((sum,l)=>sum+l.quantity*materials.find(m=>m.id===l.material_id).unit_cost,0);
    const sourceCost=numeric(at('包材方案汇总','D',r),`${code}方案合计`,true);
    if(Math.abs(cost-sourceCost)>1e-8) fail(`${code}方案分项与合计不一致`);
    schemes.push({id:'packing-'+code,code,name:at('包材方案汇总','B',r),lines,note:`包材方案汇总!A${r}；按表中每份数量导入，背心袋也按每份计；可改为每单共享`,source_cost:sourceCost});
  }
  const sheet=w.Sheets['打包盒搭配'], end=XLSX.utils.decode_range(sheet['!ref']).e.r+1;
  for(let r=8;r<=end;r++) {
    const code=at('打包盒搭配','A',r); if(!/^B\d/.test(code || '')) continue;
    const scheme=schemes.find(s=>s.code===at('打包盒搭配','U',r)); if(!scheme) fail(`${code}未选择有效打包方案`);
    const sourceCost=numeric(at('打包盒搭配','Q',r),`${code}包装成本`,true);
    if(Math.abs(sourceCost-scheme.source_cost)>1e-8) fail(`${code}搭配合计与方案不一致`);
    mappings.push({code,name:at('打包盒搭配','C',r),category:at('打包盒搭配','B',r),variant:at('打包盒搭配','D',r)||'',scheme_id:scheme.id,source:`打包盒搭配!A${r}`,source_cost:sourceCost});
  }
  const comparison=w.Sheets['菜品包装对照'];
  for(let r=7;r<=XLSX.utils.decode_range(comparison['!ref']).e.r+1;r++) {
    if(typeof at('菜品包装对照','A',r)!=='number')continue;
    const code=at('菜品包装对照','E',r), mapping=mappings.find(m=>m.code===code);
    if(!mapping)fail(`菜品包装对照!E${r}编号不存在`);
    const packaging=numeric(at('菜品包装对照','H',r),'对照包装成本',true), food=numeric(at('菜品包装对照','F',r),'对照食材成本',true), total=numeric(at('菜品包装对照','I',r),'对照含包成本',true);
    if(Math.abs(packaging-mapping.source_cost)>1e-8 || Math.abs(food+packaging-total)>1e-8)fail(`菜品包装对照第${r}行成本不一致`);
    checks.push({name:at('菜品包装对照','C',r),origin:at('菜品包装对照','D',r),code,food_cost:food,packaging_cost:packaging,total_cost:total,source:`菜品包装对照!A${r}`});
  }
  return {hash:crypto.createHash('sha256').update(buffer).digest('hex'),filename:String(filename||'包材.xlsx').split(/[\\/]/).pop(),materials,schemes,mappings,checks};
}
function importWorkbook(db, buffer, filename) {
  const data=parse(buffer,filename);
  if(db.queryOne('SELECT hash FROM menu_packaging_imports WHERE hash=?',[data.hash]))return{existing:true,materials:data.materials.length,schemes:data.schemes.length,mappings:data.mappings.length,checks:data.checks.length};
  // A new import must not silently overwrite standards already maintained here.
  for(const p of data.materials) if(db.queryOne('SELECT id FROM menu_packaging_materials WHERE id=?',[p.id]))fail('包材标准已存在，请在包材档案核对维护；新版本导入不能覆盖已有价格',409);
  for(const s of data.schemes) if(db.queryOne('SELECT id FROM menu_packaging_schemes WHERE id=?',[s.id]))fail('方案标准已存在，请在打包方案中核对维护',409);
  return transaction(db,()=>{
    for(const p of data.materials){db.run('INSERT INTO menu_packaging_materials(id,name,unit,unit_cost,note) VALUES(?,?,?,?,?)',[p.id,p.name,p.unit,p.unit_cost,p.note]);purchases.save(db,p.id,p);db.run('INSERT INTO menu_packaging_versions(material_id,payload_json) VALUES(?,?)',[p.id,JSON.stringify({...p,revision:1})]);}
    for(const s of data.schemes){db.run('INSERT INTO menu_packaging_schemes(id,code,name,payload_json) VALUES(?,?,?,?)',[s.id,s.code,s.name,JSON.stringify(s)]);db.run('INSERT INTO menu_packaging_scheme_versions(scheme_id,revision,payload_json) VALUES(?,?,?)',[s.id,1,JSON.stringify(s)]);}
    db.run('INSERT INTO menu_packaging_imports(hash,filename,metadata_json) VALUES(?,?,?)',[data.hash,data.filename,JSON.stringify(data)]);
    return{existing:false,materials:data.materials.length,schemes:data.schemes.length,mappings:data.mappings.length,checks:data.checks.length};
  });
}
const normalize = name => String(name || '').replace(/（/g,'(').replace(/）/g,')').replace(/^限量[!！]?/,'').replace(/\s+/g,'');
function match(item,mappings) {
  if(item.item_type==='combo'||/员工/.test(item.category||''))return null;
  let name=normalize(item.name), variant='';
  const aliases={'金牌烧鸭饭':'招牌烧鸭饭','金牌烧鸭腿饭':'招牌烧鸭腿饭','黄金鹅腩饭':'黄金鹅腩饭','太公烧鹅三宝饭':'太公三宝饭','超爽柠檬茶':'【新客专享】超爽柠檬茶','咸鸭蛋':'【新客专享】咸鸭蛋','溏心蛋':'溏心蛋(不含米饭)','蜜汁鸡翅':'蜜汁鸡翅(不含米饭)'};
  name=aliases[name]||name;
  name=({'招牌烧鹅(约100克)':'招牌烧鹅100g(不含米饭)','招牌烧鸭(约100g)':'招牌烧鸭100g(不含米饭)','蜜汁叉烧(约60g)':'蜜汁叉烧60g(不含米饭)','咸香靓鸡(约80g)':'咸香靓鸡80g(不含米饭)','脆皮烧肉(约60g)':'脆皮烧肉60g(不含米饭)','招牌烧鹅腿(单)':'招牌烧鹅腿(不含米饭)','金牌烧鸭腿(单)':'招牌烧鸭腿(不含米饭)','咸香靓鸡腿(单)':'咸香靓鸡腿(不含米饭)'})[name]||name;
  if(['太公烧鹅','金牌烧鸭','咸香靓鸡'].includes(name)) {name=({'太公烧鹅':'招牌太公烧鹅(不含米饭)','金牌烧鸭':'招牌现烤烧鸭(不含米饭)','咸香靓鸡':'咸香靓鸡(不含米饭)'})[name];variant=item.spec;}
  if(name==='澳门烧肉(约250g)')name='澳门烧肉约250g(不含米饭)';
  if(name==='蜜汁叉烧(约250g)')name='蜜汁叉烧约250g(不含米饭)';
  // Size names such as 大盒 are not evidence of grams: leave them for review.
  if(/500g|500克|1斤|一斤/.test(name+item.spec)){if(/烧肉/.test(name))name='脆皮烧肉500g';else if(/叉烧/.test(name))name='蜜汁叉烧500g';}
  const candidates=mappings.filter(m=>m.category!=='旧搭配参考' && normalize(m.name)===name && (!variant||m.variant===variant));
  return candidates.length===1?candidates[0]:null;
}
function metadata(db){const row=db.queryOne('SELECT metadata_json FROM menu_packaging_imports ORDER BY rowid DESC LIMIT 1');return row?JSON.parse(row.metadata_json):null;}
module.exports={initialize,list,save,parse,importWorkbook,match,metadata};
