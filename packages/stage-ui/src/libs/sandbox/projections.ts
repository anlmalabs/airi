import type {
  SandboxVfsCognitionProjection,
  SandboxVfsLive2dProjection,
  SandboxVfsMessageItem,
  SandboxVfsSessionProjection,
  SandboxVfsTelemetryProjection,
} from './types'

import { deriveMood } from '@proj-airi/nan0-runtime'
import { useDslSnapshotStore, useLive2d } from '@proj-airi/stage-ui-live2d/stores'

import { useChatSessionStore } from '../../stores/chat/session-store'
import { useAiriCardStore } from '../../stores/modules/airi-card'
import { useConsciousnessStore } from '../../stores/modules/consciousness'
import { useNan0Store } from '../../stores/modules/nan0'
import { useProactivityStore } from '../../stores/proactivity'

export function buildSessionProjection(): SandboxVfsSessionProjection {
  try {
    const sessionStore = useChatSessionStore()
    const cardStore = useAiriCardStore()
    const activeSessionId = sessionStore.activeSessionId || ''
    const meta = activeSessionId ? sessionStore.getSessionMeta(activeSessionId) : null
    const messages = activeSessionId ? sessionStore.getSessionMessages(activeSessionId) : []

    let lastMessageAt: string | null = null
    let hoursSinceLastMessage: number | null = null

    if (messages && messages.length > 0) {
      const lastMsg = messages[messages.length - 1] as any
      if (lastMsg?.createdAt) {
        lastMessageAt = new Date(lastMsg.createdAt).toISOString()
        const diffMs = Date.now() - new Date(lastMsg.createdAt).getTime()
        hoursSinceLastMessage = Math.max(0, Number((diffMs / 3600000).toFixed(2)))
      }
    }

    return {
      activeSessionId,
      characterName: cardStore.activeCard?.name || 'Airi',
      messageCount: messages ? messages.length : 0,
      lastMessageAt,
      hoursSinceLastMessage,
      createdAt: meta?.createdAt ? new Date(meta.createdAt).toISOString() : null,
    }
  }
  catch (err) {
    console.warn('[Sandbox] Error building session projection:', err)
    return {
      activeSessionId: '',
      characterName: 'Airi',
      messageCount: 0,
      lastMessageAt: null,
      hoursSinceLastMessage: null,
      createdAt: null,
    }
  }
}

export function buildCognitionProjection(): SandboxVfsCognitionProjection {
  try {
    const cardStore = useAiriCardStore()
    const consciousnessStore = useConsciousnessStore()
    const nan0Store = useNan0Store()

    const activeCard = cardStore.activeCard
    const airiExt = activeCard?.extensions?.airi as any
    const cognitionModule = airiExt?.modules?.cognition ?? airiExt?.cognition
    const processor = cognitionModule?.processor ?? cognitionModule?.firstHopProcessor ?? airiExt?.firstHopProcessor
    const isNan0Enabled = cognitionModule?.enabled ?? (processor === 'local_nan0' || processor === 'nan0')

    const actingExt = airiExt?.acting
    let acting: SandboxVfsCognitionProjection['character']['acting']
    if (actingExt) {
      const modelExpressionPrompt = actingExt.modelExpressionPrompt?.trim() || undefined
      const speechExpressionPrompt = actingExt.speechExpressionPrompt?.trim() || undefined
      const speechMannerismPrompt = actingExt.speechMannerismPrompt?.trim() || undefined
      const stickerDirectivesPrompt = actingExt.stickerDirectivesPrompt?.trim() || undefined

      if (modelExpressionPrompt || speechExpressionPrompt || speechMannerismPrompt || stickerDirectivesPrompt) {
        acting = {
          modelExpressionPrompt,
          speechExpressionPrompt,
          speechMannerismPrompt,
          stickerDirectivesPrompt,
        }
      }
    }

    const character: SandboxVfsCognitionProjection['character'] = {
      name: activeCard?.name || 'Airi',
      description: activeCard?.description || '',
    }
    if (activeCard?.nickname)
      character.nickname = activeCard.nickname
    if (activeCard?.personality)
      character.personality = activeCard.personality
    if (activeCard?.scenario)
      character.scenario = activeCard.scenario
    if (activeCard?.systemPrompt)
      character.systemPrompt = activeCard.systemPrompt
    if (acting)
      character.acting = acting

    const base: SandboxVfsCognitionProjection = {
      character,
      consciousness: {
        activeProvider: consciousnessStore.activeProvider || '',
        activeModel: consciousnessStore.activeModel || '',
      },
    }

    if (isNan0Enabled) {
      const mood = deriveMood(nan0Store.emotions)
      return {
        ...base,
        emotion: mood.primary,
        valence: Number(mood.valence.toFixed(2)),
        energy: Number(mood.arousal.toFixed(2)),
        somaticState: nan0Store.demandsSilence ? 'silence-demanded' : 'engaged',
        nan0: {
          enabled: true,
          emotions: { ...nan0Store.emotions },
          lastReflex: nan0Store.lastReflex ? { ...nan0Store.lastReflex } : null,
          decision: nan0Store.decision,
          decisionReason: nan0Store.decisionReason,
          demandsSilence: nan0Store.demandsSilence,
          isPouting: nan0Store.isPouting,
          innerMonologue: nan0Store.innerMonologue,
          moodProfile: {
            primary: mood.primary,
            secondary: mood.secondary,
            valence: Number(mood.valence.toFixed(2)),
            arousal: Number(mood.arousal.toFixed(2)),
          },
        },
      }
    }

    return base
  }
  catch (err) {
    console.warn('[Sandbox] Error building cognition projection:', err)
    return {
      character: { name: 'Airi' },
      consciousness: { activeProvider: '', activeModel: '' },
    }
  }
}

