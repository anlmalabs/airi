export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface CommandLogEntry {
  id: string
  command: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
  timestamp: number
  sessionId?: string
}

export interface VirtualFileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
}

export interface MountedWidget {
  id: string
  path: string
  sourcePath?: string
  sourceCode?: string
  code: string
  title?: string
  surface?: 'panel' | 'widget'
  target?: 'sidepanel' | 'inline' | 'window'
  position?: { x: number, y: number }
  state?: any
  scope?: 'global' | 'card'
  cardId?: string
  _lastSyncedJsonContent?: string
  mountedAt: number
}

export interface SandboxVfsSessionProjection {
  activeSessionId: string
  characterName: string
  messageCount: number
  lastMessageAt: string | null
  hoursSinceLastMessage: number | null
  createdAt: string | null
}

export interface SandboxVfsCharacterActingCognition {
  modelExpressionPrompt?: string
  speechExpressionPrompt?: string
  speechMannerismPrompt?: string
  stickerDirectivesPrompt?: string
}

export interface SandboxVfsCharacterCognition {
  name: string
  nickname?: string
  description?: string
  personality?: string
  scenario?: string
  systemPrompt?: string
  acting?: SandboxVfsCharacterActingCognition
}

export interface SandboxVfsCognitionProjection {
  character: SandboxVfsCharacterCognition
  consciousness: {
    activeProvider: string
    activeModel: string
  }
  emotion?: string
  valence?: number
  energy?: number
  somaticState?: string
  nan0?: {
    enabled: boolean
    emotions: Record<string, number>
    lastReflex?: {
      label: string
      cluster?: string
      confidence?: number
      icon?: string
    } | null
    decision?: string
    decisionReason?: string
    demandsSilence?: boolean
    isPouting?: boolean
    innerMonologue?: string
    moodProfile?: {
      primary: string
      secondary?: string | null
      valence: number
      arousal: number
    }
  }
}

export interface SandboxVfsTelemetryProjection {
  idleTimeSec: number
  activeProgram: string
  activeWindowTitle: string
  windowHistory: Array<{
    processName: string
    title: string
    durationMs: number
  }>
  cpuLoad: [number, number, number]
  gpuAvg: number
  volumeLevel: number
  localTime: string
  usageMetrics: {
    ttsHourly: number
    sttHourly: number
    chatHourly: number
    journalHourly: number
    turnCount: number
  }
}

export interface SandboxVfsMessageItem {
  id: string
  role: string
  createdAt?: string
  content: string
}

export interface SandboxVfsLive2dHitArea {
  name: string
  id?: string
  motion?: string
}

export interface SandboxVfsLive2dReaction {
  group: string
  text?: string
  sound?: string
}

export interface SandboxVfsLive2dDispatch {
  kind: 'dispatch' | 'command' | 'choice' | 'tap'
  target: string
  at: number
}

export interface SandboxVfsLive2dProjection {
  modelId: string
  hasModel: boolean
  live: boolean
  activeMotion: { group: string, index?: number } | null
  lastText: string | null
  lastDispatch: SandboxVfsLive2dDispatch | null
  enabledHitAreas: string[]
  hitAreas: SandboxVfsLive2dHitArea[]
  hitAreasCount: number
  reactions: SandboxVfsLive2dReaction[]
  reactionsCount: number
  hasDsl: boolean
  varFloats: Record<string, number>
  updatedAt: number
}

export type SandboxChannelMessage
  = | { type: 'sync-request', requestId: string }
    | { type: 'sync-response', requestId: string, commandLogs: CommandLogEntry[], mountedWidgets?: MountedWidget[] }
    | { type: 'command-log', entry: CommandLogEntry }
    | { type: 'widget-mount', widget: MountedWidget }
    | { type: 'widget-unmount', id: string }
    | { type: 'widget-clear' }
    | { type: 'widget-state-sync', id: string, path: string, state: any }
    | { type: 'widget-state-update', id: string, path: string, state: any }
    | { type: 'exec', requestId: string, command: string }
    | { type: 'exec-done', requestId: string, result: ExecResult }
    | { type: 'exec-error', requestId: string, error: string }
    | { type: 'list-files', requestId: string, dir: string }
    | { type: 'list-files-done', requestId: string, entries: VirtualFileEntry[] }
    | { type: 'read-file', requestId: string, path: string }
    | { type: 'read-file-done', requestId: string, content: string }
    | { type: 'read-file-error', requestId: string, error: string }
    | { type: 'write-file', requestId: string, path: string, content: string }
    | { type: 'write-file-done', requestId: string }
    | { type: 'clear-logs' }
    | { type: 'reset', requestId: string }
    | { type: 'reset-done', requestId: string }
