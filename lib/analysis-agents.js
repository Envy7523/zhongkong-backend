const operating = require('./analysis-operating-facts');
/**
 * 只读经营分析编排。三个专员只读取聚合数据；队长只汇总已留痕结果。
 * 模型只能补充文字建议，不能执行工具、SQL、导入、推送或改写经营数据。
 */
const STEPS = [
  ['coordinator', '队长 · 确定口径与分工'],
  ['channels', '渠道专员 · 实收构成'],
  ['dishes', '菜品专员 · 销量与折扣'],
  ['ledger', '账本专员 · 收支构成'],
  ['synthesis', '队长 · 汇总与调整计划'],
];

const round = value => Math.round((Number(value) || 0) * 100) / 100;
const asJson = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const now = () => new Date().toISOString();
const todayShanghai = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function validateInput(db, input) {
  const storeId = Number(input.store_id);
  const from = String(input.date_from || '');
  const to = String(input.date_to || '');
  if (!Number.isInteger(storeId) || storeId < 1) throw new Error('请选择门店');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('请选择有效日期');
  const first = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()) || first.toISOString().slice(0, 10) !== from || last.toISOString().slice(0, 10) !== to || first > last) throw new Error('日期范围无效');
  if ((last - first) / 86400000 > 30) throw new Error('单次最多分析连续 31 天');
  if (to >= todayShanghai()) throw new Error('只能分析已结束的业务日');
  const store = db.queryOne('SELECT id,store_name FROM stores WHERE id=?', [storeId]);
  if (!store) throw new Error('门店不存在');
  const mode = input.mode === 'ai' ? 'ai' : 'rules';
  const depth = ['brief', 'standard', 'deep'].includes(input.depth) ? input.depth : 'standard';
  return { store, from, to, mode, depth, profileId: String(input.profile_id || '').slice(0, 100) };
}

function chooseProfile(config, profileId) {
  if (!config || !config.aiEnabled) return null;
  const profiles = Array.isArray(config.aiProfiles) ? config.aiProfiles : [];
  const selectedId = profileId || config.activeAiProfileId;
  const profile = profiles.find(item => item.id === selectedId);
  if (!profile || !profile.baseUrl || !profile.model || !profile.apiKey) return null;
  const endpoint = new URL(profile.baseUrl);
  if (endpoint.protocol !== 'https:') return null;
  return { name: profile.name || profile.model, baseUrl: profile.baseUrl.replace(/\/$/, ''), model: profile.model, apiKey: profile.apiKey, auth: profile.auth, header: profile.header };
}

function start(db, input, user, config) {
  const args = validateInput(db, input);
  const profile = args.mode === 'ai' ? chooseProfile(config, args.profileId) : null;
  if (args.mode === 'ai' && !profile) throw new Error('所选模型未启用或配置不完整，请先到企业设置配置模型');
  const running = db.queryOne("SELECT id FROM analysis_agent_runs WHERE status='running' LIMIT 1");
  if (running) throw new Error(`已有分析任务 #${running.id} 正在运行，请等待完成`);
  const runId = db.insert(`INSERT INTO analysis_agent_runs
    (store_id,store_name,date_from,date_to,mode,depth,profile_name,created_by,created_by_name)
    VALUES (?,?,?,?,?,?,?,?,?)`, [args.store.id, args.store.store_name, args.from, args.to, args.mode, args.depth,
    profile?.name || '', user?.id || null, user?.display_name || user?.username || '系统']);
  for (const [key, name] of STEPS) db.insert('INSERT INTO analysis_agent_steps (run_id,step_key,step_name) VALUES (?,?,?)', [runId, key, name]);
  db.save();
  setImmediate(() => execute(db, runId, args, profile).catch(error => {
    db.run("UPDATE analysis_agent_steps SET status='failed',error_text=?,finished_at=? WHERE run_id=? AND status='running'", [String(error.message || error).slice(0, 400), now(), runId]);
    db.run("UPDATE analysis_agent_runs SET status='failed',error_text=?,finished_at=? WHERE id=?", [String(error.message || error).slice(0, 400), now(), runId]);
    db.save();
  }));
  return runId;
}

