/**
 * Pluggable transport boundary.
 *
 * Aligned with upstream (dasilva333/airi) `packages/stage-shared/src/transport.ts`
 * so features ported from upstream (embassy-inbox, MessagingFriends, nap-chat
 * coordinator) compile against the same contract. Sovereignty extras
 * (`capabilities`, `requiresExternalRelay` gate) are kept as OPTIONAL fields so
 * upstream adapters port verbatim while the fork can still advertise and gate
 * relay-requiring adapters (see `transport-registry.ts`).
 *
 * Naming note: libp2p's own `Transport` (`@libp2p/interface`) is a different
 * concept and is never re-exported from `@proj-airi/stage-shared`.
 */

export type TransportId = 'cloudflare-edge' | 'libp2p-mesh' | 'loopback'
export type TransportStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface TransportMessage<T = unknown> {
  topic: string
  payload: T
  senderId: string
  timestamp: number
}

export type TransportHandler<T = unknown> = (msg: TransportMessage<T>) => void

// ── Sovereignty extras (optional, fork-only) ───────────────────────────────────
export interface TransportCapabilities {
  readonly isLocalOnly: boolean
  readonly supportsMultiParty: boolean
  readonly supportsMeshGossip: boolean
  readonly requiresExternalRelay: boolean
}

export interface TransportAdapter {
  readonly id: TransportId
  readonly status: TransportStatus

  // Upstream lifecycle + delivery
  start: () => Promise<void>
  stop: () => Promise<void>
  sendToPeer: <T>(peerId: string, topic: string, payload: T) => Promise<boolean>
  broadcast: <T>(topic: string, payload: T) => Promise<void>
  subscribe: <T>(topic: string, handler: TransportHandler<T>) => Promise<() => void>

  // Fork-only extras (optional, for backward compat / capability gating)
  readonly capabilities?: TransportCapabilities
  initialize?: () => Promise<void>
  dispose?: () => Promise<void>
  publish?: (topic: string, payload: Uint8Array) => Promise<void>
}

export interface CloudflareEdgeTransportConfig {
  workerOrigin: string
  senderPubkey: string
  sign: (message: string) => Promise<string>
}

export function createLoopbackTransport(): TransportAdapter {
  const subs = new Map<string, Set<TransportHandler<any>>>()
  let status: TransportStatus = 'disconnected'

  return {
    id: 'loopback',
    get status() { return status },
    async start() { status = 'connected' },
    async stop() {
      status = 'disconnected'
      subs.clear()
    },
    async sendToPeer(peerId, topic, payload) {
      const handlers = subs.get(topic)
      if (!handlers || handlers.size === 0)
        return false
      const msg = { topic, payload, senderId: peerId, timestamp: Date.now() }
      for (const handler of [...handlers]) handler(msg)
      return true
    },
    async broadcast(topic, payload) {
      const handlers = subs.get(topic)
      if (!handlers)
        return
      const msg = { topic, payload, senderId: 'local', timestamp: Date.now() }
      for (const handler of [...handlers]) handler(msg)
    },
    async subscribe(topic, handler) {
      let set = subs.get(topic)
      if (!set) {
        set = new Set()
        subs.set(topic, set)
      }
      set.add(handler as TransportHandler<any>)
      return () => {
        set!.delete(handler as TransportHandler<any>)
      }
    },
    capabilities: {
      isLocalOnly: true,
      supportsMultiParty: true,
      supportsMeshGossip: true,
      requiresExternalRelay: false,
    },
    initialize: async () => { status = 'connected' },
    dispose: async () => { status = 'disconnected'; subs.clear() },
    publish: async (topic, payload) => {
      const handlers = subs.get(topic)
      if (!handlers)
        return
      const msg = { topic, payload, senderId: 'local', timestamp: Date.now() }
      for (const handler of [...handlers]) handler(msg as TransportMessage<unknown>)
    },
  }
}
