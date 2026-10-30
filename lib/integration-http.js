"use strict";
// All configured destinations use pinned public DNS answers, TLS and no redirects.
const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");
const blocked = new net.BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
])
  blocked.addSubnet(ip, prefix, "ipv4");
const global6 = new net.BlockList();
global6.addSubnet("2000::", 3, "ipv6");
for (const [ip, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
])
  blocked.addSubnet(ip, prefix, "ipv6");
function publicAddress(ip) {
  const family = net.isIP(ip);
  return family === 4
    ? !blocked.check(ip, "ipv4")
    : family === 6 && global6.check(ip, "ipv6") && !blocked.check(ip, "ipv6");
}
function endpoint(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new Error("请输入完整 HTTPS 地址");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.port && u.port !== "443") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    !host.includes(".") ||
    net.isIP(host)
  )
    throw new Error(
      "API 地址仅允许公网 HTTPS 域名、443端口，不能带账号、密钥或查询参数",
    );
  return u.toString().replace(/\/$/, "");
}
async function request(
  url,
  { method = "GET", headers = {}, body, signal, timeout = 20000 } = {},
) {
  const target = new URL(endpoint(url));
  let answers;
  try {
    answers = await dns.lookup(target.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("API 域名解析失败");
  }
  if (!answers.length || answers.some((a) => !publicAddress(a.address)))
    throw new Error("API 域名指向内网或保留地址，已阻止调用");
  const chosen = answers[0];
  return new Promise((resolve, reject) => {
    const req = https.request(
      target,
      {
        method,
        headers,
        signal,
        lookup: (_host, options, cb) =>
          options?.all
            ? cb(null, [chosen])
            : cb(null, chosen.address, chosen.family),
      },
      (res) => {
        let bytes = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024)
            res.destroy(new Error("API 响应超过安全大小限制"));
          else chunks.push(chunk);
        });
        res.on("error", () => reject(new Error("API 响应中断或超出限制")));
        res.on("end", () => {
          if (res.statusCode >= 300 && res.statusCode < 400)
            return reject(new Error("API 重定向已被阻止，请填写最终地址"));
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            json: async () => JSON.parse(raw),
          });
        });
      },
    );
    const timer = setTimeout(() => req.destroy(), Math.min(timeout, 90000));
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("API 连接失败、超时或被取消")));
    if (body) req.write(body);
    req.end();
  });
}
module.exports = { endpoint, publicAddress, request };
