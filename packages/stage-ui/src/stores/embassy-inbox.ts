import type { ExternalFriend, FriendRequest, Peer } from '@proj-airi/stage-shared'

import type { EmbassySocketRequest } from '../libs/transport/embassy-socket'

import { extractHandleAlias } from '@proj-airi/stage-shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'

import { getOrCreateDeviceKeypair, uint8ArrayToHex, usePeerEmbassy } from '../composables/use-peer-embassy'
import { createCloudflareEdgeTransport, NAP_CHAT_TOPICS } from '../libs/transport/cloudflare-edge-transport'
import { createEmbassySocket } from '../libs/transport/embassy-socket'
import { usePeersStore } from './peers'

export interface EmbassyInboxConnectOptions {
  workerUrl: string
  ownerId: string
  machineId?: string
  socketImpl?: typeof WebSocket
  fetchFn?: typeof fetch
}

export interface StagedOutboundMessage {
  id: string
  peerId: string
  peerName: string
  text: string
  status: 'review' | 'waiting' | 'sending' | 'sent' | 'failed'
  createdAt: number
  error?: string
}

function makeStagedId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return `staged-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  return `staged-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

interface EmbassySocketHandle {
  disconnect: () => void
  sendSync: () => boolean
  readonly status: string
}

async function signWithKeypair(privateKey: CryptoKey, message: string): Promise<string> {
  const data = new TextEncoder().encode(message)
  const sig = await crypto.subtle.sign('Ed25519', privateKey, data)
  return uint8ArrayToHex(new Uint8Array(sig))
}

/**
 * Live embassy inbox (plumbing side).
 *
 * Owns the hibernated WebSocket + CloudflareEdge transport pair and a real
 * inbound friend-request queue. Nap turns arriving on the socket are fanned
 * into the transport's subscriber set; the nap-chat coordinator subscribes
 * there. Accepting writes trust server-side first, roster second.
 */
