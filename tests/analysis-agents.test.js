const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const agents = require('../lib/analysis-agents');

async function fixture() {
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  sqlite.run(`CREATE TABLE stores(id INTEGER,store_name TEXT);
    CREATE TABLE business_revenue_records(store_id INTEGER,biz_date TEXT,source_type TEXT,channel TEXT,channel_group TEXT,platform TEXT,actual_amount REAL,gross_amount REAL,platform_income_amount REAL);
    CREATE TABLE business_revenue_compositions(store_id INTEGER,biz_date TEXT,category TEXT,amount REAL);
    CREATE TABLE pos_product_sale_details(store_id INTEGER,biz_date TEXT,product_name TEXT,quantity REAL,sales_amount REAL,discount_amount REAL,income_amount REAL,order_source TEXT);
    CREATE TABLE bookkeeping_entries(id INTEGER,store_id INTEGER,date TEXT,category_name TEXT,subcategory_name TEXT,amount REAL);
    CREATE TABLE pos_bookkeeping_daily_import_rows(entry_id INTEGER);
    CREATE TABLE analysis_agent_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,store_id INTEGER,store_name TEXT,date_from TEXT,date_to TEXT,mode TEXT,depth TEXT,profile_name TEXT,status TEXT DEFAULT 'running',result_json TEXT DEFAULT '{}',error_text TEXT DEFAULT '',created_by INTEGER,created_by_name TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,finished_at TEXT DEFAULT '');
    CREATE TABLE analysis_agent_steps(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER,step_key TEXT,step_name TEXT,status TEXT DEFAULT 'pending',evidence_json TEXT DEFAULT '{}',result_json TEXT DEFAULT '{}',interpretation TEXT DEFAULT '',error_text TEXT DEFAULT '',started_at TEXT DEFAULT '',finished_at TEXT DEFAULT '');
    INSERT INTO stores VALUES(30,'大运城邦店');
    INSERT INTO business_revenue_records VALUES(30,'2026-09-01','pos','store_sales','offline','',100,120,0);
    INSERT INTO business_revenue_records VALUES(30,'2026-09-01','pos','meituan_group','group_buy','美团团购',15,20,0);
    INSERT INTO business_revenue_compositions VALUES(30,'2026-09-01','扫码支付',100);
    INSERT INTO pos_product_sale_details VALUES(30,'2026-09-01','烧鹅饭',2,80,5,75,'POS');
    INSERT INTO bookkeeping_entries VALUES(1,30,'2026-09-01','销售收入','堂食',75);
    INSERT INTO bookkeeping_entries VALUES(2,30,'2026-09-01','会员','充值',30);
    INSERT INTO bookkeeping_entries VALUES(3,30,'2026-09-01','食材','采购',-40);`);
  const queryAll = (sql, params = []) => { const stmt = sqlite.prepare(sql); stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows; };
  return { queryAll, queryOne: (sql, params) => queryAll(sql, params)[0] || null,
    run: (sql, params = []) => { sqlite.run(sql, params); return sqlite.getRowsModified(); },
    insert: (sql, params = []) => { sqlite.run(sql, params); return queryAll('SELECT last_insert_rowid() id')[0].id; }, save: () => {} };
}

test('固定路线生成可审计结果，不把团购嵌入金额叠加为店内实收', async () => {
  const db = await fixture();
  const id = agents.start(db, { store_id: 30, date_from: '2026-09-01', date_to: '2026-09-01', mode: 'rules' }, { id: 1, username: 'test' }, {});
  let run;
  for (let attempt = 0; attempt < 50; attempt++) {
    run = agents.getRun(db, id);
    if (run.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(run.status, 'completed', run.error_text);
  assert.deepEqual(run.steps.map(step => step.step_key), ['coordinator', 'channels', 'dishes', 'ledger', 'synthesis']);
  assert.equal(run.steps[1].result.pos_store_sales, 100);
  assert.equal(run.steps[2].result.totals.income_amount, 75);
  assert.equal(run.steps[3].result.totals.inflow, 105);
  assert.match(run.result.warnings.join(' '), /没有第三方平台实收数据/);
  assert.equal(run.steps[1].interpretation, '');
});

test('拒绝超长、未结束日期和缺失门店', async () => {
  const db = await fixture();
  assert.throws(() => agents.validateInput(db, { store_id: 30, date_from: '2026-01-01', date_to: '2026-02-10' }), /31 天/);
  assert.throws(() => agents.validateInput(db, { store_id: 30, date_from: '2099-01-01', date_to: '2099-01-01' }), /已结束/);
  assert.throws(() => agents.validateInput(db, { store_id: 999, date_from: '2026-09-01', date_to: '2026-09-01' }), /不存在/);
});

test('模型仅消耗推理预算时标记警告，随后可在原任务补齐四段解读', async () => {
  const db = await fixture();
  const previousFetch = global.fetch;
  let answer = '';
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: answer }, finish_reason: answer ? 'stop' : 'length' }] }) });
  const config = { aiEnabled: true, activeAiProfileId: 'test', aiProfiles: [{ id: 'test', name: 'test', baseUrl: 'https://example.test', model: 'test', apiKey: 'secret' }] };
  try {
    const id = agents.start(db, { store_id: 30, date_from: '2026-09-01', date_to: '2026-09-01', mode: 'ai', depth: 'deep', profile_id: 'test' }, { id: 1 }, config);
    let run;
    for (let i = 0; i < 50; i++) { run = agents.getRun(db, id); if (run.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(run.status, 'completed_with_warning');
    assert.match(run.steps[1].error_text, /输出预算已耗尽/);
    answer = '观察：测试。证据：已给数据。建议：人工核对。待核实：平台账单。';
    agents.retryAi(db, id, 'test', config);
    for (let i = 0; i < 50; i++) { run = agents.getRun(db, id); if (run.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(run.status, 'completed');
    assert.equal(run.steps.filter(step => step.interpretation).length, 4);
  } finally { global.fetch = previousFetch; }
});
