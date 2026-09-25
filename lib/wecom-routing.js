'use strict';

const express = require('express');

const MESSAGE_CODES = Object.freeze({
  pos_daily: '收银系统每日高低位数据',
});

function validWebhook(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'qyapi.weixin.qq.com' &&
      url.pathname === '/cgi-bin/webhook/send' && /^[A-Za-z0-9_-]{8,200}$/.test(url.searchParams.get('key') || '') &&
      [...url.searchParams.keys()].every(key => key === 'key');
  } catch { return false; }
}

// Keep the existing enterprise-settings Webhook in the same assignable registry.
// Importing a recipient never binds a message route or turns on a send schedule.
function syncDefaultWebhookBot(db, config = {}) {
  const webhook = String(config.webhook || '').trim();
  const wantedName = String(config.webhookName || '企业微信机器人').trim().slice(0, 80);
  let row = db.queryOne("SELECT * FROM wecom_webhook_bots WHERE source='default_config' LIMIT 1");
  if (!validWebhook(webhook)) {
    if (row && (row.enabled || row.webhook_url)) {
      db.run("UPDATE wecom_message_routes SET enabled=0,updated_at=datetime('now','localtime') WHERE bot_id=?", [row.id]);
      db.run("UPDATE wecom_webhook_bots SET webhook_url='',enabled=0,updated_at=datetime('now','localtime') WHERE id=?", [row.id]);
      db.save();
    }
    return null;
  }
  if (!row) {
    // A user may already have registered the same group; never create two entries for it.
    row = db.queryOne('SELECT * FROM wecom_webhook_bots WHERE webhook_url=? LIMIT 1', [webhook]);
    if (row) db.run("UPDATE wecom_webhook_bots SET source='default_config' WHERE id=?", [row.id]);
  }
  let name = wantedName;
  for (let suffix = 2; db.queryOne('SELECT id FROM wecom_webhook_bots WHERE name=? AND id<>?', [name, row?.id || 0]); suffix++)
    name = `${wantedName.slice(0, 76)} ${suffix}`;
  if (!row) {
    const id = db.insert("INSERT INTO wecom_webhook_bots(name,webhook_url,enabled,source) VALUES (?,?,1,'default_config')", [name, webhook]);
    db.save();
    return id;
  }
  if (row.name !== name || row.webhook_url !== webhook) {
    if (row.webhook_url !== webhook)
      db.run("UPDATE wecom_message_routes SET enabled=0,updated_at=datetime('now','localtime') WHERE bot_id=?", [row.id]);
    db.run("UPDATE wecom_webhook_bots SET name=?,webhook_url=?,updated_at=datetime('now','localtime') WHERE id=?", [name, webhook, row.id]);
    db.save();
  }
  return row.id;
}

