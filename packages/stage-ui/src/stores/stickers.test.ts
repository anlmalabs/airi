import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useStickersStore } from './stickers'

vi.mock('./modules/airi-card', () => ({
  useAiriCardStore: () => ({
    activeCardId: 'default',
    activeCard: {
      extensions: {
        airi: {
          stickers: {},
        },
      },
    },
  }),
}))

// In-memory localforage so addSticker/updateSticker round-trip Blobs in Node.
const mockStickerDb = new Map<string, any>()
vi.mock('localforage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => mockStickerDb.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: any) => {
      mockStickerDb.set(key, value)
      return value
    }),
    removeItem: vi.fn(async (key: string) => {
      mockStickerDb.delete(key)
    }),
  },
}))

// Stub the worker adapter: no WebGPU/worker in unit tests.
const processImageMock = vi.fn(async (image: { width: number, height: number }) => ({
  data: new Uint8ClampedArray(image.width * image.height * 4),
  width: image.width,
  height: image.height,
}))
type AdapterState = 'idle' | 'loading' | 'ready' | 'processing' | 'error' | 'terminated'
const createdAdapters: Array<{ terminate: ReturnType<typeof vi.fn>, state: AdapterState }> = []
let mockAdapterState: AdapterState = 'ready'
vi.mock('../libs/inference/adapters/background-removal', () => ({
  createBackgroundRemovalAdapter: vi.fn(() => {
    const adapter = {
      load: vi.fn(async () => {}),
      processImage: processImageMock,
      terminate: vi.fn(),
      get state(): AdapterState { return mockAdapterState },
      deviceLossCount: 0,
    }
    createdAdapters.push(adapter)
    return adapter
  }),
}))

// Stub DOM image conversion (createImageBitmap/canvas unavailable in Node).
vi.mock('../libs/stickers/image-convert', () => ({
  blobToImageData: vi.fn(async (_blob: Blob) => ({
    data: new Uint8ClampedArray([255, 0, 0, 255]),
    width: 1,
    height: 1,
  })),
  imageDataToPngBlob: vi.fn(async (_image: unknown) => new Blob(['cutout'], { type: 'image/png' })),
  applyAlphaMask: vi.fn((source: any) => source),
}))

describe('useStickersStore - resolveStickerId', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('resolves exact match', () => {
    const store = useStickersStore()
    expect(store.resolveStickerId('airi-happy')).toBe('airi-happy')
    expect(store.resolveStickerId('lupin-warm-smile')).toBe('lupin-warm-smile')
  })

  it('resolves case and underscore/hyphen/space normalization', () => {
    const store = useStickersStore()
    expect(store.resolveStickerId('airi_happy')).toBe('airi-happy')
    expect(store.resolveStickerId('Airi Happy')).toBe('airi-happy')
    expect(store.resolveStickerId('LUPIN_WARM_SMILE')).toBe('lupin-warm-smile')
    expect(store.resolveStickerId('lupin cheer')).toBe('lupin-cheer')
  })

  it('resolves custom stickers with space-delimited names and character prefix', () => {
    const store = useStickersStore()
    store.libraryMetadata.push({
      id: 'character-smug',
      label: 'Character smug',
      addedAt: Date.now(),
      originalName: 'character-smug.png',
      mimeType: 'image/png',
    })
    store.libraryMetadata.push({
      id: 'character-neko',
      label: 'neko',
      addedAt: Date.now(),
      originalName: 'character-neko.png',
      mimeType: 'image/png',
    })

    // Exact space-separated display name
    expect(store.resolveStickerId('Character smug')).toBe('character-smug')
    expect(store.resolveStickerId('Character neko')).toBe('character-neko')

    // Single-word shorthand with 'character' prefix stripped
    expect(store.resolveStickerId('smug')).toBe('character-smug')
    expect(store.resolveStickerId('neko')).toBe('character-neko')
  })

  it('resolves builtin sticker descriptions', () => {
    const store = useStickersStore()
    expect(store.resolveStickerId('Celebration')).toBe('airi-celebrate')
    expect(store.resolveStickerId('Warm Smile')).toBe('lupin-warm-smile')
  })

  it('resolves token-overlap fuzzy matches with character prefix', () => {
    const store = useStickersStore()
    // arona_warm_smile -> [arona, warm, smile] -> strips known prefixes (none for arona) -> [arona, warm, smile]
    // candidates include lupin-warm-smile ([warm, smile] after stripping 'lupin') -> 2 shared tokens -> matches!
    expect(store.resolveStickerId('arona_warm_smile')).toBe('lupin-warm-smile')
    expect(store.resolveStickerId('arona_cheer')).toBe('lupin-cheer')
    expect(store.resolveStickerId('arona_tired')).toBe('airi-tired')
    expect(store.resolveStickerId('arona-thanks')).toBe('airi-thanks')
  })

  it('returns undefined for empty or non-matching inputs with no overlap', () => {
    const store = useStickersStore()
    expect(store.resolveStickerId('')).toBeUndefined()
    expect(store.resolveStickerId('completely_unrelated_xyz_123')).toBeUndefined()
  })
})

