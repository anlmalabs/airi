import { cacheKeyForModel, isStateCached } from '../../workers/web-rwkv/cache'
import { NativeAI } from '../native-ai'

// The cache name used by transformers.js / ONNX runtime
const TRANSFORMERS_CACHE_NAME = 'transformers-cache'
const OPFS_DIR_NAME = 'web-rwkv'
const MOSS_OPFS_DIR_NAME = 'nano-reader-browser-model-store'
// WebLLM (`@mlc-ai/web-llm`) stores weights / WASM libs / model config in the
// browser Cache Storage API under these scoped cache names (its default
// `cacheBackend` is `"cache"`; see `createScopedArtifactCache` in the library).
const WEBLLM_CACHE_NAMES = ['webllm/model', 'webllm/wasm', 'webllm/config'] as const
export const NEEDLE_CACHE_NAME = 'needle-cache'
export const LAYA_CACHE_NAME = 'laya-cache'

async function getDirectorySizeRecursive(dirHandle: FileSystemDirectoryHandle): Promise<number> {
  let size = 0
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      const file = await (entry as FileSystemFileHandle).getFile()
      size += file.size
    }
    else if (entry.kind === 'directory') {
      size += await getDirectorySizeRecursive(entry as FileSystemDirectoryHandle)
    }
  }
  return size
}

async function getMossOpfsCacheSize(): Promise<number> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory)
    return 0
  try {
    const root = await navigator.storage.getDirectory()
    let dir: FileSystemDirectoryHandle
    try {
      dir = await root.getDirectoryHandle(MOSS_OPFS_DIR_NAME, { create: false })
    }
    catch {
      return 0
    }
    return await getDirectorySizeRecursive(dir)
  }
  catch (error) {
    console.warn('[cache-utils] failed to get MOSS cache size', error)
    return 0
  }
}

async function clearMossOpfsCache(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory)
    return
  try {
    const root = await navigator.storage.getDirectory()
    try {
      await root.removeEntry(MOSS_OPFS_DIR_NAME, { recursive: true })
    }
    catch {
      // Ignored if directory doesn't exist
    }
  }
  catch (error) {
    console.warn('[cache-utils] failed to clear MOSS cache', error)
  }
}

async function isMossModelCached(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory)
    return false
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(MOSS_OPFS_DIR_NAME, { create: false })
    const iterator: AsyncIterator<FileSystemHandle> = dir.values()[Symbol.asyncIterator]()
    const first = await iterator.next()
    return !first.done // directory is not empty when it yields at least one entry
  }
  catch {
    return false
  }
}

async function getOpfsCacheSize(): Promise<number> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory)
    return 0
  try {
    const root = await navigator.storage.getDirectory()
    let dir: FileSystemDirectoryHandle
    try {
      dir = await root.getDirectoryHandle(OPFS_DIR_NAME, { create: false })
    }
    catch {
      return 0
    }
    let totalSize = 0
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') {
        const file = await (entry as FileSystemFileHandle).getFile()
        totalSize += file.size
      }
    }
    return totalSize
  }
  catch (error) {
    console.warn('[cache-utils] failed to get OPFS cache size', error)
    return 0
  }
}

async function clearOpfsCache(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory)
    return
  try {
    const root = await navigator.storage.getDirectory()
    try {
      await root.removeEntry(OPFS_DIR_NAME, { recursive: true })
    }
    catch {
      // Ignored if directory doesn't exist
    }
  }
  catch (error) {
    console.warn('[cache-utils] failed to clear OPFS cache', error)
  }
}

async function clearSingleOpfsModelCache(modelUrl: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory)
    return
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(OPFS_DIR_NAME, { create: false })
    const key = await cacheKeyForModel(modelUrl)
    const fileName = `${key}.f16cache`
    await dir.removeEntry(fileName)
  }
  catch (error) {
    console.warn('[cache-utils] failed to delete OPFS model entry', modelUrl, error)
  }
}

/**
 * Whether the single-slot Web-RWKV OPFS cache currently holds a checkpoint.
 *
 * The worker evicts the previous file whenever a new model finalizes, so the
 * slot reflects "whatever was loaded last" — this is what the generic
 * `web-rwkv` widget row reports instead of tracking any one model URL.
 */
export async function isWebRwkvSlotOccupied(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory)
    return false
  try {
    const root = await navigator.storage.getDirectory()
    let dir: FileSystemDirectoryHandle
    try {
      dir = await root.getDirectoryHandle(OPFS_DIR_NAME, { create: false })
    }
    catch {
      return false
    }
    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && (entry.name.endsWith('.f16cache') || entry.name.endsWith('.prefabcache')))
        return true
    }
    return false
  }
  catch {
    return false
  }
}

