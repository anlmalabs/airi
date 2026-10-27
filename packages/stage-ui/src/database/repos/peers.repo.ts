import type { Peer } from '@proj-airi/stage-shared'

import { storage } from '../storage'

export const PEERS_ROSTER_KEY = 'local:peers/roster'

export const peersRepo = {
  async getRoster(): Promise<Peer[]> {
    const stored = await storage.getItemRaw<Peer[]>(PEERS_ROSTER_KEY)
    return Array.isArray(stored) ? stored : []
  },

  async saveRoster(peers: Peer[]): Promise<void> {
    const clean = JSON.parse(JSON.stringify(peers)) as Peer[]
    await storage.setItemRaw(PEERS_ROSTER_KEY, clean)
  },
}
