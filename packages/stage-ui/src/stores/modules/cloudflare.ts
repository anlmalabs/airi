import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Sovereign stub: Cloudflare Edge embassy is not available in the AnimaOS build.
 * This store keeps `MessagingFriends.vue` (ported verbatim from upstream) compiling
 * and degrading gracefully: `isAuthenticated` is always false so the component
 * surfaces "Sign in to Cloudflare first" rather than attempting cloud calls.
 * Libp2p mesh is the sovereign transport; cloud paths are no-ops here.
 */
export const useCloudflareStore = defineStore('cloudflare', () => {
  const isAuthenticated = ref(false)
  const activeAccountId = ref<string | null>(null)
  const cfSubdomain = ref<string | null>(null)
  /**
   * Whether this build ships the Cloudflare Edge surface at all.
   * The sovereign AnimaOS build does not — the libp2p local mesh is the
   * active transport. Callers must use this (not `isAuthenticated`) to tell
   * "unavailable in this build" apart from "signed out".
   */
  const isAvailable = ref(false)

  const UNAVAILABLE_MESSAGE = 'Cloudflare Edge is unavailable in this build.'

  async function deployCompanionEmbassy(_opts?: unknown): Promise<{ success: boolean, error?: string }> {
    return { success: false, error: UNAVAILABLE_MESSAGE }
  }

  async function syncVaultDevices(_opts?: unknown): Promise<{ success: boolean, count?: number, error?: string }> {
    return { success: false, count: 0, error: UNAVAILABLE_MESSAGE }
  }

  return {
    isAuthenticated,
    activeAccountId,
    cfSubdomain,
    isAvailable,
    deployCompanionEmbassy,
    syncVaultDevices,
  }
})
