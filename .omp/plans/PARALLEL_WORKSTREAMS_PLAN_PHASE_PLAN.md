# Parallel Workstreams Plan: Phase 6 Cloudflare Shims + Phase 5 Cross-WAN TDD + Nap-Chat Recap Consolidation

## Context

Three independent workstreams requested to run in parallel (each may spawn further subagents). All three target the AIRI fork (anlmalabs/airi), sovereignty-first. Current HEAD `06695b4a1` (PR #28 merged). Working tree clean.

- **Workstream A (Phase 6):** Re-add minimal cloud adapter shims behind the TransportAdapter seam so upstream features port cleanly; sovereign build omits them by default. Restore-pluggable items: Cloudflare Workers AI provider, Cloudflare relay for Discord (already local gateway + optional stage-edge Worker).
- **Workstream B (Phase 5):** Harden cross-WAN libp2p mesh CI + TDD across core stores; automated gossipsub round-trip assertions.
- **Workstream C (Nap-Chat):** Collapse two parallel recap systems (`latestEpisode` in-memory preview record vs `pendingRecap` persisted production seam) into one source of truth.

Deliverable: three independently mergeable PRs (two-phase delete→add where applicable), each with typecheck + targeted tests green.

## Shared invariants (all workstreams)

- Sovereignty gate: `TransportRegistry.initialize(id, sovereign)` refuses adapters whose captured `requiresExternalRelay` is true. Cloud adapters MUST set `requiresExternalRelay: true`.
- Default-disabled cloud features: env flags `AIRI_ENABLE_CLOUD_ADAPTERS=1` (main) / `VITE_ENABLE_CLOUD_PROVIDERS=1` (renderer). Default false; registration skipped entirely when false.
- TransportAdapter canonical contract: `packages/stage-shared/src/transport.ts` (`TransportId`, `TransportStatus`, `TransportMessage`, `TransportHandler`, `TransportAdapter`, `TransportCapabilities`, `CloudflareEdgeTransportConfig`, `createLoopbackTransport`). `transport-adapter.ts` re-exports.
- libp2p node lives in Electron main process (`apps/stage-tamagotchi/src/main/services/airi/libp2p`).
- Local IndexedDB for persisted data; no Cloudflare KV.
- Two-phase PRs: delete first, then add (standing pref). Each workstream ships as delete-PR then add-PR where it removes code.

## Workstream A — Phase 6 Cloudflare adapter shims

### A.1 Cloudflare Workers AI provider shim (renderer)

**Goal:** restore the deleted provider so upstream imports resolve; default-disabled.

**Files:**
- Create `packages/stage-ui/src/libs/providers/providers/cloudflare-workers-ai/index.ts`, modeled on `openai-compatible/index.ts`.
  - Config schema: `{ accountId: string, apiToken: string, modelId: string }` (zod).
  - `id: 'cloudflare-workers-ai'`, `tasks: ['chat','vision']`, `business: () => ({ pricing:'paid', deployment:'cloud' })` (or 'free' if free tier; keep 'paid' to match cloud).
  - `createProvider(config)` returns an OpenAI-compatible client pointed at `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}` with Bearer token, OR use `@xsai-ext/providers/create` createOpenAI with that baseUrl. Follow openai-compatible pattern.
  - Validators: reuse `createOpenAICompatibleValidators`.
- Edit `packages/stage-ui/src/libs/providers/providers/index.ts`: add `import './cloudflare-workers-ai'` inside a conditional. Since index.ts is static imports, instead gate registration: always import the module (cheap, no side effects beyond defineProvider) but make `defineProvider` accept a `disabledByDefault`? Simpler: import unconditionally (provider defined but not shown unless flag). To honor default-disabled in UI listing, add a metadata flag `enabledByDefault: false` consumed by provider catalog. If no such flag exists, register always but mark `business.deployment: 'cloud'` and rely on env flag `VITE_ENABLE_CLOUD_PROVIDERS` to skip import via dynamic import in a wrapper.

**Decision (concrete):** Use static import gated by Vite env at build time: wrap the import in `packages/stage-ui/src/libs/providers/providers/index.ts` with `if (import.meta.env.VITE_ENABLE_CLOUD_PROVIDERS === '1') { await import('./cloudflare-workers-ai') }` — but index.ts is sync. Alternative: keep static import always; provider appears in catalog. Given upstream expects it present, simplest correct: static import always, provider defined. Default-disabled is a registration-time concern in `createProviderRegistry`: filter out `cloudflare-workers-ai` unless `import.meta.env.VITE_ENABLE_CLOUD_PROVIDERS === '1'`. Add that filter in `packages/stage-ui/src/stores/providers/registry/index.ts`.

**Tests:**
- Add `packages/stage-ui/src/libs/providers/providers/cloudflare-workers-ai/index.test.ts` (or extend arks): assert defineProvider registers with id; config schema validates; createProvider returns client with correct baseUrl. Follow existing provider tests pattern (grep `ark-providers.test.ts`).
- Update `project-testing-parity`? Not needed.

### A.2 Cloudflare relay transport shim (main process)

**Goal:** pluggable adapter registered only when flag; capabilities require relay.

**Files:**
- Create `apps/stage-tamagotchi/src/main/services/airi/cloudflare/transport-adapter.ts` (new dir) exporting `createCloudflareRelayTransportAdapter(options)` that wraps `createCloudflareEdgeTransport`? But that lives in stage-ui (renderer). Main process can't import stage-ui. Instead define a main-process shim that implements `TransportAdapter` by delegating over IPC or simply a no-op default-disabled adapter. Given the cloudflare-edge transport is renderer-side (uses fetch + signing), the main-process "shim" should be a registration placeholder: an adapter whose `start/stop` are no-ops and `publish/broadcast/subscribe` throw "cloud relay disabled" unless flag; when flag set, it proxies to the renderer via IPC events. Minimal shim per restore-pluggable: just register a no-op adapter with `requiresExternalRelay: true` behind the flag so upstream code paths that call `registry.get('cloudflare-edge')` don't crash. Document that real relay lives in renderer embassy-inbox.

**Decision:** Create `apps/stage-tamagotchi/src/main/services/airi/cloudflare/transport-adapter.ts`:
```
export function createCloudflareRelayTransportAdapter(): TransportAdapter {
  const status = ref... // use let
  return { id:'cloudflare-edge', status:'disconnected', capabilities:{isLocalOnly:false,supportsMultiParty:true,supportsMeshGossip:false,requiresExternalRelay:true}, start:async()=>{status='connected'}, stop:async()=>{status='disconnected'}, sendToPeer:async()=>false, broadcast:async()=>{}, subscribe:async()=>()=>{}, initialize:async()=>{}, dispose:async()=>{}, publish:async()=>{} }
}
```
And a registration helper `registerCloudAdapters(registry, sovereign)` in `apps/stage-tamagotchi/src/main/services/airi/cloudflare/index.ts` that registers only if `process.env.AIRI_ENABLE_CLOUD_ADAPTERS === '1'` and `!sovereign`. Wire into wherever transport registry is constructed (search for `createTransportRegistry()` usage).

- Search usage: `grep -rn "createTransportRegistry" apps/`. Wire registration call next to libp2p adapter registration.

**Tests:**
- Add `apps/stage-tamagotchi/src/main/services/airi/cloudflare/transport-adapter.test.ts`: asserts id/capabilities/requiresExternalRelay; asserts not registered in sovereign mode (via registry test).

### A.3 Discord cloud relay

Already optional via `stores/modules/discord.ts` deployCloudRelay + stage-edge Worker. No transport adapter needed. Keep as-is; just document. No code change. (Out of scope for edits; note in PR.)

### A.4 Docs

- Update `docs/provider-catalog.md` (already lists it) — no change needed. Update `docs/rosetta-stone.md` only if adding new canonical entry point (registration helper). Add one line.

### A.5 Verification (Workstream A)

- `pnpm -F @proj-airi/stage-ui typecheck` (pre-existing errors unrelated; ensure no new).
- `pnpm -F @proj-airi/stage-tamagotchi typecheck`.
- `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/transport-registry.test.ts src/main/services/airi/cloudflare`.
- `pnpm -F @proj-airi/stage-ui test:run` targeted provider tests.

## Workstream B — Phase 5 Cross-WAN TDD hardening

### B.1 TransportRegistry sovereignty gate unit tests

**File:** `packages/stage-shared/src/transport-registry.test.ts` or `apps/.../transport-registry.test.ts`. Add cases:
- registering an adapter with `requiresExternalRelay:true` then `initialize(id, true)` throws/rejects.
- registering local adapter then `initialize(id, true)` resolves.
- snapshot immutability: mutate `adapter.capabilities.requiresExternalRelay` after register; gate still uses captured flag.
- missing adapter: `initialize('nope', false)` rejects.

**Owner:** stage-shared (interface) + tamagotchi (impl). Test in tamagotchi's test file (already 8 cases; add 4).

### B.2 Companion nonce race

**File:** `packages/stage-ui/src/stores/companion.ts` (mintNapChatNonce/consumeNapChatNonce, pendingNapChatNonces). Add red-green test in `companion.test.ts` (or `agentic-guard.test.ts`): duplicate accept during in-flight session is rejected (nonce consumed once). Fix liveness check. Preserve existing expiry tests.

### B.3 Pairing expiry boundary tests

**File:** `apps/stage-tamagotchi/src/main/services/airi/libp2p/pairing-trust-flow.test.ts`. Add:
- expired invite refused before dial (already).
- malformed expiry (NaN/undefined) handled (refuse or treat as expired).
- far-future cap eviction in `capDiscoveredInvites`/`pruneDiscoveredInvites`.

### B.4 Self-echo guard

**File:** pairing-trust-flow tests. Assert own publications (from === peerId) not recorded; bystander replay refused. Already partially; add explicit negative case.

### B.5 Cross-WAN round-trip assertion extraction

**Goal:** make `scripts/cross-wan-node.mjs` round-trip assertion testable from vitest. Extract gossipsub round-trip logic into `scripts/lib/cross-wan-roundtrip.ts` (or `packages/...`) and add a vitest smoke test that spins two in-process libp2p nodes over loopback and asserts a message round-trips. This does not replace CI; adds a fast local regression.

**Files:**
- Refactor `scripts/cross-wan-node.mjs` to import from new module (keep CLI entry).
- Create `apps/stage-tamagotchi/src/main/services/airi/libp2p/cross-wan-roundtrip.test.ts` (or in scripts tests) that uses real libp2p node creation helpers from pairing tests.

### B.6 Nap-chat recap consolidation (see Workstream C) — covered there.

### B.7 Memory direct tests

**Files:** `packages/stage-ui/src/stores/memory-short-term.test.ts` (new) covering budgets/rebuild; `memory-lifetime.test.ts` already exists; add incremental case. Low priority; include only if time.

### B.8 Verification (Workstream B)

- `pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/libp2p src/main/services/airi/transport-registry.test.ts`
- `pnpm -F @proj-airi/stage-ui test:run` (nap-chat + companion + agentic suites)
- `pnpm test:run` (root) for cross-project.

## Workstream C — Nap-Chat recap consolidation

### C.1 Single source of truth

**Decision:** `pendingRecap` + text journal is the single production source. `latestEpisode` becomes a read-only projection derived from the last `PendingRecap` (or removed entirely). Coordinator no longer mutates `latestEpisode` directly.

**Steps:**
1. In `nap-chat.ts`, add a computed projection `latestEpisode` derived from a stored `lastCompletedEpisode` slot? Simpler: keep `latestEpisode` ref but populate it inside `recordNapChatCompletion` by constructing a `NapEpisode` from the record + journal entry, so both code paths (coordinator preview + companion production) produce the same shape.

   Concretely: extend `recordNapChatCompletion` to also set:
   ```
   napChat.latestEpisode = {
     sessionId: record.sessionId,
     with: { characterName: record.peerCardName, alias: record.peerCardName },
     turnCount: record.turnCount,
     summary: record.recap,
     timestamp: record.endedAt,
     journalEntryId: journalEntryId ?? '',
     turns: [], // coordinator turns not available here; keep empty or pass via record
   }
   ```
   But record lacks turns. Alternative: add `turns` to `NapChatSessionRecord`? Check type. Let me check.

2. Make coordinator's `finishSession` call `napChat.recordNapChatCompletion` instead of directly setting `latestEpisode`. Coordinator has turns + summary + peerId. Build a `NapChatSessionRecord` with closeReason 'completed', recap = summary, turnCount = turns.length, startedAt/endedAt. Await recordNapChatCompletion. Then set status done and return the projected latestEpisode (or the record's sessionId).

   But coordinator is sync-ish and recordNapChatCompletion is async (journal write). Make finishSession async: `async function finishSession(summary): Promise<NapEpisode | null>`.

3. Update callers of `finishSession` (grep) to await.

4. UI: `MessagingFriends.vue` reads `latestEpisode` (now projection) — no change needed for data, but dialog priming uses `latestEpisode.value?.with?.characterName` and `latestEpisode.value?.turns`. If turns now empty in production, dialog priming loses turns. To preserve, include turns in record. Add `turns: NapTurn[]` to `NapChatSessionRecord` (optional) and pass from coordinator. Check the type definition.

Let me check NapChatSessionRecord type.<|end|><|start|>start of thinking<|message|>Let me check the NapChatSessionRecord type.<|end|><|start|>start of thinking to=grep<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="pattern">
interface NapChatSessionRecord|type NapChatSessionRecord|NapChatSessionRecord =
