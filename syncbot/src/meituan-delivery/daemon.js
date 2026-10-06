'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');
const { createLineDecoder } = require('../phase2/proto');
const { runOperating } = require('./runner');
const root = process.env.SYNCBOT_ROOT || '/opt/zhongkong-sync-bot';
const runtime = path.join(root, 'state/runtime/meituan-delivery');
const socketPath = path.join(runtime, 'host.sock');
let context, page, busy = false, human = false;
async function inspect() {
  const frames = [];
  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(() => ({
        text: (document.body?.innerText || '').slice(0, 12000),
        inputs: [...document.querySelectorAll('input')].filter(el => el.getBoundingClientRect().width > 0).map(el => ({
          type: el.type, placeholder: el.placeholder, id: el.id, name: el.name,
        })),
      }));
      frames.push({ origin: new URL(frame.url()).origin, ...result });
    } catch { /* 未加载的 frame */ }
  }
  return { busy, human, frames };
}
async function main() {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const profile = path.join(root, 'browser-profiles/meituan_delivery');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  context = await chromium.launchPersistentContext(profile, { headless: false, acceptDownloads: true,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 1000 },
    args: ['--no-first-run', '--no-default-browser-check', '--window-position=0,0', '--window-size=1440,1000'],
  });
  page = context.pages()[0] || await context.newPage();
  await page.goto('https://waimaie.meituan.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (await page.locator('input[type="password"]').isVisible().catch(() => false)) await page.setViewportSize({ width: 640, height: 900 });
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
  const server = net.createServer(socket => socket.on('data', createLineDecoder(async message => {
    const reply = (ok, result, error) => socket.write(JSON.stringify({ id: message.id, ok, result, error }) + '\n');
    try {
      if (message.cmd === 'inspect') return reply(true, await inspect());
      if (message.cmd === 'screenshot') {
        const file = path.join(runtime, 'current.png'); await page.screenshot({ path: file });
        return reply(true, { file });
      }
      if (message.cmd === 'human-start') { if (busy) throw Error('robot_busy'); human = true; return reply(true, { human }); }
      if (message.cmd === 'human-stop') { human = false; return reply(true, { human }); }
      if (busy || human) throw Error('browser_busy');
      busy = true;
      try {
        if (message.cmd === 'login') {
          const { username, password, usernameSelector, passwordSelector, submitText } = message.args || {};
          if (!username || !password || !usernameSelector || !passwordSelector || !submitText) throw Error('login_parameters_required');
          await page.locator(usernameSelector).fill(username);
          await page.locator(passwordSelector).fill(password);
          const agreement = page.locator('label[for="checkbox"]');
          if (await agreement.count() === 1 && !await page.locator('#checkbox').isChecked()) await agreement.click();
          await page.getByText(submitText, { exact: true }).click();
          reply(true, { submitted: true });
        } else if (message.cmd === 'run') reply(true, await runOperating({ ...message.args, page, context, root }));
        else throw Error('command_unknown');
      } finally { busy = false; }
    } catch (error) {
      // Playwright 原始错误可能含会话 URL；仅输出受控错误码。
      reply(false, null, /^[a-z][a-z0-9_:.-]{0,150}$/.test(error.message) ? error.message : 'browser_operation_failed');
    }
  })));
  server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); console.log('meituan_delivery_browser_ready'); });
  const stop = async () => { server.close(); await context.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch(() => { console.error('meituan_delivery_browser_start_failed'); process.exit(1); });
