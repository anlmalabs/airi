import type { ActiveWindowEntry, SystemLoadAverages } from '@proj-airi/stage-shared'

import { describe, expect, it } from 'vitest'

import {
  checkIsPipeBusy,
  evaluateHeartbeatGating,
  formatProactiveTailEnvelope,
  formatSensorPayload,
  isNoReplySentinel,
  isUserAway,
} from './proactivity-telemetry'

describe('evaluateHeartbeatGating', () => {
  it('allows when forced', () => {
    expect(evaluateHeartbeatGating({ isForce: true })).toEqual({ allowed: true })
  })

  it('outside schedule', () => {
    const res = evaluateHeartbeatGating({
      isForce: false,
      respectSchedule: true,
      schedule: { start: '09:00', end: '17:00' },
    }, () => false)
    expect(res).toEqual({ allowed: false, reason: 'outside_schedule', detail: 'Outside operating window (09:00 - 17:00)' })
  })

  it('in schedule passes', () => {
    const res = evaluateHeartbeatGating({
      isForce: false,
      respectSchedule: true,
      schedule: { start: '09:00', end: '17:00' },
    }, () => true)
    expect(res.allowed).toBe(true)
  })

  it('skips schedule when not respected or missing', () => {
    expect(evaluateHeartbeatGating({ respectSchedule: false }).allowed).toBe(true)
    expect(evaluateHeartbeatGating({ respectSchedule: true, schedule: { start: 'a' } }).allowed).toBe(true)
  })

  it('user afk', () => {
    const res = evaluateHeartbeatGating({ pauseWhenAfk: true, afkThresholdMinutes: 5, currentIdleSec: 300 })
    expect(res).toEqual({ allowed: false, reason: 'user_afk', detail: 'User is away / AFK (5m 0s idle, limit 5m)' })
  })

  it('not afk passes', () => {
    expect(evaluateHeartbeatGating({ pauseWhenAfk: true, currentIdleSec: 10 }).allowed).toBe(true)
  })

  it('pauseWhenAfk false skips', () => {
    expect(evaluateHeartbeatGating({ pauseWhenAfk: false, currentIdleSec: 100000 }).allowed).toBe(true)
  })

  it('interval pending', () => {
    const now = 1000000
    const res = evaluateHeartbeatGating({ now, lastHeartbeatTime: now - 1000, intervalMinutes: 5 })
    expect(res.allowed).toBe(false)
    if (!res.allowed)
      expect(res.reason).toBe('interval_pending')
  })

  it('interval elapsed allows', () => {
    const now = 1000000
    const res = evaluateHeartbeatGating({ now, lastHeartbeatTime: now - 10 * 60 * 1000, intervalMinutes: 5 })
    expect(res).toEqual({ allowed: true })
  })

  it('intervalMinutes 0 defaults to 1', () => {
    const now = 1000000
    const res = evaluateHeartbeatGating({ now, lastHeartbeatTime: now - 30000, intervalMinutes: 0 })
    expect(res.allowed).toBe(false)
  })
})

describe('isUserAway', () => {
  it('away at threshold', () => {
    expect(isUserAway(60, 1)).toBe(true)
  })
  it('not away below threshold', () => {
    expect(isUserAway(30, 1)).toBe(false)
  })
  it('absent reading means present', () => {
    expect(isUserAway(undefined, 1)).toBe(false)
  })
  it('default threshold away', () => {
    expect(isUserAway(300)).toBe(true)
  })
  it('default threshold not away', () => {
    expect(isUserAway(299)).toBe(false)
  })
})

describe('checkIsPipeBusy', () => {
  it('false when empty', () => {
    expect(checkIsPipeBusy({})).toBe(false)
  })
  it('true for each flag', () => {
    expect(checkIsPipeBusy({ sending: true })).toBe(true)
    expect(checkIsPipeBusy({ activeSpokenText: 'x' })).toBe(true)
    expect(checkIsPipeBusy({ isHeartbeatEvaluating: true })).toBe(true)
    expect(checkIsPipeBusy({ isDreamStateEvaluating: true })).toBe(true)
    expect(checkIsPipeBusy({ isUserTyping: true })).toBe(true)
  })
})

