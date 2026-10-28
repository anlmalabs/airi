import type { SameAccountDevice, VaultDeviceMap } from '@proj-airi/stage-shared'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import {
  cloudflareServiceDeployCorsProxy,
  cloudflareServiceFetchEdgeVault,
  cloudflareServiceRefreshOAuth,
  cloudflareServiceSaveEdgeVault,
  discordServiceCloudflareOAuth,
  discordServiceGetCloudflareSubdomain,
  discordServiceSetCloudflareSubdomain,
} from '@proj-airi/stage-shared'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { usePeersStore } from '../peers'
import { useSyncEngineStore } from '../sync-engine'
import {
  base64UrlEncode,
  buildCloudflareOAuthUrl,
  CLOUDFLARE_EDGE_VAULT_DEVICES_KEY,
  CLOUDFLARE_EDGE_VAULT_KEY,
  CLOUDFLARE_EDGE_VAULT_NAMESPACE,
  CLOUDFLARE_OAUTH_CLIENT_ID,
  CLOUDFLARE_TOKEN_ENDPOINT,
  deriveCodeChallenge,
  formatEdgeVaultPayload,
  getCorsProxiedEndpoints,
  isDeterministicCfErrorStatus,
  parseEdgeVaultPayload,
  parseOAuthCallbackInput,
  resolveAccountId,
  sanitizeWorkersSubdomain,
} from './cloudflare-auth'
import { CORS_PROXY_WORKER_SCRIPT } from './cors-proxy-worker-script'

export interface CloudflareOAuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn?: number
  accountId?: string
}

const TOKEN_ENDPOINT = CLOUDFLARE_TOKEN_ENDPOINT

function isCfAuthError(err: any): boolean {
  if (!err)
    return false
  const str = typeof err === 'string' ? err : (err?.message || JSON.stringify(err) || '')
  return str.includes('401') || str.includes('Authentication error') || str.includes('10000') || str.toLowerCase().includes('unauthorized')
}

async function generateWebPkce(): Promise<{ codeVerifier: string, codeChallenge: string }> {
  const randomBytes = new Uint8Array(32)
  window.crypto.getRandomValues(randomBytes)
  const codeVerifier = base64UrlEncode(randomBytes)
  const codeChallenge = await deriveCodeChallenge(codeVerifier, window.crypto.subtle)
  return { codeVerifier, codeChallenge }
}

