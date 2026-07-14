/**
 * 门店日报数据模块
 * 读取本地 Excel (xlsx)，解析多门店日报数据
 * 
 * Excel 列结构（按顺序，共两行表头）：
 *   [row0] 排名 | 门店名称 | 营业额 | 实收 | 有效订单 | (合并单元格) |
 *          店内销售 | 自提销售 | 美团外卖 | 淘宝闪购 | 京东外卖 |
 *          美团一键买单 | 美团团购 | 抖音团购 | 储值消费 | 优惠券 |
 *          店内+自提收入 | 优惠金额 | 优惠占比
 * 
 * 业务逻辑：
 *   实收 = 店内销售 + 自提销售 + 美团外卖 + 淘宝闪购 + 京东外卖
 *   堂食消费来源 = 美团一键买单 + 美团团购 + 抖音团购 + 储值消费 + 优惠券 + 店内+自提收入
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

/** Excel 列索引映射（对应 row1 子标题行 + row2 数据行） */
const COL = {
  storeName: 1,       // 门店名称
  revenue: 2,         // 营业额
  actualRevenue: 3,   // 实收（Excel 直接提供）
  orderCount: 4,      // 有效订单数
  instore: 5,         // 店内销售
  pickup: 6,          // 自提销售
  mtWaimai: 7,        // 美团外卖
  tbFlash: 8,         // 淘宝闪购
  jdWaimai: 9,        // 京东外卖
  mtPay: 10,          // 美团一键买单
  mtTuan: 11,         // 美团团购
  dyTuan: 12,         // 抖音团购
  stored: 13,         // 储值消费
  coupon: 14,         // 优惠券
  instorePickupRaw: 15, // 店内+自提收入（Excel 直接提供）
  discountAmount: 16, // 优惠金额
  discountRate: 17,   // 优惠占比
};

/** 默认 Excel 文件路径 */
const DEFAULT_XLSX_PATH = path.join(__dirname, '..', '日报.xlsx');

/**
 * 推断日报日期
 * 优先从文件名中提取日期（如 "日报-20260709.xlsx"），否则使用当天日期
 */
function getReportDate() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 读取并解析日报 Excel
 * @param {string} [filePath] - Excel 文件路径，默认 workspace 下的 日报.xlsx
 * @returns {Object[]} 解析后的门店数据数组
 */
function parseDailyExcel(filePath) {
  const fp = filePath || DEFAULT_XLSX_PATH;
  
  if (!fs.existsSync(fp)) {
    throw new Error(`日报文件不存在: ${fp}`);
  }

  const wb = XLSX.readFile(fp);
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];

  // 转换为数组（跳过表头）
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (rows.length < 2) {
    throw new Error('日报 Excel 中没有数据行（需要至少 1 行表头 + 1 行数据）');
  }

  // row 0 是第一行表头，row 1 是子标题行，从 row 2 开始是数据
  // 但为了兼容单行表头的 Excel，用 storeName 是否为空来跳过非数据行
  const stores = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const storeName = String(row[COL.storeName] || '').trim();
    if (!storeName) continue; // 跳过空行 / 子标题行

    // 读取各列原始数据
    const instore = parseFloat(row[COL.instore]) || 0;
    const pickup = parseFloat(row[COL.pickup]) || 0;
    const mtWaimai = parseFloat(row[COL.mtWaimai]) || 0;
    const tbFlash = parseFloat(row[COL.tbFlash]) || 0;
    const jdWaimai = parseFloat(row[COL.jdWaimai]) || 0;
    const mtPay = parseFloat(row[COL.mtPay]) || 0;
    const mtTuan = parseFloat(row[COL.mtTuan]) || 0;
    const dyTuan = parseFloat(row[COL.dyTuan]) || 0;
    const stored = parseFloat(row[COL.stored]) || 0;
    const coupon = parseFloat(row[COL.coupon]) || 0;
    const discountAmount = parseFloat(row[COL.discountAmount]) || 0;
    const discountRate = String(row[COL.discountRate] || '').trim();

    // 营业额（Excel 列2 直接提供）
    const revenue = parseFloat(row[COL.revenue]) || 0;

    // 实收：优先用 Excel 列3 的值；若没有则用各渠道加总
    const excelActualRevenue = parseFloat(row[COL.actualRevenue]);
    const computedActualRevenue = instore + pickup + mtWaimai + tbFlash + jdWaimai;
    const actualRevenue = !isNaN(excelActualRevenue) && excelActualRevenue > 0
      ? excelActualRevenue
      : computedActualRevenue;

    // 店内+自提收入：优先用 Excel 列15 的值；若没有则用 instore+pickup 计算
    const excelInstorePickup = parseFloat(row[COL.instorePickupRaw]);
    const computedInstorePickup = instore + pickup;
    const instorePickup = !isNaN(excelInstorePickup) && excelInstorePickup > 0
      ? excelInstorePickup
      : computedInstorePickup;

    const orderCount = parseInt(row[COL.orderCount]) || 0;

    // 堂食消费来源（饼图展示）
    const sources = [
      { label: '美团一键买单', value: mtPay },
      { label: '美团团购', value: mtTuan },
      { label: '抖音团购', value: dyTuan },
      { label: '储值消费', value: stored },
      { label: '优惠券', value: coupon },
      { label: '店内+自提收入', value: instorePickup },
    ].filter(s => s.value > 0);

    // 渠道销售明细（条形图展示，按金额降序）
    const channels = [
      { label: '京东外卖', value: jdWaimai },
      { label: '淘宝闪购', value: tbFlash },
      { label: '美团外卖', value: mtWaimai },
      { label: '店内销售', value: instore },
      { label: '自提销售', value: pickup },
    ].sort((a, b) => b.value - a.value);

    // 折扣率格式化：统一转为百分比两位小数
    let finalDiscountRate = discountRate;
    if (finalDiscountRate) {
      // 如果已经是百分比字符串，直接保留；否则视为小数转换
      if (!finalDiscountRate.includes('%')) {
        const num = parseFloat(finalDiscountRate);
        finalDiscountRate = isNaN(num) ? '0.00%' : (num * 100).toFixed(2) + '%';
      }
    } else if (revenue > 0 && discountAmount > 0) {
      finalDiscountRate = ((discountAmount / revenue) * 100).toFixed(2) + '%';
    }

    // 日期：Excel 中没有日期列，尝试从文件名或当前日期推断
    const dateStr = getReportDate();

    stores.push({
      id: 'store_' + i,
      storeName,
      date: dateStr,
      revenue,
      actualRevenue,
      orderCount,
      sources,
      channels,
      discountAmount: discountAmount || 0,
      discountRate: finalDiscountRate || '0%',
      // 原始数据用于前端表格展示
      raw: {
        instore,
        pickup,
        mtWaimai,
        tbFlash,
        jdWaimai,
        mtPay,
        mtTuan,
        dyTuan,
        stored,
        coupon,
        instorePickup,
        actualRevenue,
      },
    });
  }

  return stores;
}

/**
 * 为 drawStoreDailyReport 生成兼容的数据格式
 */
function toReportData(store) {
  return {
    storeName: store.storeName,
    date: store.date,
    revenue: store.revenue,
    actualRevenue: store.actualRevenue,
    orderCount: store.orderCount,
    sources: store.sources,
    channels: store.channels,
    discountAmount: store.discountAmount,
    discountRate: store.discountRate,
  };
}

module.exports = { parseDailyExcel, toReportData, DEFAULT_XLSX_PATH, COL };
