/**
 * 门店 GLB 模型存储模块（分片上传 + 断点续传 + 内容寻址落盘）
 *
 * ## 为什么不把文件存进数据库
 * 本项目用 sql.js —— 内存态 SQLite，`db.save()` 每次都把**整个库**重新写盘一次，
 * 当前库已 282MB。GLB 动辄 100MB+，一旦作为 BLOB 入库，之后每写一行业务数据都要
 * 多写 100MB+，库会迅速膨胀且每次保存阻塞主线程。
 * 因此沿用 lib/mp/upload.js 已定下的路线：**文件落盘、库里只存元数据**。
 *
 * ## 磁盘布局
 *   data/uploads/store-models/<sha256>.glb        成品，按内容寻址
 *   data/uploads/store-models/.tmp/<uploadId>/    分片上传的中间态
 *     session.json                                会话元数据（含声明总大小、分片大小）
 *     0.part 1.part 2.part ...                    分片，序号即分片下标
 *
 * 已收到的分片**以磁盘上的 .part 文件为准**，不从 session.json 读：
 * 这样即使进程中途重启、JSON 写了一半，恢复时看到的也是真实落盘状态。
 *
 * ## 为什么按内容哈希命名
 * 内容变了文件名就变，URL 永远不可能指向过期模型，因此可以放心让浏览器做长期强缓存
 * （immutable），从根上避免"换了模型但前端还在用旧模型"这类缓存事故。
 * 顺带还实现了天然去重：多个门店传同一个文件只占一份磁盘。
 *
 * ## 分片大小的取法
 * 8MB 分片对 100MB+ 文件是 13~17 片：单片超时/断网只丢一片，重传代价小；
 * 又不会因为片数太多导致请求次数爆炸。前端可传 chunk_size 覆盖，服务端按 4MB~64MB 夹逼。
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const UPLOAD_ROOT = path.join(__dirname, '..', 'data', 'uploads', 'store-models');
const MODEL_DIR = UPLOAD_ROOT;
const TMP_DIR = path.join(UPLOAD_ROOT, '.tmp');

/** 单个模型上限（可通过环境变量调整）；100MB+ 的模型留足余量 */
const MAX_BYTES = Number(process.env.STORE_MODEL_MAX_BYTES || 512 * 1024 * 1024);
/** 默认分片大小 */
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const MIN_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
/** 中间态保留时长：超过这个时间没动的上传视为废弃，清理时一并删除 */
const TMP_TTL_MS = 24 * 60 * 60 * 1000;

function ensureDirs() {
  for (const dir of [MODEL_DIR, TMP_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function clampChunkSize(value) {
  const size = Math.floor(Number(value) || 0);
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_CHUNK_SIZE;
  return Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, size));
}

/** 只看文件名，剥掉任何目录成分 —— 防止 file_name 里带 ../ 穿越 */
function sanitizeName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  return base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().slice(0, 200) || 'model.glb';
}

/** GLB 魔数：文件头 4 字节是 ASCII 'glTF'（小端 0x46546C67） */
function hasGlbMagic(buffer) {
  return Boolean(buffer) && buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'glTF';
}

/**
 * 完整校验 GLB 头：magic + version(2) + 声明长度。
 * @returns {{ ok: boolean, reason?: string, declaredBytes?: number }}
 */
function inspectGlbHeader(buffer) {
  if (!hasGlbMagic(buffer)) return { ok: false, reason: '文件不是 GLB 格式（缺少 glTF 魔数）' };
  if (buffer.length < 12) return { ok: false, reason: 'GLB 文件头不完整' };
  const version = buffer.readUInt32LE(4);
  const declaredBytes = buffer.readUInt32LE(8);
  if (version !== 2) return { ok: false, reason: `暂不支持 GLB ${version} 版本（只支持 2）` };
  return { ok: true, declaredBytes };
}

/** 磁盘剩余空间（拿不到就返回 null，不做硬拦截） */
function freeDiskBytes() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stat = fs.statfsSync(MODEL_DIR);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch { return null; }
}

