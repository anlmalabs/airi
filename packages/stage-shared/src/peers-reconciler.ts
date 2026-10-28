import type { SameAccountDevice } from './peers'

export interface DeviceHeartbeat {
  machineId: string
  deviceName?: string
  deviceType: SameAccountDevice['deviceType']
  workerUrl?: string
  lastSeen: number
  presenceState?: 'active' | 'idle' | 'offline'
}

export type VaultDeviceMap = Record<string, DeviceHeartbeat>

export const DEVICE_STALE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export function toVaultDevice(device: SameAccountDevice): DeviceHeartbeat {
  return {
    machineId: device.machineId,
    deviceName: device.alias,
    deviceType: device.deviceType,
    workerUrl: device.endpoints.cloudflareWorkerUrl,
    lastSeen: device.lastSeenTimestamp,
    presenceState: 'active',
  }
}

export function toVaultDeviceMap(roster: SameAccountDevice[]): VaultDeviceMap {
  const map: VaultDeviceMap = {}
  for (const device of roster)
    map[device.machineId] = toVaultDevice(device)
  return map
}

export function mergeSameAccountDevices(
  local: SameAccountDevice[],
  remote: VaultDeviceMap,
  now = Date.now(),
  maxStaleMs = DEVICE_STALE_MS,
): SameAccountDevice[] {
  const merged = new Map<string, SameAccountDevice>()
  for (const device of local)
    merged.set(device.machineId, device)

  for (const heartbeat of Object.values(remote)) {
    if (!heartbeat || typeof heartbeat.machineId !== 'string' || !heartbeat.machineId)
      continue
    if (!Number.isFinite(heartbeat.lastSeen) || now - heartbeat.lastSeen > maxStaleMs)
      continue
    const existing = merged.get(heartbeat.machineId)
    if (existing && existing.lastSeenTimestamp >= heartbeat.lastSeen)
      continue
    if (existing) {
      merged.set(heartbeat.machineId, {
        ...existing,
        alias: heartbeat.deviceName ?? existing.alias,
        deviceType: heartbeat.deviceType ?? existing.deviceType,
        lastSeenTimestamp: heartbeat.lastSeen,
        edgeVaultSyncedAt: now,
        endpoints: {
          ...existing.endpoints,
          cloudflareWorkerUrl: heartbeat.workerUrl ?? existing.endpoints.cloudflareWorkerUrl,
        },
      })
    }
    else {
      merged.set(heartbeat.machineId, {
        id: `peer-${heartbeat.machineId}`,
        alias: heartbeat.deviceName ?? heartbeat.machineId,
        characterName: 'AIRI',
        relationship: 'same-account',
        trustState: 'trusted',
        lastSeenTimestamp: heartbeat.lastSeen,
        endpoints: heartbeat.workerUrl ? { cloudflareWorkerUrl: heartbeat.workerUrl } : {},
        machineId: heartbeat.machineId,
        deviceType: heartbeat.deviceType ?? 'desktop',
        edgeVaultSyncedAt: now,
      })
    }
  }

  return [...merged.values()]
}
