'use strict';
/** 每份收银报表独立同步计划。A 继续使用既有 schedule_config，避免双重真相。 */
const { localParts, nextRunAt, isValidHHmm } = require('./schedule-core');
const PREFIX = '/api/enterprise-settings/report-sync-plans';
const INTERNAL = '/api/internal/syncbot/report-sync-plans';
const REPORTS = Object.freeze({
  ...Object.fromEntries(['taobao_flash','jd_delivery'].flatMap(platform=>['operating','product','settlement'].map(type=>[platform+'_'+type,{name:(platform==='taobao_flash'?'淘宝闪购':'京东外卖')+({operating:'营业日报',product:'商品销量',settlement:'结算账单'}[type]),defaultTime:platform==='taobao_flash'?'03:00':'02:00',defaultEnabled:false,platform:platform==='taobao_flash'?'淘宝闪购':'京东外卖',sourceSite:'平台品牌后台',category:'delivery'}]))),
  douyin_group_reviews: { name: '抖音门店评价', defaultTime: '04:00', defaultEnabled: false, platform: '抖音团购', sourceSite: '抖音来客', category: 'group', collection: 'douyin_reviews', scopeNote: '每天更新近七天评价、商家回复、门店评分与评价统计；保留完整历史评价' },
  douyin_group_report2: { name: '抖音团购门店经营报表', defaultTime: '04:00', defaultEnabled: false, platform: '抖音团购', sourceSite: '抖音生意经', category: 'group', collection: 'douyin_report2', scopeNote: '每天按日更新前一天经营数据；11项原始指标与4项转化率；历史补录独立执行' },
  cashier_composite: { name: '综合营业统计', defaultTime: '01:05' },
  item_sales_detail: { name: '品项销售明细', defaultTime: '03:20' },
  all_channel_orders: { name: '全渠道订单明细（新版）', defaultTime: '05:20', scopeNote: '每日采集前一完整营业日全部订单及付款、退款构成；用于堂食逐笔手续费计算；不发送日报' },
  member_card_transactions: { name: '会员卡交易流水表', defaultTime: '06:20', defaultEnabled: false, scopeNote: '每日采集前一完整交易日全部门店、全部操作；ZIP全部分片校验，本金赠金与退款独立保存；不发送日报' },
  pos_bookkeeping_daily: { name: '门店收支统计', defaultTime: '02:00' },
  meituan_delivery_product: { name:'美团外卖商品销量明细',defaultTime:'01:00',defaultEnabled:false,platform:'美团外卖',sourceSite:'美团外卖品牌后台',category:'delivery' },
  meituan_delivery_settlement: { name:'美团外卖结算与费用明细',defaultTime:'01:00',defaultEnabled:false,platform:'美团外卖',sourceSite:'美团外卖品牌后台',category:'delivery' },
  meituan_delivery_operating: { name: '美团外卖营业表', defaultTime: '01:00', platform: '美团外卖', sourceSite: '美团外卖品牌后台' },
  meituan_group_report1: { name: '美团团购收益明细', defaultTime: '03:00', platform: '美团团购', sourceSite: '美团经营宝', category: 'group', collection: 'report1' },
  meituan_group_report2: { name: '美团团购经营参谋报表', defaultTime: '03:00', platform: '美团团购', sourceSite: '美团经营宝', category: 'group', collection: 'report2' },
  douyin_group_report1: { name: '抖音团购账单', defaultTime: '04:00', defaultEnabled: false, platform: '抖音团购', sourceSite: '抖音来客', category: 'group', collection: 'douyin_report1', scopeNote: '每天更新前一天账单；首次历史补录独立执行；等待生成与下载完成后校验导入' },
  meituan_group_reviews: { name: '美团与点评评价', defaultTime: '03:00', platform: '美团团购', sourceSite: '美团经营宝', category: 'group', collection: 'reviews', scopeNote: '首次全量采集后，每次更新近七天评价；云端正式入库仍暂停' },
});
function conflictWithPlans(runTime, peers, minimumMinutes = 60) {
  const at = Number(runTime.slice(0, 2)) * 60 + Number(runTime.slice(3, 5));
  return peers.find(p => {
    if (!p || !p.enabled || !isValidHHmm(p.run_time)) return false;
    const other = Number(p.run_time.slice(0, 2)) * 60 + Number(p.run_time.slice(3, 5));
    const distance = Math.abs(at - other);
    return Math.min(distance, 1440 - distance) < minimumMinutes;
  }) || null;
}