export const useEmbassyInboxStore = defineStore('embassy-inbox', () => {
  const connected = ref(false)
  const socketStatus = ref('disconnected')
  const workerUrl = ref<string | null>(null)
  const ownerId = ref<string | null>(null)
  const inboundRequests = ref<FriendRequest[]>([])
  const ignoredIds = ref<Set<string>>(new Set())
  const recentTurns = ref<Array<{ topic: string, payload: unknown, senderId: string, timestamp: number }>>([])
  // NOTICE: human-in-the-loop staging queue for the nap-chat preview workbench.
  // Drafts sit at `review` until the user approves; approval attempts a real
  // `transport.sendToPeer` and lands on `sent` or falls back to `waiting`.
  const stagedOutbound = ref<StagedOutboundMessage[]>([])

  let socket: EmbassySocketHandle | null = null
  let transport: ReturnType<typeof createCloudflareEdgeTransport> | null = null
  let unsubscribeTurns: (() => void) | null = null

  const pendingRequests = computed(() => {
    const peersStore = usePeersStore()
    const trustedPubkeys = new Set((peersStore.friends as ExternalFriend[]).filter(p => p.trustState === 'trusted').map(p => p.id))
    const trustedHandles = (peersStore.friends as ExternalFriend[]).filter(p => p.trustState === 'trusted' && p.shareHandle).map(p => p.shareHandle.toLowerCase())

    return inboundRequests.value.filter((r) => {
      if (r.status !== 'pending' || ignoredIds.value.has(r.id))
        return false
      if (trustedPubkeys.has(r.fromPubkey))
        return false
      const reqHandle = r.fromHandle?.toLowerCase()
      if (reqHandle && trustedHandles.some(th => th === reqHandle || th.includes(reqHandle) || reqHandle.includes(th)))
        return false
      return true
    })
  })

  const activeMutualResolutions: Promise<void>[] = []

  async function resolveMutualAccept(request: FriendRequest, matchingPeer: ExternalFriend) {
    if (workerUrl.value && ownerId.value) {
      try {
        const fetchFn = (globalThis.fetch ?? fetch).bind(globalThis)
        await fetchFn(`${workerUrl.value.replace(/\/$/, '')}/api/friends/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-owner-id': ownerId.value },
          body: JSON.stringify({ pubkey: request.fromPubkey, handle: request.fromHandle }),
        })
      }
      catch (e) {
        console.warn('[embassyInboxStore] Failed to auto-authorize mutual peer on worker:', e)
      }
    }

    const peersStore = usePeersStore()
    if (matchingPeer.id !== request.fromPubkey) {
      await peersStore.removePeer(matchingPeer.id)
    }

    await peersStore.upsertPeer({
      ...matchingPeer,
      id: request.fromPubkey,
      alias: matchingPeer.alias || extractHandleAlias(request.fromHandle) || request.fromCharacterName,
      characterName: matchingPeer.characterName && matchingPeer.characterName !== 'Friend' ? matchingPeer.characterName : request.fromCharacterName,
      relationship: 'external-friend',
      trustState: 'trusted',
      lastSeenTimestamp: Date.now(),
      endpoints: {
        ...matchingPeer.endpoints,
        cloudflareWorkerUrl: request.fromHandle.startsWith('http') ? request.fromHandle : `https://${request.fromHandle}`,
      },
      shareHandle: request.fromHandle,
      allowedCapabilities: matchingPeer.allowedCapabilities || { canNapChat: true, canShareMemories: false, canStreamSensory: false },
      allowedCompanionIds: matchingPeer.allowedCompanionIds || [],
    })

    const inReq = inboundRequests.value.find(r => r.id === request.id || r.fromPubkey === request.fromPubkey)
    if (inReq) {
      inReq.status = 'accepted'
    }

    try {
      const friendName = request.fromCharacterName || matchingPeer.characterName || 'Friend'
      toast.success(`${friendName} accepted your friend request! You are now connected.`)
    }
    catch {}
  }

  function upsertRequest(request: FriendRequest | (EmbassySocketRequest & { status?: FriendRequest['status'] })) {
    const peersStore = usePeersStore()
    const reqAlias = extractHandleAlias(request.fromHandle)?.toLowerCase()

    const matchingPendingPeer = (peersStore.friends as ExternalFriend[]).find((p) => {
      if (p.trustState !== 'pending')
        return false
      if (p.id === request.fromPubkey)
        return true
      if (p.shareHandle && (p.shareHandle === request.fromHandle || request.fromHandle.includes(p.shareHandle) || p.shareHandle.includes(request.fromHandle)))
        return true
      const pAlias = extractHandleAlias(p.shareHandle || p.endpoints?.cloudflareWorkerUrl || '')?.toLowerCase()
      if (pAlias && reqAlias && pAlias === reqAlias)
        return true
      return false
    })

    const matchingTrustedPeer = (peersStore.friends as ExternalFriend[]).find((p) => {
      if (p.trustState !== 'trusted')
        return false
      if (p.id === request.fromPubkey)
        return true
      if (p.shareHandle && (p.shareHandle === request.fromHandle || request.fromHandle.includes(p.shareHandle) || p.shareHandle.includes(request.fromHandle)))
        return true
      const pAlias = extractHandleAlias(p.shareHandle || p.endpoints?.cloudflareWorkerUrl || '')?.toLowerCase()
      if (pAlias && reqAlias && pAlias === reqAlias)
        return true
      return false
    })

    const isMutual = Boolean(matchingPendingPeer)
    const isAlreadyTrusted = Boolean(matchingTrustedPeer)
    const isResolved = isMutual || isAlreadyTrusted || request.status === 'accepted'

    const idx = inboundRequests.value.findIndex(r => r.id === request.id)
    const normalized: FriendRequest = {
      id: request.id,
      fromHandle: request.fromHandle,
      fromPubkey: request.fromPubkey,
      fromCharacterName: request.fromCharacterName,
      introMessage: request.introMessage,
      fromTagline: request.fromTagline ?? null,
      timestamp: request.timestamp ?? Date.now(),
      nonce: request.nonce ?? request.id,
      status: isResolved ? 'accepted' : (request.status ?? 'pending'),
    }
    if (idx >= 0)
      inboundRequests.value[idx] = normalized
    else inboundRequests.value.push(normalized)

    if (matchingPendingPeer) {
      const p = resolveMutualAccept(normalized, matchingPendingPeer)
      activeMutualResolutions.push(p)
      void p.finally(() => {
        const i = activeMutualResolutions.indexOf(p)
        if (i >= 0)
          activeMutualResolutions.splice(i, 1)
      })
    }
  }

  async function waitForMutualResolutions() {
    await Promise.allSettled(activeMutualResolutions)
  }

  async function connect(options: EmbassyInboxConnectOptions) {
    disconnect()
    workerUrl.value = options.workerUrl
    ownerId.value = options.ownerId

    const keypair = await getOrCreateDeviceKeypair()
    const sign = (message: string) => signWithKeypair(keypair.privateKey, message)

    const peersStore = usePeersStore()
    await peersStore.init()
    const edgeTransport = createCloudflareEdgeTransport({
      senderPubkey: keypair.publicKeyHex,
      resolvePeerWorkerUrl: (peerId: string) => {
        const peer = (peersStore.roster as Peer[]).find(p => p.id === peerId)
        return peer?.endpoints.cloudflareWorkerUrl ?? null
      },
      sign,
      fetchFn: options.fetchFn,
    })
    transport = edgeTransport
    await edgeTransport.start()
    unsubscribeTurns = await edgeTransport.subscribe(NAP_CHAT_TOPICS.turn, (msg) => {
      recentTurns.value.push({ topic: msg.topic, payload: msg.payload, senderId: msg.senderId, timestamp: msg.timestamp })
      if (recentTurns.value.length > 50)
        recentTurns.value.splice(0, recentTurns.value.length - 50)
    })

    const sock = createEmbassySocket({
      workerUrl: options.workerUrl,
      ownerId: options.ownerId,
      machineId: options.machineId ?? `machine-${Date.now().toString(36)}`,
      socketImpl: options.socketImpl,
      events: {
        onEnvelopeText: raw => edgeTransport.ingestInboundEnvelope(raw, 'embassy-socket'),
        onRequest: request => upsertRequest(request),
        onSyncRequests: requests => requests.forEach(upsertRequest),
        onStatusChange: status => socketStatus.value = status,
      },
    })
    socket = sock
    sock.connect()
    connected.value = true
  }

  function disconnect() {
    try {
      socket?.disconnect()
    }
    catch {}
    try {
      unsubscribeTurns?.()
    }
    catch {}
    void transport?.stop().catch(() => {})
    socket = null
    transport = null
    unsubscribeTurns = null
    connected.value = false
    socketStatus.value = 'disconnected'
  }

  function ignoreRequest(id: string) {
    // NOTICE: local-only until the worker gains a decline route; a dropped
    // entry reappears on the next sync catch-up while the DO still holds it.
    ignoredIds.value.add(id)
    inboundRequests.value = inboundRequests.value.filter(r => r.id !== id)
  }

  async function acceptRequest(
    id: string,
    options?: { companionName?: string, sendReciprocal?: boolean, shareTagline?: boolean, senderTagline?: string },
  ): Promise<{ ok: boolean, error?: string }> {
    const request = inboundRequests.value.find(r => r.id === id)
    if (!request)
      return { ok: false, error: 'Unknown request.' }
    if (!workerUrl.value || !ownerId.value)
      return { ok: false, error: 'Embassy not connected.' }
    let res: Response
    try {
      const fetchFn = (globalThis.fetch ?? fetch).bind(globalThis)
      res = await fetchFn(`${workerUrl.value.replace(/\/$/, '')}/api/friends/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-owner-id': ownerId.value },
        body: JSON.stringify({ pubkey: request.fromPubkey, handle: request.fromHandle }),
      })
    }
    catch (err: any) {
      return { ok: false, error: err?.message || 'Network error.' }
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        detail = (await res.json() as any)?.error ?? detail
      }
      catch {}
      return { ok: false, error: String(detail) }
    }
    request.status = 'accepted'
    inboundRequests.value = inboundRequests.value.filter(r => r.id !== id)
    const peersStore = usePeersStore()
    await peersStore.upsertPeer({
      id: request.fromPubkey,
      alias: extractHandleAlias(request.fromHandle) || request.fromCharacterName,
      characterName: request.fromCharacterName,
      relationship: 'external-friend',
      trustState: 'trusted',
      lastSeenTimestamp: Date.now(),
      endpoints: {
        cloudflareWorkerUrl: request.fromHandle.startsWith('http') ? request.fromHandle : `https://${request.fromHandle}`,
      },
      shareHandle: request.fromHandle,
      // Sender's public blurb, when they opted in — persisted for prompt priming.
      tagline: request.fromTagline ?? null,
      allowedCapabilities: { canNapChat: false, canShareMemories: false, canStreamSensory: false },
      allowedCompanionIds: [],
    })

    if (options?.sendReciprocal && workerUrl.value) {
      try {
        const fromHandle = new URL(workerUrl.value).host
        const fromCharacterName = options?.companionName || 'AIRI'
        const { sendFriendRequest } = usePeerEmbassy()
        await sendFriendRequest(request.fromHandle, {
          fromHandle,
          fromCharacterName,
          introMessage: '[AIRI_MUTUAL_ACCEPT]',
          senderTagline: options?.shareTagline ? options?.senderTagline : undefined,
        }).catch((err) => {
          console.warn('[embassyInboxStore] Reciprocal friend request failed:', err)
        })
      }
      catch (e) {
        console.warn('[embassyInboxStore] Failed to dispatch reciprocal friend request:', e)
      }
    }

    return { ok: true }
  }

  function getTransport() {
    return transport
  }

  function queueOutbound(peerId: string, peerName: string, text: string): string {
    const id = makeStagedId()
    stagedOutbound.value.unshift({ id, peerId, peerName, text, status: 'review', createdAt: Date.now() })
    return id
  }

  function updateStagedText(id: string, text: string) {
    const entry = stagedOutbound.value.find(m => m.id === id)
    if (entry)
      entry.text = text
  }

  function discardStaged(id: string) {
    stagedOutbound.value = stagedOutbound.value.filter(m => m.id !== id)
  }

  function dismissTurn(senderId: string, timestamp: number) {
    recentTurns.value = recentTurns.value.filter(t => t.senderId !== senderId || t.timestamp !== timestamp)
  }

  async function approveStaged(id: string): Promise<{ ok: boolean, error?: string }> {
    const entry = stagedOutbound.value.find(m => m.id === id)
    if (!entry)
      return { ok: false, error: 'Unknown staged message.' }
    entry.status = 'sending'
    entry.error = undefined
    if (!transport) {
      entry.status = 'waiting'
      entry.error = 'Transport offline — staged for delivery.'
      return { ok: false, error: entry.error }
    }
    try {
      const ok = await transport.sendToPeer(entry.peerId, NAP_CHAT_TOPICS.turn, { text: entry.text })
      entry.status = ok ? 'sent' : 'waiting'
      if (!ok)
        entry.error = 'Recipient unreachable — staged for delivery.'
      return ok ? { ok: true } : { ok: false, error: entry.error }
    }
    catch (err: any) {
      entry.status = 'waiting'
      entry.error = err?.message || 'Send failed — staged for delivery.'
      return { ok: false, error: entry.error }
    }
  }

  return {
    connected,
    socketStatus,
    workerUrl,
    inboundRequests,
    pendingRequests,
    recentTurns,
    stagedOutbound,
    connect,
    disconnect,
    ignoreRequest,
    acceptRequest,
    getTransport,
    queueOutbound,
    updateStagedText,
    discardStaged,
    dismissTurn,
    approveStaged,
    waitForMutualResolutions,
  }
})
