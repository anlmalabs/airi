import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PEERS_ROSTER_KEY } from '../database/repos/peers.repo'
import { storage } from '../database/storage'
import { useEmbassyInboxStore } from './embassy-inbox'

class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: ((event: any) => void) | null = null
  onmessage: ((event: any) => void) | null = null
  onclose: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  sent: string[] = []

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {}

  simulateOpen() {
    this.onopen?.({})
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data })
  }
}

function setup() {
  setActivePinia(createPinia())
  FakeSocket.instances = []
  const store = useEmbassyInboxStore()
  return { store }
}

async function connect(store: ReturnType<typeof useEmbassyInboxStore>) {
  await store.connect({
    workerUrl: 'https://airi-stage-edge.test.workers.dev',
    ownerId: 'owner-1',
    machineId: 'test-machine',
    socketImpl: FakeSocket as any,
  })
  FakeSocket.instances[0].simulateOpen()
}

describe('useEmbassyInboxStore', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals()
    await storage.removeItem(PEERS_ROSTER_KEY)
  })

  it('opens the embassy socket and requests a sync catch-up', async () => {
    const { store } = setup()
    await connect(store)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(FakeSocket.instances[0].url).toBe('wss://airi-stage-edge.test.workers.dev/ws?owner=owner-1&machine=test-machine')
    expect(FakeSocket.instances[0].sent).toEqual([JSON.stringify({ action: 'sync' })])
    expect(store.connected).toBe(true)
    store.disconnect()
    expect(store.connected).toBe(false)
  })

  it('fills the inbound queue from pending_sync without duplicates', async () => {
    const { store } = setup()
    await connect(store)
    const ws = FakeSocket.instances[0]
    const sync = {
      type: 'pending_sync',
      requests: [
        { id: 'r1', fromHandle: 'alex.workers.dev', fromPubkey: 'ab'.repeat(32), fromCharacterName: 'Kirie', timestamp: 1, nonce: 'n1', status: 'pending' },
        { id: 'r2', fromHandle: 'sarah.workers.dev', fromPubkey: 'cd'.repeat(32), fromCharacterName: 'Lain', timestamp: 2, nonce: 'n2', status: 'pending' },
      ],
    }
    ws.simulateMessage(JSON.stringify(sync))
    ws.simulateMessage(JSON.stringify(sync))
    expect(store.pendingRequests).toHaveLength(2)
    expect(store.pendingRequests.map(r => r.id).sort()).toEqual(['r1', 'r2'])
    store.disconnect()
  })

  it('routes nap turns through the transport into recentTurns', async () => {
    const { store } = setup()
    await connect(store)
    const envelope = JSON.stringify({ topic: 'airi/nap-chat/turn', payload: { text: 'hey' }, senderId: 'peer-x', timestamp: 7 })
    FakeSocket.instances[0].simulateMessage(JSON.stringify({ type: 'nap_turn', turn: { payloadJson: envelope } }))
    expect(store.recentTurns).toHaveLength(1)
    expect(store.recentTurns[0].topic).toBe('airi/nap-chat/turn')
    expect(store.recentTurns[0].senderId).toBe('peer-x')
    store.disconnect()
  })

  it('accept writes trust server-side first, roster second', async () => {
    const { store } = setup()
    await connect(store)
    FakeSocket.instances[0].simulateMessage(JSON.stringify({
      type: 'inbound_request',
      request: { id: 'r9', fromHandle: 'alex.workers.dev', fromPubkey: 'ab'.repeat(32), fromCharacterName: 'Kirie', timestamp: 1, nonce: 'n9', status: 'pending' },
    }))
    expect(store.pendingRequests).toHaveLength(1)

    const calls: Array<{ url: string, init: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ trusted: true }), { status: 200 })
    }))

    const res = await store.acceptRequest('r9')
    expect(res).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://airi-stage-edge.test.workers.dev/api/friends/accept')
    expect(JSON.parse(calls[0].init.body)).toEqual({ pubkey: 'ab'.repeat(32), handle: 'alex.workers.dev' })
    expect(calls[0].init.headers['x-owner-id']).toBe('owner-1')
    expect(store.pendingRequests).toHaveLength(0)

    const { usePeersStore } = await import('./peers')
    const peers = usePeersStore()
    const entry = peers.roster.find(p => p.id === 'ab'.repeat(32))
    expect(entry?.trustState).toBe('trusted')
    expect(entry && 'allowedCapabilities' in entry && (entry as any).allowedCapabilities.canNapChat).toBe(false)
    store.disconnect()
  })

  it('rejects unknown requests and surfaces worker failures', async () => {
    const { store } = setup()
    await connect(store)
    expect(await store.acceptRequest('nope')).toEqual({ ok: false, error: 'Unknown request.' })

    FakeSocket.instances[0].simulateMessage(JSON.stringify({
      type: 'inbound_request',
      request: { id: 'r8', fromHandle: 'alex.workers.dev', fromPubkey: 'ab'.repeat(32), fromCharacterName: 'Kirie', timestamp: 1, nonce: 'n8', status: 'pending' },
    }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'quarantined' }), { status: 403 })))
    expect((await store.acceptRequest('r8')).ok).toBe(false)
    expect(store.pendingRequests).toHaveLength(1)
    store.disconnect()
  })

  it('ignore filters locally and survives resync within the session', async () => {
    const { store } = setup()
    await connect(store)
    const ws = FakeSocket.instances[0]
    const mk = (id: string) => JSON.stringify({ type: 'pending_sync', requests: [{ id, fromHandle: 'a.w.dev', fromPubkey: 'ab'.repeat(32), fromCharacterName: 'K', timestamp: 1, nonce: id, status: 'pending' }] })
    ws.simulateMessage(mk('r1'))
    expect(store.pendingRequests).toHaveLength(1)
    store.ignoreRequest('r1')
    expect(store.pendingRequests).toHaveLength(0)
    ws.simulateMessage(mk('r1'))
    expect(store.pendingRequests).toHaveLength(0)
    store.disconnect()
  })

  it('auto-accepts inbound request if an outbound request is pending for that peer (mutual accept)', async () => {
    const { store } = setup()
    await connect(store)

    const { usePeersStore } = await import('./peers')
    const peers = usePeersStore()
    await peers.upsertPeer({
      id: 'placeholder-temp-id',
      alias: 'bob',
      characterName: 'Bob Companion',
      relationship: 'external-friend',
      trustState: 'pending',
      lastSeenTimestamp: Date.now(),
      endpoints: { cloudflareWorkerUrl: 'https://bob.workers.dev' },
      shareHandle: 'bob.workers.dev',
      allowedCapabilities: { canNapChat: true, canShareMemories: false, canStreamSensory: false },
      allowedCompanionIds: ['card-123'],
    })

    const calls: Array<{ url: string, init: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ trusted: true }), { status: 200 })
    }))

    const ws = FakeSocket.instances[0]
    ws.simulateMessage(JSON.stringify({
      type: 'inbound_request',
      request: {
        id: 'r-reciprocal',
        fromHandle: 'airi-stage-edge.bob.workers.dev',
        fromPubkey: '11'.repeat(32),
        fromCharacterName: 'Bob Real Companion',
        timestamp: Date.now(),
        nonce: 'nonce-reciprocal',
        status: 'pending',
      },
    }))

    await store.waitForMutualResolutions()

    // Inbound request should be marked accepted and not appear in pendingRequests
    expect(store.pendingRequests).toHaveLength(0)

    // Worker accept endpoint was called with Bob's pubkey
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://airi-stage-edge.test.workers.dev/api/friends/accept')
    expect(JSON.parse(calls[0].init.body)).toEqual({ pubkey: '11'.repeat(32), handle: 'airi-stage-edge.bob.workers.dev' })

    // Peer record was updated to trusted with new pubkey and preserved capabilities
    const entry = peers.roster.find(p => p.id === '11'.repeat(32))
    expect(entry).toBeDefined()
    expect(entry?.trustState).toBe('trusted')
    expect(entry?.characterName).toBe('Bob Companion')
    expect((entry as { allowedCompanionIds?: string[] } | undefined)?.allowedCompanionIds).toEqual(['card-123'])

    // Old placeholder peer ID was removed
    expect(peers.roster.find(p => p.id === 'placeholder-temp-id')).toBeUndefined()

    store.disconnect()
  })

  it('dispatches reciprocal friend request when acceptRequest is called with sendReciprocal', async () => {
    const { store } = setup()
    await connect(store)

    const ws = FakeSocket.instances[0]
    ws.simulateMessage(JSON.stringify({
      type: 'inbound_request',
      request: { id: 'r-manual', fromHandle: 'charlie.workers.dev', fromPubkey: '22'.repeat(32), fromCharacterName: 'Charlie', timestamp: 1, nonce: 'n-c', status: 'pending' },
    }))

    const calls: Array<{ url: string, init: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: true, status: 'pending', id: 'reciprocal-id' }), { status: 200 })
    }))

    const res = await store.acceptRequest('r-manual', {
      companionName: 'My Custom AIRI',
      sendReciprocal: true,
    })
    expect(res).toEqual({ ok: true })

    // Call 1: local worker /api/friends/accept
    expect(calls[0].url).toBe('https://airi-stage-edge.test.workers.dev/api/friends/accept')
    expect(JSON.parse(calls[0].init.body)).toEqual({ pubkey: '22'.repeat(32), handle: 'charlie.workers.dev' })

    // Call 2: reciprocal request sent to charlie's worker /api/friends/request
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const reciprocalCall = calls.find(c => c.url.includes('charlie.workers.dev/api/friends/request'))
    expect(reciprocalCall).toBeDefined()
    const reciprocalBody = JSON.parse(reciprocalCall!.init.body)
    expect(reciprocalBody.fromCharacterName).toBe('My Custom AIRI')
    expect(reciprocalBody.fromHandle).toBe('airi-stage-edge.test.workers.dev')
    expect(reciprocalBody.introMessage).toBe('[AIRI_MUTUAL_ACCEPT]')

    store.disconnect()
  })

  it('stages outbound drafts at review and edits/discards them before dispatch', async () => {
    // ROOT CAUSE: the preview workbench queued into a local ref, so Approve
    // never touched the transport. Staged drafts must live in this store.
    const { store } = setup()
    const id = store.queueOutbound('peer-yuki', 'Yuki', 'Hello from preview')
    expect(store.stagedOutbound).toHaveLength(1)
    expect(store.stagedOutbound[0]).toMatchObject({ id, peerId: 'peer-yuki', status: 'review' })
    store.updateStagedText(id, 'Edited draft')
    expect(store.stagedOutbound[0].text).toBe('Edited draft')
    store.discardStaged(id)
    expect(store.stagedOutbound).toHaveLength(0)
    store.disconnect()
  })

  it('approve without transport falls back to waiting instead of dropping the draft', async () => {
    const { store } = setup()
    const id = store.queueOutbound('peer-yuki', 'Yuki', 'Hello')
    const res = await store.approveStaged(id)
    expect(res.ok).toBe(false)
    expect(store.stagedOutbound[0].status).toBe('waiting')
    store.disconnect()
  })

  it('approve dispatches via Edge transport and marks sent on success', async () => {
    // NOTICE: the Edge transport binds fetchFn at connect time, so the stub
    // must ride in via connect options — a late global stub misses it.
    const { store } = setup()
    const fetchCalls: string[] = []
    await store.connect({
      workerUrl: 'https://airi-stage-edge.test.workers.dev',
      ownerId: 'owner-1',
      machineId: 'test-machine',
      socketImpl: FakeSocket as any,
      fetchFn: (async (url: any) => {
        fetchCalls.push(String(url))
        return new Response('{}', { status: 200 })
      }) as any,
    })
    FakeSocket.instances[0].simulateOpen()

    const { usePeersStore } = await import('./peers')
    const peers = usePeersStore()
    await peers.upsertPeer({
      id: 'peer-yuki',
      alias: 'yuki',
      characterName: 'Yuki',
      relationship: 'external-friend',
      trustState: 'trusted',
      lastSeenTimestamp: Date.now(),
      endpoints: { cloudflareWorkerUrl: 'https://yuki.workers.dev' },
      shareHandle: 'yuki.workers.dev',
      allowedCapabilities: { canNapChat: true, canShareMemories: false, canStreamSensory: false },
      allowedCompanionIds: [],
    })

    const id = store.queueOutbound('peer-yuki', 'Yuki', 'Hello via Edge')
    const res = await store.approveStaged(id)
    expect(res).toEqual({ ok: true })
    expect(store.stagedOutbound[0].status).toBe('sent')
    expect(fetchCalls.some(u => u.startsWith('https://yuki.workers.dev/api/friends/inbox'))).toBe(true)
    store.disconnect()
  })

  it('carries an opted-in sender tagline from socket to peer record', async () => {
    // ROOT CAUSE: the handshake primes both sides pre-first-turn, so the
    // tagline must survive intake → review → accept without re-fetching.
    const { store } = setup()
    await connect(store)

    const ws = FakeSocket.instances[0]
    ws.simulateMessage(JSON.stringify({
      type: 'inbound_request',
      request: {
        id: 'r-tagline',
        fromHandle: 'yuki.workers.dev',
        fromPubkey: 'ab'.repeat(32),
        fromCharacterName: 'Yuki',
        introMessage: 'hi',
        fromTagline: 'Quiet conversations',
        timestamp: 1,
        nonce: 'n-tag',
        status: 'pending',
      },
    }))
    expect(store.inboundRequests.find(r => r.id === 'r-tagline')?.fromTagline).toBe('Quiet conversations')

    const calls: Array<{ url: string, init: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ trusted: true }), { status: 200 })
    }))
    const res = await store.acceptRequest('r-tagline')
    expect(res).toEqual({ ok: true })

    const { usePeersStore } = await import('./peers')
    const peers = usePeersStore()
    const entry = peers.roster.find(p => p.id === 'ab'.repeat(32))
    expect(entry && 'tagline' in entry && (entry as any).tagline).toBe('Quiet conversations')
    store.disconnect()
  })

  it('marks inbound request as accepted and excludes from pendingRequests if peer is already trusted', async () => {
    const { store } = setup()
    await connect(store)

    const { usePeersStore } = await import('./peers')
    const peers = usePeersStore()
    await peers.upsertPeer({
      id: '99'.repeat(32),
      alias: 'dave',
      characterName: 'Dave Companion',
      relationship: 'external-friend',
      trustState: 'trusted',
      lastSeenTimestamp: Date.now(),
      endpoints: { cloudflareWorkerUrl: 'https://dave.workers.dev' },
      shareHandle: 'dave.workers.dev',
      allowedCapabilities: { canNapChat: true, canShareMemories: false, canStreamSensory: false },
      allowedCompanionIds: [],
    })

    const ws = FakeSocket.instances[0]
    ws.simulateMessage(JSON.stringify({
      type: 'inbound_request',
      request: {
        id: 'r-already-trusted',
        fromHandle: 'dave.workers.dev',
        fromPubkey: '99'.repeat(32),
        fromCharacterName: 'Dave Companion',
        timestamp: Date.now(),
        nonce: 'nonce-already-trusted',
        status: 'pending',
      },
    }))

    // Should NOT appear in pendingRequests
    expect(store.pendingRequests).toHaveLength(0)
    // The internal inbound request should be marked accepted
    const req = store.inboundRequests.find(r => r.id === 'r-already-trusted')
    expect(req).toBeDefined()
    expect(req?.status).toBe('accepted')

    store.disconnect()
  })
})
