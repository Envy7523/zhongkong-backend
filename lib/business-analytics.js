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
  productName: ['商品', '商品名', '商品名称', '菜品名称', 'product_name'],
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
    const compact = String(Math.trunc(value));
    if (/^\d{8}$/.test(compact)) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
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
  const buffer = Buffer.from(payload, 'base64');
  // 美团导出的 CSV 通常是 GB18030/GBK，而 xlsx 默认按 UTF-8 读取会把“日期、门店id、商品名”等表头解析为乱码，
  // 导致后续报表类型和字段无法识别。二进制 Excel 仍交给 SheetJS 原样处理；纯文本 CSV 按实际字节编码解析。
  const isZipWorkbook = buffer.length >= 4 && buffer.subarray(0, 4).toString('binary') === 'PK\x03\x04';
  const isOleWorkbook = buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1';
  if (isZipWorkbook || isOleWorkbook) return XLSX.read(buffer, { type: 'buffer', cellDates: false });

  const utf8Text = buffer.toString('utf8');
  const isUtf8 = Buffer.from(utf8Text, 'utf8').equals(buffer);
  return XLSX.read(buffer, { type: 'buffer', cellDates: false, codepage: isUtf8 ? 65001 : 936 });
}

function workbookRows(base64) {
  const workbook = readWorkbook(base64);
  return workbook.SheetNames.flatMap(sheetName => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true }));
}

function assertDeliveryReportKind(params, actualKind) {
  const requested = String(params?.report_kind || '').trim();
  if (!requested || requested === actualKind) return;
  const labels = { operating: '营业数据表', products: '商品销量表', settlement: '真实到账表' };
  throw new Error(`当前选择的是“${labels[requested] || requested}”，但文件识别为“${labels[actualKind] || actualKind}”。请切换报表类型后重新导入。`);
}

// 外卖三平台的导出文件名高度相似——“门店_20260901_20260909_鹅太公总商_时间戳.xlsx”
// 这类名字在淘宝闪购与京东外卖后台都会生成，仅凭文件名无法区分（此前京东数据会被判成淘宝闪购）。
// 因此导入时改为按表内门店 ID 判定真实平台：优先命中“第三方平台”档案，其次按已登记 ID 的段位特征匹配。
// 只有在命中数足够且明显领先时才改判，避免个别串号把整份报表导错平台。
const DELIVERY_PLATFORM_NAMES = ['美团外卖', '淘宝闪购', '京东外卖'];
const DELIVERY_STORE_ID_ALIASES = ['门店id', '门店ID', '门店编号', '门店号', '美团门店id', '美团门店ID', '淘宝门店ID', '淘宝门店id', '京东门店ID', '京东门店id'];
const DELIVERY_WORKBOOK_IMPORTERS = {
  美团外卖: (db, params, user) => importMeituanDeliveryWorkbook(db, params, user),
  淘宝闪购: (db, params, user) => importTaobaoFlashWorkbook(db, params, user),
  京东外卖: (db, params, user) => importJdDeliveryWorkbook(db, params, user),
};

function storeIdSignature(id) {
  const text = String(id || '').trim();
  return text ? `${text.length}:${text.slice(0, 2)}` : '';
}

function collectDeliveryStoreIds(workbook) {
  const ids = new Set();
  workbook.SheetNames.forEach(sheetName => {
    XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true }).forEach(row => {
      const value = String(getValue(row, DELIVERY_STORE_ID_ALIASES) || '').trim();
      if (value) ids.add(value);
    });
  });
  return [...ids];
}

function detectDeliveryPlatformByStoreIds(db, ids, declared) {
  if (!ids.length) return null;
  const exact = new Map();
  const bySignature = new Map();
  ids.forEach(id => {
    const hit = db.queryOne(`SELECT platform_name FROM store_platforms WHERE platform_id=? LIMIT 1`, [id]);
    if (hit?.platform_name) exact.set(hit.platform_name, (exact.get(hit.platform_name) || 0) + 1);
    const signature = storeIdSignature(id);
    if (signature) bySignature.set(signature, (bySignature.get(signature) || 0) + 1);
  });
  const registered = db.queryAll(`SELECT platform_name, platform_id FROM store_platforms WHERE platform_id IS NOT NULL AND platform_id<>''`);
  const patternTotals = new Map();
  const patternHits = new Map();
  registered.forEach(item => {
    const signature = storeIdSignature(item.platform_id);
    if (!signature) return;
    patternTotals.set(signature, (patternTotals.get(signature) || 0) + 1);
    if (bySignature.has(signature)) patternHits.set(item.platform_name, (patternHits.get(item.platform_name) || 0) + bySignature.get(signature));
  });
  const pick = (scores, minimum) => {
    const ranked = [...scores.entries()].filter(item => DELIVERY_PLATFORM_NAMES.includes(item[0])).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    const [platform, matched] = ranked[0];
    const runnerUp = ranked[1] ? ranked[1][1] : 0;
    if (matched < minimum || matched < runnerUp * 2) return null;
    return { platform, matched };
  };
  // 第一优先：门店 ID 精确命中平台档案
  const exactPick = pick(exact, 2);
  if (exactPick) return exactPick.platform === declared ? null : { ...exactPick, total: ids.length, basis: 'exact' };
  // 第二优先：ID 长度 + 前两位段位与已登记档案一致（覆盖尚未登记的新门店）
  const patternPick = pick(patternHits, 2);
  if (!patternPick || patternPick.matched / ids.length < 0.6) return null;
  return patternPick.platform === declared ? null : { ...patternPick, total: ids.length, basis: 'pattern' };
}

function routeDeliveryPlatform(db, params, user, declared) {
  let workbook;
  try { workbook = readWorkbook(params.data); } catch { return null; }
  const detected = detectDeliveryPlatformByStoreIds(db, collectDeliveryStoreIds(workbook), declared);
  if (!detected) return null;
  const importer = DELIVERY_WORKBOOK_IMPORTERS[detected.platform];
  if (!importer) return null;
  const result = importer(db, params, user);
  return {
    ...result,
    platform: detected.platform,
    platform_switch: { from: declared, to: detected.platform, matched_ids: detected.matched, total_ids: detected.total, basis: detected.basis },
  };
}

function replaceRevenue(db, record) {
  db.run('DELETE FROM business_revenue_records WHERE store_id=? AND biz_date=? AND source_type=? AND channel=?',
    [record.store_id, record.biz_date, record.source_type, record.channel]);
  db.insert(`INSERT INTO business_revenue_records
    (batch_id,store_id,store_name,biz_date,source_type,platform,channel_group,channel,recorded_amount,gross_amount,platform_income_amount,actual_amount,service_fee,insurance_fee,promotion_fee,refund_amount,discount_amount,order_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    record.batch_id, record.store_id, record.store_name, record.biz_date, record.source_type,
    record.platform || '', record.channel_group, record.channel, record.recorded_amount || 0,
    record.gross_amount || 0, record.platform_income_amount || 0, record.actual_amount || 0, record.service_fee || 0,
    record.insurance_fee || 0, record.promotion_fee || 0, record.refund_amount || 0,
    record.discount_amount || 0,
    record.order_count || 0,
  ]);
}

// 淘宝闪购“账单类型”决定账单金额在经营看板中的归属。
// “外卖”是优惠后的平台收入；营业额必须取自“营业额收入单量”日报，不能混用。
function taobaoBillCategory(billType) {
  const type = String(billType || '').trim();
  if (type === '外卖') return 'revenue';
  if (/退款|售后|赔付/.test(type)) return 'refund_amount';
  if (/推广|红包|营销|流量/.test(type)) return 'promotion_fee';
  if (/保障|配送|履约/.test(type)) return 'insurance_fee';
  return 'service_fee';
}

/**
 * 用已保存的闪购账单重建平台营收记录。
 * 只重建 source_type='platform'，绝不删除收银系统（pos）记录，以保留双向核对依据。
 */
function rebuildTaobaoFlashRevenue(db, { from, to, batchId }) {
  if (!from || !to) return { revenueRecords: 0, netTotal: 0, grossTotal: 0, incomeTotal: 0, feeTotal: 0, feeBreakdown: {} };
  const oldRows = db.queryAll(`SELECT store_id, biz_date, source_type, order_count FROM business_revenue_records
    WHERE source_type IN ('pos','platform') AND channel='taobao_flash' AND biz_date>=? AND biz_date<=?`, [from, to]);
  const orderMap = new Map();
  oldRows.forEach(row => {
    const key = `${row.store_id}|${row.biz_date}`;
    // 正常情况下订单量来自收银日报；对已经被旧版逻辑误删的历史收银记录，暂时沿用旧平台记录避免归零。
    if (row.source_type === 'pos' || !orderMap.has(key)) orderMap.set(key, Number(row.order_count) || 0);
  });
  const dailyRows = db.queryAll(`
    SELECT store_id, store_name, biz_date, gross_amount, income_amount, order_count
    FROM taobao_flash_daily_reports
    WHERE match_status='matched' AND biz_date>=? AND biz_date<=?
    ORDER BY store_id, biz_date, id`, [from, to]);
  const dailyMap = new Map(dailyRows.map(row => [`${row.store_id}|${row.biz_date}`, row]));
  const billRows = db.queryAll(`
    SELECT store_id, store_name, bill_date, bill_type, amount
    FROM taobao_flash_bills
    WHERE match_status='matched' AND bill_date>=? AND bill_date<=?
    ORDER BY store_id, bill_date, id`, [from, to]);
  const aggregates = new Map();
  // 先建立日报基准：营业额、优惠后收入、订单量只来自日报。
  dailyRows.forEach(row => {
    const key = `${row.store_id}|${row.biz_date}`;
    aggregates.set(key, {
      store_id: row.store_id, store_name: row.store_name, bill_date: row.biz_date,
      gross_amount: number(row.gross_amount), platform_income_amount: number(row.income_amount),
      actual_amount: number(row.income_amount), discount_amount: Math.max(0, number(row.gross_amount) - number(row.income_amount)),
      service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0, has_bill: false,
    });
  });
  billRows.forEach(row => {
    const key = `${row.store_id}|${row.bill_date}`;
    const item = aggregates.get(key) || {
      store_id: row.store_id, store_name: row.store_name, bill_date: row.bill_date,
      gross_amount: 0, platform_income_amount: 0, actual_amount: 0, discount_amount: 0,
      service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0, has_bill: false,
    };
    const amount = number(row.amount);
    if (!item.has_bill) { item.actual_amount = 0; item.has_bill = true; }
    item.actual_amount += amount;
    const category = taobaoBillCategory(row.bill_type);
    if (category === 'revenue') {
      // 日报尚未导入时，以账单“外卖”收入作为临时回退值，绝不称为营业额。
      if (!dailyMap.has(key)) item.platform_income_amount += amount;
    }
    else item[category] -= amount; // 账单支出为负数，费用字段按正数展示；正向调整会冲减相应费用。
    aggregates.set(key, item);
  });

  // 仅移除旧的平台净额，保留收银机“记录金额”和订单数用于后续双向核对。
  db.run(`DELETE FROM business_revenue_records
    WHERE source_type='platform' AND channel='taobao_flash' AND biz_date>=? AND biz_date<=?`, [from, to]);

  const feeBreakdown = { service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0 };
  let revenueRecords = 0;
  let netTotal = 0;
  let grossTotal = 0;
  let incomeTotal = 0;
  aggregates.forEach(agg => {
    if (!agg.gross_amount) agg.gross_amount = agg.platform_income_amount;
    if (!agg.discount_amount) agg.discount_amount = Math.max(0, agg.gross_amount - agg.platform_income_amount);
    replaceRevenue(db, {
      batch_id: batchId, store_id: agg.store_id, store_name: agg.store_name, biz_date: agg.bill_date,
      source_type: 'platform', platform: '淘宝闪购', channel_group: 'delivery', channel: 'taobao_flash',
      gross_amount: agg.gross_amount, platform_income_amount: agg.platform_income_amount,
      actual_amount: agg.actual_amount, discount_amount: agg.discount_amount,
      service_fee: agg.service_fee, insurance_fee: agg.insurance_fee,
      promotion_fee: agg.promotion_fee, refund_amount: agg.refund_amount,
      order_count: dailyMap.get(`${agg.store_id}|${agg.bill_date}`)?.order_count || orderMap.get(`${agg.store_id}|${agg.bill_date}`) || 0,
    });
    revenueRecords += 1;
    netTotal += agg.actual_amount;
    grossTotal += agg.gross_amount;
    incomeTotal += agg.platform_income_amount;
    feeBreakdown.service_fee += agg.service_fee;
    feeBreakdown.insurance_fee += agg.insurance_fee;
    feeBreakdown.promotion_fee += agg.promotion_fee;
    feeBreakdown.refund_amount += agg.refund_amount;
  });
  const feeTotal = Object.values(feeBreakdown).reduce((sum, value) => sum + value, 0);
  return { revenueRecords, netTotal, grossTotal, incomeTotal, feeTotal, feeBreakdown };
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
    .find(sheet => {
      const header = sheet.rows?.[0] || [];
      // 完整经营日报存在两种固定布局：门店/营业日在前两列，或城市/门店/营业日在前三列。
      const compactWithCity = cleanKey(header[0]) === cleanKey('城市')
        && ['门店', '门店名称'].some(value => cleanKey(header[1]) === cleanKey(value))
        && ['营业日', '营业日期'].some(value => cleanKey(header[2]) === cleanKey(value));
      const classic = ['门店', '门店名称'].some(value => cleanKey(header[0]) === cleanKey(value))
        && ['营业日', '营业日期'].some(value => cleanKey(header[1]) === cleanKey(value));
      return (compactWithCity || classic) && cleanKey(header[compactWithCity ? 5 : 4]) === cleanKey('营业收入(元)');
    });
}

function replaceRevenueComposition(db, batchId, store, bizDate, composition) {
  db.run('DELETE FROM business_revenue_compositions WHERE store_id=? AND biz_date=?', [store.id, bizDate]);
  Object.entries(composition).forEach(([category, amount]) => {
    db.insert(`INSERT INTO business_revenue_compositions (batch_id,store_id,store_name,biz_date,category,amount) VALUES (?,?,?,?,?,?)`, [
      batchId, store.id, store.store_name, bizDate, category, amount,
    ]);
  });
}

// 收银日报的“营业收入构成”中，美团/大众点评团购与美团/大众点评支付
// 同属美团团购收银侧收入。两列相加后作为与第三方收益明细的核对基数。
function meituanGroupCompositionAmount(composition = {}) {
  return Object.entries(composition).reduce((total, [category, amount]) => (
    /美团.*大众点评.*(?:团购|支付)|(?:美团|大众点评)(?:团购|支付)/.test(String(category || ''))
      ? total + number(amount)
      : total
  ), 0);
}

function douyinGroupCompositionAmount(composition = {}) {
  return Object.entries(composition).reduce((total, [category, amount]) => (
    /抖音(?:团购|券)?/.test(String(category || '')) ? total + number(amount) : total
  ), 0);
}

function replaceGroupBuyPosRevenue(db, { batchId = null, storeId, storeName, bizDate, amount, channel, platform, orderCount = 0 }) {
  db.run("DELETE FROM business_revenue_records WHERE store_id=? AND biz_date=? AND source_type='pos' AND channel=?", [storeId, bizDate, channel]);
  if (!amount) return;
  replaceRevenue(db, {
    batch_id: batchId, store_id: storeId, store_name: storeName, biz_date: bizDate,
    source_type: 'pos', platform, channel_group: 'group_buy', channel,
    // 收银系统的综合营业统计只在“营业收入构成”提供这两项支付金额，
    // 没有拆分后的团购折前金额。因此该口径同时作为收银机视角的营业额与实收，
    // 不以第三方流水补填或改写。
    recorded_amount: amount, gross_amount: amount, actual_amount: amount, order_count: orderCount,
  });
}

function replaceMeituanGroupPosRevenue(db, params) {
  return replaceGroupBuyPosRevenue(db, { ...params, channel: 'meituan_group', platform: '美团团购' });
}

function replaceDouyinGroupPosRevenue(db, params) {
  return replaceGroupBuyPosRevenue(db, { ...params, channel: 'douyin_group', platform: '抖音团购' });
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
  const matchedDates = new Set();

  dataRows.forEach((row, rowIndex) => {
    const compactWithCity = cleanKey(report.rows?.[0]?.[0]) === cleanKey('城市');
    const store = resolveStore(db, { 门店: row[compactWithCity ? 1 : 0] });
    const bizDate = dateText(row[compactWithCity ? 2 : 1]);
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
    replaceMeituanGroupPosRevenue(db, {
      batchId, storeId: store.id, storeName: store.store_name, bizDate,
      amount: meituanGroupCompositionAmount(composition),
    });
    replaceDouyinGroupPosRevenue(db, {
      batchId, storeId: store.id, storeName: store.store_name, bizDate,
      amount: douyinGroupCompositionAmount(composition),
    });
  });
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [imported, dates.sort()[0] || null, dates.sort().at(-1) || null, batchId]);
  db.save();
  return { batch_id: batchId, imported, product_rows: 0, skipped: errors.length, errors: errors.slice(0, 20), detailed_report: true, matched_stores: matchedStoreIds.size, rows: dataRows.length };
}

/**
 * 收银系统“综合营业统计”原始报表。
 * 支持两种收银机导出布局：
 * - 标准综合营业统计：第 3 行为门店/日期，第 4 行为渠道，第 5 行为指标；
 * - 精简补录表：第 1 行为城市/门店/营业日，第 2 行为渠道，第 3 行为指标。
 * 按“淘宝闪购”渠道名与指标名动态定位营业额、营业收入/收银记录、订单量；
 * 不依赖 AQ/AR/AT 等固定列号，因此任意其他渠道整组缺失、列发生左移时仍可识别。
 */
function cashierCompositeReportSheet(workbook) {
  const channelDefinitions = [
    { code: 'store_sales', names: ['店内销售'] },
    { code: 'pickup', names: ['自提销售'] },
    { code: 'meituan_delivery', names: ['美团外卖'] },
    { code: 'taobao_flash', names: ['淘宝闪购'] },
    { code: 'jd_delivery', names: ['京东秒送', '京东外卖'] },
  ];
  return workbook.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: true }) }))
    .map(sheet => {
      const compact = String(sheet.rows?.[0]?.[0] || '').trim() === '城市'
        && ['门店', '门店名称'].includes(String(sheet.rows?.[0]?.[1] || '').trim())
        && ['营业日', '营业日期'].includes(String(sheet.rows?.[0]?.[2] || '').trim());
      const offset = compact ? 0 : 2;
      const [identityHeader = [], channelHeader = [], metricHeader = []] = sheet.rows.slice(offset, offset + 3);
      const topSections = fillMergedHeader(identityHeader);
      const channels = fillMergedHeader(channelHeader);
      const metrics = fillMergedHeader(metricHeader);
      const incomeCompositionColumns = channelHeader.map((header, index) => {
        const category = String(header || '').trim();
        return cleanKey(topSections[index]) === cleanKey('营业收入构成') && category && category !== '小计'
          ? { category, index }
          : null;
      }).filter(Boolean);
      // “美团/大众点评团购”与“美团/大众点评支付”位于营业收入构成，
      // 并非渠道营业构成的三列指标；两项之和就是美团团购的收银机取值。
      const meituanGroupPaymentColumns = incomeCompositionColumns
        .filter(item => /美团.*大众点评.*(?:团购|支付)/.test(item.category))
        .map(item => item.index);
      const columns = Object.fromEntries(channelDefinitions.map(definition => {
        const isChannel = value => definition.names.some(name => cleanKey(value) === cleanKey(name));
        const columnOf = label => metrics.findIndex((metric, index) => isChannel(channels[index]) && metric === label);
        return [definition.code, { gross: columnOf('营业额(元)'), recorded: columnOf('营业收入(元)'), orders: columnOf('订单量') }];
      }));
      const validIdentity = compact || (
        String(identityHeader[0] || '').trim() === '城市'
        && ['门店', '门店名称'].includes(String(identityHeader[1] || '').trim())
        && ['营业日', '营业日期'].includes(String(identityHeader[2] || '').trim())
      );
      const resolvedChannels = Object.entries(columns).filter(([, value]) => [value.gross, value.recorded, value.orders].every(index => index >= 0));
      return {
        ...sheet, columns, dataStart: offset + 3, storeColumn: 1, dateColumn: 2,
        sourceFormat: compact ? 'cashier_compact' : 'cashier_composite',
        valid: validIdentity && resolvedChannels.length > 0,
        resolvedChannels: resolvedChannels.map(([channel]) => channel),
        incomeCompositionColumns,
        meituanGroupPaymentColumns,
      };
    })
    .find(sheet => sheet.valid);
}

function importCashierCompositeReport(db, report, params, user) {
  const channels = (report.resolvedChannels || []).map(channel => ({ channel, ...report.columns[channel] }));
  if (!channels.length) throw new Error('已识别为“综合营业统计”原表，但未找到任何完整渠道组。请确认导出时包含营业额、营业收入和订单量。');
  const batchId = db.insert(`INSERT INTO business_import_batches
    (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'pos', '收银系统综合营业统计', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  const errors = [];
  const dates = [];
  const matchedStoreIds = new Set();
  let imported = 0;
  let sourceRows = 0;
  report.rows.slice(report.dataStart).forEach((row, index) => {
    const sourceStoreName = String(row[report.storeColumn] || '').trim();
    const bizDate = dateText(row[report.dateColumn]);
    if (!sourceStoreName || !bizDate) return;
    sourceRows += 1;
    const store = resolveStore(db, { 门店名称: sourceStoreName });
    if (!store) {
      if (errors.length < 20) errors.push(`第 ${index + report.dataStart + 1} 行：未匹配到门店“${sourceStoreName}”`);
      return;
    }
    channels.forEach(item => {
      const meta = CHANNELS[item.channel];
      const gross = number(row[item.gross]);
      const recorded = number(row[item.recorded]);
      replaceRevenue(db, {
        batch_id: batchId, store_id: store.id, store_name: store.store_name, biz_date: bizDate,
        source_type: 'pos', platform: meta.group === 'delivery' ? meta.label : '', channel_group: meta.group, channel: item.channel,
        gross_amount: gross, recorded_amount: recorded, actual_amount: meta.group === 'offline' ? recorded : 0,
        discount_amount: Math.max(0, gross - recorded), order_count: number(row[item.orders]),
      });
      imported += 1;
    });
    const composition = Object.fromEntries((report.incomeCompositionColumns || []).map(item => [item.category, number(row[item.index])]));
    if (report.incomeCompositionColumns?.length) replaceRevenueComposition(db, batchId, store, bizDate, composition);
    if (report.incomeCompositionColumns?.length) {
      replaceMeituanGroupPosRevenue(db, {
        batchId, storeId: store.id, storeName: store.store_name, bizDate,
        amount: meituanGroupCompositionAmount(composition),
      });
      replaceDouyinGroupPosRevenue(db, {
        batchId, storeId: store.id, storeName: store.store_name, bizDate,
        amount: douyinGroupCompositionAmount(composition),
      });
      imported += 2;
    }
    matchedStoreIds.add(store.id);
    dates.push(bizDate);
  });
  if (!sourceRows) throw new Error('未识别到收银系统综合营业统计明细行');
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [imported, dates.sort()[0] || null, dates.sort().at(-1) || null, batchId]);
  db.save();
  return {
    batch_id: batchId, data_kind: 'cashier_composite', imported, raw_imported: sourceRows,
    matched_stores: matchedStoreIds.size,
    skipped: sourceRows - Math.round(imported / Math.max(1, channels.length + (report.meituanGroupPaymentColumns?.length ? 1 : 0))),
    errors,
    resolved_channels: [
      ...channels.map(item => CHANNELS[item.channel].label),
      ...(report.meituanGroupPaymentColumns?.length ? ['美团团购（美团/大众点评团购 + 美团/大众点评支付）'] : []),
    ],
    income_composition_fields: (report.incomeCompositionColumns || []).map(item => item.category),
  };
}
function importWorkbook(db, params, user) {
  const workbook = readWorkbook(params.data);
  const posItemDetail = posItemSalesDetailSheet(workbook);
  if (posItemDetail) return importPosItemSalesDetailWorkbook(db, posItemDetail, params, user);
  // 完整经营日报与“淘宝闪购补录”都可能含淘宝字段；必须优先识别三行表头的完整日报，
  // 否则会只写入淘宝列，漏掉美团外卖、京东、自提和店内销售。
  const detailedReport = detailedReportSheet(workbook);
  if (detailedReport) return importDetailedBusinessReport(db, detailedReport, params, user);
  const cashierComposite = cashierCompositeReportSheet(workbook);
  if (cashierComposite) return importCashierCompositeReport(db, cashierComposite, params, user);
  // 日报文件偶尔附带 meta/说明页；优先锁定同时拥有营业额、收入、有效订单的真实数据页，避免把说明行当作异常记录。
  const dailySheet = workbook.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: '', raw: true }) }))
    .find(sheet => {
      const head = sheet.rows[0];
      return head && getValue(head, ['营业额']) !== undefined && getValue(head, ['收入']) !== undefined
        && getValue(head, ['有效订单']) !== undefined && getValue(head, ['门店编号', '门店ID', '门店id']) !== undefined;
    });
  const rows = dailySheet ? dailySheet.rows : workbook.SheetNames.flatMap(sheetName => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true }));
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

// 收银机“品项销售明细”使用第三行表头，最后一行为“合计”。它是订单级明细，
// 与经营日报、平台真实账单完全独立，导入时不能触碰第三方平台原始数据。
function posItemSalesDetailSheet(workbook) {
  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
    const headerIndex = grid.findIndex(row => row.includes('机构编码') && row.includes('营业日期') && row.includes('品项名称') && row.includes('订单号') && row.includes('品项收入(元)'));
    if (headerIndex >= 0) return { sheet_name: sheetName, header: grid[headerIndex], rows: grid.slice(headerIndex + 1) };
  }
  return null;
}

function posDetailChannel(orderClass, subSource) {
  const order = String(orderClass || '').trim();
  const sub = String(subSource || '').trim();
  if (order === '美团外卖') return 'meituan_delivery';
  if (order === '淘宝闪购') return 'taobao_flash';
  if (order === '京东秒送' || order === '京东外卖') return 'jd_delivery';
  if (/美团|大众点评/.test(sub) && /(团购|支付)/.test(sub)) return 'meituan_group';
  if (/抖音.*团购/.test(sub)) return 'douyin_group';
  if (/自提/.test(order)) return 'pickup';
  return 'store_sales';
}

function resolvePosDetailStore(db, posStoreCode, storeName) {
  const code = String(posStoreCode || '').trim();
  if (code) {
    const matchedByCode = db.queryOne('SELECT id,store_name FROM stores WHERE pos_store_code=?', [code]);
    if (matchedByCode) return matchedByCode;
  }
  const store = resolveStore(db, { 门店名称: storeName });
  if (!store) return null;
  // 首次从报表识别时以已匹配的名称补齐稳定机构编码；后续即便门店改名也优先按编码匹配。
  if (code) {
    const occupied = db.queryOne('SELECT id FROM stores WHERE pos_store_code=? AND id<>?', [code, store.id]);
    if (occupied) throw new Error(`收银机构编码 ${code} 已绑定到其他门店`);
    db.run("UPDATE stores SET pos_store_code=? WHERE id=? AND (pos_store_code IS NULL OR pos_store_code='')", [code, store.id]);
  }
  return store;
}

/**
 * 源报表的时间列（如「2026/09/10 21:24:53」）统一成 'YYYY-MM-DD HH:MM:SS'。
 * dish_sales.order_time 的时段走势图取 substr(order_time,12,2) 作为小时、区间过滤也用字符串比较，
 * 因此这里必须统一成定长格式，不能原样存 '2026/09/10 21:24:53'。
 */
