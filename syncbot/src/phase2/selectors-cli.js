'use strict';
/**
 * 阶段2：选择器注册表 CLI
 *   node src/phase2/selectors-cli.js show
 *   node src/phase2/selectors-cli.js validate [--for-real-run]
 *   node src/phase2/selectors-cli.js verify --all [--note=...]
 *   node src/phase2/selectors-cli.js verify --keys=a,b,c
 */
const selectors = require('./selectors');

const cmd = process.argv[2];
const args = {};
for (const a of process.argv.slice(3)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}

try {
  if (cmd === 'show') {
    const s = selectors.summary();
    console.log(JSON.stringify(s, null, 2));
  } else if (cmd === 'validate') {
    const v = selectors.validate({ forRealRun: !!args['for-real-run'] });
    console.log(JSON.stringify(v, null, 2));
    process.exit(v.ok ? 0 : 1);
  } else if (cmd === 'verify') {
    const keys = args.all ? null : String(args.keys || '').split(',').map((s) => s.trim()).filter(Boolean);
    const r = selectors.markVerified(keys, args.by || 'human', args.note || '');
    console.log(JSON.stringify({ ok: true, ...r }, null, 2));
  } else {
    console.error('用法: selectors-cli.js show|validate [--for-real-run]|verify --all|--keys=a,b');
    process.exit(2);
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
}
