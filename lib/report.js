/**
 * 门店日报图片生成模块
 * 基于 @napi-rs/canvas 渲染综合日报 PNG 图片
 * 用于企业微信 Webhook image 推送
 */

const { createCanvas } = require('@napi-rs/canvas');

// 字体
const FONT = '"Microsoft YaHei", SimHei, sans-serif';

// 配色方案
const COLORS = {
  primary: '#1e40af',
  primaryMid: '#2563eb',
  primaryLight: '#3b82f6',
  bg: '#f8fafc',
  cardBg: '#ffffff',
  text: '#1e293b',
  textSec: '#64748b',
  textLight: '#94a3b8',
  accent: '#f59e0b',
  danger: '#ef4444',
  dangerLight: '#fecaca',
  dangerBg: '#fef2f2',
  success: '#10b981',
  successLight: '#a7f3d0',
  successBg: '#ecfdf5',
  info: '#8b5cf6',
  border: '#e2e8f0',
  stripeBg: '#f1f5f9',
  warnBg: '#fffbeb',
  warnBorder: '#fde68a',
  warnText: '#d97706',
};

// 饼图配色（环形图）
const PIE_COLORS = [
  '#2563eb', '#ef4444', '#10b981',
  '#f59e0b', '#8b5cf6', '#ec4899',
  '#06b6d4', '#f97316',
];

