"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("./integration-http");
const KEY = "enterprise_api_registry_v1";
function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function text(v, max = 80) {
  const s = String(v ?? "").trim();
  if (!s || s.length > max || /[\x00-\x1f]/.test(s))
    fail("名称或字段格式不正确");
  return s;
}
function masterKey(allowCreate = false) {
  if (process.env.INTEGRATION_MASTER_KEY) {
    const k = Buffer.from(process.env.INTEGRATION_MASTER_KEY, "base64");
    if (k.length !== 32)
      throw new Error("INTEGRATION_MASTER_KEY 必须是32字节Base64密钥");
    return k;
  }
  const dir = path.join(os.homedir(), ".zhongkong", "keys");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "integration-master.key");
  if (!fs.existsSync(file)) {
    if (!allowCreate) throw new Error("API加密主密钥丢失");
    try {
      fs.writeFileSync(file, crypto.randomBytes(32), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  const k = fs.readFileSync(file);
  if (k.length !== 32) throw new Error("API 加密主密钥无效");
  return k;
}
function create({
  db,
  key = masterKey,
  loadConfig = () => ({}),
  saveConfig = () => {},
}) {
  function read() {
    const row = db.queryOne("SELECT value FROM config WHERE key=?", [KEY]);
    if (!row) return { revision: 0, platforms: [], apis: [], audit: [] };
    try {
      return JSON.parse(row.value);
    } catch {
      fail("API 配置损坏，已停止读写，请从备份恢复", 500);
    }
  }
  const aad = (a) =>
    Buffer.from(JSON.stringify([a.id, a.baseUrl, a.auth, a.header || ""]));
  function encrypt(secret, id, context) {
    const iv = crypto.randomBytes(12),
      c = crypto.createCipheriv("aes-256-gcm", key(true), iv);
    c.setAAD(aad({ id, ...context }));
    const data = Buffer.concat([c.update(secret, "utf8"), c.final()]);
    return {
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }
  function decrypt(a) {
    if (!a.secret) return "";
    try {
      const c = crypto.createDecipheriv(
        "aes-256-gcm",
        key(),
        Buffer.from(a.secret.iv, "base64"),
      );
      c.setAAD(aad(a));
      c.setAuthTag(Buffer.from(a.secret.tag, "base64"));
      return Buffer.concat([
        c.update(Buffer.from(a.secret.data, "base64")),
        c.final(),
      ]).toString("utf8");
    } catch {
      fail("API 密钥无法解密，请恢复主密钥或重新录入凭据", 503);
    }
  }
  function refs(a) {
    const cfg = loadConfig();
    return a.kind === "openai"
      ? [
          "AI经营分析可选模型",
          ...(cfg.activeAiProfileId === a.id ? ["机器人当前模型"] : []),
        ]
      : [];
  }
  function publicApi(a) {
    const { secret, ...rest } = a;
    return { ...rest, secretConfigured: !!secret, references: refs(a) };
  }
  function snapshot() {
    const s = read(),
      cfg = loadConfig();
    return {
      ...s,
      apis: s.apis.map(publicApi),
      legacyCount: legacy(cfg).length,
      legacyProfiles: legacy(cfg)
        .filter((a) => !s.apis.some((x) => x.id === a.id))
        .map((a) => ({ id: a.id, name: a.name || a.model })),
      activeAiProfileId: cfg.activeAiProfileId || "",
      aiEnabled: !!cfg.aiEnabled,
    };
  }
  function commit(revision, user, action, id, change) {
    const s = read();
    if (!Number.isInteger(revision) || revision !== s.revision)
      fail("配置已被其他人修改，请刷新后再保存", 409);
    change(s);
    s.revision++;
    s.audit.unshift({
      at: new Date().toISOString(),
      actor: String(user?.username || user?.id || "系统"),
      action,
      id,
    });
    s.audit = s.audit.slice(0, 300);
    db.run("BEGIN");
    try {
      db.run(
        "INSERT INTO config(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [KEY, JSON.stringify(s)],
      );
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
    db.save();
    return snapshot();
  }
  function platform(body, user, id) {
    return commit(
      body.revision,
      user,
      id ? "修改平台" : "新增平台",
      id || "",
      (s) => {
        const old = id ? s.platforms.find((p) => p.id === id) : null;
        if (id && !old) fail("平台不存在", 404);
        const name = text(body.name);
        if (s.platforms.some((p) => p.id !== id && p.name === name))
          fail("平台名称已存在");
        const enabled = body.enabled !== false;
        if (
          !enabled &&
          old &&
          s.apis.some(
            (a) =>
              a.platformId === id && loadConfig().activeAiProfileId === a.id,
          )
        )
          fail("请先切换机器人当前模型，再停用平台");
        const p = {
          id: id || crypto.randomUUID(),
          name,
          description: String(body.description || "")
            .trim()
            .slice(0, 200),
          enabled,
        };
        if (old) Object.assign(old, p);
        else s.platforms.push(p);
      },
    );
  }
  function api(body, user, id) {
    return commit(
      body.revision,
      user,
      id ? "修改API" : "新增API",
      id || "",
      (s) => {
        const old = id ? s.apis.find((a) => a.id === id) : null;
        if (id && !old) fail("API不存在", 404);
        const platform = s.platforms.find((p) => p.id === body.platformId);
        if (!platform) fail("请选择平台");
        const name = text(body.name),
          kind = body.kind;
        if (!["openai", "rest"].includes(kind)) fail("请选择支持的协议");
        const baseUrl = http.endpoint(body.baseUrl),
          model = kind === "openai" ? text(body.model, 150) : "";
        const auth = body.auth || "bearer";
        if (!["bearer", "header", "none"].includes(auth)) fail("认证方式无效");
        const header = auth === "header" ? text(body.header, 60) : "";
        if (
          header &&
          (!/^[A-Za-z][A-Za-z0-9-]*$/.test(header) ||
            /^(host|cookie|connection|content-length|transfer-encoding|proxy-|forwarded|x-forwarded|content-type)/i.test(
              header,
            ))
        )
          fail("此请求头不允许用于认证");
        if (kind === "openai" && auth === "none") fail("模型调用需要认证密钥");
        const endpointPath =
          kind === "rest" ? String(body.endpointPath || "/") : "";
        if (
          kind === "rest" &&
          (!/^\/[A-Za-z0-9_./:-]*$/.test(endpointPath) ||
            endpointPath.startsWith("//") ||
            endpointPath.includes(".."))
        )
          fail("API路径只能是无参数的相对路径");
        const method =
          kind === "openai"
            ? "POST"
            : String(body.method || "GET").toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
          fail("HTTP方法无效");
        const enabled = body.enabled !== false;
        if (
          old &&
          loadConfig().activeAiProfileId === id &&
          (!enabled || kind !== "openai")
        )
          fail("请先切换机器人当前模型");
        const secretValue = String(body.secret || "").trim();
        if (
          secretValue.length > 8000 ||
          /[\r\n]/.test(secretValue) ||
          /^\*+$/.test(secretValue)
        )
          fail("密钥格式不正确，不能填写脱敏占位值");
        // A new destination or auth scheme must never inherit credentials silently.
        if (
          old &&
          (old.baseUrl !== baseUrl ||
            old.auth !== auth ||
            old.header !== header) &&
          old.secret &&
          !secretValue &&
          auth !== "none"
        )
          fail("地址或认证方式变更后，必须重新填写密钥");
        const apiId = id || crypto.randomUUID();
        const secret =
          auth === "none"
            ? null
            : secretValue
              ? encrypt(secretValue, apiId, { baseUrl, auth, header })
              : old?.secret;
        if (auth !== "none" && !secret) fail("请填写认证密钥");
        if (
          s.apis.some(
            (a) =>
              a.id !== id && a.platformId === platform.id && a.name === name,
          )
        )
          fail("该平台已有同名API");
        const a = {
          id: apiId,
          platformId: platform.id,
          name,
          kind,
          baseUrl,
          model,
          auth,
          header,
          endpointPath,
          method,
          enabled,
          secret,
          updatedAt: new Date().toISOString(),
        };
        if (old) Object.assign(old, a);
        else s.apis.push(a);
      },
    );
  }
  function remove(type, id, body, user) {
    return commit(
      body.revision,
      user,
      type === "apis" ? "删除API" : "删除平台",
      id,
      (s) => {
        if (!s[type].some((a) => a.id === id)) fail("记录不存在", 404);
        if (type === "platforms" && s.apis.some((a) => a.platformId === id))
          fail("平台下仍有API，请先删除或迁移");
        if (type === "apis" && loadConfig().activeAiProfileId === id)
          fail("当前机器人正在使用此API，请先切换模型");
        s[type] = s[type].filter((a) => a.id !== id);
      },
    );
  }
  function profiles() {
    const s = read();
    return s.apis
      .filter(
        (a) =>
          a.kind === "openai" &&
          a.enabled &&
          s.platforms.some((p) => p.id === a.platformId && p.enabled),
      )
      .map((a) => ({
        id: a.id,
        name: a.name,
        baseUrl: a.baseUrl,
        model: a.model,
        apiKey: decrypt(a),
        auth: a.auth,
        header: a.header,
        managed: true,
      }));
  }
  function legacy(cfg) {
    if (cfg.aiProfiles?.length) return cfg.aiProfiles;
    return cfg.aiApiKey
      ? [
          {
            id: "legacy-default",
            name: "原有模型配置",
            baseUrl: cfg.aiBaseUrl,
            model: cfg.aiModel,
            apiKey: cfg.aiApiKey,
          },
        ]
      : [];
  }
  function migrate(body, user) {
    const cfg = loadConfig(),
      old = legacy(cfg);
    const result = commit(
      body.revision,
      user,
      "迁移旧模型凭据至加密存储",
      "legacy",
      (s) => {
        if (!old.length) fail("没有待迁移模型");
        let p = s.platforms.find((p) => p.id === "legacy-models");
        if (!p) {
          p = {
            id: "legacy-models",
            name: "已有模型平台",
            description: "从旧版模型配置迁入，可编辑归属",
            enabled: true,
          };
          s.platforms.push(p);
        }
        for (const a of old) {
          if (s.apis.some((x) => x.id === a.id)) continue;
          const baseUrl = http.endpoint(a.baseUrl);
          s.apis.push({
            id: a.id,
            platformId: p.id,
            name: a.name || a.model,
            kind: "openai",
            baseUrl,
            model: a.model,
            auth: "bearer",
            header: "",
            endpointPath: "",
            enabled: true,
            secret: encrypt(a.apiKey, a.id, {
              baseUrl,
              auth: "bearer",
              header: "",
            }),
            updatedAt: new Date().toISOString(),
          });
        }
      },
    );
    // Commit encrypted copies first. A failed config cleanup leaves originals usable and can be retried.
    delete cfg.aiProfiles;
    delete cfg.aiApiKey;
    delete cfg.aiBaseUrl;
    delete cfg.aiModel;
    saveConfig(cfg);
    return { ...result, legacyCount: 0 };
  }
  function binding(body, user) {
    const id = String(body.activeAiProfileId || "");
    const s = read();
    if (
      id !== "local-simulation" &&
      !s.apis.some(
        (a) =>
          a.id === id &&
          a.kind === "openai" &&
          a.enabled &&
          s.platforms.some((p) => p.id === a.platformId && p.enabled),
      )
    )
      fail("请选择已启用的模型API");
    commit(body.revision, user, "切换机器人模型", id, () => {});
    const cfg = loadConfig();
    cfg.activeAiProfileId = id;
    cfg.aiEnabled = body.aiEnabled === true;
    saveConfig(cfg);
    return snapshot();
  }
  async function test(id, body, user) {
    const s = read();
    if (body.revision !== s.revision) fail("配置已更新，请刷新", 409);
    const a = s.apis.find((x) => x.id === id);
    if (
      !a ||
      !a.enabled ||
      !s.platforms.some((p) => p.id === a.platformId && p.enabled)
    )
      fail("API或平台未启用");
    if (a.kind === "rest")
      fail("通用API只登记引用，不支持自动探测；避免对未知接口执行操作");
    const headers = { "Content-Type": "application/json" },
      secret = decrypt(a);
    headers[a.auth === "header" ? a.header : "Authorization"] =
      a.auth === "header" ? secret : `Bearer ${secret}`;
    const start = Date.now();
    let result;
    try {
      const r = await http.request(a.baseUrl + "/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: a.model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply OK." }],
        }),
      });
      const payload = await r.json().catch(() => null);
      result = {
        ok: r.ok && typeof payload?.choices?.[0]?.message?.content === "string",
        status: r.status,
        elapsedMs: Date.now() - start,
      };
    } catch {
      result = { ok: false, status: 0, elapsedMs: Date.now() - start };
    }
    commit(
      body.revision,
      user,
      result.ok ? "API测试成功" : "API测试失败",
      id,
      () => {},
    );
    return {
      ...result,
      message: result.ok
        ? "模型协议验证通过"
        : "未通过模型验证，请核对地址、权限、模型及网络；响应正文不回传",
    };
  }
  return { snapshot, platform, api, remove, profiles, migrate, binding, test };
}
function router(service) {
  const r = require("express").Router();
  r.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      res
        .status(e.status || 500)
        .json({
          error: e.status
            ? e.message
            : "API配置操作失败，请检查服务端配置和加密主密钥",
        });
    }
  };
  r.get(
    "/",
    wrap(() => service.snapshot()),
  );
  r.post(
    "/platforms",
    wrap((req) => service.platform(req.body, req.user)),
  );
  r.put(
    "/platforms/:id",
    wrap((req) => service.platform(req.body, req.user, req.params.id)),
  );
  r.post(
    "/apis",
    wrap((req) => service.api(req.body, req.user)),
  );
  r.put(
    "/apis/:id",
    wrap((req) => service.api(req.body, req.user, req.params.id)),
  );
  for (const type of ["platforms", "apis"])
    r.delete(
      `/${type}/:id`,
      wrap((req) => service.remove(type, req.params.id, req.body, req.user)),
    );
  r.post(
    "/migrate",
    wrap((req) => service.migrate(req.body, req.user)),
  );
  r.put(
    "/binding",
    wrap((req) => service.binding(req.body, req.user)),
  );
  r.post(
    "/apis/:id/test",
    wrap((req) => service.test(req.params.id, req.body, req.user)),
  );
  return r;
}
module.exports = { create, router };
