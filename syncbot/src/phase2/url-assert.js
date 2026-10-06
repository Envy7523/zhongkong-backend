'use strict';
/**
 * 阶段2：URL 分段断言（禁止宽匹配）
 * 规则来源：config/meituan-rules.json → download_list_locator.url_assertion
 *          以及 navigation.steps 中每步的期望 URL。
 *
 * 判定方式：解析 URL 后逐段比对 protocol / host / pathname / hash，四段全等才通过。
 * 明确禁止：includes / startsWith / substring / regex 部分匹配 / 只比 host / 只看路径片段。
 */
const { URL } = require('url');

const FORBIDDEN_MODES = ['includes', 'startsWith', 'substring', 'regex_partial', 'host_only', 'path_fragment_only'];

function parse(u) {
  const x = new URL(u);
  return { protocol: x.protocol, host: x.host, hostname: x.hostname, pathname: x.pathname, hash: x.hash, search: x.search };
}

/**
 * @param {string} actual 当前页面 URL
 * @param {object} expect {protocol, host, pathname, hash}
 * @returns {{ok:boolean, segments:object, mismatches:Array}}
 */
function assertSegments(actual, expect) {
  const a = parse(actual);
  const segments = {};
  const mismatches = [];
  for (const k of ['protocol', 'host', 'pathname', 'hash']) {
    if (expect[k] === undefined || expect[k] === null) continue;
    const ok = a[k] === expect[k];
    segments[k] = { expected: expect[k], actual: a[k], ok };
    if (!ok) mismatches.push(`${k}: 期望 ${JSON.stringify(expect[k])} ≠ 实际 ${JSON.stringify(a[k])}`);
  }
  return {
    ok: mismatches.length === 0,
    segments,
    mismatches,
    query_string: a.search || '',
    query_string_policy: '查询串不参与判定；若存在则记入审计，不得替代 hash 判定',
    match_mode: 'segment_equality_all_required',
    forbidden_match_modes: FORBIDDEN_MODES,
  };
}

/** 从 meituan-rules.json 的 URL 字面量构造期望段 */
function expectFromFullUrl(fullUrl) {
  const p = parse(fullUrl);
  return { protocol: p.protocol, host: p.host, pathname: p.pathname, hash: p.hash };
}

/** 便捷：判断若干期望 URL 中最匹配的一个（用于导航步骤校验，仍为逐段相等判定） */
function matchAny(actual, candidates) {
  for (const c of candidates) {
    const r = assertSegments(actual, expectFromFullUrl(c));
    if (r.ok) return { matched: c, result: r };
  }
  return { matched: null, result: assertSegments(actual, expectFromFullUrl(candidates[0])) };
}

module.exports = { assertSegments, expectFromFullUrl, matchAny, parse, FORBIDDEN_MODES };
