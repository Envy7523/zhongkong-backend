/**
 * 小程序图片上传落地模块
 *
 * 为什么不用 base64 直接存库：collab_replies.images 目前存 base64 原文，
 * 现有生产库已 265MB，移动端拍照高频写入会加速膨胀（见项目分析风险 #3）。
 * 小程序端先把图片读成 base64 再 POST（无需 multer 依赖），服务端落盘为文件、库里只存 URL。
 */
const fs = require('fs');
const path = require('path');

const MP_UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'mp');
const MAX_BYTES = 4 * 1024 * 1024; // 单图 4MB

function ensureDir() {
  if (!fs.existsSync(MP_UPLOAD_DIR)) fs.mkdirSync(MP_UPLOAD_DIR, { recursive: true });
}

/** 校验图片魔数，避免伪造扩展名 */
function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  return null;
}

/**
 * 保存 data URL（data:image/jpeg;base64,....）
 * @returns {{ ok: true, url: string, bytes: number }}
 */
function saveDataUrl(dataUrl) {
  const str = String(dataUrl || '');
  const match = str.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw Object.assign(new Error('图片格式无效，仅支持 PNG/JPEG/WebP/GIF'), { status: 400 });

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw Object.assign(new Error('图片内容为空'), { status: 400 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('图片不能超过 4MB'), { status: 400 });

  const type = detectImageType(buffer);
  if (!type) throw Object.assign(new Error('图片文件内容无效'), { status: 400 });

  ensureDir();
  const ext = type === 'jpeg' ? 'jpg' : type;
  const filename = `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(MP_UPLOAD_DIR, filename), buffer);

  return { ok: true, url: `/uploads/mp/${filename}`, bytes: buffer.length };
}

module.exports = { MP_UPLOAD_DIR, saveDataUrl, MAX_BYTES };