function mountReportSyncPlans({ app, db, permissions, audit, logger = () => {} }) {
  const log = (event, extra) => { try { logger(event, extra); } catch (_) {} };
  let schemaReady = false;
  function ready() {
    if (schemaReady) return;
    db.run(`CREATE TABLE IF NOT EXISTS report_sync_plans (
      report_type TEXT PRIMARY KEY, enabled INTEGER NOT NULL, run_time TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT, updated_by INTEGER, updated_by_name TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS report_sync_plan_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, report_type TEXT NOT NULL, at TEXT NOT NULL,
      user_id INTEGER, user_name TEXT, before_json TEXT NOT NULL, after_json TEXT NOT NULL)`);
    for (const type of ['item_sales_detail', 'pos_bookkeeping_daily', 'all_channel_orders','member_card_transactions']) {
      db.run('INSERT OR IGNORE INTO report_sync_plans (report_type,enabled,run_time,updated_at) VALUES (?,?,?,?)',
        [type, REPORTS[type].defaultEnabled === false ? 0 : 1, REPORTS[type].defaultTime, new Date().toISOString()]);
    }
    db.run('INSERT OR IGNORE INTO report_sync_plans (report_type,enabled,run_time,updated_at) VALUES (?,?,?,?)',
      ['meituan_delivery_operating', 0, REPORTS.meituan_delivery_operating.defaultTime, new Date().toISOString()]);
    for (const type of Object.keys(REPORTS).filter(type => ['group','delivery'].includes(REPORTS[type].category))) {
      db.run('INSERT OR IGNORE INTO report_sync_plans (report_type,enabled,run_time,updated_at) VALUES (?,?,?,?)',
        [type, REPORTS[type].defaultEnabled === false ? 0 : 1, REPORTS[type].defaultTime, new Date().toISOString()]);
    }
    db.save();
    schemaReady = true;
  }
  function plan(type) {
    if (!REPORTS[type]) return null;
    if (type === 'cashier_composite') {
      const row = db.queryOne('SELECT sync_enabled,sync_time,updated_at,version FROM schedule_config WHERE id=1');
      if (!row) return null;
      return { report_type: type, category: 'system', platform: '收银系统', source_site: '美团管家', name: REPORTS[type].name,
        enabled: Number(row.sync_enabled) === 1, run_time: row.sync_time, timezone: 'Asia/Shanghai',
        updated_at: row.updated_at || null, version: Number(row.version || 1), managed_by: 'legacy_a_schedule' };
    }
    const row = db.queryOne('SELECT * FROM report_sync_plans WHERE report_type=?', [type]);
    if (!row) return null;
    return { report_type: type, category: REPORTS[type].category || (type === 'meituan_delivery_operating' ? 'delivery' : 'system'), scope_note: REPORTS[type].scopeNote || null, platform: REPORTS[type].platform || '收银系统', source_site: REPORTS[type].sourceSite || '美团管家', name: REPORTS[type].name,
      enabled: Number(row.enabled) === 1, run_time: row.run_time, timezone: row.timezone,
      updated_at: row.updated_at || null, version: Number(row.version || 1), managed_by: 'report_sync_plans' };
  }
  function userAllowed(req, res) {
    const user = req.user;
    if (!user?.id) { res.status(401).json({ ok: false, reason: 'login_required' }); return null; }
    const row = db.queryOne('SELECT p.permissions_json FROM users u LEFT JOIN position_settings p ON p.id=u.position_id WHERE u.id=?', [user.id]);
    if (!permissions.can(permissions.normalizePermissions(row?.permissions_json), 'enterprise-settings.manage')) {
      res.status(403).json({ ok: false, reason: 'permission_denied' }); return null;
    }
    return user;
  }
  function internalAllowed(req, res) {
    if (req.get('x-forwarded-for') || req.get('x-real-ip') || req.get('via') || req.get('forwarded')
      || !/^(127\.|::1$|::ffff:127\.)/.test(req.socket?.remoteAddress || '')) {
      res.status(403).json({ ok: false, reason: 'loopback_required' }); return false;
    }
    const secret = audit.loadSecret();
    const timestamp = String(req.get('x-syncbot-timestamp') || '');
    if (!secret || !audit.timestampAcceptable(timestamp).ok
      || !audit.verifySignature({ secret, timestamp, signature: req.get('x-syncbot-signature'), rawBody: '' }).ok) {
      res.status(401).json({ ok: false, reason: 'signature_invalid' }); return false;
    }
    return true;
  }
  app.get(PREFIX, (req, res) => {
    try {
      ready(); if (!userAllowed(req, res)) return;
      const now = new Date();
      res.json({ ok: true, timezone: 'Asia/Shanghai', plans: Object.keys(REPORTS).map((type) => {
        const p = plan(type);
        return { ...p, next_run_at: p && nextRunAt({ now, time: p.run_time, enabled: p.enabled }) };
      }) });
    } catch (e) { log('report_plans.read_failed', { error: String(e.message).slice(0, 80) }); res.status(503).json({ ok: false, reason: 'plan_unavailable' }); }
  });
  app.post(PREFIX + '/:reportType', (req, res) => {
    try {
      ready(); const user = userAllowed(req, res); if (!user) return;
      const type = String(req.params.reportType || '');
      if (!REPORTS[type]) return res.status(404).json({ ok: false, reason: 'report_unknown' });
      if (type === 'cashier_composite') return res.status(409).json({ ok: false, reason: 'use_existing_a_schedule' });
      const body = req.body || {};
      if (Object.keys(body).some(k => !['enabled', 'run_time'].includes(k))
        || typeof body.enabled !== 'boolean' || !isValidHHmm(body.run_time)) {
        return res.status(400).json({ ok: false, reason: 'invalid_plan' });
      }
      const before = plan(type);
      if (before.enabled === body.enabled && before.run_time === body.run_time) return res.json({ ok: true, plan: before, changed: false });
      if (body.enabled && REPORTS[type].category !== 'group') {
        const minimumMinutes = type === 'pos_bookkeeping_daily' ? 45 : 60;
        const conflict = conflictWithPlans(body.run_time, Object.keys(REPORTS).filter(k => k !== type && (before.category === 'delivery' ? (REPORTS[k].category === 'delivery' || k === 'meituan_delivery_operating') && REPORTS[k].platform !== REPORTS[type].platform : REPORTS[k].sourceSite === REPORTS[type].sourceSite)).map(plan),
          minimumMinutes);
        if (conflict) return res.status(409).json({ ok: false, reason: 'sync_time_conflict',
          error: `与「${conflict.name}」同步时间相隔不足 ${minimumMinutes} 分钟，请错开同一采集站点的报表。` });
      }
      const at = new Date().toISOString();
      db.run('UPDATE report_sync_plans SET enabled=?,run_time=?,version=version+1,updated_at=?,updated_by=?,updated_by_name=? WHERE report_type=?',
        [body.enabled ? 1 : 0, body.run_time, at, user.id, user.name || user.username || '', type]);
      const after = plan(type);
      db.run('INSERT INTO report_sync_plan_audit (report_type,at,user_id,user_name,before_json,after_json) VALUES (?,?,?,?,?,?)',
        [type, at, user.id, user.name || user.username || '', JSON.stringify(before), JSON.stringify(after)]);
      db.save();
      log('report_plans.saved', { report_type: type, enabled: after.enabled, run_time: after.run_time });
      res.json({ ok: true, plan: after, changed: true, note: '仅影响未来计划，不补跑、不触发导出' });
    } catch (e) { log('report_plans.save_failed', { error: String(e.message).slice(0, 80) }); res.status(503).json({ ok: false, reason: 'plan_unavailable' }); }
  });
  app.get(INTERNAL + '/:reportType', (req, res) => {
    try {
      ready(); if (!internalAllowed(req, res)) return;
      const type = String(req.params.reportType || '');
      const p = plan(type);
      if (!p) return res.status(404).json({ ok: false, reason: 'report_unknown' });
      res.json({ ok: true, plan: p, now_local: localParts(new Date()).date_time });
    } catch (e) { log('report_plans.internal_read_failed', { error: String(e.message).slice(0, 80) }); res.status(503).json({ ok: false, reason: 'plan_unavailable' }); }
  });
  return { plan, ready };
}

module.exports = { mountReportSyncPlans, conflictWithPlans, REPORTS, PREFIX, INTERNAL };
