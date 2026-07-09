/**
 * 图表绘制模块 — 基于 @napi-rs/canvas 的服务端图表渲染
 * 输出 PNG Buffer，用于企业微信 Webhook image 推送
 */

const { createCanvas } = require('@napi-rs/canvas');

// 调色板
const PALETTE = [
  '#4f6ef7', '#52c41a', '#faad14', '#ff4d4f',
  '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16',
  '#2f54eb', '#a0d911', '#f5222d', '#1890ff',
];
const BG = '#ffffff';
const GRID = '#f0f0f0';
const TEXT = '#333333';
const TEXT_SEC = '#888888';

// 字体名（Windows 系统自带）
const FONT = '"Microsoft YaHei", SimHei, sans-serif';

/** 将 canvas 转为 PNG base64（去除 data: 前缀） */
function toBase64(canvas) {
  return canvas.toBuffer('image/png').toString('base64');
}

/**
 * 绘制柱状图
 * @param {Object} opts
 * @param {string} opts.title       — 标题
 * @param {string} [opts.subtitle]  — 副标题（日期等）
 * @param {string[]} opts.labels    — X 轴标签
 * @param {{label:string,data:number[],color?:string}[]} opts.datasets
 * @param {number} [opts.width]     — 默认 800
 * @param {number} [opts.height]    — 默认 420
 * @param {number} [opts.yMax]      — Y 轴上限（自动计算）
 * @returns {{ base64: string, buffer: Buffer }}
 */
