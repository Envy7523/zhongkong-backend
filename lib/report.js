/**
 * 门店日报图片生成模块
 * 基于 @napi-rs/canvas 渲染综合日报 PNG 图片
 * 用于企业微信 Webhook image 推送
 */

const fs = require('fs');
const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// 日报图由服务端渲染。云服务器通常没有 Windows 中文字体，必须随项目注册，
// 否则会回退为衬线字体，导致本地预览和企微实际图片不一致。
const bundledFont = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansSC-VF.ttf');
if (fs.existsSync(bundledFont)) {
  GlobalFonts.registerFromPath(bundledFont, 'Noto Sans SC');
}
const FONT = '"Noto Sans SC", sans-serif';

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

/**
 * 团购每日总结推送卡：由一键推送按门店生成，随后作为企业微信图片消息发送。
 * imageTitle/imageFooter 来自推送通道配置，便于不改代码调整卡片的视觉文案。
 */
// 团购每日总结正式图卡：一张图对应一个门店，便于企业微信群内逐店阅读。
function drawGroupBuyDailyPushCard({ imageTitle = '', imageFooter = '', bizDate = '', records = [] } = {}) {
  const W = 650, H = 1280, PAD = 38;
  const row = records[0] || {};
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const text = (value, x, y, size = 24, color = '#233954', weight = 400) => { ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillStyle = color; ctx.fillText(String(value ?? ''), x, y); };
  const rounded = (x, y, w, h, r, color) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = color; ctx.fill(); };
  const rating = value => value == null || value === '' ? '—' : Number(value).toFixed(1);
  const metric = (label, target, actual, rate, x, y, color) => {
    text(label, x, y, 14, '#74879b', 500);
    text(target == null ? '—' : target, x, y + 44, 34, '#203b55', 800);
    text('目标', x, y + 66, 12, '#8b9bac', 500);
    text(actual, x + 184, y + 44, 34, color, 800);
    text('实际达成', x + 184, y + 66, 12, '#8b9bac', 500);
    text(rate, x + 330, y + 44, 22, color, 800);
    text('今日达成率', x + 330, y + 66, 12, '#8b9bac', 500);
  };
  const section = ({ y, label, scoreLabel, score, accent, pale, task1, task2, negative, reason }) => {
    rounded(PAD, y, W - PAD * 2, 380, 18, '#ffffff');
    rounded(PAD, y, 9, 380, 8, accent);
    text(label, PAD + 28, y + 49, 26, '#203b55', 800);
    rounded(W - PAD - 154, y + 21, 128, 42, 21, pale);
    text(`${scoreLabel} ${score}`, W - PAD - 136, y + 48, 16, accent, 800);
    ctx.strokeStyle = '#e8eef3'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(PAD + 28, y + 82); ctx.lineTo(W - PAD - 28, y + 82); ctx.stroke();
    metric(task1.label, task1.target, task1.actual, task1.rate, PAD + 28, y + 115, accent);
    ctx.strokeStyle = '#edf1f5'; ctx.beginPath(); ctx.moveTo(PAD + 28, y + 208); ctx.lineTo(W - PAD - 28, y + 208); ctx.stroke();
    metric(task2.label, task2.target, task2.actual, task2.rate, PAD + 28, y + 232, accent);
    text(`今日差评  ${negative}`, PAD + 28, y + 350, 18, negative > 0 ? '#c06a50' : '#4b907b', 800);
    text(reason || (negative > 0 ? '未填写原因' : '暂无'), PAD + 192, y + 350, 17, '#526b82', 600);
  };
  const rate = (actual, target) => Number(target) > 0 ? `${(Number(actual || 0) / Number(target) * 100).toFixed(1)}%` : '0.0%';
  const header = ctx.createLinearGradient(0, 0, W, 170); header.addColorStop(0, '#123d60'); header.addColorStop(1, '#16766e'); ctx.fillStyle = header; ctx.fillRect(0, 0, W, 170);
  text(row.store_name || '示例门店', PAD, 65, 34, '#ffffff', 800);
  text(`${bizDate} · 团购每日经营日报`, PAD, 102, 16, '#b9eadc', 500);
  ctx.fillStyle = '#f3f7fb'; ctx.fillRect(0, 170, W, H - 170);
  section({ y: 198, label: '美团', scoreLabel: '门店星级', score: rating(row.meituan_rating), accent: '#b67a1d', pale: '#fff2d4', task1: { label: '收藏打卡', target: row.targets?.checkin, actual: row.checkin_actual || 0, rate: rate(row.checkin_actual, row.targets?.checkin) }, task2: { label: '评价引导', target: row.targets?.meituan_review, actual: row.meituan_review_actual || 0, rate: rate(row.meituan_review_actual, row.targets?.meituan_review) }, negative: Number(row.meituan_negative_reviews || 0), reason: row.meituan_negative_reason });
  section({ y: 598, label: '抖音', scoreLabel: '门店星级', score: rating(row.douyin_rating), accent: '#3479c8', pale: '#e9f3ff', task1: { label: '点亮有礼', target: row.targets?.lighting, actual: row.lighting_actual || 0, rate: rate(row.lighting_actual, row.targets?.lighting) }, task2: { label: '评价引导', target: row.targets?.douyin_review, actual: row.douyin_review_actual || 0, rate: rate(row.douyin_review_actual, row.targets?.douyin_review) }, negative: Number(row.douyin_negative_reviews || 0), reason: row.douyin_negative_reason });
  text('明日任务目标', PAD, 1012, 18, '#177969', 800);
  rounded(PAD, 1030, W - PAD * 2, 104, 18, '#fff4dd');
  text('美团 · 明日目标', PAD + 24, 1059, 15, '#a66d19', 800);
  text(row.next_checkin_target ?? 0, PAD + 28, 1104, 38, '#b77a1e', 800);
  text('收藏打卡数', PAD + 28, 1124, 12, '#9c875f', 500);
  text(row.next_meituan_review_target ?? 0, PAD + 210, 1104, 38, '#b77a1e', 800);
  text('评价引导数', PAD + 210, 1124, 12, '#9c875f', 500);
  rounded(PAD, 1150, W - PAD * 2, 104, 18, '#eaf3ff');
  text('抖音 · 明日目标', PAD + 24, 1179, 15, '#3479c8', 800);
  text(row.next_lighting_target ?? 0, PAD + 28, 1224, 38, '#3479c8', 800);
  text('点亮有礼数', PAD + 28, 1244, 12, '#6686a5', 500);
  text(row.next_douyin_review_target ?? 0, PAD + 210, 1224, 38, '#3479c8', 800);
  text('评价引导数', PAD + 210, 1244, 12, '#6686a5', 500);
  const buffer = canvas.toBuffer('image/png');
  return { base64: buffer.toString('base64'), buffer };
}