function normalizeReportTime(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return '';
  const pad = (v) => String(v).padStart(2, '0');
  return `${match[1]}-${pad(match[2])}-${pad(match[3])} ${pad(match[4] || 0)}:${pad(match[5] || 0)}:${pad(match[6] || 0)}`;
}

function importPosItemSalesDetailWorkbook(db, report, params, user) {
  if (params.source_type === 'platform') throw new Error('“品项销售明细”属于收银机数据，请选择收银机导入');
  const index = Object.fromEntries(report.header.map((name, i) => [String(name || '').trim(), i]));
  const value = (row, name) => row[index[name]];
  // 同一份「品项销售明细」服务两张表：pos_product_sale_details（总数据·本地 SKU 看板）
  // 与 dish_sales（菜品销售分析、时段订单走势图）。后者必须带下单时刻，源报表有就存下来。
  const orderTimeOf = (row, bizDate) =>
    normalizeReportTime(value(row, '下单时间')) ||
    normalizeReportTime(value(row, '点菜时间')) ||
    normalizeReportTime(value(row, '接单/结账/退菜时间')) ||
    `${bizDate} 00:00:00`;
  const batchId = db.insert(`INSERT INTO business_import_batches
    (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'pos', '收银机品项销售明细', params.file_name || '', 0, user?.id || null, user?.display_name || user?.username || '',
  ]);
  const errors = [], dates = new Set(), stores = new Set();
  const clearedStoreDates = new Set();
  const clearedDishOrders = new Set();
  let imported = 0, skipped = 0, dishMirrored = 0;
  db.run('BEGIN');
  try {
    report.rows.forEach((row, rowIndex) => {
      // 汇总/空白行不能作为菜品行，否则会使销量与金额重复一次。
      if (String(value(row, '城市') || '').trim() === '合计') return;
      const bizDate = dateText(value(row, '营业日期'));
      const orderId = String(value(row, '订单号') || '').trim();
      const productName = String(value(row, '品项名称') || '').trim();
      if (!bizDate || !orderId || !productName || productName === '--') {
        skipped += 1;
        if (errors.length < 20) errors.push(`第 ${rowIndex + 2} 行：缺少${!bizDate ? '营业日期' : !orderId ? '订单号' : '品项名称'}，已跳过`);
        return;
      }
      const posStoreCode = String(value(row, '机构编码') || '').trim();
      const store = resolvePosDetailStore(db, posStoreCode, String(value(row, '门店名称') || '').trim());
      if (!store) {
        skipped += 1;
        if (errors.length < 20) errors.push(`第 ${rowIndex + 2} 行：机构编码 ${posStoreCode || '未提供'} / 门店 ${value(row, '门店名称') || '未提供'} 无法匹配`);
        return;
      }
      const orderClass = String(value(row, '订单分类') || '').trim();
      const orderSource = String(value(row, '订单来源') || '').trim();
      const newOrderSource = String(value(row, '新订单来源') || '').trim();
      const orderSubSource = String(value(row, '订单子来源') || '').trim();
      const channel = posDetailChannel(orderClass, orderSubSource);
      // 同一文件可以出现同订单、同菜品的多行套餐明细；先按门店/日期清空旧快照，
      // 再在唯一键冲突时累加，既保留真实数量，又保证重传同一报表不会翻倍。
      const storeDateKey = `${store.id}|${bizDate}`;
      if (!clearedStoreDates.has(storeDateKey)) {
        db.run('DELETE FROM pos_product_sale_details WHERE store_id=? AND biz_date=?', [store.id, bizDate]);
        clearedStoreDates.add(storeDateKey);
      }
      const orderTime = orderTimeOf(row, bizDate);
      // dish_sales 没有业务日期列，重传时按「门店 + 订单号」清旧行：
      // 跨零点的订单其 order_time 日期可能不等于营业日期，按日期删会漏删导致翻倍。
      const dishOrderKey = `${store.store_name}|${orderId}`;
      if (!clearedDishOrders.has(dishOrderKey)) {
        db.run('DELETE FROM dish_sales WHERE store_name=? AND order_no=?', [store.store_name, orderId]);
        clearedDishOrders.add(dishOrderKey);
      }
      db.run(`INSERT INTO pos_product_sale_details
        (batch_id,store_id,store_name,pos_store_code,biz_date,order_id,product_code,product_name,related_product_name,product_type,dish_type,spec,method,addons,channel,order_class,order_source,new_order_source,order_sub_source,quantity,sales_amount,discount_amount,gift_quantity,gift_amount,income_amount,sales_mode,order_time)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(store_id,biz_date,order_id,product_code,product_name,sales_mode) DO UPDATE SET
          batch_id=excluded.batch_id,store_name=excluded.store_name,pos_store_code=excluded.pos_store_code,related_product_name=excluded.related_product_name,product_type=excluded.product_type,dish_type=excluded.dish_type,spec=excluded.spec,method=excluded.method,addons=excluded.addons,channel=excluded.channel,order_class=excluded.order_class,order_source=excluded.order_source,new_order_source=excluded.new_order_source,order_sub_source=excluded.order_sub_source,order_time=excluded.order_time,quantity=pos_product_sale_details.quantity+excluded.quantity,sales_amount=pos_product_sale_details.sales_amount+excluded.sales_amount,discount_amount=pos_product_sale_details.discount_amount+excluded.discount_amount,gift_quantity=pos_product_sale_details.gift_quantity+excluded.gift_quantity,gift_amount=pos_product_sale_details.gift_amount+excluded.gift_amount,income_amount=pos_product_sale_details.income_amount+excluded.income_amount`, [
        batchId, store.id, store.store_name, posStoreCode, bizDate, orderId,
        String(value(row, '菜品编码') || '').trim(), productName, String(value(row, '关联菜品名称') || '').trim(),
        String(value(row, '品项类型') || '').trim(), String(value(row, '菜品类型') || '').trim(), String(value(row, '规格') || '').trim(),
        String(value(row, '关联做法') || '').trim(), [value(row, '关联加料'), value(row, '关联餐盒')].filter(Boolean).join(' / '),
        channel, orderClass, orderSource, newOrderSource, orderSubSource,
        number(value(row, '销售数量')), number(value(row, '销售金额(元)')), number(value(row, '优惠金额(元)')),
        number(value(row, '赠送数量')), number(value(row, '赠送金额(元)')),
        number(value(row, '品项收入(元)')), String(value(row, '销售方式') || '').trim(),
        orderTime,
      ]);
      // 同一份源报表再写一份 dish_sales：菜品销售分析、时段订单走势图、堂食菜品绑定都在用这张表。
      // 口径与历史 dish_sales 一致（多渠道，payment_detail 存来源组合），退菜用 refunded/refund_amount 表达。
      const salesMode = String(value(row, '销售方式') || '').trim();
      const isRefundRow = salesMode === '退菜';
      const incomeAmount = number(value(row, '品项收入(元)'));
      db.run(`INSERT INTO dish_sales
        (store_name,product_code,product_name,spec,quantity,unit,amount_total,discount_amount,income_amount,order_time,refunded,order_no,payment_detail,refund_amount)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        store.store_name,
        String(value(row, '菜品编码') || '').trim(),
        productName,
        String(value(row, '规格') || '').trim() || '--',
        number(value(row, '销售数量')),
        String(value(row, '单位') || '').trim() || '份',
        number(value(row, '销售金额(元)')),
        number(value(row, '优惠金额(元)')),
        incomeAmount,
        orderTime,
        isRefundRow ? '部分退' : '否',
        orderId,
        [orderClass, orderSource, newOrderSource, orderSubSource].filter(Boolean).join('|'),
        isRefundRow ? Math.abs(incomeAmount) : 0,
      ]);
      dishMirrored += 1;
      imported += 1; dates.add(bizDate); stores.add(store.id);
    });
    db.run('COMMIT');
  } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
  const period = [...dates].sort();
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [imported, period[0] || null, period.at(-1) || null, batchId]);
  db.save();
  return { batch_id: batchId, data_kind: 'pos_item_sales_detail', imported, dish_mirrored: dishMirrored, source_rows: report.rows.length, matched_stores: stores.size, skipped, errors: errors.slice(0, 20), date_from: period[0] || null, date_to: period.at(-1) || null };
}

// 美团结算账单“交易类型”在经营看板中的费用归属。
// “外卖订单”是已扣除订单级费用的商家应收款；其它类型按名称归入推广/保险/退款/服务费。
function meituanBillCategory(billType) {
  const type = String(billType || '').trim();
  if (type === '外卖订单') return 'revenue';
  if (/推广|广告|流量|津贴|联盟|拼单宝|订单通|充值/.test(type)) return 'promotion_fee';
  if (/保险/.test(type)) return 'insurance_fee';
  if (/退款|赔付扣款/.test(type)) return 'refund_amount';
  return 'service_fee';
}

/**
 * 用美团结算账单重建平台营收记录（与淘宝闪购同法）：
 * 营业额/优惠后收入/订单量来自美团营业额日报（meituan_delivery_daily_records），
 * 真实到账 = 当日全部交易类型“商家应收款”之和；费用按交易类型归入 推广/保险/退款/服务。
 * 只重建 source_type='platform'，绝不删除收银机(pos)记录。
 */
function rebuildMeituanDeliveryRevenue(db, { from, to, batchId }) {
  if (!from || !to) return { revenueRecords: 0, netTotal: 0, grossTotal: 0, incomeTotal: 0, feeTotal: 0, feeBreakdown: {} };
  const oldRows = db.queryAll(`SELECT store_id, biz_date, source_type, order_count FROM business_revenue_records
    WHERE source_type IN ('pos','platform') AND channel='meituan_delivery' AND biz_date>=? AND biz_date<=?`, [from, to]);
  const orderMap = new Map();
  oldRows.forEach(row => {
    const key = `${row.store_id}|${row.biz_date}`;
    if (row.source_type === 'pos' || !orderMap.has(key)) orderMap.set(key, Number(row.order_count) || 0);
  });
  const dailyRows = db.queryAll(`
    SELECT store_id, store_name, biz_date, gross_amount, actual_amount, order_count
    FROM meituan_delivery_daily_records
    WHERE match_status='matched' AND biz_date>=? AND biz_date<=?
    ORDER BY store_id, biz_date, id`, [from, to]);
  const dailyMap = new Map(dailyRows.map(row => [`${row.store_id}|${row.biz_date}`, row]));
  const billRows = db.queryAll(`
    SELECT store_id, store_name, bill_date, bill_type, amount
    FROM meituan_delivery_bills
    WHERE match_status='matched' AND bill_date>=? AND bill_date<=?
    ORDER BY store_id, bill_date, id`, [from, to]);
  const aggregates = new Map();
  // 先建立日报基准：营业额、优惠后收入(收入口径)、订单量只来自日报。
  dailyRows.forEach(row => {
    const key = `${row.store_id}|${row.biz_date}`;
    aggregates.set(key, {
      store_id: row.store_id, store_name: row.store_name, bill_date: row.biz_date,
      gross_amount: number(row.gross_amount), platform_income_amount: number(row.actual_amount),
      actual_amount: number(row.actual_amount), discount_amount: Math.max(0, number(row.gross_amount) - number(row.actual_amount)),
      service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0, has_bill: false,
    });
  });
  billRows.forEach(row => {
    const key = `${row.store_id}|${row.bill_date}`;
    const item = aggregates.get(key) || {
      store_id: row.store_id, store_name: row.store_name, bill_date: row.bill_date,
      gross_amount: 0, platform_income_amount: 0, actual_amount: 0, discount_amount: 0,
      service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0, has_bill: false,
    };
    const amount = number(row.amount);
    if (!item.has_bill) { item.actual_amount = 0; item.has_bill = true; }
    item.actual_amount += amount;
    const category = meituanBillCategory(row.bill_type);
    if (category === 'revenue') {
      // 日报尚未导入时，以账单“外卖订单”收入作为临时回退值（订单级费用已扣除）。
      if (!dailyMap.has(key)) item.platform_income_amount += amount;
    }
    else item[category] -= amount;
    aggregates.set(key, item);
  });
  // 仅移除旧的平台记录，保留收银机“记录金额”与订单数。
  db.run(`DELETE FROM business_revenue_records
    WHERE source_type='platform' AND channel='meituan_delivery' AND biz_date>=? AND biz_date<=?`, [from, to]);
  const feeBreakdown = { service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0 };
  let revenueRecords = 0;
  let netTotal = 0;
  let grossTotal = 0;
  let incomeTotal = 0;
  aggregates.forEach(agg => {
    if (!agg.gross_amount) agg.gross_amount = agg.platform_income_amount;
    if (!agg.discount_amount) agg.discount_amount = Math.max(0, agg.gross_amount - agg.platform_income_amount);
    replaceRevenue(db, {
      batch_id: batchId, store_id: agg.store_id, store_name: agg.store_name, biz_date: agg.bill_date,
      source_type: 'platform', platform: '美团外卖', channel_group: 'delivery', channel: 'meituan_delivery',
      gross_amount: agg.gross_amount, platform_income_amount: agg.platform_income_amount,
      actual_amount: agg.actual_amount, discount_amount: agg.discount_amount,
      service_fee: agg.service_fee, insurance_fee: agg.insurance_fee,
      promotion_fee: agg.promotion_fee, refund_amount: agg.refund_amount,
      order_count: dailyMap.get(`${agg.store_id}|${agg.bill_date}`)?.order_count || orderMap.get(`${agg.store_id}|${agg.bill_date}`) || 0,
    });
    revenueRecords += 1;
    netTotal += agg.actual_amount;
    grossTotal += agg.gross_amount;
    incomeTotal += agg.platform_income_amount;
    feeBreakdown.service_fee += agg.service_fee;
    feeBreakdown.insurance_fee += agg.insurance_fee;
    feeBreakdown.promotion_fee += agg.promotion_fee;
    feeBreakdown.refund_amount += agg.refund_amount;
  });
  const feeTotal = Object.values(feeBreakdown).reduce((sum, value) => sum + value, 0);
  return { revenueRecords, netTotal, grossTotal, incomeTotal, feeTotal, feeBreakdown };
}

/**
 * 美团“订单明细”结算表：按 D交易类型 + R商家应收款 归集（表头可能不在第 1 行）。
 * 日期取“账单日期”列；与官方“账单明细”按店日汇总核对一致（ΣR = 账单金额）。
 */
function meituanBillDetailRows(workbook) {
  const aliasHit = (header, aliases) => aliases.some(alias => cleanKey(header) === cleanKey(alias));
  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
    for (let h = 0; h < Math.min(5, grid.length); h++) {
      const header = grid[h] || [];
      const col = index => {
        for (let i = 0; i < header.length; i++) {
          if (aliasHit(header[i], index)) return i;
        }
        return -1;
      };
      const storeIdCol = col(['门店id', '门店ID', '美团门店id', '美团门店ID']);
      const dateCol = col(['账单日期', '日期']);
      const typeCol = col(['交易类型', '账单类型']);
      const amountCol = col(['商家应收款', '结算金额', '金额']);
      if (storeIdCol < 0 || dateCol < 0 || typeCol < 0 || amountCol < 0) continue;
      const storeNameCol = header.findIndex(cell => aliasHit(cell, ['门店名称', '门店名']));
      const descCol = header.findIndex(cell => aliasHit(cell, ['交易描述', '描述']));
      const rows = [];
      for (let i = h + 1; i < grid.length; i++) {
        const r = grid[i];
        const date = dateText(r[dateCol]);
        const type = String(r[typeCol] || '').trim();
        const storeId = String(r[storeIdCol] || '').trim();
        const amount = number(r[amountCol]);
        if (!storeId || !date || !type) continue;
        rows.push({
          门店id: storeId,
          门店名称: storeNameCol >= 0 ? String(r[storeNameCol] || '').trim() : '',
          账单日期: date,
          交易类型: type,
          交易描述: descCol >= 0 ? String(r[descCol] || '').trim() : '',
          商家应收款: amount,
        });
      }
      if (rows.length) return { sheet_name: sheetName, rows };
    }
  }
  return null;
}

function importMeituanDeliveryBillWorkbook(db, detailRows, params, user) {
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '美团外卖', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  // 按(门店ID, 账单日, 交易类型)归集 ΣR
  const grouped = new Map();
  detailRows.forEach(row => {
    const key = `${row.门店id}|${row.账单日期}|${row.交易类型}`;
    const item = grouped.get(key) || { 门店id: row.门店id, 门店名称: row.门店名称, 账单日期: row.账单日期, 交易类型: row.交易类型, 交易描述: row.交易描述, amount: 0, count: 0 };
    item.amount += number(row.商家应收款);
    item.count += 1;
    grouped.set(key, item);
  });
  const errors = [];
  const dates = new Set();
  const matchedDates = new Set();
  const matchedStoreIds = new Set();
  let rawImported = 0;
  let unmatched = 0;
  db.run('BEGIN');
  try {
    grouped.forEach(group => {
      const meituanStoreId = group.门店id;
      const billDate = group.账单日期;
      const billType = group.交易类型;
      const amount = group.amount;
      const store = db.queryOne(`
        SELECT s.id, s.store_name
        FROM store_platforms p
        JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name='美团外卖' AND p.platform_id=?
        LIMIT 1
      `, [meituanStoreId]);
      const matched = !!store;
      db.run(`INSERT INTO meituan_delivery_bills
        (batch_id,meituan_store_id,source_store_name,bill_date,bill_type,amount,transaction_count,description_sample,raw_json,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(meituan_store_id,bill_date,bill_type) DO UPDATE SET
          batch_id=excluded.batch_id,source_store_name=excluded.source_store_name,amount=excluded.amount,
          transaction_count=excluded.transaction_count,description_sample=excluded.description_sample,
          raw_json=excluded.raw_json,store_id=excluded.store_id,store_name=excluded.store_name,
          match_status=excluded.match_status,updated_at=datetime('now','localtime')`, [
        batchId, meituanStoreId, group.门店名称, billDate, billType, amount, group.count,
        String(group.交易描述 || '').slice(0, 80), JSON.stringify({ count: group.count, desc: String(group.交易描述 || '').slice(0, 120) }),
        store?.id || null, store?.store_name || '', matched ? 'matched' : 'unmatched',
      ]);
      rawImported += 1;
      dates.add(billDate);
      if (!matched) {
        unmatched += 1;
        if (errors.length < 20) errors.push(`美团门店 ID ${meituanStoreId}（${group.门店名称}）未在“第三方平台 → 美团外卖”中登记，原始账单已保留但未计入真实实收`);
        return;
      }
      matchedStoreIds.add(store.id);
      matchedDates.add(billDate);
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  const dateArr = [...dates].sort();
  const from = dateArr[0] || null;
  const to = dateArr.at(-1) || null;
  const mergeRanges = [...matchedDates].sort().reduce((ranges, date) => {
    const current = ranges.at(-1);
    if (!current) return [{ from: date, to: date }];
    const cursor = new Date(`${current.to}T12:00:00`);
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.toISOString().slice(0, 10) === date) current.to = date;
    else ranges.push({ from: date, to: date });
    return ranges;
  }, []);
  let rebuild = { revenueRecords: 0, netTotal: 0, grossTotal: 0, incomeTotal: 0, feeTotal: 0, feeBreakdown: {} };
  if (mergeRanges.length) {
    db.run('BEGIN');
    try {
      mergeRanges.forEach(range => {
        const result = rebuildMeituanDeliveryRevenue(db, { ...range, batchId });
        rebuild.revenueRecords += result.revenueRecords;
        rebuild.netTotal += result.netTotal;
        rebuild.grossTotal += result.grossTotal;
        rebuild.incomeTotal += result.incomeTotal;
        rebuild.feeTotal += result.feeTotal;
        Object.entries(result.feeBreakdown || {}).forEach(([key, value]) => {
          rebuild.feeBreakdown[key] = Number(rebuild.feeBreakdown[key] || 0) + Number(value || 0);
        });
      });
      db.run('COMMIT');
    } catch (error) {
      try { db.run('ROLLBACK'); } catch {}
      throw error;
    }
  }
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawImported, from, to, batchId]);
  db.save();
  return {
    batch_id: batchId, data_kind: 'settlement_bills', imported: rawImported, raw_imported: rawImported,
    unmatched, matched_stores: matchedStoreIds.size,
    revenue_records: rebuild.revenueRecords,
    net_total: Math.round(rebuild.netTotal * 100) / 100,
    gross_total: Math.round(rebuild.grossTotal * 100) / 100,
    delivery_amount_total: Math.round(rebuild.incomeTotal * 100) / 100,
    fee_total: Math.round(rebuild.feeTotal * 100) / 100,
    fee_breakdown: Object.fromEntries(Object.entries(rebuild.feeBreakdown).map(([key, value]) => [key, Math.round(value * 100) / 100])),
    skipped: 0, errors: errors.slice(0, 20),
  };
}

// 美团团购“收益明细”仅识别该工作表，不遍历或导入同一文件中的其他明细/汇总页。
// 用字段锚点定位而非固定工作表名称，兼容美团导出时带日期后缀的表名。
function meituanGroupBenefitDetailSheet(workbook) {
  const required = ['收益时间', '美团门店ID', '项目名称', '售价（美团售价）', '商家应得', '美团承担促销费', '顾客实际支付', '售卖方式'];
  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
    const headers = (grid[0] || []).map(value => String(value || '').trim());
    const hasHeader = label => headers.some(value => cleanKey(value) === cleanKey(label));
    if (!required.every(hasHeader)) continue;
    const col = label => headers.findIndex(value => cleanKey(value) === cleanKey(label));
    const priceCol = col('售价（美团售价）');
    const merchantCol = col('商家应得');
    if (priceCol < 0 || merchantCol <= priceCol + 1) continue;
    return {
      sheetName,
      grid,
      columns: {
        incomeTime: col('收益时间'), storeName: col('美团门店名称'), storeId: col('美团门店ID'),
        orderNo: col('订单号'), voucherNo: col('券号'), projectId: col('项目ID'), projectName: col('项目名称'),
        transactionType: col('流水类型'), saleMode: col('售卖方式'), price: priceCol, merchant: merchantCol,
        customerPromotion: col('美团承担促销费'), customerPaid: col('顾客实际支付'),
        // U 至 AO：即售价列与商家应得列之间的全部费用字段。
        feeColumns: headers.slice(priceCol + 1, merchantCol).map((name, offset) => ({ name, index: priceCol + 1 + offset })),
      },
    };
  }
  return null;
}

function groupBuyFeeCategory(name) {
  const label = String(name || '');
  if (/保险/.test(label)) return 'insurance_fee';
  if (/退款/.test(label)) return 'refund_amount';
  if (/促销|推广|营销|消费券|锁客|返转|赏金|达人|渠道/.test(label)) return 'promotion_fee';
  return 'service_fee';
}

// 美团团购收益明细的费用归属，以结算报表字段为准。这里刻意不依赖关键字猜测，
// 避免把“商家承担促销费”和“推广费”混为同一项。合作商商业支持费用在报表中
// 会出现两列，按导出列的出现顺序分别归入服务费、其他费用。
const MEITUAN_GROUP_FEE_GROUPS = [
  { key: 'promotion', label: '促销费', fields: ['商家承担促销费-随单抵扣', '商家承担促销费-营销账户余额抵扣', '政府消费券扣补款'] },
  { key: 'service', label: '服务费', fields: ['商家承担促销费-配送费减免', '服务费（平台实际扣除）', '技术服务费优惠', '服务费-配送费', '商家自配配送费', '合作商商业支持费用'] },
  { key: 'merchant_refund', label: '商家承担退款', fields: ['商家承担退款'] },
  { key: 'other', label: '其他费用', fields: ['代运营服务费', '安心吃保险费用'] },
  { key: 'marketing', label: '推广费', fields: ['公益捐款', '核销订单推广费', '达人分销服务费', '交易额转推广充值', '远程锁客节省转推广', '随单返转推广费', '渠道推广服务费', '赏金联盟推广费'] },
];

function meituanGroupFeeGroupForEntry(name, occurrence = 1) {
  const label = String(name || '').trim();
  // 第二个同名“合作商商业支持费用”属于其他费用，和用户提供的分组表保持一致。
  if (label === '合作商商业支持费用') return occurrence > 1 ? 'other' : 'service';
  return MEITUAN_GROUP_FEE_GROUPS.find(group => group.fields.includes(label))?.key || 'other';
}

function meituanGroupFeeCategories(db, params = {}) {
  const selectedPlatform = String(params.platform || '').trim();
  if (selectedPlatform && selectedPlatform !== '美团团购') return [];
  const clauses = ["match_status='matched'"];
  const values = [];
  const requestedStoreIds = Array.isArray(params.store_ids) ? params.store_ids : String(params.store_ids || '').split(',');
  const storeIds = requestedStoreIds.map(Number).filter(id => Number.isInteger(id) && id > 0);
  if (storeIds.length) { clauses.push(`store_id IN (${storeIds.map(() => '?').join(',')})`); values.push(...storeIds); }
  else if (params.store_id) { clauses.push('store_id=?'); values.push(Number(params.store_id)); }
  if (params.date_from) { clauses.push('income_date>=?'); values.push(params.date_from); }
  if (params.date_to) { clauses.push('income_date<=?'); values.push(params.date_to); }
  const groups = new Map(MEITUAN_GROUP_FEE_GROUPS.map(group => [group.key, { key: group.key, label: group.label, amount: 0, details: new Map() }]));
  const rows = db.queryAll(`SELECT fee_breakdown_json FROM meituan_group_buy_benefit_records WHERE ${clauses.join(' AND ')}`, values);
  rows.forEach(row => {
    let payload = {};
    try { payload = JSON.parse(row.fee_breakdown_json || '{}'); } catch {}
    const rawEntries = Array.isArray(payload.raw_entries)
      ? payload.raw_entries
      : Object.entries(payload.raw || {}).map(([name, amount]) => ({ name, amount }));
    const occurrences = new Map();
    rawEntries.forEach(entry => {
      const name = String(entry.name || '').trim();
      if (!name) return;
      const occurrence = Number(entry.occurrence) || (Number(occurrences.get(name)) || 0) + 1;
      occurrences.set(name, occurrence);
      const group = groups.get(meituanGroupFeeGroupForEntry(name, occurrence));
      const amount = number(entry.amount);
      group.amount += amount;
      group.details.set(name, number(group.details.get(name)) + amount);
    });
  });
  return [...groups.values()].map(group => ({
    key: group.key,
    label: group.label,
    amount: Math.round(group.amount * 100) / 100,
    details: [...group.details.entries()].map(([label, amount]) => ({ label, amount: Math.round(amount * 100) / 100 })).filter(item => Math.abs(item.amount) > 0.000001),
  })).filter(group => Math.abs(group.amount) > 0.000001 || group.details.length);
}