export function buildTelemetryProjection(): SandboxVfsTelemetryProjection {
  try {
    const proactivity = useProactivityStore()
    const payload = proactivity.sensorPayload as any

    return {
      idleTimeSec: payload?.idleTimeSec ?? proactivity.idleTimeSec ?? 0,
      activeProgram: payload?.activeProgram ?? (proactivity.activeWinStr ? proactivity.activeWinStr.split(' - ')[0] : 'Unknown'),
      activeWindowTitle: payload?.activeWindowTitle ?? proactivity.activeWinStr ?? '',
      windowHistory: Array.isArray(proactivity.winHistory)
        ? proactivity.winHistory.slice(-6).map((item: any) => ({
            processName: item.window?.processName || 'Unknown',
            title: item.window?.title || '',
            durationMs: item.durationMs || 0,
          }))
        : [],
      cpuLoad: payload?.cpuLoad ?? proactivity.sysLoad?.cpu ?? [0, 0, 0],
      gpuAvg: payload?.gpuAvg ?? proactivity.sysLoad?.gpuAvg ?? 0,
      volumeLevel: payload?.volumeLevel ?? proactivity.volLevel ?? 100,
      localTime: payload?.localTime ?? proactivity.locTime ?? new Date().toLocaleTimeString(),
      usageMetrics: {
        ttsHourly: payload?.usageMetrics?.ttsHourly ?? 0,
        sttHourly: payload?.usageMetrics?.sttHourly ?? 0,
        chatHourly: payload?.usageMetrics?.chatHourly ?? 0,
        journalHourly: payload?.usageMetrics?.journalHourly ?? 0,
        turnCount: payload?.usageMetrics?.turnCount ?? 0,
      },
    }
  }
  catch (err) {
    console.warn('[Sandbox] Error building telemetry projection:', err)
    return {
      idleTimeSec: 0,
      activeProgram: 'Unknown',
      activeWindowTitle: '',
      windowHistory: [],
      cpuLoad: [0, 0, 0],
      gpuAvg: 0,
      volumeLevel: 100,
      localTime: new Date().toLocaleTimeString(),
      usageMetrics: {
        ttsHourly: 0,
        sttHourly: 0,
        chatHourly: 0,
        journalHourly: 0,
        turnCount: 0,
      },
    }
  }
}

