'use strict';
/**
 * 文件归档：把「已确认完整」的下载文件从 _incoming 移到
 *   downloads/<platform>/<业务日期>/<统一命名>.xlsx
 * 并计算 sha256，用于「同平台+同日期+同来源文件不允许重复导入」的去重判断。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const TC = require('./task-context');

/** 统一命名：<平台中文名>_<报表名>_<YYYY-MM-DD>.<ext> */
function canonicalName({ platformLabel, reportLabel, businessDate, ext }) {
  const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '').replace(/_+/g, '_');
  const e = String(ext || 'xlsx').replace(/^\./, '');
  return `${safe(platformLabel)}_${safe(reportLabel)}_${businessDate}.${e}`;
}

function sha256(file, { chunk = 4 * 1024 * 1024 } = {}) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunk);
    let n;
    while ((n = fs.readSync(fd, buf, 0, chunk, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** 下载临时文件判断：Chrome 未完成时为 .crdownload/.part，必须等到它们消失 */
function pendingTempFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(crdownload|part|tmp|download)$/i.test(f));
}

/**
 * 归档一个下载文件。
 * @returns {{file:string, dir:string, size:number, sha256:string, archived:boolean}}
 */
function archive({ srcFile, platform, reportType, businessDate, fileName, move = true }) {
  if (!fs.existsSync(srcFile)) throw new Error(`源文件不存在：${srcFile}`);
  const dir = P.dayDownloads(platform, TC.assertResidentReportType(reportType), businessDate);
  P.ensureDir(dir);
  const target = path.join(dir, fileName);
  if (fs.existsSync(target)) {
    const same = sha256(target) === sha256(srcFile);
    if (same) {
      if (move) fs.unlinkSync(srcFile);
      return { file: target, dir, size: fs.statSync(target).size, sha256: sha256(target), archived: false, duplicate: true };
    }
    // 同名不同内容：加时间戳保留两份，绝不覆盖历史文件
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const alt = path.join(dir, `${path.parse(fileName).name}.${stamp}${path.extname(fileName)}`);
    if (move) fs.renameSync(srcFile, alt);
    else fs.copyFileSync(srcFile, alt);
    return { file: alt, dir, size: fs.statSync(alt).size, sha256: sha256(alt), archived: true, duplicate: false, keptBoth: target };
  }
  if (move) fs.renameSync(srcFile, target);
  else fs.copyFileSync(srcFile, target);
  const st = fs.statSync(target);
  return { file: target, dir, size: st.size, sha256: sha256(target), archived: true, duplicate: false };
}

/** 去重查询：该平台该日期是否已归档过同一 sha256 的文件 */
function findDuplicate({ platform, reportType, businessDate, sha256: hash }) {
  const dir = P.dayDownloads(platform, TC.assertResidentReportType(reportType), businessDate);
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!fs.statSync(full).isFile()) continue;
    if (sha256(full) === hash) return full;
  }
  return null;
}

function listDay(platform, reportType, businessDate) {
  const dir = P.dayDownloads(platform, TC.assertResidentReportType(reportType), businessDate);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => {
    const st = fs.statSync(path.join(dir, f));
    return { name: f, size: st.size, mtime: st.mtime.toISOString() };
  });
}

/** 保留策略：原始报表至少保留 90 天（dryRun 预览，不删除） */
function cleanup({ platform, reportType, days = 90, dryRun = true } = {}) {
  const base = P.reportDownloads(platform, TC.assertResidentReportType(reportType));
  const cutoff = Date.now() - days * 86400000;
  const out = [];
  if (!fs.existsSync(base)) return out;
  for (const name of fs.readdirSync(base)) {
    const full = path.join(base, name);
    const st = fs.statSync(full);
    if (st.isDirectory() && st.mtimeMs < cutoff) {
      const files = fs.readdirSync(full).map((f) => ({ f, size: fs.statSync(path.join(full, f)).size }));
      const bytes = files.reduce((a, b) => a + b.size, 0);
      out.push({ dir: full, mtime: st.mtime.toISOString(), files: files.length, bytes });
      if (!dryRun) fs.rmSync(full, { recursive: true, force: true });
    }
  }
  return out;
}

module.exports = { canonicalName, sha256, pendingTempFiles, archive, findDuplicate, listDay, cleanup };
