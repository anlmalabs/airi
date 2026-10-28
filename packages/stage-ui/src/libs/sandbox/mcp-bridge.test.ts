import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clearMcpToolBridge, setMcpToolBridge } from '../../stores/mcp-tool-bridge'
import { clearSystemOneBridge, setSystemOneBridge } from './jev'
import { executeUniversalMcpTool, handleWidgetMcpMessage, listUniversalMcpTools } from './mcp-bridge'

describe('universal MCP Bridge & Widget Message Dispatcher', () => {
  beforeEach(() => {
    clearMcpToolBridge()
    clearSystemOneBridge()
  })

  it('routes jev::choose directly to Jev environment without external MCP server', async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      answers: {
        choice_decision: {
          choice: 'espresso',
        },
      },
    })
    setSystemOneBridge({
      execute: mockExecute,
      configured: true,
      lastLatencyMs: 85,
    })

    const res = await executeUniversalMcpTool({
      name: 'jev::choose',
      arguments: {
        question: 'Pick coffee',
        options: ['espresso', 'latte', 'tea'],
      },
    })

    expect(res.isError).toBeFalsy()
    expect((res.toolResult as any).choice).toBe('espresso')
    expect((res.toolResult as any).latencyMs).toBe(85)
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it('falls back to MCP tool bridge for non-Jev tools', async () => {
    const mockBridge = {
      listTools: vi.fn().mockResolvedValue([
        { serverName: 'weather', name: 'weather::forecast', toolName: 'forecast', inputSchema: {} },
      ]),
      callTool: vi.fn().mockResolvedValue({
        structuredContent: { temp: 24, condition: 'sunny' },
      }),
      getRuntimeStatus: vi.fn(),
    }
    setMcpToolBridge(mockBridge as any)

    const res = await executeUniversalMcpTool({
      name: 'weather::forecast',
      arguments: { city: 'Tokyo' },
    })

    expect(res.isError).toBeFalsy()
    expect((res.structuredContent as any).temp).toBe(24)
    expect(mockBridge.callTool).toHaveBeenCalledWith({
      name: 'weather::forecast',
      arguments: { city: 'Tokyo' },
    })
  })

  it('returns graceful error if bridge is unavailable for external tool', async () => {
    const res = await executeUniversalMcpTool({
      name: 'external::tool',
      arguments: {},
    })

    expect(res.isError).toBe(true)
    expect(res.toolResult).toContain('MCP tool bridge not available')
  })

  it('lists both Jev tools and external bridge tools', async () => {
    const mockBridge = {
      listTools: vi.fn().mockResolvedValue([
        { serverName: 'notes', name: 'notes::add', toolName: 'add', inputSchema: {} },
      ]),
      callTool: vi.fn(),
      getRuntimeStatus: vi.fn(),
    }
    setMcpToolBridge(mockBridge as any)

    const tools = await listUniversalMcpTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('jev::choose')
    expect(names).toContain('jev::is')
    expect(names).toContain('notes::add')
  })

  it('handles widget mcp-call iframe messages and posts result back to target', async () => {
    setSystemOneBridge({
      execute: vi.fn().mockResolvedValue({
        answers: { choice_decision: { choice: 'scone' } },
      }),
      configured: true,
      lastLatencyMs: 40,
    })

    const postMessage = vi.fn()
    const mockWindow = { postMessage } as unknown as WindowProxy

    const event = {
      data: {
        type: 'mcp-call',
        id: 'req-123',
        name: 'jev::choose',
        args: {
          question: 'Pick snack',
          options: ['scone', 'cookie'],
        },
      },
      source: mockWindow,
    } as unknown as MessageEvent

    const handled = await handleWidgetMcpMessage(event)
    expect(handled).toBe(true)
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mcp-call-result',
        id: 'req-123',
        result: expect.objectContaining({ choice: 'scone' }),
      }),
      '*',
    )
  })

  it('ignores non-mcp messages', async () => {
    const event = {
      data: { type: 'widget-resize', height: 200 },
    } as MessageEvent

    const handled = await handleWidgetMcpMessage(event)
    expect(handled).toBe(false)
  })

  it('forwards allowlisted live2d dispatch over the DSL bridge', async () => {
    const received: any[] = []
    const receiver = new BroadcastChannel('live2d-dsl-bridge')
    receiver.onmessage = (e: MessageEvent) => received.push(e.data)

    const event = {
      data: { type: 'airi:live2d:dispatch', target: 'phone' },
    } as MessageEvent
    const handled = await handleWidgetMcpMessage(event)
    expect(handled).toBe(true)

    await vi.waitFor(() => expect(received).toContainEqual({ type: 'dsl-widget-dispatch', target: 'phone' }))
    receiver.close()
  })

  it('forwards raw live2d commands and drops unallowlisted payloads', async () => {
    const received: any[] = []
    const receiver = new BroadcastChannel('live2d-dsl-bridge')
    receiver.onmessage = (e: MessageEvent) => received.push(e.data)

    const cmdEvent = {
      data: { type: 'airi:live2d:command', command: 'stop_sound 0' },
    } as MessageEvent
    expect(await handleWidgetMcpMessage(cmdEvent)).toBe(true)
    await vi.waitFor(() => expect(received).toContainEqual({ type: 'dsl-widget-command', command: 'stop_sound 0' }))

    const evilEvent = {
      data: { type: 'airi:live2d:eval', target: 'phone' },
    } as MessageEvent
    expect(await handleWidgetMcpMessage(evilEvent)).toBe(false)
    const emptyEvent = {
      data: { type: 'airi:live2d:dispatch' },
    } as MessageEvent
    expect(await handleWidgetMcpMessage(emptyEvent)).toBe(false)

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(received).toHaveLength(1)
    receiver.close()
  })
})
