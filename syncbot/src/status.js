'use strict';
/**
 * 运行状态总览（只读，不做任何修改）：
 *   node src/status.js [--platform=meituan] [--date=YYYY-MM-DD] [--days=7]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const P = require('./paths');
const config = require('./config');
const lock = require('./lock');
const state = require('./state');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const PLATFORM = String(args.platform || 'meituan');

function sh(cmd) {
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  const out = (e) => (e && e.stdout ? String(e.stdout).trim() : '');
  try {
    return execSync(cmd, opts).trim();
  } catch (e) {
    // 退出码非 0 但仍有输出（如 systemctl is-enabled 返回 "disabled"、"inactive"）→ 直接用输出
    if (out(e)) return out(e);
    // 业务数据目录为 0750(syncbot:syncbot)，非 root 直接读取会失败 → 尝试免密 sudo
    try {
      return execSync(`sudo -n ${cmd}`, opts).trim();
    } catch (e2) {
      return out(e2) || '(不可用：请以 root 或具备免密 sudo 的账号执行)';
    }
  }
}

/** 读取文件内容，必要时经免密 sudo 回退（用于 0750 目录下的运行态文件） */
function readFileSmart(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    const out = sh(`cat ${JSON.stringify(file)}`);
    return out.startsWith('(不可用') ? null : out;
  }
}

function du(dir) {
  if (!fs.existsSync(dir)) return '不存在';
  return sh(`du -sh ${JSON.stringify(dir)} 2>/dev/null | cut -f1`) || '0';
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

const SERVICES = [
  'syncbot-xvfb.service',
  'syncbot-wm.service',
  'syncbot-vnc.service',
  'syncbot-novnc.service',
  'syncbot-browser.service',
];

console.log('================ 中控同步机器人 · 运行状态 ================');
console.log(`根目录        : ${P.root}`);
console.log(`平台          : ${PLATFORM}`);
console.log(`配置          : ${config.bot().__file}`);
console.log('');

console.log('--- 目录占用 ---');
for (const [label, dir] of [
  ['app(脚本)', P.app],
  ['browser-profiles(登录态)', P.browserProfiles],
  ['downloads(原始报表)', P.downloads],
  ['screenshots(截图)', P.screenshots],
  ['logs(日志)', P.logs],
  ['state(状态/锁)', P.state],
]) {
  console.log(`  ${label.padEnd(26, ' ')} ${du(dir)}`);
}
console.log('');

console.log('--- systemd 服务 ---');
for (const s of SERVICES) {
  const active = sh(`systemctl is-active ${s}`);
  const enabled = sh(`systemctl is-enabled ${s}`);
  console.log(`  ${s.padEnd(28, ' ')} active=${active.padEnd(9)} enabled=${enabled}`);
}
console.log('');

console.log('--- 监听端口（应全部为 127.0.0.1）---');
console.log(
  sh(`ss -tlnp 2>/dev/null | grep -E ":(5901|6080)\\b" || echo "  (5901/6080 未监听)"`)
    .split('\n')
    .map((l) => '  ' + l.trim())
    .join('\n')
);
console.log('');

console.log('--- 浏览器运行态 ---');
const rtFile = path.join(P.runtime, `browser-${PLATFORM}.json`);
const rtRaw = fs.existsSync(rtFile) ? fs.readFileSync(rtFile, 'utf8') : readFileSmart(rtFile);
if (rtRaw) {
  const rt = JSON.parse(rtRaw);
  let alive = false;
  try {
    process.kill(rt.pid, 0);
    alive = true;
  } catch (e) {
    alive = false;
  }
  console.log(`  运行时文件    : ${rtFile}`);
  console.log(`  pid           : ${rt.pid} (${alive ? '存活' : '已退出，属残留记录'})`);
  console.log(`  Chromium      : ${rt.chromium_version}`);
  console.log(`  DISPLAY       : ${rt.display}`);
  console.log(`  Profile       : ${rt.profile_dir}`);
  console.log(`  下载目录      : ${rt.download_dir}`);
  console.log(`  启动时间      : ${rt.started_at}`);
} else {
  console.log('  (无运行记录：浏览器未启动或已正常关闭)');
}
console.log('');

console.log('--- 防并发锁 ---');
const locks = lock.list();
if (locks.length === 0) console.log('  (无锁)');
else for (const l of locks) console.log(`  ${l.name.padEnd(24)} pid=${l.pid} since=${l.startedAt}` + (lock.isStale(l, lock.DEFAULT_STALE_MS) ? '  [残留]' : ''));
console.log('');

console.log('--- 最近任务状态 ---');
const days = Number(args.days || 7);
const rows = state.recent(PLATFORM, days);
if (args.date) rows.unshift(state.read(PLATFORM, String(args.date)));
if (rows.length === 0) console.log('  (暂无任务记录)');
for (const s of rows) {
  console.log(
    `  ${s.business_date}  download=${s.download.status.padEnd(8)} file=${s.validate_file.status.padEnd(8)} ` +
      `import=${s.import.status.padEnd(8)} validate=${s.validate_import.status.padEnd(8)} push=${s.push.status.padEnd(8)} ` +
      `ready_to_push=${s.ready_to_push}`
  );
  for (const k of ['download', 'validate_file', 'import', 'validate_import', 'push']) {
    if (s[k] && s[k].last_error) console.log(`       └ ${k} 失败原因: ${s[k].last_error}`);
  }
}
console.log('');
console.log('--- 磁盘 ---');
console.log('  ' + sh('df -h /opt | tail -1'));
console.log('=========================================================');
