'use strict';
// Quantity ledger only. Market prices and dish sales never change these balances.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const PURPOSES = { business: '营业用料', staff_meal: '员工餐用料' };
const SOURCES = { lcx: { name: '绿春翔', purpose: 'business' }, lcx_staff_meal: { name: '绿春翔员工餐', purpose: 'staff_meal' } };
const TYPES = { opening:'期初盘点', receipt:'实收入库', closing:'每日收档', transfer:'直接转用', borrow:'借货', repayment:'归还', loss:'报损', purchase_return:'退货', adjustment:'盘点更正' };
const fail = (message, status=400) => { throw Object.assign(new Error(message), {status}); };
const stamp = () => new Date().toISOString();
function qty(value, allowZero=true) {
  if (!['string','number'].includes(typeof value) || !/^\d+(?:\.\d{1,3})?$/.test(String(value))) fail('数量须为非负数，最多三位小数');
  const n=Math.round(Number(value)*1000);
  if (!Number.isSafeInteger(n)||n>1e12||(!allowZero&&n===0)) fail('数量超出允许范围');
  return n;
}
const number = n => Number(n)/1000;
const writeAction = kind => kind==='closing'||kind==='loss'?'close':['transfer','borrow','repayment'].includes(kind)?'transfer':['opening','adjustment'].includes(kind)?'confirm':'receive';
function date(value) { const d=new Date(String(value)+'T00:00:00Z');if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value) fail('营业日期无效');return value; }
function text(value, max=300) { if(typeof value!=='string'||!value.trim()||value.length>max) fail('请填写有效的内容');return value.trim(); }
function purpose(value) { if(!Object.hasOwn(PURPOSES,value))fail('请选择有效库存用途');return value; }
function positiveId(value) { if(typeof value==='boolean'||!Number.isSafeInteger(Number(value))||Number(value)<=0)fail('编号无效');return Number(value); }
function open(filename) {
  if(!filename||filename===':memory:') { if(filename!==':memory:')fail('库存数据库路径未配置'); }
  else fs.mkdirSync(path.dirname(path.resolve(filename)),{recursive:true});
  const {DatabaseSync}=require('node:sqlite');
  const sql=new DatabaseSync(filename);sql.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS inv_items(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,unit TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS inv_documents(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,store_id INTEGER NOT NULL,purpose TEXT NOT NULL,business_date TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,creator_id INTEGER NOT NULL,creator_name TEXT NOT NULL,payload_json TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,created_at TEXT NOT NULL,posted_at TEXT,posted_by TEXT);
    CREATE INDEX IF NOT EXISTS inv_docs_scope ON inv_documents(store_id,purpose,business_date,id);
    CREATE TABLE IF NOT EXISTS inv_balances(store_id INTEGER NOT NULL,purpose TEXT NOT NULL,item_id TEXT NOT NULL REFERENCES inv_items(id),quantity INTEGER NOT NULL CHECK(quantity>=0),version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(store_id,purpose,item_id));
    CREATE TABLE IF NOT EXISTS inv_movements(id INTEGER PRIMARY KEY,document_id INTEGER NOT NULL REFERENCES inv_documents(id),store_id INTEGER NOT NULL,purpose TEXT NOT NULL,item_id TEXT NOT NULL REFERENCES inv_items(id),delta INTEGER NOT NULL,balance_after INTEGER NOT NULL,category TEXT NOT NULL,actor_id INTEGER NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS inv_moves_scope ON inv_movements(store_id,purpose,item_id,id);
    CREATE TABLE IF NOT EXISTS inv_closures(store_id INTEGER NOT NULL,purpose TEXT NOT NULL,business_date TEXT NOT NULL,document_id INTEGER NOT NULL REFERENCES inv_documents(id),PRIMARY KEY(store_id,purpose,business_date));
    CREATE TABLE IF NOT EXISTS inv_receipts(source_key TEXT NOT NULL,store_id INTEGER NOT NULL,order_ref TEXT NOT NULL,document_id INTEGER NOT NULL REFERENCES inv_documents(id),PRIMARY KEY(source_key,store_id,order_ref));
    CREATE TABLE IF NOT EXISTS inv_loans(document_id INTEGER PRIMARY KEY REFERENCES inv_documents(id),store_id INTEGER NOT NULL,from_purpose TEXT NOT NULL,to_purpose TEXT NOT NULL,item_id TEXT NOT NULL REFERENCES inv_items(id),lent INTEGER NOT NULL,returned INTEGER NOT NULL DEFAULT 0,waived INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS inv_events(id INTEGER PRIMARY KEY,actor_id INTEGER NOT NULL,actor_name TEXT NOT NULL,action TEXT NOT NULL,document_id INTEGER,before_json TEXT,after_json TEXT,created_at TEXT NOT NULL);
  `);
  require('./store-inventory-catalog').initialize(sql);
  return sql;
}
function create({sql,authorize=(a)=>a.admin===true,storeExists=()=>false}) {
  const all=(q,p=[])=>sql.prepare(q).all(...p), one=(q,p=[])=>sql.prepare(q).get(...p)||null, run=(q,p=[])=>sql.prepare(q).run(...p);
  function transaction(fn){sql.exec('BEGIN IMMEDIATE');try{const result=fn();sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}
  function check(actor,action,storeId,p) { if(!actor?.id)fail('请先登录',401);if(p)purpose(p);if(!authorize(actor,'inventory.'+action,storeId,p))fail('没有此门店、用途或操作权限',403);if(storeId&&!storeExists(storeId))fail('门店不存在',404); }
  function event(a,action,id,before,after){run('INSERT INTO inv_events(actor_id,actor_name,action,document_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)',[a.id,a.display_name||a.username||'操作人员',action,id,before?JSON.stringify(before):null,after?JSON.stringify(after):null,stamp()]);}
  function item(id){const row=one('SELECT * FROM inv_items WHERE id=?',[id]);if(!row)fail('物料不存在',404);return row;}
  function balance(store,p,id){return one('SELECT * FROM inv_balances WHERE store_id=? AND purpose=? AND item_id=?',[store,p,id]);}
  function can(a,action,s,p){try{check(a,action,s,p);return true;}catch{return false;}}
  function closingCoverage(store,p,lines){const expected=all('SELECT b.item_id FROM inv_balances b JOIN inv_items i ON i.id=b.item_id WHERE b.store_id=? AND b.purpose=? AND i.active=1',[store,p]).map(x=>x.item_id);if(!Array.isArray(lines)||expected.length!==lines.length||expected.some(id=>!lines.some(l=>l.item_id===id)))fail('收档须包含该用途全部已启用建账物料，未耗用请填0，未盘可留空');}
  const catalog=require('./store-inventory-catalog').create({sql,check,event,transaction});
  function items(a,{includeSuppliers=false}={}){check(a,'view');return all('SELECT * FROM inv_items ORDER BY code').map(r=>{const row={...r,active:!!r.active};return includeSuppliers?catalog.enrich(row):row;});}
  function saveItem(a,b){
    check(a,'configure');const code=text(b.code,50),name=text(b.name,100),unit=text(b.unit,8);
    if(!require('./store-inventory-catalog').UNITS.includes(unit))fail('请选择支持的基础单位');catalog.validateIds(b.supplier_ids);
    return transaction(()=>{
      let id;
      if(b.id){
        const old=item(b.id);if(Number(b.revision)!==old.revision)fail('物料已更新，请刷新',409);
        if(b.active===false&&(one('SELECT 1 FROM inv_balances WHERE item_id=? AND quantity>0 LIMIT 1',[old.id])||one('SELECT 1 FROM inv_loans WHERE item_id=? AND lent>returned+waived LIMIT 1',[old.id])))fail('有剩余库存或待还借货的物料不能停用');
        if(unit!==old.unit&&one('SELECT 1 FROM inv_balances WHERE item_id=? LIMIT 1',[old.id]))fail('已有库存的基础单位不可直接修改');
        id=old.id;run('UPDATE inv_items SET code=?,name=?,unit=?,active=?,revision=revision+1 WHERE id=?',[code,name,unit,b.active===false?0:1,id]);event(a,'item.update',null,old,item(id));
      }else{
        if(one('SELECT id FROM inv_items WHERE code=?',[code]))fail('物料编码已存在',409);
        id=crypto.randomUUID();run('INSERT INTO inv_items(id,code,name,unit) VALUES(?,?,?,?)',[id,code,name,unit]);event(a,'item.create',null,null,item(id));
      }
      catalog.assign(a,id,b.supplier_ids);return catalog.enrich(item(id));
    });
  }
  function stock(a,store,p){store=positiveId(store);check(a,'view',store,p);return all('SELECT b.*,i.code,i.name,i.unit,i.active FROM inv_balances b JOIN inv_items i ON i.id=b.item_id WHERE b.store_id=? AND b.purpose=? ORDER BY i.code',[store,p]).map(r=>({...r,quantity:number(r.quantity),last_count:countFor(store,p,r.item_id)}));}
  function countFor(store,p,id){const r=one(`SELECT m.balance_after,d.business_date,d.posted_at FROM inv_movements m JOIN inv_documents d ON d.id=m.document_id WHERE m.store_id=? AND m.purpose=? AND m.item_id=? AND m.category IN ('opening','count_adjustment') ORDER BY m.id DESC LIMIT 1`,[store,p,id]);return r?{quantity:number(r.balance_after),date:r.business_date,confirmed_at:r.posted_at}:null;}
  function rawDoc(id){const r=one('SELECT * FROM inv_documents WHERE id=?',[positiveId(id)]);if(!r)fail('单据不存在',404);return r;}
  function payload(r){return JSON.parse(r.payload_json);}
  function countChecks(r){if(!['closing','adjustment'].includes(r.kind))return [];return payload(r).lines.map(l=>{if(r.status==='posted'&&l.confirmed_check)return {...l.confirmed_check,item_id:l.item_id,name:l.name,unit:l.unit,stale:false};const b=balance(r.store_id,r.purpose,l.item_id),before=b?.quantity??0,expected=before-(r.kind==='closing'?qty(l.consumed)+qty(l.loss):0);return {item_id:l.item_id,name:l.name,unit:l.unit,before:number(before),expected:number(expected),counted:l.counted,difference:l.counted===null?null:number(qty(l.counted)-expected),stale:!b||b.version!==l.balance_version};});}
  function docCheck(a,action,r){check(a,action,r.store_id,r.purpose);const b=payload(r);if(['transfer','borrow'].includes(r.kind))check(a,action,r.store_id,b.to_purpose);if(r.kind==='repayment'){const l=loan(b.loan_id);check(a,action,l.store_id,l.from_purpose);}}
  function present(r){const b=payload(r);return {...r,payload_json:undefined,request_hash:undefined,request_key:undefined,payload:b,kind_label:TYPES[r.kind],purpose_label:PURPOSES[r.purpose]};}
  function detail(a,id){const r=rawDoc(id);docCheck(a,'view',r);return {...present(r),checks:countChecks(r),movements:all('SELECT m.*,i.name,i.unit FROM inv_movements m JOIN inv_items i ON i.id=m.item_id WHERE document_id=? ORDER BY m.id',[r.id]).map(m=>({...m,delta:number(m.delta),balance_after:number(m.balance_after)})),events:all('SELECT action,actor_name,created_at FROM inv_events WHERE document_id=? ORDER BY id',[r.id])};}
  function list(a,q){const store=positiveId(q.store_id),p=purpose(q.purpose);check(a,'view',store,p);const page=Math.max(1,Math.min(100000,Number(q.page)||1));const rows=all('SELECT * FROM inv_documents WHERE store_id=? AND purpose=? ORDER BY id DESC LIMIT 50 OFFSET ?',[store,p,(page-1)*50]).filter(r=>{try{docCheck(a,'view',r);return true;}catch{return false;}});return {items:rows.map(present),page,total:one('SELECT COUNT(*) AS n FROM inv_documents WHERE store_id=? AND purpose=?',[store,p]).n};}
  function loan(id){const r=one('SELECT * FROM inv_loans WHERE document_id=?',[positiveId(id)]);if(!r)fail('借货记录不存在',404);return r;}
  function loans(a,store,p){store=positiveId(store);check(a,'view',store,p);return all('SELECT l.*,i.name,i.unit FROM inv_loans l JOIN inv_items i ON i.id=l.item_id WHERE l.store_id=? AND (l.from_purpose=? OR l.to_purpose=?) ORDER BY l.document_id DESC LIMIT 200',[store,p,p]).filter(l=>can(a,'view',store,l.from_purpose)&&can(a,'view',store,l.to_purpose)).map(l=>({...l,lent:number(l.lent),returned:number(l.returned),waived:number(l.waived),remaining:number(l.lent-l.returned-l.waived)}));}
  function normalize(a,b){
    const kind=b.kind;if(!Object.hasOwn(TYPES,kind))fail('单据类型无效');const s=positiveId(b.store_id),p=purpose(b.purpose),day=date(b.business_date);check(a,writeAction(kind),s,p);
    const out={kind,store_id:s,purpose:p,business_date:day,note:String(b.note||'').trim().slice(0,500)};
    if(kind==='closing')closingCoverage(s,p,b.lines);
    if(['adjustment','loss','purchase_return','transfer','borrow','repayment'].includes(kind)&&!out.note)fail('请填写原因或说明');
    if(kind==='receipt'){if(!SOURCES[b.source_key]||SOURCES[b.source_key].purpose!==p)fail('订单来源与库存用途不符');out.source_key=b.source_key;out.order_ref=text(b.order_ref,100);}
    if(['transfer','borrow'].includes(kind)){check(a,'transfer',s,p);out.to_purpose=purpose(b.to_purpose);if(out.to_purpose===p)fail('请选择另一个库存用途');check(a,'transfer',s,out.to_purpose);}
    if(kind==='repayment'){const l=loan(b.loan_id);if(l.store_id!==s||l.to_purpose!==p)fail('归还门店或用途与原借货不符');check(a,'transfer',s,p);check(a,'transfer',s,l.from_purpose);out.loan_id=l.document_id;}
    if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>300)fail('请填写1至300项物料');const seen=new Set();
    out.lines=b.lines.map(l=>{const i=item(l.item_id);if(!i.active)fail('停用物料不能登记新单');if(kind==='receipt'){const groups=catalog.supplierIds(i.id);if(groups.length&&!groups.includes('lcx'))fail('物料供应商与当前订单来源不符，请核对供应商分组');}if(seen.has(i.id))fail('同一物料不能重复填行');seen.add(i.id);const n={item_id:i.id,name:i.name,unit:i.unit};
      if(kind==='closing'){n.consumed=number(qty(l.consumed));n.loss=number(qty(l.loss));n.counted=l.counted===null||l.counted===undefined||l.counted===''?null:number(qty(l.counted));if(!Number.isInteger(l.balance_version)||l.balance_version<1)fail('请刷新库存后填写收档');n.balance_version=l.balance_version;}
      else if(['opening','adjustment'].includes(kind)){n.counted=number(qty(l.counted));if(kind==='adjustment'){if(!Number.isInteger(l.balance_version)||l.balance_version<1)fail('请刷新库存后更正');n.balance_version=l.balance_version;}}
      else {n.quantity=number(qty(l.quantity,false));if(kind==='receipt'&&l.ordered_quantity!==undefined&&l.ordered_quantity!==''){n.ordered_quantity=number(qty(l.ordered_quantity));if(n.quantity>n.ordered_quantity)fail('实收超过订货量，请核实并更正订货量');}}
      return n;});
    if(['borrow','repayment'].includes(kind)&&out.lines.length!==1)fail('借还单一次登记一种物料');if(kind==='repayment'&&out.lines[0].item_id!==loan(out.loan_id).item_id)fail('归还物料与原借货不符');return out;
  }
  function createDoc(a,b){const key=text(b.request_key,100),out=normalize(a,b),hash=crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex');return transaction(()=>{const old=one('SELECT * FROM inv_documents WHERE request_key=?',[key]);if(old){if(old.creator_id!==a.id||old.request_hash!==hash)fail('请求编号已使用，请勿重复提交不同内容',409);docCheck(a,'view',old);return present(old);}const now=stamp(),r=run('INSERT INTO inv_documents(kind,store_id,purpose,business_date,status,creator_id,creator_name,payload_json,request_key,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[out.kind,out.store_id,out.purpose,out.business_date,'draft',a.id,a.display_name||a.username||'操作人员',JSON.stringify(out),key,hash,now]);const id=Number(r.lastInsertRowid);event(a,'document.create',id,null,out);return present(rawDoc(id));});}
  function updateDoc(a,id,b){return transaction(()=>{const old=rawDoc(id);docCheck(a,'view',old);if(old.status!=='draft'||old.version!==Number(b.version))fail('单据已提交或已更新，请刷新',409);if(old.creator_id!==a.id&&!can(a,'confirm',old.store_id,old.purpose))fail('不能编辑他人草稿',403);const out=normalize(a,{...b,kind:old.kind,store_id:old.store_id,purpose:old.purpose,business_date:old.business_date});run('UPDATE inv_documents SET payload_json=?,version=version+1 WHERE id=?',[JSON.stringify(out),old.id]);event(a,'document.edit',old.id,payload(old),out);return present(rawDoc(old.id));});}
  function change(a,r,p,id,delta,category,allowOpening=false){const old=balance(r.store_id,p,id);if(!old&&!allowOpening)fail('该用途物料未做期初盘点，请先初始化');if(old&&allowOpening)fail('该用途物料已初始化，请用盘点更正',409);const n=(old?.quantity||0)+delta;if(!Number.isSafeInteger(n)||n<0||n>1e12)fail('库存不足或数量越界，请先核对收货与耗用',409);if(old)run('UPDATE inv_balances SET quantity=?,version=version+1 WHERE store_id=? AND purpose=? AND item_id=?',[n,r.store_id,p,id]);else run('INSERT INTO inv_balances(store_id,purpose,item_id,quantity) VALUES(?,?,?,?)',[r.store_id,p,id,n]);run('INSERT INTO inv_movements(document_id,store_id,purpose,item_id,delta,balance_after,category,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[r.id,r.store_id,p,id,delta,n,category,a.id,a.display_name||a.username||'操作人员',stamp()]);}
  function assertOpenPeriod(r,b){const pp=new Set([r.purpose]);if(b.to_purpose)pp.add(b.to_purpose);if(r.kind==='repayment')pp.add(loan(b.loan_id).from_purpose);for(const p of pp){const latest=one('SELECT business_date FROM inv_closures WHERE store_id=? AND purpose=? ORDER BY business_date DESC LIMIT 1',[r.store_id,p]);if(latest&&r.business_date<=latest.business_date)fail('此营业日已收档，请使用下一开放营业日并保留更正说明',409);const movement=one('SELECT d.business_date FROM inv_movements m JOIN inv_documents d ON d.id=m.document_id WHERE m.store_id=? AND m.purpose=? ORDER BY d.business_date DESC LIMIT 1',[r.store_id,p]);if(movement&&r.business_date<movement.business_date)fail('已有更晚营业日的库存变动，不能用旧日期覆盖现有余额',409);}}
  function action(a,id,b){return transaction(()=>{const r=rawDoc(id);docCheck(a,'view',r);const data=payload(r),act=b.action;
    if(act==='confirm'&&r.status==='posted'){docCheck(a,'confirm',r);return present(r);}
    if(r.version!==Number(b.version))fail('单据已更新，请刷新后操作',409);
    if(act==='submit'){docCheck(a,writeAction(r.kind),r);if(r.status==='submitted')return present(r);if(r.status!=='draft')fail('当前状态不能提交');run("UPDATE inv_documents SET status='submitted',version=version+1 WHERE id=?",[r.id]);event(a,'document.submit',r.id,null,null);return present(rawDoc(r.id));}
    if(act==='reject'){docCheck(a,'confirm',r);if(r.status!=='submitted')fail('只能退回待确认单据');const reason=text(b.reason,500);run("UPDATE inv_documents SET status='draft',version=version+1 WHERE id=?",[r.id]);event(a,'document.reject',r.id,null,{reason});return present(rawDoc(r.id));}
    if(act==='cancel'){if(r.status!=='draft'||(r.creator_id!==a.id&&!can(a,'confirm',r.store_id,r.purpose)))fail('只能撤销自己的未提交草稿');run("UPDATE inv_documents SET status='cancelled',version=version+1 WHERE id=?",[r.id]);event(a,'document.cancel',r.id,null,null);return present(rawDoc(r.id));}
    if(act!=='confirm'||r.status!=='submitted')fail('请先提交待确认单据');docCheck(a,'confirm',r);assertOpenPeriod(r,data);if(r.kind==='closing')closingCoverage(r.store_id,r.purpose,data.lines);
    if(r.kind==='receipt'){if(one('SELECT document_id FROM inv_receipts WHERE source_key=? AND store_id=? AND order_ref=?',[data.source_key,r.store_id,data.order_ref]))fail('此来源订单已经入库；补送请使用明确补送单号并关联说明',409);run('INSERT INTO inv_receipts VALUES(?,?,?,?)',[data.source_key,r.store_id,data.order_ref,r.id]);}
    if(r.kind==='closing')run('INSERT INTO inv_closures VALUES(?,?,?,?)',[r.store_id,r.purpose,r.business_date,r.id]);
    for(const l of data.lines){const current=balance(r.store_id,r.purpose,l.item_id);
      if(['closing','adjustment'].includes(r.kind)&&(!current||current.version!==l.balance_version))fail('库存自填报后已变化，请刷新后重新核对收档/盘点',409);
      if(['closing','adjustment'].includes(r.kind)){const expected=current.quantity-(r.kind==='closing'?qty(l.consumed)+qty(l.loss):0),difference=l.counted===null?null:qty(l.counted)-expected;if(difference&&!data.note)fail('实盘与账面应余存在差异，请退回填写差异说明');l.confirmed_check={before:number(current.quantity),expected:number(expected),counted:l.counted,difference:difference===null?null:number(difference)};}
      if(r.kind==='opening')change(a,r,r.purpose,l.item_id,qty(l.counted),'opening',true);
      else if(r.kind==='receipt')change(a,r,r.purpose,l.item_id,qty(l.quantity),'receipt');
      else if(['loss','purchase_return'].includes(r.kind))change(a,r,r.purpose,l.item_id,-qty(l.quantity),r.kind);
      else if(r.kind==='closing'){change(a,r,r.purpose,l.item_id,-qty(l.consumed),'consumption');if(qty(l.loss))change(a,r,r.purpose,l.item_id,-qty(l.loss),'loss');if(l.counted!==null){const after=balance(r.store_id,r.purpose,l.item_id);change(a,r,r.purpose,l.item_id,qty(l.counted)-after.quantity,'count_adjustment');}}
      else if(r.kind==='adjustment')change(a,r,r.purpose,l.item_id,qty(l.counted)-current.quantity,'count_adjustment');
      else if(['transfer','borrow'].includes(r.kind)){change(a,r,r.purpose,l.item_id,-qty(l.quantity),r.kind+'_out');change(a,r,data.to_purpose,l.item_id,qty(l.quantity),r.kind+'_in');if(r.kind==='borrow')run('INSERT INTO inv_loans(document_id,store_id,from_purpose,to_purpose,item_id,lent) VALUES(?,?,?,?,?,?)',[r.id,r.store_id,r.purpose,data.to_purpose,l.item_id,qty(l.quantity)]);}
      else if(r.kind==='repayment'){const ln=loan(data.loan_id),n=qty(l.quantity);if(n>ln.lent-ln.returned-ln.waived)fail('归还数量超过待还数');change(a,r,r.purpose,l.item_id,-n,'repayment_out');change(a,r,ln.from_purpose,l.item_id,n,'repayment_in');run('UPDATE inv_loans SET returned=returned+?,version=version+1 WHERE document_id=?',[n,ln.document_id]);event(a,'loan.repayment',ln.document_id,null,{repayment_document_id:r.id,quantity:number(n)});}
    }
    run("UPDATE inv_documents SET status='posted',version=version+1,posted_at=?,posted_by=?,payload_json=? WHERE id=?",[stamp(),a.display_name||a.username||'操作人员',JSON.stringify(data),r.id]);event(a,'document.confirm',r.id,null,data);return present(rawDoc(r.id));
  });}
  function waive(a,id,b){return transaction(()=>{const l=loan(id);check(a,'confirm',l.store_id,l.from_purpose);check(a,'confirm',l.store_id,l.to_purpose);check(a,'transfer',l.store_id,l.from_purpose);check(a,'transfer',l.store_id,l.to_purpose);if(l.version!==Number(b.version))fail('借还记录已更新，请刷新',409);const n=qty(b.quantity,false);if(n>l.lent-l.returned-l.waived)fail('转为直接使用的数量超过待还数');const reason=text(b.reason,500);run('UPDATE inv_loans SET waived=waived+?,version=version+1 WHERE document_id=?',[n,l.document_id]);event(a,'loan.convert_to_transfer',l.document_id,l,{quantity:number(n),reason});return loans(a,l.store_id,l.from_purpose).find(x=>x.document_id===l.document_id);});}
  return {items,saveItem,suppliers:catalog.suppliers,supplierCatalog:catalog.catalog,previewSupplierImport:catalog.preview,importSupplierCatalog:catalog.importCatalog,stock,list,detail,createDoc,updateDoc,action,loans,waive,can,close:()=>sql.close()};
}
module.exports={open,create,qty,PURPOSES,SOURCES,TYPES};
