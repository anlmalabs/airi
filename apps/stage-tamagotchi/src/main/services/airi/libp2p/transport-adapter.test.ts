import type { TransportAdapter, TransportHandler } from '@proj-airi/stage-shared/transport'

import { describe, expect, it, vi } from 'vitest'

import { createLibp2pTransportAdapter } from './transport-adapter'

describe('createLibp2pTransportAdapter', () => {
  it('delegates start/stop/broadcast/subscribe to deps', async () => {
    const initialize = vi.fn(async () => {})
    const dispose = vi.fn(async () => {})
    const publish = vi.fn(async (_t: string, _d: Uint8Array) => {})
    const subscribe = vi.fn((_t: string, _h: (d: Uint8Array) => void) => () => {})
    const adapter = createLibp2pTransportAdapter({
      deps: { initialize, dispose, publish, subscribe },
    })

    expect(adapter.id).toBe('libp2p-mesh')

    await adapter.start()
    expect(initialize).toHaveBeenCalledOnce()

    const payload = new Uint8Array([1, 2, 3])
    await adapter.broadcast('airi/test', payload)
    expect(publish).toHaveBeenCalledWith('airi/test', payload)

    const handler: TransportHandler<unknown> = () => {}
    const unsub = await adapter.subscribe('airi/test', handler)
    expect(typeof unsub).toBe('function')

    await adapter.stop()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('defaults to local-only mesh capabilities', () => {
    const adapter = createLibp2pTransportAdapter({
      deps: {
        initialize: async () => {},
        dispose: async () => {},
        publish: async () => {},
        subscribe: () => () => {},
      },
    })
    expect(adapter.capabilities?.isLocalOnly).toBe(true)
    expect(adapter.capabilities?.requiresExternalRelay).toBe(false)
  })

  it('allows capability overrides', () => {
    const adapter = createLibp2pTransportAdapter({
      deps: {
        initialize: async () => {},
        dispose: async () => {},
        publish: async () => {},
        subscribe: () => () => {},
      },
      capabilities: { requiresExternalRelay: true },
    })
    expect(adapter.capabilities?.requiresExternalRelay).toBe(true)
    expect(adapter.capabilities?.isLocalOnly).toBe(true)
  })

  it('satisfies the TransportAdapter contract', () => {
    const adapter: TransportAdapter = createLibp2pTransportAdapter({
      deps: {
        initialize: async () => {},
        dispose: async () => {},
        publish: async () => {},
        subscribe: () => () => {},
      },
    })
    expect(adapter).toBeDefined()
  })
})
