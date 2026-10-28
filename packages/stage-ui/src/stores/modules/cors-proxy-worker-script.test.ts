/**
 * Parity lock between the deployed template worker
 * (CORS_PROXY_WORKER_SCRIPT, the actual bytes Cloudflare runs) and the
 * security contract in apps/stage-edge/src/index.ts.
 *
 * The template is loaded through a data: URL and executed for real with a
 * mocked env. If these tests fail, the template has drifted from the
 * canonical worker — do not deploy until they pass.
 */
import { describe, expect, it, vi } from 'vitest'

import { CORS_PROXY_WORKER_SCRIPT } from './cors-proxy-worker-script'

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function loadTemplate(): Promise<{ fetch: (req: Request, env?: unknown) => Promise<Response> }> {
  const mod = await import(
    `data:text/javascript;charset=utf-8,${encodeURIComponent(CORS_PROXY_WORKER_SCRIPT)}`,
  )
  return mod.default
}

function createKv() {
  const map = new Map<string, string>()
  return {
    store: map,
    async get(key: string) {
      return map.has(key) ? map.get(key)! : null
    },
    async put(key: string, value: string) {
      map.set(key, value)
    },
    async delete(key: string) {
      map.delete(key)
    },
  }
}

async function generateEdKey() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
  const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey)
  return { keyPair, publicKeyHex: uint8ArrayToHex(new Uint8Array(rawPublicKey)) }
}

