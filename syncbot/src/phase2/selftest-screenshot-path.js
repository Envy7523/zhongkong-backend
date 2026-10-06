'use strict';
/**
 * 截图路径派生 · 离线回归测试（不访问网络）
 * 验证：有效 ctx 落盘并返回真实 file 路径；缺 ctx / 非法 reportType / 路径越界 / 截图异常 均明确失败
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncbot-shot-'));
process.env.SYNCBOT_ROOT = TMP;

const P = require('../paths');
const TC = require('../task-context');
const out = [];
const ck = (n, ok, d) => out.push({ name: n, ok: !!ok, detail: d === undefined ? '' : String(d) });

// 用假的 client 替换 host 调用：直接落盘
const flowPath = require.resolve('./meituan-flow');
const clientMod = require('./client');
const origShot = clientMod.screenshot;
clientMod.screenshot = async (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'PNGDATA'); const st = fs.statSync(file); return { path: file, bytes: st.size, url: 'x' }; };
const flow = require('./meituan-flow');

const CTX = TC.createContext('cashier_composite', { platform: 'meituan', taskId: 'shot-test', businessDate: '2026-09-17' });

(async () => {
  // R1 有效 ctx → 落盘并返回真实路径
  try {
    const r = await flow.screenshot(CTX, '05', 'filters');
    const exists = fs.existsSync(r.file);
    const inDir = r.file.replace(/\\/g, '/').includes('/screenshots/meituan/cashier_composite/2026-09-17/');
    const nonEmpty = exists && fs.statSync(r.file).size > 0;
    ck('R1 有效 ctx → 截图落盘且返回真实 file 路径', exists && nonEmpty && /shot-test-05-filters\.png$/.test(r.file), r.file.replace(TMP, '<ROOT>'));
    ck('R1b 路径在 screenshots/meituan/cashier_composite/2026-09-17/ 下', inDir, r.file.replace(TMP, '<ROOT>'));
    ck('R1c 路径完全由 ctx 派生（含 taskId/businessDate/reportType）', r.file.includes('shot-test') && r.file.includes('2026-09-17') && r.file.includes('cashier_composite'), '');
  } catch (e) { ck('R1 有效 ctx 截图', false, e.message); }

  // R2 缺 ctx → 明确失败
  for (const [n, bad] of [['R2 缺 ctx(null)', null], ['R2b ctx 为空对象', {}], ['R2c ctx 字段不全', { reportType: 'cashier_composite' }], ['R2d 缺 nn', CTX]]) {
    let msg = null;
    try { await flow.screenshot(bad, n === 'R2d 缺 nn' ? undefined : '05', 'x'); } catch (e) { msg = e.message; }
    ck(`${n} → 明确失败`, !!msg, msg || '未抛错');
  }
  // R3 非法 reportType → 失败
  for (const rt of ['../../etc', 'unknown_report', 'item_sales_detail']) {
    let msg = null;
    try { await flow.screenshot({ reportType: rt, platform: 'meituan', taskId: 't', businessDate: '2026-09-17' }, '01', 'x'); } catch (e) { msg = e.message; }
    ck(`R3 非法/未授权 reportType(${rt}) → 失败`, !!msg, (msg || '未抛错').slice(0, 90));
  }
  // R4 非法业务日期（路径越界）→ 失败
  let msg4 = null;
  try { await flow.screenshot({ reportType: 'cashier_composite', platform: 'meituan', taskId: 't', businessDate: '../../etc' }, '01', 'x'); } catch (e) { msg4 = e.message; }
  ck('R4 非法业务日期 → 失败（防穿越）', !!msg4, (msg4 || '未抛错').slice(0, 90));
  // R5 路径必须在 SYNCBOT_ROOT 内
  const anyShot = fs.readdirSync(TMP, { recursive: true }).filter((x) => String(x).endsWith('.png'));
  ck('R5 所有产物均在 SYNCBOT_ROOT 内', anyShot.every((x) => path.resolve(TMP, x).startsWith(path.resolve(TMP) + path.sep)), JSON.stringify(anyShot));
  // R6 截图异常 → 明确抛出（由上层 captureScreenshot 记录为 ok:false）
  clientMod.screenshot = async () => { throw new Error('host down'); };
  let msg6 = null;
  try { await flow.screenshot(CTX, '06', 'boom'); } catch (e) { msg6 = e.message; }
  ck('R6 截图异常 → 明确抛出', msg6 === 'host down', String(msg6));
  // R7 共享封装能把异常记为 ok:false（不伪装）
  const DR = require('./date-range');
  const sink = [];
  const rec = await DR.captureScreenshot({ flow, ctx: CTX, nn: '07', step: 'z', sink });
  ck('R7 captureScreenshot 把异常记为 ok:false 并入 sink', rec.ok === false && sink.length === 1 && /host down/.test(rec.reason), JSON.stringify(rec));
  // R8 无全局 report_type 依赖
  ck('R8 源码无 report-type 引用', !/report-type/.test(fs.readFileSync(flowPath, 'utf8')), '');

  clientMod.screenshot = origShot;
  const ok = out.every((r) => r.ok);
  console.log(JSON.stringify({ ok, tmp_root: TMP, total: out.length, failed: out.filter((x) => !x.ok).length, results: out }, null, 2));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(ok ? 0 : 1);
})();
