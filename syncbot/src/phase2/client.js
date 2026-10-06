'use strict';
/** 阶段2：宿主客户端（CLI 侧使用） */
const path = require('path');
const P = require('../paths');
const { request } = require('./proto');

const SOCKET_PATH = path.join(P.runtime, 'host.sock');

function call(cmd, args = {}, opts = {}) {
  return request(SOCKET_PATH, cmd, args, opts);
}

const C = {
  SOCKET_PATH,
  call,
  ping: (o) => call('ping', {}, o),
  health: (o) => call('health', {}, o),
  url: (o) => call('url', {}, o),
  goto: (url, extra = {}, o) => call('goto', { url, ...extra }, o),
  screenshot: (p, extra = {}, o) => call('screenshot', { path: p, ...extra }, o),
  probe: (texts, extra = {}, o) => call('probe', { texts, ...extra }, o),
  filterPanel: (extra = {}, o) => call('filterPanel', extra, o),
  tableSummary: (extra = {}, o) => call('tableSummary', extra, o),
  gridDetail: (extra = {}, o) => call('gridDetail', extra, o),
  gridAllRows: (extra = {}, o) => call('gridAllRows', extra, o),
  filterGroups: (extra = {}, o) => call('filterGroups', extra, o),
  filterDetail: (extra = {}, o) => call('filterDetail', extra, o),
  filterState: (extra = {}, o) => call('filterState', extra, o),
  listOptions: (extra = {}, o) => call('listOptions', extra, o),
  dateRow: (extra = {}, o) => call('dateRow', extra, o),
  picker: (extra = {}, o) => call('picker', extra, o),
  overlays: (extra = {}, o) => call('overlays', extra, o),
  mouse: (extra = {}, o) => call('mouse', extra, o),
  inspect: (selector, extra = {}, o) => call('inspect', { selector, ...extra }, o),
  dateInputs: (o) => call('dateInputs', {}, o),
  region: (selector, extra = {}, o) => call('region', { selector, ...extra }, o),
  waitForSelector: (selector, extra = {}, o) => call('waitForSelector', { selector, ...extra }, o),
  click: (selector, purpose, extra = {}, o) => call('click', { selector, purpose, ...extra }, o),
  fill: (selector, value, o) => call('fill', { selector, value }, o),
  press: (selector, key, o) => call('press', { selector, key }, o),
  setDateRange: (args, o) => call('setDateRange', args, o),
  findPanel: (texts, minHits, o) => call('findPanel', { texts, minHits }, o),
  findTable: (o) => call('findTable', {}, o),
  blockers: (o) => call('blockers', {}, o),
  pageText: (extra = {}, o) => call('pageText', extra, o),
  taskBegin: (task_id, extra = {}, o) => call('taskBegin', { task_id, ...extra }, o),
  taskEnd: (task_id, o) => call('taskEnd', { task_id }, o),
  humanSessionStart: (extra = {}, o) => call('humanSessionStart', extra, o),
  humanSessionStop: (o) => call('humanSessionStop', {}, o),
  humanBusy: (o) => call('humanBusy', {}, o),
  approvals: (o) => call('approvals', {}, o),
  audit: (record, o) => call('audit', { record }, o),
  stats: (o) => call('stats', {}, o),
};

module.exports = C;