function beginStep(db, runId, key) {
  db.run("UPDATE analysis_agent_steps SET status='running',started_at=? WHERE run_id=? AND step_key=?", [now(), runId, key]);
  db.save();
}
function finishStep(db, runId, key, result, evidence, interpretation = '', error = '') {
  db.run(`UPDATE analysis_agent_steps SET status=?,result_json=?,evidence_json=?,interpretation=?,error_text=?,finished_at=?
    WHERE run_id=? AND step_key=?`, [error ? 'completed_with_warning' : 'completed', JSON.stringify(result), JSON.stringify(evidence), interpretation, error.slice(0, 400), now(), runId, key]);
  db.save();
}

function channelFacts(db, id, from, to) {
  const pos = db.queryAll(`SELECT channel,channel_group,COUNT(DISTINCT biz_date) days,
    ROUND(SUM(CASE WHEN channel_group='delivery' THEN recorded_amount ELSE actual_amount END),2) actual_amount,ROUND(SUM(gross_amount),2) gross_amount
    FROM business_revenue_records WHERE store_id=? AND biz_date BETWEEN ? AND ? AND source_type='pos'
    GROUP BY channel,channel_group ORDER BY actual_amount DESC`, [id, from, to]);
  const platform = db.queryAll(`SELECT platform,channel,COUNT(DISTINCT biz_date) days,
    ROUND(SUM(actual_amount),2) actual_amount,ROUND(SUM(platform_income_amount),2) platform_income_amount
    FROM business_revenue_records WHERE store_id=? AND biz_date BETWEEN ? AND ? AND source_type='platform'
    GROUP BY platform,channel ORDER BY actual_amount DESC`, [id, from, to]);
  const payments = db.queryAll(`SELECT category,ROUND(SUM(amount),2) amount FROM business_revenue_compositions
    WHERE store_id=? AND biz_date BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC`, [id, from, to]);
  const days = db.queryOne(`SELECT COUNT(DISTINCT biz_date) days FROM business_revenue_records
    WHERE store_id=? AND biz_date BETWEEN ? AND ? AND source_type='pos'`, [id, from, to]);
  const base = round(pos.filter(x => x.channel === 'store_sales').reduce((sum, x) => sum + Number(x.actual_amount || 0), 0));
  const topPayment = payments[0];
  const observations = [
    `收银系统「店内销售」实收 ¥${base.toFixed(2)}，仅覆盖 ${Number(days?.days || 0)} 个业务日；其他收银渠道可能嵌入其中，不应相加。`,
    topPayment ? `支付构成中最大项为「${topPayment.category}」¥${round(topPayment.amount).toFixed(2)}；这是支付方式，不是额外收入。` : '缺少收银支付构成，无法核对现金/扫码/会员卡结构。',
    platform.length ? `已读取 ${platform.length} 类第三方平台记录；应逐平台核对到账、退款、费用和日期覆盖。` : '目前没有第三方平台真实到账记录，无法评价外卖或团购各平台的真实收入占比。',
  ];
  return { pos, platform, payments, observations, pos_days: Number(days?.days || 0), pos_store_sales: base,
    note: '收银视角的外卖/团购是分类，不等于第三方平台真实结算；店内实收、支付构成及嵌入的团购金额不能相加。平台表单独列示，不与收银表求总和。' };
}

