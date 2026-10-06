'use strict';
/**
 * 门店映射台账 + **在营清单可信度判定**（只读纯函数；无网络、无数据库、无文件 IO、无模糊匹配）
 *
 * 冻结口径：
 *  1. 台账只负责「源门店名 → 项目门店 ID」的**精确**映射，**不判断在营与否**；
 *     允许且仅允许：完全一致、去首尾空格并折叠连续空格后完全一致；
 *     **严禁**双向包含 / 模糊 / 相似度 / LIKE；同一源名对应多个不同 id ⇒ 歧义（不猜）。
 *  2. 「在营」只来自中控只读接口 GET /api/internal/syncbot/coverage 的
 *     active_stores:[{id,name}]（由调用方**原样注入**），本模块不推断、不直连项目库。
 *  3. **在营清单不可信 ⇒ 一律转人工（WAITING_HUMAN，零导入零推送）**，且**不得**继续做
 *     absent / mapping 覆盖判断。不可信 = 下列任一：
 *       · ok !== true（含 coverage_query_failed）
 *       · active_stores === null / 非数组（**禁止**把 null 当作"没有在营门店"）
 *       · truncated === true（被截断的清单不得用于 absent / 覆盖判定）
 *       · active_stores_basis 缺失或为空
 *     只有 ok===true && Array.isArray(active_stores) && truncated!==true && active_stores_basis 非空
 *     才允许判定；其中 length===0 是**合法空集**（例如全部闭店）⇒ 只审计、不因 absent 失败。
 *  4. **阶段 1 判据（最终口径）**：active_stores_basis_confirmed !== true（中控侧尚未确认真实在营判定）
 *     ⇒ 与"basis 缺失"同级，判为 **untrusted** ⇒ **WAITING_HUMAN（零导入零推送）**，
 *     不得据此自动判定 absent。
 *     兼容开关：调用方显式传 allowUnconfirmedBasis:true 时降级为旧行为 ——
 *     absent 记 **unconfirmed**（只写审计、不失败），但**未知门店仍阻断 ⇒ WAITING_HUMAN**。
 *     默认（不传）= 严格 fail-closed。
 */

