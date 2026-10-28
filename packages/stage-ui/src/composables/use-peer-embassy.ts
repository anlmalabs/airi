import type { AmbassadorCard } from '@proj-airi/stage-shared'

import {
  buildRequestSignaturePayload,
  sanitizeIntroMessage,
  sanitizeTaglineMessage,
} from '@proj-airi/stage-shared'
import { ref } from 'vue'

export interface NormalizedAddress {
  raw: string
  workerUrl: string
  handle: string
  invite?: string
}

export interface DeviceKeypairState {
  publicKeyHex: string
  privateKey: CryptoKey
}

export function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function hexToUint8Array(hex?: string | null): Uint8Array {
  if (!hex)
    return new Uint8Array()
  const matches = hex.match(/.{1,2}/g)
  if (!matches)
    return new Uint8Array()
  return new Uint8Array(matches.map(byte => Number.parseInt(byte, 16)))
}

const STORAGE_KEY_KEYPAIR = 'local:peers/device-keypair'

let cachedKeypair: DeviceKeypairState | null = null

export async function getOrCreateDeviceKeypair(): Promise<DeviceKeypairState> {
  if (cachedKeypair)
    return cachedKeypair

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_KEYPAIR)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (parsed.publicKeyHex && parsed.privateKeyJwk) {
          const privateKey = await crypto.subtle.importKey(
            'jwk',
            parsed.privateKeyJwk,
            'Ed25519',
            false,
            ['sign'],
          )
          cachedKeypair = { publicKeyHex: parsed.publicKeyHex, privateKey }
          return cachedKeypair
        }
      }
    }
    catch (e) {
      console.warn('[usePeerEmbassy] Failed to parse stored keypair, regenerating:', e)
    }
  }

  // Generate new Web Crypto Ed25519 keypair
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey)
  const publicKeyHex = uint8ArrayToHex(new Uint8Array(rawPub))
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', kp.privateKey)

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      localStorage.setItem(STORAGE_KEY_KEYPAIR, JSON.stringify({
        publicKeyHex,
        privateKeyJwk,
        createdAt: Date.now(),
      }))
    }
    catch (e) {
      console.warn('[usePeerEmbassy] Failed to persist keypair:', e)
    }
  }

  cachedKeypair = { publicKeyHex, privateKey: kp.privateKey }
  return cachedKeypair
}

export function normalizeAddress(input: string): NormalizedAddress {
  const trimmed = (input || '').trim()
  if (!trimmed) {
    return { raw: '', workerUrl: '', handle: '' }
  }

  // Check if airi:// pairing link
  if (trimmed.startsWith('airi://pair')) {
    try {
      const parsedUrl = new URL(trimmed.replace('airi://pair', 'https://placeholder.internal'))
      const worker = parsedUrl.searchParams.get('worker') || ''
      const invite = parsedUrl.searchParams.get('invite') || undefined
      const cleanWorker = worker.replace(/\/+$/, '')
      const handle = cleanWorker.replace(/^https?:\/\//, '')
      return { raw: trimmed, workerUrl: cleanWorker.startsWith('http') ? cleanWorker : `https://${cleanWorker}`, handle, invite }
    }
    catch {
      // Fallback
    }
  }

  // Check if standard HTTP/HTTPS URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed)
      const invite = url.searchParams.get('invite') || url.searchParams.get('code') || undefined
      const workerUrl = `${url.protocol}//${url.host}`
      return { raw: trimmed, workerUrl, handle: url.host, invite }
    }
    catch {}
  }

  // Treat as naked hostname or hostname with path, e.g. "mira.workers.dev"
  const clean = trimmed.replace(/\/+$/, '')
  const handle = clean.split('/')[0]
  return {
    raw: trimmed,
    workerUrl: `https://${handle}`,
    handle,
  }
}

