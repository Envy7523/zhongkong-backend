'use strict';

// 一次性只读审核预览。SSH 只读 SQLite，不接触 webhook / 推送接口。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { buildPosDailyPreview } = require('../lib/pos-daily-preview');
const { renderPosDailyImage } = require('../lib/pos-daily-image');

const businessDate = process.argv[2];
const target = process.argv[3];
if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || '')) || !target) {
  throw new Error('usage: node scripts/preview-pos-daily-from-cloud.js YYYY-MM-DD OUTPUT.png');
}
const py = `import json,sqlite3,sys
c=sqlite3.connect("file:/home/ubuntu/app/data/database.sqlite?mode=ro",uri=True)
c.row_factory=sqlite3.Row
date=sys.argv[1]
out={
"stores":[dict(x) for x in c.execute("SELECT id,store_name FROM stores WHERE status='正常营业' ORDER BY id")],
"records":[dict(x) for x in c.execute("SELECT store_id,store_name,channel,channel_group,gross_amount,recorded_amount,order_count FROM business_revenue_records WHERE source_type='pos' AND biz_date=? ORDER BY store_id,channel",(date,))],
"compositions":[dict(x) for x in c.execute("SELECT store_id,category,amount FROM business_revenue_compositions WHERE biz_date=? ORDER BY store_id,category",(date,))]
}
print(json.dumps(out,ensure_ascii=False))`;
const encoded = Buffer.from(py).toString('base64');
const remote = `python3 -c 'exec(__import__("base64").b64decode("${encoded}"))' ${businessDate}`;
const raw = execFileSync('ssh', ['zhongkong', remote], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const source = JSON.parse(raw);
const db = { queryAll(sql) {
  if (sql.includes('FROM stores')) return source.stores;
  if (sql.includes('FROM business_revenue_records')) return source.records;
  if (sql.includes('FROM business_revenue_compositions')) return source.compositions;
  throw new Error('unsupported_query');
} };
// 仅供本次人工预览：依据 2026-09-25 用户确认。不能静默变为生产固定规则。
const excludedStores = { 13: '已停业', 17: '放养门店', 19: '已停业' };
const preview = buildPosDailyPreview(db, businessDate, { excludedStores });
const image = renderPosDailyImage(preview);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, image.buffer);
process.stdout.write(JSON.stringify({ target, ready: preview.ready, store_count: preview.store_count,
  excluded_stores: preview.excluded_stores, problems: preview.problems, totals: preview.totals,
  image: { width: image.width, height: image.height } }, null, 2) + '\n');
