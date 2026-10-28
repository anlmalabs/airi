import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { useMemoryLifetimeStore } from './memory-lifetime'

// ---------------------------------------------------------------------------
// Shared mocked boundaries (repos + provider/LLM chain). The store under test
// is real; only its persistence and inference edges are stubbed.
// ---------------------------------------------------------------------------
const shared = vi.hoisted(() => ({
  userId: 'test-user',
  provider: 'test-provider',
  model: 'test-model',
  cards: new Map<string, any>(),
  chatIndex: null as any,
  sessions: new Map<string, any>(),
  lifetime: new Map<string, any>(),
  provisioning: new Map<string, any>(),
  savedLifetime: [] as any[],
  savedProvisioning: [] as any[],
  generate: vi.fn(),
  getProviderInstance: vi.fn(async () => ({})),
  recordInferenceUsage: vi.fn(),
  failChunk3: false,
  systemOneConfigured: false,
  runLifetimeDayGate: vi.fn(),
  runWinnowTurnCompaction: vi.fn(async (windows: Array<{ id: string }>) => new Set(windows.map(w => w.id))),
}))

vi.mock('./auth', () => ({
  useAuthStore: () => ({ userId: ref(shared.userId) }),
}))

vi.mock('./modules/airi-card', () => ({
  // NOTICE: a real vue ref is required here — storeToRefs() does not unwrap
  // hand-rolled `{ get value() }` shapes, which left `cards.value` undefined.
  // The ref wraps the single shared Map (mutated in place per test).
  useAiriCardStore: () => ({ cards: ref(shared.cards) }),
}))

vi.mock('./modules/consciousness', () => ({
  useConsciousnessStore: () => ({ activeProvider: ref(shared.provider), activeModel: ref(shared.model) }),
}))

vi.mock('./providers', () => ({
  useProvidersStore: () => ({ getProviderInstance: shared.getProviderInstance }),
}))

vi.mock('./llm', () => ({
  useLLM: () => ({ generate: shared.generate }),
}))

vi.mock('./modules/live-session', () => ({
  useLiveSessionStore: () => ({ recordInferenceUsage: shared.recordInferenceUsage }),
}))

vi.mock('./modules/system-one', () => ({
  useSystemOneStore: () => ({
    get configured() { return shared.systemOneConfigured },
    runLifetimeDayGate: shared.runLifetimeDayGate,
    runWinnowTurnCompaction: shared.runWinnowTurnCompaction,
  }),
}))

vi.mock('../database/repos/chat-sessions.repo', () => ({
  chatSessionsRepo: {
    getIndex: async () => shared.chatIndex,
    getSession: async (id: string) => shared.sessions.get(id) ?? null,
  },
}))

vi.mock('../database/repos/lifetime-memory.repo', () => ({
  lifetimeMemoryRepo: {
    getByCharacter: async (c: string, u = 'global') => shared.lifetime.get(`${c}:${u}`) ?? null,
    save: async (c: string, u: string, a: any) => {
      shared.lifetime.set(`${c}:${u}`, a)
      shared.savedLifetime.push(a)
    },
    delete: async () => {},
  },
}))

vi.mock('../database/repos/provisioning-session.repo', () => ({
  provisioningSessionRepo: {
    get: async (c: string, u = 'global') => shared.provisioning.get(`${c}:${u}`) ?? null,
    save: async (s: any) => {
      // NOTICE: deep-clone like the real repo (which strips Vue proxies via
      // JSON round-trip) so phase-transition assertions observe each save as
      // written, not the final mutated object.
      const snapshot = JSON.parse(JSON.stringify(s))
      shared.provisioning.set(`${s.characterId}:${s.universeId || 'global'}`, snapshot)
      shared.savedProvisioning.push(snapshot)
    },
    delete: async (c: string, u = 'global') => {
      shared.provisioning.delete(`${c}:${u}`)
    },
  },
}))

vi.mock('../database/repos/short-term-memory.repo', () => ({
  shortTermMemoryRepo: { getAll: async () => [] },
}))