function uploadDir(uploadId) {
  if (!/^[a-f0-9-]{8,64}$/i.test(String(uploadId || ''))) throw Object.assign(new Error('上传会话不存在'), { status: 404 });
  return path.join(TMP_DIR, uploadId);
}
function chunkPath(uploadId, index) { return path.join(uploadDir(uploadId), `${index}.part`); }
function sessionPath(uploadId) { return path.join(uploadDir(uploadId), 'session.json'); }

function readSessionSync(uploadId) {
  try {
    const raw = fs.readFileSync(sessionPath(uploadId), 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

function writeSessionSync(session) {
  ensureDirs();
  if (!fs.existsSync(uploadDir(session.upload_id))) fs.mkdirSync(uploadDir(session.upload_id), { recursive: true });
  fs.writeFileSync(sessionPath(session.upload_id), JSON.stringify(session, null, 2), 'utf-8');
}

/** 已收到的分片 —— 直接扫盘，不信任 JSON */
function receivedIndexes(uploadId) {
  const dir = uploadDir(uploadId);
  if (!fs.existsSync(dir)) return [];
  const found = new Set();
  for (const name of fs.readdirSync(dir)) {
    const matched = /^(\d+)\.part$/.exec(name);
    if (!matched) continue;
    // 空分片视为未收到：中断的写入会留下 0 字节文件，续传时必须重传
    try { if (fs.statSync(path.join(dir, name)).size > 0) found.add(Number(matched[1])); } catch { /* 刚好被清理，跳过 */ }
  }
  return [...found].sort((left, right) => left - right);
}

/** 只读文件头若干字节 —— 校验 GLB 头不该把整个 135MB 读进内存 */
async function readHead(filePath, length = 12) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function missingIndexes(session) {
  const received = new Set(receivedIndexes(session.upload_id));
  const missing = [];
  for (let index = 0; index < session.total_chunks; index++) if (!received.has(index)) missing.push(index);
  return missing;
}

/**
 * 开一个上传会话；同一 (门店, 文件名, 大小, 修改时间) 的旧会话会被复用，
 * 前端据此实现"关了页面再回来接着传"。
 */
function createSession({ storeId, fileName, bytes, chunkSize, fingerprint, userId, userName }) {
  ensureDirs();
  const store = Number(storeId);
  if (!Number.isInteger(store) || store <= 0) throw Object.assign(new Error('缺少有效的门店'), { status: 400 });

  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) throw Object.assign(new Error('文件大小无效'), { status: 400 });
  if (size > MAX_BYTES) {
    throw Object.assign(new Error(`模型不能超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB（当前 ${Math.round(size / 1024 / 1024)}MB）`), { status: 413 });
  }

  const free = freeDiskBytes();
  if (free !== null && free < size * 1.2) {
    throw Object.assign(new Error(`服务器磁盘剩余空间不足（剩 ${Math.round(free / 1024 / 1024)}MB，需要约 ${Math.round(size * 1.2 / 1024 / 1024)}MB）`), { status: 507 });
  }

  const size8 = clampChunkSize(chunkSize);
  const totalChunks = Math.max(1, Math.ceil(size / size8));
  const session = {
    upload_id: crypto.randomUUID(),
    store_id: store,
    file_name: sanitizeName(fileName),
    bytes: size,
    chunk_size: size8,
    total_chunks: totalChunks,
    fingerprint: String(fingerprint || ''),
    user_id: userId || null,
    user_name: String(userName || ''),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeSessionSync(session);
  return session;
}

function getSession(uploadId) {
  const session = readSessionSync(uploadId);
  if (!session) throw Object.assign(new Error('上传会话不存在或已过期，请重新上传'), { status: 404 });
  return session;
}

/** 上传状态：给前端算"还差哪几片" */
function describeSession(session) {
  const received = receivedIndexes(session.upload_id);
  const missing = missingIndexes(session);
  return {
    upload_id: session.upload_id,
    store_id: session.store_id,
    file_name: session.file_name,
    bytes: session.bytes,
    chunk_size: session.chunk_size,
    total_chunks: session.total_chunks,
    received_count: received.length,
    received,
    missing,
    updated_at: session.updated_at,
  };
}

/** 落一片。重复上传同一片直接覆盖（幂等），重试不会污染状态。 */
function saveChunk(uploadId, index, buffer) {
  const session = getSession(uploadId);
  const chunkIndex = Number(index);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.total_chunks) {
    throw Object.assign(new Error('分片序号超出范围'), { status: 400 });
  }
  if (!buffer || !buffer.length) throw Object.assign(new Error('分片内容为空'), { status: 400 });
  if (buffer.length > session.chunk_size) {
    throw Object.assign(new Error(`分片超过约定大小 ${session.chunk_size} 字节`), { status: 413 });
  }
  // 首片必须带 GLB 魔数：坏文件在第一步就拒掉，不必等传完 135MB
  if (chunkIndex === 0) {
    const head = inspectGlbHeader(buffer);
    if (!head.ok) throw Object.assign(new Error(head.reason), { status: 400 });
  }

  ensureDirs();
  const dir = uploadDir(uploadId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(chunkPath(uploadId, chunkIndex), buffer);

  session.updated_at = new Date().toISOString();
  writeSessionSync(session);
  return describeSession(session);
}

/**
 * 合并分片 → 校验 → 按内容哈希落成品 → 写库（换版本）。
 * 合并时逐片读、逐片写、同步喂哈希：峰值内存只有一个分片，
 * 且每片之间 await 让出事件循环，不会卡住整个服务。
 */
async function completeSession(db, uploadId, { userId, userName } = {}) {
  const session = getSession(uploadId);
  const missing = missingIndexes(session);
  if (missing.length) {
    throw Object.assign(new Error(`还有 ${missing.length} 个分片未上传，请继续上传后再提交`), { status: 409 });
  }

  const dir = uploadDir(uploadId);
  const merged = path.join(dir, 'merged.glb.part');
  const hash = crypto.createHash('sha256');
  let total = 0;
  const handle = await fsp.open(merged, 'w');
  try {
    for (let index = 0; index < session.total_chunks; index++) {
      const buffer = await fsp.readFile(chunkPath(uploadId, index));
      hash.update(buffer);
      await handle.write(buffer);
      total += buffer.length;
    }
  } finally {
    await handle.close();
  }

  if (total !== session.bytes) {
    throw Object.assign(new Error(`文件大小不一致：声明 ${session.bytes} 字节，实际合并 ${total} 字节`), { status: 400 });
  }

  const head = inspectGlbHeader(await readHead(merged));
  if (!head.ok) throw Object.assign(new Error(head.reason), { status: 400 });

  const sha256 = hash.digest('hex');
  const storedName = `${sha256}.glb`;
  const finalPath = path.join(MODEL_DIR, storedName);
  ensureDirs();

  // 同内容已存在（重复上传或别的门店传过同一个文件）→ 复用磁盘副本，不重复占空间
  const deduped = fs.existsSync(finalPath);
  if (deduped) await fsp.unlink(merged);
  else await fsp.rename(merged, finalPath);

  const store = db.queryOne('SELECT id,store_name FROM stores WHERE id=?', [session.store_id]);
  if (!store) throw Object.assign(new Error('门店不存在'), { status: 404 });

  const nextVersion = Number(db.queryOne('SELECT COALESCE(MAX(version),0)+1 AS v FROM store_models WHERE store_id=?', [session.store_id])?.v || 1);
  db.run('UPDATE store_models SET is_active=0 WHERE store_id=? AND is_active=1', [session.store_id]);
  const id = db.insert(
    `INSERT INTO store_models (store_id,file_name,stored_name,bytes,sha256,version,is_active,uploaded_by,uploaded_by_name)
     VALUES (?,?,?,?,?,?,1,?,?)`,
    [session.store_id, session.file_name, storedName, total, sha256, nextVersion, userId || session.user_id || null, String(userName || session.user_name || '')]
  );

  await fsp.rm(dir, { recursive: true, force: true });

  return {
    model: db.queryOne('SELECT * FROM store_models WHERE id=?', [id]),
    store,
    deduped,
    version: nextVersion,
  };
}

async function abortSession(uploadId) {
  const dir = uploadDir(uploadId);
  await fsp.rm(dir, { recursive: true, force: true });
  return { upload_id: uploadId };
}

/** 门店当前生效的模型 */
function getActiveModel(db, storeId) {
  return db.queryOne('SELECT * FROM store_models WHERE store_id=? AND is_active=1 ORDER BY version DESC LIMIT 1', [storeId]) || null;
}

function getModelById(db, id) {
  return db.queryOne('SELECT * FROM store_models WHERE id=?', [id]) || null;
}

/** 全部门店的生效模型，一次查完给列表页用（25 家门店不必发 25 个请求） */
function listActiveModels(db) {
  return db.queryAll(
    `SELECT m.*, s.store_name FROM store_models m
     LEFT JOIN stores s ON s.id = m.store_id
     WHERE m.is_active=1 ORDER BY m.store_id, m.version DESC`
  );
}

function listModelHistory(db, storeId) {
  return db.queryAll('SELECT * FROM store_models WHERE store_id=? ORDER BY version DESC', [storeId]);
}

/** 软删：只摘掉生效标记，文件和历史都留着（误删可恢复） */
function deactivateModel(db, id) {
  const model = getModelById(db, id);
  if (!model) throw Object.assign(new Error('模型不存在'), { status: 404 });
  db.run('UPDATE store_models SET is_active=0 WHERE id=?', [id]);
  const fallback = getActiveModel(db, model.store_id);
  if (fallback && fallback.id !== model.id) {
    // 删的是当前版本时，自动回退到上一版
    db.run('UPDATE store_models SET is_active=1 WHERE id=?', [fallback.id]);
  }
  return { removed: model, fallback };
}

/** 带目录逃逸防护的成品路径 */
function filePathOf(storedName) {
  const base = path.basename(String(storedName || ''));
  if (!/^[a-f0-9]{64}\.glb$/i.test(base)) return null;
  return path.join(MODEL_DIR, base);
}

function stats(db) {
  const row = db.queryOne('SELECT COUNT(*) AS files, COALESCE(SUM(bytes),0) AS bytes FROM store_models WHERE is_active=1') || {};
  const all = db.queryOne('SELECT COUNT(*) AS rows_count FROM store_models') || {};
  const storesWithModel = db.queryOne('SELECT COUNT(DISTINCT store_id) AS n FROM store_models WHERE is_active=1') || {};
  return {
    active_files: Number(row.files || 0),
    active_bytes: Number(row.bytes || 0),
    total_rows: Number(all.rows_count || 0),
    stores_with_model: Number(storesWithModel.n || 0),
    max_bytes: MAX_BYTES,
    default_chunk_size: DEFAULT_CHUNK_SIZE,
    free_bytes: freeDiskBytes(),
  };
}

/**
 * 清理磁盘。
 *
 * ## 为什么原来的孤儿判定是错的
 * 第一版把"任何一行 store_models"都当作对文件的引用，**包括 is_active=0 的历史版本**。
 * 结果是：换模型之后旧版文件永远被自己那条历史记录钉住，磁盘再也不会释放；
 * 删除模型同理。等于"保留了历史"就"永远不回收"。
 *
 * ## 现在的口径
 *   1. 每个门店保留：生效版本 + 最近 (keepVersions - 1) 个历史版本。
 *   2. 超出保留窗口的历史记录 —— 先删库记录，再删文件（`purgeHistory` 控制，默认开）。
 *   3. 剩下的文件里，没有任何记录引用的才算孤儿，一并删除。
 *   4. 超过 TTL 的废弃上传中间态。
 *
 * 默认 keepVersions = 1（只留生效版）。要保留可回滚的历史就把这个值调大。
 * 默认 dryRun，只报告不删。
 *
 * @returns {{ dry_run: boolean, keep_versions: number, expired_rows: Array, orphan_files: Array,
 *             stale_uploads: Array, orphan_bytes: number, freed_bytes: number, rows_deleted: number }}
 */
async function purgeOrphans(db, { dryRun = true, keepVersions = 1, purgeHistory = true, now = Date.now() } = {}) {
  ensureDirs();
  const keep = Math.max(1, Math.floor(Number(keepVersions) || 1));

  // ---- ① 按门店计算保留窗口，找出过期历史版本 ----
  const rows = db.queryAll('SELECT id, store_id, version, is_active, stored_name, bytes, created_at FROM store_models ORDER BY store_id, version DESC');
  const byStore = new Map();
  for (const row of rows) {
    if (!byStore.has(row.store_id)) byStore.set(row.store_id, []);
    byStore.get(row.store_id).push(row);
  }
  const expiredRows = [];
  const keptRows = [];
  for (const [storeId, list] of byStore) {
    const active = list.filter(row => row.is_active);
    const history = list.filter(row => !row.is_active);
    // 门店一个生效版本都没有（模型被删过）→ 历史全是过期：文件该回收就回收，
    // 否则一个已经不显示模型的门店会把自己的历史文件永远钉在磁盘上（实测踩到过）。
    // 门店有生效版本时，才按 keep 保留可回滚的历史。
    if (!active.length) { expiredRows.push(...history); continue; }
    const keepHistory = Math.max(0, keep - active.length);
    keptRows.push(...active, ...history.slice(0, keepHistory));
    expiredRows.push(...history.slice(keepHistory));
    void storeId;
  }

  // ---- ② 文件引用只认"保留窗口内"的记录 ----
  const referenced = new Set(keptRows.map(row => row.stored_name));
  const orphanFiles = [];
  for (const name of fs.readdirSync(MODEL_DIR)) {
    const full = path.join(MODEL_DIR, name);
    if (fs.statSync(full).isDirectory()) continue;
    if (!/\.glb$/i.test(name)) continue;
    if (referenced.has(name)) continue;
    orphanFiles.push({ name, bytes: fs.statSync(full).size });
  }

  // ---- ③ 过期的上传中间态 ----
  const staleUploads = [];
  for (const name of fs.readdirSync(TMP_DIR)) {
    const full = path.join(TMP_DIR, name);
    if (!fs.statSync(full).isDirectory()) continue;
    const session = readSessionSync(name);
    const touched = session?.updated_at ? Date.parse(session.updated_at) : fs.statSync(full).mtimeMs;
    if (now - touched > TMP_TTL_MS) staleUploads.push({ upload_id: name, idle_ms: now - touched });
  }

  let freedBytes = 0;
  let rowsDeleted = 0;
  if (!dryRun) {
    if (purgeHistory && expiredRows.length) {
      for (const row of expiredRows) {
        db.run('DELETE FROM store_models WHERE id=?', [row.id]);
        rowsDeleted += 1;
      }
    }
    for (const item of orphanFiles) { await fsp.unlink(path.join(MODEL_DIR, item.name)); freedBytes += item.bytes; }
    for (const item of staleUploads) await fsp.rm(path.join(TMP_DIR, item.upload_id), { recursive: true, force: true });
  }

  return {
    dry_run: Boolean(dryRun),
    keep_versions: keep,
    purge_history: Boolean(purgeHistory),
    // 超出保留窗口的历史记录：只有真跑且开了 purgeHistory 才会被删
    expired_rows: expiredRows.map(row => ({ id: row.id, store_id: row.store_id, version: row.version, file_name: row.stored_name, bytes: row.bytes })),
    orphan_files: orphanFiles,
    orphan_bytes: orphanFiles.reduce((sum, item) => sum + item.bytes, 0),
    expired_bytes: expiredRows.reduce((sum, row) => sum + (row.bytes || 0), 0),
    stale_uploads: staleUploads,
    rows_deleted: rowsDeleted,
    freed_bytes: freedBytes,
  };
}

module.exports = {
  MODEL_DIR,
  TMP_DIR,
  MAX_BYTES,
  DEFAULT_CHUNK_SIZE,
  ensureDirs,
  sanitizeName,
  hasGlbMagic,
  inspectGlbHeader,
  clampChunkSize,
  freeDiskBytes,
  createSession,
  getSession,
  describeSession,
  saveChunk,
  completeSession,
  abortSession,
  receivedIndexes,
  missingIndexes,
  getActiveModel,
  getModelById,
  listActiveModels,
  listModelHistory,
  deactivateModel,
  filePathOf,
  stats,
  purgeOrphans,
};