export function usePeerEmbassy() {
  const isLookingUp = ref(false)
  const isSending = ref(false)
  const error = ref<string | null>(null)

  async function fetchCompanionCard(addressOrUri: string): Promise<{ card: AmbassadorCard, normalized: NormalizedAddress } | null> {
    isLookingUp.value = true
    error.value = null
    try {
      const normalized = normalizeAddress(addressOrUri)
      if (!normalized.workerUrl) {
        error.value = 'Invalid companion address or URI.'
        return null
      }

      const urlsToTry: string[] = [normalized.workerUrl]
      const handleParts = normalized.handle.split('.')
      if (handleParts.length === 3 && handleParts[1] === 'workers' && handleParts[2] === 'dev') {
        urlsToTry.push(`https://airi-stage-edge.${normalized.handle}`)
        urlsToTry.push(`https://airi-cors-proxy.${normalized.handle}`)
      }

      let lastError: any = null
      for (const baseUrl of urlsToTry) {
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 6000)

          const res = await fetch(`${baseUrl}/api/companion/card`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          })
          clearTimeout(timeoutId)

          if (res.ok) {
            const data: AmbassadorCard = await res.json()
            return {
              card: data,
              normalized: {
                ...normalized,
                workerUrl: baseUrl,
                handle: new URL(baseUrl).host,
              },
            }
          }
          else {
            lastError = new Error(`Worker returned status ${res.status}`)
          }
        }
        catch (err: any) {
          lastError = err
        }
      }

      const message = lastError?.name === 'AbortError'
        ? 'Request timed out. Please check that the worker is online.'
        : `Could not reach ${normalized.handle}: ${lastError?.message || 'Network error'}`
      error.value = message
      return null
    }
    finally {
      isLookingUp.value = false
    }
  }

  async function sendFriendRequest(
    targetAddressOrUri: string,
    options: {
      fromHandle: string
      fromCharacterName: string
      introMessage?: string
      inviteToken?: string
      senderTagline?: string
    },
  ): Promise<{ ok: boolean, id?: string, error?: string }> {
    isSending.value = true
    error.value = null
    const normalized = normalizeAddress(targetAddressOrUri)
    if (!normalized.workerUrl) {
      isSending.value = false
      return { ok: false, error: 'Invalid destination address.' }
    }

    try {
      const keypair = await getOrCreateDeviceKeypair()
      const timestamp = Date.now()
      const nonce = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '')
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

      const intro = sanitizeIntroMessage(options.introMessage)
      const tagline = sanitizeTaglineMessage(options.senderTagline)
      const signaturePayload = buildRequestSignaturePayload(timestamp, nonce, intro, keypair.publicKeyHex)

      const encoder = new TextEncoder()
      const sigBuffer = await crypto.subtle.sign(
        'Ed25519',
        keypair.privateKey,
        encoder.encode(signaturePayload),
      )
      const signatureHex = uint8ArrayToHex(new Uint8Array(sigBuffer))

      const body: Record<string, unknown> = {
        fromHandle: options.fromHandle,
        fromPubkey: keypair.publicKeyHex,
        fromCharacterName: options.fromCharacterName,
        introMessage: intro,
        timestamp,
        nonce,
        signature: signatureHex,
        invite: options.inviteToken || normalized.invite,
      }
      // Self-asserted public blurb — rides outside the signature (see
      // buildRequestSignaturePayload). Omitted when blank to keep old workers happy.
      if (tagline)
        body.fromTagline = tagline

      const urlsToTry: string[] = [normalized.workerUrl]
      const handleParts = normalized.handle.split('.')
      if (handleParts.length === 3 && handleParts[1] === 'workers' && handleParts[2] === 'dev') {
        urlsToTry.push(`https://airi-stage-edge.${normalized.handle}`)
        urlsToTry.push(`https://airi-cors-proxy.${normalized.handle}`)
      }

      let lastError: any = null
      for (const baseUrl of urlsToTry) {
        try {
          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 8000)

          const res = await fetch(`${baseUrl}/api/friends/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          clearTimeout(timeoutId)

          const data = await res.json()
          if (!res.ok) {
            lastError = new Error(data?.error || `Request failed with HTTP ${res.status}`)
            continue
          }

          return { ok: true, id: data.id }
        }
        catch (err: any) {
          lastError = err
        }
      }

      const message = lastError?.name === 'AbortError' ? 'Friend request timed out.' : (lastError?.message || 'Network error')
      error.value = message
      return { ok: false, error: message }
    }
    finally {
      isSending.value = false
    }
  }

  async function acceptFriendRequest(
    myWorkerUrl: string,
    ownerId: string,
    payload: { pubkey: string, handle: string },
  ): Promise<{ ok: boolean, error?: string }> {
    try {
      const res = await fetch(`${myWorkerUrl}/api/friends/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-owner-id': ownerId,
        },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        return { ok: true }
      }
      const data = await res.json().catch(() => ({}))
      return { ok: false, error: data?.error || `HTTP ${res.status}` }
    }
    catch (e: any) {
      return { ok: false, error: e?.message || 'Network error' }
    }
  }

  async function mintInviteToken(options: { myWorkerUrl?: string, ownerId?: string } = {}): Promise<{ invite: string, uri: string, expiresAt: number, verified?: boolean }> {
    const { myWorkerUrl, ownerId } = options
    if (myWorkerUrl && ownerId) {
      try {
        const res = await fetch(`${myWorkerUrl}/api/friends/invite`, {
          method: 'POST',
          headers: {
            'x-owner-id': ownerId,
          },
        })
        if (res.ok) {
          const data = await res.json()
          if (data.invite && data.uri) {
            return { ...data, verified: true }
          }
        }
        else {
          const errData = await res.json().catch(() => ({}))
          throw new Error(errData?.error || `HTTP ${res.status}`)
        }
      }
      catch (e: any) {
        throw new Error(`Embassy invite mint failed: ${e?.message || e}`)
      }
    }

    const invite = `cf_inv_${Math.random().toString(36).slice(2, 10)}`
    const host = myWorkerUrl || 'https://my.workers.dev'
    const uri = `airi://pair?worker=${host}&invite=${invite}`
    return {
      invite,
      uri,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      verified: false,
    }
  }

  return {
    isLookingUp,
    isSending,
    error,
    fetchCompanionCard,
    sendFriendRequest,
    acceptFriendRequest,
    mintInviteToken,
    normalizeAddress,
    getOrCreateDeviceKeypair,
  }
}