vi.mock('../database/repos/text-journal.repo', () => ({
  textJournalRepo: { getAll: async () => [] },
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const at = (month: number, day: number, h = 10, min = 0) => new Date(2026, month, day, h, min).getTime()
function keyAt(month: number, day: number) {
  const d = new Date(2026, month, day)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const userMsg = (id: string, text: string, createdAt: number) => ({ id, role: 'user', content: text, createdAt })

function sessionRecord(sessionId: string, messages: any[], universeId = 'global') {
  return {
    meta: { sessionId, userId: 'test-user', characterId: 'char-1', universeId, title: 'Main', messageCount: messages.length, createdAt: at(8, 20), updatedAt: at(9, 13) },
    messages,
  }
}

function indexFor(sessions: Record<string, any>) {
  return { userId: 'test-user', characters: { 'char-1': { activeSessionId: 's1', sessions } } }
}

function sessionMeta(sessionId: string, messageCount: number, universeId = 'global', title = 'Main') {
  return { sessionId, userId: 'test-user', characterId: 'char-1', universeId, title, messageCount, createdAt: at(8, 20), updatedAt: at(9, 13) }
}

const FULL_PACK = {
  relationship_core: Array.from({ length: 15 }, (_, i) => `core bullet ${i}`),
  user_patterns: ['says good morning daily', 'shares dinner photos'],
  shared_rituals: ['midnight ramen'],
  stable_topics: ['romance anime', 'rust programming'],
  meaningful_old_moments: ['first stargazing night'],
  inside_jokes_or_motifs: ['rubber duck debugging'],
}

function seedArtifact(over: Record<string, any> = {}) {
  return {
    id: 'art-1',
    characterId: 'char-1',
    universeId: 'global',
    version: 1,
    chunkSummaries: [{}],
    baseArchive: {},
    baseContent: '# base',
    distillPass1Pack: { ...FULL_PACK, compression_notes: [] },
    distilledContent: '# distilled',
    finalPack: { ...FULL_PACK, compression_notes: [] },
    sourceManifest: { rawTurnCount: 3, stmmBlockCount: 0, ltmmEntryCount: 0 },
    createdAt: 1,
    updatedAt: 1,
    metadata: { model: 't', totalElapsedMs: 1, chunkCount: 1, targetTokens: 1000, lastConsumedDay: '2026-10-12', lastUpdateType: 'init', mergesSinceRebase: 0, updateHistory: [] },
    ...over,
  }
}

// Union response: satisfies the required keys of the chunk, archive, and
// distill JSON schemas in a single payload.
const UNION_TEXT = JSON.stringify({
  durable_facts: ['df1'],
  recurring_preferences: ['rp1'],
  recurring_topics: ['rt1'],
  relationship_dynamics: ['rd1'],
  user_mannerisms: ['um1'],
  meaningful_moments: ['mm1'],
  inside_jokes_or_motifs: ['jj1'],
  relationship_summary: 'Dense relationship summary sentence one two three four five.',
  archive_notes: ['an1'],
  relationship_core: ['rc1'],
  user_patterns: ['up1'],
  shared_rituals: ['sr1'],
  stable_topics: ['st1'],
  meaningful_old_moments: ['mo1'],
  compression_notes: ['cn1'],
})

function mergeResponse(changed: boolean, pack: Record<string, any>) {
  return {
    text: JSON.stringify({ changed, change_notes: changed ? ['evolved'] : ['routine day'], ...pack }),
    usage: {},
  }
}

function freshStore() {
  setActivePinia(createPinia())
  return useMemoryLifetimeStore()
}

beforeEach(() => {
  shared.cards.clear()
  shared.cards.set('char-1', { name: 'Airi', extensions: { airi: { modules: {} } } })
  shared.chatIndex = null
  shared.sessions = new Map()
  shared.lifetime = new Map()
  shared.provisioning = new Map()
  shared.savedLifetime = []
  shared.savedProvisioning = []
  shared.failChunk3 = false
  // NOTICE: System-1 stays unconfigured by default so every existing suite
  // keeps exercising the hardened System-2 baseline untouched.
  shared.systemOneConfigured = false
  shared.runLifetimeDayGate.mockReset()
  shared.runWinnowTurnCompaction.mockReset()
  shared.generate.mockReset()
  shared.generate.mockResolvedValue({ text: UNION_TEXT, usage: {} })
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 14, 14, 30, 0))
})

async function withTimerAdvance<T>(promise: Promise<T>, ms = 30000): Promise<T> {
  const result = promise.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )
  await vi.advanceTimersByTimeAsync(ms)
  const settled = await result
  if (!settled.ok)
    throw settled.error
  return settled.value
}

// ---------------------------------------------------------------------------
// F-01: no premature "today" sealing
// ---------------------------------------------------------------------------
describe('f-01 watermark sealing', () => {
  it('clamps the initial provision watermark to yesterday', async () => {
    shared.sessions.set('s1', sessionRecord('s1', [
      userMsg('m1', 'oct 12 talk', at(9, 12)),
      userMsg('m2', 'oct 13 talk', at(9, 13)),
      userMsg('m3', 'today 10am talk', at(9, 14, 10)),
    ]))
    shared.chatIndex = indexFor({ s1: sessionMeta('s1', 3) })

    const store = freshStore()
    await store.provision('char-1', 'global', false, 0, 64, 1000)

    const saved = shared.savedLifetime.at(-1)
    expect(saved.metadata.lastConsumedDay).toBe('2026-10-13')
  })

  it('merges only completed days and never consumes today', async () => {
    shared.lifetime.set('char-1:global', seedArtifact())
    shared.sessions.set('s1', sessionRecord('s1', [
      userMsg('m1', 'oct 12 talk', at(9, 12)),
      userMsg('m2', 'oct 13 talk', at(9, 13)),
      userMsg('m3', 'TODAY-SECRET-TURN', at(9, 14, 10)),
    ]))
    shared.chatIndex = indexFor({ s1: sessionMeta('s1', 3) })
    shared.generate.mockResolvedValue(mergeResponse(false, FULL_PACK))

    const store = freshStore()
    await store.applyIncrementalUpdate('char-1', 'global')

    expect(shared.generate).toHaveBeenCalledTimes(1)
    const prompt = shared.generate.mock.calls[0][2][1].content as string
    expect(prompt).not.toContain('TODAY-SECRET-TURN')
    const saved = shared.savedLifetime.at(-1)
    expect(saved.metadata.lastConsumedDay).toBe('2026-10-13')
    expect(saved.version).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// F-02: reprovision preserves watermark + incremental evolution
// ---------------------------------------------------------------------------
describe('f-02 reprovisionFromChunks', () => {
  it('never re-aggregates sources and preserves watermark + learned bullets', async () => {
    const ramenPack = { ...FULL_PACK, relationship_core: [...FULL_PACK.relationship_core, 'loves late-night ramen'] }
    shared.lifetime.set('char-1:global', seedArtifact({
      version: 4,
      finalPack: ramenPack,
      metadata: { model: 't', totalElapsedMs: 1, chunkCount: 2, targetTokens: 1000, initialConsumedDay: '2026-10-01', lastConsumedDay: '2026-10-10', lastUpdateType: 'incremental', mergesSinceRebase: 3, updateHistory: [] },
    }))

    const store = freshStore()
    const spy = vi.spyOn(store, 'collectSourceDocs')
    await store.reprovisionFromChunks('char-1', 'global', 0, 3000)

    expect(spy).not.toHaveBeenCalled()
    const synthesisPrompt = shared.generate.mock.calls[0][2][1].content as string
    expect(synthesisPrompt).toContain('loves late-night ramen')
    const saved = shared.savedLifetime.at(-1)
    expect(saved.metadata.lastConsumedDay).toBe('2026-10-10')
    expect(saved.metadata.initialConsumedDay).toBe('2026-10-01')
    expect(saved.metadata.lastUpdateType).toBe('reprovision')
  })
})

// ---------------------------------------------------------------------------
// F-03: universe cache isolation
// ---------------------------------------------------------------------------
describe('f-03 universe isolation', () => {
  it('never merges one universe into another', async () => {
    shared.lifetime.set('char-1:global', seedArtifact({ id: 'art-global', universeId: 'global', version: 1 }))
    shared.lifetime.set('char-1:cyberpunk-au', seedArtifact({ id: 'art-cyber', universeId: 'cyberpunk-au', version: 7 }))
    shared.sessions.set('s-cyber', sessionRecord('s-cyber', [userMsg('mc1', 'neon rain talk', at(9, 13))], 'cyberpunk-au'))
    shared.chatIndex = {
      userId: 'test-user',
      characters: { 'char-1': { activeSessionId: 's-cyber', sessions: { 's-cyber': sessionMeta('s-cyber', 1, 'cyberpunk-au', 'Neon') } } },
    }
    shared.generate.mockResolvedValue(mergeResponse(false, FULL_PACK))

    const store = freshStore()
    await store.applyIncrementalUpdate('char-1', 'cyberpunk-au')

    expect(shared.savedLifetime.length).toBeGreaterThan(0)
    for (const a of shared.savedLifetime)
      expect(a.universeId).toBe('cyberpunk-au')
    expect(shared.lifetime.get('char-1:global').version).toBe(1)
    // The charId-keyed slot currently holds cyberpunk-au, so a global lookup
    // must refuse it (strict isolation) until global is explicitly loaded.
    expect(store.artifacts.get('char-1')).toBeUndefined()
    await store.loadForCharacter('char-1', 'global')
    expect(store.artifacts.get('char-1')?.version).toBe(1)
    expect((store.artifacts.get('char-1') as any)?.version).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// F-05: timeline headers + same-day fork dedup
// ---------------------------------------------------------------------------
describe('f-05 multi-timeline collection', () => {
  it('keeps branch headers attached and repeated greetings across days', async () => {
    shared.sessions.set('s-long', {
      meta: { sessionId: 's-long', userId: 'test-user', characterId: 'char-1', createdAt: at(8, 20) },
      messages: [
        userMsg('trunk-1', 'Shared trunk hello', at(9, 12, 9)),
        userMsg('m-long-1', 'Good morning', at(9, 12, 10)),
        userMsg('m-long-2', 'Good morning', at(9, 13, 10)),
        userMsg('m-long-3', 'Canonical evening thought', at(9, 13, 20)),
      ],
    })
    shared.sessions.set('s-branch', {
      meta: { sessionId: 's-branch', userId: 'test-user', characterId: 'char-1', createdAt: at(8, 21) },
      messages: [
        userMsg('trunk-1', 'Shared trunk hello', at(9, 12, 9)),
        userMsg('m-branch-1', 'Branch midnight idea', at(9, 12, 23)),
        { id: 'm-branch-2', role: 'assistant', content: 'Branch reply', createdAt: at(9, 13, 1) },
      ],
    })
    shared.chatIndex = indexFor({
      's-long': sessionMeta('s-long', 50, 'global', 'Canonical Journey'),
      's-branch': sessionMeta('s-branch', 5, 'global', 'Alt Night'),
    })

    const store = freshStore()
    const docs = await store.collectSourceDocs('char-1', 'global')

    expect(docs).toHaveLength(6)
    expect(docs.filter(d => d.text.includes('Good morning'))).toHaveLength(2)
    const all = docs.map(d => d.text).join('\n')
    expect(all).toContain('# Canonical Timeline: Canonical Journey')
    expect(all).toContain('# Timeline Branch: Alt Night (Alternative Path)')
  })
})

// ---------------------------------------------------------------------------
// F-06: true-diff + contraction guards, incremental status isolation
// ---------------------------------------------------------------------------
describe('f-06 merge guards', () => {
  function seedForMerge() {
    shared.lifetime.set('char-1:global', seedArtifact({ version: 3 }))
    shared.sessions.set('s1', sessionRecord('s1', [userMsg('m1', 'oct 13 talk', at(9, 13))]))
    shared.chatIndex = indexFor({ s1: sessionMeta('s1', 1) })
  }

  it('coerces changed:true with an identical pack to false without a version bump', async () => {
    seedForMerge()
    shared.generate.mockResolvedValue(mergeResponse(true, FULL_PACK))

    const store = freshStore()
    await store.applyIncrementalUpdate('char-1', 'global')

    const saved = shared.savedLifetime.at(-1)
    expect(saved.version).toBe(3)
    expect(saved.metadata.updateHistory.at(-1).changed).toBe(false)
  })

  it('retries a contracted merge and succeeds on the second attempt', async () => {
    seedForMerge()
    const tiny = { ...FULL_PACK, relationship_core: ['a', 'b', 'c', 'd'] }
    // The retry response must genuinely differ, or the true-diff guard would
    // (correctly) coerce it to changed:false and skip the version bump.
    const evolved = { ...FULL_PACK, relationship_core: [...FULL_PACK.relationship_core, 'brand new mannerism'] }
    const seenUpdating: boolean[] = []
    let liveStore: { isUpdatingIncremental: boolean } | null = null
    let calls = 0
    shared.generate.mockImplementation(async () => {
      seenUpdating.push(liveStore?.isUpdatingIncremental ?? false)
      calls += 1
      return calls === 1 ? mergeResponse(true, tiny) : mergeResponse(true, evolved)
    })
    const store = freshStore()
    liveStore = store as unknown as { isUpdatingIncremental: boolean }

    await withTimerAdvance(store.applyIncrementalUpdate('char-1', 'global'))

    expect(shared.generate).toHaveBeenCalledTimes(2)
    expect(seenUpdating).toEqual([true, true])
    const saved = shared.savedLifetime.at(-1)
    expect(saved.version).toBe(4)
    expect(saved.finalPack.relationship_core).toHaveLength(16)
    expect((store as any).isUpdatingIncremental).toBe(false)
    expect(store.isProvisioning).toBe(false)
    expect(store.progress.phase).toBe('idle')
  })
})

// ---------------------------------------------------------------------------
// Suite 2a: 14-day catch-up batching + crash recovery (also covers Catch 1)
// ---------------------------------------------------------------------------
describe('catch-up batching and crash recovery', () => {
  function seed18Days() {
    const messages = Array.from({ length: 18 }, (_, i) => {
      const d = new Date(2026, 8, 20 + i)
      return userMsg(`m${i}`, `day ${i} talk`, new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10).getTime())
    })
    // Fake "today" is 2026-10-14; shift the window so yesterday is 2026-10-07.
    vi.setSystemTime(new Date(2026, 9, 8, 14, 30, 0))
    shared.lifetime.set('char-1:global', seedArtifact({ metadata: { model: 't', totalElapsedMs: 1, chunkCount: 1, targetTokens: 1000, lastConsumedDay: '2026-09-19', lastUpdateType: 'init', mergesSinceRebase: 0, updateHistory: [] } }))
    shared.sessions.set('s1', sessionRecord('s1', messages))
    shared.chatIndex = indexFor({ s1: sessionMeta('s1', 18) })
  }

  it('processes exactly 14 days per run and persists per day', async () => {
    seed18Days()
    shared.generate.mockResolvedValue(mergeResponse(false, FULL_PACK))

    const store = freshStore()
    await store.applyIncrementalUpdate('char-1', 'global')

    expect(shared.generate).toHaveBeenCalledTimes(14)
    expect(shared.savedLifetime).toHaveLength(14)
    expect(shared.savedLifetime.map(a => a.metadata.lastConsumedDay)).toEqual(
      Array.from({ length: 14 }, (_, i) => keyAt(8, 20 + i)),
    )
    expect(shared.savedLifetime.at(-1).metadata.lastConsumedDay).toBe('2026-10-03')
  })

  it('keeps days 1-4 persisted and surfaces the error when day 5 fails', async () => {
    seed18Days()
    let calls = 0
    shared.generate.mockImplementation(async () => {
      calls += 1
      if (calls >= 5)
        throw new Error('boom')
      return mergeResponse(false, FULL_PACK)
    })

    const store = freshStore()
    await withTimerAdvance(store.applyIncrementalUpdate('char-1', 'global'), 60000)

    expect(shared.savedLifetime).toHaveLength(4)
    expect(shared.savedLifetime.at(-1).metadata.lastConsumedDay).toBe('2026-09-23')
    expect((store as any).incrementalError).toBe('boom')
  })
})

// ---------------------------------------------------------------------------
// Suite 2b: v2 auto-rollup at 15 merges
// ---------------------------------------------------------------------------
describe('v2 auto-rollup', () => {
  it('consolidates the base archive when mergesSinceRebase hits 15', async () => {
    shared.lifetime.set('char-1:global', seedArtifact({
      version: 5,
      chunkSummaries: [{ durable_facts: ['fact 1'] }],
      sourceManifest: { rawTurnCount: 9, stmmBlockCount: 0, ltmmEntryCount: 0 },
      metadata: { model: 't', totalElapsedMs: 1, chunkCount: 1, targetTokens: 1000, initialConsumedDay: '2026-10-01', lastConsumedDay: '2026-10-12', lastUpdateType: 'incremental', mergesSinceRebase: 14, updateHistory: [] },
    }))
    shared.sessions.set('s1', sessionRecord('s1', [userMsg('m1', 'oct 13 talk', at(9, 13))]))
    shared.chatIndex = indexFor({ s1: sessionMeta('s1', 1) })
    const evolved = { ...FULL_PACK, relationship_core: [...FULL_PACK.relationship_core, 'brand new mannerism'] }
    shared.generate
      .mockResolvedValueOnce(mergeResponse(true, evolved))
      .mockResolvedValue({ text: UNION_TEXT, usage: {} })

    const store = freshStore()
    await store.applyIncrementalUpdate('char-1', 'global')

    // 1 merge + 3 reprovision passes (synthesis + 2 distills)
    expect(shared.generate).toHaveBeenCalledTimes(4)
    expect(shared.savedProvisioning.length).toBeGreaterThan(0)
    // First save is the synthetic reprovision session; later saves record
    // phase transitions as the resumed pipeline advances.
    expect(shared.savedProvisioning[0].phase).toBe('synthesizing')
    const saved = shared.savedLifetime.at(-1)
    expect(saved.metadata.lastUpdateType).toBe('reprovision')
    expect(saved.metadata.mergesSinceRebase).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Suite 2c: provisioning checkpoint resume + background no-op guard
// ---------------------------------------------------------------------------
describe('provisioning checkpoints', () => {
  function seedThreeChunks() {
    const big = (label: string) => `User: ${label} ${'x'.repeat(3000)}`
    shared.sessions.set('s1', sessionRecord('s1', [
      userMsg('m1', big('one'), at(9, 13, 9)),
      userMsg('m2', big('two'), at(9, 13, 10)),
      userMsg('m3', big('three'), at(9, 13, 11)),
    ]))
    shared.chatIndex = indexFor({ s1: sessionMeta('s1', 3) })
  }

  it('resumes after chunk 2 without re-summarizing completed chunks', async () => {
    seedThreeChunks()
    shared.generate.mockImplementation(async (_m: any, _p: any, messages: any[]) => {
      const prompt = messages[1].content as string
      if (prompt.includes('This is chunk 3 of 3') && shared.failChunk3)
        throw new Error('rate limited')
      return { text: UNION_TEXT, usage: {} }
    })

    const store = freshStore()

    shared.failChunk3 = true
    await withTimerAdvance(store.provision('char-1', 'global', false, 0, 1, 1000))
    expect(store.error).toContain('rate limited')
    expect(shared.savedProvisioning.at(-1)?.completedChunks).toBe(2)
    expect(shared.savedLifetime).toHaveLength(0)

    shared.failChunk3 = false
    await store.provision('char-1', 'global', true, 0, 1, 1000)

    const chunkPrompts = shared.generate.mock.calls
      .map(c => c[2][1].content as string)
      .filter(p => p.includes('This is chunk'))
    expect(chunkPrompts.filter(p => p.includes('This is chunk 1 of 3'))).toHaveLength(1)
    expect(chunkPrompts.filter(p => p.includes('This is chunk 2 of 3'))).toHaveLength(1)
    expect(shared.savedLifetime).toHaveLength(1)
    expect(shared.savedLifetime[0].metadata.lastConsumedDay).toBe('2026-10-13')
  })

  it('skips background updates while a provisioning session is active', async () => {
    shared.provisioning.set('char-1:global', { characterId: 'char-1', universeId: 'global', phase: 'chunking' })
    const store = freshStore()
    await store.applyIncrementalUpdate('char-1', 'global')
    expect(shared.generate).not.toHaveBeenCalled()
    expect(shared.savedLifetime).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Suite 3: System-1 (Jev / Laya) fast-exit gate, surgical section lock & fallback
// ---------------------------------------------------------------------------
describe('system-1 (Jev) enhanced incremental maintenance', () => {
  function seedOneMissedDay() {
    shared.lifetime.set('char-1:global', seedArtifact({ version: 2 }))
    shared.sessions.set('s1', sessionRecord('s1', [userMsg('m1', 'oct 13 talk', at(9, 13))]))
    shared.chatIndex = indexFor({ s1: sessionMeta('s1', 1) })
  }

  it('fast-exits on routine days without calling System-2 LLM', async () => {
    seedOneMissedDay()
    shared.systemOneConfigured = true
    shared.runLifetimeDayGate.mockResolvedValue({
      shouldInvokeSystem2: false,
      triggeredSections: [],
      verdicts: {},
      auditNote: 'System-1 gate: routine day (no durable section changes)',
    })

    const store = freshStore()
    await store.applyIncrementalUpdate('char-1', 'global')

    expect(shared.runLifetimeDayGate).toHaveBeenCalledTimes(1)
    // Zero System-2 LLM calls!
    expect(shared.generate).not.toHaveBeenCalled()

    const saved = shared.savedLifetime.at(-1)
    expect(saved.version).toBe(2)
    expect(saved.metadata.lastConsumedDay).toBe('2026-10-13')
    expect(saved.metadata.updateHistory.at(-1)).toMatchObject({
      day: '2026-10-13',
      changed: false,
      notes: ['System-1 gate: routine day (no durable section changes)'],
    })
  })

  it('surgically locks un-triggered sections when System 1 unlocks only inside_jokes_or_motifs', async () => {
    seedOneMissedDay()
    shared.systemOneConfigured = true
    shared.runLifetimeDayGate.mockResolvedValue({
      shouldInvokeSystem2: true,
      triggeredSections: ['inside_jokes_or_motifs'],
      verdicts: {},
      auditNote: 'System-1: unlocked [inside_jokes_or_motifs], 5 sections frozen',
    })

    // System 2 tries to mutate relationship_core AND add an inside joke
    const overzealousSystem2Pack = {
      ...FULL_PACK,
      relationship_core: ['HALLUCINATED REWRITE'],
      inside_jokes_or_motifs: [...FULL_PACK.inside_jokes_or_motifs, 'noble gas argon'],
    }
    shared.generate.mockResolvedValue(mergeResponse(true, overzealousSystem2Pack))

    const store = freshStore()
    await store.applyIncrementalUpdate('char-1', 'global')

    expect(shared.generate).toHaveBeenCalledTimes(1)
    const saved = shared.savedLifetime.at(-1)
    expect(saved.version).toBe(3)
    // Un-triggered relationship_core remained frozen to FULL_PACK
    expect(saved.finalPack.relationship_core).toEqual(FULL_PACK.relationship_core)
    // Unlocked inside_jokes_or_motifs accepted the new bullet
    expect(saved.finalPack.inside_jokes_or_motifs).toEqual(['rubber duck debugging', 'noble gas argon'])
    expect(saved.metadata.updateHistory.at(-1).notes[0]).toBe('System-1: unlocked [inside_jokes_or_motifs], 5 sections frozen')
  })

  it('falls back cleanly to full System-2 merge if System-1 gate throws', async () => {
    seedOneMissedDay()
    shared.systemOneConfigured = true
    shared.runLifetimeDayGate.mockRejectedValue(new Error('Jev network timeout'))

    const evolved = { ...FULL_PACK, shared_rituals: ['midnight ramen', 'morning espresso'] }
    shared.generate.mockResolvedValue(mergeResponse(true, evolved))

    const store = freshStore()
    await store.applyIncrementalUpdate('char-1', 'global')

    expect(shared.generate).toHaveBeenCalledTimes(1)
    const saved = shared.savedLifetime.at(-1)
    expect(saved.version).toBe(3)
    expect(saved.finalPack.shared_rituals).toEqual(['midnight ramen', 'morning espresso'])
  })
})