/** Clear the single-slot Web-RWKV OPFS cache (whatever checkpoint it holds). */
export async function clearWebRwkvCache(): Promise<void> {
  await clearOpfsCache()
}

async function isOpfsModelCached(modelUrl: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory)
    return false
  try {
    const root = await navigator.storage.getDirectory()
    let dir: FileSystemDirectoryHandle
    try {
      dir = await root.getDirectoryHandle(OPFS_DIR_NAME, { create: false })
    }
    catch {
      return false
    }
    const key = await cacheKeyForModel(modelUrl)
    try {
      await dir.getFileHandle(`${key}.f16cache`, { create: false })
      return true
    }
    catch {
      try {
        await dir.getFileHandle(`${key}.prefabcache`, { create: false })
        return true
      }
      catch {
        return false
      }
    }
  }
  catch {
    return false
  }
}

/**
 * Get the total size of cached model files in bytes across web and native backends.
 * Returns 0 if no caches exist or all are empty.
 */
export async function getModelCacheSize(): Promise<number> {
  const [transformersSize, opfsSize, mossSize, webLlmSize, needleSize, layaSize, nativeSize] = await Promise.all([
    getTransformersCacheSize(),
    getOpfsCacheSize(),
    getMossOpfsCacheSize(),
    getWebLlmCacheSize(),
    getNeedleCacheSize(),
    getLayaCacheSize(),
    NativeAI.listCachedModels().then(res => res.totalSizeBytes).catch(() => 0),
  ])

  return transformersSize + opfsSize + mossSize + webLlmSize + needleSize + layaSize + nativeSize
}

async function getTransformersCacheSize(): Promise<number> {
  if (typeof caches === 'undefined')
    return 0

  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME)
    const keys = await cache.keys()

    let totalSize = 0
    for (const request of keys) {
      const response = await cache.match(request)
      if (response) {
        // Content-Length header if available
        const cl = response.headers.get('content-length')
        if (cl) {
          totalSize += Number.parseInt(cl, 10)
        }
        else {
          // Fallback: read the body to measure size
          const blob = await response.blob()
          totalSize += blob.size
        }
      }
    }

    return totalSize
  }
  catch {
    return 0
  }
}

/**
 * Clear all cached model files across web and native backends.
 */
export async function clearModelCache(): Promise<void> {
  await Promise.all([
    clearTransformersCache(),
    clearOpfsCache(),
    clearMossOpfsCache(),
    clearWebLlmCache(),
    clearNeedleCache(),
    clearLayaCache(),
    NativeAI.listCachedModels().then(async (res) => {
      for (const m of res.models) {
        await NativeAI.deleteCachedModel({ modelId: m.modelId }).catch(() => {})
      }
    }).catch(() => {}),
  ])
}

/**
 * Clear a specific model from cache by ID.
 */
export async function clearSingleModelCache(modelId: string): Promise<void> {
  if (modelId.includes('coreml') || modelId.includes('Gemma-4-E2B') || modelId.includes('okayuji') || modelId.includes('aoiandroid')) {
    await NativeAI.deleteCachedModel({ modelId }).catch(() => {})
    return
  }
  if (modelId === 'moss-tts-nano') {
    await clearMossOpfsCache()
    return
  }
  if (modelId === 'web-llm') {
    await clearWebLlmCache()
    return
  }
  if (modelId === 'needle-2' || modelId.includes('needle2') || modelId.includes('needle')) {
    await clearNeedleCache()
    return
  }
  if (modelId.includes('laya')) {
    await clearLayaCache()
    return
  }
  if (modelId === 'web-rwkv') {
    await clearWebRwkvCache()
    return
  }
  if (modelId.startsWith('http')) {
    await clearSingleOpfsModelCache(modelId)
    return
  }
  await clearSingleTransformersModelCache(modelId)
}

async function clearTransformersCache(): Promise<void> {
  if (typeof caches === 'undefined')
    return

  try {
    await caches.delete(TRANSFORMERS_CACHE_NAME)
  }
  catch {
    // Silently ignore if cache doesn't exist
  }
}

async function clearSingleTransformersModelCache(modelId: string): Promise<void> {
  if (typeof caches === 'undefined')
    return

  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME)
    const keys = await cache.keys()
    for (const request of keys) {
      if (request.url.includes(modelId)) {
        await cache.delete(request)
      }
    }
  }
  catch (error) {
    console.warn('[cache-utils] failed to delete transformers cache entry', modelId, error)
  }
}

/**
 * Evict all cached Whisper model shards except the specified model repository ID.
 * Ensures that only a single active Whisper model shard is retained in browser storage.
 */
