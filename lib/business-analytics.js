const XLSX = require('xlsx');

const CHANNELS = {
  scan_pay: { label: '扫码支付', group: 'offline' },
  cash: { label: '现金', group: 'offline' },
  mini_stored: { label: '小程序储值消费', group: 'offline' },
  other_offline: { label: '其他线下', group: 'offline' },
  meituan_group: { label: '美团团购', group: 'group_buy' },
  douyin_group: { label: '抖音团购', group: 'group_buy' },
  free_trial: { label: '免费试', group: 'group_buy' },
  meituan_delivery: { label: '美团外卖', group: 'delivery' },
  taobao_flash: { label: '淘宝闪购', group: 'delivery' },
  jd_delivery: { label: '京东外卖', group: 'delivery' },
};

const HEADER_ALIASES = {
  date: ['日期', '营业日期', '业务日期', 'date', 'biz_date'],
  storeId: ['门店ID', '门店编号', 'store_id', 'storeid'],
  storeName: ['门店', '门店名称', 'store_name', 'storename'],
  channel: ['渠道', '平台', '渠道名称', 'channel', 'platform'],
  actual: ['实收', '实际收入', '结算收入', '净收入', 'actual_amount', 'net_amount'],
  gross: ['订单金额', '交易金额', '应收', '原始金额', 'gross_amount'],
  recorded: ['收银记录金额', '收银金额', '系统金额', 'recorded_amount'],
  serviceFee: ['手续费', '平台服务费', '佣金', 'service_fee'],
  insuranceFee: ['保险费', '履约保险', 'insurance_fee'],
  promotionFee: ['推广费', '广告费', 'promotion_fee'],
  refund: ['退款', '退款金额', 'refund_amount'],
  orders: ['订单数', '有效订单', 'order_count'],
  productName: ['商品', '商品名称', '菜品名称', 'product_name'],
  quantity: ['销量', '销售数量', '数量', 'quantity'],
  salesAmount: ['商品销售额', '销售额', 'sales_amount'],
};

const POS_CHANNEL_HEADERS = {
  scan_pay: ['扫码支付', '线下扫码', '微信支付宝'],
  cash: ['现金', '现金收入'],
  mini_stored: ['小程序储值消费', '储值消费', '会员储值消费'],
  other_offline: ['其他线下', '堂食其他'],
  meituan_group: ['美团团购', '美团券'],
  douyin_group: ['抖音团购', '抖音券'],
  free_trial: ['免费试'],
  meituan_delivery: ['美团外卖'],
  taobao_flash: ['淘宝闪购', '饿了么', '淘宝外卖'],
  jd_delivery: ['京东外卖'],
};

function cleanKey(value) {
  return String(value == null ? '' : value).trim().replace(/[\s_（）()]/g, '').toLowerCase();
}

function getValue(row, aliases) {
  const keys = Object.keys(row);
  const wanted = aliases.map(cleanKey);
  const key = keys.find(k => wanted.includes(cleanKey(k)));
  return key == null ? undefined : row[key];
}