function replaceMeituanGroupBuyRevenue(db, { batchId, storeId, incomeDate }) {
  const rows = db.queryAll(`SELECT * FROM meituan_group_buy_benefit_records
    WHERE store_id=? AND income_date=? AND match_status='matched'`, [storeId, incomeDate]);
  if (!rows.length) return null;
  const totals = { gross: 0, merchant: 0, customerPromotion: 0, customerPaid: 0, service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0 };
  const saleVoucherNet = new Map();
  rows.forEach(row => {
    totals.gross += number(row.sale_price);
    totals.merchant += number(row.merchant_income);
    totals.customerPromotion += number(row.customer_promotion);
    totals.customerPaid += number(row.customer_paid);
    let fees = {};
    try { fees = JSON.parse(row.fee_breakdown_json || '{}'); } catch {}
    ['service_fee', 'insurance_fee', 'promotion_fee', 'refund_amount'].forEach(key => { totals[key] += number(fees[key]); });
    // 订单量按券号净额计算：消费加入、撤销冲回，保险投保/退保不计订单。
    if (['消费', '撤销'].includes(String(row.transaction_type || ''))) {
      const key = String(row.voucher_no || row.order_no || `${row.id}`);
      saleVoucherNet.set(key, number(saleVoucherNet.get(key)) + number(row.sale_price));
    }
  });
  const orderCount = [...saleVoucherNet.values()].filter(value => Math.abs(value) > 0.000001).length;
  replaceRevenue(db, {
    batch_id: batchId, store_id: storeId, store_name: rows[0].store_name, biz_date: incomeDate,
    source_type: 'platform', platform: '美团团购', channel_group: 'group_buy', channel: 'meituan_group',
    gross_amount: totals.gross,
    // “优惠后收入”字段保留顾客实际支付；商家应得才是平台最终结算实收。
    platform_income_amount: totals.customerPaid,
    actual_amount: totals.merchant,
    service_fee: totals.service_fee, insurance_fee: totals.insurance_fee,
    promotion_fee: totals.promotion_fee, refund_amount: totals.refund_amount,
    // AQ 是美团承担的顾客补贴，不是商家费用；单独记为优惠。
    discount_amount: totals.customerPromotion,
    order_count: orderCount,
  });
  return { ...totals, orderCount };
}

function importMeituanGroupBuyWorkbook(db, params, user) {
  const workbook = readWorkbook(params.data);
  const report = meituanGroupBenefitDetailSheet(workbook);
  if (!report) throw new Error('未找到“收益明细”工作表。该表必须包含收益时间、美团门店ID、项目名称、售价、商家应得、美团承担促销费、顾客实际支付和售卖方式。');
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '美团团购', params.file_name || '', 0, user?.id || null, user?.display_name || user?.username || '',
  ]);
  const { grid, columns: c } = report;
  const rawRows = [];
  const errors = [];
  const storeDates = new Map();
  const matchedStoreIds = new Set();
  const dates = new Set();
  let unmatched = 0;
  let skipped = 0;
  for (let rowIndex = 1; rowIndex < grid.length; rowIndex++) {
    const row = grid[rowIndex];
    const incomeDate = dateText(row[c.incomeTime]);
    const meituanStoreId = String(row[c.storeId] || '').trim();
    const transactionType = String(row[c.transactionType] || '').trim();
    if (!incomeDate || !meituanStoreId || !transactionType) {
      skipped++;
      if (errors.length < 20) errors.push(`第 ${rowIndex + 1} 行：${!incomeDate ? '收益时间不正确' : !meituanStoreId ? '缺少美团门店 ID' : '缺少流水类型'}`);
      continue;
    }
    const feeBreakdown = { service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0 };
    const rawFeeBreakdown = {};
    const rawFeeEntries = [];
    const fieldOccurrences = new Map();
    c.feeColumns.forEach(column => {
      const value = number(row[column.index]);
      const occurrence = (Number(fieldOccurrences.get(column.name)) || 0) + 1;
      fieldOccurrences.set(column.name, occurrence);
      // 旧版 raw 对象保留以兼容已有看板；entries 用于保留同名列，供新分组精确追溯。
      rawFeeBreakdown[column.name] = number(rawFeeBreakdown[column.name]) + value;
      rawFeeEntries.push({ name: column.name, occurrence, amount: value });
      feeBreakdown[groupBuyFeeCategory(column.name)] += value;
    });
    const store = db.queryOne(`SELECT s.id,s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id
      WHERE p.platform_name='美团团购' AND p.platform_id=? LIMIT 1`, [meituanStoreId]);
    const rowKey = [meituanStoreId, incomeDate, row[c.incomeTime], row[c.orderNo], row[c.voucherNo], transactionType, row[c.projectId], row[c.price], row[c.merchant]].map(value => String(value ?? '').trim()).join('|');
    const record = {
      rowIndex, rowKey, meituanStoreId, sourceStoreName: String(row[c.storeName] || '').trim(), incomeDate,
      incomeTime: String(row[c.incomeTime] || '').trim(), orderNo: String(row[c.orderNo] || '').trim(), voucherNo: String(row[c.voucherNo] || '').trim(),
      projectId: String(row[c.projectId] || '').trim(), projectName: String(row[c.projectName] || '').trim(), transactionType,
      saleMode: String(row[c.saleMode] || '').trim(), salePrice: number(row[c.price]), merchantIncome: number(row[c.merchant]),
      customerPromotion: number(row[c.customerPromotion]), customerPaid: number(row[c.customerPaid]),
      thirdPartyFee: c.feeColumns.reduce((sum, column) => sum + number(row[column.index]), 0),
      feeBreakdown: { ...feeBreakdown, raw: rawFeeBreakdown, raw_entries: rawFeeEntries }, store,
      raw: Object.fromEntries((grid[0] || []).map((header, index) => [String(header || XLSX.utils.encode_col(index)), row[index]])),
    };
    rawRows.push(record);
    storeDates.set(`${meituanStoreId}|${incomeDate}`, { meituanStoreId, incomeDate });
    dates.add(incomeDate);
  }
  if (!rawRows.length) throw new Error('收益明细表中没有可导入的有效流水');
  const rebuildTargets = new Map();
  db.run('BEGIN');
  try {
    // 同一美团门店、同一收益日再次导入视为该日完整覆盖，避免旧流水残留或重复累计。
    storeDates.forEach(({ meituanStoreId, incomeDate }) => db.run('DELETE FROM meituan_group_buy_benefit_records WHERE meituan_store_id=? AND income_date=?', [meituanStoreId, incomeDate]));
    rawRows.forEach(record => {
      const matched = !!record.store;
      db.run(`INSERT INTO meituan_group_buy_benefit_records
        (batch_id,source_row_key,meituan_store_id,source_store_name,income_date,income_time,order_no,voucher_no,project_id,project_name,transaction_type,sale_mode,sale_price,merchant_income,customer_promotion,customer_paid,third_party_fee,fee_breakdown_json,raw_json,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`, [
        batchId, record.rowKey, record.meituanStoreId, record.sourceStoreName, record.incomeDate, record.incomeTime,
        record.orderNo, record.voucherNo, record.projectId, record.projectName, record.transactionType, record.saleMode,
        record.salePrice, record.merchantIncome, record.customerPromotion, record.customerPaid, record.thirdPartyFee,
        JSON.stringify(record.feeBreakdown), JSON.stringify(record.raw), record.store?.id || null, record.store?.store_name || '', matched ? 'matched' : 'unmatched',
      ]);
      if (!matched) {
        unmatched++;
        if (errors.length < 20) errors.push(`第 ${record.rowIndex + 1} 行：美团团购门店 ID ${record.meituanStoreId} 未在“第三方平台 → 美团团购”中登记，原始流水已保留但未计入看板`);
        return;
      }
      matchedStoreIds.add(record.store.id);
      rebuildTargets.set(`${record.store.id}|${record.incomeDate}`, { storeId: record.store.id, incomeDate: record.incomeDate });
    });
    // 覆盖商品销量：只把消费和撤销作为菜品，保险等结算流水绝不进入成本核算。
    rebuildTargets.forEach(target => db.run(`DELETE FROM business_product_sales WHERE store_id=? AND biz_date=? AND source_type='platform' AND channel='meituan_group'`, [target.storeId, target.incomeDate]));
    const products = new Map();
    rawRows.filter(record => record.store && ['消费', '撤销'].includes(record.transactionType) && record.projectName && Math.abs(record.salePrice) > 0.000001).forEach(record => {
      const key = `${record.store.id}|${record.incomeDate}|${record.projectName}`;
      const product = products.get(key) || { ...record, quantity: 0, salesAmount: 0, projectIds: new Set() };
      product.quantity += record.salePrice < 0 || record.transactionType === '撤销' ? -1 : 1;
      product.salesAmount += record.salePrice;
      if (String(record.projectId || '').trim()) product.projectIds.add(String(record.projectId).trim());
      products.set(key, product);
    });
    products.forEach(product => {
      const idList = [...product.projectIds];
      db.insert(`INSERT INTO business_product_sales (batch_id,store_id,store_name,biz_date,source_type,platform,channel,product_name,platform_product_id,quantity,sales_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
        batchId, product.store.id, product.store.store_name, product.incomeDate, 'platform', '美团团购', 'meituan_group', product.projectName,
        idList.length === 1 ? idList[0] : '', product.quantity, product.salesAmount,
      ]);
    });
    const total = { gross: 0, merchant: 0, customerPromotion: 0, customerPaid: 0, thirdPartyFee: 0, online: 0, offline: 0 };
    rebuildTargets.forEach(target => {
      const daily = replaceMeituanGroupBuyRevenue(db, { batchId, storeId: target.storeId, incomeDate: target.incomeDate });
      if (daily) { total.gross += daily.gross; total.merchant += daily.merchant; total.customerPromotion += daily.customerPromotion; total.customerPaid += daily.customerPaid; }
    });
    rawRows.filter(record => record.store).forEach(record => {
      total.thirdPartyFee += record.thirdPartyFee;
      if (record.saleMode === '线上交易') total.online += record.salePrice;
      else if (record.saleMode === '线下买单') total.offline += record.salePrice;
    });
    db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawRows.length, [...dates].sort()[0] || null, [...dates].sort().at(-1) || null, batchId]);
    db.run('COMMIT');
    db.save();
    return {
      batch_id: batchId, data_kind: 'meituan_group_benefit', imported: rebuildTargets.size, raw_imported: rawRows.length,
      product_rows: products.size, matched_stores: matchedStoreIds.size, unmatched, skipped, errors: errors.slice(0, 20),
      gross_total: Math.round(total.gross * 100) / 100, net_total: Math.round(total.merchant * 100) / 100,
      customer_paid_total: Math.round(total.customerPaid * 100) / 100, customer_promotion_total: Math.round(total.customerPromotion * 100) / 100,
      fee_total: Math.round(total.thirdPartyFee * 100) / 100, online_gross_total: Math.round(total.online * 100) / 100, offline_gross_total: Math.round(total.offline * 100) / 100,
      sheet_name: report.sheetName,
    };
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
}

// 抖音账单的 <dimension ref="A1"> 经常是错误的，不能依赖工作表范围；xlsx 会按实际单元格读出数据。
// 两张目标表都以首行字段定位：正向表第二列是订单编号，退款表第二列是退款时间、第三列才是订单编号。
function douyinGroupSettlementSheets(workbook) {
  const reports = [];
  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    // 抖音导出的 !ref 常被错误写成 A1；从真实单元格坐标重建范围，避免 sheet_to_json 只读到表头首格。
    const cells = Object.keys(sheet).filter(key => /^[A-Z]+\d+$/.test(key));
    if (!cells.length) return;
    const range = { s: { r: Infinity, c: Infinity }, e: { r: 0, c: 0 } };
    cells.forEach(key => {
      const point = XLSX.utils.decode_cell(key);
      range.s.r = Math.min(range.s.r, point.r); range.s.c = Math.min(range.s.c, point.c);
      range.e.r = Math.max(range.e.r, point.r); range.e.c = Math.max(range.e.c, point.c);
    });
    const grid = XLSX.utils.sheet_to_json({ ...sheet, '!ref': XLSX.utils.encode_range(range) }, { header: 1, defval: '', raw: true });
    const headers = (grid[0] || []).map(value => String(value || '').trim());
    if (cleanKey(headers[0]) !== cleanKey('核销时间') || !headers.some(header => cleanKey(header) === cleanKey('核销门店ID'))) return;
    const refund = cleanKey(headers[1]) === cleanKey('退款时间');
    const orderNo = refund ? 2 : 1;
    const storeId = headers.findIndex(header => cleanKey(header) === cleanKey('核销门店ID'));
    const storeName = headers.findIndex(header => cleanKey(header) === cleanKey('核销门店'));
    const productName = headers.findIndex(header => cleanKey(header) === cleanKey('订单商品'));
    // 若分账明细含平台商品/套餐/项目标识列则一并保留，便于与平台账单核对；没有则留空。
    const productIdLabels = ['商品ID', '商品id', '套餐ID', '套餐id', '项目ID', '项目id', '团购ID', '团购id', '商品编号', 'SPU ID', '商品SPU'];
    const productId = headers.findIndex(header => productIdLabels.some(label => cleanKey(header) === cleanKey(label)));
    const saleAmount = headers.findIndex(header => cleanKey(header).includes(cleanKey('售卖金额')));
    const netAmount = headers.findIndex(header => ['到手金额', '商家应得'].some(label => cleanKey(header) === cleanKey(label)));
    if (storeId < 0 || productName < 0 || saleAmount < 0 || netAmount < 0) return;
    // X 至 BI：保留所有费用字段，费率、说明和标识列只保留在 raw_json，不参与费用金额求和。
    const feeColumns = headers.slice(23, 61).map((name, offset) => ({ name, index: offset + 23 }))
      .filter(column => /^(增量宝|软件服务费|平台撮合服务费|达人服务费|团长服务费|服务商服务费|职人激励金|店员激励金|分期免息手续费|保险费用)$/.test(String(column.name)));
    reports.push({ sheetName, grid, refund, columns: { orderNo, storeId, storeName, productName, productId, saleAmount, netAmount, feeColumns } });
  });
  const hasPositive = reports.some(report => !report.refund);
  const hasRefund = reports.some(report => report.refund);
  return { reports, hasPositive, hasRefund };
}

function douyinFeeCategory(name) {
  const label = String(name || '');
  if (/保险|保障/.test(label)) return 'insurance_fee';
  if (/退款|退货|售后/.test(label)) return 'refund_amount';
  if (/推广|营销|补贴|优惠券|红包|达人|佣金/.test(label)) return 'promotion_fee';
  return 'service_fee';
}

function replaceDouyinGroupBuyRevenue(db, { batchId, storeId, incomeDate }) {
  const rows = db.queryAll(`SELECT * FROM douyin_group_buy_settlement_records
    WHERE store_id=? AND income_date=? AND match_status='matched'`, [storeId, incomeDate]);
  if (!rows.length) return null;
  const totals = { gross: 0, net: 0, fees: 0, service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0 };
  const orders = new Map();
  rows.forEach(row => {
    totals.gross += number(row.sale_amount);
    totals.net += number(row.net_amount);
    totals.fees += number(row.third_party_fee);
    let fees = {};
    try { fees = JSON.parse(row.fee_breakdown_json || '{}'); } catch {}
    ['service_fee', 'insurance_fee', 'promotion_fee', 'refund_amount'].forEach(key => { totals[key] += -number(fees[key]); });
    const order = String(row.order_no || row.id);
    orders.set(order, number(orders.get(order)) + number(row.sale_amount));
  });
  const orderCount = [...orders.values()].filter(value => value > 0.000001).length;
  replaceRevenue(db, {
    batch_id: batchId, store_id: storeId, store_name: rows[0].store_name, biz_date: incomeDate,
    source_type: 'platform', platform: '抖音团购', channel_group: 'group_buy', channel: 'douyin_group',
    gross_amount: totals.gross, platform_income_amount: totals.gross,
    actual_amount: totals.net, service_fee: totals.service_fee, insurance_fee: totals.insurance_fee,
    promotion_fee: totals.promotion_fee, refund_amount: totals.refund_amount, order_count: orderCount,
  });
  return { ...totals, orderCount };
}

function importDouyinGroupBuyWorkbook(db, params, user) {
  const operation = require('./douyin-operation');
  const dailyReport = operation.detect(readWorkbook(params.data));
  if (dailyReport) return operation.importReport(db, dailyReport, params, user);
  if (params.report_kind === 'operation') throw new Error('请选择抖音门店经营数据表');
  const workbook = readWorkbook(params.data);
  const { reports, hasPositive, hasRefund } = douyinGroupSettlementSheets(workbook);
  if (!hasPositive || !hasRefund) throw new Error('未同时找到“分账明细-正向-团购”和“分账明细-退款-团购”。请确认两表均含核销时间、订单编号、核销门店ID、订单商品、售卖金额和到手金额。');
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '抖音团购', params.file_name || '', 0, user?.id || null, user?.display_name || user?.username || '',
  ]);
  const rawRows = [], errors = [], targets = new Map(), dates = new Set(), matchedStoreIds = new Set();
  let skipped = 0, unmatched = 0;
  reports.forEach(report => {
    const c = report.columns;
    for (let rowIndex = 1; rowIndex < report.grid.length; rowIndex++) {
      const row = report.grid[rowIndex];
      const incomeDate = dateText(row[0]);
      const douyinStoreId = String(row[c.storeId] || '').trim();
      const orderNo = String(row[c.orderNo] || '').trim();
      if (!incomeDate || !douyinStoreId || !orderNo) {
        skipped++;
        if (errors.length < 20) errors.push(`${report.sheetName} 第 ${rowIndex + 1} 行：${!incomeDate ? '核销时间不正确' : !douyinStoreId ? '缺少核销门店 ID' : '缺少订单编号'}`);
        continue;
      }
      const feeBreakdown = { service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0, raw: {} };
      report.columns.feeColumns.forEach(column => {
        const amount = number(row[column.index]);
        feeBreakdown.raw[column.name] = number(feeBreakdown.raw[column.name]) + amount;
        feeBreakdown[douyinFeeCategory(column.name)] += amount;
      });
      const sign = report.refund ? -1 : 1;
      const store = db.queryOne(`SELECT s.id,s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name IN ('抖音团购','抖音') AND p.platform_id=? LIMIT 1`, [douyinStoreId]);
      const productName = String(row[c.productName] || '').trim();
      const productId = c.productId >= 0 ? String(row[c.productId] || '').trim() : '';
      const record = {
        rowIndex, sheetName: report.sheetName, douyinStoreId, sourceStoreName: String(row[c.storeName] || '').trim(), incomeDate, orderNo,
        recordType: report.refund ? '退款' : '正向', productName, productId, saleAmount: sign * Math.abs(number(row[c.saleAmount])), netAmount: sign * Math.abs(number(row[c.netAmount])),
        feeBreakdown, thirdPartyFee: Object.entries(feeBreakdown.raw).reduce((sum, [, value]) => sum + Math.abs(number(value)), 0), store,
        rowKey: [douyinStoreId, incomeDate, orderNo, report.refund ? '退款' : '正向', productName, rowIndex].join('|'),
        raw: Object.fromEntries((report.grid[0] || []).map((header, index) => [String(header || XLSX.utils.encode_col(index)), row[index]])),
      };
      rawRows.push(record); dates.add(incomeDate); targets.set(`${douyinStoreId}|${incomeDate}`, { douyinStoreId, incomeDate });
    }
  });
  if (!rawRows.length) throw new Error('两张抖音团购明细表中没有可导入的有效订单流水');
  const rebuildTargets = new Map();
  db.run('BEGIN');
  try {
    targets.forEach(target => db.run('DELETE FROM douyin_group_buy_settlement_records WHERE douyin_store_id=? AND income_date=?', [target.douyinStoreId, target.incomeDate]));
    rawRows.forEach(record => {
      const matched = !!record.store;
      db.run(`INSERT INTO douyin_group_buy_settlement_records
        (batch_id,source_row_key,douyin_store_id,source_store_name,income_date,order_no,record_type,product_name,sale_amount,net_amount,third_party_fee,fee_breakdown_json,raw_json,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`, [
        batchId, record.rowKey, record.douyinStoreId, record.sourceStoreName, record.incomeDate, record.orderNo, record.recordType, record.productName,
        record.saleAmount, record.netAmount, record.thirdPartyFee, JSON.stringify(record.feeBreakdown), JSON.stringify(record.raw), record.store?.id || null, record.store?.store_name || '', matched ? 'matched' : 'unmatched',
      ]);
      if (!matched) { unmatched++; if (errors.length < 20) errors.push(`${record.sheetName} 第 ${record.rowIndex + 1} 行：抖音门店 ID ${record.douyinStoreId} 未在“第三方平台 → 抖音团购”中登记`); return; }
      matchedStoreIds.add(record.store.id); rebuildTargets.set(`${record.store.id}|${record.incomeDate}`, { storeId: record.store.id, incomeDate: record.incomeDate });
    });
    rebuildTargets.forEach(target => db.run(`DELETE FROM business_product_sales WHERE store_id=? AND biz_date=? AND source_type='platform' AND channel='douyin_group'`, [target.storeId, target.incomeDate]));
    const products = new Map();
    rawRows.filter(record => record.store && record.productName).forEach(record => {
      const key = `${record.store.id}|${record.incomeDate}|${record.productName}`;
      const product = products.get(key) || { ...record, quantity: 0, salesAmount: 0, productIds: new Set() };
      product.quantity += record.recordType === '退款' ? -1 : 1; product.salesAmount += record.saleAmount;
      if (String(record.productId || '').trim()) product.productIds.add(String(record.productId).trim());
      products.set(key, product);
    });
    products.forEach(product => {
      const idList = [...product.productIds];
      db.insert(`INSERT INTO business_product_sales (batch_id,store_id,store_name,biz_date,source_type,platform,channel,product_name,platform_product_id,quantity,sales_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
        batchId, product.store.id, product.store.store_name, product.incomeDate, 'platform', '抖音团购', 'douyin_group', product.productName,
        idList.length === 1 ? idList[0] : '', product.quantity, product.salesAmount,
      ]);
    });
    const total = { gross: 0, net: 0, fee: 0 };
    rebuildTargets.forEach(target => { const daily = replaceDouyinGroupBuyRevenue(db, { batchId, ...target }); if (daily) { total.gross += daily.gross; total.net += daily.net; total.fee += daily.fees; } });
    db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawRows.length, [...dates].sort()[0] || null, [...dates].sort().at(-1) || null, batchId]);
    db.run('COMMIT'); db.save();
    return { batch_id: batchId, data_kind: 'douyin_group_settlement', imported: rebuildTargets.size, raw_imported: rawRows.length, product_rows: products.size, matched_stores: matchedStoreIds.size, unmatched, skipped, errors: errors.slice(0, 20), gross_total: Math.round(total.gross * 100) / 100, net_total: Math.round(total.net * 100) / 100, fee_total: Math.round(total.fee * 100) / 100, sheet_names: reports.map(report => report.sheetName) };
  } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
}

/**
 * 美团外卖“门店经营日报”导入（含流量/转化指标）。
 * 列：日期 | 门店名称 | 门店id | 省份/城市/区县 | 营业收入 | 优惠前总额 | 有效订单 |
 *     曝光人数 | 入店人数 | 入店转化率 | 下单转化率 | 曝光次数 | 下单人数
 * - 求和字段与比率字段分别落库（比率保留原始值，聚合时按加权口径重算）；
 * - 按(美团门店ID, 日期)去重，可重复导入；不影响已有营收/账单记录。
 */
