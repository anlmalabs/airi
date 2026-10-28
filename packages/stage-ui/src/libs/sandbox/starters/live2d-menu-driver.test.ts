import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LIVE2D_MENU_DRIVER_STARTER } from './live2d-menu-driver'

interface MockNode {
  tagName: string
  className: string
  id?: string
  innerHTML: string
  dataset: Record<string, string>
  children: MockNode[]
  listeners: Record<string, Function[]>
  appendChild: (child: MockNode) => void
  addEventListener: (event: string, fn: Function) => void
  querySelector: (sel: string) => MockNode | null
  querySelectorAll: (sel: string) => MockNode[]
  click: () => void
}

function createMockElement(tag = 'div'): MockNode {
  let innerHtmlContent = ''

  const el: MockNode = {
    tagName: tag.toUpperCase(),
    className: '',
    dataset: {},
    children: [],
    listeners: {},
    get innerHTML() {
      return innerHtmlContent
    },
    set innerHTML(html: string) {
      innerHtmlContent = html
      this.children = []
      const buttonMatches = html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)
      for (const match of buttonMatches) {
        const attrs = match[1]
        const btn = createMockElement('button')
        const idMatch = attrs.match(/id="([^"]+)"/)
        if (idMatch)
          btn.id = idMatch[1]
        const classMatch = attrs.match(/class="([^"]+)"/)
        if (classMatch)
          btn.className = classMatch[1]
        const trackMatch = attrs.match(/data-track="([^"]+)"/)
        if (trackMatch)
          btn.dataset.track = trackMatch[1]
        const groupMatch = attrs.match(/data-group="([^"]+)"/)
        if (groupMatch)
          btn.dataset.group = groupMatch[1]
        const hitMatch = attrs.match(/data-hit="([^"]+)"/)
        if (hitMatch)
          btn.dataset.hit = hitMatch[1]
        this.children.push(btn)
      }
    },
    appendChild(child: MockNode) {
      this.children.push(child)
    },
    addEventListener(event: string, fn: Function) {
      this.listeners[event] = this.listeners[event] || []
      this.listeners[event].push(fn)
    },
    click() {
      this.listeners.click?.forEach(fn => fn({ currentTarget: this, target: this }))
    },
    querySelector(sel: string) {
      if (sel.startsWith('#')) {
        const id = sel.slice(1)
        return this.children.find(c => c.id === id) || null
      }
      if (sel.startsWith('[data-track=')) {
        const track = sel.match(/\[data-track="([^"]+)"\]/)?.[1]
        return this.children.find(c => c.dataset.track === track) || null
      }
      return this.children[0] || null
    },
    querySelectorAll(sel: string) {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1)
        return this.children.filter(c => c.className.includes(cls))
      }
      return [...this.children]
    },
  }
  return el
}

describe('lIVE2D_MENU_DRIVER_STARTER widget', () => {
  let mockPostMessage: any

  beforeEach(() => {
    mockPostMessage = vi.fn()
    ;(globalThis as any).window = globalThis
    ;(globalThis as any).window.parent = {
      postMessage: mockPostMessage,
    }
    ;(globalThis as any).document = {
      createElement: (tag: string) => createMockElement(tag),
    }
  })

  it('conforms to WidgetExportManifest specification', () => {
    expect(LIVE2D_MENU_DRIVER_STARTER.version).toBe('1.0')
    expect(LIVE2D_MENU_DRIVER_STARTER.id).toBe('starter-live2d-menu-driver')
    expect(LIVE2D_MENU_DRIVER_STARTER.title).toContain('Live2D Controller')
    expect(LIVE2D_MENU_DRIVER_STARTER.scope).toBe('global')
    expect(LIVE2D_MENU_DRIVER_STARTER.surface).toBe('panel')
    expect(typeof LIVE2D_MENU_DRIVER_STARTER.sourceCode).toBe('string')
    expect(typeof LIVE2D_MENU_DRIVER_STARTER.code).toBe('string')
  })

  it('renders waiting state when no Live2D model is loaded', async () => {
    const container = createMockElement('div')
    const state: any = {}
    const sidecar: any = { live2d: null }

    const cleanCode = LIVE2D_MENU_DRIVER_STARTER.code.replace('export default function mount', 'return function mount')
    const mountFn = new Function(cleanCode)()
    mountFn({
      container,
      sidecar,
      state,
      setState: vi.fn(),
      onStateChange: () => () => {},
      onUpdate: () => () => {},
    })

    const rootChild = container.children[0]
    expect(rootChild.innerHTML).toContain('Awaiting active Live2D model')
  })

  it('renders hit areas, audio tracks, and voice topics from sidecar.live2d', async () => {
    const container = createMockElement('div')
    const state: any = {
      skin: {
        title: 'AMADEUS SYSTEM',
        subtitle: '1.048596%',
        customTrackTitles: {
          '音乐（amadeus）': 'Amadeus OP',
        },
      },
    }
    const sidecar: any = {
      live2d: {
        hasModel: true,
        modelId: 'kurisu',
        hasDsl: true,
        enabledHitAreas: ['phone'],
        hitAreas: [
          { name: 'phone', id: 'ArtMesh113', motion: 'phone', enabled: true },
          { name: '音乐（进入）', id: 'ArtMesh121', motion: '主界面（音乐进入）', enabled: false },
        ],
        reactions: [
          { group: '音乐（amadeus）', sound: 'Motions_amadeus.mp3', text: '音乐（amadeus）' },
          { group: '互动（打招呼1）', sound: 'Motions_hello.wav', text: '互动（打招呼1）' },
        ],
      },
    }

    const cleanCode = LIVE2D_MENU_DRIVER_STARTER.code.replace('export default function mount', 'return function mount')
    const mountFn = new Function(cleanCode)()
    mountFn({
      container,
      sidecar,
      state,
      setState: vi.fn(),
      onStateChange: () => () => {},
      onUpdate: () => () => {},
    })

    const rootChild = container.children[0]
    expect(rootChild.innerHTML).toContain('AMADEUS SYSTEM')
    expect(rootChild.innerHTML).toContain('1.048596%')
    expect(rootChild.innerHTML).toContain('Amadeus OP')
    expect(rootChild.innerHTML).toContain('phone')
    expect(rootChild.innerHTML).toContain('音乐（进入）')

    // Click track button
    const trackBtn = rootChild.querySelector('[data-track="音乐（amadeus）"]') as MockNode
    expect(trackBtn).not.toBeNull()
    trackBtn.click()

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'airi:live2d:dispatch',
        target: '音乐（amadeus）',
      }),
      '*',
    )

    // Click stop button
    const stopBtn = rootChild.querySelector('#stop-audio-btn') as MockNode
    expect(stopBtn).not.toBeNull()
    stopBtn.click()

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'airi:live2d:command',
        command: 'stop_sound 0',
      }),
      '*',
    )
  })
})
