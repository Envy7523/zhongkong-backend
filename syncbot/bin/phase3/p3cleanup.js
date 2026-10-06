#!/usr/bin/env node
'use strict';
/** 用官方 test-cleanup 端点精确清理指定 test_run_id 的残留（仅 is_test=1 且 test_run_id 精确匹配） */
const crypto = require('crypto');
const fs = require('fs');
const BOT = '/opt/zhongkong-sync-bot';
const BASE = 'http://127.0.0.1:3456';
const SECRET = JSON.parse(fs.readFileSync(`${BOT}/state/secrets/audit-hmac.json`, 'utf8')).secret;
const ids = process.argv.slice(2);
(async () => {
  const out = [];
  for (const id of ids) {
    const raw = JSON.stringify({ test_run_id: id });
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', SECRET).update(`${ts}.${raw}`, 'utf8').digest('hex');
    const r = await fetch(`${BASE}/api/internal/syncbot/test-cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Syncbot-Timestamp': ts, 'X-Syncbot-Signature': sig },
      body: Buffer.from(raw, 'utf8'),
    });
    const j = await r.json().catch(() => null);
    out.push({ test_run_id: id, http: r.status, ok: j && j.ok, deleted_events: j && j.deleted_events, deleted_runs: j && j.deleted_runs });
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.every((x) => x.http === 200 && x.ok === true) ? 0 : 1);
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e && e.message).slice(0, 200) })); process.exit(9); });