function importMeituanOperationWorkbook(db, rows, params, user) {
  const aliases = {
    storeId: ['门店id', '门店ID', '美团门店id', '美团门店ID'],
    storeName: ['门店名称'],
    province: ['省份'],
    city: ['门店所在城市', '城市'],
    district: ['区县市', '区县'],
    income: ['营业收入', '收入'],
    gross: ['优惠前总额', '营业额'],
    orders: ['有效订单', '订单数'],
    impUsers: ['曝光人数', '曝光'],
    visitUsers: ['入店人数', '入店'],
    visitRate: ['入店转化率'],
    orderRate: ['下单转化率'],
    impCount: ['曝光次数'],
    orderUsers: ['下单人数'],
  };
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '美团外卖', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  const errors = [];
  const dates = new Set();
  const matchedStoreIds = new Set();
  let rawImported = 0;
  let unmatched = 0;
  const sums = { income_amount: 0, gross_amount: 0, order_count: 0, impression_users: 0, visit_users: 0, impression_count: 0, ordering_users: 0 };
  db.run('BEGIN');
  try {
    rows.forEach((row, index) => {
      const meituanStoreId = String(getValue(row, aliases.storeId) || '').trim();
      const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
      if (!meituanStoreId || !bizDate) {
        errors.push(`第 ${index + 2} 行：${!meituanStoreId ? '缺少美团门店 ID' : '日期格式不正确'}（已跳过）`);
        return;
      }
      const income = number(getValue(row, aliases.income));
      const gross = number(getValue(row, aliases.gross));
      const orders = number(getValue(row, aliases.orders));
      const impUsers = number(getValue(row, aliases.impUsers));
      const visitUsers = number(getValue(row, aliases.visitUsers));
      const visitRate = number(getValue(row, aliases.visitRate));
      const orderRate = number(getValue(row, aliases.orderRate));
      const impCount = number(getValue(row, aliases.impCount));
      const orderUsers = number(getValue(row, aliases.orderUsers));
      const store = db.queryOne(`
        SELECT s.id, s.store_name
        FROM store_platforms p
        JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name='美团外卖' AND p.platform_id=?
        LIMIT 1
      `, [meituanStoreId]);
      const matched = !!store;
      db.run(`INSERT INTO meituan_delivery_operation_records
        (batch_id,biz_date,meituan_store_id,source_store_name,source_province,source_city,source_district,
         income_amount,gross_amount,order_count,impression_users,visit_users,visit_rate,order_rate,impression_count,ordering_users,
         raw_json,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(meituan_store_id,biz_date) DO UPDATE SET
          batch_id=excluded.batch_id,source_store_name=excluded.source_store_name,
          source_province=excluded.source_province,source_city=excluded.source_city,source_district=excluded.source_district,
          income_amount=excluded.income_amount,gross_amount=excluded.gross_amount,order_count=excluded.order_count,
          impression_users=excluded.impression_users,visit_users=excluded.visit_users,visit_rate=excluded.visit_rate,
          order_rate=excluded.order_rate,impression_count=excluded.impression_count,ordering_users=excluded.ordering_users,
          raw_json=excluded.raw_json,store_id=excluded.store_id,store_name=excluded.store_name,
          match_status=excluded.match_status,updated_at=datetime('now','localtime')`, [
        batchId, bizDate, meituanStoreId,
        String(getValue(row, aliases.storeName) || '').trim(), String(getValue(row, aliases.province) || '').trim(),
        String(getValue(row, aliases.city) || '').trim(), String(getValue(row, aliases.district) || '').trim(),
        income, gross, orders, impUsers, visitUsers, visitRate, orderRate, impCount, orderUsers,
        JSON.stringify(row), store?.id || null, store?.store_name || '', matched ? 'matched' : 'unmatched',
      ]);
      rawImported += 1;
      dates.add(bizDate);
      if (!matched) {
        unmatched += 1;
        if (errors.length < 20) errors.push(`第 ${index + 2} 行：美团门店 ID ${meituanStoreId}（${String(getValue(row, aliases.storeName) || '').trim()}）未在“第三方平台 → 美团外卖”中登记，原始记录已保留`);
        return;
      }
      matchedStoreIds.add(store.id);
      sums.income_amount += income;
      sums.gross_amount += gross;
      sums.order_count += orders;
      sums.impression_users += impUsers;
      sums.visit_users += visitUsers;
      sums.impression_count += impCount;
      sums.ordering_users += orderUsers;
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  const dateArr = [...dates].sort();
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawImported, dateArr[0] || null, dateArr.at(-1) || null, batchId]);
  db.save();
  return {
    batch_id: batchId, data_kind: 'meituan_operation', imported: rawImported, raw_imported: rawImported,
    unmatched, matched_stores: matchedStoreIds.size,
    date_from: dateArr[0] || null, date_to: dateArr.at(-1) || null,
    sums: Object.fromEntries(Object.entries(sums).map(([key, value]) => [key, Math.round(value * 100) / 100])),
    skipped: errors.filter(error => error.includes('缺少') || error.includes('格式')).length,
    errors: errors.slice(0, 20),
  };
}

// 淘宝闪购 / 京东外卖“全门店营业日报”：字段不完全相同，但统一为营业、流量、转化漏斗。
function importDeliveryOperationWorkbook(db, rows, params, user, platform) {
  const aliases = {
    storeId: ['门店id', '门店ID', '门店编号', platform === '淘宝闪购' ? '淘宝门店ID' : '京东门店ID'],
    storeName: ['门店名称'], city: ['城市', '门店所在城市'], income: ['收入', '营业收入'], gross: ['营业额', '优惠前总额'], orders: ['有效订单', '订单数'],
    productSales: ['商品销售额'], packingFee: ['打包费'], deliveryFee: ['商家应收配送费'], claim: ['索赔单'], otherGross: ['其他营业额'],
    impUsers: ['曝光人数', '曝光'], visitUsers: ['进店人数', '入店人数', '入店'], orderUsers: ['下单人数'], impCount: ['曝光次数'],
    visitRate: ['进店转化率', '入店转化率'], orderRate: ['下单转化率'],
  };
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', platform, params.file_name || '', 0, user?.id || null, user?.display_name || user?.username || '',
  ]);
  const errors = [], dates = new Set(), matchedStoreIds = new Set();
  let rawImported = 0, imported = 0, unmatched = 0;
  db.run('BEGIN');
  try {
    rows.forEach((row, index) => {
      const platformStoreId = String(getValue(row, aliases.storeId) || '').trim();
      const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
      if (!platformStoreId || !bizDate) {
        if (errors.length < 20) errors.push(`第 ${index + 2} 行：${!platformStoreId ? `缺少${platform}门店 ID` : '日期格式不正确'}（已跳过）`);
        return;
      }
      const store = db.queryOne(`SELECT s.id,s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name=? AND p.platform_id=? LIMIT 1`, [platform, platformStoreId]);
      const values = {
        income: number(getValue(row, aliases.income)), gross: number(getValue(row, aliases.gross)), orders: number(getValue(row, aliases.orders)),
        productSales: number(getValue(row, aliases.productSales)), packing: number(getValue(row, aliases.packingFee)), delivery: number(getValue(row, aliases.deliveryFee)),
        claim: number(getValue(row, aliases.claim)), other: number(getValue(row, aliases.otherGross)), impUsers: number(getValue(row, aliases.impUsers)),
        visitUsers: number(getValue(row, aliases.visitUsers)), orderUsers: number(getValue(row, aliases.orderUsers)), impCount: number(getValue(row, aliases.impCount)),
        visitRate: number(getValue(row, aliases.visitRate)), orderRate: number(getValue(row, aliases.orderRate)),
      };
      // 京东报表没有“下单人数”列，只有“下单转化率(%)”：以转化率为准反推 下单人数 = 入店人数 × 下单转化率 ÷ 100（四舍五入保留整数）
      if (platform === '京东外卖' && !values.orderUsers && values.visitUsers > 0 && values.orderRate > 0) {
        values.orderUsers = Math.round(values.visitUsers * values.orderRate / 100);
      }
      db.run(`INSERT INTO delivery_operation_records
        (batch_id,platform,biz_date,platform_store_id,source_store_name,source_city,income_amount,gross_amount,order_count,product_sales_amount,packing_fee,delivery_fee,claim_amount,other_gross_amount,impression_users,visit_users,ordering_users,impression_count,visit_rate,order_rate,raw_json,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(platform,platform_store_id,biz_date) DO UPDATE SET batch_id=excluded.batch_id,source_store_name=excluded.source_store_name,source_city=excluded.source_city,income_amount=excluded.income_amount,gross_amount=excluded.gross_amount,order_count=excluded.order_count,product_sales_amount=excluded.product_sales_amount,packing_fee=excluded.packing_fee,delivery_fee=excluded.delivery_fee,claim_amount=excluded.claim_amount,other_gross_amount=excluded.other_gross_amount,impression_users=excluded.impression_users,visit_users=excluded.visit_users,ordering_users=excluded.ordering_users,impression_count=excluded.impression_count,visit_rate=excluded.visit_rate,order_rate=excluded.order_rate,raw_json=excluded.raw_json,store_id=excluded.store_id,store_name=excluded.store_name,match_status=excluded.match_status,updated_at=datetime('now','localtime')`, [
        batchId, platform, bizDate, platformStoreId, String(getValue(row, aliases.storeName) || '').trim(), String(getValue(row, aliases.city) || '').trim(),
        values.income, values.gross, values.orders, values.productSales, values.packing, values.delivery, values.claim, values.other, values.impUsers, values.visitUsers, values.orderUsers, values.impCount, values.visitRate, values.orderRate,
        JSON.stringify(row), store?.id || null, store?.store_name || '', store ? 'matched' : 'unmatched',
      ]);
      rawImported++; dates.add(bizDate);
      if (!store) { unmatched++; if (errors.length < 20) errors.push(`第 ${index + 2} 行：${platform}门店 ID ${platformStoreId} 未在“第三方平台 → ${platform}”中登记，原始记录已保留`); return; }
      matchedStoreIds.add(store.id); imported++;
      // 京东“门店经营日报”本身就是按日、按店的平台营业口径。此前只写入运营看板，
      // 导致总数据视角无法识别为第三方记录而错误回退到收银机。结算明细若已存在，
      // 则继续以结算明细的到账和费用为准，仅用日报补齐营业额、优惠与订单数。
      if (platform === '京东外卖') {
        syncJdOperationRevenue(db, {
          batch_id: batchId,
          store_id: store.id,
          store_name: store.store_name,
          biz_date: bizDate,
          gross_amount: values.gross,
          income_amount: values.income,
          order_count: values.orders,
        });
      }
    });
    db.run('COMMIT');
  } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
  const dateArr = [...dates].sort();
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawImported, dateArr[0] || null, dateArr.at(-1) || null, batchId]);
  db.save();
  return { batch_id: batchId, data_kind: 'delivery_operation', imported, raw_imported: rawImported, unmatched, matched_stores: matchedStoreIds.size, date_from: dateArr[0] || null, date_to: dateArr.at(-1) || null, skipped: errors.filter(error => error.includes('缺少') || error.includes('格式')).length, errors: errors.slice(0, 20) };
}

/**
 * 将京东门店经营日报同步为总数据视角的平台营业记录。
 * 真实结算账单已存在时，账单的到账/费用优先级高于经营日报；日报只负责营业额口径。
 */
function syncJdOperationRevenue(db, row) {
  const hasSettlement = !!db.queryOne(`SELECT 1 FROM jd_delivery_bills
    WHERE store_id=? AND bill_date=? AND match_status='matched' LIMIT 1`, [row.store_id, row.biz_date]);
  const existing = db.queryOne(`SELECT * FROM business_revenue_records
    WHERE store_id=? AND biz_date=? AND source_type='platform' AND platform='京东外卖' AND channel='jd_delivery'
    LIMIT 1`, [row.store_id, row.biz_date]);
  const gross = number(row.gross_amount);
  const income = number(row.income_amount);
  replaceRevenue(db, {
    batch_id: row.batch_id,
    store_id: row.store_id,
    store_name: row.store_name,
    biz_date: row.biz_date,
    source_type: 'platform',
    platform: '京东外卖',
    channel_group: 'delivery',
    channel: 'jd_delivery',
    gross_amount: gross,
    platform_income_amount: hasSettlement ? number(existing?.platform_income_amount) : income,
    actual_amount: hasSettlement ? number(existing?.actual_amount) : income,
    service_fee: hasSettlement ? number(existing?.service_fee) : 0,
    insurance_fee: hasSettlement ? number(existing?.insurance_fee) : 0,
    promotion_fee: hasSettlement ? number(existing?.promotion_fee) : 0,
    refund_amount: hasSettlement ? number(existing?.refund_amount) : 0,
    discount_amount: Math.max(0, gross - income),
    order_count: number(row.order_count),
  });
}

// 兼容已导入的京东经营日报：服务启动时补齐一次，不需要用户重新上传同一份表。
function rebuildJdRevenueFromOperation(db) {
  const rows = db.queryAll(`SELECT batch_id,store_id,store_name,biz_date,gross_amount,income_amount,order_count
    FROM delivery_operation_records
    WHERE platform='京东外卖' AND match_status='matched' AND store_id IS NOT NULL`);
  rows.forEach(row => syncJdOperationRevenue(db, row));
  if (rows.length) db.save();
  return rows.length;
}

// 京东以 H 列“订单类型”决定流水归属：仅“正向订单”是订单实收，其他类型均为第三方费用。
// I 列“订单二级类型”是费用明细名称，优先保留给看板展示。
function jdBillCategory(orderType) {
  const type = String(orderType || '').trim();
  if (type === '正向订单' || type.startsWith('正向订单 ·')) return 'revenue';
  if (/保险/.test(type)) return 'insurance_fee';
  if (/推广|营销|广告/.test(type)) return 'promotion_fee';
  if (/退款|赔付|逆向|取消/.test(type)) return 'refund_amount';
  return 'service_fee';
}

/**
 * 京东“全部门店真实到账收入”结算明细为两行表头：第二行给出字段名，X 列为应结金额。
 * H 列“正向订单”归为订单实收；其余订单类型均记录为第三方费用明细。
 * X 列合计始终作为实际到账，不由费用再次反算。
 */
function jdSettlementDetailRows(workbook) {
  const aliasHit = (header, aliases) => aliases.some(alias => cleanKey(header) === cleanKey(alias));
  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
    const header = grid[1] || [];
    const col = aliases => header.findIndex(cell => aliasHit(cell, aliases));
    const storeIdCol = col(['门店编号', '门店ID']);
    const storeNameCol = col(['门店名称']);
    const completedAtCol = col(['订单完成/退款完成时间', '订单完成时间']);
    const actualCol = col(['应结金额', '实际收入']);
    const orderTypeCol = col(['订单类型']);
    const orderSubTypeCol = col(['订单二级类型']);
    if (storeIdCol < 0 || completedAtCol < 0 || actualCol < 0 || orderTypeCol < 0) continue;
    const rows = [];
    for (let index = 2; index < grid.length; index += 1) {
      const row = grid[index] || [];
      const storeId = String(row[storeIdCol] || '').trim();
      const bizDate = dateText(row[completedAtCol]);
      if (!storeId || !bizDate) continue;
      rows.push({
        京东门店ID: storeId,
        门店名称: storeNameCol >= 0 ? String(row[storeNameCol] || '').trim() : '',
        完成日期: bizDate,
        订单类型: String(row[orderTypeCol] || '').trim(),
        订单二级类型: orderSubTypeCol >= 0 ? String(row[orderSubTypeCol] || '').trim() : '',
        实际收入: number(row[actualCol]),
      });
    }
    if (rows.length) return { sheet_name: sheetName, rows };
  }
  return null;
}

function importJdSettlementDetailWorkbook(db, detailRows, params, user) {
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '京东外卖', params.file_name || '', 0, user?.id || null, user?.display_name || user?.username || '',
  ]);
  const daily = new Map();
  detailRows.forEach(row => {
    const key = `${row.京东门店ID}|${row.完成日期}`;
    const item = daily.get(key) || {
      ...row, amount: 0, order_income: 0, transaction_count: 0,
      service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0,
      bill_groups: new Map(),
    };
    item.amount += number(row.实际收入);
    item.transaction_count += 1;
    const category = jdBillCategory(row.订单类型);
    if (category === 'revenue') item.order_income += number(row.实际收入);
    else item[category] -= number(row.实际收入);
    const billType = row.订单二级类型 ? `${row.订单类型} · ${row.订单二级类型}` : (row.订单类型 || '未分类流水');
    const bill = item.bill_groups.get(billType) || { bill_type: billType, amount: 0, transaction_count: 0, category };
    bill.amount += number(row.实际收入);
    bill.transaction_count += 1;
    item.bill_groups.set(billType, bill);
    daily.set(key, item);
  });
  const errors = [], dates = new Set(), matchedStoreIds = new Set();
  let imported = 0, unmatched = 0, matchedTotal = 0, orderIncomeTotal = 0;
  const feeBreakdown = { service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0 };
  db.run('BEGIN');
  try {
    daily.forEach(item => {
      const store = db.queryOne(`SELECT s.id,s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name='京东外卖' AND p.platform_id=? LIMIT 1`, [item.京东门店ID]);
      dates.add(item.完成日期);
      if (!store) {
        unmatched += 1;
        if (errors.length < 20) errors.push(`京东门店 ID ${item.京东门店ID}（${item.门店名称 || '未提供名称'}）未在“第三方平台 → 京东外卖”中登记，明细已跳过统计`);
        return;
      }
      item.bill_groups.forEach(bill => {
        db.run(`INSERT INTO jd_delivery_bills
          (batch_id,jd_store_id,source_store_name,bill_date,bill_type,amount,transaction_count,store_id,store_name,match_status,raw_json,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
          ON CONFLICT(jd_store_id,bill_date,bill_type) DO UPDATE SET
            batch_id=excluded.batch_id,source_store_name=excluded.source_store_name,amount=excluded.amount,
            transaction_count=excluded.transaction_count,store_id=excluded.store_id,store_name=excluded.store_name,
            match_status=excluded.match_status,raw_json=excluded.raw_json,updated_at=datetime('now','localtime')`, [
          batchId, item.京东门店ID, item.门店名称, item.完成日期, bill.bill_type, bill.amount, bill.transaction_count,
          store.id, store.store_name, 'matched', JSON.stringify({ order_type: bill.bill_type, category: bill.category }),
        ]);
      });
      const existing = db.queryOne(`SELECT gross_amount,discount_amount,order_count FROM business_revenue_records
        WHERE store_id=? AND biz_date=? AND source_type='platform' AND platform='京东外卖' AND channel='jd_delivery' LIMIT 1`, [store.id, item.完成日期]);
      const operation = db.queryOne(`SELECT gross_amount,order_count FROM delivery_operation_records
        WHERE platform='京东外卖' AND store_id=? AND biz_date=? AND match_status='matched' LIMIT 1`, [store.id, item.完成日期]);
      // X 列已是京东最终应结金额；H/I 费用仅用于费用明细展示，绝不再从 X 列二次扣减。
      replaceRevenue(db, {
        batch_id: batchId, store_id: store.id, store_name: store.store_name, biz_date: item.完成日期,
        source_type: 'platform', platform: '京东外卖', channel_group: 'delivery', channel: 'jd_delivery',
        gross_amount: number(existing?.gross_amount || operation?.gross_amount),
        platform_income_amount: item.order_income, actual_amount: item.amount,
        service_fee: item.service_fee, insurance_fee: item.insurance_fee,
        promotion_fee: item.promotion_fee, refund_amount: item.refund_amount,
        discount_amount: number(existing?.discount_amount), order_count: number(existing?.order_count || operation?.order_count),
      });
      matchedStoreIds.add(store.id);
      matchedTotal += item.amount;
      orderIncomeTotal += item.order_income;
      Object.keys(feeBreakdown).forEach(key => { feeBreakdown[key] += number(item[key]); });
      imported += 1;
    });
    db.run('COMMIT');
  } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
  const dateArr = [...dates].sort();
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [detailRows.length, dateArr[0] || null, dateArr.at(-1) || null, batchId]);
  db.save();
  return {
    batch_id: batchId, data_kind: 'settlement_bills', imported, raw_imported: detailRows.length,
    unmatched, matched_stores: matchedStoreIds.size, date_from: dateArr[0] || null, date_to: dateArr.at(-1) || null,
    net_total: Math.round(matchedTotal * 100) / 100, delivery_amount_total: Math.round(orderIncomeTotal * 100) / 100,
    fee_total: Math.round(Object.values(feeBreakdown).reduce((sum, value) => sum + value, 0) * 100) / 100,
    fee_breakdown: Object.fromEntries(Object.entries(feeBreakdown).map(([key, value]) => [key, Math.round(value * 100) / 100])),
    skipped: 0, errors: errors.slice(0, 20),
  };
}

/**
 * 美团外卖经营指标汇总（供“美团外卖视角”展示）。
 * 求和：金额/单量/曝光/入店/下单/次数；
 * 平均（加权重算）：入店转化率 = Σ入店 ÷ Σ曝光；下单转化率 = Σ下单 ÷ Σ入店。
 */
/**
 * 规格售价反解：给定平台/商品在(门店,日)的 销量+销售额，
 * 用配置的规格售价反推各规格数量，成本 = Σ(规格数量×规格成本)。
 * 只接受“单价直接命中”或“唯一的整数金额组合”；存在多解时绝不猜成本。
 * 配置来源 business_product_spec_links；未配置返回 configured=false；
 * 无整数解/多解信息一并返回，调用方决定兜底。
 */
function resolveSpecCost(db, platform, productName, quantity, salesAmount, context = {}) {
  const links = db.queryAll(`SELECT sl.id, sl.menu_item_id, sl.platform_price AS price, m.name AS menu_name, m.spec AS menu_spec, COALESCE(m.cost, 0) AS cost
    FROM business_product_spec_links sl
    LEFT JOIN menu_items m ON m.id = sl.menu_item_id
    WHERE sl.platform=? AND sl.external_product_name=? AND sl.enabled=1
    ORDER BY sl.sort_order, sl.platform_price`, [platform, productName]);
  if (!links.length) return { configured: false };
  const n = Math.round(Number(quantity) || 0);
  const totalCents = Math.round((Number(salesAmount) || 0) * 100);
  if (n <= 0 || n > 400) return { configured: true, solved: false, reason: n > 400 ? '数量过大' : '数量为空' };
  const prices = links.map(link => Math.round((Number(link.price) || 0) * 100));
  if (prices.some(price => price <= 0)) return { configured: true, solved: false, reason: '规格平台售价无效' };
  const resultCounts = counts => links.map((link, index) => ({
    price: Number(link.price), cost: Number(link.cost), spec_label: (link.menu_spec || link.menu_name || ''), count: counts[index] || 0,
  }));
  // 人工确认覆盖优先：用于淘宝闪购等仅提供日汇总、且售价组合存在多解的场景。
  const storeId = Number(context.store_id || context.storeId);
  const bizDate = String(context.biz_date || context.bizDate || '').trim();
  if (storeId > 0 && bizDate) {
    const overrides = db.queryAll(`SELECT menu_item_id, quantity FROM business_product_spec_overrides
      WHERE platform=? AND store_id=? AND biz_date=? AND external_product_name=?`, [platform, storeId, bizDate, productName]);
    if (overrides.length) {
      const overrideMap = new Map(overrides.map(row => [Number(row.menu_item_id), Math.max(0, Math.round(number(row.quantity)))]));
      const counts = links.map(link => overrideMap.get(Number(link.menu_item_id)) || 0);
      const overrideQty = counts.reduce((sum, value) => sum + value, 0);
      if (overrideQty !== n) return { configured: true, solved: false, reason: `人工确认数量 ${overrideQty} 与平台销量 ${n} 不一致`, method: 'manual_override_invalid' };
      const cost = links.reduce((sum, link, index) => sum + counts[index] * number(link.cost), 0);
      return { configured: true, solved: true, method: 'manual_override', confidence: 'confirmed', unique: true, cost: Math.round(cost * 100) / 100, counts: resultCounts(counts) };
    }
  }
  // 单一规格售价直接命中：例如 2 份 × ¥96.80 = ¥193.60，属于最高置信度。
  const direct = prices.map((price, index) => ({ price, index })).filter(item => item.price * n === totalCents);
  if (direct.length === 1) {
    const counts = links.map((_, index) => index === direct[0].index ? n : 0);
    return {
      configured: true, solved: true, method: 'unit_price_match', confidence: 'exact', unique: true,
      cost: Math.round(n * (Number(links[direct[0].index].cost) || 0) * 100) / 100,
      counts: resultCounts(counts),
    };
  }
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const solutions = [];
  const walk = (index, remainN, remainCents, counts, cost) => {
    // 只需区分“唯一”与“非唯一”，找到两种组合立即停止，避免大销量商品枚举过慢。
    if (solutions.length > 1) return;
    if (index === links.length) {
      if (remainN === 0 && remainCents === 0) solutions.push({ counts: [...counts], cost });
      return;
    }
    const price = prices[index];
    const left = links.length - index - 1;
    const leftMin = left ? Math.min(...prices.slice(index + 1)) : 0;
    const leftMax = left ? Math.max(...prices.slice(index + 1)) : 0;
    const maxK = Math.min(remainN, Math.floor(remainCents / price));
    for (let k = 0; k <= maxK && k <= remainN; k++) {
      const nextCents = remainCents - k * price;
      const nextN = remainN - k;
      if (nextN === 0) { if (nextCents === 0) solutions.push({ counts: [...counts, k], cost: cost + k * (Number(links[index].cost) || 0) }); continue; }
      if (left && (nextCents < leftMin * nextN || nextCents > leftMax * nextN)) continue;
      walk(index + 1, nextN, nextCents, [...counts, k], cost + k * (Number(links[index].cost) || 0));
    }
  };
  walk(0, n, totalCents, [], 0);
  if (!solutions.length) return { configured: true, solved: false, reason: '无整数解（价格组合无法凑出销售额）' };
  if (solutions.length > 1) return { configured: true, solved: false, reason: `存在 ${solutions.length} 种规格组合，无法唯一判断` };
  const best = solutions[0];
  return {
    configured: true, solved: true, method: 'unique_price_combination', confidence: 'exact',
    cost: Math.round(best.cost * 100) / 100,
    unique: true, solution_count: 1, counts: resultCounts(best.counts),
  };
}

function meituanGroupOperationSheet(workbook) {
  for (const sheetName of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
    const headers = (grid[0] || []).map(value => String(value || '').trim());
    const col = label => headers.findIndex(value => cleanKey(value) === cleanKey(label));
    const columns = {
      date: col('日期'), storeId: col('美团门店ID'), storeName: col('门店名称'),
      impressions: col('曝光人数'), visits: col('访问人数'), purchases: col('购买人数'),
      gross: col('成交金额'), income: col('核销金额'),
      meituanRating: col('美团星级'), dianpingRating: col('点评星级'), reviews: col('全部评价数'),
    };
    if ([columns.date, columns.storeId, columns.impressions, columns.visits, columns.purchases, columns.gross, columns.income].every(index => index >= 0)) {
      return { sheetName, grid, columns };
    }
  }
  return null;
}

function importMeituanGroupOperationWorkbook(db, params, user) {
  const workbook = readWorkbook(params.data);
  const report = meituanGroupOperationSheet(workbook);
  if (!report) throw new Error('未找到美团团购“门店基础数据”工作表。需要包含日期、美团门店ID、曝光人数、访问人数、购买人数、成交金额和核销金额。');
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '美团团购', params.file_name || '', 0, user?.id || null, user?.display_name || user?.username || '',
  ]);
  const { grid, columns: c } = report;
  const rows = [], errors = [], dates = new Set(), matchedStoreIds = new Set();
  let skipped = 0, unmatched = 0;
  for (let index = 1; index < grid.length; index++) {
    const row = grid[index];
    const bizDate = dateText(row[c.date]);
    const meituanStoreId = String(row[c.storeId] || '').trim();
    if (!bizDate || !meituanStoreId) {
      skipped++;
      if (errors.length < 20) errors.push(`第 ${index + 1} 行：${!bizDate ? '日期不正确' : '缺少美团门店 ID'}`);
      continue;
    }
    const store = db.queryOne(`SELECT s.id,s.store_name FROM store_platforms p JOIN stores s ON s.id=p.store_id
      WHERE p.platform_name='美团团购' AND p.platform_id=? LIMIT 1`, [meituanStoreId]);
    rows.push({
      index, bizDate, meituanStoreId, sourceStoreName: String(row[c.storeName] || '').trim(), store,
      grossAmount: number(row[c.gross]), incomeAmount: number(row[c.income]), orderCount: number(row[c.purchases]),
      impressionUsers: number(row[c.impressions]), visitUsers: number(row[c.visits]), orderingUsers: number(row[c.purchases]),
      meituanRating: number(row[c.meituanRating]), dianpingRating: number(row[c.dianpingRating]), reviewCount: number(row[c.reviews]),
      raw: Object.fromEntries((grid[0] || []).map((header, column) => [String(header || XLSX.utils.encode_col(column)), row[column]])),
    });
    dates.add(bizDate);
  }
  if (!rows.length) throw new Error('门店基础数据中没有可导入的有效行');
  db.run('BEGIN');
  try {
    rows.forEach(record => {
      db.run('DELETE FROM meituan_group_buy_operation_records WHERE meituan_store_id=? AND biz_date=?', [record.meituanStoreId, record.bizDate]);
      const matched = !!record.store;
      db.run(`INSERT INTO meituan_group_buy_operation_records
        (batch_id,meituan_store_id,source_store_name,biz_date,gross_amount,income_amount,order_count,impression_users,visit_users,ordering_users,meituan_rating,dianping_rating,review_count,raw_json,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`, [
        batchId, record.meituanStoreId, record.sourceStoreName, record.bizDate, record.grossAmount, record.incomeAmount,
        record.orderCount, record.impressionUsers, record.visitUsers, record.orderingUsers, record.meituanRating,
        record.dianpingRating, record.reviewCount, JSON.stringify(record.raw), record.store?.id || null, record.store?.store_name || '', matched ? 'matched' : 'unmatched',
      ]);
      if (!matched) {
        unmatched++;
        if (errors.length < 20) errors.push(`第 ${record.index + 1} 行：美团团购门店 ID ${record.meituanStoreId} 未在“第三方平台 → 美团团购”中登记，已保留但未计入看板`);
      } else matchedStoreIds.add(record.store.id);
    });
    const dateList = [...dates].sort();
    db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rows.length, dateList[0] || null, dateList.at(-1) || null, batchId]);
    db.run('COMMIT'); db.save();
    return { batch_id: batchId, data_kind: 'meituan_group_operation', imported: rows.length - unmatched, raw_imported: rows.length,
      matched_stores: matchedStoreIds.size, unmatched, skipped, errors, date_from: dateList[0] || null, date_to: dateList.at(-1) || null, sheet_name: report.sheetName };
  } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
}

