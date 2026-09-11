// Read-only UI smoke test with intercepted API fixtures, never production data.
// Start a dedicated headless Chrome with --remote-debugging-port=9335 first.
// Usage: node scripts/ui-theme-smoke.mjs [output-directory]
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const output = process.argv[2] || join(tmpdir(), 'etaigong-theme-smoke')
await mkdir(output, { recursive: true })
const pages = await fetch('http://127.0.0.1:9335/json/list').then(r => r.json())
const socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
let seq = 0
const pending = new Map()
const errors = []
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
const fixture = {
  totals: { gross_amount: 168926.72, actual_amount: 145783.26, delivery: 145783.26, group_buy: 145783.26, confirmed: 145783.26, order_count: 6554, discount_amount: 8849.46, platform_fee_amount: 23143.46 },
  trend: Array.from({ length: 12 }, (_, i) => ({ period: `2026-08-${String(i + 1).padStart(2, '0')}`, gross_amount: 11000 + i * 750, delivery_gross: 11000 + i * 750, actual_amount: 8200 + i * 630, total: 8200 + i * 630, delivery: 8200 + i * 630 })),
  reconciliation: [], reconciliation_total: 0, reconciliation_page: 1, reconciliation_page_size: 20,
  stores: [], revenue_composition: [], channel_breakdown: [], fee_detail_breakdown: [], meituan_group_fee_categories: [],
}
socket.addEventListener('message', async event => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const call = pending.get(message.id)
    if (call) { pending.delete(message.id); message.error ? call.reject(message.error) : call.resolve(message.result) }
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + message.params.exceptionDetails.exception?.description)
  if (message.method === 'Fetch.requestPaused') {
    const { requestId, request } = message.params
    const path = new URL(request.url).pathname
    let body = {}
    if (path === '/api/auth/me') body = { user: { username: 'ui-test', display_name: '界面测试', role: '管理员' } }
    else if (path.includes('/views/')) body = fixture
    else if (path.includes('stores')) body = { stores: [], total: 0 }
    else if (path.includes('products')) body = { products: [], totals: {} }
    await cdp('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') })
  }
})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function evaluate(expression) {
  const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw Error(response.exceptionDetails.text)
  return response.result.value
}
await cdp('Runtime.enable')
await cdp('Page.enable')
await cdp('Fetch.enable', { patterns: [{ urlPattern: '*://localhost:4173/api/*' }] })
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('etaigong_token', 'ui-fixture-only')" })
try {
  for (const width of [1920, 1366, 1024, 768]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp('Page.navigate', { url: 'http://localhost:4173/analysis/delivery/platform' })
    for (let tries = 0; tries < 30; tries++) {
      if (await evaluate("!!document.querySelector('.query-button')")) break
      await pause(200)
    }
    await evaluate("document.querySelector('.query-button').click()")
    await pause(800)
    const metrics = await evaluate(`(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height } };
      const content = document.querySelector('.content-area');
      return { sidebar: getComputedStyle(document.querySelector('.app-sidebar')).backgroundColor,
        hero: getComputedStyle(document.querySelector('.analytics-hero')).backgroundImage,
        overflow: content.scrollWidth - content.clientWidth,
        date: rect('.filter-bar > .el-date-editor'), store: rect('.filter-bar .store-region-select'),
        card: rect('.metric-card') };
    })()`)
    assert.equal(metrics.sidebar, 'rgb(17, 24, 39)')
    assert.equal(metrics.hero, 'none')
    assert.equal(metrics.date.width, 184)
    assert.equal(metrics.store.width, 240)
    assert.ok(metrics.overflow <= 2, `workspace overflow at ${width}: ${metrics.overflow}`)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: metrics.date.x + 50, y: metrics.date.y + 15 })
    await pause(200)
    const after = await evaluate("JSON.stringify(document.querySelector('.metric-card').getBoundingClientRect().toJSON())")
    const rect = JSON.parse(after)
    assert.equal(rect.x, metrics.card.x)
    assert.equal(rect.y, metrics.card.y)
    assert.equal(rect.width, metrics.card.width)
    const shot = await cdp('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(output, `platform-${width}.png`), Buffer.from(shot.data, 'base64'))
    console.log(JSON.stringify({ width, ...metrics }))
  }
  await evaluate("document.querySelector('.compare-button').click()")
  await pause(250)
  assert.equal(await evaluate("document.querySelector('.business-analytics-page').classList.contains('compare-mode')"), false)
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.analytics-hero')).backgroundImage"), 'none')
  console.log('PASS: opening comparison preserves workstation theme')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.navigate', { url: 'http://localhost:4173/analysis/total/monthly-dashboard' })
  for (let tries = 0; tries < 30; tries++) {
    if (await evaluate("!!document.querySelector('.query-card')")) break
    await pause(200)
  }
  const monthlyBefore = await evaluate("JSON.stringify([...document.querySelectorAll('.query-field')].map(e => e.getBoundingClientRect().toJSON()))")
  const firstDate = JSON.parse(monthlyBefore)[0]
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: firstDate.x + 80, y: firstDate.y + 40 })
  await pause(250)
  assert.equal(await evaluate("JSON.stringify([...document.querySelectorAll('.query-field')].map(e => e.getBoundingClientRect().toJSON()))"), monthlyBefore)
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.board-hero')).backgroundImage"), 'none')
  assert.ok(await evaluate("document.querySelector('.content-area').scrollWidth <= document.querySelector('.content-area').clientWidth + 2"))
  console.log('PASS: monthly dashboard filter bounds remain stable on hover')
  assert.deepEqual(errors, [], 'No browser runtime exceptions')
  console.log(`PASS: desktop/laptop/tablet widths, hover stability, no runtime errors. Screenshots: ${output}`)
} finally { socket.close() }
