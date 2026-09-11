/**
 * 验证脚本共用的鉴权工具。
 *
 * 本机后端要求带 JWT 才能调 /api/*；这里**不在脚本里硬编码密钥**，按顺序尝试：
 *   1) 环境变量 JWT_SECRET
 *   2) config.json 里的 jwtSecret（config.json 已被 .gitignore 排除）
 *   3) 从 server.js 里读取当前使用的值（server.js 目前把密钥硬编码在源码里，
 *      该密钥已随公开仓库暴露，属已知安全问题，详见 docs/poultry-accounting-handover.md §13）
 *
 * 这样将来把密钥外置 / 轮换后，验证脚本无需改动即可继续用。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..', '..');

function loadJwtSecret(root = DEFAULT_ROOT) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  try {
    const raw = fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.jwtSecret) return String(cfg.jwtSecret);
  } catch { /* 没有 config.json 或格式不对，继续往下试 */ }

  try {
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const match = src.match(/JWT_SECRET\s*=\s*'([^']+)'/);
    if (match) return match[1];
  } catch { /* 读不到 server.js，继续 */ }

  throw new Error('无法确定 JWT 密钥：请设置环境变量 JWT_SECRET，或在 config.json 里配置 jwtSecret');
}

/** 签一个只用于本地校验的短期 token */
function signProbeToken(claims = {}, expiresIn = '15m', root = DEFAULT_ROOT) {
  const jwt = require(path.join(root, 'node_modules', 'jsonwebtoken'));
  return jwt.sign({
    id: 1,
    username: 'local-verify',
    role: '管理员',
    display_name: '本地校验',
    avatar_url: '',
    store_id: null,
    store_name: '',
    ...claims,
  }, loadJwtSecret(root), { expiresIn });
}

module.exports = { loadJwtSecret, signProbeToken };