function getMeituanGroupOperation(db, params = {}) {
  const clauses = ["o.match_status='matched'"]; const values = [];
  const storeIds = String(params.store_ids || '').split(',').map(Number).filter(id => Number.isInteger(id) && id > 0);
  if (storeIds.length) { clauses.push(`o.store_id IN (${storeIds.map(() => '?').join(',')})`); values.push(...storeIds); }
  else if (params.store_id) { clauses.push('o.store_id=?'); values.push(Number(params.store_id)); }
  if (params.date_from) { clauses.push('o.biz_date>=?'); values.push(params.date_from); }
  if (params.date_to) { clauses.push('o.biz_date<=?'); values.push(params.date_to); }
  const records = db.queryAll(`SELECT o.*, COALESCE(r.actual_amount, 0) AS actual_amount
    FROM meituan_group_buy_operation_records o
    LEFT JOIN (
      SELECT store_id,biz_date,SUM(actual_amount) AS actual_amount FROM business_revenue_records
      WHERE source_type='platform' AND channel='meituan_group' GROUP BY store_id,biz_date
    ) r ON r.store_id=o.store_id AND r.biz_date=o.biz_date
    WHERE ${clauses.join(' AND ')}`, values);
  const numeric = ['gross_amount','income_amount','actual_amount','order_count','impression_users','visit_users','ordering_users','review_count'];
  const totals = Object.fromEntries(numeric.map(key => [key, 0]));
  let meituanRatingTotal = 0, dianpingRatingTotal = 0, ratingRows = 0;
  const stores = new Map(), dates = new Map();
  const add = (target, row) => numeric.forEach(key => { target[key] = number(target[key]) + number(row[key]); });
  records.forEach(row => {
    add(totals, row);
    if (number(row.meituan_rating) || number(row.dianping_rating)) { meituanRatingTotal += number(row.meituan_rating); dianpingRatingTotal += number(row.dianping_rating); ratingRows++; }
    const store = stores.get(row.store_id) || { store_id: row.store_id, store_name: row.store_name, ...Object.fromEntries(numeric.map(key => [key, 0])), _ratingRows: 0, _meituanRating: 0, _dianpingRating: 0 };
    add(store, row); if (number(row.meituan_rating) || number(row.dianping_rating)) { store._ratingRows++; store._meituanRating += number(row.meituan_rating); store._dianpingRating += number(row.dianping_rating); } stores.set(row.store_id, store);
    const day = dates.get(row.biz_date) || { date: row.biz_date, ...Object.fromEntries(numeric.map(key => [key, 0])), _ratingRows: 0, _meituanRating: 0, _dianpingRating: 0 };
    add(day, row); if (number(row.meituan_rating) || number(row.dianping_rating)) { day._ratingRows++; day._meituanRating += number(row.meituan_rating); day._dianpingRating += number(row.dianping_rating); } dates.set(row.biz_date, day);
  });
  const finish = row => {
    row.visit_rate = row.impression_users ? row.visit_users / row.impression_users : null;
    row.order_rate = row.visit_users ? row.ordering_users / row.visit_users : null;
    row.meituan_rating = row._ratingRows ? row._meituanRating / row._ratingRows : 0;
    row.dianping_rating = row._ratingRows ? row._dianpingRating / row._ratingRows : 0;
    delete row._ratingRows; delete row._meituanRating; delete row._dianpingRating; return row;
  };
  totals._ratingRows = ratingRows; totals._meituanRating = meituanRatingTotal; totals._dianpingRating = dianpingRatingTotal;
  // 团购预估毛利严格使用“收益明细商家应得（实际到账）− 已绑定菜品成本之和”。
  // 门店基础数据中的成交/核销金额仅用于经营指标，绝不作为毛利收入基数。
  const productClauses = ["p.source_type='platform'", "p.channel='meituan_group'"];
  const productValues = [];
  if (storeIds.length) { productClauses.push(`p.store_id IN (${storeIds.map(() => '?').join(',')})`); productValues.push(...storeIds); }
  else if (params.store_id) { productClauses.push('p.store_id=?'); productValues.push(Number(params.store_id)); }
  if (params.date_from) { productClauses.push('p.biz_date>=?'); productValues.push(params.date_from); }
  if (params.date_to) { productClauses.push('p.biz_date<=?'); productValues.push(params.date_to); }
  const costByStore = new Map();
  db.queryAll(`SELECT p.store_id,p.quantity,COALESCE(mi.cost,0) AS unit_cost
    FROM business_product_sales p
    LEFT JOIN business_product_mappings bm ON bm.platform='美团团购' AND bm.external_product_name=p.product_name
    LEFT JOIN menu_items mi ON mi.id=bm.menu_item_id
    WHERE ${productClauses.join(' AND ')}`, productValues).forEach(row => {
      const cost = number(row.quantity) * number(row.unit_cost);
      costByStore.set(Number(row.store_id), (costByStore.get(Number(row.store_id)) || 0) + cost);
    });
  const totalCost = [...costByStore.values()].reduce((sum, value) => sum + value, 0);
  const applyProfit = row => {
    const cost = row.store_id != null ? (costByStore.get(Number(row.store_id)) || 0) : totalCost;
    row.cost_amount = Math.round(cost * 100) / 100;
    row.gross_profit = Math.round((number(row.actual_amount) - row.cost_amount) * 100) / 100;
    row.gross_profit_rate = number(row.actual_amount) ? row.gross_profit / number(row.actual_amount) : null;
    return row;
  };
  return { ok: true, days: dates.size, stores_count: stores.size, totals: applyProfit(finish(totals)), trend: [...dates.values()].sort((a,b) => a.date.localeCompare(b.date)).map(finish), stores: [...stores.values()].map(finish).map(applyProfit).sort((a,b) => b.actual_amount - a.actual_amount) };
}
function getMeituanOperation(db, params = {}) {
  if (params.platform === '抖音团购') return require('./douyin-operation').getReport(db, params);
  const platform = String(params.platform || '美团外卖').trim() || '美团外卖';
  if (platform === '美团团购') return getMeituanGroupOperation(db, params);
  const usesLegacyMeituanTable = platform === '美团外卖';
  const clauses = ["match_status='matched'"];
  const values = [];
  if (!usesLegacyMeituanTable) { clauses.unshift('platform=?'); values.push(platform); }
  const storeIds = String(params.store_ids || '').split(',').map(Number).filter(id => Number.isInteger(id) && id > 0);
  if (storeIds.length) { clauses.push(`store_id IN (${storeIds.map(() => '?').join(',')})`); values.push(...storeIds); }
  else if (params.store_id) { clauses.push('store_id=?'); values.push(Number(params.store_id)); }
  if (params.date_from) { clauses.push('biz_date>=?'); values.push(params.date_from); }
  if (params.date_to) { clauses.push('biz_date<=?'); values.push(params.date_to); }
  const sourceTable = usesLegacyMeituanTable ? 'meituan_delivery_operation_records' : 'delivery_operation_records';
  const extraFields = usesLegacyMeituanTable
    ? '0 AS product_sales_amount, 0 AS packing_fee, 0 AS delivery_fee, 0 AS claim_amount, 0 AS other_gross_amount'
    : 'product_sales_amount, packing_fee, delivery_fee, claim_amount, other_gross_amount';
  const sql = `SELECT store_id, store_name, biz_date,
      income_amount, gross_amount, order_count,
      impression_users, visit_users, impression_count, ordering_users,
      ${extraFields}
    FROM ${sourceTable} WHERE ${clauses.join(' AND ')}`;
  const records = db.queryAll(sql, values);
  const sums = {
    income_amount: 0, gross_amount: 0, order_count: 0,
    impression_users: 0, visit_users: 0, impression_count: 0, ordering_users: 0,
    product_sales_amount: 0, packing_fee: 0, delivery_fee: 0, claim_amount: 0, other_gross_amount: 0,
  };
  const byStore = new Map();
  records.forEach(row => {
    ['income_amount', 'gross_amount', 'order_count', 'impression_users', 'visit_users', 'impression_count', 'ordering_users', 'product_sales_amount', 'packing_fee', 'delivery_fee', 'claim_amount', 'other_gross_amount'].forEach(key => {
      sums[key] += number(row[key]);
    });
    const item = byStore.get(row.store_id) || {
      store_id: row.store_id, store_name: row.store_name,
      income_amount: 0, gross_amount: 0, order_count: 0,
      impression_users: 0, visit_users: 0, impression_count: 0, ordering_users: 0,
      product_sales_amount: 0, packing_fee: 0, delivery_fee: 0, claim_amount: 0, other_gross_amount: 0,
    };
    ['income_amount', 'gross_amount', 'order_count', 'impression_users', 'visit_users', 'impression_count', 'ordering_users', 'product_sales_amount', 'packing_fee', 'delivery_fee', 'claim_amount', 'other_gross_amount'].forEach(key => {
      item[key] += number(row[key]);
    });
    byStore.set(row.store_id, item);
  });
  const withRate = (value) => {
    value.visit_rate = value.impression_users ? value.visit_users / value.impression_users : null;
    value.order_rate = value.visit_users ? value.ordering_users / value.visit_users : null;
    return value;
  };
  const days = new Set(records.map(row => row.biz_date)).size;
  const totals = withRate(sums);
  // 淘宝日报“收入”是优惠后收入，真实到账必须以账单汇总扣除第三方费用后的 platform actual_amount 为准。
  // 京东结算明细 X 列已经是应结金额（已扣第三方费用），同样以结算明细为准；美团沿用营业日报口径。
  const actualByStore = new Map();
  const settlementTotals = { actual_amount: 0, platform_income_amount: 0, service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0 };
  if (['淘宝闪购', '京东外卖'].includes(platform)) {
    const actualClauses = ["source_type='platform'", 'platform=?', 'channel=?'];
    const actualValues = [platform, platform === '淘宝闪购' ? 'taobao_flash' : 'jd_delivery'];
    if (storeIds.length) { actualClauses.push(`store_id IN (${storeIds.map(() => '?').join(',')})`); actualValues.push(...storeIds); }
    else if (params.store_id) { actualClauses.push('store_id=?'); actualValues.push(Number(params.store_id)); }
    if (params.date_from) { actualClauses.push('biz_date>=?'); actualValues.push(params.date_from); }
    if (params.date_to) { actualClauses.push('biz_date<=?'); actualValues.push(params.date_to); }
    db.queryAll(`SELECT store_id,SUM(actual_amount) actual_amount,SUM(platform_income_amount) platform_income_amount,
      SUM(service_fee) service_fee,SUM(insurance_fee) insurance_fee,SUM(promotion_fee) promotion_fee,SUM(refund_amount) refund_amount
      FROM business_revenue_records WHERE ${actualClauses.join(' AND ')} GROUP BY store_id`, actualValues)
      .forEach(row => {
        actualByStore.set(Number(row.store_id), number(row.actual_amount));
        ['actual_amount', 'platform_income_amount', 'service_fee', 'insurance_fee', 'promotion_fee', 'refund_amount']
          .forEach(key => { settlementTotals[key] += number(row[key]); });
      });
  }
  const usesSettlementActual = ['淘宝闪购', '京东外卖'].includes(platform);
  totals.actual_amount = usesSettlementActual ? [...actualByStore.values()].reduce((sum, value) => sum + value, 0) : totals.income_amount;
  if (platform === '京东外卖') {
    totals.platform_income_amount = settlementTotals.platform_income_amount;
    totals.fee_total = settlementTotals.service_fee + settlementTotals.insurance_fee + settlementTotals.promotion_fee + settlementTotals.refund_amount;
  }
  byStore.forEach(item => { item.actual_amount = usesSettlementActual ? (actualByStore.get(Number(item.store_id)) ?? null) : item.income_amount; });
    // 预估毛利成本 = 普通绑定菜品成本(quantity×已绑SKU成本) + 配置“规格反解”商品的规格成本；未绑/未解按 0
  const specLinks = db.queryAll(`SELECT sl.external_product_name, sl.menu_item_id, sl.platform_price,
      m.name AS menu_name, m.spec AS menu_spec, m.method AS menu_method, COALESCE(m.cost, 0) AS unit_cost
    FROM business_product_spec_links sl LEFT JOIN menu_items m ON m.id=sl.menu_item_id
    WHERE sl.platform=? AND sl.enabled=1
    ORDER BY sl.external_product_name, sl.sort_order, sl.platform_price`, [platform]);
  const specMap = new Map();
  specLinks.forEach(link => {
    const name = String(link.external_product_name || '');
    const list = specMap.get(name) || [];
    list.push({ menu_item_id: Number(link.menu_item_id), platform_price: number(link.platform_price), menu_name: link.menu_name || '', menu_spec: link.menu_spec || '', menu_method: link.menu_method || '', unit_cost: number(link.unit_cost) });
    specMap.set(name, list);
  });
  const operationChannel = { '美团外卖': 'meituan_delivery', '淘宝闪购': 'taobao_flash', '京东外卖': 'jd_delivery' }[platform] || 'meituan_delivery';
  const rowClauses = ['p.channel=?'];
  const rowValues = [operationChannel];
  if (storeIds.length) { rowClauses.push(`p.store_id IN (${storeIds.map(() => '?').join(',')})`); rowValues.push(...storeIds); }
  else if (params.store_id) { rowClauses.push('p.store_id=?'); rowValues.push(Number(params.store_id)); }
  if (params.date_from) { rowClauses.push('p.biz_date>=?'); rowValues.push(params.date_from); }
  if (params.date_to) { rowClauses.push('p.biz_date<=?'); rowValues.push(params.date_to); }
  const productRows = db.queryAll(`SELECT p.store_id, p.product_name, p.quantity, p.sales_amount, COALESCE(mi.cost, 0) AS mapped_cost
    FROM business_product_sales p
    LEFT JOIN business_product_mappings bm ON bm.platform=? AND bm.external_product_name = p.product_name
    LEFT JOIN menu_items mi ON mi.id = bm.menu_item_id
    WHERE ${rowClauses.join(' AND ')}`, [platform, ...rowValues]);
  const costByStore = new Map();
  productRows.forEach(row => {
    let cost = 0;
    if (specMap.has(String(row.product_name || ''))) {
      const resolved = resolveSpecCost(db, platform, String(row.product_name || ''), number(row.quantity), number(row.sales_amount));
      if (resolved.configured && resolved.solved) cost = resolved.cost;
    } else {
      cost = number(row.quantity) * number(row.mapped_cost);
    }
    if (cost) costByStore.set(row.store_id, (costByStore.get(row.store_id) || 0) + cost);
  });
  const totalCost = [...costByStore.values()].reduce((sum, value) => sum + value, 0);
  const applyProfit = (value) => {
    const cost = value.store_id != null ? (costByStore.get(value.store_id) || 0) : totalCost;
    value.cost_amount = Math.round(cost * 100) / 100;
    const profitIncome = value.actual_amount == null ? value.income_amount : value.actual_amount;
    value.gross_profit = Math.round((profitIncome - cost) * 100) / 100;
    value.gross_profit_rate = profitIncome ? value.gross_profit / profitIncome : null;
    return value;
  };
  totals.cost_amount = Math.round(totalCost * 100) / 100;
  applyProfit(totals);// 每日趋势：求和字段逐日合计；转化率按当日加权口径（Σ入店÷Σ曝光等）
  const byDate = new Map();
  records.forEach(row => {
    const item = byDate.get(row.biz_date) || {
      date: row.biz_date, gross_amount: 0, income_amount: 0, order_count: 0,
      impression_users: 0, visit_users: 0, impression_count: 0, ordering_users: 0,
    };
    ['gross_amount', 'income_amount', 'order_count', 'impression_users', 'visit_users', 'impression_count', 'ordering_users'].forEach(key => {
      item[key] += number(row[key]);
    });
    byDate.set(row.biz_date, item);
  });
  const trend = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map(withRate);
  return {
    ok: true,
    days,
    stores_count: byStore.size,
    totals: applyProfit({ ...totals }),
    trend,
    stores: [...byStore.values()].map(withRate).map(applyProfit).sort((a, b) => b.income_amount - a.income_amount),
  };
}

function importMeituanDeliveryWorkbook(db, params, user) {
  // 文件名不足以区分平台：先按门店 ID 判定真实平台，必要时直接转交对应平台的导入器。
  const routed = routeDeliveryPlatform(db, params, user, '美团外卖');
  if (routed) return routed;
  const workbook = readWorkbook(params.data);
  // 美团“订单明细”结算账单（D交易类型 / R商家应收款）→ 真实到账口径
  const billDetail = meituanBillDetailRows(workbook);
  if (billDetail) { assertDeliveryReportKind(params, 'settlement'); return importMeituanDeliveryBillWorkbook(db, billDetail.rows, params, user); }
  const rows = workbook.SheetNames.flatMap(sheetName => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true }));
  if (!rows.length) throw new Error('表格中没有可导入的数据');
  // 美团外卖“门店经营日报”（含曝光/入店/转化等流量指标）→ 单独入库，不覆盖已有营收/账单数据
  const looksLikeOperation = rows.some(row =>
    getValue(row, ['曝光人数', '曝光']) !== undefined
    && getValue(row, ['入店转化率']) !== undefined
    && getValue(row, ['营业收入', '收入']) !== undefined
    && getValue(row, ['门店id', '门店ID', '美团门店id', '美团门店ID']) !== undefined);
  if (looksLikeOperation) { assertDeliveryReportKind(params, 'operating'); return importMeituanOperationWorkbook(db, rows, params, user); }
  if (rows.some(row => getValue(row, ['商品名', '商品名称']) !== undefined && getValue(row, ['商品销量', '销量']) !== undefined)) {
    assertDeliveryReportKind(params, 'products'); return importMeituanDeliveryProductWorkbook(db, rows, params, user);
  }
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '美团外卖', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  const aliases = {
    storeId: ['门店id', '门店ID', '美团门店id', '美团门店ID'],
    storeName: ['门店名称'],
    province: ['省份'],
    city: ['门店所在城市', '城市'],
    district: ['区县市', '区县'],
    actual: ['营业收入'],
    gross: ['营业额', '优惠前总额'],
    orders: ['有效订单'],
  };
  const errors = [];
  const dates = [];
  const matchedStoreIds = new Set();
  let rawImported = 0;
  let imported = 0;
  let unmatched = 0;

  db.run('BEGIN');
  try {
    rows.forEach((row, index) => {
      const meituanStoreId = String(getValue(row, aliases.storeId) || '').trim();
      const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
      if (!meituanStoreId || !bizDate) {
        errors.push(`第 ${index + 2} 行：${!meituanStoreId ? '缺少美团门店 ID' : '日期格式不正确'}`);
        return;
      }
      const sourceStoreName = String(getValue(row, aliases.storeName) || '').trim();
      const gross = number(getValue(row, aliases.gross));
      const actual = number(getValue(row, aliases.actual));
      const discount = Math.max(0, gross - actual);
      const orderCount = number(getValue(row, aliases.orders));
      const store = db.queryOne(`
        SELECT s.id, s.store_name
        FROM store_platforms p
        JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name='美团外卖' AND p.platform_id=?
        LIMIT 1
      `, [meituanStoreId]);
      const matched = !!store;

      db.run(`INSERT INTO meituan_delivery_daily_records
        (batch_id,biz_date,meituan_store_id,source_store_name,source_province,source_city,source_district,gross_amount,actual_amount,discount_amount,order_count,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(meituan_store_id,biz_date) DO UPDATE SET
          batch_id=excluded.batch_id,source_store_name=excluded.source_store_name,source_province=excluded.source_province,
          source_city=excluded.source_city,source_district=excluded.source_district,gross_amount=excluded.gross_amount,
          actual_amount=excluded.actual_amount,discount_amount=excluded.discount_amount,order_count=excluded.order_count,
          store_id=excluded.store_id,store_name=excluded.store_name,match_status=excluded.match_status,updated_at=datetime('now','localtime')`, [
        batchId, bizDate, meituanStoreId, sourceStoreName,
        String(getValue(row, aliases.province) || '').trim(), String(getValue(row, aliases.city) || '').trim(), String(getValue(row, aliases.district) || '').trim(),
        gross, actual, discount, orderCount, store?.id || null, store?.store_name || '', matched ? 'matched' : 'unmatched',
      ]);
      rawImported += 1;
      dates.push(bizDate);
      if (!matched) {
        unmatched += 1;
        if (errors.length < 20) errors.push(`第 ${index + 2} 行：美团门店 ID ${meituanStoreId} 未在“第三方平台 → 美团外卖”中登记，原始数据已保留但未计入分析`);
        return;
      }
      matchedStoreIds.add(store.id);
      // 先保存日报原始数据。循环结束后统一重建平台营收，确保“后导入日报”
      // 不会覆盖此前已导入的结算账单（费用和真实到账）。
      imported += 1;
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  const sortedDates = dates.sort();
  const from = sortedDates[0] || null;
  const to = sortedDates.at(-1) || null;
  let rebuild = { revenueRecords: 0, netTotal: 0, grossTotal: 0, incomeTotal: 0, feeTotal: 0, feeBreakdown: {} };
  if (from && to) {
    db.run('BEGIN');
    try {
      rebuild = rebuildMeituanDeliveryRevenue(db, { from, to, batchId });
      db.run('COMMIT');
    } catch (error) {
      try { db.run('ROLLBACK'); } catch {}
      throw error;
    }
  }
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawImported, from, to, batchId]);
  db.save();
  return {
    batch_id: batchId, data_kind: 'daily_revenue', imported, raw_imported: rawImported,
    unmatched, matched_stores: matchedStoreIds.size, revenue_records: rebuild.revenueRecords,
    gross_total: Math.round(rebuild.grossTotal * 100) / 100,
    delivery_amount_total: Math.round(rebuild.incomeTotal * 100) / 100,
    fee_total: Math.round(rebuild.feeTotal * 100) / 100,
    net_total: Math.round(rebuild.netTotal * 100) / 100,
    skipped: errors.filter(error => error.includes('缺少') || error.includes('日期格式')).length, errors: errors.slice(0, 20),
  };
}

/**
 * 淘宝闪购数据导入（自动识别两种文件格式）：
 *  1) “账单汇总”结算账单（含 账单类型/结算金额）→ importTaobaoFlashBillWorkbook：真实实收（净额）口径
 *  2) 营业额/收入/单量日报（收入/营业额/有效订单）→ 营业额、优惠后收入、订单量口径
 * 两类文件会按门店/日期合并：日报不再被账单覆盖。
 */
function importTaobaoFlashWorkbook(db, params, user) {
  // 京东与淘宝闪购的门店报表文件名完全同款，必须靠表内门店 ID 判定平台，否则京东数据会被写成淘宝闪购。
  const routed = routeDeliveryPlatform(db, params, user, '淘宝闪购');
  if (routed) return routed;
  const workbook = readWorkbook(params.data);
  // 账单模式：优先取名为“账单汇总”的子表；改名/换名时按表头特征（含 账单类型+结算金额）兜底识别。
  // 其余子表（外卖/推广/保障/余额变动等明细）一律不导入，避免误算与报错噪音。
  let billSheet = workbook.SheetNames.map(name => ({ name, sheet: workbook.Sheets[name] })).find(sheet => sheet.name === '账单汇总');
  if (!billSheet) {
    billSheet = workbook.SheetNames.map(name => ({ name, sheet: workbook.Sheets[name] }))
      .find(sheet => {
        const head = XLSX.utils.sheet_to_json(sheet.sheet, { defval: '', raw: true })[0];
        return head && getValue(head, ['账单类型']) !== undefined && getValue(head, ['结算金额']) !== undefined;
      });
  }
  if (billSheet) {
    const billRows = XLSX.utils.sheet_to_json(billSheet.sheet, { defval: '', raw: true });
    if (!billRows.length) throw new Error('“账单汇总”子表为空');
    assertDeliveryReportKind(params, 'settlement');
    return importTaobaoFlashBillWorkbook(db, billRows, params, user);
  }
  const rows = workbook.SheetNames.flatMap(sheetName => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true }));
  if (!rows.length) throw new Error('表格中没有可导入的数据');
  if (rows.some(row => getValue(row, ['曝光人数', '曝光']) !== undefined && getValue(row, ['进店转化率', '入店转化率']) !== undefined && getValue(row, ['收入', '营业收入']) !== undefined)) {
    assertDeliveryReportKind(params, 'operating'); return importDeliveryOperationWorkbook(db, rows, params, user, '淘宝闪购');
  }
  const looksLikeProduct = rows.some(row =>
    getValue(row, ['商品名', '商品名称', '菜品名称']) !== undefined
    && (getValue(row, ['商品销量', '销量']) !== undefined || getValue(row, ['销售额']) !== undefined));
  // 淘宝闪购商品报表只提供每个商品的单日总销量和总销售额；它仍是菜品绑定的唯一来源。
  // 多规格无法唯一反解时由规格人工确认覆盖处理，绝不能因此拒绝商品源数据。
  if (looksLikeProduct) { assertDeliveryReportKind(params, 'products'); return importTaobaoFlashProductWorkbook(db, rows, params, user); }
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '淘宝闪购', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  const aliases = {
    storeId: ['门店编号', '门店id', '门店ID'],
    storeName: ['门店名称'],
    actual: ['收入'],
    gross: ['营业额'],
    productSales: ['商品销售额'],
    orders: ['有效订单'],
  };  
  const errors = [];
  const dates = [];
  const matchedStoreIds = new Set();
  let rawImported = 0;
  let imported = 0;
  let unmatched = 0;
  db.run('BEGIN');
  try {
    rows.forEach((row, index) => {
      const taobaoStoreId = String(getValue(row, aliases.storeId) || '').trim();
      const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
      if (!taobaoStoreId || !bizDate) {
        errors.push(`第 ${index + 2} 行：${!taobaoStoreId ? '缺少门店编号' : '日期格式不正确'}`);
        return;
      }
      const sourceStoreName = String(getValue(row, aliases.storeName) || '').trim();
      const gross = number(getValue(row, aliases.gross));
      const productSales = number(getValue(row, aliases.productSales));
      const actual = number(getValue(row, aliases.actual));
      const orderCount = number(getValue(row, aliases.orders));
      const store = db.queryOne(`
        SELECT s.id, s.store_name
        FROM store_platforms p
        JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name='淘宝闪购' AND p.platform_id=?
        LIMIT 1
      `, [taobaoStoreId]);
      const matched = !!store;
      rawImported += 1;
      dates.push(bizDate);
      db.run(`INSERT INTO taobao_flash_daily_reports
        (batch_id,platform_store_id,source_store_name,biz_date,gross_amount,product_sales_amount,income_amount,order_count,store_id,store_name,match_status,raw_json,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(platform_store_id,biz_date) DO UPDATE SET
          batch_id=excluded.batch_id,source_store_name=excluded.source_store_name,gross_amount=excluded.gross_amount,
          product_sales_amount=excluded.product_sales_amount,
          income_amount=excluded.income_amount,order_count=excluded.order_count,store_id=excluded.store_id,
          store_name=excluded.store_name,match_status=excluded.match_status,raw_json=excluded.raw_json,
          updated_at=datetime('now','localtime')`, [
        batchId, taobaoStoreId, sourceStoreName, bizDate, gross, productSales, actual, orderCount,
        store?.id || null, store?.store_name || '', matched ? 'matched' : 'unmatched', JSON.stringify(row),
      ]);
      if (!matched) {
        unmatched += 1;
        if (errors.length < 20) errors.push(`第 ${index + 2} 行：淘宝闪购门店 ID ${taobaoStoreId}（${sourceStoreName}）未在“第三方平台 → 淘宝闪购”中登记，原始数据已保留但未计入分析`);
        return;
      }
      matchedStoreIds.add(store.id);
      imported += 1;
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  const from = dates.sort()[0] || null;
  const to = dates.sort().at(-1) || null;
  let rebuild = { revenueRecords: 0, netTotal: 0, grossTotal: 0, incomeTotal: 0, feeTotal: 0, feeBreakdown: {} };
  if (from && to) {
    db.run('BEGIN');
    try {
      rebuild = rebuildTaobaoFlashRevenue(db, { from, to, batchId });
      db.run('COMMIT');
    } catch (error) {
      try { db.run('ROLLBACK'); } catch {}
      throw error;
    }
  }
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawImported, from, to, batchId]);
  db.save();
  return { batch_id: batchId, data_kind: 'daily_revenue', imported, raw_imported: rawImported, unmatched, matched_stores: matchedStoreIds.size,
    revenue_records: rebuild.revenueRecords, gross_total: Math.round(rebuild.grossTotal * 100) / 100,
    income_total: Math.round(rebuild.incomeTotal * 100) / 100, net_total: Math.round(rebuild.netTotal * 100) / 100,
    fee_total: Math.round(rebuild.feeTotal * 100) / 100,
    skipped: errors.filter(error => error.includes('缺少') || error.includes('日期格式')).length, errors: errors.slice(0, 20) };
}

/**
 * 淘宝闪购商品销量日报。平台不会返回每笔订单的规格明细，只保留「门店 + 日期 + 商品」聚合行；
 * 后续多规格成本由 business_product_spec_overrides 按日人工确认，或由唯一售价组合自动反解。
 */
