import type { BackgroundRemovalAdapter } from '../libs/inference/adapters/background-removal'

import localforage from 'localforage'

import { useIntervalFn, useLocalStorage } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { computed, ref } from 'vue'

import * as Pinia from 'pinia'

import { chatStickers } from '../assets/stickers'
import { createBackgroundRemovalAdapter } from '../libs/inference/adapters/background-removal'
import { applyAlphaMask, blobToImageData, imageDataToPngBlob } from '../libs/stickers/image-convert'
import { useAiriCardStore } from './modules/airi-card'

export { chatStickers }

export interface StickerMetadata {
  id: string
  label: string
  addedAt: number
  originalName: string
  mimeType: string
  characterId?: string
}

export interface StickerPlacement {
  instanceId: string
  stickerId: string
  x: number
  y: number
  rotation: number
  scale: number
  createdAt: number
  expiresAt?: number
}

export interface BackgroundRemovalOptions {
  signal?: AbortSignal
  sensitivity?: number
  onProgress?: (phase: 'loading-model' | 'segmenting', percent?: number) => void
}

export type CutoutBlob = Blob & {
  maskData?: Uint8Array
  sourceImageData?: ImageData
}

const KNOWN_STICKER_PREFIXES = new Set(['airi', 'lupin', 'character'])

function tokenizeStickerId(id: string): string[] {
  return id.toLowerCase().split(/[\s_-]+/).filter(Boolean)
}

function stripKnownStickerPrefix(tokens: string[]): string[] {
  if (tokens.length > 1 && KNOWN_STICKER_PREFIXES.has(tokens[0]))
    return tokens.slice(1)
  return tokens
}

function normalizeStickerKey(id: string): string {
  return tokenizeStickerId(id).join('-')
}

