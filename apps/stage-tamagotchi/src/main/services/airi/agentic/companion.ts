import type { Eventa } from '@moeru/eventa'
import type {
  CompanionConsent,
  CompanionGuestAccess,
  CompanionGuestSnapshot,
  CompanionShareCard,
  CompanionShareInput,
  CompanionShareScope,
} from '@proj-airi/stage-shared/agentic'
import type { TransportAdapter } from '@proj-airi/stage-shared/transport-adapter'
import type { InferOutput } from 'valibot'

import type { AgenticInvokeContext } from './index'

import { randomBytes } from 'node:crypto'

import { useLogg } from '@guiiai/logg'
import { defineInvokeEventa, defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import {
  COMPANION_TOPIC,
  companionConsentChanged,
  companionServiceGetConsent,
  companionServiceHost,
  companionServiceNapChatConsent,
  companionServiceNapChatConsumeNonce,
  companionServiceNapChatDecideProposal,
  companionServiceRecordObservedShare,
  companionServiceSetConsent,
  companionServiceShare,
  companionServiceVisit,
  companionShareReceived,
  NAP_CHAT_EXPIRY_MS,
} from '@proj-airi/stage-shared/agentic'
import { BrowserWindow, ipcMain } from 'electron'
import { boolean, number, object, optional, picklist } from 'valibot'

import { createConfig } from '../../../libs/electron/persistence'
import { getLibp2pMeshPublisher } from '../libp2p'
import { listPairedDevices } from '../libp2p/pairing'
import { createLibp2pTransportAdapter } from '../libp2p/transport-adapter'

const log = useLogg('agentic-companion').useGlobalConfig()

// TransportAdapter seam: companion publishing goes through the shared contract
// instead of the libp2p-specific publisher. Lifecycle (init/dispose) stays with
// setupLibp2pService.
//
// `currentMeshPublisher` is captured once per publishCompanionShare call so the
// adapter does not re-resolve the mesh publisher (which would open a
// resolve-time window where hostPeerId and the emitting node could diverge).
let currentMeshPublisher: ReturnType<typeof getLibp2pMeshPublisher> = null

const companionTransportAdapter: TransportAdapter = createLibp2pTransportAdapter({
  deps: {
    initialize: async () => {},
    dispose: async () => {},
    publish: async (topic, data) => {
      const publisher = currentMeshPublisher ?? getLibp2pMeshPublisher()
      if (!publisher) {
        throw new Error('libp2p mesh unavailable')
      }
      await publisher.publish(topic, data)
    },
    subscribe: () => () => {},
  },
})

// ── Topics ────────────────────────────────────────────────────────────────────

/**
 * Renderer → main: the memory snapshot a hosted guest may read.
 *
 * The renderer owns the memory pillars (IndexedDB + Pinia), so it is the only
 * process that can read them. It reports the snapshot here — on mount and when
 * a pillar finishes loading — and `companionServiceHost` packs exactly what this
 * reports, so the host side never fabricates memory and never reads the
 * renderer's store from main.
 */
export const companionServiceReportGuestSnapshot = defineInvokeEventa<
  { reported: boolean },
  CompanionGuestSnapshot
>(
  'eventa:invoke:electron:agentic:companion:report-guest-snapshot',
)

// ── Wire payload ──────────────────────────────────────────────────────────────
//
// NOTICE: a share carries the card and the consented *scope*, never the memory
// itself. Memory travels only as a direct response from a host to the guest
// that asked, so a broadcast cannot carry another companion's private history
// to every peer on the mesh.
//
// `parseCompanionShare` and its schema are imported from the shared package so
// main and the renderer validate a share under identical rules; a second copy in
// main would be the kind of drift that makes a mesh look connected while
// nothing round-trips.

// ── Guest boundary ────────────────────────────────────────────────────────────

/**
 * Ordering of share scopes, narrowest first.
 *
 * The guest boundary is enforced structurally rather than by convention: a
 * share carries exactly one scope, and the *host* decides which memories it
 * packs. A guest therefore never holds a capability it was not given — there is
 * no "read more" request to grant or refuse.
 */
const SCOPE_ORDER: readonly CompanionShareScope[] = ['card-only', 'card-and-echo-chips', 'card-and-lifetime']

/** The narrower of two scopes, where `card-only` is the floor. */
export function narrowerScope(hostScope: CompanionShareScope, requestedScope: CompanionShareScope): CompanionShareScope {
  const hostIndex = SCOPE_ORDER.indexOf(hostScope)
  const requestedIndex = SCOPE_ORDER.indexOf(requestedScope)
  return SCOPE_ORDER[Math.min(hostIndex, requestedIndex)]
}

/**
 * Pack the memory a visiting companion may read, under the granted scope.
 *
 * This is the *only* place the guest boundary is enforced. The rule is
 * structural: a scope below `card-and-echo-chips` never receives chips, and only
 * `card-and-lifetime` receives lifetime text.
 *
 * The lifetime text is the artifact's own distilled string, never the raw
 * archive or `chunkSummaries`, which would expose the full conversation history
 * behind the distillation.
 */
export function packGuestAccess(input: {
  card: CompanionShareCard
  scope: CompanionShareScope
  echoChips?: CompanionGuestAccess['echoChips']
  lifetimeDistilled?: string
}): CompanionGuestAccess {
  const access: CompanionGuestAccess = {
    card: input.card,
    echoChips: [],
  }

  if (input.scope === 'card-and-echo-chips' || input.scope === 'card-and-lifetime') {
    access.echoChips = input.echoChips ?? []
  }

  if (input.scope === 'card-and-lifetime' && input.lifetimeDistilled) {
    // The distilled relational essence only; the slice is a bound, not a
    // transformation, so a dense archive cannot become an unbounded share.
    access.lifetimeSummary = input.lifetimeDistilled.slice(0, 4000)
  }

  return access
}

// ── Consent persistence ───────────────────────────────────────────────────────

const COMPANION_NAMESPACE = 'agentic-companion'
const COMPANION_FILENAME = 'companion-consent.json'

const CompanionConsentSchema = object({
  granted: boolean(),
  grantedAt: optional(number()),
  scope: picklist(['card-only', 'card-and-echo-chips', 'card-and-lifetime']),
})

const consentStore = createConfig(
  COMPANION_NAMESPACE,
  COMPANION_FILENAME,
  CompanionConsentSchema,
  { default: { granted: false, scope: 'card-only' }, autoHeal: true },
)

/** In-memory consent, so a guest never triggers a disk read. */
let currentConsent: CompanionConsent = { granted: false, scope: 'card-only', grantedAt: undefined }

/**
 * Load consent from disk.
 *
 * NOTICE: `.setup()` must run first — the in-memory map is only populated by
 * `createConfig`'s synchronous disk read, as the libp2p and agentic services do.
 * Without it a real boot ignores the persisted file entirely.
 */
export function setupCompanionConsent() {
  consentStore.setup()
  const stored = consentStore.get()
  if (stored) {
    currentConsent = {
      granted: stored.granted,
      scope: stored.scope,
      // A persisted grant without a timestamp predates the field, so it falls
      // back to `0` rather than to `Date.now()`, which would claim a grant
      // happened at boot when it did not.
      grantedAt: stored.granted ? stored.grantedAt ?? 0 : undefined,
    }
  }
}

/**
 * Persist and broadcast a consent change.
 *
 * One entry point, so every write to consent goes through the same path and the
 * settings page can never show a state the service does not actually hold.
 */
function setConsent(input: { granted: boolean, scope: CompanionShareScope }): CompanionConsent {
  const next: CompanionConsent = input.granted
    ? {
        granted: true,
        scope: input.scope,
        // Re-granting is a new grant; changing the scope while already granted
        // keeps the original time, because the operator did not newly consent.
        grantedAt: currentConsent.granted ? currentConsent.grantedAt ?? Date.now() : Date.now(),
      }
    : { granted: false, scope: 'card-only', grantedAt: undefined }

  currentConsent = next
  consentStore.update(next)
  emitToAllWindows(companionConsentChanged, next)
  return next
}

// ── Guest snapshot (renderer → main) ──────────────────────────────────────────

/** The memory snapshot the renderer last reported, or `null` if it never has. */
let reportedGuestSnapshot: CompanionGuestSnapshot | null = null

// ── Observed shares ───────────────────────────────────────────────────────────

/**
 * Shares observed on `airi/companion`, keyed by the peer id that authored them.
 *
 * A `Map` is used because entries are inserted and evicted at runtime against a
 * cap, which is exactly the case a static `Record` cannot express. The cap
 * matters: a hostile peer must not be able to grow this process's memory by
 * spraying the mesh with shares.
 */
const MAX_OBSERVED_SHARES = 256
/** Shares older than this are treated as expired, so a stale card cannot linger. */
const MAX_OBSERVED_LIFETIME_MS = 30 * 60 * 1000
const observedShares = new Map<string, CompanionShareCard>()

/** Record one observed share, evicting oldest-first past the cap. */
function observeShare(share: CompanionShareCard): void {
  // Re-insertion moves the entry to the newest position, so an active peer is
  // never the one evicted.
  observedShares.delete(share.hostPeerId)
  observedShares.set(share.hostPeerId, share)
  while (observedShares.size > MAX_OBSERVED_SHARES) {
    const oldest = observedShares.keys().next()
    if (oldest.done)
      break
    observedShares.delete(oldest.value)
  }
}

// ── Nap-chat negotiation ─────────────────────────────────────────────────────
//
// NOTICE: nothing in this section opens, advances or closes a session — that is
// Phase 3. What lives here is only the part of the *contract* that needs a
// permission or a nonce, both of which are decided in the process that owns the
// publisher: main reads the paired-device record the pairing flow wrote, and
// main mints the nonce a peer's `accept` has to echo.

/**
 * Pending nonces this node minted for nap-chat proposals it has published.
 *
 * The nonce is minted by the *publisher* of a proposal and echoed by the peer's
 * `accept`, so an entry here is a live authorisation to open exactly one
 * session: a bystander that harvests an `accept` off the topic, or forges one
 * for a proposal it never saw, cannot name a nonce this node did not mint. The
 * cap bounds a peer that keeps a node minting; the age prune bounds one that
 * keeps a nonce outstanding without ever echoing it.
 */
export const MAX_PENDING_NAP_CHAT_NONCES = 64
const pendingNapChatNonces = new Map<string, { peerId: string, sessionId: string, at: number, spent?: boolean }>()

/** Drop nonces older than a session's silence bound, so a stall frees them. */
function prunePendingNapChatNonces(): void {
  const now = Date.now()
  for (const [nonce, entry] of pendingNapChatNonces) {
    if (now - entry.at > NAP_CHAT_EXPIRY_MS) {
      pendingNapChatNonces.delete(nonce)
    }
  }
}

/**
 * Re-insert a live entry so it moves to the newest position.
 *
 * `Map` iteration is insertion-ordered and `set` on an existing key does *not*
 * move it, so touching an entry requires the explicit delete-then-reinsert.
 * Without this the eviction below is oldest-*minted*, which is not the same as
 * oldest-*in-flight*: one long-lived peer plus a stream of proposals it never
 * answers would evict the live authorisation and look like the peer went quiet.
 */
function touchNapChatNonce(nonce: string, entry: { peerId: string, sessionId: string, at: number }): void {
  pendingNapChatNonces.delete(nonce)
  pendingNapChatNonces.set(nonce, entry)
}

/**
 * Evict least-recently-used nonces until the map is back within its cap.
 *
 * The `size > 1` floor is deliberate: the mint that is about to be inserted
 * must not evict the single in-flight nonce already outstanding, so a node with
 * one live session never loses its only authorisation to make room for the next
 * proposal it is publishing.
 */
function capPendingNapChatNonces(): void {
  while (pendingNapChatNonces.size > MAX_PENDING_NAP_CHAT_NONCES && pendingNapChatNonces.size > 1) {
    const oldest = pendingNapChatNonces.keys().next()
    if (oldest.done)
      break
    pendingNapChatNonces.delete(oldest.value)
  }
}

/**
 * Forget every pending authorisation, so none outlive the node that minted them.
 *
 * NOTICE: a nonce is a permission this node granted, so it must not survive
 * whatever shutting down means. The prune above is age-bounded and therefore
 * never fires for a node that shut down inside the window, which is exactly the
 * case that matters: every outstanding accept the peer may still be about to
 * send refers to a mint that no longer has a bound process behind it.
 */
export function clearPendingNapChatNonces(): void {
  pendingNapChatNonces.clear()
}

/** Mint the nonce a peer's `accept` must echo for the proposal about to be sent. */
export function mintNapChatNonce(peerId: string, sessionId: string): string {
  prunePendingNapChatNonces()
  // 128 bits of CSPRNG, base64url so the value survives JSON unchanged — the
  // same shape the pairing token generator uses, for the same reason.
  const nonce = randomBytes(16).toString('base64url')
  pendingNapChatNonces.set(nonce, { peerId, sessionId, at: Date.now() })
  capPendingNapChatNonces()
  return nonce
}

/**
 * The ways an inbound `accept` can resolve, which the caller must tell apart.
 *
 * They matter because they mean opposite things for a session this node already
 * holds. `accepted` and `already-consumed` both answer "yes, this accept is
 * authorised": the second is a re-sent accept, which is idempotent rather than a
 * second authorisation, and answering it as a refusal is what used to tear down
 * a live session over gossip re-delivery. `wrong-peer` is the peer being wrong —
 * the nonce is real and live, so refusing the *message* must not burn the
 * authorisation a legitimate accept is still entitled to. `malformed` is the
 * message being forged or non-existent, which is the case a one-shot
 * authorisation must not survive.
 */
export type NapChatNonceOutcome = 'accepted' | 'already-consumed' | 'malformed' | 'wrong-peer'

/**
 * Whether an inbound `accept` carries a nonce this node actually minted for that
 * peer and that session, consuming it so one nonce opens at most one session.
 *
 * NOTICE: validation runs *before* the entry is claimed, which inverts the old
 * order and is the whole fix. A nonce was previously deleted before its peer,
 * session and age were checked, so a legitimate re-sent accept arrived at an
 * entry that no longer existed and was refused — and the renderer then nulled a
 * live session because of it. Deleting only on a full match keeps the fail-
 * closed direction (a replayed accept still cannot open a *second* session)
 * without punishing the one case that is not an attack.
 *
 * `sessionId` is required: the accept payload carries the session id beside the
 * nonce it echoes, so a nonce valid for one session is never an authorisation
 * for another. An absent one is a caller bug and reads as a mismatch rather
 * than as "bind to whatever".
 */
export function consumeNapChatNonce(nonce: string, peerId: string, sessionId: string): NapChatNonceOutcome {
  // Reaped first, so a node that stopped minting still answers an expired entry
  // as expired instead of holding it for the life of the process.
  prunePendingNapChatNonces()

  const entry = pendingNapChatNonces.get(nonce)
  if (entry === undefined)
    return 'malformed'

  // Every attempt that finds the entry re-inserts it, so eviction order follows
  // use rather than mint order — see `touchNapChatNonce`.
  touchNapChatNonce(nonce, entry)

  if (entry.spent === true) {
    return entry.peerId === peerId && entry.sessionId === sessionId
      ? 'already-consumed'
      : 'wrong-peer'
  }

  if (entry.peerId !== peerId)
    return 'wrong-peer'

  if (sessionId.length === 0 || entry.sessionId !== sessionId)
    return 'wrong-peer'

  // Claimed last, and only on a full match. The entry is kept — marked spent
  // rather than deleted — so a re-sent accept is answerable as the same
  // authorisation instead of as an unknown nonce. The age prune reaps it with
  // the rest of the map, so it is not a leak.
  entry.spent = true
  return 'accepted'
}

/**
 * This node's nap-chat consent for one peer, read from the paired-device record
 * the pairing flow wrote.
 *
 * NOTICE: `listPairedDevices()` is the only route to that record, and main is
 * where it is bound — a renderer-side copy of the grant would be a second source
 * of truth for a permission, which is exactly what single-entry-point pairing
 * avoids. Note what main actually holds: the store is only populated once its
 * `setup()` has run, and `pairedDevicesStore.setup()` currently has no caller at
 * all, so until that is wired every peer here answers "not paired". That fails
 * closed, which is the safe direction, but it also means the grant is only ever
 * reachable after the setup path exists — do not read a refusal as "the user
 * revoked it".
 *
 * A peer with no record at all is a refusal, never a default grant, so "never
 * paired" and "paired without the grant" answer differently only in the reason
 * string, and identically in the answer.
 */
export async function napChatConsentFor(peerId: string): Promise<{ granted: boolean, reason?: string }> {
  const device = (await listPairedDevices()).find(d => d.peerId === peerId)
  if (device === undefined) {
    return { granted: false, reason: 'not-paired' }
  }
  if (device.napChatGranted !== true) {
    return { granted: false, reason: 'nap-chat-consent-not-granted' }
  }
  return { granted: true }
}

/**
 * Decide whether this node may invite `peerId` into a nap-chat session, minting
 * the nonce the peer's `accept` must echo when it may.
 *
 * NOTICE: a refusal sends *nothing*, and in particular no `decline` — a decline
 * would confirm to the peer that this node is alive and listening, which is the
 * one thing a gate must not spend. The reason exists for this node's own log and
 * for the ledger, not for the wire.
 */
export async function decideNapChatProposal(peerId: string, sessionId: string): Promise<{
  proposal: boolean
  nonce?: string
  reason?: string
}> {
  const consent = await napChatConsentFor(peerId)
  if (!consent.granted) {
    return { proposal: false, reason: consent.reason }
  }
  return { proposal: true, nonce: mintNapChatNonce(peerId, sessionId) }
}

// ── Session recap ─────────────────────────────────────────────────────────────

/**
 * One turn of a closed session, as the composing side knows it.
 *
 * `role` is a *local* label, never the peer's claim about itself: the composer
 * decides which side said what, and a peer's own text is quoted as what the
 * other companion said. Nothing here is a memory field, so a recap composed
 * from these cannot carry a chip, a journal entry or a lifetime artifact — the
 * same leak boundary the wire schema holds (§5).
 */
export interface NapChatRecapTurn {
  /** Which side spoke. */
  role: 'Local' | 'Peer'
  /** The text that side said, exactly as this node recorded it. */
  text: string
}

/**
 * The largest recap the journal entry and the spoken turn may carry.
 *
 * Bounded by the shared schema's own text bound (`MAX_NAP_CHAT_TEXT_LENGTH`
 * in `stage-shared/src/agentic.ts`), so a recap main composes is always a
 * valid `reason`/`text` payload as well as a journal body. Capping here rather
 * than at the callsite is what stops three close paths drifting apart.
 */
export const MAX_NAP_CHAT_RECAP_CHARS = 4000

/**
 * Compose a session's recap from its turn history, deterministically.
 *
 * Main owns this function and nothing else about the recap: the turn text only
 * ever exists in the renderer, so the content cannot originate here. What main
 * owns is the *shape*, so that a `completed` close, a `stalled` close and a
 * model-gate record all describe a session the same way instead of each
 * inventing a format.
 *
 * Markdown bullet list, one bullet per turn, in session order, with the local
 * side first wherever this node spoke first. The cap is applied to the whole
 * composed string, never to individual turns, so a truncated bullet is a whole
 * bullet that was dropped rather than a half sentence — and the count of turns
 * that made it in is the honest signal that the session continued past what is
 * quoted.
 *
 * NOTICE: no `Date.now()` and no DOM, so this is pure and testable from main.
 * It is a deterministic function of its input, which is what makes the journal
 * text and the spoken text the same string by construction rather than by two
 * call sites agreeing to be careful.
 *
 * NOTICE: an empty turn list returns `''` rather than throwing. That is the
 * "a session that closed before it said anything" case — a `model-gate` refusal
 * most of all — and the honest recap for it is no recap, not a claim that
 * something was discussed.
 */
export function composeSessionRecap(turns: readonly NapChatRecapTurn[]): string {
  if (turns.length === 0)
    return ''

  const bullets: string[] = []
  let used = 0
  for (const turn of turns) {
    const text = turn.text.trim()
    if (text.length === 0)
      continue

    const bullet = `- **${turn.role}:** ${text}`
    // The separator before each bullet after the first counts toward the cap.
    const cost = bullet.length + (bullets.length === 0 ? 0 : 1)
    if (used + cost > MAX_NAP_CHAT_RECAP_CHARS)
      break
    used += cost
    bullets.push(bullet)
  }

  return bullets.join('\n')
}

// ── Publishing ────────────────────────────────────────────────────────────────

/**
 * Publish a companion share on `airi/companion`.
 *
 * `getPeerId()` is read at publish time so a share always names the node that
 * actually emitted it, rather than a peer id captured when the service started.
 */
function publishCompanionShare(card: CompanionShareInput): CompanionShareCard | null {
  const publisher = getLibp2pMeshPublisher()
  if (!publisher) {
    return null
  }

  const published: CompanionShareCard = {
    cardId: card.cardId,
    name: card.name,
    ...(card.description !== undefined ? { description: card.description } : {}),
    ...(card.portraitBase64 !== undefined ? { portraitBase64: card.portraitBase64 } : {}),
    hostPeerId: String(publisher.getPeerId()),
    publishedAt: Date.now(),
    scope: card.scope,
  }

  // Capture the publisher once so the adapter does not re-resolve it (avoids a
  // hostPeerId / emitting-node mismatch on a concurrent node restart).
  currentMeshPublisher = publisher
  void companionTransportAdapter.publish!(
    COMPANION_TOPIC,
    new TextEncoder().encode(JSON.stringify(published)),
  )
    .catch((err: unknown) => log.withError(err).warn('Failed to publish companion share'))
    .finally(() => {
      currentMeshPublisher = null
    })

  return published
}

// ── Main → Renderer Push ──────────────────────────────────────────────────────
// NOTICE: eventa's electron renderer adapter only binds `ipcRenderer.on('eventa-message')`,
// so a bare `webContents.send()` on a custom channel name reaches nothing — the push
// silently lands nowhere and the contract is dead. Pushes therefore go through a
// transient eventa context bound to each window, exactly as
// `apps/stage-tamagotchi/src/main/services/airi/libp2p/index.ts` does.

function emitToAllWindows<P>(contract: Eventa<P>, payload: P) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed())
      continue
    try {
      const { context: winContext, dispose } = createContext(ipcMain, win)
      winContext.emit(contract, payload)
      dispose()
    }
    catch (err) {
      // A window torn down mid-iteration, or a payload the structured-clone
      // boundary rejects, must not take the caller down; a real serialization
      // failure is a renderer-sync bug and has to stay visible.
      log.withError(err).debug(`Failed to emit ${contract.id} to a window`)
    }
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export async function createCompanionService(params: { context: AgenticInvokeContext }) {
  const context = params.context

  defineInvokeHandler(context, companionServiceGetConsent, async (): Promise<CompanionConsent> => currentConsent)

  defineInvokeHandler(context, companionServiceSetConsent, async (input: {
    granted: boolean
    scope: CompanionShareScope
  }): Promise<CompanionConsent> => setConsent(input))

  defineInvokeHandler(context, companionServiceReportGuestSnapshot, async (snapshot: CompanionGuestSnapshot): Promise<{ reported: boolean }> => {
    reportedGuestSnapshot = snapshot
    return { reported: true }
  })

  defineInvokeHandler(context, companionServiceRecordObservedShare, async (share: CompanionShareCard): Promise<{ recorded: boolean }> => {
    observeShare(share)
    emitToAllWindows(companionShareReceived, share)
    return { recorded: true }
  })

  defineInvokeHandler(context, companionServiceNapChatConsent, async (input: { peerId: string }): Promise<{ granted: boolean, reason?: string }> => {
    return napChatConsentFor(input.peerId)
  })

  // The proposal decision is the minting path, so it is main-side for the same
  // reason the consent read is: main owns the only `listPairedDevices` record a
  // renderer would otherwise have to copy. A refusal returns `{ proposal: false }`
  // and sends nothing on the wire — see `decideNapChatProposal`'s NOTICE.
  defineInvokeHandler(context, companionServiceNapChatDecideProposal, async (input: {
    peerId: string
    sessionId: string
  }): Promise<{ proposal: boolean, nonce?: string, reason?: string }> => {
    return decideNapChatProposal(input.peerId, input.sessionId)
  })

  defineInvokeHandler(context, companionServiceNapChatConsumeNonce, async (input: {
    nonce: string
    peerId: string
    sessionId?: string
  }): Promise<{ accepted: boolean }> => {
    // NOTICE: the invoke contract in `stage-shared` keeps `sessionId` optional
    // because older renderers send it absent, so it cannot be required here
    // without touching that file. The *consuming* boundary requires it instead:
    // an absent session id is passed down as a mismatch rather than as "bind to
    // whatever session is open", which is what stops a nonce valid for one
    // session from opening another.
    //
    // `accepted`/`already-consumed` answer true; `wrong-peer`/`malformed`
    // answer false. The first pair and the second mean opposite things to a
    // caller holding a live session — a re-sent accept is idempotent, while a
    // wrong-peer echo is a real nonce presented by the wrong node — but the
    // contract's return shape is a single boolean, so the distinction is carried
    // by the nonce's stay-alive behaviour rather than by the answer: the wrong
    // peer's attempt burns nothing, so the legitimate accept still works.
    const outcome = consumeNapChatNonce(input.nonce, input.peerId, input.sessionId ?? '')
    return { accepted: outcome === 'accepted' || outcome === 'already-consumed' }
  })

  defineInvokeHandler(context, companionServiceShare, async (card: CompanionShareInput): Promise<{
    shared: boolean
    scope: CompanionShareScope
    reason?: string
  }> => {
    if (!currentConsent.granted) {
      return { shared: false, scope: 'card-only', reason: 'consent-not-granted' }
    }

    // A share can be narrower than the consent, never wider.
    const scope = narrowerScope(currentConsent.scope, card.scope)
    const published = publishCompanionShare({ ...card, scope })

    // Main decides; the renderer only supplied card fields. Nothing is reported
    // as shared when the mesh is down, so a share cannot look successful while
    // no peer ever received it.
    return published
      ? { shared: true, scope }
      : { shared: false, scope, reason: 'mesh-not-running' }
  })

  defineInvokeHandler(context, companionServiceHost, async (input: {
    guestPeerId: string
    scope?: CompanionShareScope
  }): Promise<CompanionGuestAccess | { error: string }> => {
    if (!currentConsent.granted) {
      return { error: 'consent-not-granted' }
    }

    const scope = narrowerScope(currentConsent.scope, input.scope ?? 'card-only')

    // NOTICE: main does not read the renderer's memory pillars — IndexedDB and
    // Pinia are renderer-side. The host therefore packs the snapshot the
    // renderer reported, and packs only that. A `null` snapshot is an honest
    // "granted but the renderer has not reported anything yet", never a
    // fabricated memory.
    return packGuestAccess({
      card: {
        cardId: 'companion',
        name: 'AIRI Companion',
        hostPeerId: input.guestPeerId,
        publishedAt: Date.now(),
        scope,
      },
      scope,
      echoChips: reportedGuestSnapshot?.echoChips,
      lifetimeDistilled: reportedGuestSnapshot?.lifetimeDistilled,
    })
  })

  defineInvokeHandler(context, companionServiceVisit, async (input: {
    hostPeerId: string
  }): Promise<CompanionGuestAccess | { error: string }> => {
    // A visit is answered from the shares observed on `airi/companion`. Nothing
    // is fetched from the peer on demand, so a visit cannot be used to probe a
    // peer that never shared.
    const share = observedShares.get(input.hostPeerId)
    if (!share) {
      return { error: `no share observed from peer "${input.hostPeerId}"` }
    }

    if (Date.now() - share.publishedAt > MAX_OBSERVED_LIFETIME_MS) {
      observedShares.delete(input.hostPeerId)
      return { error: `share from peer "${input.hostPeerId}" has expired` }
    }

    // The observed share's own scope is what the guest gets. A guest cannot ask
    // for a wider scope than the host published, because the published scope is
    // the only claim main recorded.
    return packGuestAccess({
      card: share,
      scope: share.scope,
    })
  })
}

export type ConsentRecord = InferOutput<typeof CompanionConsentSchema>