/** 去首尾空格并折叠连续空白 */
function normName(v) {
  return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
}
/** 折叠后的比较键（去所有空白） */
function keyName(v) {
  return normName(v).replace(/\s/g, '');
}
function toId(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 建索引。mappingJson 为 config/store-mapping.json 的解析结果（或 null）。
 * 只收 confirmed===true 且 project_store_id 有效的条目；未确认条目一律不参与映射。
 */
function buildLedger(mappingJson) {
  const j = mappingJson && typeof mappingJson === 'object' ? mappingJson : null;
  const mappings = (j && j.mappings && typeof j.mappings === 'object') ? j.mappings : {};
  const byName = new Map();
  const byKey = new Map();
  const confirmed = [];
  let skipped_unconfirmed = 0;
  for (const [source, v] of Object.entries(mappings)) {
    const id = toId(v && v.project_store_id);
    if (!v || v.confirmed !== true || id === null) { skipped_unconfirmed += 1; continue; }
    const entry = { source: normName(source), id: id, match_method: (v && (v.match_method || v.draft_match_method)) || null };
    if (!entry.source) { skipped_unconfirmed += 1; continue; }
    confirmed.push(entry);
    if (!byName.has(entry.source)) byName.set(entry.source, entry);
    const k = keyName(entry.source);
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(entry.id);
  }
  // 报表专属排除：门店可在公司主档正常营业，但未接入本报表的数据源。
  // 该配置绝不修改主档状态，也不适用于其它平台/报表。
  const excluded_ids = new Set();
  const exclusions = (j && Array.isArray(j.cashier_composite_exclusions)) ? j.cashier_composite_exclusions : [];
  for (const item of exclusions) {
    const id = toId(item && (item.project_store_id !== undefined ? item.project_store_id : item.id));
    if (!item || item.confirmed !== true || item.reason !== 'not_using_company_cashier_system' || id === null) continue;
    excluded_ids.add(id);
  }
  return {
    available: !!j,
    status: j ? (j.status || null) : null,
    confirmed_at: j ? (j.confirmed_at || null) : null,
    confirmed: confirmed,
    byName: byName,
    byKey: byKey,
    source_count: Object.keys(mappings).length,
    confirmed_count: confirmed.length,
    skipped_unconfirmed: skipped_unconfirmed,
    covered_ids: new Set(confirmed.map((e) => e.id)),
    excluded_ids: excluded_ids,
  };
}

/**
 * 精确匹配一个源门店名。返回：
 *   { ok:true, id, via:'name_exact'|'name_whitespace_normalized' }
 *   { ok:false, reason:'empty'|'unknown'|'ambiguous'|'ledger_unavailable', candidates? }
 * 绝不返回“最相似”的猜测结果。
 */
function matchStoreName(name, ledger) {
  const n = normName(name);
  if (!n) return { ok: false, reason: 'empty', name: n };
  if (!ledger || !ledger.available || !(ledger.byKey instanceof Map)) {
    return { ok: false, reason: 'ledger_unavailable', name: n };
  }
  const ids = ledger.byKey.get(keyName(n));
  if (!ids || ids.size === 0) return { ok: false, reason: 'unknown', name: n };
  if (ids.size > 1) return { ok: false, reason: 'ambiguous', name: n, candidates: [...ids].sort((a, b) => a - b) };
  const exact = ledger.byName.get(n);
  const id = [...ids][0];
  return { ok: true, name: n, id: id, via: exact && exact.source === n ? 'name_exact' : 'name_whitespace_normalized' };
}

/** 把 [{id,name}]（中控 coverage 响应字段）规整为稳定顺序；非数组 ⇒ null（**不**退化为空集） */
function normalizeActiveStores(activeStores) {
  if (!Array.isArray(activeStores)) return null;
  return activeStores
    .map((s) => ({ id: toId(s && (s.id !== undefined ? s.id : s.store_id)), name: normName(s && (s.name || s.store_name)) }))
    .filter((s) => s.id !== null)
    .sort((a, b) => a.id - b.id);
}

/** 覆盖输入的归一（只做结构识别，不做可信度结论） */
function normalizeCoverageInput(input) {
  if (Array.isArray(input)) {
    // 裸数组：**没有** basis ⇒ 交由 assessActiveStores 判为不可信（fail-closed）。
    // 离线套件/调用方必须传中控 coverage 应答对象（含 basis / truncated / basis_confirmed）。
    return { present: true, ok: true, active_stores: input, truncated: false, active_stores_basis: null, active_stores_basis_confirmed: false, shape: 'array' };
  }
  if (!input || typeof input !== 'object') return { present: false, ok: false, active_stores: null, truncated: false, active_stores_basis: null, active_stores_basis_confirmed: false, shape: 'missing' };
  const raw = (input.coverage && typeof input.coverage === 'object') ? input.coverage : input;
  const bd = (raw.business_date === undefined || raw.business_date === null) ? null : String(raw.business_date);
  return {
    present: true,
    shape: 'object',
    ok: raw.ok === true,
    active_stores: raw.active_stores === undefined ? null : raw.active_stores,
    truncated: raw.truncated === true,
    active_stores_basis: normName(raw.active_stores_basis) || null,
    active_stores_basis_confirmed: raw.active_stores_basis_confirmed === true,
    business_date: bd,
  };
}

/**
 * **在营清单可信度判定**（硬规则，单一权威；调用方不得自行放宽）。
 * @returns {{trust:'trusted'|'trusted_empty'|'untrusted', reason:string|null, stores:Array|null,
 *            basis:string|null, basis_confirmed:boolean, active_count:number|null, shape:string}}
 */
function assessActiveStores(input, opts = {}) {
  const allowUnconfirmedBasis = opts.allowUnconfirmedBasis === true;
  const c = normalizeCoverageInput(input);
  const base = { basis: c.active_stores_basis, basis_confirmed: c.active_stores_basis_confirmed === true, shape: c.shape };
  if (!c.present) return Object.assign({ trust: 'untrusted', reason: 'active_stores_unavailable', stores: null, active_count: null }, base);
  if (c.ok !== true) return Object.assign({ trust: 'untrusted', reason: 'active_stores_query_failed', stores: null, active_count: null }, base);
  if (!Array.isArray(c.active_stores)) return Object.assign({ trust: 'untrusted', reason: 'active_stores_missing', stores: null, active_count: null }, base);
  if (c.truncated === true) return Object.assign({ trust: 'untrusted', reason: 'active_stores_truncated', stores: null, active_count: null }, base);
  if (!c.active_stores_basis) return Object.assign({ trust: 'untrusted', reason: 'active_stores_basis_missing', stores: null, active_count: null }, base);
  // 阶段 1 判据：basis **未确认** 与 basis 缺失同级 —— 一律 fail-closed（除非调用方显式启用兼容开关）
  if (c.active_stores_basis_confirmed !== true && !allowUnconfirmedBasis) {
    return Object.assign({ trust: 'untrusted', reason: 'active_stores_basis_unconfirmed', stores: null, active_count: null }, base);
  }
  const list = normalizeActiveStores(c.active_stores);
  if (!list.length) return Object.assign({ trust: 'trusted_empty', reason: null, stores: [], active_count: 0 }, base);
  return Object.assign({ trust: 'trusted', reason: null, stores: list, active_count: list.length }, base);
}

/**
 * 映射台账覆盖率。**只在在营清单可信时**才给出覆盖率结论；
 * 不可信 ⇒ ok=false + reason='active_stores_untrusted:<cause>'（调用方据此转人工）。
 * trusted_empty（合法空集）⇒ 覆盖率空真（ok:true，uncovered=[]）。
 * basis_confirmed===false ⇒ 结论仍返回（但 basis_confirmed=false），是否豁免阻断由调用方决定。
 */
function checkCoverage({ ledger, coverage, allowUnconfirmedBasis = false } = {}) {
  const asmt = (coverage && coverage.trust) ? coverage : assessActiveStores(coverage, { allowUnconfirmedBasis: allowUnconfirmedBasis });
  if (!ledger || !ledger.available) return { ok: false, reason: 'ledger_unavailable', uncovered: [], detail: '映射台账不可读', trust: asmt.trust, basis_confirmed: asmt.basis_confirmed };
  if (ledger.status !== 'confirmed') return { ok: false, reason: 'ledger_not_confirmed', uncovered: [], detail: '映射台账 status=' + ledger.status, trust: asmt.trust, basis_confirmed: asmt.basis_confirmed };
  if (!ledger.confirmed_count) return { ok: false, reason: 'ledger_empty', uncovered: [], detail: '映射台账无 confirmed 条目', trust: asmt.trust, basis_confirmed: asmt.basis_confirmed };
  if (asmt.trust === 'untrusted') {
    return { ok: false, reason: 'active_stores_untrusted:' + asmt.reason, uncovered: [], detail: '在营清单不可信（' + asmt.reason + '）⇒ 不得做映射覆盖判断，一律转人工', trust: asmt.trust, basis_confirmed: asmt.basis_confirmed };
  }
  if (asmt.trust === 'trusted_empty') {
    return { ok: true, reason: null, uncovered: [], covered_count: 0, active_count: 0, detail: '在营清单为**合法空集**（0 家在营）⇒ 覆盖率空真（仅审计）', trust: asmt.trust, basis_confirmed: asmt.basis_confirmed };
  }
  const excluded = asmt.stores.filter((s) => ledger.excluded_ids instanceof Set && ledger.excluded_ids.has(s.id));
  const eligible = asmt.stores.filter((s) => !(ledger.excluded_ids instanceof Set) || !ledger.excluded_ids.has(s.id));
  const uncovered = eligible.filter((s) => !ledger.covered_ids.has(s.id));
  return {
    ok: uncovered.length === 0,
    reason: uncovered.length ? 'uncovered_active_stores' : null,
    uncovered: uncovered,
    covered_count: eligible.length - uncovered.length,
    active_count: eligible.length,
    excluded_active_stores: excluded,
    trust: asmt.trust,
    basis_confirmed: asmt.basis_confirmed,
    detail: '报表适用在营 ' + eligible.length + ' 家，已确认映射覆盖 ' + (eligible.length - uncovered.length) + ' 家，缺映射 ' + uncovered.length + ' 家；数据源不适用排除 ' + excluded.length + ' 家',
  };
}

/**
 * absent 审计（**只记录，不失败、不补零**）：
 *   absent = 主档在营门店 − 文件出现的门店（按 project_store_id 比较）。
 *   · 在营清单不可信 ⇒ status:'unknown'（**不得**据此判定"未出现门店"，也不产生 absent 记录）；
 *   · 合法空集 ⇒ status:'known'、absent=[]（0 家在营，无缺席）；
 *   · basis_confirmed===false ⇒ status:'unconfirmed'（只写审计、不失败）。
 */
function computeAbsent({ coverage, fileMappedIds, excludedStoreIds = null, allowUnconfirmedBasis = false } = {}) {
  const asmt = (coverage && coverage.trust) ? coverage : assessActiveStores(coverage, { allowUnconfirmedBasis: allowUnconfirmedBasis });
  if (asmt.trust === 'untrusted') {
    return { status: 'unknown', reason: asmt.reason, absent: [], absent_count: null, active_count: null, matched_count: null, basis_confirmed: asmt.basis_confirmed };
  }
  if (asmt.trust === 'trusted_empty') {
    return { status: 'known', reason: null, absent: [], absent_count: 0, active_count: 0, matched_count: 0, basis_confirmed: asmt.basis_confirmed };
  }
  const got = new Set(Array.isArray(fileMappedIds) ? fileMappedIds.filter((x) => x !== null && x !== undefined) : []);
  const excluded = excludedStoreIds instanceof Set ? excludedStoreIds : new Set();
  const eligible = asmt.stores.filter((s) => !excluded.has(s.id));
  const absent = eligible.filter((s) => !got.has(s.id));
  const confirmed = asmt.basis_confirmed === true;
  return {
    status: confirmed ? 'known' : 'unconfirmed',
    reason: confirmed ? null : 'active_stores_basis_unconfirmed',
    absent: absent,
    absent_count: absent.length,
    active_count: eligible.length,
    matched_count: eligible.length - absent.length,
    basis_confirmed: confirmed,
  };
}

module.exports = {
  normName, keyName, buildLedger, matchStoreName,
  normalizeActiveStores, normalizeCoverageInput, assessActiveStores,
  checkCoverage, computeAbsent,
};
