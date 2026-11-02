'use strict';
// Read-only preflight. A candidate may differ only at explicitly recorded file hashes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function option(name) { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; }
const baselinePath = path.resolve(root, option('--baseline') || 'deployment/production-baseline.json');
const allowPath = option('--allowlist');
const scope = option('--scope') || 'all';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function normalizedHash(file) {
  const b = fs.readFileSync(file);
  return hash(/\.(js|cjs|mjs|vue|css|json|html|ts|svg|py)$/.test(file) ? Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n')) : b);
}
try {
  if (!['all', 'frontend', 'backend'].includes(scope)) throw Error('scope 只支持 all、frontend、backend');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const ageHours = (Date.now() - Date.parse(baseline.checked_at)) / 3600000;
  if (!Number.isFinite(ageHours) || ageHours < -0.1 || ageHours > 24) throw Error('生产基线已过期或时间无效，须先重新只读核对云端，不能沿用旧快照发布');
  const allowed = allowPath ? JSON.parse(fs.readFileSync(path.resolve(root, allowPath), 'utf8')) : {};
  if (allowed.frontend_index_sha256 !== undefined && allowed.frontend_index_sha256 !== baseline.frontend_index_sha256) throw Error('允许变更清单不属于当前网页基线');
  if (allowed.backend_commit !== undefined && allowed.backend_commit !== baseline.backend_commit) throw Error('允许变更清单不属于当前后端基线');
  const names = new Set(Object.keys(baseline.sources));
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) names.add(path.relative(root, file).replaceAll('\\', '/'));
    }
  }
  for (const dir of ['frontend/src', 'lib', 'tools/domain-site']) walk(path.join(root, dir));
  for (const dir of ['frontend/public', 'shared', 'syncbot/src']) walk(path.join(root, dir));
  function inScope(name) {
    if (scope === 'frontend') return name.startsWith('frontend/') || name.startsWith('shared/') || name.startsWith('tools/domain-site/');
    if (scope === 'backend') return !name.startsWith('frontend/') && !name.startsWith('tools/domain-site/');
    return true;
  }
  const changes = [], blocked = [];
  for (const name of names) {
    if (!inScope(name)) continue;
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw Error('基线含非法文件路径');
    const file = path.join(root, name);
    const candidate = fs.existsSync(file) && fs.statSync(file).isFile() ? normalizedHash(file) : null;
    const deployed = baseline.sources[name]?.normalized_sha256 || null;
    if (candidate === deployed) continue;
    const approved = allowed.files?.[name];
    const change = { path: name, deployed_sha256: deployed, candidate_sha256: candidate };
    changes.push(change);
    if (!approved || approved.deployed_sha256 !== deployed || approved.candidate_sha256 !== candidate) blocked.push(change);
  }
  console.log(JSON.stringify({ passed: !blocked.length, scope, checked_at: baseline.checked_at, backend_commit: baseline.backend_commit,
    frontend_commit: baseline.frontend_manifest.commit, frontend_index_sha256: baseline.frontend_index_sha256,
    compared_files: [...names].filter(inScope).length, planned_changes: changes.map(c => c.path), unreviewed_changes: blocked.map(c => c.path),
    note: '只读差异检查；通过不代表已构建、已发布或业务验收。发布切换前仍须重新核对云端运行目录、网页哈希与网关。' }, null, 2));
  process.exitCode = blocked.length ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
