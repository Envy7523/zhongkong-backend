'use strict';
/** 全平台共享浏览器互斥。独立于每份报表的业务日期锁；目前尚未接入 A/B 运行路径。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./paths');
const NAME = 'shared-pos-browser.lock';

function lockPath() { return path.join(P.locks, NAME); }
function acquire({ taskId, reportType } = {}) {
  if (!/^[A-Za-z0-9._-]{3,100}$/.test(String(taskId || ''))
    || !Object.prototype.hasOwnProperty.call(P.REPORT_TYPES, reportType)
    || P.REPORT_TYPES[reportType].authorized !== true)
    throw new Error('shared_browser_lock_identity_invalid');
  P.ensureDir(P.locks);
  const file = lockPath();
  const payload = { task_id: taskId, report_type: reportType, pid: process.pid,
    host: os.hostname(), started_at: new Date().toISOString() };
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('shared_browser_busy_manual_review'); throw e; }
  try { fs.writeFileSync(fd, JSON.stringify(payload)); }
  finally { fs.closeSync(fd); }
  let released = false;
  return { file, release() {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.task_id === payload.task_id && current.report_type === payload.report_type
        && current.pid === payload.pid && current.started_at === payload.started_at)
        fs.unlinkSync(file);
    } catch { /* 丢失所有权/无法读回时保留给人工处理 */ }
  } };
}
async function withSharedBrowserLock(identity, fn) {
  const handle = acquire(identity);
  try { return await fn(); }
  finally { handle.release(); }
}
module.exports = { NAME, lockPath, acquire, withSharedBrowserLock };
