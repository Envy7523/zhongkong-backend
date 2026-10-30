'use strict';
const M = require('./member-card-transactions');
const auth = require('./syncbot-coverage');
const PREFIX = '/api/internal/syncbot/member-transactions';
function mountMemberTransactions({ app, express, db, audit }) {
  app.use(PREFIX, express.raw({ type: () => true, limit: '96mb' }));
  app.get(PREFIX + '/coverage', (req, res) => {
    const check = auth.verifyRequest(req, audit);
    if (!check.ok) return res.status(401).json({ ok: false, reason: check.reason });
    try { return res.json(M.coverage(db, String(req.query.date_from || ''), String(req.query.date_to || req.query.date_from || ''))); }
    catch { return res.status(400).json({ ok: false, reason: 'member_coverage_failed' }); }
  });
  app.post(PREFIX + '/import', (req, res) => {
    const check = auth.verifyRequest(req, audit);
    if (!check.ok) return res.status(401).json({ ok: false, reason: check.reason });
    try {
      const p = JSON.parse(req.body.toString('utf8'));
      if (p.report_type !== M.TYPE || !/^[0-9a-f]{64}$/.test(p.sha256 || '') || typeof p.data !== 'string'
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data) || p.data.length % 4) throw Error('会员导入请求格式不正确');
      const buffer = Buffer.from(p.data, 'base64');
      if (require('crypto').createHash('sha256').update(buffer).digest('hex') !== p.sha256) throw Error('会员文件摘要不符');
      const result = M.importBuffer(db, buffer, p, { username: 'syncbot-member-importer' });
      return res.json({ ok: true, ...result });
    } catch (error) { return res.status(400).json({ ok: false, reason: 'member_import_failed', error: error.message }); }
  });
}
module.exports = { PREFIX, mountMemberTransactions };
