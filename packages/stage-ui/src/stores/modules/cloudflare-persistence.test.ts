import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePeersStore } from '../peers'
import { useCloudflareStore } from './cloudflare'
import { resolveAccountId } from './cloudflare-auth'

describe('cloudflare store persistence & corruption recovery', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('serializes token objects to valid JSON instead of [object Object]', async () => {
    const store = useCloudflareStore()

    store.cfOAuthTokens = {
      accessToken: 'test_access_token_123',
      refreshToken: 'test_refresh_token_456',
      expiresIn: 3600,
      accountId: 'test_account_id_789',
    }

    // Wait a tick for watcher / storage flush
    await new Promise(resolve => setTimeout(resolve, 50))

    const rawInStorage = localStorage.getItem('settings/cloudflare/cfOAuthTokens')
    expect(rawInStorage).not.toBeNull()
    expect(rawInStorage).not.toBe('[object Object]')
    expect(rawInStorage).toContain('test_access_token_123')

    const parsed = JSON.parse(rawInStorage || '{}')
    expect(parsed.accessToken).toBe('test_access_token_123')
    expect(parsed.refreshToken).toBe('test_refresh_token_456')
    expect(parsed.accountId).toBe('test_account_id_789')
  })

  it('recovers gracefully from legacy corrupted [object Object] in localStorage on boot', () => {
    // Seed corrupted state that previously occurred
    localStorage.setItem('settings/cloudflare/cfOAuthTokens', '[object Object]')
    localStorage.setItem('settings/discord/cfOAuthTokens', '[object Object]')
    localStorage.setItem('settings/cloudflare/cfAccountId', '[object Object]')
    localStorage.setItem('settings/cloudflare/cfApiToken', '[object Object]')

    // Creating the store should not throw and should clean up corrupted values
    const store = useCloudflareStore()

    expect(store.cfOAuthTokens).toBeNull()
    expect(store.cfAccountId).toBe('')
    expect(store.cfApiToken).toBe('')
    expect(store.isAuthenticated).toBe(false)
    expect(localStorage.getItem('settings/cloudflare/cfOAuthTokens')).toBeNull()
    expect(localStorage.getItem('settings/discord/cfOAuthTokens')).toBeNull()
  })

  it('persists authenticated state across simulated app restarts', async () => {
    // Session 1: User logs in
    const session1Store = useCloudflareStore()
    session1Store.cfOAuthTokens = {
      accessToken: 'persisted_token_abc',
      refreshToken: 'persisted_refresh_def',
      expiresIn: 3600,
      accountId: 'persisted_acc_123',
    }
    session1Store.cfAccountId = 'persisted_acc_123'
    expect(session1Store.isAuthenticated).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 50))

    // Session 2: App restarts (new pinia root, re-instantiate store)
    setActivePinia(createPinia())
    const session2Store = useCloudflareStore()

    expect(session2Store.cfOAuthTokens).not.toBeNull()
    expect(session2Store.cfOAuthTokens?.accessToken).toBe('persisted_token_abc')
    expect(session2Store.cfOAuthTokens?.refreshToken).toBe('persisted_refresh_def')
    expect(session2Store.cfAccountId).toBe('persisted_acc_123')
    expect(session2Store.isAuthenticated).toBe(true)
    expect(session2Store.activeAccessToken).toBe('persisted_token_abc')
    expect(session2Store.activeAccountId).toBe('persisted_acc_123')
  })

  it('correctly resolves account ID from accounts list when missing from token response', () => {
    // Token endpoint response does not include account_id
    const tokenDataWithoutAccountId = {
      account_id: undefined,
      access_token: 'valid_access_token',
      refresh_token: 'valid_refresh_token',
    }

    const accountsApiResponse = {
      result: [
        { id: 'resolved_cf_account_id_999', name: 'Primary Account' },
      ],
    }

    const resolved = resolveAccountId(tokenDataWithoutAccountId, accountsApiResponse)
    expect(resolved).toBe('resolved_cf_account_id_999')
  })

  it('syncVaultDevices merges remote devices from Edge Vault and writes back updated roster', async () => {
    const store = useCloudflareStore()
    store.cfApiToken = 'dummy_token'
    store.cfAccountId = 'dummy_acc'

    const remoteMap = {
      'remote-laptop': {
        machineId: 'remote-laptop',
        deviceName: 'MacBook Air',
        deviceType: 'desktop' as const,
        workerUrl: 'https://airi-stage-edge.r1ch4rd.workers.dev',
        lastSeen: Date.now() - 5000,
        presenceState: 'active' as const,
      },
    }

    const putCalls: Array<{ url: string, body: string }> = []

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const decodedUrl = decodeURIComponent(String(url))
      if (decodedUrl.includes('/storage/kv/namespaces') && !decodedUrl.includes('/values/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: init?.method === 'POST'
              ? { id: 'mock-edge-vault-ns', title: 'airi-edge-vault' }
              : [{ id: 'mock-edge-vault-ns', title: 'airi-edge-vault' }],
          }),
        } as any
      }

      if (decodedUrl.includes('/values/devices%2Fmap') && (!init?.method || init.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(remoteMap),
        } as any
      }

      if (decodedUrl.includes('/values/devices%2Fmap') && init?.method === 'PUT') {
        putCalls.push({ url: decodedUrl, body: String(init.body) })
        return {
          ok: true,
          status: 200,
          text: async () => '',
        } as any
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
        text: async () => '',
      } as any
    }))

    const res = await store.syncVaultDevices()
    expect(res.success).toBe(true)
    expect(putCalls.length).toBeGreaterThan(0)
    expect(putCalls[0].url).toContain('devices%2Fmap')

    const parsedSaved = JSON.parse(putCalls[0].body)
    expect(parsedSaved['remote-laptop']).toBeDefined()
    expect(parsedSaved['remote-laptop'].deviceName).toBe('MacBook Air')

    vi.unstubAllGlobals()
  })

  it('syncVaultDevices transparently refreshes expired OAuth token on 401 and retries', async () => {
    const store = useCloudflareStore()
    store.cfOAuthTokens = {
      accessToken: 'expired_access_token',
      refreshToken: 'valid_refresh_token_123',
      accountId: 'mock-account-id',
    }

    let refreshCalled = false
    const remoteMap = {
      'remote-laptop': {
        machineId: 'remote-laptop',
        deviceName: 'MacBook Air',
        relationship: 'same-account',
        discoveredAt: 1000,
        lastSeenTimestamp: 2000,
      },
    }

    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      const decodedUrl = decodeURIComponent(String(url))
      const authHeader = init?.headers?.Authorization

      // If called with expired token, return 401 Authentication error
      if (authHeader === 'Bearer expired_access_token') {
        return {
          ok: false,
          status: 401,
          json: async () => ({
            success: false,
            errors: [{ code: 10000, message: 'Authentication error' }],
          }),
          text: async () => JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: 'Authentication error' }],
          }),
        } as any
      }

      // OAuth token refresh endpoint
      if (init?.body && String(init.body).includes('grant_type=refresh_token')) {
        refreshCalled = true
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'freshly_minted_access_token',
            refresh_token: 'valid_refresh_token_123',
            expires_in: 3600,
          }),
        } as any
      }

      // Successful calls with refreshed token
      if (authHeader === 'Bearer freshly_minted_access_token') {
        if (decodedUrl.includes('/storage/kv/namespaces') && !decodedUrl.includes('/values/')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              result: [{ id: 'mock-edge-vault-ns', title: 'airi-edge-vault' }],
            }),
          } as any
        }

        if (decodedUrl.includes('/values/devices/map') || decodedUrl.includes('/values/devices%2Fmap')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(remoteMap),
            json: async () => ({ success: true }),
          } as any
        }
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
        text: async () => '',
      } as any
    }))

    const res = await store.syncVaultDevices()
    expect(res.success).toBe(true)
    expect(refreshCalled).toBe(true)
    expect(store.activeAccessToken).toBe('freshly_minted_access_token')

    vi.unstubAllGlobals()
  })

  it('syncVaultDevices write-gates and skips KV PUT when local device is already registered', async () => {
    const store = useCloudflareStore()
    const peersStore = usePeersStore()
    await peersStore.init()

    store.cfOAuthTokens = {
      accessToken: 'valid_access_token',
      refreshToken: 'valid_refresh_token',
      accountId: 'mock-account-id',
    }

    const currentId = peersStore.currentMachineId
    const localDevice = peersStore.roster.find(
      p => p.relationship === 'same-account' && (p as any).machineId === currentId,
    ) as any

    const remoteMap = {
      [currentId]: {
        machineId: currentId,
        deviceName: localDevice?.alias || currentId,
        deviceType: localDevice?.deviceType || 'desktop',
        workerUrl: undefined,
        lastSeen: Date.now() - 10000,
        presenceState: 'active' as const,
      },
    }

    const putCalls: string[] = []

    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      const decodedUrl = decodeURIComponent(String(url))
      if (decodedUrl.includes('/storage/kv/namespaces') && !decodedUrl.includes('/values/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ id: 'mock-edge-vault-ns', title: 'airi-edge-vault' }],
          }),
        } as any
      }

      if (decodedUrl.includes('/values/devices%2Fmap') && (!init?.method || init.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(remoteMap),
        } as any
      }

      if (decodedUrl.includes('/values/devices%2Fmap') && init?.method === 'PUT') {
        putCalls.push(decodedUrl)
        return { ok: true, status: 200, text: async () => '' } as any
      }

      return { ok: true, status: 200, json: async () => ({ success: true }) } as any
    }))

    // First call: device is already registered and configuration matches -> 0 PUT calls (no quota wasted)
    const res = await store.syncVaultDevices()
    expect(res.success).toBe(true)
    expect(putCalls.length).toBe(0)

    // Second call with forceWrite: true -> 1 PUT call
    const resForced = await store.syncVaultDevices({ forceWrite: true })
    expect(resForced.success).toBe(true)
    expect(putCalls.length).toBe(1)

    vi.unstubAllGlobals()
  })

  it('deployCorsProxy rejects when unauthenticated or when subdomain is missing', async () => {
    const store = useCloudflareStore()

    // 1. Unauthenticated
    await expect(store.deployCorsProxy()).rejects.toThrow('Not authenticated with Cloudflare')

    // 2. Authenticated but missing subdomain
    store.cfApiToken = 'dummy_token'
    store.cfAccountId = 'dummy_account'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, result: null }),
    } as any)))

    await expect(store.deployCorsProxy()).rejects.toThrow('Please register a workers.dev subdomain before deploying edge workers.')
    vi.unstubAllGlobals()
  })

  it('deployCorsProxy and deployCompanionEmbassy upload their respective workers and enable routes', async () => {
    const store = useCloudflareStore()
    store.cfApiToken = 'valid_token'
    store.cfAccountId = 'valid_account'
    store.cfSubdomain = 'alice'

    const uploadedScripts: string[] = []
    const enabledRoutes: string[] = []

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const decodedUrl = decodeURIComponent(String(url))

      // Script upload
      if (init?.method === 'PUT' && decodedUrl.includes('/workers/scripts/')) {
        const parts = decodedUrl.split('/workers/scripts/')
        const scriptName = parts[1].split(/[/?]/)[0]
        uploadedScripts.push(scriptName)
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        } as any
      }

      // Route enablement
      if (init?.method === 'POST' && decodedUrl.includes('/subdomain')) {
        const parts = decodedUrl.split('/workers/scripts/')
        const scriptName = parts[1].split('/')[0]
        enabledRoutes.push(scriptName)
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        } as any
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      } as any
    }))

    const result = await store.deployCorsProxy()
    expect(result).toBe(true)
    expect(uploadedScripts).toContain('airi-cors-proxy')
    expect(enabledRoutes).toContain('airi-cors-proxy')

    const embassyResult = await store.deployCompanionEmbassy()
    expect(embassyResult.success).toBe(true)
    expect(embassyResult.workerUrl).toContain('airi-stage-edge')
    expect(uploadedScripts).toContain('airi-stage-edge')
    expect(enabledRoutes).toContain('airi-stage-edge')

    vi.unstubAllGlobals()
  })

  it('setCloudflareSubdomain registers handle and enables script routes', async () => {
    const store = useCloudflareStore()
    store.cfApiToken = 'valid_token'
    store.cfAccountId = 'valid_account'

    const enabledRoutes: string[] = []

    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const decodedUrl = decodeURIComponent(String(url))

      if (init?.method === 'PUT' && decodedUrl.includes('/workers/subdomain')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { subdomain: 'bob' } }),
        } as any
      }

      if (init?.method === 'POST' && decodedUrl.includes('/subdomain')) {
        const parts = decodedUrl.split('/workers/scripts/')
        const scriptName = parts[1].split('/')[0]
        enabledRoutes.push(scriptName)
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        } as any
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      } as any
    }))

    const sub = await store.setCloudflareSubdomain('bob')
    expect(sub).toBe('bob')
    expect(store.cfSubdomain).toBe('bob')
    expect(enabledRoutes).toContain('airi-cors-proxy')
    expect(enabledRoutes).toContain('airi-stage-edge')

    vi.unstubAllGlobals()
  })
})