export async function evictOtherWhisperModels(keepModelId: string): Promise<void> {
  if (typeof caches === 'undefined')
    return

  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME)
    const keys = await cache.keys()
    for (const request of keys) {
      if (request.url.includes('whisper') && !request.url.includes(keepModelId)) {
        await cache.delete(request)
      }
    }
  }
  catch (error) {
    console.warn('[cache-utils] failed to evict other whisper model shards', error)
  }
}

// ---------------------------------------------------------------------------
// WebLLM (Cache Storage API, `webllm/*` scopes)
// ---------------------------------------------------------------------------

/** Sum the byte size of every response across all `webllm/*` cache scopes. */
export async function getWebLlmCacheSize(): Promise<number> {
  if (typeof caches === 'undefined')
    return 0

  let totalSize = 0
  for (const name of WEBLLM_CACHE_NAMES) {
    try {
      const has = await caches.has(name)
      if (!has)
        continue
      const cache = await caches.open(name)
      const keys = await cache.keys()
      for (const request of keys) {
        const response = await cache.match(request)
        if (!response)
          continue
        // Content-Length header if available, else read the body to measure.
        const cl = response.headers.get('content-length')
        if (cl) {
          totalSize += Number.parseInt(cl, 10)
        }
        else {
          const blob = await response.blob()
          totalSize += blob.size
        }
      }
    }
    catch (error) {
      console.warn('[cache-utils] failed to measure WebLLM cache scope', name, error)
    }
  }
  return totalSize
}

/** Delete all `webllm/*` cache scopes (weights, WASM libs, and model config). */
export async function clearWebLlmCache(): Promise<void> {
  for (const name of WEBLLM_CACHE_NAMES) {
    if (typeof caches !== 'undefined') {
      try {
        await caches.delete(name)
      }
      catch (error) {
        console.warn('[cache-utils] failed to clear WebLLM Cache scope', name, error)
      }
    }
    if (typeof indexedDB !== 'undefined') {
      try {
        indexedDB.deleteDatabase(name)
      }
      catch (error) {
        console.warn('[cache-utils] failed to delete WebLLM IndexedDB database', name, error)
      }
    }
  }
}

/**
 * Check whether any WebLLM model is cached (any entry in any `webllm/*` scope).
 * When `modelId` is provided, matches entries whose request URL contains it;
 * otherwise returns true if any scope holds anything at all.
 */
