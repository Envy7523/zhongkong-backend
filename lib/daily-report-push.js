'use strict';
/**
 * 项目侧「日报推送」执行体（供**既有日报路由**与新的**调度内部接口**共用）
 *
 * 设计原则：**不发明新的日报/推送逻辑**，只把既有路由里那段"逐门店生成图片并 POST webhook"的代码
 * 行为保持不变地抽出来，成为一个可注入依赖、可离线测试的函数。
 *
 * 返回语义（调度侧依赖它区分"未知"与"明确失败"）：
 *   { ok:true,  sent:true,  pushed:n, push_log_ids:[...] }                       已确实发出 n 条
 *   { ok:false, reason:'webhook_not_configured' }                               零副作用（未发出任何消息）
 *   { ok:false, unknown:true, reason:'push_timeout_unknown' }                   结果未知 → 必须人工处理
 *   { ok:false, reason:'push_partial'|'push_http_<code>'|'push_failed', ... }   明确失败
 */

/** 判定一个异常是否属于"请求已发出但结果未知" */
function isUnknownError(err) {
  const code = String((err && (err.code || err.errno)) || '');
  const msg = String((err && err.message) || err || '');
  if (/ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|EAI_AGAIN|UND_ERR|ABORT_ERR|socket hang up/i.test(code + ' ' + msg)) return true;
  if (/timeout|timed out|aborted|socket hang up|network/i.test(msg)) return true;
  return false;
}

/** 单次推送（单门店）——与既有路由逐字一致的行为：errcode===0 视为成功 */
async function pushOneStore({ store, ctx }) {
  const { cfg, httpPost, drawStoreDailyReport, toReportData, crypto, dailyStoreState } = ctx;
  if (store && typeof store !== 'object') return { ok: false, reason: 'bad_store' };
  let gen = store && dailyStoreState.generated ? dailyStoreState.generated[store.id] : null;
  if (!gen) {
    const { base64, buffer } = drawStoreDailyReport(toReportData(store));
    gen = { base64, md5: crypto.createHash('md5').update(buffer).digest('hex') };
  }
  const ir = await httpPost(cfg.webhook, { msgtype: 'image', image: { base64: gen.base64, md5: gen.md5 } });
  if (ir && ir.errcode === 0) {
    if (dailyStoreState.pushed) dailyStoreState.pushed[store.id] = true;
    return { ok: true };
  }
  return { ok: false, code: ir && ir.errcode, error: ir ? '[' + ir.errcode + '] ' + ir.errmsg : 'empty_response' };
}

/**
 * 推送全部门店日报（= 既有"推送全部门店日报"路由的同一逻辑）。
 * @param {object} ctx deps：{ cfg, httpPost, ensureDailyDataLoaded, dailyStoreState, drawStoreDailyReport, toReportData, crypto, db }
 */
async function pushAllStoreDailyReports(ctx) {
  const { cfg, httpPost, ensureDailyDataLoaded, dailyStoreData, db, now } = ctx;
  if (!cfg || !cfg.webhook) return { ok: false, sent: false, reason: 'webhook_not_configured' };
  if (typeof httpPost !== 'function') return { ok: false, sent: false, reason: 'http_post_missing' };
  try { if (typeof ensureDailyDataLoaded === 'function') ensureDailyDataLoaded(); }
  catch (e) { return { ok: false, sent: false, reason: 'daily_data_unavailable', detail: String(e && e.message).slice(0, 120) }; }
  const stores = (ctx.dailyStoreState && ctx.dailyStoreState.stores) || [];
  if (!stores.length) return { ok: false, sent: false, reason: 'no_stores' };
  const results = [];
  const pushLogIds = [];
  let sawUnknown = false;
  for (const s of stores) {
    try {
      const r = await pushOneStore({ store: s, ctx });
      if (r.ok) {
        results.push({ id: s.id, storeName: s.storeName, ok: true });
        if (db) {
          try {
            const sql = 'INSERT INTO push_logs (push_type,target,content_preview,status) VALUES (?,?,?,?)';
            const args = ['daily', (cfg.webhookName || ''), (s.storeName || '') + ' 日报（自动计划）', 'success'];
            const id = typeof db.insert === 'function' ? db.insert(sql, args) : (db.run(sql, args), (db.queryOne('SELECT id FROM push_logs ORDER BY id DESC LIMIT 1') || {}).id);
            if (id) pushLogIds.push(id);
            if (typeof db.save === 'function') db.save();
          } catch (_) { /* 审计写入失败不影响推送结果判定 */ }
        }
      } else {
        results.push({ id: s.id, storeName: s.storeName, ok: false, error: r.error });
        if (db) {
          try {
            const sql = 'INSERT INTO push_logs (push_type,target,content_preview,status,error_msg) VALUES (?,?,?,?,?)';
            const args = ['daily', (cfg.webhookName || ''), (s.storeName || '') + ' 日报（自动计划）', 'failed', String(r.error || '').slice(0, 120)];
            if (typeof db.insert === 'function') db.insert(sql, args); else db.run(sql, args);
            if (typeof db.save === 'function') db.save();
          } catch (_) { /* ignore */ }
        }
      }
    } catch (e) {
      if (isUnknownError(e)) { sawUnknown = true; results.push({ id: s.id, storeName: s.storeName, ok: false, unknown: true }); }
      else results.push({ id: s.id, storeName: s.storeName, ok: false, error: String(e && e.message).slice(0, 120) });
    }
  }
  const pushed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && !r.unknown).length;
  const unknownCount = results.filter((r) => r.unknown).length;
  if (pushed === results.length && results.length > 0) return { ok: true, sent: true, pushed, push_log_ids: pushLogIds, results, at: now ? now() : new Date().toISOString() };
  if (unknownCount > 0) return { ok: false, sent: false, unknown: true, reason: 'push_timeout_unknown', pushed, push_log_ids: pushLogIds };
  if (pushed > 0) return { ok: false, sent: false, reason: 'push_partial', pushed, failed, push_log_ids: pushLogIds };
  return { ok: false, sent: false, reason: 'push_failed', pushed: 0, failed, push_log_ids: pushLogIds };
}

module.exports = { pushAllStoreDailyReports, pushOneStore, isUnknownError };
