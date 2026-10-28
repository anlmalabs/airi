import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getOrCreateDeviceKeypair,
  hexToUint8Array,
  normalizeAddress,
  uint8ArrayToHex,
  usePeerEmbassy,
} from './use-peer-embassy'

describe('usePeerEmbassy composable', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  describe('hex and Uint8Array helpers', () => {
    it('converts Uint8Array to hex and back', () => {
      const bytes = new Uint8Array([0, 15, 255, 128, 42])
      const hex = uint8ArrayToHex(bytes)
      expect(hex).toBe('000fff802a')
      const back = hexToUint8Array(hex)
      expect(back).toEqual(bytes)
    })

    it('handles empty or null hex', () => {
      expect(hexToUint8Array(null)).toEqual(new Uint8Array())
      expect(hexToUint8Array('')).toEqual(new Uint8Array())
    })
  })

  describe('normalizeAddress', () => {
    it('normalizes naked worker domain', () => {
      const res = normalizeAddress('mira.workers.dev')
      expect(res.workerUrl).toBe('https://mira.workers.dev')
      expect(res.handle).toBe('mira.workers.dev')
      expect(res.invite).toBeUndefined()
    })

    it('normalizes http/https worker URLs', () => {
      const res = normalizeAddress('https://alex.workers.dev')
      expect(res.workerUrl).toBe('https://alex.workers.dev')
      expect(res.handle).toBe('alex.workers.dev')
    })

    it('extracts invite token from URL with code query param', () => {
      const res = normalizeAddress('https://lain.workers.dev/api/friends/invite?code=cf_inv_888')
      expect(res.workerUrl).toBe('https://lain.workers.dev')
      expect(res.handle).toBe('lain.workers.dev')
      expect(res.invite).toBe('cf_inv_888')
    })

    it('parses airi://pair custom pairing protocol', () => {
      const res = normalizeAddress('airi://pair?worker=https://kirie.workers.dev&invite=cf_inv_999')
      expect(res.workerUrl).toBe('https://kirie.workers.dev')
      expect(res.handle).toBe('kirie.workers.dev')
      expect(res.invite).toBe('cf_inv_999')
    })
  })

  describe('getOrCreateDeviceKeypair', () => {
    it('generates a 64-hex character Ed25519 public key and persists it', async () => {
      const kp = await getOrCreateDeviceKeypair()
      expect(kp.publicKeyHex).toMatch(/^[0-9a-f]{64}$/i)
      expect(kp.privateKey).toBeDefined()

      // Subsequent call reuses keypair
      const kp2 = await getOrCreateDeviceKeypair()
      expect(kp2.publicKeyHex).toBe(kp.publicKeyHex)
    })
  })

  describe('fetchCompanionCard', () => {
    it('successfully fetches ambassador card metadata', async () => {
      const mockCard = {
        name: 'Mira',
        avatarUrl: 'https://example.com/mira.png',
        tagline: 'Quiet companion',
        publicKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockCard,
      })

      const { fetchCompanionCard } = usePeerEmbassy()
      const result = await fetchCompanionCard('mira.workers.dev')

      expect(result).not.toBeNull()
      expect(result!.card.name).toBe('Mira')
      expect(result!.card.tagline).toBe('Quiet companion')
      expect(result!.normalized.handle).toBe('mira.workers.dev')
    })

    it('handles network error and populates error ref', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'))

      const { fetchCompanionCard, error } = usePeerEmbassy()
      const result = await fetchCompanionCard('offline.workers.dev')

      expect(result).toBeNull()
      expect(error.value).toContain('Could not reach offline.workers.dev')
    })
  })

  describe('sendFriendRequest', () => {
    it('signs and dispatches friend request to worker', async () => {
      let dispatchedBody: any = null
      globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
        dispatchedBody = JSON.parse(options.body)
        return {
          ok: true,
          json: async () => ({ status: 'pending', id: 'req-123' }),
        }
      })

      const { sendFriendRequest } = usePeerEmbassy()
      const res = await sendFriendRequest('mira.workers.dev', {
        fromHandle: 'richy.workers.dev',
        fromCharacterName: 'AIRI',
        introMessage: 'Hello from AIRI!',
        inviteToken: 'inv-test-123',
      })

      expect(res.ok).toBe(true)
      expect(res.id).toBe('req-123')
      expect(dispatchedBody).not.toBeNull()
      expect(dispatchedBody.fromHandle).toBe('richy.workers.dev')
      expect(dispatchedBody.fromCharacterName).toBe('AIRI')
      expect(dispatchedBody.introMessage).toBe('Hello from AIRI!')
      expect(dispatchedBody.fromPubkey).toMatch(/^[0-9a-f]{64}$/i)
      expect(dispatchedBody.signature).toMatch(/^[0-9a-f]{128}$/i)
      expect(dispatchedBody.nonce).toBeDefined()
      expect(dispatchedBody.timestamp).toBeGreaterThan(0)
    })

    it('attaches the sender tagline when opted in, omits it otherwise', async () => {
      let dispatchedBody: any = null
      globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
        dispatchedBody = JSON.parse(options.body)
        return {
          ok: true,
          json: async () => ({ status: 'pending', id: 'req-124' }),
        }
      })

      const { sendFriendRequest } = usePeerEmbassy()
      const withTagline = await sendFriendRequest('mira.workers.dev', {
        fromHandle: 'richy.workers.dev',
        fromCharacterName: 'AIRI',
        senderTagline: '  Quiet <b>conversations</b>  ',
      })
      expect(withTagline.ok).toBe(true)
      // Sanitized, and outside the signature payload by design.
      expect(dispatchedBody.fromTagline).toBe('Quiet conversations')

      const withoutTagline = await sendFriendRequest('mira.workers.dev', {
        fromHandle: 'richy.workers.dev',
        fromCharacterName: 'AIRI',
      })
      expect(withoutTagline.ok).toBe(true)
      expect('fromTagline' in dispatchedBody).toBe(false)
    })

    it('returns error when endpoint rejects request', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'intro_too_long' }),
      })

      const { sendFriendRequest } = usePeerEmbassy()
      const res = await sendFriendRequest('mira.workers.dev', {
        fromHandle: 'richy.workers.dev',
        fromCharacterName: 'AIRI',
        introMessage: 'Too long message',
      })

      expect(res.ok).toBe(false)
      expect(res.error).toBe('intro_too_long')
    })
  })

  describe('mintInviteToken', () => {
    it('generates offline single-use invite URI if no worker provided', async () => {
      const { mintInviteToken } = usePeerEmbassy()
      const result = await mintInviteToken()

      expect(result.invite).toMatch(/^cf_inv_/)
      expect(result.uri).toContain('airi://pair?worker=')
      expect(result.uri).toContain(`invite=${result.invite}`)
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    })
  })
})