export const useCloudflareStore = defineStore('cloudflare', () => {
  if (typeof localStorage !== 'undefined') {
    // 1. Primary key check and corruption cleanup
    const primaryRaw = localStorage.getItem('settings/cloudflare/cfOAuthTokens')
    if (primaryRaw && (primaryRaw === '[object Object]' || primaryRaw.startsWith('[object'))) {
      localStorage.removeItem('settings/cloudflare/cfOAuthTokens')
    }

    const primaryAccountId = localStorage.getItem('settings/cloudflare/cfAccountId')
    if (primaryAccountId && (primaryAccountId === '[object Object]' || primaryAccountId.startsWith('[object'))) {
      localStorage.removeItem('settings/cloudflare/cfAccountId')
    }

    const primaryApiToken = localStorage.getItem('settings/cloudflare/cfApiToken')
    if (primaryApiToken && (primaryApiToken === '[object Object]' || primaryApiToken.startsWith('[object'))) {
      localStorage.removeItem('settings/cloudflare/cfApiToken')
    }

    // 2. Legacy fallback migration
    const legacyRaw = localStorage.getItem('settings/discord/cfOAuthTokens')
    if (legacyRaw) {
      if (legacyRaw === '[object Object]' || legacyRaw.startsWith('[object')) {
        localStorage.removeItem('settings/discord/cfOAuthTokens')
      }
      else if (!localStorage.getItem('settings/cloudflare/cfOAuthTokens')) {
        try {
          const parsed = JSON.parse(legacyRaw)
          if (parsed && typeof parsed === 'object' && parsed.accessToken) {
            localStorage.setItem('settings/cloudflare/cfOAuthTokens', legacyRaw)
          }
        }
        catch {
          // ignore
        }
        localStorage.removeItem('settings/discord/cfOAuthTokens')
      }
      else {
        localStorage.removeItem('settings/discord/cfOAuthTokens')
      }
    }

    const legacyAccountId = localStorage.getItem('settings/discord/cfAccountId')
    if (legacyAccountId) {
      if (legacyAccountId === '[object Object]' || legacyAccountId.startsWith('[object')) {
        localStorage.removeItem('settings/discord/cfAccountId')
      }
      else if (!localStorage.getItem('settings/cloudflare/cfAccountId')) {
        localStorage.setItem('settings/cloudflare/cfAccountId', legacyAccountId)
      }
      localStorage.removeItem('settings/discord/cfAccountId')
    }

    const legacyApiToken = localStorage.getItem('settings/discord/cfApiToken')
    if (legacyApiToken) {
      if (legacyApiToken === '[object Object]' || legacyApiToken.startsWith('[object')) {
        localStorage.removeItem('settings/discord/cfApiToken')
      }
      else if (!localStorage.getItem('settings/cloudflare/cfApiToken')) {
        localStorage.setItem('settings/cloudflare/cfApiToken', legacyApiToken)
      }
      localStorage.removeItem('settings/discord/cfApiToken')
    }
  }

  const cfOAuthTokensSerializer = {
    read: (raw: string): CloudflareOAuthTokens | null => {
      if (!raw || raw === '[object Object]' || raw.startsWith('[object')) {
        return null
      }
      try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' && parsed.accessToken ? parsed : null
      }
      catch {
        return null
      }
    },
    write: (val: CloudflareOAuthTokens | null): string => {
      if (!val || typeof val !== 'object') {
        return ''
      }
      return JSON.stringify(val)
    },
  }

  const cfOAuthTokens = useLocalStorageManualReset<CloudflareOAuthTokens | null>(
    'settings/cloudflare/cfOAuthTokens',
    null,
    { serializer: cfOAuthTokensSerializer },
  )
  const cfAccountId = useLocalStorageManualReset<string>(
    'settings/cloudflare/cfAccountId',
    '',
  )
  const cfApiToken = useLocalStorageManualReset<string>(
    'settings/cloudflare/cfApiToken',
    '',
  )
  const cfSubdomain = useLocalStorageManualReset<string>(
    'settings/cloudflare/cfSubdomain',
    '',
  )

  const isAuthenticating = ref(false)
  const authError = ref<string | null>(null)

  const isAuthenticated = computed(() => Boolean(cfOAuthTokens.value?.accessToken || cfApiToken.value.trim()))
  const activeAccessToken = computed(() => cfOAuthTokens.value?.accessToken || cfApiToken.value.trim() || '')
  const activeAccountId = computed(() => cfAccountId.value || cfOAuthTokens.value?.accountId || '')

  const isHubOpen = ref(false)
  const isConnectOpen = ref(false)

  const isElectron = typeof window !== 'undefined' && !!(window as any).electron
  const invokeCloudflareOAuth = isElectron ? useElectronEventaInvoke(discordServiceCloudflareOAuth) : null
  const invokeGetSubdomain = isElectron ? useElectronEventaInvoke(discordServiceGetCloudflareSubdomain) : null
  const invokeSetSubdomain = isElectron ? useElectronEventaInvoke(discordServiceSetCloudflareSubdomain) : null
  const invokeSaveEdgeVault = isElectron ? useElectronEventaInvoke(cloudflareServiceSaveEdgeVault) : null
  const invokeFetchEdgeVault = isElectron ? useElectronEventaInvoke(cloudflareServiceFetchEdgeVault) : null
  const invokeDeployCorsProxy = isElectron ? useElectronEventaInvoke(cloudflareServiceDeployCorsProxy) : null
  const invokeRefreshOAuth = isElectron ? useElectronEventaInvoke(cloudflareServiceRefreshOAuth) : null

  function getCorsProxiedUrls(rawUrl: string): string[] {
    const isViteDev = Boolean(
      import.meta.env?.DEV
        && !isElectron
        && typeof window !== 'undefined'
        && !(window as any)?.Capacitor?.isNativePlatform?.()
        && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        && window.location.port,
    )

    return getCorsProxiedEndpoints(rawUrl, {
      isElectron,
      isViteDev,
      cfSubdomain: cfSubdomain.value,
    })
  }

  async function fetchWithCfProxy(rawUrl: string, init?: RequestInit): Promise<Response> {
    const urls = getCorsProxiedUrls(rawUrl)
    let lastError: any = null
    for (const u of urls) {
      try {
        const res = await fetch(u, init)
        if (res.ok) {
          return res
        }
        // NOTICE: deterministic 4xx errors must be returned, not fanned out.
        // A 401/412/etc. from one proxy is the Cloudflare API answering — the
        // same call through another proxy answers identically, and falling
        // through converts the real status/body into a generic 'Failed to
        // fetch' throw (which also starves the DO-migration retry below).
        if (isDeterministicCfErrorStatus(res.status)) {
          return res
        }
      }
      catch (e) {
        lastError = e
      }
    }
    throw lastError || new Error(`Failed to fetch ${rawUrl} via CORS proxy`)
  }

  async function autoRestoreEdgeVault(): Promise<{ success: boolean, bucket?: string, error?: string }> {
    const apiToken = activeAccessToken.value
    const accountId = activeAccountId.value
    if (!apiToken || !accountId) {
      return { success: false, error: 'Not authenticated with Cloudflare' }
    }

    try {
      const syncStore = useSyncEngineStore()
      const vault = await fetchFromEdgeVault()
      if (vault && vault.s3Endpoint && vault.s3Bucket) {
        syncStore.s3Endpoint = vault.s3Endpoint
        syncStore.s3Bucket = vault.s3Bucket
        syncStore.s3Region = vault.s3Region || 'auto'
        syncStore.s3AccessKeyId = vault.s3AccessKeyId || ''
        syncStore.s3SecretAccessKey = vault.s3SecretAccessKey || ''
        syncStore.activeProvider = 's3'
        syncStore.syncEnabled = true
        console.info('[useCloudflareStore] Auto-restored Edge Vault credentials into SyncEngineStore, bucket:', vault.s3Bucket)
        void syncVaultDevices().catch(() => {})
        return { success: true, bucket: vault.s3Bucket }
      }
      void syncVaultDevices().catch(() => {})
      return { success: false, error: 'No Edge Vault credentials found in Cloudflare KV' }
    }
    catch (err: any) {
      console.warn('[useCloudflareStore] Auto-restore Edge Vault failed:', err)
      return { success: false, error: err?.message || String(err) }
    }
  }

  async function exchangeAuthCode(code: string, customVerifier?: string) {
    if (!code)
      return null

    const effectiveVerifier = customVerifier
      || (typeof window !== 'undefined' ? (localStorage.getItem('cf_oauth_verifier') || sessionStorage.getItem('cf_oauth_verifier') || '') : '')

    const redirectUri = 'http://localhost:8976/oauth/callback'
    const isViteDev = Boolean(
      import.meta.env?.DEV
        && !isElectron
        && typeof window !== 'undefined'
        && !(window as any)?.Capacitor?.isNativePlatform?.()
        && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        && window.location.port,
    )

    const endpointsToTry: string[] = []

    if (isElectron) {
      endpointsToTry.push(TOKEN_ENDPOINT)
    }
    else if (isViteDev) {
      endpointsToTry.push('/api/cf-oauth-token')
      endpointsToTry.push(TOKEN_ENDPOINT)
    }
    else {
      // In native mobile or web production, use CORS proxy worker, then direct endpoint
      if (cfSubdomain.value) {
        endpointsToTry.push(`https://airi-cors-proxy.${cfSubdomain.value}.workers.dev/cors-proxy?url=${encodeURIComponent(TOKEN_ENDPOINT)}`)
      }
      endpointsToTry.push(`https://airi-cors-proxy.r1ch4rd.workers.dev/cors-proxy?url=${encodeURIComponent(TOKEN_ENDPOINT)}`)
      endpointsToTry.push(TOKEN_ENDPOINT)
    }

    let tokenData: any = null
    let lastError: any = null

    for (const endpoint of endpointsToTry) {
      try {
        const tokenRes = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLOUDFLARE_OAUTH_CLIENT_ID,
            code_verifier: effectiveVerifier,
            code,
            redirect_uri: redirectUri,
          }),
        })

        const contentType = tokenRes.headers.get('content-type') || ''
        if (contentType.includes('text/html')) {
          // HTML index.html fallback from SPA webview, try next endpoint
          continue
        }

        const rawText = await tokenRes.text()
        try {
          const parsed = JSON.parse(rawText)
          if (parsed.access_token) {
            tokenData = parsed
            break
          }
          else if (parsed.error_description || parsed.error) {
            throw new Error(parsed.error_description || parsed.error)
          }
        }
        catch (e: any) {
          if (e.message && !e.message.includes('JSON')) {
            throw e
          }
        }
      }
      catch (err: any) {
        lastError = err
      }
    }

    if (!tokenData?.access_token) {
      throw lastError || new Error('Failed to exchange OAuth token with Cloudflare.')
    }

    let accountId = resolveAccountId(tokenData)
    if (!accountId) {
      try {
        const accRes = await fetch(`${getCfApiBaseUrl()}/accounts`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        })
        if (accRes.ok) {
          const accData: any = await accRes.json()
          accountId = resolveAccountId(tokenData, accData)
        }
      }
      catch (e) {
        console.warn('[useCloudflareStore] Failed to auto-fetch account ID:', e)
      }
    }

    cfOAuthTokens.value = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
      accountId,
    }
    if (accountId) {
      cfAccountId.value = accountId
    }

    void getCloudflareSubdomain().catch(() => {})
    void autoRestoreEdgeVault().catch(() => {})
    return cfOAuthTokens.value
  }

  // Auto-detect OAuth code passed in URL hash / search params from mobile / web redirects
  if (typeof window !== 'undefined') {
    const parseUrlParams = () => {
      const searchParams = new URLSearchParams(window.location.search)
      const hashQuery = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : ''
      const hashParams = new URLSearchParams(hashQuery)

      return searchParams.get('cf_code') || hashParams.get('cf_code')
    }

    const pendingCode = parseUrlParams()
    if (pendingCode) {
      console.info('[useCloudflareStore] Found OAuth code in URL on initialization, completing token exchange...')
      if (window.history.replaceState) {
        const cleanHash = window.location.hash.split('?')[0] || '#/'
        window.history.replaceState(null, '', window.location.pathname + cleanHash)
      }
      void exchangeAuthCode(pendingCode).then(async () => {
        console.info('[useCloudflareStore] Successfully completed URL OAuth exchange!')
        await autoRestoreEdgeVault()

        const pendingFlow = localStorage.getItem('cf_oauth_pending_flow')
        const returnRoute = localStorage.getItem('cf_oauth_return_route')
        localStorage.removeItem('cf_oauth_pending_flow')
        localStorage.removeItem('cf_oauth_return_route')

        if (pendingFlow) {
          isHubOpen.value = true
          if (typeof window !== 'undefined') {
            const targetRoute = returnRoute && returnRoute !== '#' && returnRoute !== '#/' && returnRoute !== '/'
              ? returnRoute
              : '#/settings'
            const targetHash = targetRoute.startsWith('#')
              ? targetRoute
              : (targetRoute.startsWith('/') ? `#${targetRoute}` : `/#/${targetRoute}`)
            if (window.location.hash !== targetHash) {
              window.location.hash = targetHash
            }
          }
        }
      }).catch((err) => {
        console.warn('[useCloudflareStore] Automatic URL OAuth exchange failed:', err?.message || err)
      })
    }
  }

  async function authenticateWithCloudflare() {
    isAuthenticating.value = true
    authError.value = null

    try {
      if (isElectron && invokeCloudflareOAuth) {
        const res = await invokeCloudflareOAuth()
        if (res) {
          let resolvedAccountId = res.accountId
          if (!resolvedAccountId && res.accessToken) {
            try {
              const accRes = await fetch(`${getCfApiBaseUrl()}/accounts`, {
                headers: { Authorization: `Bearer ${res.accessToken}` },
              })
              if (accRes.ok) {
                const accData: any = await accRes.json()
                resolvedAccountId = resolveAccountId(undefined, accData)
              }
            }
            catch (e) {
              console.warn('[useCloudflareStore] Failed to auto-fetch account ID in Electron:', e)
            }
          }

          cfOAuthTokens.value = {
            accessToken: res.accessToken,
            refreshToken: res.refreshToken,
            expiresIn: res.expiresIn,
            accountId: resolvedAccountId,
          }
          if (resolvedAccountId) {
            cfAccountId.value = resolvedAccountId
          }
          void getCloudflareSubdomain().catch(() => {})
          void autoRestoreEdgeVault().catch(() => {})
        }
        return res
      }

      // Web Browser & Mobile PKCE Popup / Redirect Flow
      const { codeVerifier, codeChallenge } = await generateWebPkce()
      const randomState = base64UrlEncode(window.crypto.getRandomValues(new Uint8Array(16)))
      const redirectUri = 'http://localhost:8976/oauth/callback'

      const authUrl = buildCloudflareOAuthUrl({
        redirectUri,
        state: randomState,
        codeChallenge,
      })

      if (typeof window !== 'undefined') {
        sessionStorage.setItem('cf_oauth_verifier', codeVerifier)
        sessionStorage.setItem('cf_oauth_state', randomState)
        localStorage.setItem('cf_oauth_verifier', codeVerifier)
        localStorage.setItem('cf_oauth_state', randomState)
        localStorage.setItem('cf_oauth_return_route', window.location.hash || window.location.pathname || '')
        localStorage.setItem('cf_oauth_pending_flow', 'true')
      }

      // Open popup or navigate for web/mobile authorization
      const popup = window.open(authUrl.toString(), 'CloudflareAuth', 'width=600,height=750')
      if (!popup) {
        window.location.href = authUrl.toString()
        return
      }

      return new Promise((resolve, reject) => {
        let isResolved = false
        const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('airi_cf_oauth_channel') : null
        let checkInterval: ReturnType<typeof setInterval> | undefined
        let handleMessage: ((event: MessageEvent) => void) | undefined
        let handleStorage: ((event: StorageEvent) => void) | undefined

        const cleanup = () => {
          if (checkInterval)
            clearInterval(checkInterval)
          if (typeof window !== 'undefined') {
            if (handleMessage)
              window.removeEventListener('message', handleMessage)
            if (handleStorage)
              window.removeEventListener('storage', handleStorage)
          }
          if (channel) {
            channel.close()
          }
          try {
            popup?.close()
          }
          catch {}
        }

        checkInterval = setInterval(() => {
          if (popup?.closed) {
            cleanup()
            isAuthenticating.value = false
            resolve(cfOAuthTokens.value)
          }
        }, 800)

        const handleAuthCode = async (code: string) => {
          if (isResolved || !code)
            return
          isResolved = true
          cleanup()

          try {
            const tokens = await exchangeAuthCode(code, codeVerifier)
            isAuthenticating.value = false
            resolve(tokens)
          }
          catch (err: any) {
            authError.value = err?.message || String(err)
            isAuthenticating.value = false
            reject(err)
          }
        }

        handleMessage = (event: MessageEvent) => {
          if (event.data?.type === 'CLOUDFLARE_OAUTH_CODE' || event.data?.type === 'CLOUDFLARE_AUTH_CALLBACK') {
            handleAuthCode(event.data.code)
          }
        }

        handleStorage = (event: StorageEvent) => {
          if (event.key === 'airi_cf_oauth_callback' && event.newValue) {
            try {
              const parsed = JSON.parse(event.newValue)
              if (parsed.code) {
                handleAuthCode(parsed.code)
              }
            }
            catch {}
          }
        }

        if (typeof window !== 'undefined') {
          window.addEventListener('message', handleMessage)
          window.addEventListener('storage', handleStorage)
        }
        if (channel) {
          channel.onmessage = (event) => {
            if (event.data?.code) {
              handleAuthCode(event.data.code)
            }
          }
        }
      })
    }
    catch (err: any) {
      authError.value = err?.message || String(err)
      throw err
    }
    finally {
      isAuthenticating.value = false
    }
  }

  function getCfApiBaseUrl(): string {
    const isViteDev = Boolean(
      import.meta.env?.DEV
        && !isElectron
        && typeof window !== 'undefined'
        && !(window as any)?.Capacitor?.isNativePlatform?.()
        && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        && window.location.port,
    )

    if (isViteDev) {
      return '/api/cloudflare'
    }
    return 'https://api.cloudflare.com/client/v4'
  }

  async function getCloudflareSubdomain(): Promise<string | null> {
    const apiToken = activeAccessToken.value
    const accountId = activeAccountId.value
    if (!apiToken)
      return cfSubdomain.value || null

    if (isElectron && invokeGetSubdomain) {
      try {
        const res = await invokeGetSubdomain({ apiToken, accountId })
        if (res.success && res.subdomain) {
          cfSubdomain.value = res.subdomain
          return res.subdomain
        }
      }
      catch {}
    }

    // Non-Electron (Web & Mobile) REST API fetch
    if (accountId) {
      try {
        const res = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        })
        if (res.ok) {
          const data: any = await res.json()
          if (data.result?.subdomain) {
            cfSubdomain.value = data.result.subdomain
            return data.result.subdomain
          }
        }
      }
      catch (e) {
        console.warn('[useCloudflareStore] Failed to fetch subdomain via REST API:', e)
      }
    }

    return cfSubdomain.value || null
  }

  async function setCloudflareSubdomain(subdomain: string): Promise<string> {
    const apiToken = activeAccessToken.value
    const accountId = activeAccountId.value
    if (!apiToken)
      throw new Error('Cloudflare access token missing.')

    const cleanSubdomain = sanitizeWorkersSubdomain(subdomain)

    if (isElectron && invokeSetSubdomain) {
      const res = await invokeSetSubdomain({ apiToken, accountId, subdomain: cleanSubdomain })
      if (!res.success || !res.subdomain) {
        throw new Error(res.error || 'Subdomain registration failed.')
      }
      cfSubdomain.value = res.subdomain
      return res.subdomain
    }

    // Non-Electron (Web & Mobile) REST API PUT
    const res = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subdomain: cleanSubdomain }),
    })
    if (!res.ok) {
      const errData: any = await res.json().catch(() => ({}))
      throw new Error(errData.errors?.[0]?.message || 'Failed to claim workers.dev subdomain.')
    }
    cfSubdomain.value = cleanSubdomain

    // Auto-enable workers.dev routes for our scripts if they already exist
    for (const name of ['airi-cors-proxy', 'airi-stage-edge']) {
      await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: true }),
      }).catch(() => null)
    }

    return cleanSubdomain
  }

  async function deployCorsProxy(options?: { scriptName?: string }): Promise<boolean> {
    const apiToken = activeAccessToken.value
    const accountId = activeAccountId.value
    if (!apiToken || !accountId)
      throw new Error('Not authenticated with Cloudflare')

    let subdomain: string | null = cfSubdomain.value || null
    if (!subdomain) {
      subdomain = await getCloudflareSubdomain().catch(() => null)
    }
    if (!subdomain) {
      throw new Error('Please register a workers.dev subdomain before deploying edge workers.')
    }

    const scriptName = options?.scriptName || 'airi-cors-proxy'

    if (isElectron && invokeDeployCorsProxy) {
      try {
        const res = await invokeDeployCorsProxy({ apiToken, accountId, targetSubdomain: subdomain, scriptName })
        if (!res.success)
          throw new Error(res.error || 'CORS proxy deployment failed.')
        return true
      }
      catch (e: any) {
        console.warn('[useCloudflareStore] Failed to deploy CORS proxy via Electron:', e)
        throw e instanceof Error ? e : new Error(String(e))
      }
    }

    const metadata = {
      main_module: 'index.js',
      compatibility_date: '2025-02-04',
      compatibility_flags: ['nodejs_compat'],
      bindings: [],
    }
    const formData = new FormData()
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json')
    formData.append('index.js', new Blob([CORS_PROXY_WORKER_SCRIPT], { type: 'application/javascript+module' }), 'index.js')

    const uploadRes = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: formData,
    })
    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => '')
      throw new Error(`Worker "${scriptName}" upload failed (HTTP ${uploadRes.status}): ${parseCfApiError(errText)}`)
    }
    const uploadData: any = await uploadRes.json().catch(() => null)
    if (uploadData && uploadData.success === false) {
      throw new Error(`Worker "${scriptName}" upload rejected: ${parseCfApiError(JSON.stringify(uploadData))}`)
    }

    // Enable the workers.dev route for the script
    await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => null)

    return true
  }

  async function deployCompanionEmbassy(options: { enableEmbassyDO?: boolean, characterName?: string, tagline?: string } = { enableEmbassyDO: true }): Promise<{ success: boolean, workerUrl: string }> {
    const apiToken = activeAccessToken.value
    const accountId = activeAccountId.value
    if (!apiToken || !accountId)
      throw new Error('Not authenticated with Cloudflare')

    let subdomain: string | null = cfSubdomain.value || null
    if (!subdomain) {
      subdomain = await getCloudflareSubdomain().catch(() => null)
    }
    if (!subdomain) {
      throw new Error('Please register a workers.dev subdomain before deploying companion embassy.')
    }

    const scriptName = 'airi-stage-edge'
    const workerUrl = `https://${scriptName}.${subdomain}.workers.dev`
    const enableDO = options.enableEmbassyDO ?? true
    const characterName = options.characterName || 'AIRI'
    const tagline = options.tagline || ''

    if (isElectron && invokeDeployCorsProxy) {
      try {
        const res = await invokeDeployCorsProxy({
          apiToken,
          accountId,
          targetSubdomain: subdomain,
          scriptName,
          ownerId: accountId,
          characterName,
          tagline,
          enableEmbassyDO: enableDO,
        })
        if (!res.success)
          throw new Error(res.error || 'Companion embassy deployment failed.')
        return { success: true, workerUrl }
      }
      catch (e: any) {
        console.warn('[useCloudflareStore] Failed to deploy companion embassy via Electron:', e)
        throw e instanceof Error ? e : new Error(String(e))
      }
    }

    // Web / mobile REST upload for airi-stage-edge
    // 1. Resolve or create KV namespace for airi-stage-edge MEMORY
    let memoryNsId = ''
    try {
      const kvListRes = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      })
      if (kvListRes.ok) {
        const kvListData: any = await kvListRes.json()
        const existing = kvListData.result?.find((n: any) => n.title === 'airi-kv-airi-stage-edge')
        if (existing?.id)
          memoryNsId = existing.id
      }
      if (!memoryNsId) {
        const createRes = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'airi-kv-airi-stage-edge' }),
        })
        if (createRes.ok) {
          const createData: any = await createRes.json()
          memoryNsId = createData.result?.id
        }
      }
    }
    catch (e) {
      console.warn('[useCloudflareStore] KV namespace resolution warning:', e)
    }

    const bindings: any[] = []
    if (memoryNsId) {
      bindings.push({ type: 'kv_namespace', name: 'MEMORY', namespace_id: memoryNsId })
    }
    bindings.push({ type: 'plain_text', name: 'OWNER_ID', text: accountId })
    bindings.push({ type: 'plain_text', name: 'CHARACTER_NAME', text: characterName })
    bindings.push({ type: 'plain_text', name: 'COMPANION_TAGLINE', text: tagline })

    if (enableDO) {
      bindings.push({
        type: 'durable_object_namespace',
        name: 'EMBASSY',
        class_name: 'EmbassyDO',
      })
    }

    const metadata: Record<string, unknown> = {
      main_module: 'index.js',
      compatibility_date: '2025-02-04',
      compatibility_flags: ['nodejs_compat'],
      bindings,
    }

    if (enableDO) {
      metadata.migrations = {
        new_tag: 'v1',
        steps: [
          {
            new_sqlite_classes: ['EmbassyDO'],
          },
        ],
      }
    }

    const formData = new FormData()
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata')
    formData.append('index.js', new Blob([CORS_PROXY_WORKER_SCRIPT], { type: 'application/javascript+module' }), 'index.js')

    let uploadRes = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: formData,
    })
    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => '')
      // A 412 here is almost always the DO migration tag already being
      // applied (e.g. redeploying the same EmbassyDO tag). Retry without
      // migrations regardless of the exact wording — the stripped upload is
      // a no-op if migrations were never the problem.
      if (uploadRes.status === 412 || (metadata.migrations && (errText.includes('migration') || errText.includes('tag') || errText.includes('already')))) {
        delete metadata.migrations
        const retryFormData = new FormData()
        retryFormData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata')
        retryFormData.append('index.js', new Blob([CORS_PROXY_WORKER_SCRIPT], { type: 'application/javascript+module' }), 'index.js')
        uploadRes = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${apiToken}` },
          body: retryFormData,
        })
      }
      if (!uploadRes.ok) {
        const finalErr = await uploadRes.text().catch(() => errText)
        throw new Error(`Embassy worker upload failed (HTTP ${uploadRes.status}): ${parseCfApiError(finalErr)}`)
      }
    }
    const uploadData: any = await uploadRes.json().catch(() => null)
    if (uploadData && uploadData.success === false) {
      throw new Error(`Embassy worker upload rejected: ${parseCfApiError(JSON.stringify(uploadData))}`)
    }

    // Enable workers.dev subdomain route for airi-stage-edge
    await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => null)

    return { success: true, workerUrl }
  }

  function parseCfApiError(raw: string): string {
    if (!raw)
      return 'Unknown error'
    try {
      const parsed = JSON.parse(raw)
      const first = parsed?.errors?.[0]
      if (first?.message)
        return `${first.message}${first.code ? ` (code ${first.code})` : ''}`
    }
    catch {}
    return raw.slice(0, 300)
  }

  const VAULT_NS_CACHE_PREFIX = 'airi:cf:vault_ns:'

  function getCachedVaultNsId(accountId: string): string {
    if (typeof window === 'undefined' || !window.localStorage)
      return ''
    try {
      return localStorage.getItem(`${VAULT_NS_CACHE_PREFIX}${accountId}`) || ''
    }
    catch {
      return ''
    }
  }

  function setCachedVaultNsId(accountId: string, nsId: string): void {
    if (typeof window === 'undefined' || !window.localStorage)
      return
    try {
      if (nsId)
        localStorage.setItem(`${VAULT_NS_CACHE_PREFIX}${accountId}`, nsId)
      else
        localStorage.removeItem(`${VAULT_NS_CACHE_PREFIX}${accountId}`)
    }
    catch {}
  }

  async function saveToEdgeVault(vaultData: Record<string, any>, key: string = CLOUDFLARE_EDGE_VAULT_KEY, tokenOverride?: string) {
    const apiToken = tokenOverride || activeAccessToken.value
    const accountId = activeAccountId.value
    if (!apiToken || !accountId)
      throw new Error('Cloudflare access token missing.')

    const doSave = async (token: string) => {
      if (isElectron && invokeSaveEdgeVault) {
        const res = await invokeSaveEdgeVault({ apiToken: token, accountId, vaultData, key })
        if (!res.success) {
          throw new Error(res.error || 'Failed to save to Edge Key Vault.')
        }
        return res
      }

      // Non-Electron (Web & Mobile) REST API with CORS proxy
      let nsId = getCachedVaultNsId(accountId)
      if (!nsId) {
        const listRes = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (listRes.status === 401) {
          const errText = await listRes.text().catch(() => '')
          throw new Error(`401 ${errText || 'Authentication error'}`)
        }
        if (listRes.ok) {
          const listData: any = await listRes.json()
          const existing = listData.result?.find((n: any) => n.title === CLOUDFLARE_EDGE_VAULT_NAMESPACE)
          if (existing?.id) {
            nsId = existing.id
            setCachedVaultNsId(accountId, nsId)
          }
        }
        if (!nsId) {
          const createRes = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ title: CLOUDFLARE_EDGE_VAULT_NAMESPACE }),
          })
          if (createRes.status === 401) {
            const errText = await createRes.text().catch(() => '')
            throw new Error(`401 ${errText || 'Authentication error'}`)
          }
          if (createRes.ok) {
            const createData: any = await createRes.json()
            nsId = createData.result?.id
            if (nsId) {
              setCachedVaultNsId(accountId, nsId)
            }
          }
        }
      }
      if (!nsId) {
        throw new Error('Failed to resolve or create KV namespace for Edge Vault')
      }

      const payloadBody = key === CLOUDFLARE_EDGE_VAULT_KEY
        ? formatEdgeVaultPayload(vaultData)
        : (typeof vaultData === 'string' ? vaultData : JSON.stringify(vaultData))

      const putRes = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        body: payloadBody,
      })
      if (putRes.status === 401) {
        const errText = await putRes.text().catch(() => '')
        throw new Error(`401 ${errText || 'Authentication error'}`)
      }
      if (!putRes.ok) {
        const errText = await putRes.text().catch(() => '')
        throw new Error(`Failed to write to KV: ${putRes.status} ${errText}`)
      }
      return { success: true }
    }

    try {
      return await doSave(apiToken)
    }
    catch (err: any) {
      if (isCfAuthError(err) && cfOAuthTokens.value?.refreshToken) {
        console.info('[useCloudflareStore] 401 encountered in saveToEdgeVault, attempting token refresh...')
        const refreshed = await refreshOAuthTokens()
        if (refreshed?.accessToken) {
          return await doSave(refreshed.accessToken)
        }
      }
      throw err
    }
  }

  async function fetchFromEdgeVault(key: string = CLOUDFLARE_EDGE_VAULT_KEY, tokenOverride?: string): Promise<Record<string, any> | null> {
    const apiToken = tokenOverride || activeAccessToken.value
    const accountId = activeAccountId.value
    if (!apiToken || !accountId)
      return null

    const doFetch = async (token: string): Promise<Record<string, any> | null> => {
      if (isElectron && invokeFetchEdgeVault) {
        const res = await invokeFetchEdgeVault({ apiToken: token, accountId, key })
        if (!res.success && isCfAuthError(res.error)) {
          throw new Error(res.error || 'Authentication error')
        }
        return res.success && res.vaultData ? res.vaultData : null
      }

      // Non-Electron (Web & Mobile) REST fetch with CORS proxy
      let nsId = getCachedVaultNsId(accountId)
      if (!nsId) {
        const listRes = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (listRes.status === 401) {
          const errText = await listRes.text().catch(() => '')
          throw new Error(`401 ${errText || 'Authentication error'}`)
        }
        if (listRes.ok) {
          const listData: any = await listRes.json()
          const vaultNs = listData.result?.find((n: any) => n.title === CLOUDFLARE_EDGE_VAULT_NAMESPACE)
          if (vaultNs?.id) {
            nsId = vaultNs.id
            setCachedVaultNsId(accountId, nsId)
          }
        }
      }

      if (nsId) {
        const valRes = await fetchWithCfProxy(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (valRes.status === 401) {
          const errText = await valRes.text().catch(() => '')
          throw new Error(`401 ${errText || 'Authentication error'}`)
        }
        if (valRes.status === 404) {
          return null
        }
        if (valRes.ok) {
          const raw = await valRes.text()
          if (key === CLOUDFLARE_EDGE_VAULT_KEY) {
            return parseEdgeVaultPayload(raw)
          }
          try {
            return JSON.parse(raw)
          }
          catch {
            return parseEdgeVaultPayload(raw)
          }
        }
      }
      return null
    }

    try {
      return await doFetch(apiToken)
    }
    catch (err: any) {
      if (isCfAuthError(err) && cfOAuthTokens.value?.refreshToken) {
        console.info('[useCloudflareStore] 401 encountered in fetchFromEdgeVault, attempting token refresh...')
        try {
          const refreshed = await refreshOAuthTokens()
          if (refreshed?.accessToken) {
            return await doFetch(refreshed.accessToken)
          }
        }
        catch (e) {
          console.warn('[useCloudflareStore] Refresh during fetchFromEdgeVault failed:', e)
        }
      }
      return null
    }
  }

  async function syncVaultDevices(options?: { forceWrite?: boolean }): Promise<{ success: boolean, count?: number, error?: string }> {
    const apiToken = activeAccessToken.value
    const accountId = activeAccountId.value
    if (!apiToken || !accountId) {
      return { success: false, error: 'Not authenticated with Cloudflare' }
    }

    const runSync = async (token: string) => {
      const peersStore = usePeersStore()
      if (!peersStore.isInitialized) {
        await peersStore.init()
      }

      // 1. Fetch remote devices map from KV (Read-only: 100,000 free operations/day)
      const remoteMap = await fetchFromEdgeVault(CLOUDFLARE_EDGE_VAULT_DEVICES_KEY, token) as VaultDeviceMap | null

      // 2. Merge remote devices into local peers store
      if (remoteMap && typeof remoteMap === 'object') {
        await peersStore.mergeVaultDevices(remoteMap)
      }

      // 3. Inspect local device registration status
      const currentId = peersStore.currentMachineId
      const localDevice = peersStore.roster.find(
        p => p.relationship === 'same-account' && (p as SameAccountDevice).machineId === currentId,
      ) as SameAccountDevice | undefined

      const expectedWorkerUrl = cfSubdomain.value ? `https://${cfSubdomain.value}.workers.dev` : undefined
      const remoteEntry = remoteMap ? remoteMap[currentId] : null

      // Write-gating: only write if device is missing from remote vault, or configuration actually changed, or forced
      const isMissing = !remoteEntry
      const aliasChanged = Boolean(remoteEntry && localDevice && remoteEntry.deviceName !== localDevice.alias)
      const workerUrlChanged = Boolean(remoteEntry && expectedWorkerUrl && remoteEntry.workerUrl !== expectedWorkerUrl)
      const shouldWrite = Boolean(options?.forceWrite || isMissing || aliasChanged || workerUrlChanged)

      if (localDevice) {
        localDevice.edgeVaultSyncedAt = Date.now()
        if (expectedWorkerUrl) {
          localDevice.endpoints = {
            ...localDevice.endpoints,
            cloudflareWorkerUrl: expectedWorkerUrl,
          }
        }
        if (shouldWrite) {
          localDevice.lastSeenTimestamp = Date.now()
        }
      }

      // 4. Export fresh local + merged map and push back to KV ONLY when necessary
      if (shouldWrite) {
        const updatedMap = peersStore.toVaultDeviceMapForSync()
        await saveToEdgeVault(updatedMap, CLOUDFLARE_EDGE_VAULT_DEVICES_KEY, token)
      }

      const deviceCount = peersStore.devices.length
      console.info(`[useCloudflareStore] Synchronized ${deviceCount} device(s) with Edge Vault (wrote: ${shouldWrite}).`)
      return { success: true, count: deviceCount }
    }

    try {
      return await runSync(apiToken)
    }
    catch (err: any) {
      if (isCfAuthError(err) && cfOAuthTokens.value?.refreshToken) {
        console.info('[useCloudflareStore] 401 encountered in syncVaultDevices, attempting transparent token refresh...')
        try {
          const refreshed = await refreshOAuthTokens()
          if (refreshed?.accessToken) {
            console.info('[useCloudflareStore] Token refreshed, retrying syncVaultDevices...')
            return await runSync(refreshed.accessToken)
          }
        }
        catch (refreshErr) {
          console.warn('[useCloudflareStore] Transparent refresh failed during syncVaultDevices:', refreshErr)
        }
      }

      console.warn('[useCloudflareStore] syncVaultDevices failed:', err)
      const userFacingError = isCfAuthError(err)
        ? 'Cloudflare session expired. Please re-authenticate in Settings.'
        : (err?.message || String(err))
      return { success: false, error: userFacingError }
    }
  }

  async function verifyAndSetApiToken(token: string): Promise<string> {
    const cleanToken = token.trim()
    if (!cleanToken) {
      throw new Error('API Token is required')
    }

    const apiBase = getCfApiBaseUrl()
    let verified = false
    let accountId = ''

    // 1. Try /user/tokens/verify
    try {
      const verifyRes = await fetch(`${apiBase}/user/tokens/verify`, {
        headers: { Authorization: `Bearer ${cleanToken}` },
      })
      if (verifyRes.ok) {
        const verifyData: any = await verifyRes.json()
        if (verifyData.result?.status === 'active' || verifyData.success) {
          verified = true
        }
      }
    }
    catch (e) {
      console.warn('[useCloudflareStore] Direct /user/tokens/verify check:', e)
    }

    // 2. Fetch accounts list to confirm validity and find accountId
    try {
      const accRes = await fetch(`${apiBase}/accounts`, {
        headers: { Authorization: `Bearer ${cleanToken}` },
      })
      if (accRes.ok) {
        const accData: any = await accRes.json()
        if (accData.success && accData.result?.length > 0) {
          verified = true
          accountId = accData.result[0]?.id || ''
        }
      }
      else if (!verified) {
        const errData: any = await accRes.json().catch(() => ({}))
        throw new Error(errData.errors?.[0]?.message || 'Invalid Cloudflare API token or unauthorized.')
      }
    }
    catch (e: any) {
      if (!verified) {
        throw new Error(e?.message || 'Failed to verify Cloudflare API token. Check network or token permissions.')
      }
    }

    if (!verified) {
      throw new Error('Cloudflare API token verification failed. Please ensure the token is active.')
    }

    cfApiToken.value = cleanToken
    cfOAuthTokens.value = null
    if (accountId) {
      cfAccountId.value = accountId
    }

    void getCloudflareSubdomain().catch(() => {})
    void autoRestoreEdgeVault().catch(() => {})
    return cleanToken
  }

  async function handleManualCallbackInput(input: string, customVerifier?: string): Promise<CloudflareOAuthTokens | null> {
    const code = parseOAuthCallbackInput(input)
    const tokens = await exchangeAuthCode(code, customVerifier)
    isAuthenticating.value = false
    return tokens
  }

  let inFlightRefreshPromise: Promise<CloudflareOAuthTokens | null> | null = null

  async function refreshOAuthTokens(): Promise<CloudflareOAuthTokens | null> {
    if (inFlightRefreshPromise) {
      return inFlightRefreshPromise
    }
    inFlightRefreshPromise = doRefreshOAuthTokens().finally(() => {
      inFlightRefreshPromise = null
    })
    return inFlightRefreshPromise
  }

  async function doRefreshOAuthTokens(): Promise<CloudflareOAuthTokens | null> {
    if (!cfOAuthTokens.value?.refreshToken) {
      return null
    }

    if (isElectron && invokeRefreshOAuth) {
      try {
        const res = await invokeRefreshOAuth({ refreshToken: cfOAuthTokens.value.refreshToken })
        if (res.success && res.tokens?.accessToken) {
          cfOAuthTokens.value = {
            accessToken: res.tokens.accessToken,
            refreshToken: res.tokens.refreshToken || cfOAuthTokens.value.refreshToken,
            expiresIn: res.tokens.expiresIn,
            accountId: res.tokens.accountId || cfOAuthTokens.value.accountId,
          }
          return cfOAuthTokens.value
        }
      }
      catch (e) {
        console.warn('[useCloudflareStore] invokeRefreshOAuth failed in Electron:', e)
      }
    }

    const isViteDev = Boolean(
      import.meta.env?.DEV
        && !isElectron
        && typeof window !== 'undefined'
        && !(window as any)?.Capacitor?.isNativePlatform?.()
        && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        && window.location.port,
    )

    const endpointsToTry: string[] = []
    if (isElectron) {
      endpointsToTry.push(TOKEN_ENDPOINT)
    }
    else if (isViteDev) {
      endpointsToTry.push('/api/cf-oauth-token')
      endpointsToTry.push(TOKEN_ENDPOINT)
    }
    else {
      if (cfSubdomain.value) {
        endpointsToTry.push(`https://airi-cors-proxy.${cfSubdomain.value}.workers.dev/cors-proxy?url=${encodeURIComponent(TOKEN_ENDPOINT)}`)
      }
      endpointsToTry.push(`https://airi-cors-proxy.r1ch4rd.workers.dev/cors-proxy?url=${encodeURIComponent(TOKEN_ENDPOINT)}`)
      endpointsToTry.push(TOKEN_ENDPOINT)
    }

    for (const endpoint of endpointsToTry) {
      try {
        const fetchRes: Response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CLOUDFLARE_OAUTH_CLIENT_ID,
            refresh_token: cfOAuthTokens.value.refreshToken,
          }).toString(),
        })

        if (!fetchRes.ok) {
          continue
        }

        const data: any = await fetchRes.json()
        if (data.access_token) {
          cfOAuthTokens.value = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || cfOAuthTokens.value.refreshToken,
            expiresIn: data.expires_in,
            accountId: cfOAuthTokens.value.accountId,
          }
          return cfOAuthTokens.value
        }
      }
      catch (err) {
        console.warn('[useCloudflareStore] Error refreshing OAuth tokens on endpoint:', endpoint, err)
      }
    }
    return null
  }

  function logout() {
    cfOAuthTokens.value = null
    cfApiToken.value = ''
    cfAccountId.value = ''
    cfSubdomain.value = ''
    authError.value = null
    isHubOpen.value = false
    isConnectOpen.value = false

    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('settings/cloudflare/cfOAuthTokens')
      localStorage.removeItem('settings/cloudflare/cfAccountId')
      localStorage.removeItem('settings/cloudflare/cfApiToken')
      localStorage.removeItem('settings/cloudflare/cfSubdomain')
      localStorage.removeItem('settings/discord/cfOAuthTokens')
      localStorage.removeItem('settings/discord/cfAccountId')
      localStorage.removeItem('settings/discord/cfApiToken')
      localStorage.removeItem('settings/discord/cfSubdomain')
    }

    if (activeAccountId.value) {
      setCachedVaultNsId(activeAccountId.value, '')
    }

    try {
      const syncStore = useSyncEngineStore()
      if (syncStore.activeProvider === 's3' && (syncStore.s3Endpoint.includes('cloudflarestorage.com') || syncStore.s3Endpoint.includes('r2.cloudflarestorage.com'))) {
        syncStore.syncEnabled = false
        syncStore.s3Endpoint = ''
        syncStore.s3Bucket = ''
        syncStore.s3AccessKeyId = ''
        syncStore.s3SecretAccessKey = ''
      }
    }
    catch (e) {
      console.warn('[useCloudflareStore] Failed to reset syncStore during logout:', e)
    }
  }

  // Periodic background device sync (reads only, never writes unless metadata changed)
  if (typeof window !== 'undefined') {
    setTimeout(() => {
      if (isAuthenticated.value) {
        void syncVaultDevices().catch(() => {})
      }
    }, 2500)

    // Relaxed 15-minute background poll (96 reads/day max vs 100,000 free tier limit)
    setInterval(() => {
      if (isAuthenticated.value && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
        void syncVaultDevices().catch(() => {})
      }
    }, 15 * 60 * 1000)

    // Re-check when user switches back to this tab/window
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isAuthenticated.value) {
          void syncVaultDevices().catch(() => {})
        }
      })
    }
  }

  return {
    cfOAuthTokens,
    cfAccountId,
    cfApiToken,
    cfSubdomain,
    isAuthenticating,
    authError,
    isAuthenticated,
    isHubOpen,
    isConnectOpen,
    activeAccessToken,
    activeAccountId,
    authenticateWithCloudflare,
    refreshOAuthTokens,
    verifyAndSetApiToken,
    handleManualCallbackInput,
    exchangeAuthCode,
    getCloudflareSubdomain,
    setCloudflareSubdomain,
    deployCorsProxy,
    deployCompanionEmbassy,
    saveToEdgeVault,
    fetchFromEdgeVault,
    autoRestoreEdgeVault,
    syncVaultDevices,
    logout,
  }
})
