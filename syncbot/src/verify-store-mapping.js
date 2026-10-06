// 只读配置校验：核对映射草案 22 条 vs 项目门店主档，并检查 3 家未出现门店
// 用法：node verify-store-mapping.js [草稿json] [主档快照json(可选)]
const fs = require('fs');

(async () => {
  const draftPath = process.argv[2] || '_syncbot/store-mapping-draft.json';
  const snapshotPath = process.argv[3] || '';
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));

  let stores;
  if (snapshotPath) {
    const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    stores = snap.stores || snap;
    console.log(`主档来源：快照 ${snapshotPath}`);
  } else {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync('data/database.sqlite'));
    const r = db.exec('SELECT id, store_name, status, city FROM stores');
    stores = (r[0] ? r[0].values : []).map(v => ({ id: v[0], store_name: v[1], status: v[2], city: v[3] }));
    db.close();
    console.log('主档来源：本地 data/database.sqlite');
  }

  console.log(`主档门店数：${stores.length}｜草案：matched=${draft.summary.matched} pending=${draft.summary.pending_mapping} ambiguous=${draft.summary.ambiguous}\n`);

  const byId = new Map(stores.map(s => [Number(s.id), s]));
  const byName = new Map();
  for (const s of stores) {
    const list = byName.get(s.store_name) || [];
    list.push(s);
    byName.set(s.store_name, list);
  }

  let fail = 0;
  const bad = msg => { fail++; console.log('  ❌ ' + msg); };

  console.log('=== 1) 逐条核对 22 条映射 ===');
  const usedIds = new Set();
  for (const m of draft.matched) {
    const problems = [];
    if (m.store_name !== m.project_store_name) problems.push(`报表名与草案主档名不一致：「${m.store_name}」vs「${m.project_store_name}」`);
    const target = byId.get(Number(m.project_store_id));
    if (!target) problems.push(`主档不存在 id=${m.project_store_id}`);
    else if (target.store_name !== m.store_name) problems.push(`id=${m.project_store_id} 的主档名是「${target.store_name}」，与报表名不符`);
    const sameName = byName.get(m.store_name) || [];
    if (sameName.length === 0) problems.push('主档中找不到同名门店');
    if (sameName.length > 1) problems.push(`主档存在 ${sameName.length} 家同名门店（id=${sameName.map(s => s.id).join(',')}）`);
    if (usedIds.has(Number(m.project_store_id))) problems.push(`ID ${m.project_store_id} 被多条映射重复使用`);
    usedIds.add(Number(m.project_store_id));
    if (problems.length) bad(`${m.store_name}: ${problems.join('；')}`);
  }
  if (!fail) console.log('  ✅ 22 条全部与主档名称完全一致、ID 唯一且存在、无重名');

  console.log('\n=== 2) 待映射 / 歧义 ===');
  if (draft.pending_mapping.length) bad(`存在待映射 ${draft.pending_mapping.length} 条`);
  else console.log('  ✅ 待映射 0 条');
  if (draft.summary.ambiguous) bad(`存在歧义 ${draft.summary.ambiguous} 条`);
  else console.log('  ✅ 歧义 0 条');

  console.log('\n=== 3) 未被映射的主档门店（应为 3 家豁免） ===');
  const unmapped = stores.filter(s => !usedIds.has(Number(s.id)));
  unmapped.forEach(s => console.log(`  id=${s.id} ${s.store_name} 状态=${s.status || '(空)'} 城市=${s.city || '-'}`));
  const drafted = draft.project_stores_not_in_report.map(s => Number(s.id)).sort((a, b) => a - b);
  const actual = unmapped.map(s => Number(s.id)).sort((a, b) => a - b);
  if (JSON.stringify(drafted) !== JSON.stringify(actual)) bad(`未映射门店与草案记录不一致：草案 ${JSON.stringify(drafted)} vs 实际 ${JSON.stringify(actual)}`);
  else console.log('  ✅ 未映射门店与草案「project_stores_not_in_report」完全一致');

  console.log('\n=== 4) 3 家豁免门店明细 ===');
  for (const item of draft.project_stores_not_in_report) {
    const s = byId.get(Number(item.id));
    if (!s) { bad(`id=${item.id} 主档不存在`); continue; }
    console.log(`  id=${s.id}｜${s.store_name}｜主档状态=${s.status || '(空)'}｜草案城市=${item.city || '-'}｜主档城市=${s.city || '-'}｜人工覆盖=${item.human_override || '-'}`);
  }

  console.log('\n=== 5) id=17 人工覆盖（human_override: pre_opening） ===');
  const cfgPath = '_syncbot/stage0/config/store-mapping.json';
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const entry17 = (cfg.project_stores_absent_in_sample || []).find(x => Number(x.id) === 17);
  const overrideItems = (cfg.human_overrides && cfg.human_overrides.items) || [];
  const ov17 = overrideItems.find(x => Number(x.id) === 17);

  if (!entry17) bad('配置 project_stores_absent_in_sample 中缺少 id=17');
  else {
    if (entry17.human_override !== 'pre_opening') bad(`id=17 的 human_override 应为 pre_opening，实际 ${JSON.stringify(entry17.human_override)}`);
    else console.log('  ✅ 豁免清单中 id=17 的 human_override = pre_opening');
    if (entry17.flag !== 'pre_opening') bad('id=17 的 flag 应为 pre_opening');
  }
  if (!ov17) bad('配置 human_overrides.items 中缺少 id=17');
  else {
    const required = [
      ['human_override', 'pre_opening'],
      ['master_record_untouched', true],
      ['must_not_write_master', true],
      ['applies_to', 'syncbot_validation_only'],
    ];
    for (const [key, want] of required) {
      if (ov17[key] !== want) bad(`id=17 人工覆盖字段 ${key} 应为 ${JSON.stringify(want)}，实际 ${JSON.stringify(ov17[key])}`);
    }
    const texts = [ov17.human_override_reason, ov17.status_conflict, ov17.sync_decision, ov17.follow_up, ov17.override_scope].join(' ');
    const mustMention = [
      ['筹建、尚未开业', '人工业务确认内容'],
      ['正常营业', '主档状态冲突说明'],
      ['不视为报表缺失', '不视为异常说明'],
      ['门店管理中单独修正', '后续修正主档的说明'],
      ['不得反向修改或覆盖项目门店主档', '不得回写主档的边界'],
    ];
    // 注意：这里必须比较 fail 计数，不能写 if (!bad)——bad 是函数，恒为真值，
    // 会导致"全部通过"的提示永远不打印（曾踩过这个坑）。
    const failBefore = fail;
    for (const [needle, label] of mustMention) {
      if (!texts.includes(needle)) bad(`id=17 人工覆盖缺少「${label}」（未找到文字：${needle}）`);
    }
    if (fail === failBefore) console.log('  ✅ 人工覆盖包含全部要求说明：人工确认依据、主档状态冲突、豁免口径、后续修正主档、不得回写主档');
    console.log('  ✅ 边界字段：applies_to=syncbot_validation_only、master_record_untouched=true、must_not_write_master=true');
  }
  const allOverrideIds = overrideItems.map(x => Number(x.id)).sort((a, b) => a - b);
  if (JSON.stringify(allOverrideIds) !== JSON.stringify([17])) bad(`人工覆盖应仅限 id=17，实际 ${JSON.stringify(allOverrideIds)}`);
  else console.log('  ✅ 人工覆盖仅作用于 id=17（未扩大到 29/34）');

  console.log(fail ? `\n❌ 共 ${fail} 项问题` : '\n✅ 只读校验全部通过');
  process.exitCode = fail ? 1 : 0;
})();
