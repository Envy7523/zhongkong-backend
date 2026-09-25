'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const fontPath = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansSC-VF.ttf');
if (fs.existsSync(fontPath)) GlobalFonts.registerFromPath(fontPath, 'Noto Sans SC');
const FONT = '"Noto Sans SC", sans-serif';
const W = 2060;
const C = {
  yellow: '#fff500', blue: '#08a7dc', orange: '#ffc11a', ink: '#151515',
  border: '#313131', muted: '#5c6570', red: '#d52b28', white: '#ffffff',
  missing: '#fff1ee',
};
const columns = [
  ['rank', '排名', 90], ['store_name', '门店名称', 290],
  ['gross_amount', '营业额', 116], ['recorded_amount', '营业收入', 116], ['order_count', '订单量', 78],
  ['store_sales', '店内销售', 116], ['pickup', '自提销售', 106],
  ['meituan_delivery', '美团外卖', 110], ['taobao_flash', '淘宝闪购', 110], ['jd_delivery', '京东外卖', 110],
  ['现金', '现金', 94], ['扫码支付', '扫码支付', 106], ['会员卡', '储值消费', 106],
  ['一键买单（尾款）', '一键买单', 100], ['美团/大众点评团购', '美团团购', 104],
  ['抖音团购', '抖音团购', 98], ['自定义记账', '自定义记账', 110],
  ['discount_amount', '优惠金额', 108], ['discount_rate', '优惠占比', 102],
];

