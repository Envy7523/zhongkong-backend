'use strict';
/**
 * 防并发锁：基于「原子创建独占文件」(open with 'wx')。
 *
 * 设计目标：
 *  - 同一时刻同一任务名只允许一个进程执行（阶段5 定时任务与人工重跑互斥）；
 *  - 进程崩溃后锁不会永久卡死：超过 staleMs 或持有者 PID 已不存在时自动判定为残留锁；
 *  - 锁文件内容为 JSON（pid / 主机名 / 任务名 / 开始时间），便于人工排查。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./paths');
const TC = require('./task-context');

class LockBusyError extends Error {
  constructor(name, info) {
    super(
      `任务「${name}」正在运行中，已拒绝并发执行` +
        (info ? `（pid=${info.pid} since=${info.startedAt}）` : '')
    );
    this.name = 'LockBusyError';
    this.lockName = name;
    this.holder = info || null;
  }
}

/** 锁文件路径：state/locks/<name>.<report_type>.lock（reportType 为显式位置参数，禁止推断） */
function lockFile(name, reportType) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`非法锁名：${name}`);
  const rt = TC.assertResidentReportType(reportType);
  P.ensureDir(P.locks);
  return P.lockFile(name, rt);
}

function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readLock(name, reportType) {
  const file = lockFile(name, reportType);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const info = JSON.parse(raw);
    const st = fs.statSync(file);
    return Object.assign(info, { file, mtime: st.mtime.toISOString() });
  } catch (e) {
    return null;
  }
}

/** 判断锁是否已失效（残留） */
function isStale(info, staleMs) {
  if (!info) return true;
  if (Date.now() - new Date(info.startedAt || info.mtime).getTime() > staleMs) return true;
  // 同主机且 PID 不存在 → 残留
  if (info.host === os.hostname() && !pidAlive(info.pid)) return true;
  return false;
}

const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000; // 6 小时

/**
 * 获取锁。成功返回 handle（务必在 finally 中 release）。
 * 失败抛 LockBusyError。
 */
function acquire(name, reportType, { staleMs = DEFAULT_STALE_MS, meta = {}, force = false } = {}) {
  const file = lockFile(name, reportType);
  const payload = JSON.stringify(
    {
      name,
      pid: process.pid,
      host: os.hostname(),
      user: process.env.USER || process.env.LOGNAME || null,
      startedAt: new Date().toISOString(),
      meta,
    },
    null,
    2
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o644);
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      let released = false;
      return {
        name,
        file,
        info: JSON.parse(payload),
        release() {
          if (released) return;
          released = true;
          try {
            // 所有权校验：仅当文件内容仍为本进程本次持有的记录时才删除，
            // 避免删除其他任务/其他 report_type 的锁。
            const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (cur.pid !== process.pid || cur.startedAt !== JSON.parse(payload).startedAt) return;
            fs.unlinkSync(file);
          } catch (e) {
            /* 已被人工清理或已被接管，忽略 */
          }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const info = readLock(name, reportType);
      if (force || isStale(info, staleMs)) {
        try {
          fs.unlinkSync(file);
        } catch (_) {
          /* 竞争释放，忽略 */
        }
        continue; // 重试一次
      }
      throw new LockBusyError(name, info);
    }
  }
  throw new LockBusyError(name, readLock(name, reportType));
}

/** 便捷包装：withLock('meituan-download', async () => {...}) */
async function withLock(name, reportType, fn, opts) {
  const handle = acquire(name, reportType, opts);
  try {
    return await fn(handle);
  } finally {
    handle.release();
  }
}

function list(reportType) {
  if (!fs.existsSync(P.locks)) return [];
  return fs
    .readdirSync(P.locks)
    .filter((f) => f.endsWith('.lock'))
    .map((f) => readLock(f.replace(new RegExp(`\\.${TC.assertResidentReportType(reportType)}\\.lock$`), ''), reportType))
    .filter(Boolean);
}

function clear(name, reportType, { force = false, staleMs = DEFAULT_STALE_MS } = {}) {
  const info = readLock(name, reportType);
  if (!info) return { cleared: false, reason: '锁不存在' };
  if (!force && !isStale(info, staleMs)) {
    return { cleared: false, reason: '锁仍有效，拒绝清理', info };
  }
  fs.unlinkSync(lockFile(name, reportType));
  return { cleared: true, info };
}

module.exports = { acquire, withLock, list, clear, readLock, isStale, LockBusyError, DEFAULT_STALE_MS };
