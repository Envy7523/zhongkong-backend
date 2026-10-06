'use strict';
/**
 * 审计发送队列 + **有界** whenIdle
 *
 * 为什么有界：中控长期不可达时，审计绝不能无限阻塞任务退出或人工处置。
 * 超时不是"丢事件"——事件已在 outbox 落盘为 pending，稍后 flush 可补送；超时只意味着
 * 「不再等这条事件的 HTTP 结果」，并记录 audit_pending（原因码 audit_idle_timeout）后放行。
 */
const DEFAULT_IDLE_TIMEOUT_MS = 5000;

function createIdleQueue({ defaultTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, onTimeout = null } = {}) {
  let chain = Promise.resolve();
  let depth = 0;

  /** 串行入队（并发 1，保证发送顺序与业务阶段顺序一致）；返回本次发送的 promise（永不 reject 到调用方之外） */
  function enqueue(fn) {
    depth += 1;
    const run = chain.then(() => fn());
    chain = run.then(() => {}, () => {});
    return run.then(
      (v) => { depth -= 1; return v; },
      (e) => { depth -= 1; throw e; },
    );
  }

  /**
   * 等待队列清空；超时（默认 5s，可配置）立即返回，绝不无限等待。
   * @returns {{ok:boolean,timed_out:boolean,pending_sends:number,waited_ms:number,timeout_ms?:number}}
   */
  async function whenIdle(opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Number(opts.timeoutMs) : defaultTimeoutMs;
    const started = Date.now();
    if (depth === 0) return { ok: true, timed_out: false, pending_sends: 0, waited_ms: 0, timeout_ms: timeoutMs };
    let timer = null;
    const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    const settled = await Promise.race([chain.then(() => 'idle', () => 'idle'), timedOut]);
    if (timer) clearTimeout(timer);
    const waited = Date.now() - started;
    if (settled === 'timeout' && depth > 0) {
      const info = { ok: false, timed_out: true, pending_sends: depth, waited_ms: waited, timeout_ms: timeoutMs };
      if (typeof onTimeout === 'function') { try { onTimeout(info); } catch (_) {} }
      return info;
    }
    return { ok: true, timed_out: false, pending_sends: depth, waited_ms: waited, timeout_ms: timeoutMs };
  }

  return { enqueue, whenIdle, size: () => depth };
}

module.exports = { createIdleQueue, DEFAULT_IDLE_TIMEOUT_MS };
