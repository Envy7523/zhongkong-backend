const {test}=require('node:test'),assert=require('node:assert/strict'),XLSX=require('xlsx'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const E=require('../lib/item-update-evidence');
const day='2026-10-22';
const headers=['城市','机构编码','营业日期','订单号','菜品编码','品项名称','销售方式','销售数量','销售金额(元)','优惠金额(元)','赠送数量','赠送金额(元)','品项收入(元)'];
function file(rows){const w=XLSX.utils.book_new();XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet([['品项销售明细'],headers,...rows]),'明细');return XLSX.write(w,{type:'buffer',bookType:'xlsx'});}
const bytes=file([['测试','MD001',day,'ORDER1','DISH1','测试菜','正常',1,20,2,0,0,18],['测试','MD001',day,'ORDER1','DISH1','测试菜','正常',2,40,4,0,0,36],['合计','','','','','','',3,60,6,0,0,54]]);
function fixture(){const source=E.parse(bytes,day),rows=source.rows.map(r=>({...r,store_id:1,batch_id:123}));const batch={id:123,source_type:'pos',platform:'收银机品项销售明细',date_from:day,date_to:day,row_count:2,file_name:'sample.xlsx'};return {source,rows,batch,db:{queryAll:()=>rows,queryOne:()=>batch},run:{import_batch_id:123,sha256_prefix:crypto.createHash('sha256').update(bytes).digest('hex').slice(0,12)}};}
test('原始两行按实际业务键合并为一条，并验证数量金额守恒',()=>{const f=fixture();assert.equal(f.source.sourceRows,2);assert.equal(f.source.rows.length,1);assert.equal(f.source.rows[0].income_amount,54);assert(E.evidence(f.db,day,f.run,[{id:1}],()=>f.source).ok);});
test('等条数的错金额、删行、错误门店和批次都不能通过',()=>{for(const mutate of [f=>f.rows[0].income_amount++,f=>f.rows.pop(),f=>f.rows[0].store_id=99,f=>f.rows[0].batch_id=124,f=>f.batch.row_count=3,f=>f.batch.platform='别的报表']){const f=fixture();mutate(f);assert.equal(E.evidence(f.db,day,f.run,[{id:1}],()=>f.source).ok,false);}});
test('仅有成功运行或业务记录、没有原文件证明仍为待核验',()=>{const f=fixture();const out=E.evidence(f.db,day,f.run,[{id:1}],()=>{throw Error('missing')});assert.equal(out.ok,false);assert.equal(out.unverified,true);});
test('文件身份与哈希校验，改动原始文件后不能沿用缓存通过',()=>{const f=fixture(),root=fs.mkdtempSync(path.join(os.tmpdir(),'item-health-'));process.env.SYNCBOT_ITEM_ARCHIVE_ROOT=root;fs.mkdirSync(path.join(root,day));const target=path.join(root,day,'sample.xlsx');fs.writeFileSync(target,bytes);try{assert.equal(E.loadSource(f.batch,day,f.run).sourceRows,2);assert.throws(()=>E.loadSource({...f.batch,file_name:'../sample.xlsx'},day,f.run),/identity/);assert.throws(()=>E.loadSource(f.batch,day,{sha256_prefix:'000000000000'}),/hash/);fs.writeFileSync(target,file([['测试','MD001',day,'ORDER2','DISH1','测试菜','正常',1,10,0,0,0,10]]));assert.throws(()=>E.loadSource(f.batch,day,f.run),/hash/);}finally{delete process.env.SYNCBOT_ITEM_ARCHIVE_ROOT;fs.rmSync(root,{recursive:true,force:true});}});
test('源文件日期越界和无法识别的空白来源不能判成功',()=>{assert.throws(()=>E.parse(bytes,'2026-10-21'),/scope/);const f=fixture();f.source=E.parse(file([]),day);assert.equal(E.evidence(f.db,day,f.run,[{id:1}],()=>f.source).ok,false);});
test('筹建测试记录必须有未来开业日期和该日唯一收银编码关联，金额仍逐项核对',()=>{
 const {DatabaseSync}=require('node:sqlite');
 for(const variant of ['valid','wrong_code','before_binding','not_preopening','wrong_amount']){
  const f=fixture(),raw=new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE stores(id INTEGER,store_name TEXT,status TEXT,opening_date TEXT);CREATE TABLE store_pos_code_bindings(id INTEGER,store_id INTEGER,pos_store_code TEXT,valid_from TEXT,valid_to TEXT)');
  raw.prepare('INSERT INTO stores VALUES(?,?,?,?)').run(99,'新店',variant==='not_preopening'?'正常营业':'筹建中','2026-10-23');
  raw.prepare('INSERT INTO store_pos_code_bindings VALUES(1,99,?,?,?)').run(variant==='wrong_code'?'OTHER':'MD001',variant==='before_binding'?'2026-10-23':'2026-10-22','');
  f.rows[0].store_id=99;if(variant==='wrong_amount')f.rows[0].income_amount++;
  const db={queryOne:(q,p=[])=>q.includes('business_import_batches')?f.batch:raw.prepare(q).get(...p),queryAll:(q,p=[])=>q.includes('pos_product_sale_details')?f.rows:raw.prepare(q).all(...p)};
  try{const r=E.evidence(db,day,f.run,[{id:1}],()=>f.source);assert.equal(r.ok,variant==='valid',variant);if(r.ok){assert.equal(r.expected,1);assert.deepEqual(r.preopening_store_ids,[99]);assert.equal(r.preopening_rows,1);}}finally{raw.close();}
 }
});
test('受限归档的派生证据可供应用复核，批次或源哈希变化仍拒绝',()=>{const f=fixture(),root=fs.mkdtempSync(path.join(os.tmpdir(),'item-proof-'));process.env.SYNCBOT_ITEM_PROOF_ROOT=root;try{E.saveProof(f.batch,day,bytes);assert.equal(E.loadSource(f.batch,day,f.run).sourceRows,2);assert.throws(()=>E.loadSource({...f.batch,file_name:'other.xlsx'},day,f.run),/identity/);assert.throws(()=>E.loadSource(f.batch,day,{sha256_prefix:'111111111111'}),/identity/);const p=path.join(root,'123.json'),j=JSON.parse(fs.readFileSync(p));j.source.rows[0].income_amount=null;fs.writeFileSync(p,JSON.stringify(j));assert.equal(E.evidence(f.db,day,f.run,[{id:1}]).ok,false);}finally{delete process.env.SYNCBOT_ITEM_PROOF_ROOT;fs.unlinkSync(path.join(root,'123.json'));fs.rmdirSync(root);}});