/** 金额格式化 */
function fmtMoney(n) {
  const num = Number(n);
  return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 折扣率格式化：统一转为百分比两位小数（如 "47.10%"） */
function fmtDiscountRate(val) {
  const str = String(val || '').trim();
  if (!str) return '0.00%';
  // 如果已经是百分比字符串（含 %），直接返回
  if (str.includes('%')) return str;
  // 否则视为小数（如 0.4710），转为百分比
  const num = parseFloat(str);
  if (isNaN(num)) return '0.00%';
  return (num * 100).toFixed(2) + '%';
}

/** 圆角矩形路径 */
function roundRect(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * 绘制门店日报图片
 * @param {Object} data
 * @param {string} data.storeName      - 门店名称
 * @param {string} data.date           - 日期
 * @param {number} data.revenue        - 营业额
 * @param {number} data.actualRevenue  - 实收
 * @param {number} data.orderCount     - 有效订单数
 * @param {Object[]} data.sources      - 收入来源 [{label, value}]
 * @param {Object[]} data.channels     - 渠道明细 [{label, value}]
 * @param {number} data.discountAmount - 优惠金额
 * @param {string} data.discountRate   - 优惠占比
 * @returns {{ base64: string, buffer: Buffer }}
 */
function drawStoreDailyReport(data) {
  const W = 800;
  const H = 960;
  const PAD = 24; // 统一外边距

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ===== 整体背景 =====
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // ========== 1. 头部横幅 ==========
  const headerH = 94;
  const headerGrad = ctx.createLinearGradient(0, 0, W, 0);
  headerGrad.addColorStop(0, '#1e3a8a');
  headerGrad.addColorStop(0.5, '#1d4ed8');
  headerGrad.addColorStop(1, '#3b82f6');
  ctx.fillStyle = headerGrad;
  roundRect(ctx, PAD, PAD, W - PAD * 2, headerH, 14);
  ctx.fill();

  // 装饰圆（半透明）
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(W - 60, PAD + 47, 55, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(W - 120, PAD + 20, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // 门店图标 + 名称
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 24px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(data.storeName, PAD + 24, PAD + 44);

  // 日期标签
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.font = `14px ${FONT}`;
  ctx.fillText(data.date + '   门店经营日报', PAD + 24, PAD + 74);

  // 右上角「日报」标记
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.font = `bold 48px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText('DAILY', W - PAD - 20, PAD + 70);

  // ========== 2. 核心指标卡片 ==========
  const cardY = PAD + headerH + 20;
  const cardW = (W - PAD * 2 - 28) / 3;
  const cardH = 96;

  const metrics = [
    { icon: '', label: '营业额', value: '¥' + fmtMoney(data.revenue), color: COLORS.primaryLight },
    { icon: '', label: '实收金额', value: '¥' + fmtMoney(data.actualRevenue), color: COLORS.success },
    { icon: '', label: '有效订单', value: String(data.orderCount) + ' 单', color: COLORS.accent },
  ];

  metrics.forEach((m, i) => {
    const cx = PAD + i * (cardW + 14);

    // 卡片阴影（手动）
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.06)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 2;
    roundRect(ctx, cx, cardY, cardW, cardH, 12);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // 顶部色条
    ctx.fillStyle = m.color;
    roundRect(ctx, cx + 8, cardY + 8, cardW - 16, 4, 2);
    ctx.fill();

    // 图标 + 标签
    ctx.fillStyle = COLORS.textSec;
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(m.label, cx + cardW / 2, cardY + 34);

    // 数值
    ctx.fillStyle = COLORS.text;
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillText(m.value, cx + cardW / 2, cardY + 72);
  });

  // ========== 3. 收入来源构成（环形饼图 + 图例）==========
  const section3Y = cardY + cardH + 28;
  const section3H = 300;

  // 白底卡片
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.05)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 1;
  roundRect(ctx, PAD, section3Y, W - PAD * 2, section3H, 12);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // 标题
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 16px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('收入来源构成', PAD + 20, section3Y + 32);

  // 副标题
  const totalSource = data.sources.reduce((a, b) => a + b.value, 0);
  ctx.fillStyle = COLORS.textSec;
  ctx.font = `12px ${FONT}`;
  ctx.fillText('合计 ¥' + fmtMoney(totalSource), PAD + 20, section3Y + 52);

  // 环形饼图
  const pieCX = PAD + 100;
  const pieCY = section3Y + 170;
  const outerR = 88;
  const innerR = 48;

  const sources = data.sources.filter(s => s.value > 0);
  let startAngle = -Math.PI / 2;

  if (sources.length > 0 && totalSource > 0) {
    sources.forEach((s, i) => {
      const sliceAngle = (s.value / totalSource) * Math.PI * 2;
      const endAngle = startAngle + sliceAngle;

      ctx.fillStyle = PIE_COLORS[i % PIE_COLORS.length];
      ctx.beginPath();
      ctx.moveTo(pieCX + innerR * Math.cos(startAngle), pieCY + innerR * Math.sin(startAngle));
      ctx.arc(pieCX, pieCY, outerR, startAngle, endAngle);
      ctx.arc(pieCX, pieCY, innerR, endAngle, startAngle, true);
      ctx.closePath();
      ctx.fill();

      // 百分比标签
      const pct = ((s.value / totalSource) * 100);
      if (pct > 5) {
        const midAngle = startAngle + sliceAngle / 2;
        const labelR = (outerR + innerR) / 2;
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 12px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(pct.toFixed(1) + '%', pieCX + labelR * Math.cos(midAngle), pieCY + labelR * Math.sin(midAngle) + 5);
      }

      startAngle = endAngle;
    });

    // 中心文字
    ctx.fillStyle = COLORS.text;
    ctx.font = `bold 16px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('实收', pieCX, pieCY - 4);
    ctx.fillStyle = COLORS.textSec;
    ctx.font = `12px ${FONT}`;
    ctx.fillText('来源', pieCX, pieCY + 16);
  } else {
    // 空数据
    ctx.fillStyle = COLORS.border;
    ctx.beginPath();
    ctx.arc(pieCX, pieCY, outerR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(pieCX, pieCY, innerR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.textSec;
    ctx.font = `14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据', pieCX, pieCY + 5);
  }

  // 图例区
  const legendX = PAD + 220;
  const legendStartY = section3Y + 50;
  const colW = 250;
  const rowH = 32;

  sources.forEach((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const lx = legendX + col * colW;
    const ly = legendStartY + row * rowH;

    // 色块
    ctx.fillStyle = PIE_COLORS[i % PIE_COLORS.length];
    roundRect(ctx, lx, ly, 16, 16, 4);
    ctx.fill();

    // 文字
    const pct = ((s.value / totalSource) * 100).toFixed(1);
    ctx.fillStyle = COLORS.text;
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(s.label, lx + 24, ly + 14);

    // 金额
    ctx.fillStyle = COLORS.textSec;
    ctx.font = `12px ${FONT}`;
    ctx.fillText('¥' + fmtMoney(s.value) + '  (' + pct + '%)', lx + 24 + ctx.measureText(s.label).width + 12, ly + 14);
  });

  // ========== 4. 渠道销售明细 ==========
  const section4Y = section3Y + section3H + 18;
  const section4H = 220;

  // 白底卡片
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.05)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 1;
  roundRect(ctx, PAD, section4Y, W - PAD * 2, section4H, 12);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  ctx.fillStyle = COLORS.text;
  ctx.font = `bold 16px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('渠道销售明细', PAD + 20, section4Y + 32);

  const channels = data.channels || [];
  const maxChannel = Math.max(...channels.map(c => c.value), 1);
  const barStartY = section4Y + 52;
  const barH = 28;
  const barGap = 10;
  const labelW = 90;
  const barAreaX = PAD + 20 + labelW;
  const barMaxW = W - PAD * 2 - 40 - labelW - 100;

  channels.forEach((c, i) => {
    const y = barStartY + i * (barH + barGap);
    const barW = Math.max(4, (c.value / maxChannel) * barMaxW);

    // 标签
    ctx.fillStyle = COLORS.textSec;
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(c.label, barAreaX - 8, y + barH / 2 + 5);

    // 背景条
    ctx.fillStyle = COLORS.stripeBg;
    roundRect(ctx, barAreaX, y, barMaxW, barH, 7);
    ctx.fill();

    // 数值条（渐变）
    const barGrad = ctx.createLinearGradient(barAreaX, 0, barAreaX + barMaxW, 0);
    barGrad.addColorStop(0, COLORS.primaryMid);
    barGrad.addColorStop(1, COLORS.primaryLight);
    ctx.fillStyle = barGrad;
    roundRect(ctx, barAreaX, y, barW, barH, 7);
    ctx.fill();

    // 数值在条内（如果空间足够）
    if (barW > 80) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold 12px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText('¥' + fmtMoney(c.value), barAreaX + 10, y + barH / 2 + 5);
    }

    // 右侧金额
    ctx.fillStyle = COLORS.text;
    ctx.font = `bold 13px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText('¥' + fmtMoney(c.value), barAreaX + barMaxW + 14, y + barH / 2 + 5);
  });

  // ========== 5. 优惠信息 ==========
  const section5Y = section4Y + section4H + 18;

  const discountCards = [
    { icon: '', label: '优惠金额', value: '¥' + fmtMoney(data.discountAmount),
      bg: COLORS.dangerBg, border: COLORS.dangerLight, textColor: COLORS.danger },
    { icon: '', label: '优惠占比', value: fmtDiscountRate(data.discountRate),
      bg: COLORS.warnBg, border: COLORS.warnBorder, textColor: COLORS.warnText },
    { icon: '', label: '实收率', value: (data.revenue > 0
      ? ((data.actualRevenue / data.revenue) * 100).toFixed(2) + '%'
      : '—'),
      bg: COLORS.successBg, border: COLORS.successLight, textColor: COLORS.success },
  ];

  const dcW = (W - PAD * 2 - 28) / 3; // 3 列优惠卡片
  const dcH = 78;

  discountCards.forEach((dc, i) => {
    const dx = PAD + i * (dcW + 14);

    ctx.fillStyle = dc.bg;
    ctx.shadowColor = 'rgba(0,0,0,0.04)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 1;
    roundRect(ctx, dx, section5Y, dcW, dcH, 10);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // 边框
    ctx.strokeStyle = dc.border;
    ctx.lineWidth = 1;
    roundRect(ctx, dx, section5Y, dcW, dcH, 10);
    ctx.stroke();

    // 标签
    ctx.fillStyle = COLORS.textSec;
    ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(dc.label, dx + dcW / 2, section5Y + 26);

    // 数值
    ctx.fillStyle = dc.textColor;
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillText(dc.value, dx + dcW / 2, section5Y + 58);
  });

  // ========== 6. 底部脚注 ==========
  const footerY = H - 36;
  ctx.fillStyle = COLORS.textLight;
  ctx.font = `11px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('数据来源：门店收银系统  |  ' + data.date + ' 自动生成  |  中控后台', W / 2, footerY);

  // 底部装饰线
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, footerY - 18);
  ctx.lineTo(W - PAD, footerY - 18);
  ctx.stroke();

  // 返回结果
  const buffer = canvas.toBuffer('image/png');
  return { base64: buffer.toString('base64'), buffer };
}

module.exports = { drawStoreDailyReport };