function money(value) { return `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function valueFor(row, key) {
  if (key === 'rank') return row.rank_label || (row.rank ? String(row.rank) : '合计');
  if (key === 'store_name') return row.store_name || '';
  if (key === 'order_count') return String(row.order_count || 0);
  if (key === 'discount_rate') return `${(Number(row.discount_rate || 0) * 100).toFixed(2)}%`;
  if (Object.hasOwn(row.channels || {}, key) || ['store_sales', 'pickup', 'meituan_delivery', 'taobao_flash', 'jd_delivery'].includes(key)) return money(row.channels?.[key]);
  if (Object.hasOwn(row.compositions || {}, key) || ['现金', '扫码支付', '会员卡', '一键买单（尾款）', '美团/大众点评团购', '抖音团购', '自定义记账'].includes(key)) return money(row.compositions?.[key]);
  return money(row[key]);
}
function drawCell(ctx, text, x, y, width, height, bg, opts = {}) {
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + .5, y + .5, width, height);
  ctx.save();
  ctx.beginPath(); ctx.rect(x + 4, y + 1, width - 8, height - 2); ctx.clip();
  ctx.fillStyle = opts.color || C.ink;
  ctx.font = `${opts.bold ? 700 : 500} ${opts.fontSize || 16}px ${FONT}`;
  ctx.textAlign = opts.align || 'center'; ctx.textBaseline = 'middle';
  const tx = opts.align === 'left' ? x + 8 : x + width / 2;
  ctx.fillText(String(text), tx, y + height / 2);
  ctx.restore();
}
function renderPosDailyImage(preview, { mode = 'preview' } = {}) {
  if (!preview || !Array.isArray(preview.focus_groups) || !preview.totals) throw new Error('preview_required');
  if (!['preview', 'send'].includes(mode)) throw new Error('image_mode_invalid');
  if (mode === 'send' && !preview.ready) throw new Error('incomplete_preview_cannot_send');
  const groups = preview.focus_groups;
  const rows = groups.flatMap(group => group.rows);
  const headerY = 230;
  const headerH = 80;
  const separatorH = 24;
  const h = headerY + headerH + rows.length * 48 + (groups.length - 1) * separatorH + 48 + 115;
  const canvas = createCanvas(W, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.white; ctx.fillRect(0, 0, W, h);
  ctx.fillStyle = C.yellow; ctx.fillRect(0, 0, W, 62);
  ctx.fillStyle = C.ink; ctx.font = `700 34px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(preview.title, W / 2, 31);
  ctx.font = `700 42px ${FONT}`;
  ctx.fillText(String(preview.business_date || '').replaceAll('-', '/'), W / 2, 106);
  ctx.font = `500 16px ${FONT}`; ctx.fillStyle = C.muted;
  ctx.fillText('收银系统记录视角 · 外卖及团购渠道金额不等于平台结算实收 · 不含菜品及第三方平台结算', W / 2, 150);
  if (!preview.ready) {
    ctx.fillStyle = C.missing; ctx.fillRect(0, 175, W, 40);
    ctx.fillStyle = C.red; ctx.font = `700 18px ${FONT}`;
    ctx.fillText(`数据未齐：${(preview.problems || []).slice(0, 3).join('；')}。此图仅供核对，不可发送。`, W / 2, 195);
  }
  const left = 12;
  const totalWidth = columns.reduce((n, c) => n + c[2], 0);
  const scale = (W - 24) / totalWidth;
  const widths = columns.map(c => c[2] * scale);
  let x = left;
  const groupHeaders = [
    { start: 0, end: 4, label: '门店概况', color: C.yellow },
    { start: 5, end: 9, label: '实收 · 收银系统渠道记录', color: C.yellow },
    { start: 10, end: 12, label: '店内销售－线下', color: C.blue },
    { start: 13, end: 16, label: '团购与其他收款', color: C.blue },
    { start: 17, end: 18, label: '优惠', color: C.yellow },
  ];
  for (const group of groupHeaders) {
    const gx = left + widths.slice(0, group.start).reduce((a, b) => a + b, 0);
    const gw = widths.slice(group.start, group.end + 1).reduce((a, b) => a + b, 0);
    drawCell(ctx, group.label, gx, headerY, gw, 34, group.color, { bold: true, fontSize: 16 });
  }
  for (let i = 0; i < columns.length; i++) {
    const [key, label] = columns[i];
    const bg = i <= 4 || i >= 17 ? C.yellow : i <= 9 ? C.yellow : i <= 12 ? C.orange : C.blue;
    drawCell(ctx, label, x, headerY + 34, widths[i], 46, bg, { bold: true, fontSize: 15 });
    x += widths[i];
  }
  let rowY = headerY + headerH;
  const renderRow = (row, total = false) => {
    let cx = left;
    columns.forEach(([key], ci) => {
      const base = total ? (ci >= 10 && ci <= 16 ? C.blue : C.yellow) : C.white;
      const negative = !total && ci >= 10 && ci <= 16;
      drawCell(ctx, valueFor(row, key), cx, rowY, widths[ci], 48, base,
        { bold: total, fontSize: ci === 1 ? 15 : 14, color: negative ? C.red : C.ink });
      cx += widths[ci];
    });
    rowY += 48;
  };
  groups.forEach((group, index) => {
    if (index > 0) {
      ctx.fillStyle = C.white; ctx.fillRect(left, rowY, W - 24, separatorH);
      ctx.strokeStyle = C.border; ctx.strokeRect(left + .5, rowY + .5, W - 24, separatorH);
      rowY += separatorH;
    }
    group.rows.forEach(row => renderRow(row));
  });
  renderRow({ ...preview.totals, store_name: `全部门店合计（${preview.store_count} 家）`, rank: 0 }, true);
  const footY = rowY + 24;
  ctx.fillStyle = C.muted; ctx.font = `500 15px ${FONT}`; ctx.textAlign = 'left';
  ctx.fillText('只展示高位 3 家、中位 3 家、低位 3 家；合计按所有收银记录门店计算。', 20, footY);
  const excluded = (preview.excluded_stores || []).map(row => `${row.store_name}（${row.reason}）`).join('、');
  ctx.fillText(excluded ? `日报范围排除：${excluded}` : '日报范围：后台正常营业门店', 20, footY + 27);
  ctx.fillText(!preview.ready ? '门店覆盖不完整 · 禁止自动推送'
    : mode === 'preview' ? '样式预览 · 未发送到企业微信群' : '数据来源：收银系统综合营业统计', 20, footY + 54);
  const buffer = canvas.toBuffer('image/png');
  return { buffer, base64: buffer.toString('base64'), width: W, height: h };
}

module.exports = { renderPosDailyImage };
