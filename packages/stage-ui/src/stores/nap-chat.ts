import type { Peer } from '@proj-airi/stage-shared'

import type { ChatStreamEventContext, StreamingAssistantMessage } from '../types/chat'

import { isCompanionAllowedForFriend, isNapChatEligible, isStageTamagotchi } from '@proj-airi/stage-shared'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, watch } from 'vue'

import { useChatOrchestratorStore } from './chat'
import { useChatContextStore } from './chat/context-store'
import { useChatSessionStore } from './chat/session-store'
import { useEventLogStore } from './event-log'
import { useTextJournalStore } from './memory-text-journal'
import { useAiriCardStore } from './modules/airi-card'
import { usePresenceStore } from './presence'
import { isUserAway } from './proactivity-telemetry'

/**
 * Why a nap-chat session stopped.
 *
 * `model-gate` is the one reason that leaves nothing to surface: the gate
 * refused before any token was spent, so there is no conversation to recap
 * (design §6, §7 "A session that never produced a recap").
 */
export type NapChatCloseReason = 'completed' | 'stalled' | 'model-gate'

/**
 * The seam between the nap-chat session (Phase 3) and its memory write-back.
 *
 * Phase 3 calls {@link useNapChatStore.recordNapChatCompletion} once, when a
 * session closes. It deliberately does not import anything from
 * `stores/companion.ts`: the two stores must not know each other, so the
 * session owner can evolve without dragging the audit trail with it.
 */
export interface NapChatSessionRecord {
  sessionId: string
  localPeerId: string
  peerPeerId: string
  localCardName: string
  peerCardName: string
  turnCount: number
  startedAt: number
  endedAt: number
  closeReason: NapChatCloseReason
  /**
   * The recap of what was discussed, as a plain sentence.
   *
   * Produced deterministically from the session turns — never a second LLM
   * pass, so the journal text and the surfaced text cannot drift apart.
   */
  recap: string
}

/** What the write-back persists, per session. Key order is the §6 list. */
const RECORD_PAYLOAD_KEYS = [
  'sessionId',
  'localPeerId',
  'peerPeerId',
  'localCardName',
  'peerCardName',
  'turnCount',
  'startedAt',
  'endedAt',
  'closeReason',
] as const satisfies readonly (keyof NapChatSessionRecord)[]

/** Storage key for the single pending-recap slot. */
const PENDING_RECAP_KEY = 'settings/nap-chat/pending-recap'
/** Storage key for the lease that stops a restarted window re-firing a recap. */
const SURFACED_SESSION_KEY = 'settings/nap-chat/last-surfaced-session-id'

/**
 * The one thing the return edge delivers.
 *
 * `recapText` is the *only* copy of the wording: it is the journal entry's
 * `content` and the assistant turn's text, so nothing downstream can restate or
 * summarise it a second time.
 */
interface PendingRecap {
  sessionId: string
  journalEntryId: string
  recapText: string
  peerCardName: string
  turnCount: number
  endedAt: number
}

/**
 * Format a duration the way the presence report does, but for milliseconds.
 *
 * `stores/presence.ts` keeps its own formatter private on purpose (one owner
 * per threshold, one owner per formatting), so this is a local helper rather
 * than an import. Seconds are truncated, never rounded, so a session that ran
 * 89.9s reports `1m 29s` rather than claiming a minute and a half.
 */
export function formatNapChatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0)
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  return `${seconds}s`
}

/**
 * Compose the surfacing sentence from the session record.
 *
 * Pure, and the single source of the wording contract (design §7):
 *
 * > While you were away I napped. {peerName} and I had a short chat — {recap}.
 * > {n} turns, {duration}.
 *
 * The same string is journalled and spoken. Keeping it in one function is what
 * makes "the journal entry text and the spoken text are the same string" a
 * structural fact rather than a convention two call sites have to remember.
 */
export function composeNapChatRecap(input: {
  peerCardName: string
  recap: string
  turnCount: number
  durationMs: number
}): string {
  return `While you were away I napped. ${input.peerCardName} and I had a short chat — ${input.recap}. ${input.turnCount} turns, ${formatNapChatDuration(input.durationMs)}.`
}

