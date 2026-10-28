import type { SameAccountDevice } from '@proj-airi/stage-shared'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getLocalMachineId, usePeersStore } from './peers'

vi.mock('../database/repos/peers.repo', () => ({
  peersRepo: {
    loadRoster: vi.fn().mockResolvedValue([]),
    saveRoster: vi.fn().mockResolvedValue(undefined),
  },
}))

describe('peers store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('initializes local device and allows renaming it', async () => {
    const store = usePeersStore()
    await store.init()

    const machineId = getLocalMachineId()
    const local = store.roster.find(p => p.relationship === 'same-account' && (p as SameAccountDevice).machineId === machineId) as SameAccountDevice
    expect(local).toBeDefined()
    expect(local.alias).toBeTruthy()

    await store.renameLocalDevice('Studio Mac Studio')
    expect(local.alias).toBe('Studio Mac Studio')

    // Trims whitespace
    await store.renameLocalDevice('   Workstation   ')
    expect(local.alias).toBe('Workstation')

    // Ignores empty string
    await store.renameLocalDevice('   ')
    expect(local.alias).toBe('Workstation')
  })

  it('prunes matching pending placeholder peers when upserting a trusted external friend', async () => {
    const store = usePeersStore()
    await store.init()

    // Add a pending peer created when sending an invite/request
    await store.upsertPeer({
      id: 'ed25519-airi-placeholder',
      alias: 'airi',
      characterName: 'AIRI',
      relationship: 'external-friend',
      trustState: 'pending',
      lastSeenTimestamp: Date.now(),
      endpoints: { cloudflareWorkerUrl: 'https://airi-stage-edge.r1ch4rd.workers.dev' },
      shareHandle: 'airi-stage-edge.r1ch4rd.workers.dev',
      allowedCapabilities: { canNapChat: true, canShareMemories: false, canStreamSensory: false },
    })

    expect(store.friends).toHaveLength(1)
    expect(store.friends[0].id).toBe('ed25519-airi-placeholder')
    expect(store.friends[0].trustState).toBe('pending')

    // Upsert trusted friend with the real ed25519 pubkey
    await store.upsertPeer({
      id: 'real-pubkey-55'.repeat(3),
      alias: 'r1ch4rd',
      characterName: 'AIRI',
      relationship: 'external-friend',
      trustState: 'trusted',
      lastSeenTimestamp: Date.now(),
      endpoints: { cloudflareWorkerUrl: 'https://airi-stage-edge.r1ch4rd.workers.dev' },
      shareHandle: 'airi-stage-edge.r1ch4rd.workers.dev',
      allowedCapabilities: { canNapChat: true, canShareMemories: false, canStreamSensory: false },
    })

    // Stale pending placeholder should be pruned, leaving only the trusted friend
    expect(store.friends).toHaveLength(1)
    expect(store.friends[0].id).toBe('real-pubkey-55'.repeat(3))
    expect(store.friends[0].trustState).toBe('trusted')
  })
})