function importTaobaoFlashProductWorkbook(db, rows, params, user) {
  const aliases = {
    storeId: ['门店ID', '门店id', '门店编号', '淘宝门店ID', '淘宝门店id'],
    storeName: ['门店名称', '门店'],
    productName: ['商品名', '商品名称', '菜品名称'],
    productId: ['商品ID', '商品id', '菜品ID', '菜品id', '菜品编码', '商品编码', '商品编号', 'SPU ID', '商品SPU'],
    quantity: ['商品销量', '销量', '销售数量'],
    salesAmount: ['商品销售额', '销售额'],
  };
  const singleId = (set) => { const list = [...(set || [])].filter(Boolean); return list.length === 1 ? list[0] : ''; };
  // 商品销量必须以平台导出的真实日明细为准：日期、门店编号、商品名称、销量。
  // 一个工作簿可能同时含“区间汇总”和“逐日明细”工作表；此前根据第一行日期判断，
  // 会误把明细表当成区间累计并虚构日销量。这里逐行识别单日日期，只消费真实日明细。
  const isSingleDay = (value) => {
    if (typeof value === 'number') return Boolean(dateText(value));
    const text = String(value || '').trim().replace(/[./]/g, '-');
    return /^\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.test(text);
  };
  const dailyRows = rows.filter(row => isSingleDay(getValue(row, HEADER_ALIASES.date)));
  if (!dailyRows.length) {
    throw new Error('淘宝闪购商品销量表未发现逐日明细（需包含日期、门店编号、商品名称、商品销量）；区间汇总表不能用于商品销量导入');
  }
  rows = dailyRows;
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '淘宝闪购', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  const errors = [];
  const dates = [];
  const matchedStoreIds = new Set();
  const groupedRows = new Map();
  let rawImported = 0;
  let imported = 0;
  let unmatched = 0;

  rows.forEach((row, index) => {
    const platformStoreId = String(getValue(row, aliases.storeId) || '').trim();
    const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
    const productName = String(getValue(row, aliases.productName) || '').trim();
    if (!platformStoreId || !bizDate || !productName) {
      const reason = !platformStoreId ? '缺少淘宝闪购门店 ID' : !bizDate ? '日期格式不正确' : '缺少商品名称';
      if (errors.length < 20) errors.push(`第 ${index + 2} 行：${reason}`);
      return;
    }
    const key = `${platformStoreId}|${bizDate}|${productName}`;
    const grouped = groupedRows.get(key) || { row, index, quantity: 0, salesAmount: 0, ids: new Set() };
    grouped.quantity += number(getValue(row, aliases.quantity));
    grouped.salesAmount += number(getValue(row, aliases.salesAmount));
    const rawId = String(getValue(row, aliases.productId) || '').trim();
    if (rawId) grouped.ids.add(rawId);
    groupedRows.set(key, grouped);
  });

  // 导出的商品明细代表用户本次选择的门店与完整日期范围。
  // 先按“门店 + 实际起止日期”覆盖旧的平台商品行，才能清掉旧版本曾生成的
  // 区间分摊虚拟行（包括当天没有真实销量、因而不会出现在新文件中的菜品）。
  const storeWindows = new Map();
  groupedRows.forEach(grouped => {
    const platformStoreId = String(getValue(grouped.row, aliases.storeId) || '').trim();
    const bizDate = dateText(getValue(grouped.row, HEADER_ALIASES.date));
    const store = db.queryOne(`
      SELECT s.id, s.store_name FROM store_platforms p
      JOIN stores s ON s.id=p.store_id
      WHERE p.platform_name='淘宝闪购' AND p.platform_id=? LIMIT 1
    `, [platformStoreId]);
    if (!store || !bizDate) return;
    const current = storeWindows.get(store.id) || { from: bizDate, to: bizDate };
    if (bizDate < current.from) current.from = bizDate;
    if (bizDate > current.to) current.to = bizDate;
    storeWindows.set(store.id, current);
  });

  db.run('BEGIN');
  try {
    storeWindows.forEach((window, storeId) => {
      db.run(`DELETE FROM business_product_sales
        WHERE store_id=? AND source_type='platform' AND channel='taobao_flash'
          AND biz_date>=? AND biz_date<=?`, [storeId, window.from, window.to]);
    });
    groupedRows.forEach(grouped => {
      const { row, index } = grouped;
      const platformStoreId = String(getValue(row, aliases.storeId) || '').trim();
      const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
      const productName = String(getValue(row, aliases.productName) || '').trim();
      const sourceStoreName = String(getValue(row, aliases.storeName) || '').trim();
      const store = db.queryOne(`
        SELECT s.id, s.store_name FROM store_platforms p
        JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name='淘宝闪购' AND p.platform_id=? LIMIT 1
      `, [platformStoreId]);
      rawImported += 1;
      dates.push(bizDate);
      if (!store) {
        unmatched += 1;
        if (errors.length < 20) errors.push(`第 ${index + 2} 行：淘宝闪购门店 ID ${platformStoreId}（${sourceStoreName}）未在“第三方平台 → 淘宝闪购”中登记，原始商品记录未计入分析`);
        return;
      }
      matchedStoreIds.add(store.id);
      db.run('DELETE FROM business_product_sales WHERE store_id=? AND biz_date=? AND source_type=? AND channel=? AND product_name=?',
        [store.id, bizDate, 'platform', 'taobao_flash', productName]);
      db.insert(`INSERT INTO business_product_sales
        (batch_id,store_id,store_name,biz_date,source_type,platform,channel,product_name,platform_product_id,quantity,sales_amount)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
        batchId, store.id, store.store_name, bizDate, 'platform', '淘宝闪购', 'taobao_flash', productName, singleId(grouped.ids), grouped.quantity, grouped.salesAmount,
      ]);
      imported += 1;
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawImported, dates.sort()[0] || null, dates.sort().at(-1) || null, batchId]);
  db.save();
  return {
    batch_id: batchId, data_kind: 'product_sales', imported, product_rows: imported, raw_imported: rawImported,
    source_rows: rows.length, unmatched, matched_stores: matchedStoreIds.size,
    skipped: errors.filter(error => error.includes('缺少') || error.includes('日期格式')).length, errors: errors.slice(0, 20),
  };
}

/**
 * 淘宝闪购“区间累计商品销量”导入（如 2026-08-01-2026-08-31 整月累计，无日粒度）。
 * 官方日粒度只有“营业额收入单量”报表的日商品销售额（taobao_flash_daily_reports.product_sales_amount）。
 * 处理口径：以每店区间内「日商品销售额占比」把该店商品的月销量/月销售额分摊到每一天，
 * 店×区间总量严格守恒（月文件为准），日分布形状与官方日商品销售额一致；不虚构官方未提供的逐日商品数据。
 */
function importTaobaoFlashRangeProductWorkbook(db, rows, params, user) {
  const aliases = {
    storeId: ['门店ID', '门店id', '门店编号', '淘宝门店ID', '淘宝门店id'],
    storeName: ['门店名称', '门店'],
    productName: ['商品名', '商品名称', '菜品名称'],
    quantity: ['商品销量', '销量', '销售数量'],
    salesAmount: ['商品销售额', '销售额'],
  };
  const rangeRe = /^(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/;
  const ranges = new Map(); // rangeText -> { from, to, rows: [] }
  const skipZero = (q, s) => Math.abs(number(q)) < 0.000001 && Math.abs(number(s)) < 0.000001;
  rows.forEach(row => {
    const rangeText = String(getValue(row, HEADER_ALIASES.date) || '').trim();
    const productName = String(getValue(row, aliases.productName) || '').trim();
    const platformStoreId = String(getValue(row, aliases.storeId) || '').trim();
    const m = rangeRe.exec(rangeText);
    if (!m || !platformStoreId || !productName) return;
    const qty = number(getValue(row, aliases.quantity));
    const sales = number(getValue(row, aliases.salesAmount));
    if (skipZero(qty, sales)) return; // 0 销量行（平台后台全商品列表）不落库，避免噪音
    const g = ranges.get(rangeText) || { from: m[1], to: m[2], rows: [] };
    g.rows.push({ platformStoreId, productName, quantity: qty, salesAmount: sales });
    ranges.set(rangeText, g);
  });
  const rangeList = [...ranges.values()];
  if (!rangeList.length) throw new Error('表格中没有可导入的有效区间商品销量行（请确认含 日期/门店编号/商品名称/销量/销售额）');
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '淘宝闪购', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  const errors = [];
  const storeCache = new Map(); // platform_store_id -> { id, store_name } | null
  const resolveStore = (platformStoreId) => {
    if (storeCache.has(platformStoreId)) return storeCache.get(platformStoreId);
    const store = db.queryOne(`SELECT s.id, s.store_name FROM store_platforms p
      JOIN stores s ON s.id=p.store_id
      WHERE p.platform_name='淘宝闪购' AND p.platform_id=? LIMIT 1`, [platformStoreId]);
    storeCache.set(platformStoreId, store || null);
    return store || null;
  };
  const round4 = v => Math.round(v * 10000) / 10000;
  const round2 = v => Math.round(v * 100) / 100;
  const toDate = v => String(v).slice(0, 10);
  let imported = 0, dayRows = 0, storeCount = 0;
  const storeIds = new Set();
  const unmatchedStores = new Set();
  db.run('BEGIN');
  try {
    rangeList.forEach(({ from, to, rows: rangeRows }) => {
      // 该区间内每个店的日权重（官方日商品销售额；缺失时回退日营业额）
      const dailies = db.queryAll(`SELECT platform_store_id, biz_date, product_sales_amount, gross_amount
        FROM taobao_flash_daily_reports WHERE biz_date>=? AND biz_date<=? AND match_status='matched'`, [from, to]);
      const dayWeights = new Map(); // platform_store_id -> [{ date, weight }]
      const dayTotal = new Map();   // platform_store_id -> sum(weight)
      dailies.forEach(d => {
        const w = number(d.product_sales_amount) || number(d.gross_amount) || 0;
        if (w <= 0) return;
        const list = dayWeights.get(d.platform_store_id) || [];
        list.push({ date: toDate(d.biz_date), weight: w });
        dayWeights.set(d.platform_store_id, list);
        dayTotal.set(d.platform_store_id, number(dayTotal.get(d.platform_store_id)) + w);
      });
      // 按门店分组商品行
      const byStore = new Map();
      rangeRows.forEach(r => {
        const list = byStore.get(r.platformStoreId) || [];
        list.push(r);
        byStore.set(r.platformStoreId, list);
      });
      byStore.forEach((productRows, platformStoreId) => {
        const weights = dayWeights.get(platformStoreId) || [];
        const totalW = number(dayTotal.get(platformStoreId));
        if (!weights.length || !totalW || !isFinite(totalW)) {
          if (errors.length < 20) errors.push(`门店 ${platformStoreId}（${rangeList.length > 1 ? from + '~' + to : ''}）无日营业额/商品销售额，无法分摊，已跳过`);
          return;
        }
        const store = resolveStore(platformStoreId);
        if (!store) { unmatchedStores.add(platformStoreId); return; }
        storeIds.add(store.id);
        // 覆盖：该店该区间内淘宝闪购渠道商品行全量重建
        db.run(`DELETE FROM business_product_sales WHERE store_id=? AND channel='taobao_flash' AND biz_date>=? AND biz_date<=?`, [store.id, from, to]);
        productRows.forEach(p => {
          if (skipZero(p.quantity, p.salesAmount)) return;
          // 逐日分摊，误差回补到权重最大的一天，保证店×区间总量守恒
          const allocQty = [], allocSales = [];
          let qSum = 0, sSum = 0, maxIdx = 0;
          weights.forEach((w, i) => {
            const ratio = w.weight / totalW;
            allocQty[i] = round4(p.quantity * ratio);
            allocSales[i] = round2(p.salesAmount * ratio);
            qSum += allocQty[i]; sSum += allocSales[i];
            if (w.weight > weights[maxIdx].weight) maxIdx = i;
          });
          allocQty[maxIdx] = round4(allocQty[maxIdx] + (p.quantity - qSum));
          allocSales[maxIdx] = round2(allocSales[maxIdx] + (p.salesAmount - sSum));
          weights.forEach((w, i) => {
            if (Math.abs(allocQty[i]) < 0.00005 && Math.abs(allocSales[i]) < 0.005) return;
            db.insert(`INSERT INTO business_product_sales
              (batch_id,store_id,store_name,biz_date,source_type,platform,channel,product_name,platform_product_id,quantity,sales_amount)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
              batchId, store.id, store.store_name, w.date, 'platform', '淘宝闪购', 'taobao_flash', p.productName, '',
              allocQty[i], allocSales[i],
            ]);
            dayRows += 1;
          });
          imported += 1;
        });
        storeCount += 1;
      });
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  const dates = rangeList.flatMap(r => [r.from, r.to]).sort();
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [imported, dates[0] || null, dates.at(-1) || null, batchId]);
  db.save();
  return {
    batch_id: batchId, data_kind: 'range_product_sales', imported, product_rows: imported, day_rows: dayRows,
    raw_imported: imported, source_rows: rows.length, unmatched: unmatchedStores.size, matched_stores: storeCount,
    range: rangeList.map(r => `${r.from}~${r.to}`).join(','),
    skipped: errors.length, errors: errors.slice(0, 20),
  };
}

/**
 * 淘宝闪购“账单汇总”导入（平台真实到账口径）。
 * 列：A结算入账ID | B门店ID | C门店名称 | D账单日期 | E结算金额 | F结算日期 | G账单类型
 * - 每(门店ID, 账单日, 账单类型)一行入库 taobao_flash_bills；整行 JSON 快照自动收录未来新增列。
 * - 真实实收：每店每日净额 = 当日该店全部账单类型（外卖+推广/保障/余额变动等费用）金额之和。
 *   日报的营业额、优惠后收入、订单量会一并保留；账单只补齐费用与最终到账。
 */
function importTaobaoFlashBillWorkbook(db, rows, params, user) {
  const aliases = {
    accountId: ['结算入账ID', '结算入账id', '结算入账编号', '账户ID'],
    storeId: ['门店ID', '门店id', '门店编号'],
    storeName: ['门店名称', '门店'],
    billDate: ['账单日期', '日期', '营业日期', '业务日期'],
    amount: ['结算金额', '金额'],
    settleDate: ['结算日期'],
    billType: ['账单类型', '费用类型'],
  };
  const firstRow = rows[0] || {};
  const knownHeaders = new Set(Object.values(aliases).flat());
  const extraHeaders = Object.keys(firstRow).filter(key => !knownHeaders.has(key));
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '淘宝闪购', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  const errors = [];
  const dates = new Set();
  const matchedStoreIds = new Set();
  let rawImported = 0;
  let unmatched = 0;

  db.run('BEGIN');
  try {
    rows.forEach((row, index) => {
      const platformStoreId = String(getValue(row, aliases.storeId) || '').trim();
      const billDate = dateText(getValue(row, aliases.billDate));
      const billType = String(getValue(row, aliases.billType) || '').trim();
      const amount = number(getValue(row, aliases.amount));
      if (!platformStoreId || !billDate || !billType) {
        errors.push(`第 ${index + 2} 行：${!platformStoreId ? '缺少门店ID' : !billDate ? '账单日期格式不正确' : '缺少账单类型'}（原始行已跳过）`);
        return;
      }
      const accountId = String(getValue(row, aliases.accountId) || '').trim();
      const sourceStoreName = String(getValue(row, aliases.storeName) || '').trim();
      const settleDate = dateText(getValue(row, aliases.settleDate));
      const rawJson = JSON.stringify(row); // 整行快照：未来新增列自动收录，不丢失
      const store = db.queryOne(`
        SELECT s.id, s.store_name
        FROM store_platforms p
        JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name='淘宝闪购' AND p.platform_id=?
        LIMIT 1
      `, [platformStoreId]);
      const matched = !!store;
      db.run(`INSERT INTO taobao_flash_bills
        (batch_id,account_id,platform_store_id,source_store_name,bill_date,amount,settle_date,bill_type,raw_json,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(platform_store_id,bill_date,bill_type) DO UPDATE SET
          batch_id=excluded.batch_id,account_id=excluded.account_id,source_store_name=excluded.source_store_name,
          amount=excluded.amount,settle_date=excluded.settle_date,raw_json=excluded.raw_json,
          store_id=excluded.store_id,store_name=excluded.store_name,match_status=excluded.match_status,
          updated_at=datetime('now','localtime')`, [
        batchId, accountId, platformStoreId, sourceStoreName, billDate, amount, settleDate, billType, rawJson,
        store?.id || null, store?.store_name || '', matched ? 'matched' : 'unmatched',
      ]);
      rawImported += 1;
      dates.add(billDate);
      if (!matched) {
        unmatched += 1;
        if (errors.length < 20) errors.push(`第 ${index + 2} 行：淘宝闪购门店 ID ${platformStoreId}（${sourceStoreName}）未在“第三方平台 → 淘宝闪购”中登记，原始账单已保留但未计入真实实收`);
        return;
      }
      matchedStoreIds.add(store.id);
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }

  // —— 按账单重建平台净额（每店每日实收 = 当日全部账单类型金额之和）——
  const dateArr = [...dates].sort();
  const from = dateArr[0] || null;
  const to = dateArr.at(-1) || null;
  let rebuild = { revenueRecords: 0, netTotal: 0, grossTotal: 0, incomeTotal: 0, feeTotal: 0, feeBreakdown: {} };
  if (from && to) {
    db.run('BEGIN');
    try {
      rebuild = rebuildTaobaoFlashRevenue(db, { from, to, batchId });
      db.run('COMMIT');
    } catch (error) {
      try { db.run('ROLLBACK'); } catch {}
      throw error;
    }
  }
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawImported, from, to, batchId]);
  db.save();
  return {
    batch_id: batchId, data_kind: 'settlement_bills', imported: rawImported, raw_imported: rawImported,
    unmatched, matched_stores: matchedStoreIds.size,
    revenue_records: rebuild.revenueRecords,
    net_total: Math.round(rebuild.netTotal * 100) / 100,
    gross_total: Math.round(rebuild.grossTotal * 100) / 100,
    delivery_amount_total: Math.round(rebuild.incomeTotal * 100) / 100,
    fee_total: Math.round(rebuild.feeTotal * 100) / 100,
    fee_breakdown: Object.fromEntries(Object.entries(rebuild.feeBreakdown).map(([key, value]) => [key, Math.round(value * 100) / 100])),
    extra_headers: extraHeaders,
    skipped: errors.filter(error => error.includes('缺少') || error.includes('格式')).length,
    errors: errors.slice(0, 20),
  };
}