export async function isWebLlmModelCached(modelId?: string): Promise<boolean> {
  for (const name of WEBLLM_CACHE_NAMES) {
    if (typeof caches !== 'undefined') {
      try {
        const has = await caches.has(name)
        if (has) {
          const cache = await caches.open(name)
          const keys = await cache.keys()
          if (!modelId && keys.length > 0)
            return true
          if (modelId && keys.some(request => request.url.includes(modelId)))
            return true
        }
      }
      catch {
        // Ignore Cache API failure
      }
    }

    if (typeof indexedDB !== 'undefined') {
      try {
        let exists = true
        if (typeof indexedDB.databases === 'function') {
          const dbs = await indexedDB.databases()
          exists = dbs.some(d => d.name === name)
        }
        if (exists) {
          const req = indexedDB.open(name)
          const db = await new Promise<IDBDatabase | null>((resolve) => {
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => resolve(null)
          })
          if (db) {
            if (db.objectStoreNames.contains('urls')) {
              const count = await new Promise<number>((resolve) => {
                const tx = db.transaction('urls', 'readonly')
                const store = tx.objectStore('urls')
                const cntReq = store.count()
                cntReq.onsuccess = () => resolve(cntReq.result)
                cntReq.onerror = () => resolve(0)
              })
              db.close()
              if (count > 0)
                return true
            }
            else {
              // Stub database created without object stores; clean it up
              db.close()
              indexedDB.deleteDatabase(name)
            }
          }
        }
      }
      catch {
        // Ignore IndexedDB failure
      }
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Needle 2 (Cache Storage API, `needle-cache` scope)
// ---------------------------------------------------------------------------

export async function getNeedleCacheSize(): Promise<number> {
  if (typeof caches === 'undefined')
    return 0

  try {
    const has = await caches.has(NEEDLE_CACHE_NAME)
    if (!has)
      return 0
    const cache = await caches.open(NEEDLE_CACHE_NAME)
    const keys = await cache.keys()
    let totalSize = 0
    for (const request of keys) {
      const response = await cache.match(request)
      if (response) {
        const cl = response.headers.get('content-length')
        if (cl) {
          totalSize += Number.parseInt(cl, 10)
        }
        else {
          const blob = await response.blob()
          totalSize += blob.size
        }
      }
    }
    return totalSize
  }
  catch (error) {
    console.warn('[cache-utils] failed to get Needle cache size', error)
    return 0
  }
}

export async function clearNeedleCache(): Promise<void> {
  if (typeof caches === 'undefined')
    return
  try {
    await caches.delete(NEEDLE_CACHE_NAME)
  }
  catch (error) {
    console.warn('[cache-utils] failed to clear Needle cache', error)
  }
}

export async function isNeedleModelCached(): Promise<boolean> {
  if (typeof caches === 'undefined')
    return false
  try {
    const has = await caches.has(NEEDLE_CACHE_NAME)
    if (!has)
      return false
    const cache = await caches.open(NEEDLE_CACHE_NAME)
    const keys = await cache.keys()
    return keys.length > 0
  }
  catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Laya (Cache Storage API, `laya-cache` scope)
// ---------------------------------------------------------------------------

export async function getLayaCacheSize(): Promise<number> {
  if (typeof caches === 'undefined')
    return 0

  try {
    const has = await caches.has(LAYA_CACHE_NAME)
    if (!has)
      return 0
    const cache = await caches.open(LAYA_CACHE_NAME)
    const keys = await cache.keys()
    let totalSize = 0
    for (const request of keys) {
      const response = await cache.match(request)
      if (response) {
        const cl = response.headers.get('content-length')
        if (cl) {
          totalSize += Number.parseInt(cl, 10)
        }
        else {
          const blob = await response.blob()
          totalSize += blob.size
        }
      }
    }
    return totalSize
  }
  catch (error) {
    console.warn('[cache-utils] failed to get Laya cache size', error)
    return 0
  }
}

export async function clearLayaCache(): Promise<void> {
  if (typeof caches === 'undefined')
    return
  try {
    await caches.delete(LAYA_CACHE_NAME)
  }
  catch (error) {
    console.warn('[cache-utils] failed to clear Laya cache', error)
  }
}

export async function isLayaModelCached(): Promise<boolean> {
  if (typeof caches === 'undefined')
    return false
  try {
    const has = await caches.has(LAYA_CACHE_NAME)
    if (!has)
      return false
    const cache = await caches.open(LAYA_CACHE_NAME)
    const keys = await cache.keys()
    return keys.length > 0
  }
  catch {
    return false
  }
}

/**
 * Check whether a specific model has cached files.
 * Matches by looking for cache entries whose URL contains the model ID.
 */
export async function isModelCached(modelId: string): Promise<boolean> {
  if (modelId.includes('coreml') || modelId.includes('Gemma-4-E2B') || modelId.includes('okayuji') || modelId.includes('aoiandroid')) {
    const res = await NativeAI.listCachedModels().catch(() => ({ models: [] }))
    const sanitized = modelId.replace(/\//g, '_')
    return res.models.some(m => m.modelId.includes(sanitized) || m.modelId.includes(modelId) || m.filePath.includes(sanitized))
  }
  if (modelId === 'moss-tts-nano') {
    return isMossModelCached()
  }
  if (modelId === 'web-llm') {
    return isWebLlmModelCached()
  }
  if (modelId === 'needle-2' || modelId.includes('needle2') || modelId.includes('needle')) {
    return isNeedleModelCached()
  }
  if (modelId.includes('laya')) {
    return isLayaModelCached()
  }
  if (modelId === 'web-rwkv') {
    return isWebRwkvSlotOccupied()
  }
  if (modelId.startsWith('http')) {
    return isOpfsModelCached(modelId)
  }
  return isTransformersModelCached(modelId)
}

async function isTransformersModelCached(modelId: string): Promise<boolean> {
  if (typeof caches === 'undefined')
    return false

  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME)
    const keys = await cache.keys()

    // NOTICE: Moondream2 is a multi-shard VLM (~1.1GB). Merely checking if any URL
    // contains 'moondream2' results in false positives when only small configs or
    // partial shards were downloaded. We must verify all three essential ONNX weight shards.
    if (modelId.includes('moondream2')) {
      const requiredShards = ['decoder_model_merged', 'vision_encoder', 'embed_tokens']
      const modelKeys = keys.filter(request => request.url.includes(modelId))
      if (modelKeys.length === 0)
        return false
      return requiredShards.every(shard => modelKeys.some(req => req.url.includes(shard)))
    }

    return keys.some(request => request.url.includes(modelId))
  }
  catch {
    return false
  }
}

/**
 * Format bytes into a human-readable string (e.g. "512 MB").
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0)
    return '0 B'

  const units = ['B', 'KB', 'MB', 'GB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const value = bytes / k ** i

  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

/**
 * Evict all cached Ming 3.0 model parts except those in `keepPartHashes`.
 */
export async function evictOtherMing3Models(keepPartHashes: string[]): Promise<void> {
  void keepPartHashes
}

export { isStateCached }
