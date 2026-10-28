import { describe, expect, it, vi } from 'vitest'

import { createEmbassySocket, toEmbassySocketUrl } from './embassy-socket'

class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: ((event: any) => void) | null = null
  onmessage: ((event: any) => void) | null = null
  onclose: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  sent: string[] = []
  closed = false

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
  }

  simulateOpen() {
    this.onopen?.({})
  }

  simulateMessage(data: string) {
    this.onmessage?.({ data })
  }

  simulateClose() {
    this.onclose?.({})
  }
}

function setup() {
  FakeSocket.instances = []
  const envelopes: string[] = []
  const requests: unknown[] = []
  const synced: unknown[][] = []
  const statuses: string[] = []
  const socket = createEmbassySocket({
    workerUrl: 'https://airi-stage-edge.test.workers.dev',
    ownerId: 'owner-1',
    machineId: 'studio-mac',
    events: {
      onEnvelopeText: text => envelopes.push(text),
      onRequest: request => requests.push(request),
      onSyncRequests: list => synced.push(list),
      onStatusChange: status => statuses.push(status),
    },
    socketImpl: FakeSocket as any,
    baseRetryMs: 10,
    maxRetryMs: 20,
  })
  return { socket, envelopes, requests, synced, statuses }
}

describe('embassy socket', () => {
  it('builds a wss URL with owner and machine params', () => {
    expect(toEmbassySocketUrl('https://airi-stage-edge.x.workers.dev/', 'owner-1', 'studio-mac'))
      .toBe('wss://airi-stage-edge.x.workers.dev/ws?owner=owner-1&machine=studio-mac')
  })

  it('sends sync on open and routes push events', () => {
    const { socket, envelopes, requests, synced } = setup()
    socket.connect()
    const ws = FakeSocket.instances[0]
    expect(ws.url).toContain('/ws?')
    ws.simulateOpen()
    expect(ws.sent).toEqual([JSON.stringify({ action: 'sync' })])

    ws.simulateMessage(JSON.stringify({ type: 'nap_turn', turn: { payloadJson: '{"topic":"t"}' } }))
    expect(envelopes).toEqual(['{"topic":"t"}'])

    ws.simulateMessage(JSON.stringify({ type: 'inbound_request', request: { id: 'r1' } }))
    expect(requests).toHaveLength(1)

    ws.simulateMessage(JSON.stringify({ type: 'pending_sync', requests: [{ id: 'r2' }] }))
    expect(synced).toEqual([[{ id: 'r2' }]])
    socket.disconnect()
  })

  it('reconnects after an unexpected close but not after manual disconnect', () => {
    vi.useFakeTimers()
    try {
      const { socket } = setup()
      socket.connect()
      FakeSocket.instances[0].simulateOpen()
      FakeSocket.instances[0].simulateClose()
      expect(FakeSocket.instances).toHaveLength(1)
      vi.advanceTimersByTime(50)
      expect(FakeSocket.instances).toHaveLength(2)

      socket.disconnect()
      FakeSocket.instances[1].simulateClose()
      vi.advanceTimersByTime(1000)
      expect(FakeSocket.instances).toHaveLength(2)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