function createRouter({ db, loadConfig, saveConfig }) {
  if (!db) throw new Error('db_required');
  const router = express.Router();
  const publicBot = row => ({ id: row.id, name: row.name, enabled: Boolean(row.enabled), configured: Boolean(row.webhook_url), updated_at: row.updated_at });
  const publicRoute = row => ({ message_code: row.message_code, name: MESSAGE_CODES[row.message_code] || row.message_code,
    bot_id: row.bot_id, bot_name: row.bot_name || '', enabled: Boolean(row.enabled), ready: Boolean(row.enabled && row.bot_id && row.bot_enabled) });

  router.get('/', (_req, res) => {
    try {
      const bots = db.queryAll('SELECT id,name,enabled,webhook_url,updated_at FROM wecom_webhook_bots ORDER BY id').map(publicBot);
      const routes = db.queryAll('SELECT r.message_code,r.bot_id,r.enabled,b.name AS bot_name,b.enabled AS bot_enabled FROM wecom_message_routes r LEFT JOIN wecom_webhook_bots b ON b.id=r.bot_id ORDER BY r.message_code').map(publicRoute);
      const exclusions = db.queryAll('SELECT x.store_id,s.store_name,x.reason FROM pos_daily_scope_exclusions x JOIN stores s ON s.id=x.store_id ORDER BY x.store_id');
      res.json({ ok: true, bots, routes, exclusions, message_types: MESSAGE_CODES });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  router.post('/bots', (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();
      const webhook = String(req.body?.webhook_url || '').trim();
      if (!name || name.length > 80 || !validWebhook(webhook)) return res.status(400).json({ error: '机器人名称或企业微信 Webhook 地址无效' });
      if (db.queryOne('SELECT id FROM wecom_webhook_bots WHERE webhook_url=?', [webhook]))
        return res.status(409).json({ error: '该 Webhook 已在机器人列表中，请直接分配它的消息职责' });
      const id = db.insert('INSERT INTO wecom_webhook_bots(name,webhook_url,enabled) VALUES (?,?,1)', [name, webhook]);
      db.save();
      res.status(201).json({ ok: true, bot: publicBot(db.queryOne('SELECT * FROM wecom_webhook_bots WHERE id=?', [id])) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.put('/bots/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const prior = db.queryOne('SELECT * FROM wecom_webhook_bots WHERE id=?', [id]);
      if (!prior) return res.status(404).json({ error: '机器人不存在' });
      const name = String(req.body?.name ?? prior.name).trim();
      const webhook = req.body?.webhook_url ? String(req.body.webhook_url).trim() : prior.webhook_url;
      const enabled = req.body?.enabled === undefined ? Number(prior.enabled) : req.body.enabled === true ? 1 : 0;
      if (!name || name.length > 80 || !validWebhook(webhook)) return res.status(400).json({ error: '机器人名称或企业微信 Webhook 地址无效' });
      if (db.queryOne('SELECT id FROM wecom_webhook_bots WHERE name=? AND id<>?', [name, id]))
        return res.status(409).json({ error: '机器人名称已存在' });
      if (db.queryOne('SELECT id FROM wecom_webhook_bots WHERE webhook_url=? AND id<>?', [webhook, id]))
        return res.status(409).json({ error: '该 Webhook 已分配给另一机器人' });
      if (prior.source === 'default_config' && (name !== prior.name || webhook !== prior.webhook_url)) {
        if (typeof loadConfig !== 'function' || typeof saveConfig !== 'function')
          return res.status(500).json({ error: '默认机器人配置接口不可用' });
        // A credential/recipient change must stop sends before touching config.json.
        db.run("UPDATE wecom_message_routes SET enabled=0,updated_at=datetime('now','localtime') WHERE bot_id=?", [id]);
        db.save();
        saveConfig({ ...loadConfig(), webhook, webhookName: name });
      }
      db.run("UPDATE wecom_webhook_bots SET name=?,webhook_url=?,enabled=?,updated_at=datetime('now','localtime') WHERE id=?", [name, webhook, enabled, id]);
      if (webhook !== prior.webhook_url || enabled !== Number(prior.enabled))
        db.run("UPDATE wecom_message_routes SET enabled=0,updated_at=datetime('now','localtime') WHERE bot_id=?", [id]);
      db.save();
      res.json({ ok: true, bot: publicBot(db.queryOne('SELECT * FROM wecom_webhook_bots WHERE id=?', [id])) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.put('/routes/:code', (req, res) => {
    try {
      const code = String(req.params.code || '');
      if (!Object.hasOwn(MESSAGE_CODES, code)) return res.status(404).json({ error: '消息类型不存在' });
      const botId = req.body?.bot_id === null ? null : Number(req.body?.bot_id);
      const bot = botId ? db.queryOne('SELECT id,enabled FROM wecom_webhook_bots WHERE id=?', [botId]) : null;
      if (botId && !bot) return res.status(400).json({ error: '所选机器人不存在' });
      // 每次重新绑定都自动关闭路由，避免换群后沿用旧审批。
      db.run("UPDATE wecom_message_routes SET bot_id=?,enabled=0,updated_at=datetime('now','localtime') WHERE message_code=?", [bot?.id || null, code]);
      db.save();
      res.json({ ok: true, message_code: code, bot_id: bot?.id || null, enabled: Boolean(db.queryOne('SELECT enabled FROM wecom_message_routes WHERE message_code=?', [code])?.enabled) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.post('/routes/:code/activation', (req, res) => {
    try {
      const code = String(req.params.code || '');
      if (!Object.hasOwn(MESSAGE_CODES, code)) return res.status(404).json({ error: '消息类型不存在' });
      const enabled = req.body?.enabled === true;
      if (enabled && (req.body?.confirm_template_approved !== true || req.body?.confirm_target_verified !== true))
        return res.status(400).json({ error: '请先确认日报样式和目标群均已审批' });
      const row = db.queryOne('SELECT r.bot_id,b.enabled AS bot_enabled FROM wecom_message_routes r LEFT JOIN wecom_webhook_bots b ON b.id=r.bot_id WHERE r.message_code=?', [code]);
      if (!row) return res.status(404).json({ error: '消息路由不存在' });
      if (enabled && (!row.bot_id || Number(row.bot_enabled) !== 1)) return res.status(400).json({ error: '请先绑定已启用的专用机器人' });
      db.run("UPDATE wecom_message_routes SET enabled=?,updated_at=datetime('now','localtime') WHERE message_code=?", [enabled ? 1 : 0, code]);
      db.save();
      res.json({ ok: true, message_code: code, enabled });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  router.put('/pos-daily/exclusions', (req, res) => {
    try {
      const rows = req.body?.exclusions;
      if (!Array.isArray(rows) || rows.length > 100) return res.status(400).json({ error: '请提供门店排除清单' });
      const checked = [];
      for (const row of rows) {
        const id = Number(row.store_id);
        const reason = String(row.reason || '').trim();
        if (!Number.isSafeInteger(id) || id <= 0 || !reason || reason.length > 80 || checked.some(x => x.id === id)) return res.status(400).json({ error: '门店排除项无效或重复' });
        if (!db.queryOne('SELECT id FROM stores WHERE id=?', [id])) return res.status(400).json({ error: `门店 ${id} 不存在` });
        checked.push({ id, reason });
      }
      // 只更新日报范围，不修改门店主数据状态；如请求非法，在上方验证阶段零写入。
      db.run('BEGIN TRANSACTION');
      try {
        db.run('DELETE FROM pos_daily_scope_exclusions');
        for (const row of checked) db.run('INSERT INTO pos_daily_scope_exclusions(store_id,reason) VALUES (?,?)', [row.id, row.reason]);
        db.run('COMMIT');
      } catch (error) { db.run('ROLLBACK'); throw error; }
      db.save();
      res.json({ ok: true, exclusions: checked.map(row => ({ store_id: row.id, reason: row.reason })) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  return router;
}

module.exports = { createRouter, validWebhook, syncDefaultWebhookBot, MESSAGE_CODES };