export const useStickersStore = Pinia.defineStore('stickers', () => {
  // Persisted metadata list
  const libraryMetadata = useLocalStorage<StickerMetadata[]>('stickers/library-v2', [])

  /**
   * The library subset belonging to the currently active character
   */
  const currentLibrary = computed(() => {
    const airiCardStore = useAiriCardStore()
    return libraryMetadata.value.filter(s => !s.characterId || s.characterId === airiCardStore.activeCardId)
  })

  // Reactive state for active instances on screen
  const activePlacements = ref<StickerPlacement[]>([])

  // UI toggle for spawning standalone widgets (for Desktop support)
  const standaloneMode = useLocalStorage<boolean>('stickers/standalone-mode', false)

  // Cache for object URLs to avoid recreating them constantly
  const objectUrlCache = new Map<string, string>()

  /**
   * Resolve a model-emitted sticker id to a catalog id.
   * Order: exact match, normalized exact (_/-/case-insensitive/whitespace),
   * exact label/description match, then token-overlap fuzzy on prefix-stripped tokens.
   */
  function resolveStickerId(rawId: string): string | undefined {
    const raw = rawId?.trim()
    if (!raw)
      return undefined

    if (chatStickers.some(s => s.id === raw))
      return raw

    let customIds: string[] = []
    try {
      const airiCardStore = useAiriCardStore()
      customIds = Object.keys(airiCardStore.activeCard?.extensions?.airi?.stickers || {})
      if (customIds.includes(raw))
        return raw
    }
    catch {}

    const candidates = [
      ...chatStickers.map(s => s.id),
      ...customIds,
      ...currentLibrary.value.map(m => m.id),
      ...libraryMetadata.value.map(m => m.id),
    ]

    const normalizedRaw = normalizeStickerKey(raw)
    const normalizedMatch = candidates.find(c => normalizeStickerKey(c) === normalizedRaw)
    if (normalizedMatch)
      return normalizedMatch

    // Match against user-facing custom sticker labels and builtin descriptions
    const labelMatch = currentLibrary.value.find(m => normalizeStickerKey(m.label) === normalizedRaw)
      ?? libraryMetadata.value.find(m => normalizeStickerKey(m.label) === normalizedRaw)
    if (labelMatch)
      return labelMatch.id

    const descMatch = chatStickers.find(s => normalizeStickerKey(s.description) === normalizedRaw)
    if (descMatch)
      return descMatch.id

    const inputTokens = stripKnownStickerPrefix(tokenizeStickerId(raw))
    if (inputTokens.length === 0)
      return undefined
    const inputSet = new Set(inputTokens)

    let best: string | undefined
    let bestShared = 0
    let bestLen = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const customMeta = currentLibrary.value.find(m => m.id === candidate)
        ?? libraryMetadata.value.find(m => m.id === candidate)
      const builtinMeta = chatStickers.find(s => s.id === candidate)

      const candidateTokens = [
        ...stripKnownStickerPrefix(tokenizeStickerId(candidate)),
        ...(customMeta ? stripKnownStickerPrefix(tokenizeStickerId(customMeta.label)) : []),
        ...(builtinMeta ? stripKnownStickerPrefix(tokenizeStickerId(builtinMeta.description)) : []),
      ]
      const uniqueCandidateTokens = [...new Set(candidateTokens)]
      const shared = uniqueCandidateTokens.filter(t => inputSet.has(t)).length
      if (shared === 0)
        continue
      if (shared > bestShared || (shared === bestShared && uniqueCandidateTokens.length < bestLen)) {
        best = candidate
        bestShared = shared
        bestLen = uniqueCandidateTokens.length
      }
    }
    return best
  }

  /**
   * Get target sticker image as as Object URL
   */
  async function getStickerUrl(id: string): Promise<string | undefined> {
    const builtin = chatStickers.find(s => s.id === id)
    if (builtin) {
      return builtin.src
    }

    if (objectUrlCache.has(id)) {
      return objectUrlCache.get(id)
    }

    const resolved = resolveStickerId(id) ?? id
    const resolvedBuiltin = resolved === id
      ? undefined
      : chatStickers.find(s => s.id === resolved)
    if (resolvedBuiltin) {
      return resolvedBuiltin.src
    }
    if (resolved !== id && objectUrlCache.has(resolved)) {
      const cached = objectUrlCache.get(resolved)!
      objectUrlCache.set(id, cached)
      return cached
    }

    // NOTICE: persisted cards strip embedded dataUrls, but a freshly imported
    // card (or a failed blob unpack) may still carry one — use it before giving up.
    try {
      const airiCardStore = useAiriCardStore()
      const dataUrl = airiCardStore.activeCard?.extensions?.airi?.stickers?.[resolved]?.dataUrl
      if (dataUrl)
        return dataUrl
    }
    catch {}

    try {
      const blob = await localforage.getItem<Blob>(`sticker-data-${resolved}`)
      if (blob) {
        const url = URL.createObjectURL(blob)
        objectUrlCache.set(resolved, url)
        if (resolved !== id)
          objectUrlCache.set(id, url)
        return url
      }
    }
    catch (err) {
      console.error(`[StickersStore] Failed to fetch sticker ${id} (resolved: ${resolved}):`, err)
    }
    return undefined
  }

  /**
   * Upload and register a new sticker
   */
  async function addSticker(file: File | Blob, label?: string, characterId?: string, customId?: string) {
    const airiCardStore = useAiriCardStore()
    const id = customId || nanoid()
    const originalName = (file as File).name || `${id}.png`
    const mimeType = file.type || 'image/png'
    const metadata: StickerMetadata = {
      id,
      label: label || originalName.replace(/\.[^/.]+$/, ''), // remove extension
      addedAt: Date.now(),
      originalName,
      mimeType,
      characterId: characterId || airiCardStore.activeCardId,
    }

    try {
      // Store blob in IndexedDB
      await localforage.setItem(`sticker-data-${id}`, file)

      // Update metadata list
      const existingIdx = libraryMetadata.value.findIndex(m => m.id === id)
      if (existingIdx >= 0) {
        libraryMetadata.value[existingIdx] = metadata
      }
      else {
        libraryMetadata.value.push(metadata)
      }

      return id
    }
    catch (err) {
      console.error('[StickersStore] Failed to save sticker:', err)
      throw err
    }
  }

  /**
   * Update or rename an existing sticker
   */
  async function updateSticker(oldId: string, updates: {
    id?: string
    label?: string
    file?: File | Blob
    characterId?: string
    mimeType?: string
  }): Promise<string> {
    const targetId = updates.id ? updates.id.trim() : oldId

    try {
      // 1. If ID changed, move binary data in IndexedDB
      if (targetId !== oldId) {
        let blob = updates.file
        if (!blob) {
          blob = (await localforage.getItem<Blob>(`sticker-data-${oldId}`)) ?? undefined
        }
        if (blob) {
          await localforage.setItem(`sticker-data-${targetId}`, blob)
          await localforage.removeItem(`sticker-data-${oldId}`)
        }

        // Clean up object URL cache
        if (objectUrlCache.has(oldId)) {
          URL.revokeObjectURL(objectUrlCache.get(oldId)!)
          objectUrlCache.delete(oldId)
        }
        if (objectUrlCache.has(targetId)) {
          URL.revokeObjectURL(objectUrlCache.get(targetId)!)
          objectUrlCache.delete(targetId)
        }

        // Update libraryMetadata
        const oldEntry = libraryMetadata.value.find(m => m.id === oldId)
        if (oldEntry) {
          libraryMetadata.value = libraryMetadata.value.filter(m => m.id !== oldId && m.id !== targetId)
          libraryMetadata.value.push({
            ...oldEntry,
            id: targetId,
            label: updates.label !== undefined ? updates.label : oldEntry.label,
            originalName: updates.file ? ((updates.file as File).name || `${targetId}.png`) : oldEntry.originalName,
            mimeType: updates.mimeType ?? (updates.file ? (updates.file.type || 'image/png') : oldEntry.mimeType),
            characterId: updates.characterId || oldEntry.characterId,
          })
        }

        // Update any active placements
        for (const p of activePlacements.value) {
          if (p.stickerId === oldId) {
            p.stickerId = targetId
          }
        }
      }
      else {
        // ID remains same
        if (updates.file) {
          await localforage.setItem(`sticker-data-${targetId}`, updates.file)
          if (objectUrlCache.has(targetId)) {
            URL.revokeObjectURL(objectUrlCache.get(targetId)!)
            objectUrlCache.delete(targetId)
          }
        }

        const idx = libraryMetadata.value.findIndex(m => m.id === targetId)
        if (idx >= 0) {
          const prev = libraryMetadata.value[idx]
          libraryMetadata.value[idx] = {
            ...prev,
            label: updates.label !== undefined ? updates.label : prev.label,
            originalName: updates.file ? ((updates.file as File).name || `${targetId}.png`) : prev.originalName,
            mimeType: updates.mimeType ?? (updates.file ? (updates.file.type || 'image/png') : prev.mimeType),
            characterId: updates.characterId || prev.characterId,
          }
        }
      }

      return targetId
    }
    catch (err) {
      console.error(`[StickersStore] Failed to update sticker ${oldId}:`, err)
      throw err
    }
  }

  /**
   * Remote a sticker from the library
   */
  async function deleteSticker(id: string) {
    try {
      await localforage.removeItem(`sticker-data-${id}`)

      // Revoke and clear cache
      if (objectUrlCache.has(id)) {
        URL.revokeObjectURL(objectUrlCache.get(id)!)
        objectUrlCache.delete(id)
      }

      // Update metadata
      libraryMetadata.value = libraryMetadata.value.filter(m => m.id !== id)

      // Clean up active placements
      activePlacements.value = activePlacements.value.filter(p => p.stickerId !== id)
    }
    catch (err) {
      console.error(`[StickersStore] Failed to delete sticker ${id}:`, err)
    }
  }

  /**
   * Spawn a sticker instance at coordinates (or center)
   */
  function spawnSticker(idOrLabel: string, options: { x?: number, y?: number, duration?: number } = {}) {
    const builtin = chatStickers.find(s => s.id === idOrLabel || s.description.toLowerCase() === idOrLabel.toLowerCase())
    const resolvedId = builtin ? builtin.id : (resolveStickerId(idOrLabel) ?? idOrLabel)
    const resolvedBuiltin = chatStickers.find(s => s.id === resolvedId)
    const sticker = resolvedBuiltin
      ? { id: resolvedBuiltin.id, label: resolvedBuiltin.description }
      : currentLibrary.value.find(m => m.id === resolvedId || m.label === idOrLabel)
    if (!sticker) {
      const availableBuiltin = chatStickers.map(s => s.id).join(', ')
      const availableCustom = currentLibrary.value.map(s => s.label).join(', ')
      const allAvailable = [availableBuiltin, availableCustom].filter(Boolean).join(', ')
      const errorMsg = `Sticker "${idOrLabel}" not found. Available stickers: ${allAvailable}`
      console.warn(`[StickersStore] ${errorMsg}`)
      return errorMsg
    }

    // "randomly creeked by like 3 to 8 degrees"
    const direction = Math.random() > 0.5 ? 1 : -1
    const rotation = (3 + Math.random() * 5) * direction

    // Wild positioning: use window dimensions or default to safe center if size unknown.
    // We target 10% to 90% of the viewport to ensure they are at least partially visible.
    const width = typeof window !== 'undefined' ? window.innerWidth : 1000
    const height = typeof window !== 'undefined' ? window.innerHeight : 1000

    const finalX = options.x !== undefined ? options.x : (width * (0.1 + Math.random() * 0.8))
    const finalY = options.y !== undefined ? options.y : (height * (0.1 + Math.random() * 0.8))

    const createdAt = Date.now()
    const placement: StickerPlacement = {
      instanceId: nanoid(),
      stickerId: sticker.id,
      x: finalX,
      y: finalY,
      rotation,
      scale: 1,
      createdAt,
      expiresAt: options.duration ? createdAt + (options.duration * 1000) : undefined,
    }

    activePlacements.value.push(placement)
    return placement
  }

  /**
   * Remove a specific placement instance
   */
  function removePlacement(instanceId: string) {
    activePlacements.value = activePlacements.value.filter(p => p.instanceId !== instanceId)
  }

  /**
   * Update placement position
   */
  function updatePlacement(instanceId: string, updates: Partial<StickerPlacement>) {
    const p = activePlacements.value.find(i => i.instanceId === instanceId)
    if (p) {
      Object.assign(p, updates)
    }
  }

  /**
   * Clear all active stickers from the screen
   */
  function clearPlacements() {
    activePlacements.value = []
  }

  /**
   * Delete every sticker in the current character's library
   */
  async function clearLibrary() {
    const toRemove = [...currentLibrary.value].map(s => s.id)
    for (const id of toRemove) {
      await deleteSticker(id)
    }
  }

  // Background removal (lazy singleton; worker lifecycle owned by the adapter).
  let bgAdapter: BackgroundRemovalAdapter | null = null
  let bgAdapterLoading: Promise<BackgroundRemovalAdapter> | null = null

  /**
   * Pre-cutout blobs, keyed by sticker id. Session-only and never persisted —
   * the source of truth for `revertTransparency`.
   */
  const transparencyOriginals = new Map<string, Blob>()

  async function ensureBgAdapter(
    onProgress?: (phase: 'loading-model' | 'segmenting', percent?: number) => void,
    signal?: AbortSignal,
  ): Promise<BackgroundRemovalAdapter> {
    if (bgAdapter) {
      const state = bgAdapter.state
      if (state === 'ready' || state === 'processing' || state === 'loading')
        return bgAdapter
      // NOTICE: a previous load failed, or the host restarted/tore down the
      // worker without a model (phase 'idle'/'error'/'terminated'). The old
      // code returned the dead adapter here, bricking the feature until app
      // restart with "Model not loaded". Rebuild instead so retry just works.
      try {
        bgAdapter.terminate()
      }
      catch {}
      bgAdapter = null
      bgAdapterLoading = null
    }
    if (!bgAdapterLoading) {
      bgAdapterLoading = (async () => {
        const adapter = createBackgroundRemovalAdapter()
        try {
          await adapter.load(
            p => onProgress?.('loading-model', typeof p?.percent === 'number' ? p.percent : undefined),
            signal ? { signal } : undefined,
          )
        }
        catch (err) {
          bgAdapterLoading = null
          adapter.terminate()
          throw err
        }
        bgAdapter = adapter
        return adapter
      })()
    }
    return bgAdapterLoading
  }

  /**
   * Run a raw image blob through IS-Net anime and return a transparent PNG cutout.
   * Blob-in/Blob-out building block shared by the upload dialog (pre-save)
   * and `makeTransparent` (stored stickers).
   */
  async function removeImageBackground(
    blob: Blob,
    options?: BackgroundRemovalOptions,
  ): Promise<CutoutBlob> {
    const adapter = await ensureBgAdapter(options?.onProgress, options?.signal)
    options?.signal?.throwIfAborted()

    const imageData = await blobToImageData(blob)
    options?.onProgress?.('segmenting')
    const cutout = await adapter.processImage(imageData, {
      signal: options?.signal,
      sensitivity: options?.sensitivity ?? 65,
    })
    const outBlob = await imageDataToPngBlob(cutout) as CutoutBlob
    outBlob.maskData = cutout.maskData
    outBlob.sourceImageData = imageData
    return outBlob
  }

  /**
   * Re-composite a cutout blob with a new sensitivity value using cached mask data.
   * Zero model latency (instant canvas update).
   */
  async function recomputeCutoutBlob(
    sourceImageData: ImageData,
    maskData: Uint8Array,
    sensitivity = 65,
  ): Promise<Blob> {
    const updated = applyAlphaMask(sourceImageData, maskData, sensitivity)
    return imageDataToPngBlob(updated)
  }

  /**
   * Strip the background of a stored sticker via IS-Net anime and replace its binary
   * with a transparent PNG. The pre-cutout blob is retained in memory so the
   * operation can be reverted within the session.
   */
  async function makeTransparent(
    id: string,
    options?: BackgroundRemovalOptions,
  ): Promise<void> {
    const blob = await localforage.getItem<Blob>(`sticker-data-${id}`)
    if (!blob)
      throw new Error(`No sticker data for ${id}`)

    options?.signal?.throwIfAborted()

    if (!transparencyOriginals.has(id))
      transparencyOriginals.set(id, blob)

    const outBlob = await removeImageBackground(blob, options)
    await updateSticker(id, { file: outBlob, mimeType: 'image/png' })
  }

  function hasTransparencyBackup(id: string): boolean {
    return transparencyOriginals.has(id)
  }

  /**
   * Restore the pre-cutout blob kept by `makeTransparent`. Returns false when
   * there is nothing to revert.
   */
  async function revertTransparency(id: string): Promise<boolean> {
    const original = transparencyOriginals.get(id)
    if (!original)
      return false
    await updateSticker(id, { file: original })
    transparencyOriginals.delete(id)
    return true
  }

  // --- Internals ---

  // Automatic cleanup of expired stickers
  useIntervalFn(() => {
    const now = Date.now()
    const initialCount = activePlacements.value.length
    activePlacements.value = activePlacements.value.filter(p => !p.expiresAt || p.expiresAt > now)

    if (import.meta.env.DEV && activePlacements.value.length !== initialCount) {
      console.log(`[StickersStore] Purged ${initialCount - activePlacements.value.length} expired stickers.`)
    }
  }, 2000)

  /**
   * Slap a sticker to the desktop via the Electron widget MPA if available,
   * falling back to in-DOM placement on web or stage surfaces.
   */
  async function slapSticker(idOrLabel: string, options: { weight?: number, pos?: string, ttlMs?: number } = {}) {
    const builtin = chatStickers.find(s => s.id === idOrLabel || s.description.toLowerCase() === idOrLabel.toLowerCase())
    const resolvedId = builtin ? builtin.id : (resolveStickerId(idOrLabel) ?? idOrLabel)

    if (typeof window !== 'undefined') {
      const win = window as any
      if (typeof win.spawnSticker === 'function') {
        return await win.spawnSticker(resolvedId, options)
      }
      if (win.electron?.ipcRenderer?.invoke) {
        return await win.electron.ipcRenderer.invoke('eventa:invoke:electron:windows:widgets:add', [{
          componentName: 'sticker',
          componentProps: {
            stickerId: resolvedId,
            weight: options.weight ?? 0.5,
            pos: options.pos ?? 'random',
          },
          ttlMs: options.ttlMs ?? 0,
        }])
      }
    }

    // Web / non-electron fallback: spawn in-DOM placement on stage
    return spawnSticker(resolvedId)
  }

  return {
    libraryMetadata,
    currentLibrary,
    standaloneMode,
    activePlacements,
    resolveStickerId,
    getStickerUrl,
    addSticker,
    updateSticker,
    deleteSticker,
    spawnSticker,
    slapSticker,
    removePlacement,
    updatePlacement,
    clearPlacements,
    clearLibrary,
    removeImageBackground,
    recomputeCutoutBlob,
    makeTransparent,
    revertTransparency,
    hasTransparencyBackup,
    chatStickers,
  }
})
