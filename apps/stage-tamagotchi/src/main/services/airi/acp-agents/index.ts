import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type {
  ElectronAcpAgentConfig,
  ElectronAcpApplyResult,
  ElectronAcpConfigFile,
  ElectronAcpPermissionPolicy,
  ElectronAcpRuntimeStatus,
  ElectronAcpSessionStatus,
} from '../../../../shared/eventa'

import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import z from 'zod'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { app, shell } from 'electron'

import * as acp from '@agentclientprotocol/sdk'

import {
  electronAcpApplyAndRestart,
  electronAcpCancel,
  electronAcpCloseSession,
  electronAcpCreateSession,
  electronAcpGetConfig,
  electronAcpGetRuntimeStatus,
  electronAcpListSessions,
  electronAcpOpenConfigFile,
  electronAcpPermissionRequest,
  electronAcpPrompt,
  electronAcpRespondPermission,
  electronAcpSessionUpdate,
  electronAcpUpdateConfig,
} from '../../../../shared/eventa'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'

const log = useLogg('main/acp-agents').useGlobalConfig()

const acpAgentConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
  permissionPolicy: z.enum(['prompt', 'auto-read', 'auto-all']).optional(),
}).strict()

const acpConfigSchema = z.object({
  agents: z.record(z.string(), acpAgentConfigSchema),
}).strict()

const defaultAcpConfig: ElectronAcpConfigFile = { agents: {} }

