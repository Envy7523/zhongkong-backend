'use strict';
/** 日期动作 + 截图封装 · 离线回归测试（无网络） */
const DR = require('./date-range');
const out = [];
const ck = (n, ok, d) => out.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });
const TARGET = '2026/09/17', ISO = '2026-09-17';
const CELL = { date: ISO, rect: { x: 100, y: 200, w: 36, h: 30 } };
const INPUT = { placeholder: '开始日期', rect: { x: 324, y: 506, w: 90, h: 20 }, value: '2026/09/16' };
const END = { placeholder: '结束日期', rect: { x: 446, y: 506, w: 90, h: 20 }, value: '2026/09/16' };

/** 模拟真实日历：面板打开后，同一面板内点两次同格 → 起点、终点均设为目标 */
function fakeCalendar({ reopenResets = true, panelStaysOpen = true } = {}) {
  const st = { panelOpen: false, clicks: 0, inputClicks: 0, start: '2026/09/16', end: '2026/09/16' };
  return {
    st,
    client: {
      async mouse({ x, y }) {
        if (Math.abs(y - 200) > 60) { // y≈506 为「开始日期」输入框；y≈200 为日历单元格
          st.inputClicks += 1;
          st.panelOpen = true;
          if (reopenResets) { st.start = '2026/09/16'; st.end = '2026/09/16'; }
          return { ok: true };
        }
        st.clicks += 1;
        if (st.clicks === 1) st.start = TARGET; else { st.start = TARGET; st.end = TARGET; }
        if (!panelStaysOpen) st.panelOpen = false;
        return { ok: true };
      },
      async picker() { return st.panelOpen ? { best: { distinct_dates: 1, cells: [CELL] } } : { best: null }; },
      async press() { st.panelOpen = false; return { ok: true }; },
    },
  };
}
const reader = (c) => async () => ({ values: [c.st.start, c.st.end], inputs: [INPUT, END], formItems: [] });

(async () => {
  // R1 同一面板连续两次点选 → 完整区间
  {
    const c = fakeCalendar();
    const r = await DR.setDateRangeExact({ client: c.client, readDates: reader(c), startSelector: '#s', targetInput: TARGET, iso: ISO });
    ck('R1 同一面板连点两次 → 起止均为目标', r.ok === true && JSON.stringify(r.values_after) === JSON.stringify([TARGET, TARGET]), JSON.stringify(r.values_after));
    ck('R1b 只打开面板一次（输入框点击=1）', c.st.inputClicks === 1, `inputClicks=${c.st.inputClicks}`);
    ck('R1c 单元格点击=2', c.st.clicks === 2, `clicks=${c.st.clicks}`);
  }
  // R2 中途重新打开开始日期 → 识别为错误交互（并因重开重置而失败）
  {
    const c = fakeCalendar({ reopenResets: true, panelStaysOpen: false });
    const r = await DR.setDateRangeExact({ client: c.client, readDates: reader(c), startSelector: '#s', targetInput: TARGET, iso: ISO });
    ck('R2 面板中途关闭 → 失败且标记错误交互', r.ok === false && !!r.reopened_at, `ok=${r.ok} reopened=${JSON.stringify(r.reopened_at)}`);
    ck('R2b 报告读回值而非静默通过', Array.isArray(r.values_after) && r.values_after.length === 2, JSON.stringify(r.values_after));
  }
  // R3 目标单元格不存在 → 失败
  {
    const c = fakeCalendar();
    c.client.picker = async () => ({ best: { distinct_dates: 1, cells: [{ date: '2026-09-01', rect: CELL.rect }] } });
    const r = await DR.setDateRangeExact({ client: c.client, readDates: reader(c), startSelector: '#s', targetInput: TARGET, iso: ISO });
    ck('R3 面板中无目标日期 → 失败并说明', r.ok === false && /未找到/.test(r.reason), r.reason);
  }
  // R4 截图返回 {file} 正确记录
  {
    const sink = [];
    const rec = await DR.captureScreenshot({ flow: { screenshot: async () => ({ file: '/x/a.png', bytes: 1 }) }, ctx: {}, nn: '01', step: 's', sink });
    ck('R4 截图 {file} 正确记录', rec.ok === true && rec.file === '/x/a.png' && sink.length === 1, JSON.stringify(rec));
  }
  // R5 截图抛错 → 显式失败（不得空数组伪装）
  {
    const sink = [];
    const rec = await DR.captureScreenshot({ flow: { screenshot: async () => { throw new Error('host down'); } }, ctx: {}, nn: '02', step: 's', sink });
    ck('R5 截图抛错 → ok=false 且记录原因（不伪装）', rec.ok === false && /host down/.test(rec.reason) && sink.length === 1, JSON.stringify(rec));
  }
  // R6 截图返回结构缺 file → 显式失败
  {
    const sink = [];
    const rec = await DR.captureScreenshot({ flow: { screenshot: async () => ({ path: undefined }) }, ctx: {}, nn: '03', step: 's', sink });
    ck('R6 截图返回缺 file/path → ok=false', rec.ok === false, JSON.stringify(rec));
  }
  // R7 生产适配器与预检脚本共用同一日期动作
  {
    const fs = require('fs'); const path = require('path');
    const ad = fs.readFileSync(path.join(__dirname, 'real-download-adapters.js'), 'utf8');
    const pre = fs.readFileSync(path.join(__dirname, 'precheck-set-date.js'), 'utf8');
    const qf = fs.readFileSync(path.join(__dirname, 'report-a-query-flow.js'), 'utf8');
    ck('R7 共享查询流程调用共享日期动作', /require\('\.\/date-range'\)/.test(qf) && /setDateRangeExact\(/.test(qf), '');
    ck('R7b 预检脚本复用共享查询流程', /report-a-query-flow/.test(pre), '');
    ck('R7c 生产适配器默认共享查询流程，并委托注入的 queryFlow', /require\('\.\/report-a-query-flow'\)/.test(ad) && /queryFlow = QF\.navigateAndQueryReportA/.test(ad) && /await queryFlow\(/.test(ad), '');
  }

  const ok = out.every((r) => r.ok);
  console.log(JSON.stringify({ ok, total: out.length, failed: out.filter((x) => !x.ok).length, results: out }, null, 2));
  process.exit(ok ? 0 : 1);
})();