// 保留旧版紧凑卡片作为历史实现，避免后续需要回看旧样式时丢失参考。
function drawGroupBuyDailyPushCardLegacy({ imageTitle = '', imageFooter = '', bizDate = '', records = [] } = {}) {
  const W = 900;
  const titleLines = String(imageTitle || '团购运营日报').split(/\r?\n/).filter(Boolean).slice(0, 3);
  const itemHeight = 166;
  const H = Math.max(420, Math.min(1560, 160 + titleLines.length * 38 + records.length * itemHeight + 70));
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  const text = (value, x, y, size = 24, color = '#233954', weight = 400) => { ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillStyle = color; ctx.fillText(String(value ?? ''), x, y); };
  const rounded = (x, y, w, h, r, color) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = color; ctx.fill(); };
  ctx.fillStyle = '#f3f7fb'; ctx.fillRect(0, 0, W, H);
  const gradient = ctx.createLinearGradient(0, 0, W, 150); gradient.addColorStop(0, '#143f62'); gradient.addColorStop(1, '#16776e'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, W, 150);
  titleLines.forEach((line, index) => text(line, 44, 52 + index * 34, index === 0 ? 28 : 18, '#ffffff', index === 0 ? 700 : 400));
  text(`数据日期 · ${bizDate}`, 44, 128, 15, '#b8eadb', 500);
  let y = 176; const rating = value => value == null || value === '' ? '—' : Number(value).toFixed(1);
  records.forEach((row, index) => { if (y + itemHeight > H - 42) return; rounded(28, y, W - 56, itemHeight - 14, 14, '#ffffff'); text(`${index + 1}. ${row.store_name || `门店 ${row.store_id}`}`, 52, y + 34, 22, '#203a53', 700); rounded(52, y + 52, 382, 67, 10, '#edf5ff'); rounded(464, y + 52, 382, 67, 10, '#fff8df'); text('抖音', 68, y + 78, 16, '#2672bb', 700); text(`点亮 ${row.lighting_actual}/${row.targets?.lighting ?? '—'}   好评 ${row.douyin_review_actual}/${row.targets?.douyin_review ?? '—'}   评分 ${rating(row.douyin_rating)}`, 68, y + 104, 14, '#386582', 500); text('美团', 480, y + 78, 16, '#a77720', 700); text(`打卡 ${row.checkin_actual}/${row.targets?.checkin ?? '—'}   好评 ${row.meituan_review_actual}/${row.targets?.meituan_review ?? '—'}   星级 ${rating(row.meituan_rating)}`, 480, y + 104, 14, '#695c43', 500); const negative = []; if (Number(row.meituan_negative_reviews)) negative.push(`美团差评 ${row.meituan_negative_reviews}`); if (Number(row.douyin_negative_reviews)) negative.push(`抖音差评 ${row.douyin_negative_reviews}`); text(negative.length ? negative.join(' · ') : '今日暂无差评记录', 52, y + 143, 13, negative.length ? '#c86d51' : '#468b77', 500); y += itemHeight; });
  if (imageFooter) text(imageFooter, 44, H - 24, 12, '#8395a6', 400);
  const buffer = canvas.toBuffer('image/png'); return { base64: buffer.toString('base64'), buffer };
}

module.exports = { drawStoreDailyReport, drawGroupBuyDailyPushCard };