describe('useStickersStore - updateSticker', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useStickersStore()
    store.libraryMetadata = []
    store.activePlacements = []
  })

  it('updates label without changing ID', async () => {
    const store = useStickersStore()
    store.libraryMetadata.push({
      id: 'custom-smile',
      label: 'Old Label',
      addedAt: Date.now(),
      originalName: 'custom-smile.png',
      mimeType: 'image/png',
    })

    const result = await store.updateSticker('custom-smile', {
      label: 'New Grin Label',
    })

    expect(result).toBe('custom-smile')
    const item = store.libraryMetadata.find(m => m.id === 'custom-smile')
    expect(item?.label).toBe('New Grin Label')
  })

  it('renames sticker ID and updates metadata and active placements', async () => {
    const store = useStickersStore()
    store.libraryMetadata.push({
      id: 'smug',
      label: 'Smug Face',
      addedAt: Date.now(),
      originalName: 'smug.png',
      mimeType: 'image/png',
    })
    store.activePlacements.push({
      instanceId: 'inst-1',
      stickerId: 'smug',
      x: 100,
      y: 100,
      rotation: 0,
      scale: 1,
      createdAt: Date.now(),
    })

    const result = await store.updateSticker('smug', {
      id: 'character-smug',
      label: 'Smug Smirk',
    })

    expect(result).toBe('character-smug')
    expect(store.libraryMetadata.find(m => m.id === 'smug')).toBeUndefined()
    const item = store.libraryMetadata.find(m => m.id === 'character-smug')
    expect(item?.label).toBe('Smug Smirk')
    expect(store.activePlacements[0].stickerId).toBe('character-smug')
  })
})

describe('useStickersStore - background removal', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockStickerDb.clear()
    processImageMock.mockClear()
    createdAdapters.length = 0
    mockAdapterState = 'ready'
    const store = useStickersStore()
    store.libraryMetadata = []
  })

  async function seedSticker() {
    const store = useStickersStore()
    const id = await store.addSticker(new Blob(['opaque'], { type: 'image/jpeg' }), 'mug')
    return { store, id }
  }

  it('replaces the stored blob with a transparent PNG and keeps a revert backup', async () => {
    const { store, id } = await seedSticker()
    expect(store.hasTransparencyBackup(id)).toBe(false)

    await store.makeTransparent(id)

    expect(processImageMock).toHaveBeenCalledTimes(1)
    expect(store.hasTransparencyBackup(id)).toBe(true)
    const meta = store.libraryMetadata.find(m => m.id === id)
    expect(meta?.mimeType).toBe('image/png')
  })

  it('reverts to the original blob and clears the backup', async () => {
    const { store, id } = await seedSticker()
    await store.makeTransparent(id)
    expect(await store.revertTransparency(id)).toBe(true)
    expect(store.hasTransparencyBackup(id)).toBe(false)
    expect(await store.revertTransparency(id)).toBe(false)
  })

  it('throws when no sticker data is stored', async () => {
    const store = useStickersStore()
    await expect(store.makeTransparent('missing')).rejects.toThrow('No sticker data')
  })

  it('removeImageBackground returns a PNG blob without touching the library', async () => {
    const store = useStickersStore()
    const out = await store.removeImageBackground(new Blob(['raw'], { type: 'image/jpeg' }))
    expect(out).toBeInstanceOf(Blob)
    expect(out.type).toBe('image/png')
    expect(store.libraryMetadata).toHaveLength(0)
    expect(processImageMock).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the adapter when the previous one died without a model', async () => {
    const { store, id } = await seedSticker()
    await store.makeTransparent(id)
    expect(createdAdapters).toHaveLength(1)

    // Simulate host restart/teardown: fresh worker, no model loaded.
    mockAdapterState = 'idle'
    await store.makeTransparent(id)

    // Dead adapter terminated and replaced; original backup preserved.
    expect(createdAdapters).toHaveLength(2)
    expect(createdAdapters[0]!.terminate).toHaveBeenCalled()
    expect(store.hasTransparencyBackup(id)).toBe(true)
  })

  it('reuses the ready adapter across calls', async () => {
    const { store, id } = await seedSticker()
    await store.makeTransparent(id)
    await store.makeTransparent(id)
    expect(createdAdapters).toHaveLength(1)
  })
})