function dishFacts(db, id, from, to) {
  const totals = db.queryOne(`SELECT COUNT(*) rows,COUNT(DISTINCT biz_date) days,
    ROUND(SUM(quantity),2) quantity,ROUND(SUM(sales_amount),2) sales_amount,
    ROUND(SUM(discount_amount),2) discount_amount,ROUND(SUM(income_amount),2) income_amount
    FROM pos_product_sale_details WHERE store_id=? AND biz_date BETWEEN ? AND ?`, [id, from, to]);
  const top = db.queryAll(`SELECT product_name,ROUND(SUM(quantity),2) quantity,
    ROUND(SUM(sales_amount),2) sales_amount,ROUND(SUM(discount_amount),2) discount_amount,ROUND(SUM(income_amount),2) income_amount
    FROM pos_product_sale_details WHERE store_id=? AND biz_date BETWEEN ? AND ?
    GROUP BY product_name ORDER BY income_amount DESC LIMIT 15`, [id, from, to]);
  const sources = db.queryAll(`SELECT COALESCE(NULLIF(order_source,''),'未标明') source,
    ROUND(SUM(income_amount),2) income_amount,COUNT(*) rows FROM pos_product_sale_details
    WHERE store_id=? AND biz_date BETWEEN ? AND ? GROUP BY source ORDER BY income_amount DESC`, [id, from, to]);
  const daily = db.queryAll(`SELECT biz_date,ROUND(SUM(income_amount),2) income_amount
    FROM pos_product_sale_details WHERE store_id=? AND biz_date BETWEEN ? AND ?
    GROUP BY biz_date ORDER BY biz_date`, [id, from, to]);
  const topItem = top[0];
  const observations = [
    topItem ? `品项收入最高的是「${topItem.product_name}」，收入 ¥${round(topItem.income_amount).toFixed(2)}、数量 ${Number(topItem.quantity || 0)}；是否高利润仍需成本数据。` : '没有菜品明细，不能判断畅销品。',
    `已导入品项销售 ¥${round(totals?.sales_amount).toFixed(2)}、折扣 ¥${round(totals?.discount_amount).toFixed(2)}、收入 ¥${round(totals?.income_amount).toFixed(2)}；应重点核对高折扣品和退菜。`,
  ];
  return { totals, top, sources, daily, observations, note: '品项明细收入来自收银系统菜品报表，与综合营业统计不是可相加的两个收入来源；差异需要单独核对。' };
}

function ledgerFacts(db, id, from, to) {
  const totals = db.queryOne(`SELECT COUNT(*) rows,COUNT(DISTINCT date) days,
    ROUND(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),2) inflow,
    ROUND(SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END),2) outflow,
    ROUND(SUM(amount),2) net FROM bookkeeping_entries WHERE store_id=? AND date BETWEEN ? AND ?`, [id, from, to]);
  const categories = db.queryAll(`SELECT category_name,subcategory_name,COUNT(*) rows,
    ROUND(SUM(amount),2) amount FROM bookkeeping_entries WHERE store_id=? AND date BETWEEN ? AND ?
    GROUP BY category_name,subcategory_name ORDER BY ABS(SUM(amount)) DESC`, [id, from, to]);
  const source = db.queryOne(`SELECT COUNT(*) rows FROM pos_bookkeeping_daily_import_rows r
    JOIN bookkeeping_entries e ON e.id=r.entry_id WHERE e.store_id=? AND e.date BETWEEN ? AND ?`, [id, from, to]);
  const largestExpense = categories.find(item => Number(item.amount) < 0);
  const observations = [
    `账本流入 ¥${round(totals?.inflow).toFixed(2)}、流出 ¥${round(totals?.outflow).toFixed(2)}；流入可能含会员充值，净额不能视为利润。`,
    largestExpense ? `绝对额最大的支出分类是「${largestExpense.category_name}／${largestExpense.subcategory_name}」¥${round(Math.abs(largestExpense.amount)).toFixed(2)}；需核对凭证和一次性费用。` : '没有可识别支出分类，无法提出降本重点。',
    `共 ${Number(totals?.rows || 0)} 条账本记录，其中 ${Number(source?.rows || 0)} 条链接到收银系统单日导入；其余记录来源与后续修改历史需另行审计。`,
  ];
  return { totals, categories, observations, pos_import_rows: Number(source?.rows || 0),
    record_count_label: '记账本流水笔数，不是收银综合营业统计记录数或订单量',
    pos_import_rows_label: '已链接门店收支报表导入的账本记录数，不代表综合营业统计覆盖天数',
    note: '账本含销售、储值充值与费用；会员充值并非当期营业收入。人工粘贴与收银导入并存，账本净额不是利润。源表未记录历史修订版本，不能据此断言旧日数据没有被改动。' };
}

