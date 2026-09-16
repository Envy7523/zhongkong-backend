/**
 * 门店 GLB 模型的本机缓存（Cache Storage API）
 *
 * ## 为什么不用 HTTP 缓存
 * 模型下载走 JWT 鉴权接口（带 Authorization 头），浏览器对 100MB+ 的大响应会在磁盘缓存里
 * 按压力主动淘汰，且没有任何 API 能查询占用、精确删除或判断"到底缓存住了没有"。
 * Cache Storage 就是为"大文件长期留存 + 可编程管理"设计的：能列条目、能算占用、能精确删。
 *
 * ## 为什么键用内容哈希
 * 键形如 `<origin>/__model_cache__/<sha256>.glb`，这个地址永远不会真的发请求，
 * 纯粹当本地索引。内容变了哈希就变、键就变，天然不可能命中过期模型——
 * 从根上消掉"换了模型但前端还在用旧模型"这类事故，也不需要写任何失效逻辑。
 *
 * ## 为什么先落缓存再返回
 * 顺序是 下载完 → 写入缓存 → 交给 three.js 渲染。反过来（边下边渲染）在
 * GLTFLoader 里做不到，而 135MB 的模型一旦下载失败要从头再来，先落缓存才谈得上重试。
 */
const CACHE_NAME = 'etaigong-store-models-v1'
const KEY_PREFIX = '/__model_cache__'

export function supportsModelCache() {
  return typeof caches !== 'undefined' && typeof caches.open === 'function'
}

/** 内容哈希 → 缓存键（带 origin，避免 caches.match 相对路径解析歧义） */
export function modelCacheKey(sha256) {
  const base = typeof location !== 'undefined' ? location.origin : ''
  return `${base}${KEY_PREFIX}/${String(sha256 || '').toLowerCase()}.glb`
}

async function openCache() {
  if (!supportsModelCache()) return null
  try { return await caches.open(CACHE_NAME) } catch { return null }
}

/**
 * 读本机缓存。
 * @returns {Promise<{ blob: Blob, bytes: number, cachedAt: string }|null>}
 */
export async function readCachedModel(sha256) {
  if (!sha256) return null
  const cache = await openCache()
  if (!cache) return null
  try {
    const hit = await cache.match(modelCacheKey(sha256))
    if (!hit) return null
    const blob = await hit.blob()
    if (!blob.size) return null
    return { blob, bytes: blob.size, cachedAt: hit.headers.get('x-cached-at') || '' }
  } catch { return null }
}

export async function hasCachedModel(sha256) {
  const cache = await openCache()
  if (!cache) return false
  try { return Boolean(await cache.match(modelCacheKey(sha256))) } catch { return false }
}

/**
 * 写本机缓存。用 Response 包住 Blob 引用而不是复制字节——
 * 缓存存储引用的是同一份数据，不会在内存里再复制一份 135MB。
 */
export async function writeCachedModel(sha256, blob, meta = {}) {
  const cache = await openCache()
  if (!cache || !sha256 || !blob?.size) return false
  try {
    await cache.put(modelCacheKey(sha256), new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': 'model/gltf-binary',
        'X-Model-Sha256': sha256,
        'X-Model-Bytes': String(blob.size),
        'X-Model-Name': encodeURIComponent(meta.fileName || ''),
        'X-Cached-At': new Date().toISOString(),
      },
    }))
    return true
  } catch { return false }
}

export async function removeCachedModel(sha256) {
  const cache = await openCache()
  if (!cache || !sha256) return false
  try { return await cache.delete(modelCacheKey(sha256)) } catch { return false }
}

export async function clearModelCache() {
  if (!supportsModelCache()) return 0
  try {
    const cache = await caches.open(CACHE_NAME)
    const keys = await cache.keys()
    await Promise.all(keys.map(key => cache.delete(key)))
    return keys.length
  } catch { return 0 }
}

/**
 * 缓存占用。只读响应头不读 body：135MB 的条目若为了量体积去 blob() 会白读一遍磁盘。
 */
export async function modelCacheInfo() {
  const empty = { count: 0, bytes: 0, entries: [], supports: supportsModelCache(), persisted: false, usage: 0, quota: 0 }
  if (!supportsModelCache()) return empty
  const cache = await openCache()
  if (!cache) return empty
  try {
    const keys = await cache.keys()
    const entries = []
    let bytes = 0
    for (const key of keys) {
      const hit = await cache.match(key)
      const size = Number(hit?.headers.get('x-model-bytes') || 0)
      bytes += size
      entries.push({
        sha256: hit?.headers.get('x-model-sha256') || '',
        name: decodeURIComponent(hit?.headers.get('x-model-name') || '') || '未命名模型',
        bytes: size,
        cachedAt: hit?.headers.get('x-cached-at') || '',
      })
    }
    const estimate = await estimateStorage()
    return { ...empty, count: entries.length, bytes, entries, ...estimate }
  } catch { return empty }
}

export async function estimateStorage() {
  try {
    if (!navigator.storage?.estimate) return { usage: 0, quota: 0, persisted: false }
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false
    return { usage, quota, persisted }
  } catch { return { usage: 0, quota: 0, persisted: false } }
}

/** 申请持久化存储：避免浏览器在磁盘吃紧时把缓存里的模型清掉 */
export async function requestPersistentCache() {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch { return false }
}

/**
 * 装得下才缓存：配额不够就别硬塞，否则 put 失败还白占一次内存。
 * @returns {{ ok: boolean, reason?: string }}
 */
export async function canCacheSize(bytes) {
  const { usage, quota } = await estimateStorage()
  if (!quota) return { ok: true } // 拿不到配额信息时不拦（Safari 等）
  const headroom = quota - usage
  if (headroom < bytes * 1.2) {
    return {
      ok: false,
      reason: `本机剩余存储不足以缓存该模型（可用 ${(headroom / 1048576).toFixed(0)}MB，需要约 ${(bytes * 1.2 / 1048576).toFixed(0)}MB）`,
    }
  }
  return { ok: true }
}

/**
 * 带进度的下载：response.body 逐块读，边读边报进度，最后拼成一个 Blob。
 * 直接 await response.blob() 拿不到任何中间进度，135MB 在慢网下会像卡死。
 */
export async function readResponseWithProgress(response, onProgress) {
  const declared = Number(response.headers.get('content-length') || response.headers.get('x-model-bytes') || 0)
  if (!response.body?.getReader) {
    const blob = await response.blob()
    onProgress?.({ loaded: blob.size, total: declared || blob.size, percent: 100 })
    return blob
  }
  const reader = response.body.getReader()
  const parts = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    loaded += value.length
    const total = declared || 0
    onProgress?.({ loaded, total, percent: total ? Math.min(99, Math.round(loaded / total * 100)) : 0 })
  }
  const blob = new Blob(parts, { type: 'model/gltf-binary' })
  onProgress?.({ loaded: blob.size, total: blob.size, percent: 100 })
  return blob
}
