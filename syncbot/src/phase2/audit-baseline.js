'use strict';
/**
 * 历史审计文件「基线对比」工具（**只读**）
 *
 * 背景（必须遵守的测试原则）：
 *   历史证据类自检**不得把历史行数/条数硬编码**（例如早期断言「行数=3」）。
 *   真实下载会让 state/downloads-meituan.jsonl 自然增长（现已含 1 条真实下载记录），
 *   硬编码常量会让正确的历史被误判为回归。
 *
 * 正确做法：
 *   测试开始时 snapshot() 采集基线 → 测试结束时 verifyUnchanged() 断言
 *   「本测试没有改变基线」（逐字节 + 行数），并断言基线**末条**（最新历史真实下载记录）
 *   仍然逐字保留（未被删除、未被改写）。
 *
 * 本模块不做任何写入。
 */
const fs = require('fs');
const crypto = require('crypto');

/** 只读快照：整文件字节 + sha256 + 行数组 + 末条原始文本 */
function snapshot(file) {
  try {
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    return {
      exists: true,
      path: file,
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      text,
      lines,
      tail: lines.length ? lines[lines.length - 1] : null,
      line_count: lines.length,
    };
  } catch (e) {
    return { exists: false, path: file, error: e.message, size: null, sha256: null, text: '', lines: [], tail: null, line_count: 0 };
  }
}

/** 末条事件摘要（仅用于 detail 展示，不参与判定） */
function tailEvent(baseline) {
  try {
    const o = JSON.parse(baseline && baseline.tail);
    return `${o.event}@${o.at}`;
  } catch {
    return null;
  }
}

/**
 * 断言 after 与 baseline 完全一致。
 * @returns {{ok:boolean, problems:string[], tail_preserved:boolean, tail_event:string|null, before:object|null, after:object|null}}
 */
function verifyUnchanged(baseline, after) {
  const problems = [];
  if (!baseline || !baseline.exists) problems.push('baseline_missing');
  if (!after || !after.exists) problems.push('after_missing');
  if (baseline && after && baseline.exists && after.exists) {
    if (after.sha256 !== baseline.sha256) problems.push('content_changed');
    if (after.size !== baseline.size) problems.push('size_changed');
    if (after.line_count !== baseline.line_count) problems.push(`line_count_changed(${baseline.line_count}->${after.line_count})`);
  }
  const tailPreserved = !!(baseline && baseline.tail && after && after.text && after.text.includes(baseline.tail));
  if (!tailPreserved) problems.push('historical_tail_lost');
  return {
    ok: problems.length === 0,
    problems,
    tail_preserved: tailPreserved,
    tail_event: tailEvent(baseline),
    before: baseline && baseline.exists ? { lines: baseline.line_count, size: baseline.size, sha256: baseline.sha256 } : null,
    after: after && after.exists ? { lines: after.line_count, size: after.size, sha256: after.sha256 } : null,
  };
}

/** 供自检输出用的可读摘要 */
function summarize(v) {
  const b = v.before ? `lines=${v.before.lines} size=${v.before.size} sha=${String(v.before.sha256).slice(0, 12)}` : 'absent';
  const a = v.after ? `lines=${v.after.lines} size=${v.after.size} sha=${String(v.after.sha256).slice(0, 12)}` : 'absent';
  return `before[${b}] -> after[${a}] tail=${v.tail_event || 'n/a'}${v.problems.length ? ' problems=' + v.problems.join(',') : ''}`;
}

module.exports = { snapshot, verifyUnchanged, tailEvent, summarize };