/**
 * Read a persisted slot written by {@link writeSlot}.
 *
 * A slot left by an older shape is dropped rather than recovered: losing a
 * recap is the safe failure, whereas misreading one risks speaking the wrong
 * anecdote, and this whole feature exists to be careful about what is spoken.
 */
function readSlot<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined')
    return fallback
  const raw = localStorage.getItem(key)
  if (!raw)
    return fallback
  try {
    const parsed = JSON.parse(raw) as T | string
    if (typeof fallback === 'string')
      return (typeof parsed === 'string' ? parsed : fallback) as T
    return parsed && typeof parsed === 'object' ? parsed : fallback
  }
  catch {
    return fallback
  }
}

function writeSlot(key: string, value: unknown) {
  if (typeof localStorage === 'undefined')
    return
  localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
}

function clearSlot(key: string) {
  if (typeof localStorage === 'undefined')
    return
  localStorage.removeItem(key)
}

/**
 * Nap-chat memory write-back and return surfacing.
 *
 * Two responsibilities, both owned by the session-close seam:
 *
 * 1. **Write-back** (design §6) — one `nap_chat_completed` ledger event and one
 *    text-journal entry per *completed* session. Nothing writes echo chips,
 *    STMM or Lifetime; the peer's memory is never received, so there is nothing
 *    of theirs to persist, and nothing is relayed onward.
 * 2. **Surfacing** (design §7) — the presence edge into `active` emits exactly
 *    one assistant turn, for the most recent completed session. Not a queue,
 *    not a digest, and never while the user is present.
 */

// --- Upstream (dasilva333) nap-chat fields, adopted for convergence (eliminate silos) ---
export const NAP_CHAT_DEFAULT_THRESHOLD_MIN = 15

export const NAPCHAT_UNIVERSE_ID = 'napchat'

export const NAP_HISTORY_WINDOW_DEFAULT = 6

export const NAP_DIALOG_NO_HISTORY_MARKER = 'No prior episodes with this peer.'

export const DEFAULT_SOCIAL_PROMPT_GUIDANCE
  = 'Be casual, friendly, and enthusiastic. Discuss our shared creative and coding projects while keeping private user personal details confidential.\n'
    + 'If the dialog state says "No prior episodes with this peer", this is first contact: generate a friendly greeting mentioning them by name and probing for shared interests. Do not pretend a history you do not have.\n'
    + 'If prior dialog turns exist, continue the ongoing conversation naturally — do not re-greet or re-introduce yourself.'

export interface NapTurn {
  speaker: string
  text: string
  time: string
}

export interface NapEpisode {
  sessionId: string
  with: {
    characterName: string
    alias: string
    avatarUrl?: string
  }
  turnCount: number
  summary: string
  timestamp: number
  journalEntryId: string
  turns: NapTurn[]
}

/**
 * The idle reading a nap-chat decision uses.
 *
 * An explicit reading wins — the caller owns the signal it was handed — and
 * otherwise the presence store's canonical reading is used, so nap-chat never
 * probes the OS itself. `undefined` means "no observation", which the
 * away-predicate treats as "the user is present" (fail closed: an unavailable
 * probe must not start an autonomous session).
 */
export function resolveNapIdleSec(currentIdleSec?: number): number | undefined {
  if (currentIdleSec !== undefined)
    return currentIdleSec
  return usePresenceStore().idleTimeSec ?? undefined
}

