const XLSX = require('xlsx');

const CHANNELS = {
  store_sales: { label: '店内销售', group: 'offline' },
  pickup: { label: '自提销售', group: 'offline' },
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
  store_sales: ['店内销售', '店内实收'],
  pickup: ['自提销售'],
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
  const key = name.replace(/（订货）|\(订货\)|[\s]/g, '');
  const stores = db.queryAll('SELECT id,store_name FROM stores');
  return stores.find(store => store.store_name === name)
    || stores.find(store => store.store_name.replace(/[\s]/g, '') === key)
    || stores.find(store => key.includes(store.store_name.replace(/[\s]/g, '')) || store.store_name.replace(/[\s]/g, '').includes(key))
    || null;
}

function readWorkbook(base64) {
  const payload = String(base64 || '').replace(/^data:.*?;base64,/, '');
  if (!payload) throw new Error('文件内容为空');
  return XLSX.read(Buffer.from(payload, 'base64'), { type: 'buffer', cellDates: false });
}

function workbookRows(base64) {
  const workbook = readWorkbook(base64);
  return workbook.SheetNames.flatMap(sheetName => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true }));
}

function replaceRevenue(db, record) {
  db.run('DELETE FROM business_revenue_records WHERE store_id=? AND biz_date=? AND source_type=? AND channel=?',
    [record.store_id, record.biz_date, record.source_type, record.channel]);
  db.insert(`INSERT INTO business_revenue_records
    (batch_id,store_id,store_name,biz_date,source_type,platform,channel_group,channel,recorded_amount,gross_amount,actual_amount,service_fee,insurance_fee,promotion_fee,refund_amount,discount_amount,order_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    record.batch_id, record.store_id, record.store_name, record.biz_date, record.source_type,
    record.platform || '', record.channel_group, record.channel, record.recorded_amount || 0,
    record.gross_amount || 0, record.actual_amount || 0, record.service_fee || 0,
    record.insurance_fee || 0, record.promotion_fee || 0, record.refund_amount || 0,
    record.discount_amount || 0,
    record.order_count || 0,
  ]);
}

function fillMergedHeader(row = []) {
  let current = '';
  return row.map(value => {
    if (value !== '' && value != null) current = String(value).trim();
    return current;
  });
}

function detailedReportSheet(workbook) {
  return workbook.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: true }) }))
    .find(sheet => cleanKey(sheet.rows?.[0]?.[0]) === cleanKey('门店') && cleanKey(sheet.rows?.[0]?.[1]) === cleanKey('营业日') && cleanKey(sheet.rows?.[0]?.[4]) === cleanKey('营业收入(元)'));
}

function replaceRevenueComposition(db, batchId, store, bizDate, composition) {
  db.run('DELETE FROM business_revenue_compositions WHERE store_id=? AND biz_date=?', [store.id, bizDate]);
  Object.entries(composition).forEach(([category, amount]) => {
    db.insert(`INSERT INTO business_revenue_compositions (batch_id,store_id,store_name,biz_date,category,amount) VALUES (?,?,?,?,?,?)`, [
      batchId, store.id, store.store_name, bizDate, category, amount,
    ]);
  });
}

function importDetailedBusinessReport(db, report, params, user) {
  const [topHeader, groupHeader, fieldHeader] = report.rows.slice(0, 3).map(fillMergedHeader);
  const dataRows = report.rows.slice(3);
  const channelMap = { 店内销售: 'store_sales', 自提销售: 'pickup', 美团外卖: 'meituan_delivery', 淘宝闪购: 'taobao_flash', 京东秒送: 'jd_delivery' };
  const channelColumns = Object.fromEntries(Object.keys(channelMap).map(group => [group, {}]));
  const compositionColumns = {};
  groupHeader.forEach((group, index) => {
    if (channelColumns[group] && ['营业额(元)', '营业收入(元)', '优惠金额(元)', '订单量'].includes(fieldHeader[index])) channelColumns[group][fieldHeader[index]] = index;
    if (topHeader[index] === '营业收入构成' && group && group !== '小计') (compositionColumns[group] ||= []).push(index);
  });
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'pos', '经营日报', params.file_name || '', 0, user?.id || null, user?.display_name || user?.username || '',
  ]);
  let imported = 0;
  const errors = [];
  const dates = [];
  const matchedStoreIds = new Set();

  dataRows.forEach((row, rowIndex) => {
    const store = resolveStore(db, { 门店: row[0] });
    const bizDate = dateText(row[1]);
    if (!store || !bizDate) {
      errors.push(`第 ${rowIndex + 4} 行：${!store ? `未匹配到门店“${row[0] || ''}”` : '日期格式不正确'}`);
      return;
    }
    matchedStoreIds.add(store.id);
    dates.push(bizDate);
    Object.entries(channelMap).forEach(([group, channel]) => {
      const indexes = channelColumns[group];
      const gross = number(row[indexes['营业额(元)']]);
      const actual = number(row[indexes['营业收入(元)']]);
      const discount = number(row[indexes['优惠金额(元)']]);
      const orders = number(row[indexes['订单量']]);
      const meta = CHANNELS[channel];
      replaceRevenue(db, {
        batch_id: batchId, store_id: store.id, store_name: store.store_name, biz_date: bizDate,
        source_type: 'pos', platform: meta.group === 'delivery' ? meta.label : '', channel_group: meta.group, channel,
        recorded_amount: actual, gross_amount: gross, actual_amount: meta.group === 'offline' ? actual : 0,
        discount_amount: discount, order_count: orders,
      });
      imported += 1;
    });
    const composition = Object.fromEntries(Object.entries(compositionColumns).map(([category, indexes]) => [category, indexes.reduce((sum, index) => sum + number(row[index]), 0)]));
    replaceRevenueComposition(db, batchId, store, bizDate, composition);
  });
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [imported, dates.sort()[0] || null, dates.sort().at(-1) || null, batchId]);
  db.save();
  return { batch_id: batchId, imported, product_rows: 0, skipped: errors.length, errors: errors.slice(0, 20), detailed_report: true, matched_stores: matchedStoreIds.size, rows: dataRows.length };
}

function importWorkbook(db, params, user) {
  const workbook = readWorkbook(params.data);
  const detailedReport = detailedReportSheet(workbook);
  if (detailedReport) return importDetailedBusinessReport(db, detailedReport, params, user);
  const rows = workbook.SheetNames.flatMap(sheetName => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true }));
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
  const storeIds = Array.isArray(params.store_ids)
    ? params.store_ids
    : String(params.store_ids || '').split(',');
  const normalizedStoreIds = storeIds.map(Number).filter(id => Number.isInteger(id) && id > 0);
  if (normalizedStoreIds.length) {
    clauses.push(`${alias}.store_id IN (${normalizedStoreIds.map(() => '?').join(',')})`);
    values.push(...normalizedStoreIds);
  } else if (params.store_id) { clauses.push(`${alias}.store_id=?`); values.push(Number(params.store_id)); }
  if (params.channel_group) {
    if (alias === 'p') {
      const channels = Object.entries(CHANNELS).filter(([, meta]) => meta.group === String(params.channel_group)).map(([key]) => key);
      clauses.push(`${alias}.channel IN (${channels.map(() => '?').join(',') || "''"})`);
      values.push(...channels);
    } else {
      clauses.push(`${alias}.channel_group=?`);
      values.push(String(params.channel_group));
    }
  }
  if (params.platform) { clauses.push(`${alias}.platform=?`); values.push(String(params.platform)); }
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
      gross: 0, discount: 0, fees: 0, has_platform: false, orders: 0,
    };
    item.gross += number(row.gross_amount);
    item.discount += number(row.discount_amount);
    item.orders += number(row.order_count);
    if (row.source_type === 'pos') item.recorded += number(row.recorded_amount);
    else {
      item.actual += number(row.actual_amount);
      item.fees += number(row.service_fee) + number(row.insurance_fee) + number(row.promotion_fee) + number(row.refund_amount);
      item.has_platform = true;
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
  const period = params.trend_period || params.period || 'day';
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
  const channelMap = new Map();
  const totals = { offline: 0, group_buy: 0, delivery: 0, confirmed: 0, gross_amount: 0, discount_amount: 0, order_count: 0, recorded_online: 0, platform_online: 0, fees: 0, verified: 0, online_pairs: 0 };
  reconciled.forEach(item => {
    const bucket = bucketOf(item.biz_date);
    const trend = trendMap.get(bucket) || { period: bucket, offline: 0, group_buy: 0, delivery: 0, total: 0 };
    trend[item.channel_group] += item.confirmed;
    trend.total += item.confirmed;
    trendMap.set(bucket, trend);
    const store = storeMap.get(item.store_id) || { store_id: item.store_id, store_name: item.store_name, gross_amount: 0, actual: 0, order_count: 0, offline: 0, group_buy: 0, delivery: 0, difference: 0, verified_channels: 0 };
    store.gross_amount += item.gross;
    store.actual += item.confirmed;
    store.order_count += item.orders;
    store[item.channel_group] += item.confirmed;
    if (item.difference != null) { store.difference += item.difference; store.verified_channels += 1; }
    storeMap.set(item.store_id, store);
    const channel = channelMap.get(item.channel) || { channel: item.channel, label: item.channel_label, group: item.channel_group, amount: 0, gross_amount: 0, discount_amount: 0, order_count: 0 };
    channel.amount += item.confirmed;
    channel.gross_amount += item.gross;
    channel.discount_amount += item.discount;
    channel.order_count += item.orders;
    channelMap.set(item.channel, channel);
    totals[item.channel_group] += item.confirmed;
    totals.confirmed += item.confirmed;
    totals.gross_amount += item.gross;
    totals.discount_amount += item.discount;
    totals.order_count += item.orders;
    totals.fees += item.fees;
    if (item.channel_group !== 'offline') {
      totals.recorded_online += item.recorded;
      if (item.has_platform) { totals.platform_online += item.actual; totals.verified += 1; }
      totals.online_pairs += 1;
    }
  });
  totals.verification_rate = totals.online_pairs ? totals.verified / totals.online_pairs : 0;
  totals.online_difference = totals.recorded_online - totals.platform_online;

  // 单店周、月趋势按天展开；没有营业记录的日期也保留为 0，确保曲线完整连续。
  if (period === 'day' && params.date_from && params.date_to) {
    const cursor = new Date(`${params.date_from}T12:00:00`);
    const end = new Date(`${params.date_to}T12:00:00`);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      if (!trendMap.has(key)) trendMap.set(key, { period: key, offline: 0, group_buy: 0, delivery: 0, total: 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const salesWhere = rangeWhere(params, 'p');
  const topProducts = db.queryAll(`SELECT product_name,SUM(quantity) quantity,SUM(sales_amount) sales_amount
    FROM business_product_sales p WHERE ${salesWhere.sql} GROUP BY product_name ORDER BY sales_amount DESC,quantity DESC LIMIT 10`, salesWhere.values);
  // 营业收入构成与渠道营业构成是两套口径：前者按日报二级表头汇总，不跟随渠道筛选。
  const compositionParams = { ...params };
  delete compositionParams.channel_group;
  delete compositionParams.platform;
  const compositionWhere = rangeWhere(compositionParams, 'c');
  const revenueComposition = db.queryAll(`SELECT category,SUM(amount) amount
    FROM business_revenue_compositions c WHERE ${compositionWhere.sql}
    GROUP BY category ORDER BY amount DESC`, compositionWhere.values);
  const reconciliationRows = reconciled.filter(item => item.channel_group !== 'offline').sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0));
  const reconciliationPageSize = Math.max(10, Math.min(100, Number(params.reconciliation_page_size) || 20));
  const reconciliationTotal = reconciliationRows.length;
  const reconciliationPageCount = Math.max(1, Math.ceil(reconciliationTotal / reconciliationPageSize));
  const reconciliationPage = Math.min(reconciliationPageCount, Math.max(1, Number(params.reconciliation_page) || 1));
  const reconciliation = reconciliationRows.slice((reconciliationPage - 1) * reconciliationPageSize, reconciliationPage * reconciliationPageSize);
  const batches = db.queryAll('SELECT * FROM business_import_batches ORDER BY id DESC LIMIT 8');
  return {
    totals,
    trend: [...trendMap.values()].sort((a, b) => a.period.localeCompare(b.period)),
    reconciliation,
    reconciliation_total: reconciliationTotal,
    reconciliation_page: reconciliationPage,
    reconciliation_page_size: reconciliationPageSize,
    stores: [...storeMap.values()].sort((a, b) => b.actual - a.actual),
    channel_breakdown: [...channelMap.values()].sort((a, b) => b.amount - a.amount),
    top_products: topProducts,
    revenue_composition: revenueComposition,
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

// 本地菜品的名称不足以作为绑定依据。烧鹅的上庄、下庄、半只等都属于不同 SKU，
// 因此统一补齐规格、做法、售卖单位与价格，供绑定列表和下拉选择器明确展示。
function withMenuSku(menu = {}) {
  const name = String(menu.name || '').trim();
  const spec = String(menu.spec || '').trim();
  const method = String(menu.method || '').trim();
  const unit = String(menu.spec_unit || '').trim();
  const weight = String(menu.spec_weight || '').trim();
  const variantParts = [];
  [spec, method && method !== '/' ? method : '', weight || unit].filter(Boolean).forEach(part => {
    // 旧菜品数据常把“份/常规”同时写入规格和单位；展示时只保留一次。
    if (!variantParts.some(existing => existing === part)) variantParts.push(part);
  });
  const variant = variantParts.join(' · ');
  const dineInPrice = number(menu.dine_in_price || menu.price);
  const memberPrice = number(menu.member_price);
  const takeoutPrice = number(menu.takeout_price);
  const priceParts = [
    dineInPrice ? `堂食 ¥${dineInPrice.toFixed(2)}` : '',
    memberPrice ? `会员 ¥${memberPrice.toFixed(2)}` : '',
    takeoutPrice ? `外卖 ¥${takeoutPrice.toFixed(2)}` : '',
  ].filter(Boolean);

  return {
    ...menu,
    sku_label: `${name}${variant ? ` · ${variant}` : ''}`,
    sku_variant: variant || '标准规格',
    sku_price_summary: priceParts.join(' / ') || '价格未设置',
    dine_in_price: dineInPrice,
    member_price: memberPrice,
    takeout_price: takeoutPrice,
  };
}

function salesInScope(db, scope, params = {}) {
  const where = rangeWhere(params, 'p');
  const rows = db.queryAll(`SELECT p.* FROM business_product_sales p WHERE ${where.sql}`, where.values);
  const group = scopeGroup(scope);
  return group ? rows.filter(row => CHANNELS[row.channel]?.group === group) : rows;
}

function getProductAnalytics(db, scope, params = {}) {
  const rows = salesInScope(db, scope, params);
  const mappings = db.queryAll(`SELECT bm.id mapping_id,bm.*,m.name menu_name,m.category menu_category,m.cost unit_cost,
      m.spec menu_spec,m.method menu_method,m.spec_unit menu_spec_unit,m.spec_weight menu_spec_weight,
      m.price menu_price,m.dine_in_price menu_dine_in_price,m.member_price menu_member_price,m.takeout_price menu_takeout_price
    FROM business_product_mappings bm JOIN menu_items m ON m.id=bm.menu_item_id`).map(row => {
    const sku = withMenuSku({
      name: row.menu_name,
      spec: row.menu_spec,
      method: row.menu_method,
      spec_unit: row.menu_spec_unit,
      spec_weight: row.menu_spec_weight,
      price: row.menu_price,
      dine_in_price: row.menu_dine_in_price,
      member_price: row.menu_member_price,
      takeout_price: row.menu_takeout_price,
    });
    return { ...row, menu_sku_label: sku.sku_label, menu_sku_variant: sku.sku_variant, menu_sku_price_summary: sku.sku_price_summary };
  });
  const mappingMap = new Map(mappings.map(row => [`${row.platform}|${row.external_product_name}`, row]));
  const grouped = new Map();
  rows.forEach(row => {
    const platform = row.platform || CHANNELS[row.channel]?.label || row.channel;
    const key = `${platform}|${row.product_name}`;
    const mapping = mappingMap.get(key);
    const item = grouped.get(key) || {
      platform,
      product_name: row.product_name,
      quantity: 0,
      sales_amount: 0,
      mapping_id: mapping?.mapping_id || null,
      menu_item_id: mapping?.menu_item_id || null,
      menu_name: mapping?.menu_name || '',
      menu_category: mapping?.menu_category || '',
      menu_sku_label: mapping?.menu_sku_label || '',
      menu_sku_variant: mapping?.menu_sku_variant || '',
      menu_sku_price_summary: mapping?.menu_sku_price_summary || '',
      unit_cost: number(mapping?.unit_cost),
      mapped: !!mapping,
    };
    item.quantity += number(row.quantity);
    item.sales_amount += number(row.sales_amount);
    grouped.set(key, item);
  });
  const products = [...grouped.values()].map(item => ({ ...item, total_cost: item.mapped ? Math.round(item.quantity * item.unit_cost * 100) / 100 : null, gross_profit: item.mapped ? Math.round((item.sales_amount - item.quantity * item.unit_cost) * 100) / 100 : null }));
  return { products: products.sort((a, b) => b.sales_amount - a.sales_amount), totals: { quantity: products.reduce((s, r) => s + r.quantity, 0), sales_amount: products.reduce((s, r) => s + r.sales_amount, 0), total_cost: products.reduce((s, r) => s + (r.total_cost || 0), 0), mapped: products.filter(r => r.mapped).length, total_products: products.length } };
}

function getProductMappings(db, scope, params = {}) {
  const analytics = getProductAnalytics(db, scope, params);
  const menuItems = db.queryAll(`SELECT id,name,category,method,spec,price,dine_in_price,member_price,takeout_price,spec_unit,spec_weight,cost
    FROM menu_items WHERE status='在售' ORDER BY category,name,spec,id`).map(withMenuSku);
  return { ...analytics, menu_items: menuItems };
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

function deleteProductMapping(db, id) {
  const mappingId = Number(id);
  if (!Number.isInteger(mappingId) || mappingId <= 0) throw new Error('映射 ID 无效');
  const affected = db.run('DELETE FROM business_product_mappings WHERE id=?', [mappingId]);
  if (!affected) throw new Error('绑定记录不存在');
  db.save();
  return { ok: true, id: mappingId };
}

function parseDiagnosis(row) {
  if (!row) return null;
  let result = {};
  try { result = JSON.parse(row.result_json || '{}'); } catch {}
  return { id: row.id, perspective_key: row.perspective_key, perspective_title: row.perspective_title, date_from: row.date_from, date_to: row.date_to, created_at: row.created_at, updated_at: row.updated_at, ...result };
}

function buildDiagnosis(overview, params = {}) {
  const totals = overview.totals || {};
  const gross = number(totals.gross_amount);
  const actual = number(totals.confirmed);
  const discount = number(totals.discount_amount);
  const orders = number(totals.order_count);
  const discountRate = gross ? discount / gross : 0;
  const averageOrder = orders ? actual / orders : 0;
  const channels = overview.channel_breakdown || [];
  const topChannel = channels[0];
  const stores = overview.stores || [];
  const bestStore = stores[0];
  const weakestStore = stores.length > 1 ? stores.at(-1) : null;
  const findings = [];
  const recommendations = [];

  if (gross <= 0) {
    findings.push({ level: 'warning', title: '当前范围暂无有效营业数据', detail: '请确认时间、门店和渠道筛选条件，或先完成营业数据导入。' });
    recommendations.push('先补齐收银营业日报，再使用诊断结果判断渠道与门店表现。');
  } else {
    findings.push({ level: 'info', title: '当期经营概览', detail: `营业额 ${gross.toFixed(2)} 元，实收 ${actual.toFixed(2)} 元，共 ${orders.toLocaleString('zh-CN')} 单，客单价约 ${averageOrder.toFixed(2)} 元。` });
    if (discountRate >= 0.2) {
      findings.push({ level: 'warning', title: '优惠让利占比较高', detail: `优惠金额占营业额 ${(discountRate * 100).toFixed(1)}%，建议复核优惠活动的核销效率与毛利空间。` });
      recommendations.push('按优惠活动拆分核销订单，保留能带来复购或加购的优惠，收紧低转化的大额优惠。');
    } else {
      findings.push({ level: 'success', title: '优惠控制较稳', detail: `优惠金额占营业额 ${(discountRate * 100).toFixed(1)}%，当前让利水平处于可控范围。` });
      recommendations.push('持续按周跟踪优惠占比与订单增量，避免优惠力度在高峰期无效放大。');
    }
    if (topChannel) {
      const share = actual ? number(topChannel.amount) / actual : 0;
      findings.push({ level: 'info', title: '主要收入渠道', detail: `${topChannel.label} 实收 ${number(topChannel.amount).toFixed(2)} 元，占当期实收 ${(share * 100).toFixed(1)}%。` });
      recommendations.push(`${topChannel.label}为主要贡献渠道，建议在该渠道补充高毛利加料或套餐搭配，同时保留其他渠道的基础曝光。`);
    }
    if (bestStore && weakestStore) {
      findings.push({ level: 'info', title: '门店表现存在差异', detail: `${bestStore.store_name}当前实收最高；${weakestStore.store_name}相对偏低，建议结合订单量、营业时段和渠道结构进行复盘。` });
      recommendations.push(`提炼${bestStore.store_name}的高峰排班、出餐和活动做法，优先在${weakestStore.store_name}进行一周验证。`);
    }
  }
  return {
    is_simulated: true,
    headline: gross > 0 ? '当期经营诊断已生成' : '等待有效经营数据',
    summary: gross > 0 ? `基于当前筛选范围的数据模拟生成，重点关注实收、优惠、渠道和门店差异。` : '当前筛选范围未形成有效营业数据，暂无法给出经营改善判断。',
    metrics: { gross_amount: gross, actual_amount: actual, order_count: orders, discount_amount: discount, discount_rate: discountRate, average_order: averageOrder },
    findings,
    recommendations: [...new Set(recommendations)].slice(0, 4),
    generated_at: new Date().toISOString(),
  };
}

function getDiagnosis(db, params = {}) {
  const perspectiveKey = String(params.perspective_key || '').trim();
  const signature = String(params.filter_signature || '').trim();
  if (!perspectiveKey || !signature) return null;
  return parseDiagnosis(db.queryOne('SELECT * FROM business_ai_diagnoses WHERE perspective_key=? AND filter_signature=?', [perspectiveKey, signature]));
}

function generateDiagnosis(db, params = {}, user) {
  const perspectiveKey = String(params.perspective_key || '').trim();
  const signature = String(params.filter_signature || '').trim();
  if (!perspectiveKey || !signature) throw new Error('缺少诊断查询条件');
  const analysisParams = params.analysis_params || {};
  const result = buildDiagnosis(getOverview(db, analysisParams), analysisParams);
  const existing = db.queryOne('SELECT id FROM business_ai_diagnoses WHERE perspective_key=? AND filter_signature=?', [perspectiveKey, signature]);
  const values = [params.perspective_title || '', analysisParams.date_from || '', analysisParams.date_to || '', JSON.stringify(result), user?.id || null, user?.display_name || user?.username || ''];
  if (existing) {
    db.run(`UPDATE business_ai_diagnoses SET perspective_title=?,date_from=?,date_to=?,result_json=?,created_by=?,created_by_name=?,updated_at=datetime('now','localtime') WHERE id=?`, [...values, existing.id]);
  } else {
    db.insert(`INSERT INTO business_ai_diagnoses (perspective_key,filter_signature,perspective_title,date_from,date_to,result_json,created_by,created_by_name) VALUES (?,?,?,?,?,?,?,?)`, [perspectiveKey, signature, ...values]);
  }
  db.save();
  return getDiagnosis(db, { perspective_key: perspectiveKey, filter_signature: signature });
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

module.exports = { importWorkbook, getOverview, getScopedOverview, getProductAnalytics, getProductMappings, saveProductMapping, deleteProductMapping, getDiagnosis, generateDiagnosis, createTemplate, CHANNELS, periodExpr };
