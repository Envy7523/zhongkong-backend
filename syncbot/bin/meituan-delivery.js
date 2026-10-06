#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { request } = require('../src/phase2/proto');
const root = process.env.SYNCBOT_ROOT || '/opt/zhongkong-sync-bot';
const command = process.argv[2] || 'inspect';
const args = process.argv[3] === '--stdin' ? JSON.parse(fs.readFileSync(0, 'utf8')) : {};
for (const value of process.argv.slice(3)) {
  const match = value.match(/^--([a-z-]+)=(.*)$/);
  if (match) args[match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = match[2];
}
request(path.join(root, 'state/runtime/meituan-delivery/host.sock'), command, args, { timeoutMs: 15 * 60 * 1000 })
  .then(result => { console.log(JSON.stringify(result)); })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