export const useNapChatStore = defineStore('nap-chat', () => {
  const eventLogStore = useEventLogStore()
  const journalStore = useTextJournalStore()
  const airiCardStore = useAiriCardStore()
  const presenceStore = usePresenceStore()
  const { activeCard, activeCardId } = storeToRefs(airiCardStore)

  // --- Upstream convergence fields ---
  const napEnabled = ref(true)
  const afkThresholdMinutes = ref(NAP_CHAT_DEFAULT_THRESHOLD_MIN)
  const welcomeBackRecapEnabled = ref(true)
  const firedForIdleSession = ref(false)
  const socialPromptGuidance = ref(DEFAULT_SOCIAL_PROMPT_GUIDANCE)
  const napHistoryWindow = ref(NAP_HISTORY_WINDOW_DEFAULT)
  const ambassadorCompanionId = ref('')
  const latestEpisode = ref<NapEpisode | null>(null)

  /**
   * The recap waiting for the user's return, or `null` when there is nothing to
   * say.
   *
   * A single persisted slot rather than a list: a second completion *overwrites*
   * the first, which is how "exactly one recap surfaces" is enforced without a
   * queue that has to be drained and counted (design §7, Decision 5). Nothing
   * here needs the full record — the recap text, the session it came from, and
   * the journal entry it equals are the whole payload, so a stale slot never
   * restates already-spoken wording.
   */
  const pendingRecap = ref<PendingRecap | null>(readSlot<PendingRecap | null>(PENDING_RECAP_KEY, null))

  /**
   * The last session whose recap was delivered, so a window that restarts
   * between the write-back and the return does not speak an old anecdote twice.
   *
   * Delivery clears the pending slot *and* records the lease, so the bound holds
   * across a reload, a second window, and the cross-window storage sync.
   */
  const lastSurfacedSessionId = ref<string>(readSlot<string>(SURFACED_SESSION_KEY, ''))

  /** Guard against an overlapping delivery (two edges, or a watch re-entry). */
  const surfacing = ref(false)

  /**
   * The payload that goes on the ledger event.
   *
   * An allow-list rather than a spread of the record: the ledger is the audit
   * trail other code and the user read, so a new field added to
   * {@link NapChatSessionRecord} has to be added here deliberately. The recap is
   * deliberately absent — it lives in the journal, keyed by the `journalEntryId`
   * this event carries.
   */
  function buildLedgerPayload(record: NapChatSessionRecord, journalEntryId: string | null) {
    const entry: Record<string, unknown> = {}
    for (const key of RECORD_PAYLOAD_KEYS)
      entry[key] = record[key]
    entry.journalEntryId = journalEntryId
    return entry
  }

  /**
   * Close a nap-chat session: write the audit trail, and arm the return surface.
   *
   * Called once per session by the session owner. `model-gate` sessions record
   * only that the gate refused — no journal entry, no recap, nothing to surface,
   * because the gate refuses before any token is spent (§5.1).
   */
  async function recordNapChatCompletion(record: NapChatSessionRecord): Promise<void> {
    if (record.closeReason === 'model-gate') {
      await eventLogStore.appendEvent({
        category: 'agentic',
        type: 'nap_chat_gated',
        source: record.localCardName || 'AIRI',
        textSummary: 'Nap-chat session refused by the model gate; nothing was spent',
        autonomous: true,
        payload: buildLedgerPayload(record, null),
      })
      return
    }

    let journalEntryId: string | null = null
    let recapText = ''
    const recap = record.recap.trim()

    if (recap) {
      const durationMs = Math.max(0, record.endedAt - record.startedAt)
      recapText = composeNapChatRecap({
        peerCardName: record.peerCardName,
        recap,
        turnCount: record.turnCount,
        durationMs,
      })

      const entry = await journalStore.createEntry({
        title: `Nap-chat with ${record.peerCardName}`,
        content: recapText,
        source: 'dream',
        sessionId: record.sessionId,
      })
      journalEntryId = entry.id
    }

    await eventLogStore.appendEvent({
      category: 'agentic',
      type: 'nap_chat_completed',
      source: record.localCardName || 'AIRI',
      textSummary: `Nap-chat with ${record.peerCardName} closed (${record.closeReason})`,
      autonomous: true,
      payload: buildLedgerPayload(record, journalEntryId),
    })

    if (!journalEntryId) {
      // A `stalled` session with no recap still has its ledger row; it just has
      // nothing worth saying on return.
      return
    }

    // Arm the surface. Overwriting a previous pending recap is the whole of the
    // "no queue" rule: the newest session is the one the user hears about.
    pendingRecap.value = {
      sessionId: record.sessionId,
      journalEntryId,
      recapText,
      peerCardName: record.peerCardName,
      turnCount: record.turnCount,
      endedAt: record.endedAt,
    }
    writeSlot(PENDING_RECAP_KEY, pendingRecap.value)
  }

  /** Speak the recap through the ordinary single-pipeline chat turn. */
  async function surfacePendingRecap(): Promise<void> {
    if (surfacing.value)
      return

    const pending = pendingRecap.value
    if (!pending || pending.sessionId === lastSurfacedSessionId.value)
      return

    surfacing.value = true
    try {
      // Consume *before* delivering, so a failure mid-flight cannot leave a
      // recap armed for the next edge (the same lease-once discipline Dream
      // State uses for its chips — chat.ts:1359-1364 lease, :1960-1976 clear).
      pendingRecap.value = null
      clearSlot(PENDING_RECAP_KEY)
      lastSurfacedSessionId.value = pending.sessionId
      writeSlot(SURFACED_SESSION_KEY, pending.sessionId)

      await deliverRecapTurn(pending)
    }
    finally {
      surfacing.value = false
    }
  }

  /**
   * Inscribe the recap into the user's own active session, through the hooks.
   *
   * The four steps are the heartbeat pattern (`proactivity.ts:790-893`), reused
   * verbatim so captions, TTS, the chat bubble and the ledger all learn about
   * the turn from the usual places rather than from a parallel path. No LLM call
   * happens: the text already exists, and a second pass over it could only
   * reword what the journal records.
   */
  async function deliverRecapTurn(pending: PendingRecap): Promise<void> {
    if (!activeCardId.value)
      return

    const chatOrchestrator = useChatOrchestratorStore()
    const chatSessionStore = useChatSessionStore()
    const sessionId = chatSessionStore.activeSessionId
    if (!sessionId)
      return

    const chatContextStore = useChatContextStore()

    const now = Date.now()
    const rawContext: ChatStreamEventContext = {
      message: {
        role: 'user',
        content: '[Autonomous Intent]',
        createdAt: now,
        id: nanoid(),
      },
      contexts: chatContextStore.getContextsSnapshot(),
      composedMessage: [],
    }
    // Deep clone: the hook consumers forward this context over IPC, and a
    // reactive proxy or a class instance would fail the structured clone.
    const context = JSON.parse(JSON.stringify(rawContext)) as ChatStreamEventContext

    const buildingMessage: StreamingAssistantMessage = {
      role: 'assistant',
      content: pending.recapText,
      slices: [{ type: 'text', text: pending.recapText }],
      tool_results: [],
      createdAt: now,
      id: nanoid(),
    }

    await chatOrchestrator.emitBeforeMessageComposedHooks('[Autonomous Intent]', context)

    // The stream's completion is announced *before* the turn is inscribed, which
    // is the order the heartbeat precedent uses (`proactivity.ts:877-892`):
    // stream ended, then the assistant response ended, then the inscribe, then
    // the assistant message, then chatTurnComplete last.
    //
    // NOTICE: the two omitted hooks are the whole defect. `emitStreamEndHooks`
    // and `emitAssistantResponseEndHooks` are what every downstream consumer
    // waits on — TTS, the bubble, Discord — so a recap that skipped them was
    // written to the journal and to memory and then never said out loud or
    // shown, which is the opposite of what "surface on return" is for. They are
    // not optional companions to `emitAssistantMessageHooks`; each one drives a
    // different set of subscribers.
    await chatOrchestrator.emitStreamEndHooks(context)
    await chatOrchestrator.emitAssistantResponseEndHooks(pending.recapText, context)

    chatSessionStore.inscribeTurn(buildingMessage, sessionId)

    // The precedent resets the streaming slot only when the session is the user's
    // active one (`proactivity.ts:883-885`), so a recap inscribing into a
    // background session cannot blank the bubble the user is looking at.
    if (sessionId === chatSessionStore.activeSessionId) {
      chatOrchestrator.streamingMessage = { role: 'assistant', content: '', slices: [], tool_results: [] }
    }

    await chatOrchestrator.emitAssistantMessageHooks(buildingMessage, pending.recapText, context)
    await chatOrchestrator.emitChatTurnCompleteHooks({
      output: buildingMessage,
      outputText: pending.recapText,
      toolCalls: [],
    }, context)

    await eventLogStore.appendEvent({
      category: 'agentic',
      type: 'nap_chat_surfaced',
      source: activeCard.value?.name || 'AIRI',
      textSummary: `Nap-chat recap surfaced on return: ${pending.recapText.slice(0, 80)}${pending.recapText.length > 80 ? '...' : ''}`,
      autonomous: true,
      payload: {
        sessionId: pending.sessionId,
        journalEntryId: pending.journalEntryId,
        peerCardName: pending.peerCardName,
        turnCount: pending.turnCount,
      },
    })
  }

  /**
   * Arm the presence edge: `away`/`idle` → `active`.
   *
   * Only the *edge* is watched, so a companion already being spoken at never
   * gets an unsolicited anecdote — the watch simply does not fire when the user
   * never left, and it fires once on the way back because delivery consumes the
   * pending slot. `screen-locked` and `sleep` are intentionally not edges: the
   * renderer cannot observe either signal today (presence.ts:130-145), so an
   * unlock or a wake would be a state the store claims to have seen but never
   * did.
   *
   * Only the main window runs this: a chatbox or overlay window seeing the same
   * edge would speak the same recap twice, and the persisted lease is not enough
   * to stop two windows racing on the same tick.
   *
   * NOTICE: `flush: 'sync'`, matching the watches that own the presence signal
   * itself (`stores/presence.ts:317`, `stores/agentic.ts:312`). A deferred flush
   * coalesces two presence writes that land in the same tick into one callback
   * seeing only the final state, which is precisely the `away → active` edge
   * this boundary exists to catch — and the recap would be silently dropped.
   */
  function watchPresenceEdge(): void {
    watch(
      () => presenceStore.presenceState,
      (next, prev) => {
        if (next !== 'active')
          return
        if (prev !== 'away' && prev !== 'idle')
          return
        void surfacePendingRecap()
      },
      { flush: 'sync' },
    )
  }

  /**
   * Peers eligible for an autonomous nap-chat right now.
   *
   * `currentIdleSec` is the caller's idle reading; when it is absent the
   * presence store's canonical reading is used instead. The threshold is this
   * store's own `afkThresholdMinutes`, not the presence store's default, so
   * nap-chat keeps its own knob while still reading one idle signal.
   */
  function selectCandidates(roster: Peer[], companionId: string, currentIdleSec?: number): Peer[] {
    if (!napEnabled.value)
      return []
    const idleSec = resolveNapIdleSec(currentIdleSec)
    if (!isUserAway(idleSec, afkThresholdMinutes.value))
      return []
    return roster.filter(peer => isNapChatEligible(peer) && isCompanionAllowedForFriend(peer, companionId))
  }

  function markIdleSessionStarted() {
    firedForIdleSession.value = false
  }

  function shouldDeliverRecap(): boolean {
    if (!welcomeBackRecapEnabled.value || firedForIdleSession.value)
      return false
    firedForIdleSession.value = true
    return true
  }

  function recordEpisode(episode: NapEpisode) {
    latestEpisode.value = episode
  }

  function formatWelcomeBackRecap(episode?: NapEpisode | null): string {
    const ep = episode !== undefined ? episode : latestEpisode.value
    if (!ep || !ep.with?.characterName)
      return 'NO_REPLY'
    return `While you were away, I had a brief chat with ${ep.with.characterName} about our project notes!`
  }

  if (isNapChatWatchSurface()) {
    watchPresenceEdge()
  }

  return {
    pendingRecap,
    lastSurfacedSessionId,
    surfacing,
    recordNapChatCompletion,
    surfacePendingRecap,
    /** Test seam: deliver a recap without waiting for a presence edge. */
    deliverRecapTurn,
    watchPresenceEdge,
    napEnabled,
    afkThresholdMinutes,
    welcomeBackRecapEnabled,
    firedForIdleSession,
    socialPromptGuidance,
    napHistoryWindow,
    ambassadorCompanionId,
    latestEpisode,
    selectCandidates,
    markIdleSessionStarted,
    shouldDeliverRecap,
    recordEpisode,
    formatWelcomeBackRecap,
  }
})

/**
 * Whether this window should own the presence-edge delivery.
 *
 * The same main-window predicate the text journal uses
 * (`memory-text-journal.ts:64`): anything that is not the Electron stage
 * window is a secondary surface (chatbox, overlay) that must not speak. Under
 * jsdom the predicate is `false`, which is what keeps tests from double-firing.
 */
function isNapChatWatchSurface(): boolean {
  if (typeof window === 'undefined')
    return true
  if (!isStageTamagotchi())
    return true
  const hash = window.location.hash || ''
  return hash === '' || hash === '#/' || hash === '#'
}