function modelOptions(profile) {
  // Official DeepSeek defaults to thinking mode. These summaries already have
  // deterministic arithmetic; request the final answer instead of spending its
  // entire output budget on hidden reasoning. Do not send vendor fields elsewhere.
  return new URL(profile.baseUrl).hostname === 'api.deepseek.com' && /deepseek/i.test(profile.model)
    ? { thinking: { type: 'disabled' } } : {};
}
async function explain(profile, depth, role, facts) {
  if (!profile) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await require('./integration-http').request(`${profile.baseUrl}/chat/completions`, { method: 'POST', signal: controller.signal, timeout: 90000,
      headers: { 'Content-Type': 'application/json', [profile.auth === 'header' ? profile.header : 'Authorization']: profile.auth === 'header' ? profile.apiKey : `Bearer ${profile.apiKey}` },
      body: JSON.stringify({ model: profile.model, temperature: 0.1, ...modelOptions(profile),
        // 推理模型的 reasoning_tokens 与最终 content 共用输出预算；原 1000 tokens
        // 在深度模式下可能全部耗于推理，造成 HTTP 200 但 content 为空。
        max_tokens: { brief: 3000, standard: 6000, deep: 8192 }[depth],
        messages: [
          { role: 'system', content: `你是餐饮经营${role}分析专员。只基于所给 JSON 事实，优先输出能帮助店长经营决策的「经营结论、与前期变化、具体调整、验证方式」四段摘要。${role === '菜品' ? '重点区分销量主力、收入主力、下滑菜品和折扣压力品，逐项写出具体菜名、金额/数量/占比及变化。' : role === '渠道' ? '重点说明各渠道实际记录的收入、结构和前期变化，平台真实实收单独解释；没有菜品明细，不分析菜品。' : role === '账本' ? '重点说明具体费用项和登记付款变化，区分集中付款与经营消耗，不把账本现金净额当利润；没有菜品数据，不分析菜品。' : '结合专员返回的实际结论，给出最重要的增长点、拖累项和有明确对象的调整计划，避免重复专员全文。'}对比期间不可比时不得推断增长；缺成本不得判定毛利或直接建议涨价、下架。不要复述整个JSON，不要以泛泛的数据核对代替经营结论。原因只可列待验证假设，建议需给负责人和复查指标。不得编造原因、日期、数字或外部平台数据；不能自动修改价格、数据库或发送消息。渠道收银口径与平台结算不可相加；会员充值不是营业额。同一菜品报表的order_source分组（POS、扫码点餐）互斥，允许汇总为品项收入；不可再与综合营业统计相加。数量单位未统一，不能解释全店总销量、总份数、总订单量或客单价，只比较同一菜品数量；没有连带购买证据，不能断言饮品有引流作用。本期日期只用current_period，previous_period/comparison_period是前期，不能写反。复查7天时必须用日均数量/收入与前期日均对比，不将7天总额与12天总额对比。全店折扣率仅为排查参考，不能直接要求各菜品折扣率降至全店平均，先核实促销及单位成本。不要输出隐藏思维链。分析详尽程度：${depth}。` },
          { role: 'user', content: JSON.stringify({ ...facts, record_count_policy: '账本条目数不是收银导入笔数。流水笔数变化不能用于判断营业记录缺失；营业日期覆盖只使用pos_days、dish_days和coverage字段。' }) },
        ] }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`模型接口状态 ${response.status}`);
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new Error(payload?.choices?.[0]?.finish_reason === 'length'
        ? '模型输出预算已耗尽，未生成最终结论'
        : '模型没有返回最终文本');
    }
    if (payload?.choices?.[0]?.finish_reason === 'length') throw new Error('模型最终结论被截断，需补齐解读');
    return content.slice(0, 5000);
  } finally { clearTimeout(timer); }
}

