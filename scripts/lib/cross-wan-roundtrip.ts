import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { webSockets } from '@libp2p/websockets'
import { createLibp2p } from 'libp2p'

export const CROSS_WAN_TEST_TOPIC = 'airi/cross-wan-test'

const PUBLISH_INTERVAL_MS = 2000
const SETTLE_MS = 3000

export interface RoundTripMessage {
  from: string
  ts: number
}

export type CrossWanNode = Awaited<ReturnType<typeof createLibp2p>>

export async function startNode(listen: string[] = ['/ip4/127.0.0.1/tcp/0/ws']): Promise<CrossWanNode> {
  const keyPair = await generateKeyPair('Ed25519')
  const node = await createLibp2p({
    privateKey: keyPair,
    addresses: { listen },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: false,
      }),
      identify: identify(),
      ping: ping(),
    },
    connectionManager: { maxConnections: 10 },
  })
  await node.start()
  return node
}

export async function runRoundTrip(
  node: CrossWanNode,
  options: { ignore?: string[], timeoutMs?: number } = {},
): Promise<RoundTripMessage | null> {
  const { ignore = [], timeoutMs = 120000 } = options
  const pubsub = node.services.pubsub
  const encoder = new TextEncoder()
  const ignored = new Set([node.peerId.toString(), ...ignore])

  await pubsub.subscribe(CROSS_WAN_TEST_TOPIC)

  const { promise, resolve } = Promise.withResolvers<RoundTripMessage | null>()

  let done = false
  let publisher: ReturnType<typeof setInterval> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const onMessage = (event: { detail: { topic: string, from?: { toString?: () => string } } }) => {
    const message = event.detail
    if (message.topic !== CROSS_WAN_TEST_TOPIC)
      return
    const from = message.from?.toString?.() ?? String(message.from)
    if (ignored.has(from))
      return
    setTimeout(() => finish(message as unknown as RoundTripMessage), SETTLE_MS)
  }

  const finish = (message: RoundTripMessage | null) => {
    if (done)
      return
    done = true
    clearInterval(publisher!)
    clearTimeout(timer!)
    pubsub.removeEventListener('message', onMessage)
    resolve(message)
  }

  pubsub.addEventListener('message', onMessage)

  const publish = () => {
    pubsub.publish(CROSS_WAN_TEST_TOPIC, encoder.encode(JSON.stringify({
      from: node.peerId.toString(),
      ts: Date.now(),
    }))).catch(() => {})
  }

  publish()
  publisher = setInterval(publish, PUBLISH_INTERVAL_MS)

  timer = setTimeout(() => finish(null), timeoutMs)

  return promise
}
