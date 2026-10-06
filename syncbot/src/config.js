'use strict';
/**
 * 非敏感配置读取。
 * 配置文件位于 config/*.json，只放路径、开关、枚举等非敏感项。
 * 严禁在此写入账号、口令、Cookie、验证码、企业微信 key 等任何凭据
 * （凭据一律走 systemd 的 EnvironmentFile 且文件权限 0600，或不落地）。
 */
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const DEFAULTS = {
  bot: {
    platform: 'meituan',
    timezone: 'Asia/Shanghai',
    retention: { downloadsDays: 90, logsDays: 90, screenshotsDays: 30 },
  },
  browser: {
    display: ':99',
    screen: '1600x1000x24',
    startUrl: 'about:blank',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    windowSize: '1600x1000',
    chromiumArgs: [
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1600,1000',
    ],
  },
};

function load(name) {
  const file = path.join(P.config, `${name}.json`);
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`配置文件解析失败 ${file}: ${e.message}`);
  }
  const base = DEFAULTS[name] || {};
  return { ...base, ...fromFile, __file: file };
}

const config = {
  bot: () => load('bot.config'),
  browser: () => load('browser.config'),
  load,
  DEFAULTS,
};

module.exports = config;
