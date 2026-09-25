'use strict';

const crypto = require('node:crypto');
const { buildPosDailyPreview } = require('./pos-daily-preview');
const { renderPosDailyImage } = require('./pos-daily-image');
const { isUnknownError } = require('./daily-report-push');

function scope(db) {
  const rows = db.queryAll('SELECT store_id,reason FROM pos_daily_scope_exclusions');
  return Object.fromEntries(rows.map(row => [Number(row.store_id), String(row.reason)]));
}
function preview(db, businessDate) {
  return buildPosDailyPreview(db, businessDate, { excludedStores: scope(db) });
}
function route(db) {
  return db.queryOne("SELECT r.enabled AS route_enabled,r.bot_id,b.name AS bot_name,b.webhook_url,b.enabled AS bot_enabled FROM wecom_message_routes r LEFT JOIN wecom_webhook_bots b ON b.id=r.bot_id WHERE r.message_code='pos_daily'");
}
function routeReady(db) {
  const target = route(db);
  return Boolean(target && Number(target.route_enabled) === 1 && target.bot_id && Number(target.bot_enabled) === 1 && target.webhook_url);
}
function preflight(db, businessDate) {
  let target;
  try { target = route(db); } catch { return { ok: false, reason: 'pos_daily_route_unavailable' }; }
  if (!target || Number(target.route_enabled) !== 1 || !target.bot_id || Number(target.bot_enabled) !== 1 || !target.webhook_url)
    return { ok: false, reason: 'pos_daily_route_not_active' };
  let data;
  try { data = preview(db, businessDate); } catch { return { ok: false, reason: 'pos_daily_preview_failed' }; }
  if (!data.ready || !data.store_count) return { ok: false, reason: 'pos_daily_data_incomplete', problems: data.problems };
  return { ok: true, target, data };
}
async function pushPosDaily({ db, business_date: businessDate, httpPost }) {
  const checked = preflight(db, businessDate);
  if (!checked.ok) return { ...checked, sent: false };
  if (typeof httpPost !== 'function') return { ok: false, sent: false, reason: 'http_post_missing' };
  const image = renderPosDailyImage(checked.data);
  const payload = { msgtype: 'image', image: { base64: image.base64, md5: crypto.createHash('md5').update(image.buffer).digest('hex') } };
  let response;
  try { response = await httpPost(checked.target.webhook_url, payload); }
  catch (error) {
    if (isUnknownError(error)) return { ok: false, sent: false, unknown: true, reason: 'push_timeout_unknown' };
    return { ok: false, sent: false, reason: 'push_failed', detail: String(error?.message || error).slice(0, 120) };
  }
  if (!response || response.errcode !== 0) return { ok: false, sent: false, reason: `push_http_${response?.errcode ?? 'empty'}` };
  let id = null;
  let auditError = false;
  try {
    id = db.insert('INSERT INTO push_logs(push_type,target,content_preview,status) VALUES (?,?,?,?)',
      ['pos_daily', checked.target.bot_name, `${businessDate} 收银系统每日高低位数据（${checked.data.store_count}家门店）`, 'success']);
    db.save();
  } catch { auditError = true; }
  // 平台已返回成功，审计失败也不能改写为“发送结果未知”并触发人工重发。
  return { ok: true, sent: true, pushed: 1, push_log_ids: id ? [id] : [], audit_error: auditError };
}

module.exports = { preview, preflight, pushPosDaily, routeReady };
