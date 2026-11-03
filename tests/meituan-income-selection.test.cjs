'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const contract=require('../syncbot/src/meituan-delivery/operating-contract');
const options={from:'2026-11-02'};
test('renamed field selection runs through the installed extension allowlist without new script permissions', async () => {
  const { RemoteLocator } = require('../syncbot/windows-client/extension-broker.cjs');
  const names = contract.fields.slice(1).map(name => name === '营业收入' ? '订单收入' : name);
  const inventory = names.map((name, i) => ({ name, checked: true, disabled: i < 5, key: String(i + 1), group: false }));
  const calls = [];
  const frame = { descriptor: { frameId: 1 }, broker: { diagnostics: [], async call(_, c) {
    calls.push(c);
    if (c.action === 'texts') return names;
    if (c.action === 'count') return 1;
    if (c.action === 'visible') return true;
    if (c.action === 'read') return true;
    if (c.action === 'readAll') {
      if (c.reader === 'values') return [options.from, options.from];
      if (c.reader === 'inventory') return inventory;
      if (c.reader === 'selected') return names;
    }
    throw Error('unexpected_extension_operation');
  } } };
  const page = { locator: css => new RemoteLocator(frame).locator(css),
    getByRole: (...args) => new RemoteLocator(frame).getByRole(...args), getByText: (...args) => new RemoteLocator(frame).getByText(...args) };
  const result = await require('../syncbot/src/meituan-delivery/operating-download').prepareOperatingReport(page, { from: options.from });
  assert.equal(result.income_field, '订单收入'); assert(result.fields.includes('订单收入')); assert(!result.fields.includes('营业收入'));
  assert(calls.every(c => ['texts', 'count', 'visible', 'read', 'readAll'].includes(c.action)));
});
