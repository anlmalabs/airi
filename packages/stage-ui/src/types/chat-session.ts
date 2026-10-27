import type { ChatHistoryItem } from './chat'

export interface ChatSessionMeta {
  sessionId: string
  userId: string
  characterId: string
  title?: string
  messageCount?: number
  universeId?: string
  /**
   * Nap-chat dialog peer. Set for per-pair dialog sessions in the `napchat`
   * universe (one session per companion↔peer pair; a future group chat can
   * key this by group id instead). Lets nap sessions be found without
   * loading message payloads, and lets the session picker badge them.
   */
  napPeerId?: string
  createdAt: number
  updatedAt: number
  pendingJournalMoment?: {
    entryText: string
    timestamp: number
  }
  pendingArtistryMoment?: {
    prompt: string
    timestamp: number
  }
}

export interface ChatSessionRecord {
  meta: ChatSessionMeta
  messages: ChatHistoryItem[]
}

export interface ChatCharacterSessionsIndex {
  activeSessionId: string
  sessions: Record<string, ChatSessionMeta>
}

export interface ChatSessionsIndex {
  userId: string
  characters: Record<string, ChatCharacterSessionsIndex>
}

export interface ChatSessionsExport {
  format: 'chat-sessions-index:v1'
  index: ChatSessionsIndex
  sessions: Record<string, ChatSessionRecord>
}