function number(value) {
  if (value == null || value === '') return 0;
  const n = Number(String(value).replace(/[¥￥,%\s,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function dateText(value) {
  if (!value) return '';
  if (typeof value === 'number') {
    const d = XLSX.SSF.parse_date_code(value);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const text = String(value).trim().replace(/[./]/g, '-');
  const matched = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return matched ? `${matched[1]}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}` : '';
}

function normalizeChannel(value) {
  const key = cleanKey(value);
  return Object.keys(CHANNELS).find(code => {
    const candidates = [CHANNELS[code].label, ...(POS_CHANNEL_HEADERS[code] || [])];
    return candidates.some(item => cleanKey(item) === key || key.includes(cleanKey(item)));
  }) || '';
}

function resolveStore(db, row) {
  const id = getValue(row, HEADER_ALIASES.storeId);
  if (id !== undefined && id !== '') {
    const store = db.queryOne('SELECT id,store_name FROM stores WHERE id=?', [Number(id)]);
    if (store) return store;
  }
  const name = String(getValue(row, HEADER_ALIASES.storeName) || '').trim();
  if (!name) return null;
  return db.queryOne('SELECT id,store_name FROM stores WHERE store_name=?', [name])
    || db.queryOne('SELECT id,store_name FROM stores WHERE store_name LIKE ?', [`%${name}%`]);
}

function workbookRows(base64) {
  const payload = String(base64 || '').replace(/^data:.*?;base64,/, '');
  if (!payload) throw new Error('文件内容为空');
  const workbook = XLSX.read(Buffer.from(payload, 'base64'), { type: 'buffer', cellDates: false });
  return workbook.SheetNames.flatMap(sheetName => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true }));
}

function replaceRevenue(db, record) {
  db.run('DELETE FROM business_revenue_records WHERE store_id=? AND biz_date=? AND source_type=? AND channel=?',
    [record.store_id, record.biz_date, record.source_type, record.channel]);
  db.insert(`INSERT INTO business_revenue_records
    (batch_id,store_id,store_name,biz_date,source_type,platform,channel_group,channel,recorded_amount,gross_amount,actual_amount,service_fee,insurance_fee,promotion_fee,refund_amount,order_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    record.batch_id, record.store_id, record.store_name, record.biz_date, record.source_type,
    record.platform || '', record.channel_group, record.channel, record.recorded_amount || 0,
    record.gross_amount || 0, record.actual_amount || 0, record.service_fee || 0,
    record.insurance_fee || 0, record.promotion_fee || 0, record.refund_amount || 0,
    record.order_count || 0,
  ]);
}

function importWorkbook(db, params, user) {
  const rows = workbookRows(params.data);
  if (!rows.length) throw new Error('表格中没有可导入的数据');
  const sourceType = params.source_type === 'platform' ? 'platform' : 'pos';
  const platform = String(params.platform || '').trim();
  const batchId = db.insert(`INSERT INTO business_import_batches
    (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    sourceType, platform, params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  let imported = 0;
  let productRows = 0;
  const errors = [];
  const dates = [];

  rows.forEach((row, index) => {
    const store = resolveStore(db, row);
    const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
    if (!store || !bizDate) {
      errors.push(`第 ${index + 2} 行：${!store ? '未匹配到门店' : '日期格式不正确'}`);
      return;
    }
    dates.push(bizDate);
    if (sourceType === 'pos') {
      Object.entries(POS_CHANNEL_HEADERS).forEach(([channel, aliases]) => {
        const raw = getValue(row, aliases);
        if (raw === undefined || raw === '') return;
        const meta = CHANNELS[channel];
        const amount = number(raw);
        replaceRevenue(db, {
          batch_id: batchId, store_id: store.id, store_name: store.store_name, biz_date: bizDate,
          source_type: 'pos', platform: '', channel_group: meta.group, channel,
          recorded_amount: amount, actual_amount: meta.group === 'offline' ? amount : 0,
          order_count: number(getValue(row, HEADER_ALIASES.orders)),
        });
        imported += 1;
      });
    } else {
      const channel = normalizeChannel(getValue(row, HEADER_ALIASES.channel) || platform);
      if (!channel || CHANNELS[channel].group === 'offline') {
        errors.push(`第 ${index + 2} 行：无法识别线上渠道`);
        return;
      }
      const gross = number(getValue(row, HEADER_ALIASES.gross));
      const fees = number(getValue(row, HEADER_ALIASES.serviceFee));
      const insurance = number(getValue(row, HEADER_ALIASES.insuranceFee));
      const promotion = number(getValue(row, HEADER_ALIASES.promotionFee));
      const refund = number(getValue(row, HEADER_ALIASES.refund));
      const suppliedActual = getValue(row, HEADER_ALIASES.actual);
      const actual = suppliedActual === undefined || suppliedActual === ''
        ? Math.max(0, gross - fees - insurance - promotion - refund)
        : number(suppliedActual);
      replaceRevenue(db, {
        batch_id: batchId, store_id: store.id, store_name: store.store_name, biz_date: bizDate,
        source_type: 'platform', platform: platform || CHANNELS[channel].label,
        channel_group: CHANNELS[channel].group, channel,
        recorded_amount: number(getValue(row, HEADER_ALIASES.recorded)), gross_amount: gross,
        actual_amount: actual, service_fee: fees, insurance_fee: insurance,
        promotion_fee: promotion, refund_amount: refund,
        order_count: number(getValue(row, HEADER_ALIASES.orders)),
      });
      imported += 1;

      const productName = String(getValue(row, HEADER_ALIASES.productName) || '').trim();
      if (productName) {
        db.run('DELETE FROM business_product_sales WHERE store_id=? AND biz_date=? AND source_type=? AND channel=? AND product_name=?',
          [store.id, bizDate, 'platform', channel, productName]);
        db.insert(`INSERT INTO business_product_sales
          (batch_id,store_id,store_name,biz_date,source_type,platform,channel,product_name,quantity,sales_amount)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [batchId, store.id, store.store_name, bizDate, 'platform',
          platform || CHANNELS[channel].label, channel, productName,
          number(getValue(row, HEADER_ALIASES.quantity)), number(getValue(row, HEADER_ALIASES.salesAmount))]);
        productRows += 1;
      }
    }
  });

  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [
    imported + productRows, dates.sort()[0] || null, dates.sort().at(-1) || null, batchId,
  ]);
  db.save();
  return { batch_id: batchId, imported, product_rows: productRows, skipped: errors.length, errors: errors.slice(0, 20) };
}

function ensureLegacyRecords(db) {
  const exists = db.queryOne("SELECT COUNT(*) AS total FROM business_revenue_records WHERE source_type='pos'");
  if (Number(exists?.total || 0) > 0) return;
  const reports = db.queryAll('SELECT * FROM daily_reports ORDER BY date');
  const mapping = [
    ['instore', 'scan_pay'], ['stored_value', 'mini_stored'], ['mt_tuan', 'meituan_group'],
    ['dy_tuan', 'douyin_group'], ['mt_waimai', 'meituan_delivery'],
    ['tb_flash', 'taobao_flash'], ['jd_waimai', 'jd_delivery'],
  ];
  reports.forEach(report => mapping.forEach(([field, channel]) => {
    const amount = number(report[field]);
    if (!amount) return;
    const meta = CHANNELS[channel];
    replaceRevenue(db, {
      batch_id: null, store_id: report.store_id, store_name: report.store_name,
      biz_date: report.date, source_type: 'pos', channel_group: meta.group, channel,
      recorded_amount: amount, actual_amount: meta.group === 'offline' ? amount : 0,
      order_count: report.order_count || 0,
    });
  }));
  if (reports.length) db.save();
}

function rangeWhere(params, alias = 'r') {
  const clauses = ['1=1'];
  const values = [];
  if (params.store_id) { clauses.push(`${alias}.store_id=?`); values.push(Number(params.store_id)); }
  if (params.date_from) { clauses.push(`${alias}.biz_date>=?`); values.push(params.date_from); }
  if (params.date_to) { clauses.push(`${alias}.biz_date<=?`); values.push(params.date_to); }
  return { sql: clauses.join(' AND '), values };
}

function periodExpr(period, field = 'biz_date') {
  if (period === 'month') return `substr(${field},1,7)`;
  if (period === 'week') return `strftime('%Y-W%W',${field})`;
  return field;
}

function getOverview(db, params = {}) {
  ensureLegacyRecords(db);
  const where = rangeWhere(params);
  const records = db.queryAll(`SELECT r.* FROM business_revenue_records r WHERE ${where.sql}`, where.values);
  const grouped = new Map();
  records.forEach(row => {
    const key = `${row.store_id}|${row.biz_date}|${row.channel}`;
    const item = grouped.get(key) || {
      store_id: row.store_id, store_name: row.store_name, biz_date: row.biz_date,
      channel: row.channel, channel_group: row.channel_group, recorded: 0, actual: 0,
      gross: 0, fees: 0, has_platform: false, orders: 0,
    };
    if (row.source_type === 'pos') item.recorded += number(row.recorded_amount);
    else {
      item.actual += number(row.actual_amount);
      item.gross += number(row.gross_amount);
      item.fees += number(row.service_fee) + number(row.insurance_fee) + number(row.promotion_fee) + number(row.refund_amount);
      item.has_platform = true;
      item.orders += number(row.order_count);
    }
    grouped.set(key, item);
  });

  const reconciled = [...grouped.values()].map(item => ({
    ...item,
    confirmed: item.channel_group === 'offline' ? item.recorded : (item.has_platform ? item.actual : item.recorded),
    difference: item.has_platform ? item.recorded - item.actual : null,
    difference_rate: item.has_platform && item.recorded ? (item.recorded - item.actual) / item.recorded : null,
    channel_label: CHANNELS[item.channel]?.label || item.channel,
  }));
  const period = params.period || 'day';
  const bucketOf = date => {
    if (period === 'month') return date.slice(0, 7);
    if (period === 'week') {
      const d = new Date(`${date}T00:00:00`);
      const first = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil((((d - first) / 86400000) + first.getDay() + 1) / 7);
      return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    return date;
  };
  const trendMap = new Map();
  const storeMap = new Map();
  const totals = { offline: 0, group_buy: 0, delivery: 0, confirmed: 0, recorded_online: 0, platform_online: 0, fees: 0, verified: 0, online_pairs: 0 };
  reconciled.forEach(item => {
    const bucket = bucketOf(item.biz_date);
    const trend = trendMap.get(bucket) || { period: bucket, offline: 0, group_buy: 0, delivery: 0, total: 0 };
    trend[item.channel_group] += item.confirmed;
    trend.total += item.confirmed;
    trendMap.set(bucket, trend);
    const store = storeMap.get(item.store_id) || { store_id: item.store_id, store_name: item.store_name, actual: 0, offline: 0, group_buy: 0, delivery: 0, difference: 0, verified_channels: 0 };
    store.actual += item.confirmed;
    store[item.channel_group] += item.confirmed;
    if (item.difference != null) { store.difference += item.difference; store.verified_channels += 1; }
    storeMap.set(item.store_id, store);
    totals[item.channel_group] += item.confirmed;
    totals.confirmed += item.confirmed;
    totals.fees += item.fees;
    if (item.channel_group !== 'offline') {
      totals.recorded_online += item.recorded;
      if (item.has_platform) { totals.platform_online += item.actual; totals.verified += 1; }
      totals.online_pairs += 1;
    }
  });
  totals.verification_rate = totals.online_pairs ? totals.verified / totals.online_pairs : 0;
  totals.online_difference = totals.recorded_online - totals.platform_online;

  const salesWhere = rangeWhere(params, 'p');
  const topProducts = db.queryAll(`SELECT product_name,SUM(quantity) quantity,SUM(sales_amount) sales_amount
    FROM business_product_sales p WHERE ${salesWhere.sql} GROUP BY product_name ORDER BY sales_amount DESC,quantity DESC LIMIT 10`, salesWhere.values);
  const batches = db.queryAll('SELECT * FROM business_import_batches ORDER BY id DESC LIMIT 8');
  return {
    totals,
    trend: [...trendMap.values()].sort((a, b) => a.period.localeCompare(b.period)),
    reconciliation: reconciled.filter(item => item.channel_group !== 'offline').sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0)),
    stores: [...storeMap.values()].sort((a, b) => b.actual - a.actual),
    top_products: topProducts,
    batches,
    channels: CHANNELS,
  };
}

function getScopedOverview(db, scope, params = {}) {
  const result = getOverview(db, params);
  if (scope === 'overview') return { ...result, scope: 'overview' };
  const group = scope === 'delivery' ? 'delivery' : 'group_buy';
  const scopeLabel = group === 'delivery' ? '外卖' : '团购';
  const scopeIncome = Number(result.totals[group] || 0);
  const storeTotal = Number(result.totals.confirmed || 0);
  const targetChannels = Object.entries(CHANNELS).filter(([, meta]) => meta.group === group).map(([code]) => code);
  const range = rangeWhere(params);
  const platformRows = db.queryAll(`SELECT * FROM business_revenue_records r WHERE ${range.sql} AND source_type='platform'`, range.values)
    .filter(row => targetChannels.includes(row.channel));
  const platformMap = new Map();
  platformRows.forEach(row => {
    const platform = row.platform || CHANNELS[row.channel]?.label || row.channel;
    const key = `${row.store_id}|${platform}`;
    const item = platformMap.get(key) || { store_id: row.store_id, store_name: row.store_name, platform, gross_amount: 0, actual_amount: 0, promotion_fee: 0, other_fees: 0, order_count: 0 };
    item.gross_amount += number(row.gross_amount);
    item.actual_amount += number(row.actual_amount);
    item.promotion_fee += number(row.promotion_fee);
    item.other_fees += number(row.service_fee) + number(row.insurance_fee) + number(row.refund_amount);
    item.order_count += number(row.order_count);
    platformMap.set(key, item);
  });
  return {
    scope,
    scope_label: scopeLabel,
    totals: {
      store_total: storeTotal,
      scope_income: scopeIncome,
      scope_ratio: storeTotal ? scopeIncome / storeTotal : 0,
    },
    trend: result.trend.map(item => ({ period: item.period, store_total: item.total, scope_income: item[group] || 0 })),
    stores: result.stores.map(store => ({
      store_id: store.store_id,
      store_name: store.store_name,
      store_total: store.actual,
      scope_income: store[group] || 0,
      scope_ratio: store.actual ? (store[group] || 0) / store.actual : 0,
    })).sort((a, b) => b.scope_income - a.scope_income),
    platform_breakdown: [...platformMap.values()].sort((a, b) => b.actual_amount - a.actual_amount),
    platforms: group === 'delivery' ? ['美团外卖', '淘宝闪购', '京东外卖'] : ['美团团购', '抖音团购', '免费试'],
  };
}

function scopeGroup(scope) {
  if (scope === 'delivery') return 'delivery';
  if (scope === 'group-buy' || scope === 'group_buy') return 'group_buy';
  return '';
}

function salesInScope(db, scope, params = {}) {
  const where = rangeWhere(params, 'p');
  const rows = db.queryAll(`SELECT p.* FROM business_product_sales p WHERE ${where.sql}`, where.values);
  const group = scopeGroup(scope);
  return group ? rows.filter(row => CHANNELS[row.channel]?.group === group) : rows;
}

function getProductAnalytics(db, scope, params = {}) {
  const rows = salesInScope(db, scope, params);
  const mappings = db.queryAll(`SELECT bm.*,m.name menu_name,m.category menu_category,m.cost unit_cost,m.spec_unit,m.spec_weight
    FROM business_product_mappings bm JOIN menu_items m ON m.id=bm.menu_item_id`);
  const mappingMap = new Map(mappings.map(row => [`${row.platform}|${row.external_product_name}`, row]));
  const grouped = new Map();
  rows.forEach(row => {
    const platform = row.platform || CHANNELS[row.channel]?.label || row.channel;
    const key = `${platform}|${row.product_name}`;
    const mapping = mappingMap.get(key);
    const item = grouped.get(key) || { platform, product_name: row.product_name, quantity: 0, sales_amount: 0, menu_item_id: mapping?.menu_item_id || null, menu_name: mapping?.menu_name || '', menu_category: mapping?.menu_category || '', unit_cost: number(mapping?.unit_cost), mapped: !!mapping };
    item.quantity += number(row.quantity);
    item.sales_amount += number(row.sales_amount);
    grouped.set(key, item);
  });
  const products = [...grouped.values()].map(item => ({ ...item, total_cost: item.mapped ? Math.round(item.quantity * item.unit_cost * 100) / 100 : null, gross_profit: item.mapped ? Math.round((item.sales_amount - item.quantity * item.unit_cost) * 100) / 100 : null }));
  return { products: products.sort((a, b) => b.sales_amount - a.sales_amount), totals: { quantity: products.reduce((s, r) => s + r.quantity, 0), sales_amount: products.reduce((s, r) => s + r.sales_amount, 0), total_cost: products.reduce((s, r) => s + (r.total_cost || 0), 0), mapped: products.filter(r => r.mapped).length, total_products: products.length } };
}

function getProductMappings(db, scope, params = {}) {
  const analytics = getProductAnalytics(db, scope, params);
  return { ...analytics, menu_items: db.queryAll(`SELECT id,name,category,spec_unit,spec_weight,cost FROM menu_items WHERE status='在售' ORDER BY category,name,id`) };
}

function saveProductMapping(db, params = {}) {
  const platform = String(params.platform || '').trim();
  const externalName = String(params.external_product_name || '').trim();
  const menuItemId = Number(params.menu_item_id);
  if (!platform || !externalName) throw new Error('平台和第三方商品名称不能为空');
  const menu = db.queryOne('SELECT id FROM menu_items WHERE id=?', [menuItemId]);
  if (!menu) throw new Error('标准菜品不存在');
  const group = scopeGroup(params.scope) || (['美团外卖','淘宝闪购','京东外卖'].includes(platform) ? 'delivery' : 'group_buy');
  db.run(`INSERT INTO business_product_mappings (platform,channel_group,external_product_name,menu_item_id)
    VALUES (?,?,?,?) ON CONFLICT(platform,external_product_name) DO UPDATE SET channel_group=excluded.channel_group,menu_item_id=excluded.menu_item_id,updated_at=datetime('now','localtime')`, [platform, group, externalName, menuItemId]);
  db.save();
  return { ok: true };
}

function createTemplate(sourceType) {
  const headers = sourceType === 'platform'
    ? ['日期', '门店ID', '门店名称', '渠道', '订单金额', '实收', '手续费', '保险费', '推广费', '退款金额', '订单数', '商品名称', '销量', '商品销售额']
    : ['日期', '门店ID', '门店名称', '扫码支付', '现金', '小程序储值消费', '其他线下', '美团团购', '抖音团购', '免费试', '美团外卖', '淘宝闪购', '京东外卖', '订单数'];
  const sheet = XLSX.utils.aoa_to_sheet([headers]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sourceType === 'platform' ? '平台营业数据' : '收银系统数据');
  return XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
}

module.exports = { importWorkbook, getOverview, getScopedOverview, getProductAnalytics, getProductMappings, saveProductMapping, createTemplate, CHANNELS, periodExpr };
