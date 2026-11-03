import { multiaddr } from '@multiformats/multiaddr'
import { describe, expect, it } from 'vitest'

import { runRoundTrip, startNode } from '../../../../../../../scripts/lib/cross-wan-roundtrip'

describe('cross-wan round trip over loopback', () => {
  it('round-trips a message between two in-process nodes', async () => {
    const nodeA = await startNode(['/ip4/127.0.0.1/tcp/0'])
    const nodeB = await startNode(['/ip4/127.0.0.1/tcp/0'])

    try {
      const addrB = nodeB.getMultiaddrs()[0]
      await nodeA.dial(multiaddr(addrB.toString()))

      const [resultA, resultB] = await Promise.all([
        runRoundTrip(nodeA, { timeoutMs: 15000 }),
        runRoundTrip(nodeB, { timeoutMs: 15000 }),
      ])

      expect(resultA).not.toBeNull()
      expect(resultB).not.toBeNull()
      expect(resultA?.from).toBe(nodeB.peerId.toString())
      expect(resultB?.from).toBe(nodeA.peerId.toString())
    }
    finally {
      await nodeA.stop()
      await nodeB.stop()
    }
  }, 30000)
})