function drawBarChart(opts) {
  const w = opts.width || 800;
  const h = opts.height || 420;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  // 背景
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // 边距
  const pad = { top: 60, right: 24, bottom: 60, left: 60 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  // ---- 标题 ----
  ctx.fillStyle = TEXT;
  ctx.font = `bold 20px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(opts.title, pad.left, 34);

  if (opts.subtitle) {
    ctx.fillStyle = TEXT_SEC;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(opts.subtitle, pad.left, 52);
  }

  // ---- Y 轴 ----
  const datasets = opts.datasets || [];
  const allValues = datasets.flatMap(ds => ds.data);
  let yMax = opts.yMax || Math.ceil(Math.max(...allValues, 1) * 1.15);
  if (yMax === 0) yMax = 10;

  const ySteps = 5;
  const yStepVal = Math.ceil(yMax / ySteps);
  ctx.fillStyle = TEXT_SEC;
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'right';
  for (let i = 0; i <= ySteps; i++) {
    const val = i * yStepVal;
    const y = pad.top + chartH - (val / yMax) * chartH;
    ctx.fillText(String(val), pad.left - 8, y + 4);
    // 横向网格线
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  // ---- X 轴 ----
  const labels = opts.labels || [];
  const groupCount = labels.length;
  if (groupCount === 0) return toBase64(canvas);

  const dsCount = datasets.length;
  const barGap = Math.max(2, Math.min(12, chartW / (groupCount * (dsCount + 1))));
  const barW = Math.max(4, (chartW - barGap * (groupCount + 1)) / groupCount / dsCount);
  const groupW = barW * dsCount + barGap * (dsCount - 1);

  // 绘制柱
  datasets.forEach((ds, di) => {
    ds.data.forEach((val, li) => {
      const x = pad.left + barGap + li * (chartW / groupCount) + (groupW / dsCount - barW) / 2 + di * (groupW / dsCount);
      if (di === 0) {
        // 改进 X 坐标计算，使所有 bar 在组内均匀分布
      }
      const realX = pad.left + barGap + li * (chartW / groupCount) - (groupW / 2) + di * (barW + barGap);
      const barH = Math.max(0, (val / yMax) * chartH);
      const y = pad.top + chartH - barH;

      ctx.fillStyle = ds.color || PALETTE[di % PALETTE.length];
      // 圆角矩形
      roundRect(ctx, realX, y, barW, barH, 3);

      // 数值标签
      if (barH > 14) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold 11px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(String(val), realX + barW / 2, y + 14);
      }
    });
  });

  // X 轴标签
  ctx.fillStyle = TEXT;
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'center';
  labels.forEach((label, i) => {
    const x = pad.left + chartW / groupCount * (i + 0.5);
    ctx.fillText(label, x, h - pad.bottom + 18);
  });

  // 图例
  if (dsCount > 1) {
    ctx.textAlign = 'left';
    let legendX = w - pad.right - 160;
    datasets.forEach((ds, i) => {
      const y = 20 + i * 20;
      ctx.fillStyle = ds.color || PALETTE[i % PALETTE.length];
      ctx.fillRect(legendX, y, 12, 12);
      ctx.fillStyle = TEXT;
      ctx.font = `12px ${FONT}`;
      ctx.fillText(ds.label, legendX + 18, y + 11);
    });
  }

  const buffer = canvas.toBuffer('image/png');
  return { base64: buffer.toString('base64'), buffer };
}

/**
 * 绘制折线图
 * @param {Object} opts — 同 drawBarChart
 */
function drawLineChart(opts) {
  const w = opts.width || 800;
  const h = opts.height || 420;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  const pad = { top: 60, right: 40, bottom: 60, left: 60 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  // 标题
  ctx.fillStyle = TEXT;
  ctx.font = `bold 20px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(opts.title, pad.left, 34);

  if (opts.subtitle) {
    ctx.fillStyle = TEXT_SEC;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(opts.subtitle, pad.left, 52);
  }

  // Y 轴
  const datasets = opts.datasets || [];
  const allValues = datasets.flatMap(ds => ds.data);
  let yMax = opts.yMax || Math.ceil(Math.max(...allValues, 1) * 1.15);
  if (yMax === 0) yMax = 10;

  const ySteps = 5;
  const yStepVal = Math.ceil(yMax / ySteps);
  ctx.fillStyle = TEXT_SEC;
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'right';
  for (let i = 0; i <= ySteps; i++) {
    const val = i * yStepVal;
    const y = pad.top + chartH - (val / yMax) * chartH;
    ctx.fillText(String(val), pad.left - 8, y + 4);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
  }

  // 折线和点
  const labels = opts.labels || [];
  const pointCount = Math.max(...datasets.map(ds => ds.data.length), labels.length);
  if (pointCount === 0) return toBase64(canvas);

  datasets.forEach((ds, di) => {
    const color = ds.color || PALETTE[di % PALETTE.length];
    const points = ds.data.map((val, i) => ({
      x: pad.left + (i / Math.max(pointCount - 1, 1)) * chartW,
      y: pad.top + chartH - (val / yMax) * chartH,
    }));

    // 填充区域（微弱半透明）
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(points[0].x, pad.top + chartH);
    points.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length - 1].x, pad.top + chartH);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // 折线
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();

    // 数据点
    points.forEach(p => {
      ctx.fillStyle = BG;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // 数值标签
      ctx.fillStyle = TEXT;
      ctx.font = `bold 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(ds.data[points.indexOf(p)]), p.x, p.y - 10);
    });
  });

  // X 轴标签
  ctx.fillStyle = TEXT;
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = 'center';
  labels.forEach((label, i) => {
    const x = pad.left + (i / Math.max(labels.length - 1, 1)) * chartW;
    ctx.fillText(label, x, h - pad.bottom + 18);
  });

  // 图例
  if (datasets.length > 1) {
    ctx.textAlign = 'left';
    let legendX = w - pad.right - 160;
    datasets.forEach((ds, i) => {
      const y = 20 + i * 20;
      const color = ds.color || PALETTE[i % PALETTE.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(legendX, y + 6);
      ctx.lineTo(legendX + 16, y + 6);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(legendX + 8, y + 6, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = TEXT;
      ctx.font = `12px ${FONT}`;
      ctx.fillText(ds.label, legendX + 24, y + 11);
    });
  }

  const buffer = canvas.toBuffer('image/png');
  return { base64: buffer.toString('base64'), buffer };
}

/**
 * 绘制环形图 / 饼图
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @param {string[]} opts.labels  — 扇区名称
 * @param {number[]} opts.values  — 扇区数值
 * @param {string[]} [opts.colors]
 * @param {boolean} [opts.donut]  — 环形图（默认 true）
 * @param {number} [opts.size]    — 默认 440
 */
function drawPieChart(opts) {
  const size = opts.size || 440;
  const w = size;
  const h = size + 60;

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  // 标题
  ctx.fillStyle = TEXT;
  ctx.font = `bold 18px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(opts.title, w / 2, 36);

  if (opts.subtitle) {
    ctx.fillStyle = TEXT_SEC;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(opts.subtitle, w / 2, 54);
  }

  const values = opts.values || [];
  const labels = opts.labels || [];
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return toBase64(canvas);

  const cx = w / 2;
  const cy = size / 2 + 10;
  const outerR = Math.min(cx, cy) - 30;
  const innerR = opts.donut !== false ? outerR * 0.55 : 0;

  // 绘制扇区
  let startAngle = -Math.PI / 2;
  values.forEach((val, i) => {
    const sliceAngle = (val / total) * Math.PI * 2;
    const endAngle = startAngle + sliceAngle;

    ctx.fillStyle = (opts.colors && opts.colors[i]) || PALETTE[i % PALETTE.length];
    ctx.beginPath();
    ctx.moveTo(cx + innerR * Math.cos(startAngle), cy + innerR * Math.sin(startAngle));
    ctx.arc(cx, cy, outerR, startAngle, endAngle);
    ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fill();

    // 百分比标签
    const pct = ((val / total) * 100).toFixed(1);
    if (pct > 4) {
      const midAngle = startAngle + sliceAngle / 2;
      const labelR = (outerR + innerR) / 2;
      ctx.fillStyle = '#fff';
      ctx.font = `bold 13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${pct}%`, cx + labelR * Math.cos(midAngle), cy + labelR * Math.sin(midAngle) + 5);
    }

    startAngle = endAngle;
  });

  // 图例
  const legendX = 20;
  let legendY = size + 10;
  const perRow = 3;
  const colW = w / perRow;
  labels.forEach((label, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const lx = legendX + col * colW;
    const ly = legendY + row * 20;

    ctx.fillStyle = (opts.colors && opts.colors[i]) || PALETTE[i % PALETTE.length];
    ctx.fillRect(lx, ly, 10, 10);
    ctx.fillStyle = TEXT;
    ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'left';
    const pct = ((values[i] / total) * 100).toFixed(1);
    ctx.fillText(`${label} (${pct}%)`, lx + 14, ly + 10);
  });

  const buffer = canvas.toBuffer('image/png');
  return { base64: buffer.toString('base64'), buffer };
}

/**
 * 辅助：圆角矩形（填充模式）
 */
function roundRect(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.closePath();
  ctx.fill();
}

module.exports = { drawBarChart, drawLineChart, drawPieChart, toBase64 };