function importMeituanDeliveryProductWorkbook(db, rows, params, user) {
  const aliases = {
    storeId: ['门店id', '门店ID', '美团门店id', '美团门店ID'],
    storeName: ['门店名称'],
    city: ['门店所在城市', '城市'],
    productName: ['商品名', '商品名称', '菜品名称'],
    productId: ['商品ID', '商品id', '菜品ID', '菜品id', '菜品编码', '商品编码', '商品编号'],
    quantity: ['商品销量', '销量', '销售数量'],
    salesAmount: ['商品销售额', '销售额'],
  };
  const singleId = (set) => { const list = [...(set || [])].filter(Boolean); return list.length === 1 ? list[0] : ''; };
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '美团外卖', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  const errors = [];
  const dates = [];
  const matchedStoreIds = new Set();
  let rawImported = 0;
  let imported = 0;
  let unmatched = 0;
  const groupedRows = new Map();
  rows.forEach((row, index) => {
    const meituanStoreId = String(getValue(row, aliases.storeId) || '').trim();
    const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
    const productName = String(getValue(row, aliases.productName) || '').trim();
    if (!meituanStoreId || !bizDate || !productName) {
      const reason = !meituanStoreId ? '缺少美团门店 ID' : !bizDate ? '日期格式不正确' : '缺少商品名称';
      errors.push(`第 ${index + 2} 行：${reason}`);
      return;
    }
    const key = `${meituanStoreId}|${bizDate}|${productName}`;
    const grouped = groupedRows.get(key) || { row, index, quantity: 0, salesAmount: 0, ids: new Set() };
    grouped.quantity += number(getValue(row, aliases.quantity));
    grouped.salesAmount += number(getValue(row, aliases.salesAmount));
    const rawId = String(getValue(row, aliases.productId) || '').trim();
    if (rawId) grouped.ids.add(rawId);
    groupedRows.set(key, grouped);
  });

  db.run('BEGIN');
  try {
    groupedRows.forEach(grouped => {
      const { row, index } = grouped;
      const meituanStoreId = String(getValue(row, aliases.storeId) || '').trim();
      const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
      const productName = String(getValue(row, aliases.productName) || '').trim();
      if (!meituanStoreId || !bizDate || !productName) {
        const reason = !meituanStoreId ? '缺少美团门店 ID' : !bizDate ? '日期格式不正确' : '缺少商品名称';
        errors.push(`第 ${index + 2} 行：${reason}`);
        return;
      }
      const store = db.queryOne(`
        SELECT s.id, s.store_name
        FROM store_platforms p
        JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name='美团外卖' AND p.platform_id=?
        LIMIT 1
      `, [meituanStoreId]);
      const quantity = grouped.quantity;
      const salesAmount = grouped.salesAmount;
      const productId = singleId(grouped.ids);
      const sourceStoreName = String(getValue(row, aliases.storeName) || '').trim();
      const sourceCity = String(getValue(row, aliases.city) || '').trim();
      const matched = !!store;

      db.run(`INSERT INTO meituan_delivery_product_records
        (batch_id,biz_date,meituan_store_id,source_store_name,source_city,product_name,platform_product_id,quantity,sales_amount,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(meituan_store_id,biz_date,product_name) DO UPDATE SET
          batch_id=excluded.batch_id,source_store_name=excluded.source_store_name,source_city=excluded.source_city,
          platform_product_id=excluded.platform_product_id,
          quantity=excluded.quantity,sales_amount=excluded.sales_amount,store_id=excluded.store_id,store_name=excluded.store_name,
          match_status=excluded.match_status,updated_at=datetime('now','localtime')`, [
        batchId, bizDate, meituanStoreId, sourceStoreName, sourceCity, productName, productId, quantity, salesAmount,
        store?.id || null, store?.store_name || '', matched ? 'matched' : 'unmatched',
      ]);
      rawImported += 1;
      dates.push(bizDate);
      if (!matched) {
        unmatched += 1;
        if (errors.length < 20) errors.push(`第 ${index + 2} 行：美团门店 ID ${meituanStoreId} 未在“第三方平台 → 美团外卖”中登记，原始商品记录已保留但未计入分析`);
        return;
      }
      matchedStoreIds.add(store.id);
      db.run('DELETE FROM business_product_sales WHERE store_id=? AND biz_date=? AND source_type=? AND channel=? AND product_name=?',
        [store.id, bizDate, 'platform', 'meituan_delivery', productName]);
      db.insert(`INSERT INTO business_product_sales
        (batch_id,store_id,store_name,biz_date,source_type,platform,channel,product_name,platform_product_id,quantity,sales_amount)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
        batchId, store.id, store.store_name, bizDate, 'platform', '美团外卖', 'meituan_delivery', productName, productId, quantity, salesAmount,
      ]);
      imported += 1;
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawImported, dates.sort()[0] || null, dates.sort().at(-1) || null, batchId]);
  db.save();
  return {
    batch_id: batchId, data_kind: 'product_sales', imported, product_rows: imported, raw_imported: rawImported,
    source_rows: rows.length, unmatched, matched_stores: matchedStoreIds.size,
    skipped: errors.filter(error => error.includes('缺少') || error.includes('日期格式')).length, errors: errors.slice(0, 20),
  };
}

/**
 * 京东外卖原始报表导入：自动区分“营业额收入单量”和“商品销量”。
 * 两类报表均只按「第三方平台 → 京东外卖」的门店 ID 关联，未匹配的原始行会留存待补档案。
 */
function importJdDeliveryWorkbook(db, params, user) {
  // 同上：交由门店 ID 判定平台，避免京东报表被送进淘宝闪购导入器。
  const routed = routeDeliveryPlatform(db, params, user, '京东外卖');
  if (routed) return routed;
  const workbook = readWorkbook(params.data);
  // 部分京东导出会保留合并的第一行分组表头；当字段名位于第二行时按固定业务列兜底，
  // 避免被 sheet_to_json 当成普通日报而跳过。
  let settlementDetail = jdSettlementDetailRows(workbook);
  if (!settlementDetail) {
    for (const sheetName of workbook.SheetNames) {
      const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
      const header = grid[1] || [];
      if (String(header[2] || '').trim() !== '门店编号' || String(header[12] || '').trim() !== '订单完成/退款完成时间' || String(header[23] || '').trim() !== '应结金额') continue;
      const rows = grid.slice(2).map(row => ({
        京东门店ID: String(row[2] || '').trim(), 门店名称: String(row[3] || '').trim(),
        完成日期: dateText(row[12]), 实际收入: number(row[23]),
      })).filter(row => row.京东门店ID && row.完成日期);
      if (rows.length) { settlementDetail = { sheet_name: sheetName, rows }; break; }
    }
  }
  if (settlementDetail) { assertDeliveryReportKind(params, 'settlement'); return importJdSettlementDetailWorkbook(db, settlementDetail.rows, params, user); }
  const rows = workbook.SheetNames.flatMap(sheetName => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true }));
  if (!rows.length) throw new Error('表格中没有可导入的数据');
  if (rows.some(row => getValue(row, ['曝光人数', '曝光']) !== undefined && getValue(row, ['入店转化率', '进店转化率']) !== undefined && getValue(row, ['收入', '营业收入']) !== undefined)) {
    assertDeliveryReportKind(params, 'operating'); return importDeliveryOperationWorkbook(db, rows, params, user, '京东外卖');
  }
  if (rows.some(row => getValue(row, ['商品名', '商品名称']) !== undefined && getValue(row, ['商品销量', '销量']) !== undefined)) {
    assertDeliveryReportKind(params, 'products'); return importJdDeliveryProductWorkbook(db, rows, params, user);
  }
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '京东外卖', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  const aliases = {
    storeId: ['门店id', '门店ID', '京东门店id', '京东门店ID'],
    storeName: ['门店名称'],
    city: ['城市', '门店所在城市'],
    actual: ['收入', '营业收入'],
    gross: ['营业额', '优惠前总额'],
    orders: ['有效订单'],
  };
  const errors = [];
  const dates = [];
  const matchedStoreIds = new Set();
  let rawImported = 0;
  let imported = 0;
  let unmatched = 0;

  db.run('BEGIN');
  try {
    rows.forEach((row, index) => {
      const jdStoreId = String(getValue(row, aliases.storeId) || '').trim();
      const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
      if (!jdStoreId || !bizDate) {
        errors.push(`第 ${index + 2} 行：${!jdStoreId ? '缺少京东门店 ID' : '日期格式不正确'}`);
        return;
      }
      const sourceStoreName = String(getValue(row, aliases.storeName) || '').trim();
      const gross = number(getValue(row, aliases.gross));
      const actual = number(getValue(row, aliases.actual));
      const discount = Math.max(0, gross - actual);
      const orderCount = number(getValue(row, aliases.orders));
      const store = db.queryOne(`
        SELECT s.id, s.store_name
        FROM store_platforms p
        JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name='京东外卖' AND p.platform_id=?
        LIMIT 1
      `, [jdStoreId]);
      const matched = !!store;

      db.run(`INSERT INTO jd_delivery_daily_records
        (batch_id,biz_date,jd_store_id,source_store_name,source_city,gross_amount,actual_amount,discount_amount,order_count,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(jd_store_id,biz_date) DO UPDATE SET
          batch_id=excluded.batch_id,source_store_name=excluded.source_store_name,source_city=excluded.source_city,
          gross_amount=excluded.gross_amount,actual_amount=excluded.actual_amount,discount_amount=excluded.discount_amount,
          order_count=excluded.order_count,store_id=excluded.store_id,store_name=excluded.store_name,
          match_status=excluded.match_status,updated_at=datetime('now','localtime')`, [
        batchId, bizDate, jdStoreId, sourceStoreName, String(getValue(row, aliases.city) || '').trim(),
        gross, actual, discount, orderCount, store?.id || null, store?.store_name || '', matched ? 'matched' : 'unmatched',
      ]);
      rawImported += 1;
      dates.push(bizDate);
      if (!matched) {
        unmatched += 1;
        if (errors.length < 20) errors.push(`第 ${index + 2} 行：京东门店 ID ${jdStoreId}（${sourceStoreName}）未在“第三方平台 → 京东外卖”中登记，原始数据已保留但未计入分析`);
        return;
      }
      matchedStoreIds.add(store.id);
      replaceRevenue(db, {
        batch_id: batchId, store_id: store.id, store_name: store.store_name, biz_date: bizDate,
        source_type: 'platform', platform: '京东外卖', channel_group: 'delivery', channel: 'jd_delivery',
        // 京东当前仅导入营业日报：收入先作为优惠后收入与当前到账，待导入结算账单后再拆出平台费用。
        gross_amount: gross, platform_income_amount: actual, actual_amount: actual, discount_amount: discount, order_count: orderCount,
      });
      imported += 1;
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawImported, dates.sort()[0] || null, dates.sort().at(-1) || null, batchId]);
  db.save();
  return { batch_id: batchId, data_kind: 'daily_revenue', imported, raw_imported: rawImported, unmatched, matched_stores: matchedStoreIds.size, skipped: errors.filter(error => error.includes('缺少') || error.includes('日期格式')).length, errors: errors.slice(0, 20) };
}

function importJdDeliveryProductWorkbook(db, rows, params, user) {
  const aliases = {
    storeId: ['门店id', '门店ID', '京东门店id', '京东门店ID'],
    storeName: ['门店名称'],
    city: ['城市', '门店所在城市'],
    productName: ['商品名', '商品名称', '菜品名称'],
    productId: ['商品ID', '商品id', '菜品ID', '菜品id', '菜品编码', '商品编码', '商品编号'],
    quantity: ['商品销量', '销量', '销售数量'],
    salesAmount: ['商品销售额', '销售额'],
  };
  const singleId = (set) => { const list = [...(set || [])].filter(Boolean); return list.length === 1 ? list[0] : ''; };
  const batchId = db.insert(`INSERT INTO business_import_batches (source_type,platform,file_name,row_count,imported_by,imported_by_name) VALUES (?,?,?,?,?,?)`, [
    'platform', '京东外卖', params.file_name || '', 0, user?.id || null,
    user?.display_name || user?.username || '',
  ]);
  const errors = [];
  const dates = [];
  const matchedStoreIds = new Set();
  const groupedRows = new Map();
  let rawImported = 0;
  let imported = 0;
  let unmatched = 0;

  rows.forEach((row, index) => {
    const jdStoreId = String(getValue(row, aliases.storeId) || '').trim();
    const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
    const productName = String(getValue(row, aliases.productName) || '').trim();
    if (!jdStoreId || !bizDate || !productName) {
      const reason = !jdStoreId ? '缺少京东门店 ID' : !bizDate ? '日期格式不正确' : '缺少商品名称';
      errors.push(`第 ${index + 2} 行：${reason}`);
      return;
    }
    const key = `${jdStoreId}|${bizDate}|${productName}`;
    const grouped = groupedRows.get(key) || { row, index, quantity: 0, salesAmount: 0, ids: new Set() };
    grouped.quantity += number(getValue(row, aliases.quantity));
    grouped.salesAmount += number(getValue(row, aliases.salesAmount));
    const rawId = String(getValue(row, aliases.productId) || '').trim();
    if (rawId) grouped.ids.add(rawId);
    groupedRows.set(key, grouped);
  });

  db.run('BEGIN');
  try {
    groupedRows.forEach(grouped => {
      const { row, index } = grouped;
      const jdStoreId = String(getValue(row, aliases.storeId) || '').trim();
      const bizDate = dateText(getValue(row, HEADER_ALIASES.date));
      const productName = String(getValue(row, aliases.productName) || '').trim();
      const store = db.queryOne(`
        SELECT s.id, s.store_name
        FROM store_platforms p
        JOIN stores s ON s.id=p.store_id
        WHERE p.platform_name='京东外卖' AND p.platform_id=?
        LIMIT 1
      `, [jdStoreId]);
      const sourceStoreName = String(getValue(row, aliases.storeName) || '').trim();
      const sourceCity = String(getValue(row, aliases.city) || '').trim();
      const matched = !!store;
      const productId = singleId(grouped.ids);
      db.run(`INSERT INTO jd_delivery_product_records
        (batch_id,biz_date,jd_store_id,source_store_name,source_city,product_name,platform_product_id,quantity,sales_amount,store_id,store_name,match_status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
        ON CONFLICT(jd_store_id,biz_date,product_name) DO UPDATE SET
          batch_id=excluded.batch_id,source_store_name=excluded.source_store_name,source_city=excluded.source_city,
          platform_product_id=excluded.platform_product_id,
          quantity=excluded.quantity,sales_amount=excluded.sales_amount,store_id=excluded.store_id,store_name=excluded.store_name,
          match_status=excluded.match_status,updated_at=datetime('now','localtime')`, [
        batchId, bizDate, jdStoreId, sourceStoreName, sourceCity, productName, productId, grouped.quantity, grouped.salesAmount,
        store?.id || null, store?.store_name || '', matched ? 'matched' : 'unmatched',
      ]);
      rawImported += 1;
      dates.push(bizDate);
      if (!matched) {
        unmatched += 1;
        if (errors.length < 20) errors.push(`第 ${index + 2} 行：京东门店 ID ${jdStoreId}（${sourceStoreName}）未在“第三方平台 → 京东外卖”中登记，原始商品记录已保留但未计入分析`);
        return;
      }
      matchedStoreIds.add(store.id);
      db.run('DELETE FROM business_product_sales WHERE store_id=? AND biz_date=? AND source_type=? AND channel=? AND product_name=?',
        [store.id, bizDate, 'platform', 'jd_delivery', productName]);
      db.insert(`INSERT INTO business_product_sales
        (batch_id,store_id,store_name,biz_date,source_type,platform,channel,product_name,platform_product_id,quantity,sales_amount)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
        batchId, store.id, store.store_name, bizDate, 'platform', '京东外卖', 'jd_delivery', productName, productId, grouped.quantity, grouped.salesAmount,
      ]);
      imported += 1;
    });
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
  db.run('UPDATE business_import_batches SET row_count=?,date_from=?,date_to=? WHERE id=?', [rawImported, dates.sort()[0] || null, dates.sort().at(-1) || null, batchId]);
  db.save();
  return {
    batch_id: batchId, data_kind: 'product_sales', imported, product_rows: imported, raw_imported: rawImported,
    source_rows: rows.length, unmatched, matched_stores: matchedStoreIds.size,
    skipped: errors.filter(error => error.includes('缺少') || error.includes('日期格式')).length, errors: errors.slice(0, 20),
  };
}

let meituanGroupCompositionSynced = false;

function syncGroupBuyPosFromCompositions(db) {
  const meituanRows = db.queryAll(`
    SELECT store_id, MAX(store_name) AS store_name, biz_date, SUM(amount) AS recorded_amount
    FROM business_revenue_compositions
    WHERE category IN ('美团/大众点评团购', '美团/大众点评支付')
    GROUP BY store_id, biz_date
  `);
  meituanRows.forEach(row => replaceMeituanGroupPosRevenue(db, {
    storeId: row.store_id, storeName: row.store_name, bizDate: row.biz_date,
    amount: number(row.recorded_amount),
  }));
  const douyinRows = db.queryAll(`
    SELECT store_id, MAX(store_name) AS store_name, biz_date, SUM(amount) AS recorded_amount
    FROM business_revenue_compositions
    WHERE category='抖音团购'
    GROUP BY store_id, biz_date
  `);
  douyinRows.forEach(row => replaceDouyinGroupPosRevenue(db, {
    storeId: row.store_id, storeName: row.store_name, bizDate: row.biz_date,
    amount: number(row.recorded_amount),
  }));
  if (meituanRows.length || douyinRows.length) db.save();
  return meituanRows.length + douyinRows.length;
}

function ensureLegacyRecords(db) {
  // 历史经营日报已将团购两列写入收入构成，需要只回填一次核对记录。
  // 此步骤不能放在“已有 pos 记录”的早退之后，否则新旧来源混用时永远不会回填。
  if (!meituanGroupCompositionSynced) {
    syncGroupBuyPosFromCompositions(db);
    meituanGroupCompositionSynced = true;
  }
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

// 平台费用的看板明细优先使用上传账单中的原始“交易类型/账单类型”。
// 聚合字段（推广费、服务费等）只用于计算与无原始账单时的兼容展示，不能替换用户上传的字段名。
function getRawPlatformFeeBreakdown(db, params = {}) {
  const selectedPlatform = String(params.platform || '').trim();
  const sources = [
    { platform: '美团外卖', table: 'meituan_delivery_bills', typeField: 'bill_type', dateField: 'bill_date', classify: meituanBillCategory },
    { platform: '淘宝闪购', table: 'taobao_flash_bills', typeField: 'bill_type', dateField: 'bill_date', classify: taobaoBillCategory },
    { platform: '京东外卖', table: 'jd_delivery_bills', typeField: 'bill_type', dateField: 'bill_date', classify: jdBillCategory },
  ].filter(source => !selectedPlatform || source.platform === selectedPlatform);
  const requestedStoreIds = Array.isArray(params.store_ids) ? params.store_ids : String(params.store_ids || '').split(',');
  const storeIds = requestedStoreIds.map(Number).filter(id => Number.isInteger(id) && id > 0);
  const result = [];
  // 美团团购收益明细的 U–AO 不是账单类型，而是一组固定费用字段；保留原字段名以便看板追溯。
  if (!selectedPlatform || selectedPlatform === '美团团购') {
    const clauses = ["match_status='matched'"];
    const values = [];
    if (storeIds.length) {
      clauses.push(`store_id IN (${storeIds.map(() => '?').join(',')})`);
      values.push(...storeIds);
    } else if (params.store_id) {
      clauses.push('store_id=?');
      values.push(Number(params.store_id));
    }
    if (params.date_from) { clauses.push('income_date>=?'); values.push(params.date_from); }
    if (params.date_to) { clauses.push('income_date<=?'); values.push(params.date_to); }
    const rawRows = db.queryAll(`SELECT fee_breakdown_json FROM meituan_group_buy_benefit_records WHERE ${clauses.join(' AND ')}`, values);
    const fees = new Map();
    rawRows.forEach(row => {
      let detail = {};
      try { detail = JSON.parse(row.fee_breakdown_json || '{}').raw || {}; } catch {}
      Object.entries(detail).forEach(([name, value]) => fees.set(name, number(fees.get(name)) + number(value)));
    });
    fees.forEach((amount, label) => {
      if (Math.abs(amount) > 0.000001) result.push({ key: `美团团购:${label}`, label, amount, platform: '美团团购' });
    });
  }
  // 抖音团购 X:BI 的原始费用字段：到手金额 BK 已是最终结算，不将此处明细再次扣减。
  if (!selectedPlatform || selectedPlatform === '抖音团购') {
    const clauses = ["match_status='matched'"], values = [];
    if (storeIds.length) { clauses.push(`store_id IN (${storeIds.map(() => '?').join(',')})`); values.push(...storeIds); }
    else if (params.store_id) { clauses.push('store_id=?'); values.push(Number(params.store_id)); }
    if (params.date_from) { clauses.push('income_date>=?'); values.push(params.date_from); }
    if (params.date_to) { clauses.push('income_date<=?'); values.push(params.date_to); }
    const fees = new Map();
    db.queryAll(`SELECT fee_breakdown_json FROM douyin_group_buy_settlement_records WHERE ${clauses.join(' AND ')}`, values).forEach(row => {
      let raw = {}; try { raw = JSON.parse(row.fee_breakdown_json || '{}').raw || {}; } catch {}
      Object.entries(raw).forEach(([name, amount]) => fees.set(name, number(fees.get(name)) + number(amount)));
    });
    fees.forEach((amount, label) => { if (Math.abs(amount) > 0.000001) result.push({ key: `抖音团购:${label}`, label, amount: -amount, platform: '抖音团购' }); });
  }
  sources.forEach(source => {
    const clauses = ["b.match_status='matched'"];
    const values = [];
    if (storeIds.length) {
      clauses.push(`b.store_id IN (${storeIds.map(() => '?').join(',')})`);
      values.push(...storeIds);
    } else if (params.store_id) {
      clauses.push('b.store_id=?');
      values.push(Number(params.store_id));
    }
    if (params.date_from) { clauses.push(`b.${source.dateField}>=?`); values.push(params.date_from); }
    if (params.date_to) { clauses.push(`b.${source.dateField}<=?`); values.push(params.date_to); }
    const rows = db.queryAll(`SELECT b.${source.typeField} AS bill_type, SUM(b.amount) AS amount
      FROM ${source.table} b WHERE ${clauses.join(' AND ')}
      GROUP BY b.${source.typeField} ORDER BY SUM(b.amount) ASC`, values);
    rows.forEach(row => {
      const billType = String(row.bill_type || '').trim();
      if (!billType || source.classify(billType) === 'revenue') return;
      // 原账单中负数代表扣款，因此转换成“费用正数、冲销/退款负数”，与 totals.fees 一致。
      result.push({
        key: `${source.platform}:${billType}`,
        label: sources.length > 1 ? `${source.platform} · ${billType}` : billType,
        amount: -number(row.amount),
        platform: source.platform,
      });
    });
  });
  return result.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

function periodExpr(period, field = 'biz_date') {
  if (period === 'month') return `substr(${field},1,7)`;
  if (period === 'week') return `strftime('%Y-W%W',${field})`;
  return field;
}

// 可由用户独立切换来源的第三方渠道。线下店内和自提始终来自收银机。
// 收银综合报表中的美团团购是“营业收入构成”的付款字段，已包含在店内/外卖渠道汇总中；
// 收银机总览不把它再作为第六个渠道累计。真实第三方视角才可用平台团购记录替换该部分。
const SOURCE_CONTROLLABLE_CHANNELS = new Set(['meituan_delivery', 'taobao_flash', 'jd_delivery', 'douyin_group', 'meituan_group']);
const EMBEDDED_GROUP_CHANNELS = new Set(['douyin_group', 'meituan_group']);

function parseSourceOverrides(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function resolveSourcePolicy(params = {}) {
  const dataView = String(params.data_view || params.dataView || 'real') === 'cashier' ? 'cashier' : 'real';
  const overrides = parseSourceOverrides(params.source_overrides || params.sourceOverrides);
  const sourceFor = channel => {
    // 收银机视角必须始终使用收银机记录，不能被“平台来源”个别配置覆盖。
    // 团购收银记录已包含在店内销售中，后续会按嵌入规则剔除单列项以避免重复计入。
    if (!SOURCE_CONTROLLABLE_CHANNELS.has(channel)) return 'pos';
    if (dataView === 'cashier') return 'pos';
    const chosen = overrides[channel];
    if (chosen === 'pos' || chosen === 'platform') return chosen;
    return 'platform';
  };
  return { data_view: dataView, overrides, sourceFor };
}

function resolveRevenueRecords(rawRecords, params = {}) {
  const platformKeys = new Set(rawRecords.filter(row => row.source_type === 'platform')
    .map(row => `${row.store_id}|${row.biz_date}|${row.channel}`));
  const records = String(params.require_platform_record || '') === '1'
    ? rawRecords.filter(row => row.source_type === 'platform' || platformKeys.has(`${row.store_id}|${row.biz_date}|${row.channel}`))
    : rawRecords;
  const grouped = new Map();
  records.forEach(row => {
    const key = `${row.store_id}|${row.biz_date}|${row.channel}`;
    const item = grouped.get(key) || {
      store_id: row.store_id, store_name: row.store_name, biz_date: row.biz_date,
      channel: row.channel, channel_group: row.channel_group, recorded: 0, actual: 0,
      pos_gross: 0, pos_discount: 0, pos_orders: 0,
      platform_gross: 0, platform_income: 0, platform_discount: 0, platform_orders: 0,
      fees: 0, service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0,
      has_pos: false, has_platform: false,
    };
    if (row.source_type === 'pos') {
      item.has_pos = true;
      item.recorded += number(row.recorded_amount);
      item.pos_gross += number(row.gross_amount);
      item.pos_discount += number(row.discount_amount);
      item.pos_orders += number(row.order_count);
    } else {
      item.actual += number(row.actual_amount);
      item.platform_gross += number(row.gross_amount);
      item.platform_income += number(row.platform_income_amount);
      item.platform_discount += number(row.discount_amount);
      item.platform_orders += number(row.order_count);
      item.service_fee += number(row.service_fee);
      item.insurance_fee += number(row.insurance_fee);
      item.promotion_fee += number(row.promotion_fee);
      item.refund_amount += number(row.refund_amount);
      item.fees = item.service_fee + item.insurance_fee + item.promotion_fee + item.refund_amount;
      item.has_platform = true;
    }
    grouped.set(key, item);
  });
  const policy = resolveSourcePolicy(params);
  const rows = [...grouped.values()].map(item => {
    const requestedSource = policy.sourceFor(item.channel);
    const usePlatform = requestedSource === 'platform' && item.has_platform;
    const platformIncome = item.platform_income || item.actual;
    const gross = usePlatform ? item.platform_gross : item.pos_gross;
    const income = usePlatform ? platformIncome : item.recorded;
    const settled = usePlatform ? item.actual : item.recorded;
    return {
      ...item, gross, income, settled,
      discount: usePlatform ? item.platform_discount : item.pos_discount,
      orders: usePlatform && item.platform_orders ? item.platform_orders : item.pos_orders,
      source_used: usePlatform ? 'platform' : 'pos',
      source_status: requestedSource === 'platform' && !item.has_platform ? 'platform_missing_fallback_pos' : (usePlatform ? 'platform_confirmed' : 'pos_selected'),
      resolved_fees: usePlatform ? item.fees : 0,
      resolved_service_fee: usePlatform ? item.service_fee : 0,
      resolved_insurance_fee: usePlatform ? item.insurance_fee : 0,
      resolved_promotion_fee: usePlatform ? item.promotion_fee : 0,
      resolved_refund_amount: usePlatform ? item.refund_amount : 0,
      confirmed: settled,
      // 双向核对以收银记录为基准：平台到账低于收银记录时应为负数。
      difference: item.has_platform ? item.actual - item.recorded : null,
      difference_rate: item.has_platform && item.recorded ? (item.actual - item.recorded) / item.recorded : null,
      channel_label: CHANNELS[item.channel]?.label || item.channel,
    };
  });
  // 同一渠道在两个视角中始终保留：收银机视角读取收银字段，真实第三方视角读取平台字段。
  // 总额仅为当前视角渠道字段的自然汇总，绝不为了对齐而抵消或强制相等。
  const byStoreDay = new Map();
  rows.forEach(row => {
    const key = `${row.store_id}|${row.biz_date}`;
    if (!byStoreDay.has(key)) byStoreDay.set(key, []);
    byStoreDay.get(key).push(row);
  });
  byStoreDay.forEach(dayRows => {
    const instore = dayRows.find(row => row.channel === 'store_sales');
    dayRows.filter(row => EMBEDDED_GROUP_CHANNELS.has(row.channel)).forEach(groupRow => {
      if (policy.data_view === 'cashier') {
        // 收银机总览方案 1 只展示店内、自提、美团外卖、淘宝闪购、京东秒送；
        // 团购支付保留在“营业收入构成”（方案 2）中，不重复计入渠道合计。
        groupRow.exclude_from_sales = true;
        return;
      }
      if (!instore) return;
      // 团购在收银机报表中已包含于“店内销售”。真实视角不能简单扣除团购，
      // 而应以平台实采值替换收银机团购部分：
      // 店内销售（真实）= 店内销售（收银机）- 团购（收银机）+ 团购（平台）。
      // 平台记录缺失时 groupRow 会回退为收银机值，因此增量为 0，不会误减店内销售。
      instore.gross += groupRow.gross - groupRow.pos_gross;
      instore.income += groupRow.income - groupRow.recorded;
      instore.settled += groupRow.settled - groupRow.recorded;
      instore.confirmed += groupRow.confirmed - groupRow.recorded;
      instore.discount += groupRow.discount - groupRow.pos_discount;
      instore.orders += groupRow.orders - groupRow.pos_orders;
      // 总数据主表的字段固定为店内、自提和三个外卖渠道。
      // 团购真实数据仅用于从店内销售剔除，在团购专属视图中才单列展示。
      if (String(params.channel_group || '') !== 'group_buy') groupRow.exclude_from_sales = true;
    });
  });
  return { rows, policy };
}

function getResolvedRevenueByDate(db, params = {}) {
  ensureLegacyRecords(db);
  const where = rangeWhere(params);
  const rawRecords = db.queryAll(`SELECT r.* FROM business_revenue_records r WHERE ${where.sql}`, where.values);
  // 美团外卖的平台运营日报与结算账单分表导入：运营日报决定营业额/优惠后收入/订单量，
  // 结算账单决定实际到账和费用。总数据视角必须按同一店日合并两者，不能只读取账单。
  const meituanOperationRows = db.queryAll(`
    SELECT store_id, biz_date, gross_amount, income_amount, order_count
    FROM meituan_delivery_operation_records
    WHERE match_status='matched' AND biz_date>=? AND biz_date<=?
  `, [params.date_from || '', params.date_to || '']);
  const meituanOperationByKey = new Map(meituanOperationRows.map(row => [`${row.store_id}|${row.biz_date}`, row]));
  rawRecords.forEach(row => {
    if (row.source_type !== 'platform' || row.channel !== 'meituan_delivery') return;
    const operation = meituanOperationByKey.get(`${row.store_id}|${row.biz_date}`);
    if (!operation) return;
    row.gross_amount = number(operation.gross_amount);
    row.platform_income_amount = number(operation.income_amount);
    row.discount_amount = Math.max(0, number(operation.gross_amount) - number(operation.income_amount));
    row.order_count = number(operation.order_count) || number(row.order_count);
  });
  const resolved = resolveRevenueRecords(rawRecords, params);
  // 团购分析仅保留美团团购与抖音团购；历史“免费试”记录不再进入任何团购视角汇总。
  if (String(params.channel_group || '') === 'group_buy') {
    resolved.rows = resolved.rows.filter(row => row.channel !== 'free_trial');
  }
  return resolved;
}

function getOverview(db, params = {}) {
  const { rows: reconciled, policy } = getResolvedRevenueByDate(db, params);
  // 美团外卖“营业额”只能来自营业日报，结算账单中的商家应收款只能作为实收。
  // 没有对应日报时不再把结算收入回填为营业额，并显式通知前端该字段待补。
  const meituanDailyKeys = new Set(db.queryAll(`
    SELECT store_id, biz_date FROM meituan_delivery_daily_records
    WHERE match_status='matched' AND biz_date>=? AND biz_date<=?
    UNION
    SELECT store_id, biz_date FROM meituan_delivery_operation_records
    WHERE match_status='matched' AND biz_date>=? AND biz_date<=?
  `, [params.date_from || '', params.date_to || '', params.date_from || '', params.date_to || '']).map(row => `${row.store_id}|${row.biz_date}`));
  reconciled.forEach(item => {
    if (item.channel !== 'meituan_delivery' || item.source_used !== 'platform') return;
    if (meituanDailyKeys.has(`${item.store_id}|${item.biz_date}`)) return;
    item.gross = 0;
    item.discount = 0;
    item.gross_pending = true;
  });
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
  const totals = { offline: 0, group_buy: 0, delivery: 0, confirmed: 0, gross_amount: 0, gross_pending: false, platform_income_amount: 0, discount_amount: 0, order_count: 0, recorded_online: 0, platform_online: 0, fees: 0, fee_breakdown: { service_fee: 0, insurance_fee: 0, promotion_fee: 0, refund_amount: 0 }, verified: 0, online_pairs: 0 };
  reconciled.forEach(item => {
    if (item.exclude_from_sales) return;
    const bucket = bucketOf(item.biz_date);
    const trend = trendMap.get(bucket) || { period: bucket, offline: 0, group_buy: 0, delivery: 0, total: 0, gross_amount: 0, delivery_gross: 0 };
    trend[item.channel_group] += item.confirmed;
    trend.total += item.confirmed;
    trend.gross_amount += item.gross;
    if (item.channel_group === 'delivery') trend.delivery_gross += item.gross;
    trendMap.set(bucket, trend);
    const store = storeMap.get(item.store_id) || { store_id: item.store_id, store_name: item.store_name, gross_amount: 0, actual: 0, order_count: 0, offline: 0, group_buy: 0, delivery: 0, difference: 0, verified_channels: 0 };
    store.gross_amount += item.gross;
    store.actual += item.confirmed;
    store.order_count += item.orders;
    store[item.channel_group] += item.confirmed;
    if (item.difference != null) { store.difference += item.difference; store.verified_channels += 1; }
    storeMap.set(item.store_id, store);
    const channel = channelMap.get(item.channel) || { channel: item.channel, label: item.channel_label, group: item.channel_group, amount: 0, gross_amount: 0, gross_pending: false, platform_income_amount: 0, discount_amount: 0, order_count: 0, source_used: item.source_used, source_status: item.source_status };
    channel.amount += item.confirmed;
    channel.gross_amount += item.gross;
    channel.gross_pending = channel.gross_pending || Boolean(item.gross_pending);
    channel.platform_income_amount += item.income;
    channel.discount_amount += item.discount;
    channel.order_count += item.orders;
    if (channel.source_used !== item.source_used) {
      channel.source_used = 'mixed';
      channel.source_status = 'mixed_source';
    }
    channelMap.set(item.channel, channel);
    totals[item.channel_group] += item.confirmed;
    totals.confirmed += item.confirmed;
    totals.gross_amount += item.gross;
    totals.gross_pending = totals.gross_pending || Boolean(item.gross_pending);
    totals.platform_income_amount += item.income;
    totals.discount_amount += item.discount;
    totals.order_count += item.orders;
    totals.fees += item.resolved_fees;
    totals.fee_breakdown.service_fee += item.resolved_service_fee || 0;
    totals.fee_breakdown.insurance_fee += item.resolved_insurance_fee || 0;
    totals.fee_breakdown.promotion_fee += item.resolved_promotion_fee || 0;
    totals.fee_breakdown.refund_amount += item.resolved_refund_amount || 0;
    if (item.channel_group !== 'offline') {
      totals.recorded_online += item.recorded;
      if (item.has_platform) { totals.platform_online += item.actual; totals.verified += 1; }
      totals.online_pairs += 1;
    }
  });
  totals.verification_rate = totals.online_pairs ? totals.verified / totals.online_pairs : 0;
  // 线上核对差额 = 平台实际到账 − 收银系统记录。
  totals.online_difference = totals.platform_online - totals.recorded_online;

  // 单店周、月趋势按天展开；没有营业记录的日期也保留为 0，确保曲线完整连续。
  if (period === 'day' && params.date_from && params.date_to) {
    const cursor = new Date(`${params.date_from}T12:00:00`);
    const end = new Date(`${params.date_to}T12:00:00`);
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      if (!trendMap.has(key)) trendMap.set(key, { period: key, offline: 0, group_buy: 0, delivery: 0, total: 0, gross_amount: 0, delivery_gross: 0 });
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
  const rawRevenueComposition = db.queryAll(`SELECT category,SUM(amount) amount
    FROM business_revenue_compositions c WHERE ${compositionWhere.sql}
    GROUP BY category ORDER BY amount DESC`, compositionWhere.values);
  // “营业收入构成”保留收银日报的付款字段，而不是变成另一张渠道表。
  // 真实第三方视角仅替换有明确平台对应关系的三个付款字段：外卖、美团团购、抖音团购；
  // 现金、扫码、会员卡、尾款等没有平台等价字段，继续使用收银机值。
  const compositionMap = new Map();
  const compositionName = category => /美团\/大众点评(?:团购|支付)/.test(String(category || '')) ? '美团团购' : category;
  rawRevenueComposition.forEach(item => {
    const category = compositionName(item.category);
    const current = compositionMap.get(category) || { category, amount: 0, source: '收银经营日报' };
    current.amount += number(item.amount);
    compositionMap.set(category, current);
  });
  if (policy.data_view === 'real') {
    const replacePlatformComposition = (category, channels) => {
      const rows = reconciled.filter(item => channels.includes(item.channel));
      if (!rows.length) return;
      const amount = rows.reduce((sum, item) => sum + number(item.confirmed), 0);
      const hasFallback = rows.some(item => item.source_used !== 'platform');
      compositionMap.set(category, {
        category,
        amount,
        source: hasFallback ? '第三方平台（缺失回退收银机）' : '第三方平台',
      });
    };
    replacePlatformComposition('外卖', ['meituan_delivery', 'taobao_flash', 'jd_delivery']);
    replacePlatformComposition('美团团购', ['meituan_group']);
    replacePlatformComposition('抖音团购', ['douyin_group']);
  }
  const revenueComposition = [...compositionMap.values()].sort((a, b) => number(b.amount) - number(a.amount));
  // 双向验证列表：只保留“有平台账单”的线上记录（收银 vs 平台成对核对）；
  // 平台没有账单的记录不进入此列表（它们仍存在于收银机口径数据中，供原始核对）。
  let reconciliationRows = reconciled.filter(item => item.channel_group !== 'offline' && item.has_platform);
  const includeAllReconciliation = String(params.reconciliation_all || '') === '1';
  // 旧调用保留后端筛选/分页；核对工作台请求完整结果后由前端即时切换平台，不产生重复请求。
  const reconChannel = String(params.reconciliation_channel || '').trim();
  if (!includeAllReconciliation && reconChannel) {
    const wanted = reconChannel.split(',').map(s => s.trim()).filter(Boolean);
    reconciliationRows = reconciliationRows.filter(item => wanted.includes(item.channel));
  }
  reconciliationRows.sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0));
  const reconciliationPageSize = includeAllReconciliation ? Math.max(1, reconciliationRows.length) : Math.max(10, Math.min(100, Number(params.reconciliation_page_size) || 20));
  const reconciliationTotal = reconciliationRows.length;
  const reconciliationPageCount = Math.max(1, Math.ceil(reconciliationTotal / reconciliationPageSize));
  const reconciliationPage = Math.min(reconciliationPageCount, Math.max(1, Number(params.reconciliation_page) || 1));
  const reconciliation = includeAllReconciliation ? reconciliationRows : reconciliationRows.slice((reconciliationPage - 1) * reconciliationPageSize, reconciliationPage * reconciliationPageSize);
  const batches = db.queryAll('SELECT * FROM business_import_batches ORDER BY id DESC LIMIT 8');
  return {
    totals,
    data_source: { view: policy.data_view, overrides: policy.overrides },
    trend: [...trendMap.values()].sort((a, b) => a.period.localeCompare(b.period)),
    reconciliation,
    reconciliation_total: reconciliationTotal,
    reconciliation_page: reconciliationPage,
    reconciliation_page_size: reconciliationPageSize,
    stores: [...storeMap.values()].sort((a, b) => b.actual - a.actual),
    channel_breakdown: [...channelMap.values()].sort((a, b) => b.amount - a.amount),
    top_products: topProducts,
    revenue_composition: revenueComposition,
    fee_detail_breakdown: getRawPlatformFeeBreakdown(db, params),
    meituan_group_fee_categories: meituanGroupFeeCategories(db, params),
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
    platforms: group === 'delivery' ? ['美团外卖', '淘宝闪购', '京东外卖'] : ['美团团购', '抖音团购'],
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

function getMeituanGroupProductAnalytics(db, params = {}) {
  const clauses = ["match_status='matched'"];
  const values = [];
  const requestedStoreIds = Array.isArray(params.store_ids) ? params.store_ids : String(params.store_ids || '').split(',');
  const storeIds = requestedStoreIds.map(Number).filter(id => Number.isInteger(id) && id > 0);
  if (storeIds.length) { clauses.push(`store_id IN (${storeIds.map(() => '?').join(',')})`); values.push(...storeIds); }
  else if (params.store_id) { clauses.push('store_id=?'); values.push(Number(params.store_id)); }
  if (params.date_from) { clauses.push('income_date>=?'); values.push(params.date_from); }
  if (params.date_to) { clauses.push('income_date<=?'); values.push(params.date_to); }
  const rows = db.queryAll(`SELECT project_name,project_id,transaction_type,sale_price,merchant_income,fee_breakdown_json
    FROM meituan_group_buy_benefit_records WHERE ${clauses.join(' AND ')}`, values);
  const mappingRows = db.queryAll(`SELECT bm.id mapping_id,bm.*,m.name menu_name,m.category menu_category,m.cost unit_cost,
      m.spec menu_spec,m.method menu_method,m.spec_unit menu_spec_unit,m.spec_weight menu_spec_weight,
      m.price menu_price,m.dine_in_price menu_dine_in_price,m.member_price menu_member_price,m.takeout_price menu_takeout_price
    FROM business_product_mappings bm JOIN menu_items m ON m.id=bm.menu_item_id WHERE bm.platform='美团团购'`);
  const mappingMap = new Map(mappingRows.map(row => [`美团团购|${row.external_product_name}`, row]));
  const grouped = new Map();
  const idSets = new Map();
  const insurance = { invested: 0, refunded: 0 };
  rows.forEach(row => {
    const type = String(row.transaction_type || '').trim();
    if (type === '保险投保' || type === '保险退保') {
      let fees = {};
      try { fees = JSON.parse(row.fee_breakdown_json || '{}'); } catch {}
      const amount = Math.abs(number(fees.insurance_fee));
      if (type === '保险投保') insurance.invested += amount;
      else insurance.refunded += amount;
      return;
    }
    if (!['消费', '撤销'].includes(type) || !String(row.project_name || '').trim()) return;
    const productName = String(row.project_name).trim();
    const mapping = mappingMap.get(`美团团购|${productName}`);
    const idSet = idSets.get(productName) || new Set();
    if (String(row.project_id || '').trim()) idSet.add(String(row.project_id).trim());
    idSets.set(productName, idSet);
    const item = grouped.get(productName) || {
      platform: '美团团购', product_name: productName, orders: 0, refunds: 0, quantity: 0, sales_amount: 0, merchant_income: 0,
      mapping_id: mapping?.mapping_id || null, menu_item_id: mapping?.menu_item_id || null, menu_name: mapping?.menu_name || '',
      menu_category: mapping?.menu_category || '', unit_cost: number(mapping?.unit_cost), mapped: !!mapping,
    };
    if (type === '消费') { item.orders += 1; item.quantity += 1; }
    else { item.refunds += 1; item.quantity -= 1; }
    item.sales_amount += number(row.sale_price);
    item.merchant_income += number(row.merchant_income);
    grouped.set(productName, item);
  });
  const products = [...grouped.entries()].map(([key, item]) => {
    const idList = [...(idSets.get(key) || [])];
    return {
      ...item,
      platform_product_id: idList.length === 1 ? idList[0] : '',
      platform_product_ids: idList,
      sales_amount: Math.round(item.sales_amount * 100) / 100,
      merchant_income: Math.round(item.merchant_income * 100) / 100,
      total_cost: item.mapped ? Math.round(item.quantity * item.unit_cost * 100) / 100 : null,
      gross_profit: item.mapped ? Math.round((item.merchant_income - item.quantity * item.unit_cost) * 100) / 100 : null,
    };
  }).sort((a, b) => b.sales_amount - a.sales_amount);
  return {
    products,
    totals: {
      quantity: products.reduce((sum, item) => sum + item.quantity, 0),
      orders: products.reduce((sum, item) => sum + item.orders, 0),
      refunds: products.reduce((sum, item) => sum + item.refunds, 0),
      sales_amount: Math.round(products.reduce((sum, item) => sum + item.sales_amount, 0) * 100) / 100,
      merchant_income: Math.round(products.reduce((sum, item) => sum + item.merchant_income, 0) * 100) / 100,
      mapped: products.filter(item => item.mapped).length, total_products: products.length,
      insurance_invested: Math.round(insurance.invested * 100) / 100,
      insurance_refunded: Math.round(insurance.refunded * 100) / 100,
      insurance_net: Math.round((insurance.invested - insurance.refunded) * 100) / 100,
    },
  };
}

function getProductAnalytics(db, scope, params = {}) {
  if (scope === 'overview') return getTotalProductAnalytics(db, params);
  if (scopeGroup(scope) === 'group_buy' && String(params.platform || '') === '美团团购') return getMeituanGroupProductAnalytics(db, params);
  const rows = salesInScope(db, scope, params);
  // 商品销量报表只有“销售额”，没有每个菜品的实际到账。以同门店、同日期、同平台的
  // 实收为总额，按各菜品销售额占比分摊，保证菜品实收合计严格等于平台实收。
  const { rows: revenueRows } = getResolvedRevenueByDate(db, params);
  const revenueByStoreDayChannel = new Map(revenueRows.map(row => [
    `${row.store_id}|${row.biz_date}|${row.channel}`,
    number(row.confirmed),
  ]));
  const salesByStoreDayChannel = new Map();
  rows.forEach(row => {
    const key = `${row.store_id}|${row.biz_date}|${row.channel}`;
    salesByStoreDayChannel.set(key, number(salesByStoreDayChannel.get(key)) + number(row.sales_amount));
  });
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
  // 配置了“规格售价反解”的商品：按每行 (销量, 销售额) 反解规格成本，逐行累加。
  // 同时把完整规格关系回传给绑定中心，不能只返回“已绑定”这个模糊状态。
  const specLinks = db.queryAll(`SELECT sl.platform, sl.external_product_name, sl.menu_item_id, sl.platform_price,
      m.name AS menu_name, m.spec AS menu_spec, m.method AS menu_method, COALESCE(m.cost, 0) AS unit_cost
    FROM business_product_spec_links sl
    LEFT JOIN menu_items m ON m.id=sl.menu_item_id
    WHERE sl.enabled=1
    ORDER BY sl.platform, sl.external_product_name, sl.sort_order, sl.platform_price`);
  const specMap = new Map();
  specLinks.forEach(link => {
    const name = `${String(link.platform || '')}|${String(link.external_product_name || '')}`;
    const list = specMap.get(name) || [];
    list.push({
      menu_item_id: Number(link.menu_item_id),
      platform_price: number(link.platform_price),
      menu_name: link.menu_name || '',
      menu_spec: link.menu_spec || '',
      menu_method: link.menu_method || '',
      unit_cost: number(link.unit_cost),
    });
    specMap.set(name, list);
  });
  const grouped = new Map();
  const idSets = new Map();
  rows.forEach(row => {
    const platform = row.platform || CHANNELS[row.channel]?.label || row.channel;
    const key = `${platform}|${row.product_name}`;
    const ids = idSets.get(key) || new Set();
    if (String(row.platform_product_id || '').trim()) ids.add(String(row.platform_product_id).trim());
    idSets.set(key, ids);
    const mapping = mappingMap.get(key);
    const item = grouped.get(key) || {
      platform,
      product_name: row.product_name,
      quantity: 0,
      sales_amount: 0,
      actual_income: 0,
      actual_income_complete: true,
      mapping_id: mapping?.mapping_id || null,
      menu_item_id: mapping?.menu_item_id || null,
      menu_name: mapping?.menu_name || '',
      menu_category: mapping?.menu_category || '',
      menu_sku_label: mapping?.menu_sku_label || '',
      menu_sku_variant: mapping?.menu_sku_variant || '',
      menu_sku_price_summary: mapping?.menu_sku_price_summary || '',
      unit_cost: number(mapping?.unit_cost),
      mapped: !!mapping,
      spec_reverse: false,
      spec_cost_sum: 0,
      spec_unresolved_qty: 0,
      spec_unit_price_qty: 0,
      spec_combination_qty: 0,
      spec_unresolved_reasons: new Set(),
    };
    item.quantity += number(row.quantity);
    item.sales_amount += number(row.sales_amount);
    const revenueKey = `${row.store_id}|${row.biz_date}|${row.channel}`;
    const daySales = number(salesByStoreDayChannel.get(revenueKey));
    if (!revenueByStoreDayChannel.has(revenueKey) || !daySales) {
      item.actual_income_complete = false;
    } else {
      item.actual_income += number(revenueByStoreDayChannel.get(revenueKey)) * number(row.sales_amount) / daySales;
    }
    const itemSpecLinks = specMap.get(`${platform}|${String(row.product_name || '')}`) || [];
    if (itemSpecLinks.length) {
      item.spec_reverse = true;
      item.spec_link_count = itemSpecLinks.length;
      item.spec_links = itemSpecLinks;
      const resolved = resolveSpecCost(db, platform, String(row.product_name || ''), number(row.quantity), number(row.sales_amount), { store_id: row.store_id, biz_date: row.biz_date });
      if (resolved.configured && resolved.solved) {
        item.spec_cost_sum += resolved.cost;
        if (resolved.method === 'unit_price_match') item.spec_unit_price_qty += number(row.quantity);
        else item.spec_combination_qty += number(row.quantity);
      } else {
        item.spec_unresolved_qty += number(row.quantity);
        if (resolved.reason) item.spec_unresolved_reasons.add(resolved.reason);
      }
    }
    grouped.set(key, item);
  });
  const products = [...grouped.entries()].map(([key, item]) => {
    const idList = [...(idSets.get(key) || [])];
    const pid = idList.length === 1 ? idList[0] : '';
    if (item.spec_reverse) {
      const totalCost = Math.round(item.spec_cost_sum * 100) / 100;
      return {
        ...item,
        platform_product_id: pid,
        platform_product_ids: idList,
        actual_income: item.actual_income_complete ? Math.round(item.actual_income * 100) / 100 : null,
        cost_available: item.spec_unresolved_qty ? 0 : 1,
        total_cost: totalCost,
        // 预估毛利 = 分摊实收 − 本地菜品成本之和；规格拆分成本已由反解结果得出。
        gross_profit: item.actual_income_complete ? Math.round((item.actual_income - item.spec_cost_sum) * 100) / 100 : null,
        cost_method: 'spec_reverse',
        spec_unresolved_qty: item.spec_unresolved_qty,
        spec_unit_price_qty: item.spec_unit_price_qty,
        spec_combination_qty: item.spec_combination_qty,
        spec_unresolved_reasons: [...item.spec_unresolved_reasons],
        mapped: item.spec_unresolved_qty === 0,
        binding_mode: 'spec',
      };
    }
    const totalCost = item.mapped ? Math.round(item.quantity * item.unit_cost * 100) / 100 : null;
    return {
      ...item,
      platform_product_id: pid,
      platform_product_ids: idList,
      actual_income: item.actual_income_complete ? Math.round(item.actual_income * 100) / 100 : null,
      binding_mode: item.mapped ? 'single' : 'none',
      total_cost: totalCost,
      // 预估毛利 = 分摊实收 − 门店菜品成本之和。
      gross_profit: item.mapped && item.actual_income_complete ? Math.round((item.actual_income - totalCost) * 100) / 100 : null,
    };
  });
  const actualIncome = products.reduce((sum, item) => sum + number(item.actual_income), 0);
  const totalCost = products.reduce((sum, item) => sum + number(item.total_cost), 0);
  return { products: products.sort((a, b) => b.sales_amount - a.sales_amount), totals: {
    quantity: products.reduce((s, r) => s + r.quantity, 0),
    sales_amount: products.reduce((s, r) => s + r.sales_amount, 0),
    actual_income: Math.round(actualIncome * 100) / 100,
    total_cost: Math.round(totalCost * 100) / 100,
    gross_profit: Math.round((actualIncome - totalCost) * 100) / 100,
    mapped: products.filter(r => r.mapped).length, total_products: products.length,
  } };
}

// 总数据菜品销量：以收银机品项明细为准聚合本地 SKU，同时保留每条原始来源以供展开追溯。
// 此处只读 pos_product_sale_details，不会写入或修改任何第三方平台真实数据表。
function getTotalProductAnalytics(db, params = {}) {
  const where = rangeWhere(params, 'p');
  const rows = db.queryAll(`SELECT p.* FROM pos_product_sale_details p WHERE ${where.sql}`, where.values);
  const menus = db.queryAll(`SELECT id,name,category,method,spec,spec_unit,spec_weight,cost,skuid
    FROM menu_items WHERE status='在售' AND INSTR(name,'员工餐')=0`).map(withMenuSku);
  const menuBySku = new Map(menus.map(menu => [String(menu.skuid), menu]));
  const menusByName = new Map();
  menus.forEach(menu => {
    const key = String(menu.name || '').replace(/[【】\[\]（）()\s]/g, '').trim();
    const list = menusByName.get(key) || [];
    list.push(menu);
    menusByName.set(key, list);
  });
  const manualMenus = db.queryAll(`SELECT pm.product_code,m.id,m.name,m.category,m.method,m.spec,m.spec_unit,m.spec_weight,m.cost,m.skuid
    FROM pos_product_mappings pm JOIN menu_items m ON m.id=pm.menu_item_id`).map(row => [String(row.product_code), withMenuSku(row)]);
  const manualMenuBySku = new Map(manualMenus);
  const normalizedMenuName = value => String(value || '').replace(/[【】\[\]（）()\s]/g, '').trim();
  const grouped = new Map();
  rows.forEach(row => {
    const productCode = String(row.product_code || '').trim();
    const codedMenu = menuBySku.get(productCode);
    // 机构历史 SKU 档案可能被人工改写；编码和名称相互校验，避免把“金牌烧鸭饭”误归到另一道菜。
    const namedMenus = [row.product_name, row.related_product_name]
      .map(name => menusByName.get(normalizedMenuName(name)) || [])
      .find(list => list.length === 1) || [];
    const menu = manualMenuBySku.get(productCode)
      || (codedMenu && [row.product_name, row.related_product_name]
        .some(name => normalizedMenuName(name) === normalizedMenuName(codedMenu.name)) ? codedMenu : null)
      // 编码档案与名称冲突时，只有“本地菜品名唯一”才允许按名称自动关联；多规格同名一律留待人工绑定。
      || namedMenus[0] || null;
    const isMapped = !!menu;
    const channelMeta = CHANNELS[row.channel] || CHANNELS.store_sales;
    const groupKey = isMapped ? `menu:${menu.id}` : `unmapped:${row.channel}|${row.product_code}|${row.product_name}`;
    const item = grouped.get(groupKey) || {
      product_name: isMapped ? menu.name : row.product_name,
      product_code: row.product_code,
      platform: isMapped ? '本地菜品' : (channelMeta.label || '收银机未关联菜品'),
      quantity: 0, sales_amount: 0, discount_amount: 0, actual_income: 0,
      gift_quantity: 0, gift_amount: 0,
      refund_amount: 0, order_ids: new Set(), refund_order_ids: new Set(),
      mapped: isMapped, menu_item_id: menu?.id || null, menu_name: menu?.name || '',
      menu_category: menu?.category || '', menu_sku_label: menu?.sku_label || '',
      menu_sku_variant: menu?.sku_variant || '', unit_cost: number(menu?.cost),
      total_cost: 0, gross_profit: 0, breakdown_map: new Map(),
    };
    const quantity = number(row.quantity);
    const income = number(row.income_amount);
    const sales = number(row.sales_amount);
    const isRefund = String(row.sales_mode || '') === '退菜' || quantity < 0 || sales < 0;
    item.quantity += quantity;
    item.sales_amount += sales;
    item.discount_amount += number(row.discount_amount);
    item.actual_income += income;
    // 赠品是「已含在销量/销售额里、再全额优惠」的部分，只做标注，绝不加到销量/金额上（否则重复计数）。
    item.gift_quantity += number(row.gift_quantity);
    item.gift_amount += number(row.gift_amount);
    item.total_cost += isMapped ? quantity * number(menu.cost) : 0;
    item.order_ids.add(String(row.order_id));
    if (isRefund) { item.refund_amount += Math.abs(income); item.refund_order_ids.add(String(row.order_id)); }
    const sourceName = channelMeta.group === 'offline'
      ? (row.order_sub_source || row.new_order_source || row.order_source || channelMeta.label)
      : `（${channelMeta.label}）`;
    const detailKey = `${sourceName}|${row.product_name}|${row.product_code}`;
    const detail = item.breakdown_map.get(detailKey) || {
      source_name: sourceName,
      product_name: row.product_name,
      product_code: row.product_code,
      quantity: 0, sales_amount: 0, discount_amount: 0, income_amount: 0,
      gift_quantity: 0, gift_amount: 0,
      refund_amount: 0, order_ids: new Set(), refund_order_ids: new Set(),
    };
    detail.quantity += quantity;
    detail.sales_amount += sales;
    detail.discount_amount += number(row.discount_amount);
    detail.income_amount += income;
    detail.gift_quantity += number(row.gift_quantity);
    detail.gift_amount += number(row.gift_amount);
    detail.order_ids.add(String(row.order_id));
    if (isRefund) { detail.refund_amount += Math.abs(income); detail.refund_order_ids.add(String(row.order_id)); }
    item.breakdown_map.set(detailKey, detail);
    grouped.set(groupKey, item);
  });
  const products = [...grouped.values()].map(item => {
    const breakdown = [...item.breakdown_map.values()].map(detail => ({
      ...detail, order_count: detail.order_ids.size, refund_orders: detail.refund_order_ids.size,
      order_ids: undefined, refund_order_ids: undefined,
    })).sort((a, b) => b.sales_amount - a.sales_amount || b.quantity - a.quantity);
    const totalCost = Math.round(item.total_cost * 100) / 100;
    const income = Math.round(item.actual_income * 100) / 100;
    return {
      ...item,
      quantity: Math.round(item.quantity * 1000) / 1000,
      sales_amount: Math.round(item.sales_amount * 100) / 100,
      discount_amount: Math.round(item.discount_amount * 100) / 100,
      actual_income: income,
      gift_quantity: Math.round(item.gift_quantity * 1000) / 1000,
      gift_amount: Math.round(item.gift_amount * 100) / 100,
      refund_amount: Math.round(item.refund_amount * 100) / 100,
      order_count: item.order_ids.size,
      refund_orders: item.refund_order_ids.size,
      total_cost: item.mapped ? totalCost : null,
      gross_profit: item.mapped ? Math.round((income - totalCost) * 100) / 100 : null,
      breakdown,
      order_ids: undefined, refund_order_ids: undefined, breakdown_map: undefined,
    };
  }).sort((a, b) => Number(b.mapped) - Number(a.mapped) || b.sales_amount - a.sales_amount);
  const totals = {
    quantity: products.reduce((sum, item) => sum + number(item.quantity), 0),
    sales_amount: products.reduce((sum, item) => sum + number(item.sales_amount), 0),
    actual_income: products.reduce((sum, item) => sum + number(item.actual_income), 0),
    gift_quantity: products.reduce((sum, item) => sum + number(item.gift_quantity), 0),
    gift_amount: products.reduce((sum, item) => sum + number(item.gift_amount), 0),
    total_cost: products.reduce((sum, item) => sum + number(item.total_cost), 0),
    gross_profit: products.reduce((sum, item) => sum + number(item.gross_profit), 0),
    mapped: products.filter(item => item.mapped).length,
    total_products: products.length,
  };
  Object.keys(totals).forEach(key => { if (typeof totals[key] === 'number') totals[key] = Math.round(totals[key] * 100) / 100; });
  return { products, totals, source: 'pos_item_sales_detail' };
}

function savePosProductMapping(db, params = {}) {
  const productCode = String(params.product_code || '').trim();
  const productName = String(params.product_name || '').trim();
  const menuItemId = Number(params.menu_item_id);
  if (!productCode) throw new Error('缺少收银机菜品编码，无法保存关联');
  const menu = db.queryOne('SELECT id,name FROM menu_items WHERE id=?', [menuItemId]);
  if (!menu) throw new Error('本地菜品不存在');
  if (String(menu.name || '').includes('员工餐')) throw new Error('员工餐不参与菜品关联');
  db.run(`INSERT INTO pos_product_mappings (product_code,product_name,menu_item_id,updated_at)
    VALUES (?,?,?,datetime('now','localtime'))
    ON CONFLICT(product_code) DO UPDATE SET product_name=excluded.product_name,menu_item_id=excluded.menu_item_id,updated_at=excluded.updated_at`, [productCode, productName, menuItemId]);
  db.save();
  return { ok: true };
}

function getProductMappings(db, scope, params = {}) {
  const analytics = getProductAnalytics(db, scope, params);
  const menuItems = db.queryAll(`SELECT id,name,category,method,spec,price,dine_in_price,member_price,takeout_price,spec_unit,spec_weight,cost
    FROM menu_items WHERE status='在售' AND INSTR(name,'员工餐')=0 ORDER BY category,name,spec,id`).map(withMenuSku);
  return { ...analytics, menu_items: menuItems };
}

function saveProductMapping(db, params = {}) {
  const platform = String(params.platform || '').trim();
  const externalName = String(params.external_product_name || '').trim();
  const menuItemId = Number(params.menu_item_id);
  if (!platform || !externalName) throw new Error('平台和第三方商品名称不能为空');
  const menu = db.queryOne('SELECT id,name FROM menu_items WHERE id=?', [menuItemId]);
  if (!menu) throw new Error('标准菜品不存在');
  if (String(menu.name || '').includes('员工餐')) throw new Error('员工餐不参与外卖和团购菜品绑定');
  const group = scopeGroup(params.scope) || (['美团外卖','淘宝闪购','京东外卖'].includes(platform) ? 'delivery' : 'group_buy');
  // 单品绑定与规格拆分互斥；改回单品时自动清掉旧规格配置，避免两套成本口径并存。
  db.run('BEGIN');
  try {
    db.run('DELETE FROM business_product_spec_links WHERE platform=? AND external_product_name=?', [platform, externalName]);
    db.run(`INSERT INTO business_product_mappings (platform,channel_group,external_product_name,menu_item_id)
      VALUES (?,?,?,?) ON CONFLICT(platform,external_product_name) DO UPDATE SET channel_group=excluded.channel_group,menu_item_id=excluded.menu_item_id,updated_at=datetime('now','localtime')`, [platform, group, externalName, menuItemId]);
    db.run('COMMIT');
  } catch (error) {
    try { db.run('ROLLBACK'); } catch {}
    throw error;
  }
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

module.exports = { importWorkbook, importMeituanDeliveryWorkbook, importMeituanGroupBuyWorkbook, importMeituanGroupOperationWorkbook, importDouyinGroupBuyWorkbook, importJdDeliveryWorkbook, importTaobaoFlashWorkbook, rebuildTaobaoFlashRevenue, rebuildJdRevenueFromOperation, getOverview, getScopedOverview, getResolvedRevenueByDate, getMeituanOperation, getProductAnalytics, getProductMappings, saveProductMapping, savePosProductMapping, deleteProductMapping, getDiagnosis, generateDiagnosis, createTemplate, resolveSpecCost, CHANNELS, periodExpr };