async function execute(db, runId, args, profile) {
  const { store, from, to, depth } = args;
  beginStep(db, runId, 'coordinator');
  const period = operating.previousPeriod(from, to);
  // One synchronous read snapshot before any model call; all specialists share this cutoff.
  const facts = { channels: channelFacts(db, store.id, from, to), dishes: dishFacts(db, store.id, from, to), ledger: ledgerFacts(db, store.id, from, to) };
  facts.channels = operating.enrichChannels(facts.channels, channelFacts(db, store.id, period.from, period.to), period);
  const priorDish = dishFacts(db, store.id, period.from, period.to);
  facts.dishes = operating.enrichDishes(facts.dishes, priorDish, operating.products(db, store.id, from, to), operating.products(db, store.id, period.from, period.to), period);
  facts.ledger = operating.enrichLedger(facts.ledger, ledgerFacts(db, store.id, period.from, period.to), period);
  const frozen = value => { if(value && typeof value === 'object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value; };
  for (const value of Object.values(facts)) { value.current_period = { from, to, days: period.days }; value.previous_period = period; }
  frozen(facts);
  const plan = { store: store.store_name, date_from: from, date_to: to, comparison_period: period,
    execution: 'parallel', route: [['coordinator'], ['channels', 'dishes', 'ledger'], ['synthesis']], snapshot_at: now(),
    mode: profile ? '配置模型并行分析' : '规则计算', guardrails: ['同一数据快照', '同长度前期对比', '不同收入口径不叠加', '不自动改价/导入/发群'] };
  finishStep(db, runId, 'coordinator', plan, { source: '用户选定区间与同长度前期，模型调用前统一完成只读取数' });
  let modelWarnings = 0;
  await Promise.all([
    ['channels', '渠道', ['business_revenue_records', 'business_revenue_compositions']],
    ['dishes', '菜品', ['pos_product_sale_details']],
    ['ledger', '账本', ['bookkeeping_entries', 'pos_bookkeeping_daily_import_rows']],
  ].map(async ([key, name, tables]) => {
    beginStep(db, runId, key);
    let interpretation = '', warning = '';
    if (profile) {
      const input = key === 'dishes' ? { ...facts[key], all_products: undefined, totals: { ...facts[key].totals, quantity: undefined } } : facts[key];
      try { interpretation = await explain(profile, depth, name, input); }
      catch (error) { warning = `模型解读不可用，已保留确定性计算：${error.message}`; }
    }
    if (warning) modelWarnings++;
    finishStep(db, runId, key, facts[key], { tables, store_id: store.id, date_from: from, date_to: to, comparison_period: period, snapshot_at: plan.snapshot_at, query: '共享快照，只读聚合', execution: 'parallel' }, interpretation, warning);
  }));
  beginStep(db, runId, 'synthesis');
  const result = operating.managementReport(facts, period);
  const completed = getRun(db, runId);
  let interpretation = '';
  let warning = '';
  if (profile) {
    try { interpretation = await explain(profile, depth, '队长综合', { ...result, specialist_summaries: completed.steps.filter(step => ['channels','dishes','ledger'].includes(step.step_key)).map(step => ({ role: step.step_key, interpretation: step.interpretation, warning: step.error_text, observations: step.result.observations })) }); }
    catch (error) { warning = `模型综合不可用，已保留规则版调整计划：${error.message}`; }
  }
  if (warning) modelWarnings++;
  finishStep(db, runId, 'synthesis', result, { source_steps: ['channels', 'dishes', 'ledger'], policy: '不混算不同收入口径' }, interpretation, warning);
  db.run('UPDATE analysis_agent_runs SET status=?,result_json=?,finished_at=? WHERE id=?', [modelWarnings ? 'completed_with_warning' : 'completed', JSON.stringify(result), now(), runId]);
  db.save();
}

function retryAi(db, runId, profileId, config) {
  const run = getRun(db, runId);
  if (!run) throw new Error('分析任务不存在');
  if (run.mode !== 'ai') throw new Error('仅 AI 模式任务可以补齐模型解读');
  if (!['completed', 'completed_with_warning'].includes(run.status)) throw new Error('任务尚未结束，不能补齐解读');
  if (!run.steps.some(step => ['channels', 'dishes', 'ledger', 'synthesis'].includes(step.step_key) && !step.interpretation)) throw new Error('所有 AI 解读均已生成');
  const profile = chooseProfile(config, profileId);
  if (!profile) throw new Error('模型未启用或配置不完整');
  const running = db.queryOne("SELECT id FROM analysis_agent_runs WHERE status='running' LIMIT 1");
  if (running) throw new Error(`已有分析任务 #${running.id} 正在运行`);
  db.run("UPDATE analysis_agent_runs SET status='running',error_text='',profile_name=?,finished_at='' WHERE id=?", [profile.name, runId]);
  db.save();
  setImmediate(() => executeRetry(db, runId, profile).catch(error => {
    db.run("UPDATE analysis_agent_steps SET status='completed_with_warning',error_text=?,finished_at=? WHERE run_id=? AND status='running'", [String(error.message || error).slice(0, 400), now(), runId]);
    db.run("UPDATE analysis_agent_runs SET status='completed_with_warning',error_text=?,finished_at=? WHERE id=?", [String(error.message || error).slice(0, 400), now(), runId]);
    db.save();
  }));
}

async function executeRetry(db, runId, profile) {
  const original = getRun(db, runId);
  const byKey = Object.fromEntries(original.steps.map(step => [step.step_key, step]));
  let failed = 0;
  const retry = async (key, role) => {
    const step = byKey[key];
    if (step.interpretation && key !== 'synthesis') return;
    beginStep(db, runId, key);
    let interpretation = '', warning = '';
    const input = key === 'synthesis'
      ? { ...step.result, specialist_summaries: getRun(db,runId).steps.filter(s=>['channels','dishes','ledger'].includes(s.step_key)).map(s=>({role:s.step_key,interpretation:s.interpretation,warning:s.error_text,observations:s.result.observations})) }
      : { ...step.result, all_products: undefined, ...(key === 'dishes' ? { totals: { ...step.result.totals, quantity: undefined } } : {}) };
    try { interpretation = await explain(profile, original.depth, role, input); }
    catch (error) { warning = `模型解读仍不可用：${error.message}`; failed++; }
    finishStep(db, runId, key, step.result, step.evidence, interpretation, warning);
  };
  await Promise.all([['channels','渠道'],['dishes','菜品'],['ledger','账本']].map(([key,role])=>retry(key,role)));
  await retry('synthesis','队长综合');
  db.run('UPDATE analysis_agent_runs SET status=?,finished_at=? WHERE id=?', [failed ? 'completed_with_warning' : 'completed', now(), runId]);
  db.save();
}

function getRun(db, id) {
  const run = db.queryOne('SELECT * FROM analysis_agent_runs WHERE id=?', [id]);
  if (!run) return null;
  return { ...run, result: asJson(run.result_json), steps: db.queryAll('SELECT * FROM analysis_agent_steps WHERE run_id=? ORDER BY id', [id]).map(step => ({
    ...step, result: asJson(step.result_json), evidence: asJson(step.evidence_json), result_json: undefined, evidence_json: undefined,
  })), result_json: undefined };
}

function recoverInterrupted(db) {
  const count = db.run("UPDATE analysis_agent_runs SET status='failed',error_text='服务重启，分析被中断；原始经营数据未改变',finished_at=? WHERE status='running'", [now()]);
  if (count) {
    db.run("UPDATE analysis_agent_steps SET status='failed',error_text='服务重启，步骤中断',finished_at=? WHERE status='running'", [now()]);
    db.save();
  }
  return count;
}

module.exports = { start, retryAi, getRun, validateInput, recoverInterrupted, STEPS, modelOptions };
