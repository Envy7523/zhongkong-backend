#!/usr/bin/env node
'use strict';
/** 既有 C 成功任务的只读证明→审计补送；绝不启动浏览器或数据导入。 */
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !/^--date=\d{4}-\d{2}-\d{2}$/.test(argv[0]))
    return { exitCode: 2, reason: 'single_explicit_date_required' };
  const date = argv[0].slice(7);
  process.env.SYNCBOT_REPORT_C_MANUAL_CATCHUP = '1';
  const ZK = require('../src/schedule/zk-client');
  const bridge = require('../src/phase3/report-c-audit-bridge');
  const zk = ZK.createZkClient({});
  const result = await bridge.record({ businessDate: date, coverageClient: zk });
  return { exitCode: result.ok ? 0 : 3, result };
}
if (require.main === module) main().then(out => {
  console.log(JSON.stringify(out)); process.exitCode = out.exitCode;
}).catch(() => { console.error(JSON.stringify({ exitCode: 3,
  reason: 'report_c_audit_record_unhandled' })); process.exitCode = 3; });
module.exports = { main };
