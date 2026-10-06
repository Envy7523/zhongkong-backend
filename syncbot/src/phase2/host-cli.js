'use strict';
/**
 * 阶段2：宿主控制 CLI（供 bin/syncbot 调用）
 *   node src/phase2/host-cli.js health
 *   node src/phase2/host-cli.js stats
 *   node src/phase2/host-cli.js approvals
 *   node src/phase2/host-cli.js human-busy
 *   node src/phase2/host-cli.js human-session-start [--note=...]
 *   node src/phase2/host-cli.js human-session-stop
 */
const client = require('./client');

const cmd = process.argv[2];
const args = {};
for (const a of process.argv.slice(3)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}

(async () => {
  try {
    let r;
    switch (cmd) {
      case 'health':
        r = await client.health();
        break;
      case 'stats':
        r = await client.stats();
        break;
      case 'approvals':
        r = await client.approvals();
        break;
      case 'human-busy':
        r = await client.humanBusy();
        break;
      case 'human-session-start':
        r = await client.humanSessionStart({ note: args.note || null });
        break;
      case 'human-session-stop':
        r = await client.humanSessionStop();
        break;
      default:
        console.error('用法: host-cli.js health|stats|approvals|human-busy|human-session-start|human-session-stop');
        process.exit(2);
    }
    console.log(JSON.stringify({ ok: true, cmd, result: r }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, cmd, error: e.message }, null, 2));
    process.exit(1);
  }
})();
