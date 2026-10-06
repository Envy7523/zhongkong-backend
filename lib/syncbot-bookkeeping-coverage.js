'use strict';
/** 收银系统门店收支统计专属只读覆盖；不能借 A/B 的业务表推断记账本完成。 */
const base = require('./syncbot-coverage');
const PATH = '/api/internal/syncbot/bookkeeping-coverage';

function createBookkeepingCoverageHandler({ db, audit } = {}) {
  if (!db || typeof db.queryOne !== 'function') throw new Error('bookkeeping-coverage: db required');
  return function bookkeepingCoverage(req, res) {
    const auth = base.verifyRequest(req, audit);
    if (!auth.ok) return res.status(401).json({ ok: false, reason: auth.reason });
    const date = String(req.query?.business_date || '');
    if (!base.isRealDate(date)) return res.status(400).json({ ok: false, reason: 'business_date_invalid' });
    try {
      const entries = db.queryOne(`SELECT COUNT(*) AS n,ROUND(SUM(amount)*100) AS cents
        FROM bookkeeping_entries WHERE date=?`, [date]);
      const batch = db.queryOne(`SELECT id,row_count,store_count,total_cents,file_sha256
        FROM pos_bookkeeping_daily_imports WHERE business_date=?`, [date]);
      const linked = batch ? db.queryOne(`SELECT COUNT(*) AS n,ROUND(SUM(e.amount)*100) AS cents
        FROM pos_bookkeeping_daily_import_rows l JOIN bookkeeping_entries e ON e.id=l.entry_id
        WHERE l.batch_id=? AND e.date=?`, [batch.id, date]) : null;
      const entryCount = Number(entries?.n || 0);
      const totalCents = Number(entries?.cents || 0);
      if (!Number.isInteger(entryCount) || !Number.isSafeInteger(totalCents)) throw new Error('count_invalid');
      return res.json({ ok: true, report_type: 'pos_bookkeeping_daily', business_date: date,
        entry_count: entryCount, total_cents: totalCents,
        import_batch: batch ? { id: Number(batch.id), row_count: Number(batch.row_count),
          store_count: Number(batch.store_count), total_cents: Number(batch.total_cents),
          sha256_prefix: String(batch.file_sha256 || '').slice(0, 12), linked_rows: Number(linked?.n || 0),
          linked_cents: Number(linked?.cents || 0) } : null,
        // 有记录也不能跳过：可能是粘贴或部分历史数据，必须结合原件/任务状态核验。
        safe_to_skip_sync: false, report_eligible: false });
    } catch { return res.status(503).json({ ok: false, reason: 'coverage_query_failed' }); }
  };
}

function mountBookkeepingCoverage({ app, express, db, audit } = {}) {
  app.use(PATH, express.raw({ type: () => true, limit: '16kb' }));
  const handler = createBookkeepingCoverageHandler({ db, audit });
  app.get(PATH, handler);
  return { PATH, handler };
}
module.exports = { PATH, createBookkeepingCoverageHandler, mountBookkeepingCoverage };

