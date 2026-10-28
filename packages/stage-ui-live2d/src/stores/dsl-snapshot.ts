import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

export interface DslSnapshotHitArea {
  name: string
  id?: string
  motion?: string
}

export interface DslSnapshotReaction {
  group: string
  text?: string
  sound?: string
}

export interface DslSnapshotDispatch {
  kind: 'dispatch' | 'command' | 'choice' | 'tap'
  target: string
  at: number
}

export interface DslSnapshot {
  modelId: string
  activeMotion: { group: string, index?: number } | null
  lastText: string | null
  lastDispatch: DslSnapshotDispatch | null
  enabledHitAreas: string[]
  hitAreas: DslSnapshotHitArea[]
  reactions: DslSnapshotReaction[]
  varFloats: Record<string, number>
  updatedAt: number
}

export const useDslSnapshotStore = defineStore('live2d-dsl-snapshot', () => {
  const snapshots = useLocalStorageManualReset<Record<string, DslSnapshot>>('settings/live2d/dsl-snapshot', {})

  function publish(snapshot: DslSnapshot): void {
    if (!snapshot?.modelId)
      return
    snapshots.value = { ...snapshots.value, [snapshot.modelId]: snapshot }
  }

  function get(modelId: string | undefined): DslSnapshot | null {
    if (!modelId)
      return null
    return snapshots.value[modelId] ?? null
  }

  function reset(): void {
    snapshots.reset()
  }

  return { snapshots, publish, get, reset }
})
