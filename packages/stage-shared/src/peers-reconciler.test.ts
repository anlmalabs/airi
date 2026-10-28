import type { SameAccountDevice } from './peers'
import type { VaultDeviceMap } from './peers-reconciler'

import { describe, expect, it } from 'vitest'

import { mergeSameAccountDevices, toVaultDeviceMap } from './peers-reconciler'

function device(overrides: Partial<SameAccountDevice> = {}): SameAccountDevice {
  return {
    id: 'peer-studio-mac',
    alias: 'Studio Mac',
    characterName: 'AIRI',
    relationship: 'same-account',
    trustState: 'trusted',
    lastSeenTimestamp: 1_000,
    endpoints: {},
    machineId: 'studio-mac',
    deviceType: 'desktop',
    ...overrides,
  }
}

describe('mergeSameAccountDevices', () => {
  it('adds fresh remote devices', () => {
    const remote: VaultDeviceMap = {
      'macbook-air': { machineId: 'macbook-air', deviceType: 'laptop', lastSeen: 2_000 },
    }
    const merged = mergeSameAccountDevices([device()], remote, 2_001)
    expect(merged.map(d => d.machineId).sort()).toEqual(['macbook-air', 'studio-mac'])
  })

  it('ignores stale heartbeats beyond max age', () => {
    const remote: VaultDeviceMap = {
      'old-laptop': { machineId: 'old-laptop', deviceType: 'laptop', lastSeen: 0 },
    }
    const merged = mergeSameAccountDevices([device()], remote, 35 * 24 * 60 * 60 * 1000)
    expect(merged.map(d => d.machineId)).toEqual(['studio-mac'])
  })

  it('keeps newer local entry over older remote', () => {
    const remote: VaultDeviceMap = {
      'studio-mac': { machineId: 'studio-mac', deviceType: 'desktop', lastSeen: 500 },
    }
    const merged = mergeSameAccountDevices([device({ lastSeenTimestamp: 1_000 })], remote, 1_001)
    expect(merged[0].lastSeenTimestamp).toBe(1_000)
  })

  it('round-trips local roster to vault map', () => {
    const map = toVaultDeviceMap([device({ machineId: 'a', alias: 'A' })])
    expect(map.a.machineId).toBe('a')
    expect(map.a.deviceName).toBe('A')
  })
})
