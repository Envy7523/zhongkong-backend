'use strict';
/**
 * 阶段2：现有中控项目「五项基线」采集与对照（**全程只读**）
 *
 *   node src/phase2/baseline.js capture [--out=state/baseline.json]
 *   node src/phase2/baseline.js compare [--in=state/baseline.json]
 *
 * 五项（对应阶段2 方案 §6）：
 *   1) 应用文件 sha256
 *   2) zhongkong / nginx 服务状态与单元清单
 *   3) 监听端口
 *   4) 数据库文件属性（大小 / mtime / inode）
 *   5) systemd timer 与 crontab
 *
 * 不写入项目目录、不改动任何服务；只读文件与只读命令。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const P = require('../paths');

const APP_DIR = process.env.ZHONGKONG_APP_DIR || '/home/ubuntu/app';
const DEFAULT_FILE = path.join(P.state, 'baseline.json');

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return `(失败: ${String(e.message).split('\n')[0]})`;
  }
}

function sha256(file) {
  try {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    let n;
    try {
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
    return h.digest('hex');
  } catch (e) {
    return `(不可读: ${e.code || e.message})`;
  }
}

function listFiles() {
  const out = [];
  for (const rel of ['server.js', 'package.json', 'config.json', 'index.html']) {
    const f = path.join(APP_DIR, rel);
    if (fs.existsSync(f)) out.push(f);
  }
  for (const d of ['lib', 'frontend/dist']) {
    const dir = path.join(APP_DIR, d);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const f = path.join(dir, name);
      if (!fs.statSync(f).isFile()) continue;
      if (d === 'lib' && /\.bak-.+$/.test(name)) continue; // 备份文件不纳入基线
      if (d === 'frontend/dist' && !/\.(html|js|css)$/.test(name)) continue;
      out.push(f);
    }
  }
  return out;
}

function capture() {
  const b = {
    captured_at: new Date().toISOString(),
    app_dir: APP_DIR,
    items: {},
  };

  // 1) 应用文件哈希
  const files = listFiles();
  b.items.app_files = files.map((f) => ({ path: f, sha256: sha256(f), size: fs.existsSync(f) ? fs.statSync(f).size : null }));
  b.items.app_files_summary = { count: files.length, digest: crypto.createHash('sha256').update(b.items.app_files.map((x) => `${x.path}:${x.sha256}`).join('\n')).digest('hex') };

  // 2) 服务
  b.items.services = ['zhongkong', 'nginx'].map((s) => ({
    unit: s,
    active: sh(`systemctl is-active ${s}.service`),
    enabled: sh(`systemctl is-enabled ${s}.service 2>/dev/null`),
    main_pid: sh(`systemctl show -p MainPID --value ${s}.service`),
    active_enter: sh(`systemctl show -p ActiveEnterTimestamp --value ${s}.service`),
  }));
  b.items.running_service_count = sh('systemctl list-units --type=service --state=running --no-legend --no-pager | wc -l');

  // 3) 监听端口
  const ss = sh("ss -ltn | awk 'NR>1{print $4}' | sort -u");
  b.items.listen_tcp = ss.split('\n').filter(Boolean);

  // 4) 数据库
  const dbFile = path.join(APP_DIR, 'data', 'database.sqlite');
  try {
    const st = fs.statSync(dbFile);
    b.items.database = { path: dbFile, size: st.size, mtime: st.mtime.toISOString(), ino: st.ino, mode: st.mode.toString(8), uid: st.uid, gid: st.gid };
  } catch (e) {
    b.items.database = { path: dbFile, error: e.code || e.message };
  }

  // 5) timer 与 crontab
  b.items.timers_all = sh('systemctl list-timers --all --no-legend --no-pager | awk \'{print $1"|"$NF}\' | sort').split('\n').filter(Boolean);
  b.items.syncbot_timers = b.items.timers_all.filter((x) => /syncbot/i.test(x));
  b.items.crontab = ['root', 'ubuntu', 'syncbot'].map((u) => {
    const out = sh(`crontab -l -u ${u} 2>/dev/null | grep -v '^[[:space:]]*#' | grep -c . || true`);
    return { user: u, lines: /^\d+$/.test(out) ? Number(out) : 0, raw: /^\d+$/.test(out) ? null : out };
  });

  return b;
}

function diffLine(label, a, b) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  return { label, same, before: a, after: b };
}

function compare(baseline) {
  const now = capture();
  const diffs = [];
  const B = baseline.items;
  const N = now.items;

  diffs.push(diffLine('① 应用文件集合摘要 (count+digest)', B.app_files_summary, N.app_files_summary));
  const bMap = new Map((B.app_files || []).map((x) => [x.path, x.sha256]));
  const changed = (N.app_files || []).filter((x) => bMap.has(x.path) && bMap.get(x.path) !== x.sha256).map((x) => x.path);
  const added = (N.app_files || []).filter((x) => !bMap.has(x.path)).map((x) => x.path);
  const removed = (B.app_files || []).filter((x) => !(N.app_files || []).some((y) => y.path === x.path)).map((x) => x.path);
  diffs.push({ label: '① 应用文件逐个哈希', same: !changed.length && !added.length && !removed.length, changed, added, removed });

  for (const svc of B.services || []) {
    const n = (N.services || []).find((x) => x.unit === svc.unit) || {};
    diffs.push(diffLine(`② 服务 ${svc.unit}（active/enabled）`, { a: svc.active, e: svc.enabled }, { a: n.active, e: n.enabled }));
    diffs.push({ label: `② 服务 ${svc.unit} 的 MainPID / ActiveEnterTimestamp`, same: svc.main_pid === n.main_pid && svc.active_enter === n.active_enter, before: { pid: svc.main_pid, since: svc.active_enter }, after: { pid: n.main_pid, since: n.active_enter }, note: 'PID 或启动时间变化表示服务被重启过，需人工判断是否与本阶段有关' });
  }
  diffs.push(diffLine('② 运行中服务数量', B.running_service_count, N.running_service_count));

  const bPorts = B.listen_tcp || [];
  const nPorts = N.listen_tcp || [];
  const newPorts = nPorts.filter((p) => !bPorts.includes(p));
  const gonePorts = bPorts.filter((p) => !nPorts.includes(p));
  diffs.push({ label: '③ 监听端口（新增/消失）', same: !newPorts.length && !gonePorts.length, added: newPorts, removed: gonePorts, before: bPorts, after: nPorts });

  const bd = B.database || {};
  const nd = N.database || {};
  diffs.push({
    label: '④ 数据库大小 / mtime / inode',
    same: bd.size === nd.size && bd.ino === nd.ino,
    before: { size: bd.size, mtime: bd.mtime, ino: bd.ino },
    after: { size: nd.size, mtime: nd.mtime, ino: nd.ino },
    note: 'mtime 由现有项目自身运行写入而前进属正常；大小与 inode 变化需人工确认',
  });

  diffs.push(diffLine('⑤ syncbot timer（必须始终为空）', B.syncbot_timers, N.syncbot_timers));
  diffs.push(diffLine('⑤ crontab 有效行数', B.crontab, N.crontab));

  return { compared_at: new Date().toISOString(), baseline_captured_at: baseline.captured_at, diffs, all_same: diffs.every((d) => d.same) };
}

function main() {
  const cmd = process.argv[2];
  const argOf = (name, dflt) => {
    const a = process.argv.find((x) => x.startsWith(`--${name}=`));
    return a ? a.split('=').slice(1).join('=') : dflt;
  };
  if (cmd === 'capture') {
    const out = argOf('out', DEFAULT_FILE);
    const b = capture();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(b, null, 2));
    console.log(JSON.stringify({ ok: true, mode: 'capture', out, captured_at: b.captured_at, app_files: b.items.app_files.length, services: b.items.services.map((s) => `${s.unit}=${s.active}`), listen_tcp: b.items.listen_tcp, database: b.items.database, syncbot_timers: b.items.syncbot_timers, crontab: b.items.crontab }, null, 2));
    return;
  }
  if (cmd === 'compare') {
    const inp = argOf('in', DEFAULT_FILE);
    const baseline = JSON.parse(fs.readFileSync(inp, 'utf8'));
    const r = compare(baseline);
    console.log(JSON.stringify({ ok: r.all_same, mode: 'compare', baseline_file: inp, ...r }, null, 2));
    process.exit(r.all_same ? 0 : 1);
  }
  console.error('用法: node src/phase2/baseline.js capture|compare [--out=|--in=]');
  process.exit(2);
}

main();
