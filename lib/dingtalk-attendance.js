/**
 * 钉钉考勤适配器。
 * 凭证只从进程环境变量读取，任何接口响应都不会回传 AppSecret。
 */
const DEFAULT_API_BASE = 'https://api.dingtalk.com';

function value(name) { return String(process.env[name] || '').trim(); }

function shanghaiParts(timestamp) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}
function shanghaiDate(timestamp) {
  const parts = shanghaiParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function shanghaiDateTime(timestamp) {
  const parts = shanghaiParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function getDingTalkConfig() {
  const appKey = value('DINGTALK_APP_KEY');
  const appSecret = value('DINGTALK_APP_SECRET');
  const corpId = value('DINGTALK_CORP_ID');
  return {
    appKey,
    appSecret,
    corpId,
    apiBase: value('DINGTALK_API_BASE') || DEFAULT_API_BASE,
    configured: Boolean(appKey && appSecret && corpId),
    appKeyConfigured: Boolean(appKey),
    appSecretConfigured: Boolean(appSecret),
    corpIdConfigured: Boolean(corpId),
  };
}

function publicStatus(mappedEmployees = 0) {
  const cfg = getDingTalkConfig();
  return {
    configured: cfg.configured,
    appKeyConfigured: cfg.appKeyConfigured,
    appSecretConfigured: cfg.appSecretConfigured,
    corpIdConfigured: cfg.corpIdConfigured,
    mappedEmployees,
    message: cfg.configured
      ? '已检测到本机钉钉配置，可开始同步打卡。'
      : '尚未配置。服务已就绪，配置本机环境变量后即可同步，不会把密钥保存到数据库。',
  };
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.errmsg || `钉钉请求失败（HTTP ${response.status}）`);
  if (body.code && Number(body.code) !== 0) throw new Error(body.message || body.errmsg || `钉钉接口错误：${body.code}`);
  if (body.errcode !== undefined && Number(body.errcode) !== 0) throw new Error(body.errmsg || body.message || `钉钉接口错误：${body.errcode}`);
  return body;
}

async function getAccessToken(cfg = getDingTalkConfig()) {
  if (!cfg.configured) throw new Error('钉钉尚未配置：请配置 DINGTALK_APP_KEY、DINGTALK_APP_SECRET 和 DINGTALK_CORP_ID 后重启服务');
  const body = await requestJson(`${cfg.apiBase}/v1.0/oauth2/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: cfg.appKey, appSecret: cfg.appSecret }),
  });
  const token = body.accessToken || body.access_token;
  if (!token) throw new Error(body.message || '钉钉未返回 accessToken，请检查应用凭证和权限');
  return token;
}

function normalizeRecord(record = {}) {
  const rawCheckTime = record.userCheckTime || record.checkTime || record.baseCheckTime || record.gmtCreate || '';
  const checkTime = typeof rawCheckTime === 'number' ? shanghaiDateTime(rawCheckTime) : String(rawCheckTime).trim();
  const rawDate = String(record.workDate || checkTime || '').slice(0, 10);
  // workDate 是“本地工作日零点”的毫秒时间戳，不能用 UTC toISOString，否则会被减 8 小时落到前一天。
  const millisDate = typeof record.workDate === 'number'
    ? shanghaiDate(record.workDate)
    : (typeof rawCheckTime === 'number' ? shanghaiDate(rawCheckTime) : rawDate);
  return {
    dingtalkUserId: String(record.userId || record.userid || record.user_id || '').trim(),
    workDate: /^\d{4}-\d{2}-\d{2}$/.test(millisDate) ? millisDate : new Date().toISOString().slice(0, 10),
    checkTime: checkTime || new Date().toISOString(),
    checkType: String(record.checkType || record.check_type || '').trim(),
    timeResult: String(record.timeResult || record.time_result || '').trim(),
    locationResult: String(record.locationResult || record.location_result || '').trim(),
    raw: record,
  };
}

async function fetchAttendance({ userIds, dateFrom, dateTo }) {
  const cfg = getDingTalkConfig();
  const token = await getAccessToken(cfg);
  const dateFromValue = `${dateFrom} 00:00:00`;
  const dateToValue = `${dateTo} 23:59:59`;
  // 考勤明细仍使用钉钉 OAPI 的 attendance/listRecord；OAuth 令牌由新版 v1.0 接口签发。
  const body = await requestJson(`https://oapi.dingtalk.com/attendance/listRecord?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds, checkDateFrom: dateFromValue, checkDateTo: dateToValue, isI18n: false }),
  });
  const items = body.recordresult || body.records || body.list || body.result || [];
  if (!Array.isArray(items)) throw new Error('钉钉考勤接口返回格式不符合预期，请检查应用权限或接口版本');
  return items.map(normalizeRecord).filter(item => item.dingtalkUserId);
}

module.exports = { getDingTalkConfig, publicStatus, fetchAttendance };
