import type { TransportAdapter, TransportHandler, TransportId, TransportStatus } from '@proj-airi/stage-shared'

export const NAP_CHAT_TOPICS = {
  session: 'airi/nap-chat/session',
  turn: 'airi/nap-chat/turn',
} as const

export interface CloudflareEdgeTransportOptions {
  senderPubkey: string
  resolvePeerWorkerUrl: (peerId: string) => string | null
  sign: (message: string) => Promise<string>
  fetchFn?: typeof fetch
  now?: () => number
  makeNonce?: () => string
}

function defaultNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID().replace(/-/g, '')
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function createCloudflareEdgeTransport(options: CloudflareEdgeTransportOptions): TransportAdapter & {
  ingestInboundEnvelope: (rawText: string, senderId: string) => boolean
} {
  const subs = new Map<string, Set<TransportHandler<any>>>()
  let status: TransportStatus = 'disconnected'
  const fetchFn = options.fetchFn ?? fetch
  const now = options.now ?? Date.now
  const makeNonce = options.makeNonce ?? defaultNonce

  function dispatch(topic: string, payload: unknown, senderId: string, timestamp: number): void {
    const handlers = subs.get(topic)
    if (!handlers)
      return
    const msg = { topic, payload, senderId, timestamp }
    for (const handler of [...handlers]) {
      try {
        handler(msg)
      }
      catch {
        // NOTICE: a single faulty subscriber must never break inbox fan-out.
      }
    }
  }

  function ingestInboundEnvelope(rawText: string, senderId: string): boolean {
    try {
      const parsed = JSON.parse(rawText) as { topic?: string, payload?: unknown, senderId?: string, timestamp?: number }
      if (typeof parsed.topic !== 'string' || !parsed.topic)
        return false
      dispatch(parsed.topic, parsed.payload, typeof parsed.senderId === 'string' ? parsed.senderId : senderId, typeof parsed.timestamp === 'number' ? parsed.timestamp : now())
      return true
    }
    catch {
      return false
    }
  }

  return {
    id: 'cloudflare-edge' as TransportId,
    get status() { return status },
    // NOTICE: the sovereign gate refuses adapters that declare
    // `requiresExternalRelay: true`. A Cloudflare Worker relay always needs an
    // external relay, so this adapter must declare it — an adapter without the
    // flag is treated as local-only by the registry and would slip past the gate.
    capabilities: {
      isLocalOnly: false,
      requiresExternalRelay: true,
      supportsMultiParty: true,
      supportsMeshGossip: false,
    },
    async start() { status = 'connected' },
    async stop() {
      status = 'disconnected'
      subs.clear()
    },
    async sendToPeer(peerId, topic, payload) {
      if (status !== 'connected')
        return false
      const workerUrl = options.resolvePeerWorkerUrl(peerId)
      if (!workerUrl)
        return false
      const timestamp = now()
      const nonce = makeNonce()
      const envelope = JSON.stringify({ topic, payload, senderId: options.senderPubkey, timestamp })
      let signature = ''
      try {
        signature = await options.sign(`${timestamp}:${nonce}:${envelope}`)
      }
      catch {
        return false
      }
      try {
        const res = await fetchFn(`${workerUrl.replace(/\/$/, '')}/api/friends/inbox`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-sender-pubkey': options.senderPubkey,
            'x-signature-ed25519': signature,
            'x-signature-timestamp': String(timestamp),
            'x-signature-nonce': nonce,
          },
          body: envelope,
        })
        return res.ok
      }
      catch {
        return false
      }
    },
    async broadcast(_topic, _payload) {
      return undefined
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
    ingestInboundEnvelope,
  }
}
