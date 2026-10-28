import { describe, expect, it, vi } from 'vitest'

import { createCloudflareEdgeTransport, NAP_CHAT_TOPICS } from './cloudflare-edge-transport'

describe('createCloudflareEdgeTransport', () => {
  it('posts signed envelopes to the peer worker inbox', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ queued: true }), { status: 200 }))
    const sign = vi.fn(async (message: string) => `sig:${message.length}`)
    const transport = createCloudflareEdgeTransport({
      senderPubkey: 'a'.repeat(64),
      resolvePeerWorkerUrl: peerId => peerId === 'peer-kirie' ? 'https://alex.workers.dev' : null,
      sign,
      fetchFn: fetchFn as any,
      now: () => 1_700_000_000_000,
      makeNonce: () => 'fixed-nonce-1234',
    })
    await transport.start()

    expect(await transport.sendToPeer('unknown-peer', NAP_CHAT_TOPICS.turn, {})).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()

    const ok = await transport.sendToPeer('peer-kirie', NAP_CHAT_TOPICS.turn, { text: 'hi' })
    expect(ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://alex.workers.dev/api/friends/inbox')
    expect((init.headers as Record<string, string>)['x-sender-pubkey']).toBe('a'.repeat(64))
    expect((init.headers as Record<string, string>)['x-signature-nonce']).toBe('fixed-nonce-1234')
    expect(sign).toHaveBeenCalledOnce()
    await transport.stop()
  })

  it('returns false on quarantine or network failure', async () => {
    const forbidden = createCloudflareEdgeTransport({
      senderPubkey: 'b'.repeat(64),
      resolvePeerWorkerUrl: () => 'https://alex.workers.dev',
      sign: async () => 'sig',
      fetchFn: (async () => new Response('quarantined', { status: 403 })) as any,
    })
    await forbidden.start()
    expect(await forbidden.sendToPeer('peer-kirie', NAP_CHAT_TOPICS.session, {})).toBe(false)
    await forbidden.stop()

    const failing = createCloudflareEdgeTransport({
      senderPubkey: 'b'.repeat(64),
      resolvePeerWorkerUrl: () => 'https://alex.workers.dev',
      sign: async () => { throw new Error('no key') },
      fetchFn: (async () => new Response('{}')) as any,
    })
    await failing.start()
    expect(await failing.sendToPeer('peer-kirie', NAP_CHAT_TOPICS.session, {})).toBe(false)
    await failing.stop()
  })

  it('fans out ingested inbound envelopes to topic subscribers', async () => {
    const transport = createCloudflareEdgeTransport({
      senderPubkey: 'c'.repeat(64),
      resolvePeerWorkerUrl: () => null,
      sign: async () => 'sig',
    })
    await transport.start()
    const received: unknown[] = []
    await transport.subscribe(NAP_CHAT_TOPICS.turn, msg => received.push(msg.payload))
    expect(transport.ingestInboundEnvelope('not-json', 'peer-x')).toBe(false)
    expect(transport.ingestInboundEnvelope(JSON.stringify({ topic: NAP_CHAT_TOPICS.turn, payload: { text: 'hey' } }), 'peer-x')).toBe(true)
    expect(received).toEqual([{ text: 'hey' }])
    await transport.stop()
  })
})
