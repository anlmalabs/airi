import type {
  TransportAdapter,
  TransportCapabilities,
} from './transport-adapter'

import { describe, expectTypeOf, it } from 'vitest'

describe('transportCapabilities', () => {
  it('exposes the four capability flags from the RFC', () => {
    expectTypeOf<TransportCapabilities>().toHaveProperty('isLocalOnly')
    expectTypeOf<TransportCapabilities>().toHaveProperty('supportsMultiParty')
    expectTypeOf<TransportCapabilities>().toHaveProperty('supportsMeshGossip')
    expectTypeOf<TransportCapabilities>().toHaveProperty('requiresExternalRelay')

    expectTypeOf<TransportCapabilities['isLocalOnly']>().toEqualTypeOf<boolean>()
    expectTypeOf<TransportCapabilities['supportsMultiParty']>().toEqualTypeOf<boolean>()
    expectTypeOf<TransportCapabilities['supportsMeshGossip']>().toEqualTypeOf<boolean>()
    expectTypeOf<TransportCapabilities['requiresExternalRelay']>().toEqualTypeOf<boolean>()
  })
})

describe('transportAdapter', () => {
  it('exposes upstream-aligned fields plus optional sovereignty extras', () => {
    expectTypeOf<TransportAdapter>().toHaveProperty('id')
    expectTypeOf<TransportAdapter>().toHaveProperty('status')
    expectTypeOf<TransportAdapter>().toHaveProperty('start')
    expectTypeOf<TransportAdapter>().toHaveProperty('stop')
    expectTypeOf<TransportAdapter>().toHaveProperty('sendToPeer')
    expectTypeOf<TransportAdapter>().toHaveProperty('broadcast')
    expectTypeOf<TransportAdapter>().toHaveProperty('subscribe')

    expectTypeOf<TransportAdapter['id']>().toEqualTypeOf<'cloudflare-edge' | 'libp2p-mesh' | 'loopback'>()
    expectTypeOf<TransportAdapter['status']>().toEqualTypeOf<'disconnected' | 'connecting' | 'connected' | 'error'>()
    expectTypeOf<TransportAdapter['start']>().toEqualTypeOf<() => Promise<void>>()
    expectTypeOf<TransportAdapter['stop']>().toEqualTypeOf<() => Promise<void>>()
  })

  it('is implementable by a plain upstream-style object', () => {
    const mock: TransportAdapter = {
      id: 'loopback',
      status: 'connected',
      start: async () => {},
      stop: async () => {},
      sendToPeer: async () => false,
      broadcast: async () => {},
      subscribe: async () => () => {},
    }
    expectTypeOf(mock).toMatchTypeOf<TransportAdapter>()
  })
})
