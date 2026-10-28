export type EmbassySocketStatus = 'disconnected' | 'connecting' | 'connected' | 'retrying'

export interface EmbassySocketRequest {
  id: string
  fromHandle: string
  fromPubkey: string
  fromCharacterName: string
  introMessage?: string
  fromTagline?: string
  timestamp?: number
  nonce?: string
}

export interface EmbassySocketEvents {
  onEnvelopeText: (rawText: string) => void
  onRequest: (request: EmbassySocketRequest) => void
  onSyncRequests?: (requests: EmbassySocketRequest[]) => void
  onStatusChange?: (status: EmbassySocketStatus) => void
}

export interface EmbassySocketOptions {
  workerUrl: string
  ownerId: string
  machineId: string
  events: EmbassySocketEvents
  socketImpl?: typeof WebSocket
  baseRetryMs?: number
  maxRetryMs?: number
}

export function toEmbassySocketUrl(workerUrl: string, ownerId: string, machineId: string): string {
  const base = workerUrl.replace(/\/$/, '').replace(/^http/, 'ws')
  const params = new URLSearchParams({ owner: ownerId, machine: machineId })
  return `${base}/ws?${params.toString()}`
}

export function createEmbassySocket(options: EmbassySocketOptions) {
  const SocketImpl = options.socketImpl ?? WebSocket
  const baseRetryMs = options.baseRetryMs ?? 2000
  const maxRetryMs = options.maxRetryMs ?? 30000
  let socket: WebSocket | null = null
  let manualClose = false
  let retryAttempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let status: EmbassySocketStatus = 'disconnected'

  function setStatus(next: EmbassySocketStatus) {
    status = next
    try {
      options.events.onStatusChange?.(next)
    }
    catch {
      // NOTICE: status observers must never break the reconnect loop.
    }
  }

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function routeMessage(raw: string) {
    let parsed: any = null
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      return
    }
    if (!parsed || typeof parsed.type !== 'string')
      return
    if (parsed.type === 'nap_turn' && parsed.turn && typeof parsed.turn.payloadJson === 'string') {
      try {
        options.events.onEnvelopeText(parsed.turn.payloadJson)
      }
      catch {}
    }
    else if (parsed.type === 'inbound_request' && parsed.request) {
      try {
        options.events.onRequest(parsed.request)
      }
      catch {}
    }
    else if (parsed.type === 'pending_sync' && Array.isArray(parsed.requests)) {
      try {
        if (options.events.onSyncRequests) {
          options.events.onSyncRequests(parsed.requests)
        }
        else {
          for (const request of parsed.requests) options.events.onRequest(request)
        }
      }
      catch {}
    }
  }

  function scheduleReconnect() {
    if (manualClose)
      return
    setStatus('retrying')
    const delay = Math.min(baseRetryMs * 2 ** retryAttempt, maxRetryMs)
    retryAttempt += 1
    clearRetry()
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, delay)
  }

  function connect() {
    clearRetry()
    if (manualClose)
      return
    setStatus('connecting')
    const ws = new SocketImpl(toEmbassySocketUrl(options.workerUrl, options.ownerId, options.machineId))
    socket = ws as unknown as WebSocket
    ws.onopen = () => {
      retryAttempt = 0
      setStatus('connected')
      try {
        ws.send(JSON.stringify({ action: 'sync' }))
      }
      catch {}
    }
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string')
        routeMessage(event.data)
    }
    ws.onclose = () => {
      socket = null
      scheduleReconnect()
    }
    ws.onerror = () => {
      try {
        ws.close()
      }
      catch {}
    }
  }

  function disconnect() {
    manualClose = true
    clearRetry()
    try {
      socket?.close()
    }
    catch {}
    socket = null
    setStatus('disconnected')
  }

  function sendSync() {
    try {
      (socket as unknown as { send?: (data: string) => void } | null)?.send?.(JSON.stringify({ action: 'sync' }))
      return true
    }
    catch {
      return false
    }
  }

  return {
    get status() { return status },
    connect,
    disconnect,
    sendSync,
  }
}
