/**
 * 身份证 OCR 识别与一致性核对
 *
 * 设计要点：
 * 1. 供应商可插拔：目前实现腾讯云 OCR，容器预留阿里云；未配置凭据时返回
 *    status='not_configured'，**不报错、不阻断**，前端只提示"识别服务未配置"。
 * 2. 只把"识别结果 + 与员工档案的比对结论"返回给前端；**不在响应里回传完整身份证号**，
 *    避免敏感信息在日志/前端内存里多处留存（只回传掩码与比对用字段）。
 * 3. 判定规则（人工 2026-09-17 确认）：姓名与号码**都要一致**，任一不符即不通过；
 *    识别不出内容时状态为 undetermined，不得当作通过。
 */

const crypto = require('crypto');

const TENCENT_ENDPOINT = 'ocr.tencentcloudapi.com';
const TENCENT_SERVICE = 'ocr';
const TENCENT_VERSION = '2018-11-19';
const TENCENT_ACTION = 'IDCardOCR';
const TENCENT_REGION = 'ap-guangzhou';
const REQUEST_TIMEOUT_MS = 15000;

function normalizeIdCard(value) {
  return String(value || '').replace(/[\s-]/g, '').toUpperCase();
}

// 姓名去掉所有空白：OCR 偶尔会在汉字间插入空格
function normalizeName(value) {
  return String(value || '').replace(/\s+/g, '');
}

function maskIdCard(value) {
  const id = normalizeIdCard(value);
  return id.length >= 8 ? `${id.slice(0, 6)}****${id.slice(-4)}` : (id ? '****' : '');
}

function maskName(value) {
  const name = normalizeName(value);
  if (!name) return '';
  return name.length <= 1 ? name : `${name[0]}${'*'.repeat(name.length - 1)}`;
}

/** 身份证校验位校验，用于发现 OCR 明显误读 */
function idCardChecksumOk(value) {
  const id = normalizeIdCard(value);
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const parity = '10X98765432';
  const sum = weights.reduce((total, weight, index) => total + weight * Number(id[index]), 0);
  return parity[sum % 11] === id[17];
}

/** 读取识别凭据：优先环境变量，其次 config.json 的 idCardOcr 段 */
function readOcrConfig(config = {}) {
  const section = config.idCardOcr || {};
  const provider = String(section.provider || (process.env.TENCENT_OCR_SECRET_ID ? 'tencent' : '')).trim();
  return {
    provider,
    tencent: {
      secretId: String(section.secretId || process.env.TENCENT_OCR_SECRET_ID || '').trim(),
      secretKey: String(section.secretKey || process.env.TENCENT_OCR_SECRET_KEY || '').trim(),
      region: String(section.region || process.env.TENCENT_OCR_REGION || TENCENT_REGION).trim(),
    },
  };
}

function isConfigured(config = {}) {
  const { provider, tencent } = readOcrConfig(config);
  if (!provider) return false;
  if (provider === 'tencent') return Boolean(tencent.secretId && tencent.secretKey);
  return false;
}

/** 腾讯云 API v3 签名（TC3-HMAC-SHA256） */
function signTencent({ secretId, secretKey, action, payload, region }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const host = TENCENT_ENDPOINT;
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const credentialScope = `${date}/${TENCENT_SERVICE}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const kDate = crypto.createHmac('sha256', `TC3${secretKey}`).update(date).digest();
  const kService = crypto.createHmac('sha256', kDate).update(TENCENT_SERVICE).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    timestamp,
    host,
    region: region || TENCENT_REGION,
  };
}

/** 腾讯云身份证识别：只取姓名与号码 */
async function recognizeWithTencent(imageBase64, tencent) {
  const payload = JSON.stringify({ ImageBase64: imageBase64, CardSide: 'FRONT' });
  const signed = signTencent({ secretId: tencent.secretId, secretKey: tencent.secretKey, action: TENCENT_ACTION, payload, region: tencent.region });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://${signed.host}`, {
      method: 'POST',
      headers: {
        Authorization: signed.authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: signed.host,
        'X-TC-Action': TENCENT_ACTION,
        'X-TC-Timestamp': String(signed.timestamp),
        'X-TC-Version': TENCENT_VERSION,
        'X-TC-Region': signed.region,
      },
      body: payload,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    const result = body?.Response || {};
    if (result.Error) throw new Error(`腾讯云识别失败：${result.Error.Message || result.Error.Code}`);
    return { name: normalizeName(result.Name), idCard: normalizeIdCard(result.IdNum) };
  } finally { clearTimeout(timer); }
}

/**
 * 识别并核对。
 * @returns {{status:'pass'|'mismatch'|'undetermined'|'not_configured'|'error', ...}}
 *   status 含义：pass 完全一致 / mismatch 有字段不符 / undetermined 识别不出内容
 *                not_configured 未配置识别服务 / error 调用出错
 */
async function scanAndVerify({ imageBuffer, employee, config }) {
  const expectedName = normalizeName(employee?.name);
  const expectedId = normalizeIdCard(employee?.id_card_number);
  const { provider, tencent } = readOcrConfig(config);

  if (!isConfigured(config)) {
    return {
      status: 'not_configured',
      message: '尚未配置身份证识别服务，请在 config.json 填写 idCardOcr 凭据后重试',
      expected: { name_masked: maskName(expectedName), id_card_masked: maskIdCard(expectedId) },
    };
  }

  let recognized;
  try {
    if (provider === 'tencent') recognized = await recognizeWithTencent(imageBuffer.toString('base64'), tencent);
    else return { status: 'not_configured', message: `暂不支持的识别供应商：${provider}` };
  } catch (error) {
    return { status: 'error', message: error.message || '识别调用失败' };
  }

  const scannedName = normalizeName(recognized.name);
  const scannedId = normalizeIdCard(recognized.idCard);
  const checksumOk = scannedId ? idCardChecksumOk(scannedId) : false;
  const nameMatch = Boolean(scannedName) && Boolean(expectedName) && scannedName === expectedName;
  const idMatch = Boolean(scannedId) && Boolean(expectedId) && scannedId === expectedId;

  const base = {
    provider,
    scanned: { name_masked: maskName(scannedName), id_card_masked: maskIdCard(scannedId), checksum_ok: checksumOk },
    expected: { name_masked: maskName(expectedName), id_card_masked: maskIdCard(expectedId) },
    match: { name: nameMatch, id_card: idMatch },
  };

  if (!scannedName && !scannedId) {
    return { ...base, status: 'undetermined', message: '未能从图片中识别出姓名与身份证号，请换一张更清晰的正面照' };
  }
  // 严格口径：姓名与号码都要一致（人工 2026-09-17 确认）
  if (nameMatch && idMatch) return { ...base, status: 'pass', message: '识别结果与当前员工档案一致' };

  const problems = [];
  if (!scannedId) problems.push('未识别出身份证号');
  else if (!idMatch) problems.push(expectedId ? '身份证号与档案不一致' : '档案中尚无身份证号可比对');
  else if (!checksumOk) problems.push('身份证号校验位不正确，可能识别有误');
  if (!scannedName) problems.push('未识别出姓名');
  else if (!nameMatch) problems.push(expectedName ? '姓名与档案不一致' : '档案中尚无姓名可比对');
  return { ...base, status: 'mismatch', message: problems.join('；') };
}

module.exports = {
  scanAndVerify,
  isConfigured,
  readOcrConfig,
  normalizeIdCard,
  normalizeName,
  maskIdCard,
  maskName,
  idCardChecksumOk,
};