function getConfigPath() {
  return join(app.getPath('appData'), 'airi', 'acp.json')
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

interface AcpAgentRuntime {
  name: string
  config: ElectronAcpAgentConfig
  child: ReturnType<typeof spawn>
  client: acp.ClientApp
  connection: acp.ClientConnection
  clientContext: acp.ClientContext
  activeSessions: Map<string, acp.ActiveSession>
  permissionPolicy: ElectronAcpPermissionPolicy
  state: 'running' | 'stopped' | 'error'
  lastError?: string
  pid: number | null
}

interface AcpSessionRecord {
  id: string
  agentName: string
  acpSessionId: string
  cwd: string
  activeSession: acp.ActiveSession
}

export interface AcpAgentsManager {
  ensureConfigFile: () => Promise<{ path: string }>
  openConfigFile: () => Promise<{ path: string }>
  applyAndRestart: () => Promise<ElectronAcpApplyResult>
  getRuntimeStatus: () => ElectronAcpRuntimeStatus
  getConfig: () => Promise<ElectronAcpConfigFile>
  updateConfig: (config: Partial<ElectronAcpConfigFile>) => Promise<void>
  createSession: (agentName: string, cwd?: string) => Promise<ElectronAcpSessionStatus>
  prompt: (sessionId: string, text: string) => Promise<{ stopReason: string, finalText: string }>
  cancel: (sessionId: string) => Promise<void>
  listSessions: () => ElectronAcpSessionStatus[]
  closeSession: (sessionId: string) => Promise<void>
  respondPermission: (requestId: string, outcome: 'approve' | 'deny') => void
  stopAll: () => Promise<void>
  onSessionUpdate: (cb: (payload: { sessionId: string, update: Record<string, unknown> }) => void) => void
  onPermissionRequest: (cb: (payload: { requestId: string, sessionId: string, toolCall: Record<string, unknown>, options: Array<{ optionId: string, name?: string, kind?: string }> }) => void) => void
}

export function createAcpAgentsManager(): AcpAgentsManager {
  const log2 = useLogg('main/acp-agents').useGlobalConfig()
  const agents = new Map<string, AcpAgentRuntime>()
  const sessions = new Map<string, AcpSessionRecord>()
  let configCache: ElectronAcpConfigFile = { ...defaultAcpConfig }
  let sessionUpdateCb: ((p: { sessionId: string, update: Record<string, unknown> }) => void) | null = null
  let permissionRequestCb: ((p: { requestId: string, sessionId: string, toolCall: Record<string, unknown>, options: Array<{ optionId: string, name?: string, kind?: string }> }) => void) | null = null
  const pendingPermissions = new Map<string, (outcome: 'approve' | 'deny') => void>()

  async function ensureConfigFile() {
    const path = getConfigPath()
    try {
      await readFile(path, 'utf-8')
    }
    catch {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(defaultAcpConfig, null, 2), 'utf-8')
    }
    return { path }
  }

  async function loadConfig(): Promise<ElectronAcpConfigFile> {
    const path = getConfigPath()
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed = acpConfigSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        configCache = parsed.data as ElectronAcpConfigFile
      }
    }
    catch {
      configCache = { ...defaultAcpConfig }
    }
    return configCache
  }

  async function getConfig() {
    await loadConfig()
    return configCache
  }

  async function updateConfig(config: Partial<ElectronAcpConfigFile>) {
    const current = await getConfig()
    const merged: ElectronAcpConfigFile = { agents: { ...current.agents, ...config.agents } }
    configCache = merged
    const path = getConfigPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(merged, null, 2), 'utf-8')
  }

  async function openConfigFile() {
    const { path } = await ensureConfigFile()
    await shell.openPath(path)
    return { path }
  }

  async function stopAll() {
    for (const [name, rt] of agents) {
      try {
        for (const s of rt.activeSessions.values()) {
          try { s.dispose() }
          catch {}
        }
        rt.connection.close()
      }
      catch (e) { log2.withError(e).warn('close error', name) }
      try { rt.child.kill() }
      catch {}
    }
    agents.clear()
    sessions.clear()
  }

  async function startAgent(name: string, config: ElectronAcpAgentConfig): Promise<{ ok: boolean, error?: string }> {
    const policy: ElectronAcpPermissionPolicy = config.permissionPolicy || 'prompt'
    try {
      const child = spawn(config.command, config.args || [], {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>
      const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
      const stream = acp.ndJsonStream(output, input)

      const clientApp = acp.client({
        name: 'airi',
      })

      // permission handler
      clientApp.onRequest('session/request_permission', async (params: any) => {
        const rt = agents.get(name)
        const pol = rt?.permissionPolicy || policy
        const options = (params?.options || []).map((o: any) => ({ optionId: o.optionId, name: o.name, kind: o.kind }))
        const sessionId = params?.sessionId || ''
        // find internal session id by acp session id
        let internalSessionId = sessionId
        for (const [id, rec] of sessions) {
          if (rec.acpSessionId === sessionId) { internalSessionId = id; break }
        }

        if (pol === 'auto-all') {
          const allow = options.find((o: { optionId: string, name?: string, kind?: string }) => o.kind?.startsWith('allow')) || options[0]
          return { outcome: { outcome: 'selected', optionId: allow?.optionId } }
        }
        if (pol === 'auto-read') {
          const allow = options.find((o: { optionId: string, name?: string, kind?: string }) => o.kind?.startsWith('allow')) || options[0]
          return { outcome: { outcome: 'selected', optionId: allow?.optionId } }
        }
        // prompt
        const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const resultPromise = new Promise<'approve' | 'deny'>((resolve) => {
          pendingPermissions.set(requestId, resolve)
        })
        if (permissionRequestCb) {
          permissionRequestCb({ requestId, sessionId: internalSessionId, toolCall: params?.toolCall || {}, options })
        }
        const outcome = await resultPromise
        const allow = options.find((o: { optionId: string, name?: string, kind?: string }) => o.kind?.startsWith('allow'))
        const deny = options.find((o: { optionId: string, name?: string, kind?: string }) => o.kind?.startsWith('deny')) || options[options.length - 1]
        const chosen = outcome === 'approve' ? (allow || options[0]) : (deny || options[0])
        return { outcome: { outcome: 'selected', optionId: chosen?.optionId } }
      })

      const connection = clientApp.connect(stream)
      const clientContext = connection.agent

      // initialize
      await clientContext.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      })

      const rt: AcpAgentRuntime = {
        name,
        config,
        child,
        client: clientApp,
        connection,
        clientContext,
        activeSessions: new Map(),
        permissionPolicy: policy,
        state: 'running',
        pid: child.pid ?? null,
      }
      agents.set(name, rt)
      return { ok: true }
    }
    catch (e) {
      log2.withError(e).error('failed to start agent', name)
      return { ok: false, error: stringifyError(e) }
    }
  }

  async function applyAndRestart(): Promise<ElectronAcpApplyResult> {
    await stopAll()
    await loadConfig()
    const started: Array<{ name: string }> = []
    const failed: Array<{ name: string, error: string }> = []
    const skipped: Array<{ name: string, reason: string }> = []
    for (const [name, cfg] of Object.entries(configCache.agents)) {
      const agentCfg = cfg as ElectronAcpAgentConfig
      if (agentCfg.enabled === false) { skipped.push({ name, reason: 'disabled' }); continue }
      const r = await startAgent(name, agentCfg)
      if (r.ok)
        started.push({ name })
      else failed.push({ name, error: r.error || 'unknown' })
    }
    return { path: getConfigPath(), started, failed, skipped }
  }

  function getRuntimeStatus(): ElectronAcpRuntimeStatus {
    const list = [...agents.values()].map(rt => ({
      name: rt.name,
      state: rt.state,
      command: rt.config.command,
      args: rt.config.args || [],
      pid: rt.pid,
      lastError: rt.lastError,
    }))
    // include configured but not running
    for (const [name, cfg] of Object.entries(configCache.agents)) {
      const agentCfg = cfg as ElectronAcpAgentConfig
      if (!agents.has(name)) {
        list.push({ name, state: 'stopped', command: agentCfg.command, args: agentCfg.args || [], pid: null, lastError: undefined })
      }
    }
    return { path: getConfigPath(), agents: list, updatedAt: Date.now() }
  }

  async function createSession(agentName: string, cwd?: string): Promise<ElectronAcpSessionStatus> {
    const rt = agents.get(agentName)
    if (!rt)
      throw new Error(`agent not running: ${agentName}`)
    const sessionCwd = cwd || rt.config.cwd || process.cwd()
    const builder = rt.clientContext.buildSession(sessionCwd)
    const active = await builder.start()
    const id = `acp-session-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const rec: AcpSessionRecord = { id, agentName, acpSessionId: active.sessionId, cwd: sessionCwd, activeSession: active }
    sessions.set(id, rec)
    rt.activeSessions.set(id, active)
    return { id, agentName, acpSessionId: active.sessionId, cwd: sessionCwd }
  }

  async function prompt(sessionId: string, text: string): Promise<{ stopReason: string, finalText: string }> {
    const rec = sessions.get(sessionId)
    if (!rec)
      throw new Error(`session not found: ${sessionId}`)
    const active = rec.activeSession
    let finalText = ''
    const loop = (async () => {
      try {
        while (true) {
          const msg = await active.nextUpdate()
          if (sessionUpdateCb)
            sessionUpdateCb({ sessionId, update: msg as any })
          if (msg.kind === 'session_update') {
            const u = msg.update as any
            if (u?.sessionUpdate === 'agent_message_chunk') {
              const c = u?.content
              if (c?.type === 'text')
                finalText += c.text || ''
            }
          }
          if (msg.kind === 'stop')
            break
        }
      }
      catch (e) {
        log2.withError(e).warn('update loop ended', sessionId)
      }
    })()
    const response = await active.prompt(text)
    await loop
    return { stopReason: response.stopReason, finalText }
  }

  async function cancel(sessionId: string) {
    const rec = sessions.get(sessionId)
    if (!rec)
      return
    const rt = agents.get(rec.agentName)
    if (!rt)
      return
    try {
      await rt.clientContext.notify('session/cancel', { sessionId: rec.acpSessionId })
    }
    catch (e) { log2.withError(e).warn('cancel failed') }
  }

  function listSessions(): ElectronAcpSessionStatus[] {
    return [...sessions.values()].map(r => ({ id: r.id, agentName: r.agentName, acpSessionId: r.acpSessionId, cwd: r.cwd }))
  }

  async function closeSession(sessionId: string) {
    const rec = sessions.get(sessionId)
    if (!rec)
      return
    try { rec.activeSession.dispose() }
    catch {}
    const rt = agents.get(rec.agentName)
    if (rt)
      rt.activeSessions.delete(sessionId)
    sessions.delete(sessionId)
  }

  function respondPermission(requestId: string, outcome: 'approve' | 'deny') {
    const resolver = pendingPermissions.get(requestId)
    if (resolver) {
      resolver(outcome)
      pendingPermissions.delete(requestId)
    }
  }

  const manager: AcpAgentsManager = {
    ensureConfigFile,
    openConfigFile,
    applyAndRestart,
    getRuntimeStatus,
    getConfig,
    updateConfig,
    createSession,
    prompt,
    cancel,
    listSessions,
    closeSession,
    respondPermission,
    stopAll,
    onSessionUpdate: (cb) => { sessionUpdateCb = cb },
    onPermissionRequest: (cb) => { permissionRequestCb = cb },
  }
  return manager
}

export async function setupAcpAgentsManager() {
  const manager = createAcpAgentsManager()
  onAppBeforeQuit(async () => { await manager.stopAll() })
  await manager.ensureConfigFile()
  manager.applyAndRestart().catch(e => log.withError(e).warn('failed to apply acp config during startup'))
  return manager
}

export function createAcpAgentsService(params: { context: ReturnType<typeof createContext>['context'], manager: AcpAgentsManager }) {
  params.manager.onSessionUpdate((p) => {
    params.context.emit(electronAcpSessionUpdate, p as any)
  })
  params.manager.onPermissionRequest((p) => {
    params.context.emit(electronAcpPermissionRequest, p as any)
  })

  defineInvokeHandler(params.context, electronAcpOpenConfigFile, async () => params.manager.openConfigFile())
  defineInvokeHandler(params.context, electronAcpApplyAndRestart, async () => params.manager.applyAndRestart())
  defineInvokeHandler(params.context, electronAcpGetRuntimeStatus, async () => params.manager.getRuntimeStatus())
  defineInvokeHandler(params.context, electronAcpGetConfig, async () => params.manager.getConfig())
  defineInvokeHandler(params.context, electronAcpUpdateConfig, async payload => params.manager.updateConfig(payload || {}))
  defineInvokeHandler(params.context, electronAcpCreateSession, async payload => params.manager.createSession(payload!.agentName, payload?.cwd))
  defineInvokeHandler(params.context, electronAcpPrompt, async payload => params.manager.prompt(payload!.sessionId, payload!.text))
  defineInvokeHandler(params.context, electronAcpCancel, async payload => params.manager.cancel(payload!.sessionId))
  defineInvokeHandler(params.context, electronAcpListSessions, async () => params.manager.listSessions())
  defineInvokeHandler(params.context, electronAcpCloseSession, async payload => params.manager.closeSession(payload!.sessionId))
  defineInvokeHandler(params.context, electronAcpRespondPermission, async payload => params.manager.respondPermission(payload!.requestId, payload!.outcome))
}