describe('isNoReplySentinel', () => {
  it('matches trimmed NO_REPLY', () => {
    expect(isNoReplySentinel('  NO_REPLY  ')).toBe(true)
    expect(isNoReplySentinel('NO_REPLY')).toBe(true)
  })
  it('false otherwise', () => {
    expect(isNoReplySentinel('hello')).toBe(false)
    expect(isNoReplySentinel(null)).toBe(false)
    expect(isNoReplySentinel(undefined)).toBe(false)
    expect(isNoReplySentinel('')).toBe(false)
  })
})

describe('formatSensorPayload', () => {
  const entry = (title: string, processName = 'P', durMs = 30000): ActiveWindowEntry => ({
    window: { title, processName },
    startTime: Date.now(),
    endTime: Date.now() + durMs,
    durationMs: durMs,
  })

  it('basic unknown', () => {
    const out = formatSensorPayload({})
    expect(out).toContain('User Idle: unknown')
    expect(out).toContain('Volume Level: unknown')
    expect(out).toContain('Current Local Time: unknown')
    expect(out).toContain('Active Character Default Background: none')
  })

  it('idle sec', () => {
    expect(formatSensorPayload({ idleTimeSec: 5 })).toContain('User Idle: 5s')
  })

  it('window history disabled', () => {
    expect(formatSensorPayload({ contextOptions: { windowHistory: false } })).toContain('Window History: [DISABLED]')
  })

  it('window history with entries', () => {
    const out = formatSensorPayload({ winHistory: [entry('A'), entry('B')] })
    expect(out).toContain('Active Program: P')
    expect(out).toContain('Active Window Title: B')
    expect(out).toContain('Previous History')
  })

  it('previous history unknown process name', () => {
    const out = formatSensorPayload({ winHistory: [entry('A', 'Unknown', 30000), entry('B', 'P', 30000)] })
    expect(out).toContain('Previous History')
  })

  it('system load disabled / present', () => {
    expect(formatSensorPayload({ contextOptions: { systemLoad: false } })).toContain('System Load: [DISABLED]')
    const sysLoad: SystemLoadAverages = { cpu: [1, 2, 3], gpuAvg: 0.5 }
    const out = formatSensorPayload({ sysLoad })
    expect(out).toContain('CPU Load (1/5/15): 1.00 | 2.00 | 3.00')
    expect(out).toContain('GPU Load (Avg): 0.50')
  })

  it('usage metrics disabled / present', () => {
    expect(formatSensorPayload({ contextOptions: { usageMetrics: false } })).toContain('[Metrics]: [DISABLED]')
    const out = formatSensorPayload({ metrics: { turnCount: 5, nextMilestone: 10, recentTtsCount: 1, recentSttCount: 2, recentChatCount: 3, recentJournalEntryCount: 4 } })
    expect(out).toContain('Turn Count: 5 (Next Target: 10)')
    expect(out).toContain('TTS (Last Hr): 1')
  })

  it('volLevel and locTime and bg name', () => {
    const out = formatSensorPayload({ volLevel: 42, locTime: 'now', resolvedDefaultBackgroundName: 'bg' })
    expect(out).toContain('Volume Level: 42%')
    expect(out).toContain('Current Local Time: now')
    expect(out).toContain('Active Character Default Background: bg')
  })

  it('no win history', () => {
    const out = formatSensorPayload({ winHistory: [] })
    expect(out).toContain('[Sensor Data]')
  })

  it('processName Unknown not printed as active program', () => {
    const out = formatSensorPayload({ winHistory: [entry('T', 'Unknown')] })
    expect(out).not.toContain('Active Program:')
    expect(out).toContain('Active Window Title: T')
  })

  it('duration formatting', () => {
    const out = formatSensorPayload({ winHistory: [entry('A', 'P', 30000), entry('B', 'P', 90000)] })
    expect(out).toMatch(/\d+s|\dm/)
  })
})

describe('formatProactiveTailEnvelope', () => {
  it('with all inputs', () => {
    const out = formatProactiveTailEnvelope({ sensorPayloadRaw: 's', recentLedgerEvents: 'e', promptText: 'p' })
    expect(out).toContain('[ENVIRONMENTAL AWARENESS]')
    expect(out).toContain('[UNIFIED EVENT STREAM]')
    expect(out).toContain('[FOCUS DIRECTIVE]\np')
  })
  it('defaults promptText', () => {
    const out = formatProactiveTailEnvelope({})
    expect(out).toContain('Review situational context.')
  })
  it('trims', () => {
    const out = formatProactiveTailEnvelope({})
    expect(out).toBe(out.trim())
  })
})