export function buildLive2dProjection(): SandboxVfsLive2dProjection {
  try {
    const live2d = useLive2d()
    const cardStore = useAiriCardStore()
    const snapshotStore = useDslSnapshotStore()
    const modelId = (cardStore.activeCard as any)?.extensions?.airi?.modules?.displayModelId ?? ''
    const dslVM = live2d.dslVM as any
    const live = !!dslVM && typeof dslVM.isHitAreaEnabled === 'function'
    const snapshot = snapshotStore.get(modelId)
    const raw = live2d.rawSettings as any
    const manifestHitAreas = raw?.HitAreas ?? raw?.hitAreas
    const liveNames: string[] = Array.isArray(manifestHitAreas)
      ? manifestHitAreas.map((h: any) => h?.Name ?? h?.name).filter((n: any) => typeof n === 'string' && n)
      : []
    const groups = (live2d.dslGroups ?? []) as any[]

    const hitAreas = (liveNames.length > 0
      ? manifestHitAreas
          .filter((h: any) => typeof (h?.Name ?? h?.name) === 'string' && (h?.Name ?? h?.name))
          .map((h: any) => ({ name: (h.Name ?? h.name) as string, id: h.Id ?? h.id, motion: h.Motion ?? h.motion }))
      : (snapshot?.hitAreas ?? []).map((h: any) => ({ ...h })))
    const names = hitAreas.map((h: any) => h.name as string)
    const snapshotGates = new Set(snapshot?.enabledHitAreas ?? [])
    const enabledHitAreas = live
      ? names.filter((name: string) => dslVM.isHitAreaEnabled(name))
      : names.filter((name: string) => snapshot ? snapshotGates.has(name) : true)
    const reactions = groups.length > 0
      ? groups.flatMap(g => ((g?.entries ?? []) as any[])
          .filter((e: any) => e?.Sound)
          .map((e: any) => ({ group: g.name, text: e.Text ? String(e.Text) : undefined, sound: e.Sound as string })))
      : (snapshot?.reactions ?? []).map((r: any) => ({ ...r }))

    const localMotion = live2d.currentMotion ? { ...live2d.currentMotion } : null
    return {
      modelId,
      hasModel: !!live2d.model || !!snapshot,
      live,
      activeMotion: live ? (localMotion ?? snapshot?.activeMotion ?? null) : (snapshot?.activeMotion ?? localMotion),
      lastText: live2d.activeMotionText?.text ?? snapshot?.lastText ?? null,
      lastDispatch: snapshot?.lastDispatch ? { ...snapshot.lastDispatch } : null,
      enabledHitAreas,
      hitAreas,
      hitAreasCount: hitAreas.length,
      reactions,
      reactionsCount: reactions.length,
      hasDsl: groups.length > 0 || names.length > 0,
      varFloats: live ? (dslVM.vars?.snapshot?.() ?? {}) : (snapshot?.varFloats ?? {}),
      updatedAt: Date.now(),
    }
  }
  catch (err) {
    console.warn('[Sandbox] Error building Live2D projection:', err)
    return {
      modelId: '',
      hasModel: false,
      live: false,
      activeMotion: null,
      lastText: null,
      lastDispatch: null,
      enabledHitAreas: [],
      hitAreas: [],
      hitAreasCount: 0,
      reactions: [],
      reactionsCount: 0,
      hasDsl: false,
      varFloats: {},
      updatedAt: Date.now(),
    }
  }
}

export function buildMessagesProjection(): SandboxVfsMessageItem[] {
  try {
    const sessionStore = useChatSessionStore()
    const activeSessionId = sessionStore.activeSessionId
    if (!activeSessionId)
      return []

    const messages = sessionStore.getSessionMessages(activeSessionId) || []
    if (messages.length === 0)
      return []

    let projectedMessages = messages
    if (messages.length > 20) {
      const rootSystem = messages[0]?.role === 'system' ? [messages[0]] : []
      const recent = messages.slice(-(20 - rootSystem.length))
      projectedMessages = [...rootSystem, ...recent]
    }

    return projectedMessages.map((m: any) => ({
      id: m.id || '',
      role: m.role || 'user',
      createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : undefined,
      content: (typeof m.rawContent === 'string' && m.rawContent)
        ? m.rawContent
        : (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
    }))
  }
  catch (err) {
    console.warn('[Sandbox] Error building messages projection:', err)
    return []
  }
}