describe('cors-proxy-worker-script embassy parity', () => {
  it('exposes a public ambassador card without secrets', async () => {
    const worker = await loadTemplate()
    const res = await worker.fetch(new Request('https://edge.test/api/companion/card'))
    expect(res.status).toBe(200)
    const data: any = await res.json()
    expect(data.name).toBeTruthy()
    expect(data.publicKey).toBeNull()
    expect(data.tagline).toBe('Personal Edge Companion')

    const branded = await worker.fetch(new Request('https://edge.test/api/companion/card'), { COMPANION_TAGLINE: 'Quiet conversations' } as any)
    expect(((await branded.json()) as any).tagline).toBe('Quiet conversations')
  })

  it('ferries an opted-in sender tagline to storage without touching the signature', async () => {
    const worker = await loadTemplate()
    const { keyPair, publicKeyHex } = await generateEdKey()
    const kv = createKv()
    const env: any = { MEMORY: kv, OWNER_ID: 'owner-1' }
    const sign = async (msg: string) =>
      uint8ArrayToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, new TextEncoder().encode(msg))))

    // Signature payload deliberately excludes the tagline (self-asserted claim).
    const ts = Date.now()
    const sig = await sign(`${ts}:parity-tagline-1:hi:${publicKeyHex}`)
    const res = await worker.fetch(new Request('https://edge.test/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({
        fromHandle: 'alex.workers.dev',
        fromPubkey: publicKeyHex,
        fromCharacterName: 'Kirie',
        introMessage: 'hi',
        fromTagline: 'Quiet <b>conversations</b>',
        timestamp: ts,
        nonce: 'parity-tagline-1',
        signature: sig,
      }),
    }), env)
    expect(res.status).toBe(200)

    const stored = [...kv.store.values()].map(v => JSON.parse(v)).find(r => r.nonce === 'parity-tagline-1')
    expect(stored).toBeDefined()
    expect(stored.fromTagline).toBe('Quiet conversations')

    const tooLong = await worker.fetch(new Request('https://edge.test/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({
        fromHandle: 'alex.workers.dev',
        fromPubkey: publicKeyHex,
        fromCharacterName: 'Kirie',
        introMessage: 'hi',
        fromTagline: 'x'.repeat(141),
        timestamp: Date.now(),
        nonce: 'parity-tagline-2',
        signature: '00'.repeat(64),
      }),
    }), env)
    expect(tooLong.status).toBe(400)
  })

  it('rejects unsigned, stale, replayed, and over-long friend requests', async () => {
    const worker = await loadTemplate()
    const { keyPair, publicKeyHex } = await generateEdKey()
    const kv = createKv()
    const env: any = { MEMORY: kv, OWNER_ID: 'owner-1' }
    const sign = async (msg: string) =>
      uint8ArrayToHex(new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, new TextEncoder().encode(msg))))

    const base = {
      fromHandle: 'alex.workers.dev',
      fromPubkey: publicKeyHex,
      fromCharacterName: 'Kirie',
      introMessage: 'hi',
      timestamp: Date.now(),
      nonce: 'parity-nonce-1',
      signature: '',
    }

    const tampered = await worker.fetch(new Request('https://edge.test/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ ...base, signature: '00'.repeat(64) }),
    }), env)
    expect(tampered.status).toBe(401)

    const stale = await worker.fetch(new Request('https://edge.test/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ ...base, timestamp: Date.now() - 600_000, nonce: 'parity-nonce-2', signature: await sign(`${Date.now() - 600_000}:parity-nonce-2:hi:${publicKeyHex}`) }),
    }), env)
    expect(stale.status).toBe(400)

    const tooLong = await worker.fetch(new Request('https://edge.test/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ ...base, introMessage: 'x'.repeat(101), nonce: 'parity-nonce-3', signature: '00'.repeat(64) }),
    }), env)
    expect(tooLong.status).toBe(400)

    const ts = Date.now()
    const sig = await sign(`${ts}:parity-nonce-4:hi:${publicKeyHex}`)
    const first = await worker.fetch(new Request('https://edge.test/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ ...base, timestamp: ts, nonce: 'parity-nonce-4', signature: sig }),
    }), env)
    expect(first.status).toBe(200)
    expect((await first.json() as any).status).toBe('pending')

    const replay = await worker.fetch(new Request('https://edge.test/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ ...base, timestamp: Date.now(), nonce: 'parity-nonce-4', signature: sig }),
    }), env)
    expect(replay.status).toBe(400)
  })

  it('gates invite minting on owner auth and validates invites on intake', async () => {
    const worker = await loadTemplate()
    const kv = createKv()
    const env: any = { MEMORY: kv, OWNER_ID: 'owner-1' }

    const anon = await worker.fetch(new Request('https://edge.test/api/friends/invite', { method: 'POST' }), env)
    expect(anon.status).toBe(403)

    const minted = await worker.fetch(new Request('https://edge.test/api/friends/invite', {
      method: 'POST',
      headers: { 'x-owner-id': 'owner-1' },
    }), env)
    expect(minted.status).toBe(200)
    const { invite } = (await minted.json()) as any
    expect(typeof invite).toBe('string')

    const { keyPair, publicKeyHex } = await generateEdKey()
    const ts = Date.now()
    const sig = uint8ArrayToHex(new Uint8Array(await crypto.subtle.sign(
      'Ed25519',
      keyPair.privateKey,
      new TextEncoder().encode(`${ts}:parity-nonce-5:hi:${publicKeyHex}`),
    )))
    const badInvite = await worker.fetch(new Request('https://edge.test/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({
        fromHandle: 'alex.workers.dev',
        fromPubkey: publicKeyHex,
        fromCharacterName: 'Kirie',
        introMessage: 'hi',
        timestamp: ts,
        nonce: 'parity-nonce-5',
        signature: sig,
        invite: 'cf_inv_bogus',
      }),
    }), env)
    expect(badInvite.status).toBe(400)
  })

  it('quarantines untrusted inbox senders and queues after accept', async () => {
    const worker = await loadTemplate()
    const { keyPair, publicKeyHex } = await generateEdKey()
    const kv = createKv()
    const env: any = { MEMORY: kv, OWNER_ID: 'owner-1' }
    const bodyText = JSON.stringify({ topic: 'airi/nap-chat/turn', payload: { text: 'hey' } })
    const headersFor = async (nonce: string) => {
      const ts = Date.now()
      const sig = uint8ArrayToHex(new Uint8Array(await crypto.subtle.sign(
        'Ed25519',
        keyPair.privateKey,
        new TextEncoder().encode(`${ts}:${nonce}:${bodyText}`),
      )))
      return {
        'x-sender-pubkey': publicKeyHex,
        'x-signature-ed25519': sig,
        'x-signature-timestamp': String(ts),
        'x-signature-nonce': nonce,
      }
    }

    const quarantined = await worker.fetch(new Request('https://edge.test/api/friends/inbox', {
      method: 'POST',
      headers: await headersFor('parity-inbox-1'),
      body: bodyText,
    }), env)
    expect(quarantined.status).toBe(403)

    const accept = await worker.fetch(new Request('https://edge.test/api/friends/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-owner-id': 'owner-1' },
      body: JSON.stringify({ pubkey: publicKeyHex, handle: 'alex.workers.dev' }),
    }), env)
    expect(accept.status).toBe(200)

    const queued = await worker.fetch(new Request('https://edge.test/api/friends/inbox', {
      method: 'POST',
      headers: await headersFor('parity-inbox-2'),
      body: bodyText,
    }), env)
    expect(queued.status).toBe(200)
    expect((await queued.json() as any).queued).toBe(true)
  })

  it('stores, trusts, and pushes through the embedded DO', async () => {
    const mod: any = await import(
      `data:text/javascript;charset=utf-8,${encodeURIComponent(CORS_PROXY_WORKER_SCRIPT)}`,
    )
    const tables: Record<string, any[]> = { friend_requests: [], trusted_peers: [], nap_turns: [] }
    const sent: string[] = []
    const fakeState = {
      storage: {
        sql: {
          exec: (query: string, ...bindings: unknown[]) => {
            const q = query.trim()
            if (q.startsWith('CREATE TABLE')) {
              return { toArray: () => [] }
            }
            if (q.startsWith('SELECT id FROM friend_requests WHERE nonce')) {
              return { toArray: () => tables.friend_requests.filter(r => r.nonce === bindings[0]) }
            }
            if (q.startsWith('INSERT INTO friend_requests')) {
              const [id, from_handle, from_pubkey, from_character_name, intro_message, timestamp, nonce, status, created_at] = bindings as any[]
              tables.friend_requests.push({ id, from_handle, from_pubkey, from_character_name, intro_message, timestamp, nonce, status, created_at })
              return { toArray: () => [] }
            }
            if (q.startsWith('SELECT pubkey FROM trusted_peers')) {
              return { toArray: () => tables.trusted_peers.filter(r => r.pubkey === bindings[0]) }
            }
            if (q.startsWith('INSERT OR REPLACE INTO trusted_peers')) {
              const [pubkey, handle, accepted_at] = bindings as any[]
              tables.trusted_peers = tables.trusted_peers.filter(r => r.pubkey !== pubkey)
              tables.trusted_peers.push({ pubkey, handle, accepted_at })
              return { toArray: () => [] }
            }
            if (q.startsWith('UPDATE friend_requests SET status')) {
              for (const r of tables.friend_requests) {
                if (r.from_pubkey === bindings[0] && r.status === 'pending')
                  r.status = 'trusted'
              }
              return { toArray: () => [] }
            }
            if (q.startsWith('INSERT OR IGNORE INTO nap_turns')) {
              const [id, sender_pubkey, topic, payload_json, timestamp] = bindings as any[]
              if (!tables.nap_turns.some(t => t.id === id))
                tables.nap_turns.push({ id, sender_pubkey, topic, payload_json, timestamp })
              return { toArray: () => [] }
            }
            if (q.startsWith('SELECT id, from_handle')) {
              return {
                toArray: () => tables.friend_requests
                  .filter(r => r.status === 'pending')
                  .map(r => ({ id: r.id, from_handle: r.from_handle, from_pubkey: r.from_pubkey, from_character_name: r.from_character_name, intro_message: r.intro_message, from_tagline: r.from_tagline, timestamp: r.timestamp, nonce: r.nonce })),
              }
            }
            throw new Error(`unhandled test query: ${q.slice(0, 60)}`)
          },
        },
      },
      acceptWebSocket: vi.fn(),
      blockConcurrencyWhile: async (cb: () => Promise<unknown>) => cb(),
      getWebSockets: () => [{ send: (t: string) => { sent.push(t) } }],
    }

    const EmbassyDO = mod.EmbassyDO
    expect(typeof EmbassyDO).toBe('function')
    const DO = new EmbassyDO(fakeState, { OWNER_ID: 'owner-1' })

    const storeReq = await DO.fetch(new Request('https://do/internal/friend-request', {
      method: 'POST',
      body: JSON.stringify({
        id: 'r1',
        fromHandle: 'alex.workers.dev',
        fromPubkey: 'ab'.repeat(32),
        fromCharacterName: 'Kirie',
        introMessage: 'hi',
        fromTagline: 'Quiet conversations',
        timestamp: 1,
        nonce: 'n1',
      }),
    }))
    expect(storeReq.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]).type).toBe('inbound_request')
    expect(JSON.parse(sent[0]).request.fromTagline).toBe('Quiet conversations')

    const denied = await DO.fetch(new Request('https://do/internal/inbox', {
      method: 'POST',
      body: JSON.stringify({ senderPubkey: 'ab'.repeat(32), topic: 't', payloadJson: '{}', timestamp: 1, nonce: 'n1' }),
    }))
    expect(denied.status).toBe(403)

    const accepted = await DO.fetch(new Request('https://do/internal/accept', {
      method: 'POST',
      body: JSON.stringify({ pubkey: 'ab'.repeat(32), handle: 'alex.workers.dev' }),
    }))
    expect((await accepted.json() as any).trusted).toBe(true)

    const queued = await DO.fetch(new Request('https://do/internal/inbox', {
      method: 'POST',
      body: JSON.stringify({ senderPubkey: 'ab'.repeat(32), topic: 't', payloadJson: '{"topic":"t"}', timestamp: 2, nonce: 'n2' }),
    }))
    expect(queued.status).toBe(200)
    expect((await queued.json() as any).queued).toBe(true)
    expect(sent.some(t => JSON.parse(t).type === 'nap_turn')).toBe(true)

    const pending = await DO.fetch(new Request('https://do/internal/pending'))
    expect(((await pending.json()) as any).requests).toEqual([])
  })
})
