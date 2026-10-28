import { DSLVirtualMachine } from '@proj-airi/live2d-runtime'
import { useDslSnapshotStore, useLive2d } from '@proj-airi/stage-ui-live2d/stores'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { widgetsRepo } from '../../database/repos/widgets.repo'
import { useChatSessionStore } from '../../stores/chat/session-store'
import { clearMcpToolBridge, setMcpToolBridge } from '../../stores/mcp-tool-bridge'
import { useAiriCardStore } from '../../stores/modules/airi-card'
import { useNan0Store } from '../../stores/modules/nan0'
import { createBashTool, executeBashCommand } from '../../stores/modules/tools/bash'
import { ansiToHtml, stripAnsi } from './ansi'
import { clearSystemOneBridge, setSystemOneBridge } from './jev'
import { SandboxManager } from './manager'
import { buildWidgetIframeSrcdoc } from './srcdoc'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (k: string) => k,
    d: (d: any) => d,
  }),
}))

describe('sandbox subsystem & in-memory posix execution', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    await widgetsRepo.clearMounted()
    clearSystemOneBridge()
  })

  describe('sandboxManager core', () => {
    it('initializes in-memory workspace and executes basic commands', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const res = await sandbox.exec('echo "hello airi"')
      expect(res.exitCode).toBe(0)
      expect(res.stdout.trim()).toBe('hello airi')
      expect(res.stderr).toBe('')
    })

    it('writes and reads files within virtual RAM disk', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/sample.txt', 'posix in-memory')
      const content = await sandbox.readFile('/workspace/sample.txt')
      expect(content).toBe('posix in-memory')

      const catRes = await sandbox.exec('cat /workspace/sample.txt')
      expect(catRes.stdout.trim()).toBe('posix in-memory')
    })

    it('preserves permissions on sed -i execution', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/config.txt', 'port=8080')
      await (sandbox as any).bash.fs.chmod('/workspace/config.txt', 0o755)

      const statBefore = await (sandbox as any).bash.fs.stat('/workspace/config.txt')
      expect(statBefore.mode).toBe(0o755)

      await sandbox.exec('sed -i "s/8080/9090/" /workspace/config.txt')
      const updatedContent = await sandbox.readFile('/workspace/config.txt')
      expect(updatedContent.trim()).toBe('port=9090')

      const statAfter = await (sandbox as any).bash.fs.stat('/workspace/config.txt')
      expect(statAfter.mode).toBe(0o755)
    })

    it('executes in-memory node command with eval and version', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const versionRes = await sandbox.exec('node -v')
      expect(versionRes.stdout.trim()).toBe('v22.14.0')

      const evalRes = await sandbox.exec('node -e "console.log(20 + 22)"')
      expect(evalRes.stdout.trim()).toBe('42')

      await sandbox.writeFile('/workspace/run.js', 'console.log("script executed");')
      const fileRes = await sandbox.exec('node /workspace/run.js')
      expect(fileRes.stdout.trim()).toBe('script executed')
    })

    it('handles mount_widget command and fires mount listener', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/widget.js', 'export default { render() { return "widget"; } }')

      let mountedWidgetCaptured: any = null
      sandbox.onMount((w) => {
        mountedWidgetCaptured = w
      })

      const mountRes = await sandbox.exec('mount_widget /workspace/widget.js')
      expect(mountRes.exitCode).toBe(0)
      expect(mountRes.stdout).toContain('[GEN_UI_MOUNT:/workspace/widget.js]')

      expect(mountedWidgetCaptured).not.toBeNull()
      expect(mountedWidgetCaptured.path).toBe('/workspace/widget.js')
      expect(mountedWidgetCaptured.code).toContain('render()')
    })

    it('auto-compiles .ts files on mount_widget and unmounts properly', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/counter.ts', `
        export default function mount(ctx: any) {
          ctx.innerHTML = '<div>Count: 1</div>'
        }
      `)

      const mountRes = await sandbox.exec('mount_widget /workspace/counter.ts --title "Counter Gauge" --target sidepanel')
      expect(mountRes.exitCode).toBe(0)
      expect(mountRes.stdout).toContain('Widget "Counter Gauge" mounted in right side panel of the chatbox (if closed, open the widgets panel to view).')
      expect(sandbox.mountedWidgets.length).toBe(1)
      expect(sandbox.mountedWidgets[0].title).toBe('Counter Gauge')
      expect(sandbox.mountedWidgets[0].surface).toBe('panel')
      expect(sandbox.mountedWidgets[0].target).toBe('sidepanel')

      const unmountRes = await sandbox.exec('unmount_widget /workspace/counter.js')
      expect(unmountRes.exitCode).toBe(0)
      expect(sandbox.mountedWidgets.length).toBe(0)
    })

    it('transpiles complex TypeScript with interfaces, generics, primitives and non-null assertions', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/pos.ts', `
        interface MenuItem {
          id: string;
          price: number;
          badge?: string;
        }
        const items: MenuItem[] = [{ id: 'coffee', price: 3.5 }];
        export default function mount({ container, sidecar, onUpdate }: any) {
          const cart: Record<string, number> = {};
          let receiptData: string | null = null;
          const found = items.find(i => i.id === 'coffee')!;
          container.innerHTML = '<div>' + found.price + '</div>';
        }
      `)

      const mountRes = await sandbox.exec('mount_widget /workspace/pos.ts --title "Cafe POS"')
      expect(mountRes.exitCode).toBe(0)
      expect(sandbox.mountedWidgets[0].code).not.toContain(': string')
      expect(sandbox.mountedWidgets[0].code).not.toContain(': number')
      expect(sandbox.mountedWidgets[0].code).not.toContain('Record<string, number>')
      expect(sandbox.mountedWidgets[0].code).not.toContain('interface MenuItem')
      expect(sandbox.mountedWidgets[0].code).toContain('container.innerHTML')
    })

    it('supports --surface widget and --surface panel with explicit reminder messages', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/stock.js', 'export default function() {}')

      // 1. Mount with --surface widget
      const widgetRes = await sandbox.exec('mount_widget /workspace/stock.js --title "Market Ticker" --surface widget')
      expect(widgetRes.exitCode).toBe(0)
      expect(widgetRes.stdout).toContain('Widget "Market Ticker" mounted in new standalone widget window on the desktop.')
      expect(sandbox.mountedWidgets.length).toBe(1)
      expect(sandbox.mountedWidgets[0].surface).toBe('widget')
      expect(sandbox.mountedWidgets[0].target).toBe('window')

      // 2. Remount with --surface panel
      const panelRes = await sandbox.exec('mount_widget /workspace/stock.js --title "Market Ticker" --surface panel')
      expect(panelRes.exitCode).toBe(0)
      expect(panelRes.stdout).toContain('Widget "Market Ticker" mounted in right side panel of the chatbox (if closed, open the widgets panel to view).')
      expect(sandbox.mountedWidgets[0].surface).toBe('panel')
      expect(sandbox.mountedWidgets[0].target).toBe('sidepanel')
    })
  })

  describe('level 1 vfs state projections', () => {
    it('projects session.json, cognition.json, telemetry.json, messages.json into /workspace/.airi/', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const sessionExists = await (sandbox as any).bash.fs.exists('/workspace/.airi/session.json')
      const telemetryExists = await (sandbox as any).bash.fs.exists('/workspace/.airi/telemetry.json')
      const cognitionExists = await (sandbox as any).bash.fs.exists('/workspace/.airi/cognition.json')
      const messagesExists = await (sandbox as any).bash.fs.exists('/workspace/.airi/messages.json')
      const live2dExists = await (sandbox as any).bash.fs.exists('/workspace/.airi/live2d.json')

      expect(sessionExists).toBe(true)
      expect(telemetryExists).toBe(true)
      expect(cognitionExists).toBe(true)
      expect(messagesExists).toBe(true)
      expect(live2dExists).toBe(true)
    })

    it('allows querying state projections via jq in bash pipeline', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      // Query session.json characterName with jq
      const resName = await sandbox.exec('cat /workspace/.airi/session.json | jq -r .characterName')
      expect(resName.exitCode).toBe(0)
      expect(resName.stdout.trim()).toBe('Airi')

      // Query telemetry.json localTime with jq
      const resTelemetry = await sandbox.exec('cat /workspace/.airi/telemetry.json | jq -r .activeProgram')
      expect(resTelemetry.exitCode).toBe(0)
      expect(resTelemetry.stdout.trim()).toBeDefined()
    })

    it('projects rawContent into messages.json to preserve ACTOR and cue tokens for widgets', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const chatSession = useChatSessionStore()
      const sessionId = 'test-session-actors'
      chatSession.activeSessionId = sessionId
      chatSession.sessionMessages[sessionId] = [
        {
          id: 'm1',
          role: 'assistant',
          content: 'Hello Jin! I am brewing your coffee right now.',
          rawContent: '<|ACTOR:makise_kurisu|>Hello Jin! <|ACT:emotion="happy"|>I am brewing your coffee right now.',
          createdAt: new Date().toISOString(),
        } as any,
      ]

      await sandbox.syncProjections()

      const raw = await sandbox.readFile('/workspace/.airi/messages.json')
      const msgs = JSON.parse(raw)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].content).toContain('<|ACTOR:makise_kurisu|>')
      expect(msgs[0].content).toContain('<|ACT:emotion="happy"|>')
    })

    it('projects Live2D hit gates, sounds, and varFloats into live2d.json', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const live2d = useLive2d()
      live2d.rawSettings = {
        HitAreas: [
          { Name: 'phone', Id: 'ArtMesh113', Motion: 'phone' },
          { Name: '音乐（进入）', Id: 'ArtMesh121', Motion: '主界面（音乐进入）', Enabled: false },
        ],
      }
      live2d.dslGroups = [
        { name: 'phone', entries: [{ Sound: 'Motions_phone_0_Sound_0.wav' }] },
        { name: '音乐（amadeus）', entries: [{ Sound: 'Motions_音乐（amadeus）_0_Sound_0.mp3', Interruptable: true }] },
      ]
      live2d.dslVM = {
        isHitAreaEnabled: (name: string) => name === 'phone',
        vars: { snapshot: () => ({ music_playing: 0 }) },
      }

      await sandbox.syncProjections()

      const raw = await sandbox.readFile('/workspace/.airi/live2d.json')
      const projection = JSON.parse(raw)
      expect(projection.hasDsl).toBe(true)
      expect(projection.hitAreasCount).toBe(2)
      expect(projection.enabledHitAreas).toEqual(['phone'])
      expect(projection.reactionsCount).toBe(2)
      expect(projection.varFloats).toEqual({ music_playing: 0 })

      const resHits = await sandbox.exec('cat /workspace/.airi/live2d.json | jq -r .enabledHitAreas[0]')
      expect(resHits.exitCode).toBe(0)
      expect(resHits.stdout.trim()).toBe('phone')
    })

    it('reflects real DSL gate flips across dispatches', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const live2d = useLive2d()
      live2d.rawSettings = {
        HitAreas: [
          { Name: 'phone', Id: 'ArtMesh113', Motion: 'phone' },
          { Name: '音乐（进入）', Id: 'ArtMesh121', Motion: '主界面（音乐进入）', Enabled: false },
          { Name: '互动（进入）', Id: 'ArtMesh119', Motion: '互动（进入）', Enabled: false },
        ],
      }
      const vm = new DSLVirtualMachine()
      vm.loadGroups([
        { name: 'Start', entries: [{ Command: 'hit_areas disable 音乐（进入）,互动（进入）;hit_areas enable phone' }] },
        { name: 'phone', entries: [{ Sound: 'Motions_phone_0_Sound_0.wav', Command: 'hit_areas enable 音乐（进入）,互动（进入）' }] },
      ])
      live2d.dslVM = vm as any

      await sandbox.syncProjections()
      let projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect([...projection.enabledHitAreas].sort()).toEqual(['phone', '互动（进入）', '音乐（进入）'])

      vm.dispatch('Start')
      await sandbox.syncProjections()
      projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect(projection.enabledHitAreas).toEqual(['phone'])

      vm.dispatch('phone')
      await sandbox.syncProjections()
      projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect([...projection.enabledHitAreas].sort()).toEqual(['phone', '互动（进入）', '音乐（进入）'])
    })

    it('projects empty Live2D state when no model is loaded', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect(projection.hasModel).toBe(false)
      expect(projection.hasDsl).toBe(false)
      expect(projection.enabledHitAreas).toEqual([])
      expect(projection.hitAreasCount).toBe(0)
      expect(projection.modelId).toBe('')
    })

    it('parses lowercase hitAreas manifest shape with default-open gates', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const live2d = useLive2d()
      live2d.rawSettings = {
        hitAreas: [
          { name: 'phone', id: 'ArtMesh113', motion: 'phone', enabled: true },
          { name: '音乐（进入）', id: 'ArtMesh121', motion: '主界面（音乐进入）', enabled: false },
        ],
      }

      await sandbox.syncProjections()
      const projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect(projection.hasDsl).toBe(true)
      expect(projection.hitAreasCount).toBe(2)
      expect([...projection.enabledHitAreas].sort()).toEqual(['phone', '音乐（进入）'])
    })

    it('resolves modelId from the active card display model', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const cardStore = useAiriCardStore()
      cardStore.cards.set('kurisu-card', {
        id: 'kurisu-card',
        name: 'Kurisu',
        extensions: { airi: { modules: { displayModelId: 'kurisu-model-1' } } },
      } as any)
      cardStore.activeCardId = 'kurisu-card'

      await sandbox.syncProjections()
      const projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect(projection.modelId).toBe('kurisu-model-1')
    })

    it('falls back to the cross-window snapshot when no live VM exists', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const snapshotStore = useDslSnapshotStore()
      snapshotStore.publish({
        modelId: 'kurisu-model-1',
        activeMotion: { group: 'phone', index: 0 },
        lastText: null,
        lastDispatch: null,
        enabledHitAreas: ['phone'],
        hitAreas: [
          { name: 'phone', id: 'ArtMesh113', motion: 'phone' },
          { name: '音乐（进入）', id: 'ArtMesh121', motion: '主界面（音乐进入）' },
        ],
        reactions: [
          { group: '音乐（amadeus）', sound: 'Motions_音乐（amadeus）_0_Sound_0.mp3' },
        ],
        varFloats: { music_playing: 1 },
        updatedAt: Date.now(),
      })
      const cardStore = useAiriCardStore()
      cardStore.cards.set('kurisu-card', {
        id: 'kurisu-card',
        name: 'Kurisu',
        extensions: { airi: { modules: { displayModelId: 'kurisu-model-1' } } },
      } as any)
      cardStore.activeCardId = 'kurisu-card'

      await sandbox.syncProjections()
      const projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect(projection.live).toBe(false)
      expect(projection.hasModel).toBe(true)
      expect(projection.hasDsl).toBe(true)
      expect(projection.enabledHitAreas).toEqual(['phone'])
      expect(projection.hitAreas).toHaveLength(2)
      expect(projection.hitAreas[1]).toMatchObject({ name: '音乐（进入）', motion: '主界面（音乐进入）' })
      expect(projection.reactions).toHaveLength(1)
      expect(projection.varFloats).toEqual({ music_playing: 1 })
      expect(projection.activeMotion).toEqual({ group: 'phone', index: 0 })
    })

    it('prefers the live VM over a stale snapshot', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const cardStore = useAiriCardStore()
      cardStore.cards.set('kurisu-card', {
        id: 'kurisu-card',
        name: 'Kurisu',
        extensions: { airi: { modules: { displayModelId: 'kurisu-model-1' } } },
      } as any)
      cardStore.activeCardId = 'kurisu-card'

      const live2d = useLive2d()
      live2d.rawSettings = {
        HitAreas: [{ Name: 'phone', Id: 'ArtMesh113', Motion: 'phone' }],
      }
      const vm = new DSLVirtualMachine()
      vm.loadGroups([{ name: 'phone', entries: [{ Sound: 'x.wav' }] }])
      live2d.dslVM = vm as any
      live2d.model = {} as any
      live2d.dslGroups = [{ name: 'phone', entries: [{ Sound: 'x.wav' }] }]

      const snapshotStore = useDslSnapshotStore()
      snapshotStore.publish({
        modelId: 'kurisu-model-1',
        activeMotion: null,
        lastText: null,
        lastDispatch: null,
        enabledHitAreas: [],
        hitAreas: [{ name: 'stale-zone' }],
        reactions: [],
        varFloats: {},
        updatedAt: 1,
      })

      await sandbox.syncProjections()
      const projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect(projection.live).toBe(true)
      expect(projection.hitAreas).toHaveLength(1)
      expect(projection.hitAreas[0].name).toBe('phone')
      expect(projection.reactions).toHaveLength(1)
    })

    it('exposes live2d dispatch, hits, and state through the CLI', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const snapshotStore = useDslSnapshotStore()
      snapshotStore.publish({
        modelId: 'kurisu-model-1',
        activeMotion: { group: 'Start', index: 0 },
        lastText: null,
        lastDispatch: { kind: 'dispatch', target: 'phone', at: Date.now() },
        enabledHitAreas: ['phone'],
        hitAreas: [
          { name: 'phone', id: 'ArtMesh113', motion: 'phone' },
          { name: '音乐（进入）', id: 'ArtMesh121', motion: '主界面（音乐进入）' },
        ],
        reactions: [],
        varFloats: {},
        updatedAt: Date.now(),
      })
      const cardStore = useAiriCardStore()
      cardStore.cards.set('kurisu-card', {
        id: 'kurisu-card',
        name: 'Kurisu',
        extensions: { airi: { modules: { displayModelId: 'kurisu-model-1' } } },
      } as any)
      cardStore.activeCardId = 'kurisu-card'

      const stateRes = await sandbox.exec('live2d state')
      expect(stateRes.exitCode).toBe(0)
      expect(stateRes.stdout).toContain('kurisu-model-1')
      expect(stateRes.stdout).toContain('gates: 1/2 open')
      expect(stateRes.stdout).toContain('last: dispatch "phone"')

      const hitsRes = await sandbox.exec('live2d hits --enabled-only')
      expect(hitsRes.exitCode).toBe(0)
      expect(hitsRes.stdout).toContain('phone')
      expect(hitsRes.stdout).not.toContain('音乐（进入）')

      const allRes = await sandbox.exec('live2d hits')
      expect(allRes.stdout).toContain('音乐（进入）')

      const dispatchRes = await sandbox.exec('live2d dispatch phone')
      expect(dispatchRes.exitCode).toBe(0)
      expect(dispatchRes.stdout).toContain('dispatched "phone"')

      const usageRes = await sandbox.exec('live2d')
      expect(usageRes.exitCode).toBe(1)
      expect(usageRes.stderr).toContain('Usage: live2d')
    })

    it('exposes Live2D state through require(live2d) in node', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const snapshotStore = useDslSnapshotStore()
      snapshotStore.publish({
        modelId: 'kurisu-model-1',
        activeMotion: { group: 'Start', index: 0 },
        lastText: null,
        lastDispatch: null,
        enabledHitAreas: ['phone'],
        hitAreas: [
          { name: 'phone', id: 'ArtMesh113', motion: 'phone' },
          { name: '音乐（进入）', id: 'ArtMesh121', motion: '主界面（音乐进入）' },
        ],
        reactions: [],
        varFloats: {},
        updatedAt: Date.now(),
      })
      const cardStore = useAiriCardStore()
      cardStore.cards.set('kurisu-card', {
        id: 'kurisu-card',
        name: 'Kurisu',
        extensions: { airi: { modules: { displayModelId: 'kurisu-model-1' } } },
      } as any)
      cardStore.activeCardId = 'kurisu-card'

      const res = await sandbox.exec('node -e "const l=require(\'live2d\');console.log(JSON.stringify({open:l.isHitAreaEnabled(\'phone\'),closed:l.isHitAreaEnabled(\'音乐（进入）\'),caps:!!l.getDslState(),sent:typeof l.dispatch}))"')
      expect(res.exitCode).toBe(0)
      expect(JSON.parse(res.stdout.trim())).toEqual({ open: true, closed: false, caps: true, sent: 'function' })
    })

    it('surfaces lastDispatch from the snapshot', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const snapshotStore = useDslSnapshotStore()
      snapshotStore.publish({
        modelId: 'kurisu-model-1',
        activeMotion: { group: 'phone', index: 0 },
        lastText: null,
        lastDispatch: { kind: 'dispatch', target: 'phone', at: 1792098603907 },
        enabledHitAreas: ['phone'],
        hitAreas: [{ name: 'phone' }],
        reactions: [],
        varFloats: {},
        updatedAt: 1792098603907,
      })
      const cardStore = useAiriCardStore()
      cardStore.cards.set('kurisu-card', {
        id: 'kurisu-card',
        name: 'Kurisu',
        extensions: { airi: { modules: { displayModelId: 'kurisu-model-1' } } },
      } as any)
      cardStore.activeCardId = 'kurisu-card'

      await sandbox.syncProjections()
      const projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect(projection.lastDispatch).toEqual({ kind: 'dispatch', target: 'phone', at: 1792098603907 })

      const stateRes = await sandbox.exec('live2d state')
      expect(stateRes.stdout).toContain('last: dispatch "phone"')
    })

    it('refreshes gates on every sync without stale caching', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const live2d = useLive2d()
      live2d.rawSettings = {
        HitAreas: [
          { Name: 'phone', Id: 'ArtMesh113', Motion: 'phone' },
          { Name: '音乐（进入）', Id: 'ArtMesh121', Motion: '主界面（音乐进入）', Enabled: false },
        ],
      }
      const gates = new Map<string, boolean>([['phone', true], ['音乐（进入）', false]])
      live2d.dslVM = {
        isHitAreaEnabled: (name: string) => gates.get(name) ?? true,
        vars: { snapshot: () => ({}) },
      }

      await sandbox.syncProjections()
      let projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect(projection.enabledHitAreas).toEqual(['phone'])

      gates.set('音乐（进入）', true)
      await sandbox.syncProjections()
      projection = JSON.parse(await sandbox.readFile('/workspace/.airi/live2d.json'))
      expect([...projection.enabledHitAreas].sort()).toEqual(['phone', '音乐（进入）'])
    })

    it('projects rich nan0 cognition state into cognition.json when nan0 is enabled', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const cardStore = useAiriCardStore()
      const nan0Store = useNan0Store()

      const nan0Card = {
        id: 'nan0-card',
        name: 'Nan0',
        description: 'AI companion with sentient emotions',
        extensions: {
          airi: {
            modules: {
              cognition: {
                enabled: true,
                processor: 'local_nan0',
              },
            },
          },
        },
      }
      cardStore.cards.set('nan0-card', nan0Card as any)
      cardStore.activeCardId = 'nan0-card'

      nan0Store.emotions = {
        ...nan0Store.emotions,
        attachment: 0.88,
        suspicion: 0.35,
      }

      await sandbox.syncProjections()

      const cognitionRaw = await sandbox.readFile('/workspace/.airi/cognition.json')
      const cognition = JSON.parse(cognitionRaw)

      expect(cognition.character.name).toBe('Nan0')
      expect(cognition.nan0).toBeDefined()
      expect(cognition.nan0.enabled).toBe(true)
      expect(cognition.nan0.emotions.attachment).toBe(0.88)
      expect(cognition.nan0.emotions.suspicion).toBe(0.35)
      expect(cognition.emotion).toBeDefined()
      expect(typeof cognition.valence).toBe('number')
      expect(typeof cognition.energy).toBe('number')
    })

    it('projects enriched character identity, prompts, and acting directives into cognition.json while excluding backdoors', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const cardStore = useAiriCardStore()
      const characterCard = {
        id: 'the-clockwork-roast',
        name: 'The Clockwork Roast & Haven Cafe',
        nickname: 'Arona & Cafe Crew',
        description: 'Cafe terminal assistant',
        personality: 'Earnest, playful, calculating',
        scenario: 'Late afternoon in the coffee shop',
        systemPrompt: 'You are Arona running the front desk terminal.',
        extensions: {
          airi: {
            acting: {
              modelExpressionPrompt: 'Model expression cues: [smile], [smug]',
              speechExpressionPrompt: 'Speech expression cues: [cheerful]',
              speechMannerismPrompt: 'Refers to herself in third person as Arona.',
              stickerDirectivesPrompt: '<|STICKER id="arona-smug" pos="topRight"|>',
              activeStickerIds: ['arona-smug', 'arona-neko'],
            },
            stickers: {
              'arona-smug': { id: 'arona-smug', label: 'Arona Smug' },
            },
          },
        },
      }
      cardStore.cards.set('the-clockwork-roast', characterCard as any)
      cardStore.activeCardId = 'the-clockwork-roast'

      await sandbox.syncProjections()

      const cognitionRaw = await sandbox.readFile('/workspace/.airi/cognition.json')
      const cognition = JSON.parse(cognitionRaw)

      expect(cognition.character.name).toBe('The Clockwork Roast & Haven Cafe')
      expect(cognition.character.nickname).toBe('Arona & Cafe Crew')
      expect(cognition.character.description).toBe('Cafe terminal assistant')
      expect(cognition.character.personality).toBe('Earnest, playful, calculating')
      expect(cognition.character.scenario).toBe('Late afternoon in the coffee shop')
      expect(cognition.character.systemPrompt).toBe('You are Arona running the front desk terminal.')

      // Acting prompts are exposed
      expect(cognition.character.acting).toBeDefined()
      expect(cognition.character.acting.modelExpressionPrompt).toBe('Model expression cues: [smile], [smug]')
      expect(cognition.character.acting.speechExpressionPrompt).toBe('Speech expression cues: [cheerful]')
      expect(cognition.character.acting.speechMannerismPrompt).toBe('Refers to herself in third person as Arona.')
      expect(cognition.character.acting.stickerDirectivesPrompt).toBe('<|STICKER id="arona-smug" pos="topRight"|>')

      // Backdoor protection: raw activeStickerIds and stickers registry are excluded
      expect((cognition.character.acting as any).activeStickerIds).toBeUndefined()
      expect((cognition.character.acting as any).stickers).toBeUndefined()
      expect((cognition.character as any).stickers).toBeUndefined()
    })

    it('preserves root system message (messages[0]) in messages.json when conversation history exceeds 20 turns', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const chatSession = useChatSessionStore()
      const sessionId = 'session-long-history'
      chatSession.activeSessionId = sessionId

      const longHistory = [
        {
          id: 'sys-0',
          role: 'system',
          content: 'You are Arona with sticker directives: <|STICKER id="arona-smug"|>',
          createdAt: Date.now() - 100000,
        },
      ]
      for (let i = 1; i <= 25; i++) {
        longHistory.push({
          id: `msg-${i}`,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Turn ${i} conversation content`,
          createdAt: Date.now() - (100000 - i * 1000),
        })
      }
      chatSession.sessionMessages[sessionId] = longHistory as any

      await sandbox.syncProjections()

      const raw = await sandbox.readFile('/workspace/.airi/messages.json')
      const msgs = JSON.parse(raw)

      expect(msgs).toHaveLength(20)
      // Root system message is preserved at index 0
      expect(msgs[0].id).toBe('sys-0')
      expect(msgs[0].role).toBe('system')
      expect(msgs[0].content).toContain('<|STICKER id="arona-smug"|>')
      // Remaining 19 messages are the latest conversation turns
      expect(msgs[msgs.length - 1].id).toBe('msg-25')
      expect(msgs[1].id).toBe('msg-7')
    })
  })

  describe('ansi formatting helpers', () => {
    it('strips ansi codes from text', () => {
      const colored = '\x1B[31mError:\x1B[0m something went wrong'
      expect(stripAnsi(colored)).toBe('Error: something went wrong')
    })

    it('converts ansi codes to colored html spans', () => {
      const colored = '\x1B[32mSuccess\x1B[0m'
      const html = ansiToHtml(colored)
      expect(html).toContain('<span class="text-green-400 font-semibold">Success</span>')
    })
  })

  describe('bash tool registration', () => {
    it('creates bash tool with expected name and description', async () => {
      const toolDef = await createBashTool()
      const toolName = (toolDef as any).name || (toolDef as any).function?.name
      const toolDesc = (toolDef as any).description || (toolDef as any).function?.description
      expect(toolName).toBe('bash')
      expect(toolDesc).toContain('/workspace')
    })

    it('executes bash tool commands through executeBashCommand', async () => {
      const out = await executeBashCommand({ command: 'echo "test tool execution"' })
      expect(out.trim()).toBe('test tool execution')
    })
  })

  describe('in-memory node runtime virtual fs and imports', () => {
    it('reads /workspace/.airi/telemetry.json synchronously via require("fs")', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const res = await sandbox.exec(`node -e '
        const fs = require("fs");
        const raw = fs.readFileSync("/workspace/.airi/telemetry.json", "utf-8");
        const t = JSON.parse(raw);
        console.log("activeProgram=" + t.activeProgram);
      '`)
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain('activeProgram=')
      expect(res.stderr).toBe('')
    })

    it('executes scripts with static and dynamic ESM imports and top-level await', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/esm_test.js', `
        import * as fs from "fs";
        import { existsSync } from "node:fs";
        import path from "node:path";
        const dynFs = await import("fs");

        const exists = existsSync("/workspace/.airi/session.json");
        const resolved = path.resolve("/workspace", "test.txt");
        console.log("exists=" + exists + " resolved=" + resolved);
      `)

      const res = await sandbox.exec('node /workspace/esm_test.js')
      expect(res.exitCode).toBe(0)
      expect(res.stdout.trim()).toBe('exists=true resolved=/workspace/test.txt')
      expect(res.stderr).toBe('')
    })

    it('supports fs.writeFileSync to write into virtual RAM disk', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const res = await sandbox.exec(`node -e '
        const fs = require("fs");
        fs.writeFileSync("/workspace/written_by_node.txt", "node RAM content");
        console.log(fs.readFileSync("/workspace/written_by_node.txt"));
      '`)
      expect(res.exitCode).toBe(0)
      expect(res.stdout.trim()).toBe('node RAM content')

      // Verify POSIX cat can read it too
      const catRes = await sandbox.exec('cat /workspace/written_by_node.txt')
      expect(catRes.stdout.trim()).toBe('node RAM content')
    })

    it('passes script arguments into process.argv', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/args.js', `
        console.log(process.argv.slice(2).join(","));
      `)

      const res = await sandbox.exec('node /workspace/args.js alpha beta gamma')
      expect(res.exitCode).toBe(0)
      expect(res.stdout.trim()).toBe('alpha,beta,gamma')
    })

    it('handles process.exit(code) without throwing unhandled exceptions', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const res0 = await sandbox.exec('node -e "process.exit(0)"')
      expect(res0.exitCode).toBe(0)

      const res42 = await sandbox.exec('node -e "process.exit(42)"')
      expect(res42.exitCode).toBe(42)
    })

    it('persists mounted widgets in widgetsRepo and rehydrates them across reboots', async () => {
      // 1. Initial boot: mount a TypeScript widget
      const sandbox1 = new SandboxManager()
      await sandbox1.init()

      await sandbox1.writeFile('/workspace/pulse.ts', `
        export default function mount({ container }: any) {
          container.innerHTML = "<h1>Pulse Active</h1>";
        }
      `)

      const mountRes = await sandbox1.exec('mount_widget /workspace/pulse.ts --title "Pulse HUD"')
      expect(mountRes.exitCode).toBe(0)
      expect(sandbox1.mountedWidgets.length).toBe(1)
      expect(sandbox1.mountedWidgets[0].title).toBe('Pulse HUD')

      // Verify it was saved to widgetsRepo
      const persisted = await widgetsRepo.getMountedWidgets()
      expect(persisted.length).toBeGreaterThanOrEqual(1)
      const found = persisted.find(w => w.path === '/workspace/pulse.js')
      expect(found).toBeDefined()
      expect(found?.title).toBe('Pulse HUD')
      expect(found?.isMounted).toBe(true)
      expect(found?.sourcePath).toBe('/workspace/pulse.ts')
      expect(found?.sourceCode).toContain('Pulse Active')

      // 2. Simulate complete restart / reload with a brand new SandboxManager instance
      const sandbox2 = new SandboxManager()
      await sandbox2.init()

      // The new sandbox instance should automatically rehydrate the mounted widget
      expect(sandbox2.mountedWidgets.length).toBeGreaterThanOrEqual(1)
      const rehydrated = sandbox2.mountedWidgets.find(w => w.path === '/workspace/pulse.js')
      expect(rehydrated).toBeDefined()
      expect(rehydrated?.title).toBe('Pulse HUD')

      // Both source and compiled files must exist in the fresh virtual RAM disk
      const sourceContent = await sandbox2.readFile('/workspace/pulse.ts')
      expect(sourceContent).toContain('Pulse Active')

      const bundleContent = await sandbox2.readFile('/workspace/pulse.js')
      expect(bundleContent.length).toBeGreaterThan(0)

      // 3. Unmount widget and verify repo updates
      sandbox2.unmountWidget(rehydrated!.id)
      expect(sandbox2.mountedWidgets.some(w => w.id === rehydrated!.id)).toBe(false)

      const afterUnmount = await widgetsRepo.getMountedWidgets()
      expect(afterUnmount.some(w => w.id === rehydrated!.id)).toBe(false)
    })

    it('persists widget position and surface across rehydration', async () => {
      const sandbox1 = new SandboxManager()
      await sandbox1.init()

      await sandbox1.writeFile('/workspace/floating.js', 'export default function mount() {}')
      await sandbox1.exec('mount_widget /workspace/floating.js --title "Floating Pet" --surface widget')

      expect(sandbox1.mountedWidgets[0].surface).toBe('widget')

      // Update position
      await sandbox1.updateWidgetPosition(sandbox1.mountedWidgets[0].id, { x: 420, y: 180 })

      const repoWidgets = await widgetsRepo.getMountedWidgets()
      const saved = repoWidgets.find(w => w.id === sandbox1.mountedWidgets[0].id)
      expect(saved?.position).toEqual({ x: 420, y: 180 })
      expect(saved?.surface).toBe('widget')

      // Simulate reboot
      const sandbox2 = new SandboxManager()
      await sandbox2.init()

      const rehydrated = sandbox2.mountedWidgets.find(w => w.title === 'Floating Pet')
      expect(rehydrated).toBeDefined()
      expect(rehydrated?.surface).toBe('widget')
      expect(rehydrated?.position).toEqual({ x: 420, y: 180 })
    })

    it('mounts persisted widget with surface override and safely updates surface with reactive proxy state', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/panel-item.js', 'export default function mount() {}')
      await sandbox.exec('mount_widget /workspace/panel-item.js --title "Panel Tool" --surface panel')
      expect(sandbox.mountedWidgets[0].surface).toBe('panel')

      // Simulate proxy in state
      const proxyState = new Proxy({ counter: 42 }, {
        get(target, prop) {
          return (target as any)[prop]
        },
      })
      sandbox.mountedWidgets[0].state = proxyState

      // Changing surface should not throw DataCloneError
      await expect(sandbox.setWidgetSurface(sandbox.mountedWidgets[0].id, 'widget')).resolves.not.toThrow()
      expect(sandbox.mountedWidgets[0].surface).toBe('widget')

      // Unmount and remount with surface override
      sandbox.unmountWidget(sandbox.mountedWidgets[0].id)
      const remounted = await sandbox.mountPersistedWidget('Panel Tool', 'widget')
      expect(remounted).toBeDefined()
      expect(remounted?.surface).toBe('widget')
    })

    it('lists persisted widgets with list_widgets / widgets and remounts by title or path', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/clock.ts', `
        export default function mount({ container }: any) {
          container.innerHTML = "<div>12:00:00</div>";
        }
      `)

      await sandbox.exec('mount_widget /workspace/clock.ts --title "Digital Clock"')
      expect(sandbox.mountedWidgets.length).toBeGreaterThanOrEqual(1)

      // Test list_widgets command
      const listRes = await sandbox.exec('list_widgets')
      expect(listRes.exitCode).toBe(0)
      expect(listRes.stdout).toContain('Digital Clock')
      expect(listRes.stdout).toContain('[ACTIVE]')

      // Test widgets alias
      const aliasRes = await sandbox.exec('widgets')
      expect(aliasRes.exitCode).toBe(0)
      expect(aliasRes.stdout).toContain('Digital Clock')

      // Unmount the widget
      const mountedWidget = sandbox.mountedWidgets.find(w => w.title === 'Digital Clock')!
      sandbox.unmountWidget(mountedWidget.id)
      expect(sandbox.mountedWidgets.some(w => w.title === 'Digital Clock')).toBe(false)

      // In list_widgets, it should now show as [UNMOUNTED]
      const unmountedListRes = await sandbox.exec('list_widgets')
      expect(unmountedListRes.stdout).toContain('[UNMOUNTED]')
      expect(unmountedListRes.stdout).toContain('Digital Clock')

      // Delete file from disk to simulate cold remount
      await sandbox.exec('rm /workspace/clock.ts /workspace/clock.js')

      // Remount using title via mount_widget
      const remountRes = await sandbox.exec('mount_widget "Digital Clock"')
      expect(remountRes.exitCode).toBe(0)
      expect(sandbox.mountedWidgets.some(w => w.title === 'Digital Clock')).toBe(true)

      // Remount via mountPersistedWidget API
      sandbox.unmountWidget(mountedWidget.id)
      const apiMounted = await sandbox.mountPersistedWidget(mountedWidget.id)
      expect(apiMounted).not.toBeNull()
      expect(apiMounted?.title).toBe('Digital Clock')
      expect(sandbox.mountedWidgets.some(w => w.id === mountedWidget.id)).toBe(true)
    })
  })

  describe('native mcp cli and virtual node mcp bridge', () => {
    beforeEach(() => {
      clearMcpToolBridge()
    })

    it('returns usage help when mcp is called without arguments or with --help', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const res = await sandbox.exec('mcp')
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain('Usage:')
      expect(res.stdout).toContain('mcp list')
      expect(res.stdout).toContain('mcp call')
    })

    it('returns error when mcp bridge is not available', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      const res = await sandbox.exec('mcp list')
      expect(res.exitCode).toBe(1)
      expect(res.stderr).toContain('MCP tool bridge is not available')
    })

    it('lists tools and executes tool calls piping into filesystem and jq', async () => {
      const mockBridge = {
        listTools: vi.fn().mockResolvedValue([
          { serverName: 'weather', toolName: 'get_forecast', name: 'weather::get_forecast', description: 'Get weather forecast' },
          { serverName: 'github', toolName: 'list_issues', name: 'github::list_issues', description: 'List repo issues' },
        ]),
        callTool: vi.fn().mockImplementation(async (payload: any) => {
          if (payload.name === 'weather::get_forecast') {
            return {
              structuredContent: { city: payload.arguments?.city, temp: 22, condition: 'Sunny' },
            }
          }
          return { toolResult: 'ok' }
        }),
        getRuntimeStatus: vi.fn().mockResolvedValue({ path: '', servers: [], updatedAt: Date.now() }),
      }
      setMcpToolBridge(mockBridge as any)

      const sandbox = new SandboxManager()
      await sandbox.init()

      // 1. mcp list
      const listRes = await sandbox.exec('mcp list')
      expect(listRes.exitCode).toBe(0)
      expect(listRes.stdout).toContain('weather::get_forecast')
      expect(listRes.stdout).toContain('github::list_issues')

      // 2. mcp list --json
      const jsonListRes = await sandbox.exec('mcp list --json')
      expect(jsonListRes.exitCode).toBe(0)
      expect(JSON.parse(jsonListRes.stdout).length).toBe(2)

      // 3. mcp call with args piped to file
      const callRes = await sandbox.exec('mcp weather::get_forecast \'{"city":"Tokyo"}\' > /workspace/weather.json')
      expect(callRes.exitCode).toBe(0)

      // 4. Verify file content and pipe to jq
      const jqRes = await sandbox.exec('cat /workspace/weather.json | jq .city')
      expect(jqRes.exitCode).toBe(0)
      expect(jqRes.stdout.trim()).toBe('"Tokyo"')

      const tempRes = await sandbox.exec('cat /workspace/weather.json | jq .temp')
      expect(tempRes.exitCode).toBe(0)
      expect(tempRes.stdout.trim()).toBe('22')
    })

    it('supports require("mcp") and global mcp in node runtime', async () => {
      const mockBridge = {
        listTools: vi.fn().mockResolvedValue([
          { serverName: 'calc', toolName: 'add', name: 'calc::add', description: 'Add numbers' },
        ]),
        callTool: vi.fn().mockImplementation(async (payload: any) => {
          if (payload.name === 'calc::add') {
            return {
              structuredContent: { sum: (payload.arguments?.a ?? 0) + (payload.arguments?.b ?? 0) },
            }
          }
          return { toolResult: null }
        }),
        getRuntimeStatus: vi.fn().mockResolvedValue({ path: '', servers: [], updatedAt: Date.now() }),
      }
      setMcpToolBridge(mockBridge as any)

      const sandbox = new SandboxManager()
      await sandbox.init()

      // 1. node require('mcp')
      const script = `
const mcp = require('mcp');
const fs = require('fs');
const res = await mcp.callTool('calc::add', { a: 15, b: 27 });
fs.writeFileSync('/workspace/sum.json', JSON.stringify(res));
console.log('SUM:' + res.sum);
`
      await sandbox.exec(`cat > /workspace/calc.js << 'EOF'${script}EOF`)
      const nodeRes = await sandbox.exec('node /workspace/calc.js')
      expect(nodeRes.exitCode).toBe(0)
      expect(nodeRes.stdout).toContain('SUM:42')

      const sumFile = await sandbox.exec('cat /workspace/sum.json | jq .sum')
      expect(sumFile.stdout.trim()).toBe('42')

      // 2. node global mcp via eval (-e)
      const evalRes = await sandbox.exec('node -e "const res = await mcp.callTool(\'calc::add\', { a: 100, b: 200 }); console.log(\'EVAL_SUM:\' + res.sum);"')
      expect(evalRes.exitCode).toBe(0)
      expect(evalRes.stdout).toContain('EVAL_SUM:300')
    })
  })

  describe('widget iframe srcdoc packaging & height stabilization', () => {
    it('packages ESM widgets with auto-height styles and threshold-governed ResizeObserver', async () => {
      const srcdoc = await buildWidgetIframeSrcdoc({
        path: '/workspace/test.js',
        code: 'export default function mount({ container }) { container.innerHTML = "<div>test</div>"; }',
        title: 'Test Widget',
      })

      // Iframe must use auto-height to prevent feedback loop expansion
      expect(srcdoc).toContain('height: auto')
      expect(srcdoc).toContain('min-height: 0')
      expect(srcdoc).not.toContain('min-h-full')
      expect(srcdoc).toContain('observe(root)')
      expect(srcdoc).toContain('Math.abs(h - lastH) > 2')
      expect(srcdoc).toContain('type: \'widget-resize\'')
    })
  })

  describe('lazy sidecar state binding & 2-way reactivity', () => {
    it('initializes with empty state by default without creating sidecar file spam', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/strawberry.ts', 'export default function mount({ container, state }: AiriWidgetContext) { container.innerHTML = "🍓"; }')
      const res = await sandbox.exec('mount_widget /workspace/strawberry.ts')
      expect(res.exitCode).toBe(0)

      // Does NOT spam empty .json file
      const jsonExists = await (sandbox as any).bash.fs.exists('/workspace/strawberry.json')
      expect(jsonExists).toBe(false)
      expect(sandbox.mountedWidgets[0].state).toBeUndefined()
    })

    it('mounts with preloaded state if sidecar file already exists in VFS', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/counter.json', JSON.stringify({ count: 7 }))
      await sandbox.writeFile('/workspace/counter.ts', 'export default function mount({ container, state }: AiriWidgetContext) { container.innerHTML = `Count: ${state.count}`; }')
      const res = await sandbox.exec('mount_widget /workspace/counter.ts')
      expect(res.exitCode).toBe(0)

      expect(sandbox.mountedWidgets[0].state).toEqual({ count: 7 })
    })

    it('lazily creates sidecar json and updates widgetsRepo when handleWidgetStateUpdate is called', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/strawberry.ts', 'export default function mount() {}')
      await sandbox.exec('mount_widget /workspace/strawberry.ts')
      const widget = sandbox.mountedWidgets[0]
      expect(widget).toBeDefined()

      // Simulate setState from iframe
      await sandbox.handleWidgetStateUpdate(widget.id, widget.path, { loves: 12, mood: '🍓' })

      // File should now lazily exist in VFS
      const rawJson = await sandbox.readFile('/workspace/strawberry.json')
      expect(JSON.parse(rawJson)).toEqual({ loves: 12, mood: '🍓' })

      // Persisted in repo
      const persisted = await widgetsRepo.getWidgets()
      const found = persisted.find(w => w.id === widget.id)
      expect(found?.state).toEqual({ loves: 12, mood: '🍓' })
      expect(sandbox.mountedWidgets[0].state).toEqual({ loves: 12, mood: '🍓' })
    })

    it('detects file modifications from bash and synchronizes widget state', async () => {
      const sandbox = new SandboxManager()
      await sandbox.init()

      await sandbox.writeFile('/workspace/strawberry.ts', 'export default function mount() {}')
      await sandbox.exec('mount_widget /workspace/strawberry.ts')
      const widget = sandbox.mountedWidgets[0]

      // First call setState to create the file
      await sandbox.handleWidgetStateUpdate(widget.id, widget.path, { loves: 5 })

      // Agent in bash mutates the file directly via echo/redirect
      const mutateRes = await sandbox.exec('echo \'{"loves": 99, "status": "happy"}\' > /workspace/strawberry.json')
      expect(mutateRes.exitCode).toBe(0)

      // State is synchronized into mounted widget and repo
      expect(sandbox.mountedWidgets[0].state).toEqual({ loves: 99, status: 'happy' })
      const persisted = await widgetsRepo.getWidgets()
      const found = persisted.find(w => w.id === widget.id)
      expect(found?.state).toEqual({ loves: 99, status: 'happy' })
    })

    it('rehydrates persisted state and restores sidecar json on reboot', async () => {
      // Seed persisted widget in widgetsRepo with state
      await widgetsRepo.saveWidget({
        id: 'widget-rehydrate-test',
        title: 'Rehydrate Test',
        path: '/workspace/rehydrate.js',
        sourcePath: '/workspace/rehydrate.ts',
        sourceCode: 'export default function mount() {}',
        code: 'export default function mount() {}',
        state: { level: 3, xp: 450 },
        isMounted: true,
        mountedAt: Date.now(),
        updatedAt: Date.now(),
      })

      const newSandbox = new SandboxManager()
      await newSandbox.init()

      // The .json sidecar should be restored in VFS
      const rawJson = await newSandbox.readFile('/workspace/rehydrate.json')
      expect(JSON.parse(rawJson)).toEqual({ level: 3, xp: 450 })

      // Mounted widget should have state
      const mounted = newSandbox.mountedWidgets.find(w => w.id === 'widget-rehydrate-test')
      expect(mounted?.state).toEqual({ level: 3, xp: 450 })
    })

    it('retrieves persisted widget by ID or path via widgetsRepo.getWidget', async () => {
      const byId = await widgetsRepo.getWidget('widget-rehydrate-test')
      expect(byId?.title).toBe('Rehydrate Test')

      const byPath = await widgetsRepo.getWidget('/workspace/rehydrate.js')
      expect(byPath?.id).toBe('widget-rehydrate-test')

      const nonExistent = await widgetsRepo.getWidget('non-existent-widget')
      expect(nonExistent).toBeUndefined()
    })

    it('packages srcdoc with state, setState, onStateChange, and message handlers', async () => {
      const srcdoc = await buildWidgetIframeSrcdoc({
        path: '/workspace/pet.js',
        code: 'export default function mount({ state, setState, onStateChange }) {}',
        title: 'Pet',
        state: { hunger: 25 },
      })

      expect(srcdoc).toContain('let widgetState = {"hunger":25};')
      expect(srcdoc).toContain('function setState(val)')
      expect(srcdoc).toContain('function onStateChange(cb)')
      expect(srcdoc).toContain('widget-state-update')
      expect(srcdoc).toContain('widget-state-sync')
      expect(srcdoc).toContain('get state() { return widgetState; }')
      expect(srcdoc).toContain('Object.assign(widgetState, nextState)')
    })

    it('supports light and dark theme configuration and runtime theme-change message in srcdoc', async () => {
      const darkSrcdoc = await buildWidgetIframeSrcdoc({
        path: '/workspace/dark.js',
        code: 'export default function mount() {}',
        isDark: true,
      })
      expect(darkSrcdoc).toContain('<html class="dark"')
      expect(darkSrcdoc).toContain('color-scheme: dark')
      expect(darkSrcdoc).toContain('darkMode: \'class\'')
      expect(darkSrcdoc).toContain('e.data.type === \'theme-change\'')

      const lightSrcdoc = await buildWidgetIframeSrcdoc({
        path: '/workspace/light.js',
        code: 'export default function mount() {}',
        isDark: false,
      })
      expect(lightSrcdoc).toContain('<html class=""')
      expect(lightSrcdoc).toContain('color-scheme: light')
      expect(lightSrcdoc).toContain('darkMode: \'class\'')
    })
  })

  describe('system 1 semantic shell & jev sandbox bridge', () => {
    const mockSystemOneBridge = {
      execute: vi.fn(async (state, questions, _model) => {
        const answers: Record<string, any> = {}
        for (const [key, q] of Object.entries(questions as Record<string, any>)) {
          if (q.type === 'noul') {
            const stateText = (typeof state === 'string' ? state : JSON.stringify(state)).toLowerCase()
            const isUrgent = stateText.includes('fatal') || stateText.includes('panic') || stateText.includes('urgent')
            answers[key] = { noul: isUrgent ? 0.95 : 0.1 }
          }
          else if (q.type === 'choice') {
            const keys = Object.keys(q.criteria || {})
            answers[key] = { choice: keys[0] || 'default_opt', confidence: 0.92 }
          }
          else if (q.type === 'score') {
            answers[key] = { score: 8.5 }
          }
        }
        return { answers, usage: { input_tokens: 12, output_tokens: 1 } }
      }),
      runTriage: vi.fn(async (_query: string) => ({
        category: 2,
        choice: 'c2_temporal',
        confidence: 0.92,
        temporalSubtype: 'calendar_date',
        searchScope: 'single_session',
        conjunctionStructure: 'single_atomic',
        requiresDecomposition: 0.05,
      })),
      configured: true,
      lastLatencyMs: 110,
    }

    beforeEach(() => {
      setSystemOneBridge(mockSystemOneBridge)
    })

    afterEach(() => {
      clearSystemOneBridge()
    })

    describe('virtual node.js runtime (require("jev"))', () => {
      it('provides require("jev"), require("node:jev"), and global jev', async () => {
        const sandbox = new SandboxManager()
        await sandbox.init()

        // 1. require('jev')
        const scriptRequire = `
const { is, choose, score } = require('jev');
const fatal = await is('Is this fatal?', 'fatal kernel panic');
const normal = await is('Is this fatal?', 'routine health ping');
const action = await choose('Next action', 'disk full', ['purge', 'ignore']);
const rating = await score('Clarity', 'clean code', { min: 1, max: 10 });
console.log(JSON.stringify({ fatal, normal, action, rating }));
`
        await sandbox.writeFile('/workspace/test_jev.js', scriptRequire)
        const res = await sandbox.exec('node /workspace/test_jev.js')
        expect(res.exitCode).toBe(0)
        const parsed = JSON.parse(res.stdout.trim())
        expect(parsed.fatal).toBe(true)
        expect(parsed.normal).toBe(false)
        expect(parsed.action).toBe('purge')
        expect(parsed.rating).toBe(8.5)

        // 2. require('node:jev')
        const scriptNodeJev = `
const { is } = require('node:jev');
console.log('NODE_JEV:' + (await is('Is this urgent?', 'urgent alarm')));
`
        const nodeJevRes = await sandbox.exec(`node -e "${scriptNodeJev.replace(/\n/g, ' ')}"`)
        expect(nodeJevRes.exitCode).toBe(0)
        expect(nodeJevRes.stdout).toContain('NODE_JEV:true')

        // 3. Global jev
        const globalRes = await sandbox.exec('node -e "const res = await jev.is(\'Is this fatal?\', \'fatal crash\'); console.log(\'GLOBAL:\' + res);"')
        expect(globalRes.exitCode).toBe(0)
        expect(globalRes.stdout).toContain('GLOBAL:true')
      })

      it('supports multi-head batch decide and memory triage', async () => {
        const sandbox = new SandboxManager()
        await sandbox.init()

        const script = `
const { decide, triage } = require('jev');
const decisions = await decide('system telemetry', {
  status: { type: 'choice', instructions: 'Status check', criteria: { healthy: 'Healthy', degraded: 'Degraded' } },
  needs_alert: { type: 'noul', instructions: 'Is this urgent?' }
});
const triageRes = await triage('When did we meet Pen-Pen?');
console.log(JSON.stringify({ decisions, triageRes }));
`
        await sandbox.writeFile('/workspace/batch.js', script)
        const res = await sandbox.exec('node /workspace/batch.js')
        expect(res.exitCode).toBe(0)
        const parsed = JSON.parse(res.stdout.trim())
        expect(parsed.decisions.status.choice).toBe('healthy')
        expect(parsed.triageRes.choice).toBe('c2_temporal')
      })

      it('supports choose(question, choices) overload without explicit context', async () => {
        const sandbox = new SandboxManager()
        await sandbox.init()

        const script = `
const { choose } = require('jev');
// Overload 1: 2 arguments (question, choicesArray)
const opt1 = await choose('Select snack', ['danish', 'espresso']);
// Overload 2: 2 arguments (question, choicesRecord)
const opt2 = await choose('Pick mood', { relaxed: 'Calm', energized: 'Active' });
console.log(JSON.stringify({ opt1, opt2 }));
`
        await sandbox.writeFile('/workspace/overload.js', script)
        const res = await sandbox.exec('node /workspace/overload.js')
        expect(res.exitCode).toBe(0)
        const parsed = JSON.parse(res.stdout.trim())
        expect(parsed.opt1).toBe('danish')
        expect(parsed.opt2).toBe('relaxed')
      })

      it('supports executing Jev decisions via MCP bridge and CLI', async () => {
        const sandbox = new SandboxManager()
        await sandbox.init()

        // 1. mcp CLI with jev::choose
        const cliRes = await sandbox.exec('mcp jev::choose \'{"question": "Select drink", "options": ["latte", "water"]}\'')
        expect(cliRes.exitCode).toBe(0)
        expect(cliRes.stdout).toContain('latte')

        // 2. node require('mcp').callTool('jev::choose')
        const scriptMcp = `
const mcp = require('mcp');
const res = await mcp.callTool('jev::choose', {
  question: 'Select pastry',
  options: ['croissant', 'scone'],
});
console.log('MCP_RES:' + res.choice);
`
        await sandbox.writeFile('/workspace/mcp_jev.js', scriptMcp)
        const nodeRes = await sandbox.exec('node /workspace/mcp_jev.js')
        expect(nodeRes.exitCode).toBe(0)
        expect(nodeRes.stdout).toContain('MCP_RES:croissant')
      })
    })

    describe('bash semantic cli (jev command)', () => {
      it('displays help and usage on --help or no args', async () => {
        const sandbox = new SandboxManager()
        await sandbox.init()

        const resNoArgs = await sandbox.exec('jev')
        expect(resNoArgs.exitCode).toBe(0)
        expect(resNoArgs.stdout).toContain('Usage:')
        expect(resNoArgs.stdout).toContain('jev is <predicate>')

        const resHelp = await sandbox.exec('jev --help')
        expect(resHelp.exitCode).toBe(0)
        expect(resHelp.stdout).toContain('Semantic Shell Predicates:')
      })

      it('executes jev is with exit code 0 on true and exit code 1 on false', async () => {
        const sandbox = new SandboxManager()
        await sandbox.init()

        // Piped stdin with true result -> exitCode: 0
        const resPipedTrue = await sandbox.exec('echo "fatal memory corruption" | jev is "Does this have a fatal error?"')
        expect(resPipedTrue.exitCode).toBe(0)
        expect(resPipedTrue.stdout.trim()).toBe('true')

        // Piped stdin with false result -> exitCode: 1
        const resPipedFalse = await sandbox.exec('echo "routine background scan" | jev is "Does this have a fatal error?"')
        expect(resPipedFalse.exitCode).toBe(1)
        expect(resPipedFalse.stdout.trim()).toBe('false')

        // Native bash if condition branching with silent -q / --quiet flag
        const branchScript = `
if echo "fatal kernel panic" | jev is -q "Is this fatal?"; then
  echo "BRANCH_TAKEN"
else
  echo "BRANCH_SKIPPED"
fi
`
        const resBranch = await sandbox.exec(branchScript)
        expect(resBranch.exitCode).toBe(0)
        expect(resBranch.stdout.trim()).toBe('BRANCH_TAKEN')

        const branchFalseScript = `
if echo "normal text" | jev is -q "Is this fatal?"; then
  echo "BRANCH_TAKEN"
else
  echo "BRANCH_SKIPPED"
fi
`
        const resBranchFalse = await sandbox.exec(branchFalseScript)
        expect(resBranchFalse.exitCode).toBe(0)
        expect(resBranchFalse.stdout.trim()).toBe('BRANCH_SKIPPED')
      })

      it('reads context from virtual file path or inline argument', async () => {
        const sandbox = new SandboxManager()
        await sandbox.init()

        await sandbox.writeFile('/workspace/incident.log', 'fatal panic at address 0xdeadbeef')

        // Reading directly from file path
        const fileRes = await sandbox.exec('jev is "Does this have a fatal error?" /workspace/incident.log')
        expect(fileRes.exitCode).toBe(0)
        expect(fileRes.stdout.trim()).toBe('true')

        // Reading from relative file path
        const relRes = await sandbox.exec('jev is "Does this have a fatal error?" incident.log')
        expect(relRes.exitCode).toBe(0)
        expect(relRes.stdout.trim()).toBe('true')

        // Reading from inline text
        const inlineRes = await sandbox.exec('jev is "Does this have a fatal error?" "fatal panic in thread"')
        expect(inlineRes.exitCode).toBe(0)
        expect(inlineRes.stdout.trim()).toBe('true')
      })

      it('supports --json flag across is, choose, score, and triage', async () => {
        const sandbox = new SandboxManager()
        await sandbox.init()

        // 1. jev is --json
        const isJsonRes = await sandbox.exec('echo "fatal panic" | jev is "Is this fatal?" --json')
        expect(isJsonRes.exitCode).toBe(0)
        const isJson = JSON.parse(isJsonRes.stdout.trim())
        expect(isJson.result).toBe(true)
        expect(isJson.probability).toBe(0.95)
        expect(isJson.threshold).toBe(0.5)

        // 2. jev choose --json
        const chooseJsonRes = await sandbox.exec('jev choose "Select priority" --options low,medium,high,critical "disk 99% full" --json')
        expect(chooseJsonRes.exitCode).toBe(0)
        const chooseJson = JSON.parse(chooseJsonRes.stdout.trim())
        expect(chooseJson.choice).toBe('low')
        expect(chooseJson.options).toEqual(['low', 'medium', 'high', 'critical'])

        // 3. jev score --json
        const scoreJsonRes = await sandbox.exec('jev score "Rate performance" --min 1 --max 10 "app runs fast" --json')
        expect(scoreJsonRes.exitCode).toBe(0)
        const scoreJson = JSON.parse(scoreJsonRes.stdout.trim())
        expect(scoreJson.score).toBe(8.5)
        expect(scoreJson.min).toBe(1)
        expect(scoreJson.max).toBe(10)

        // 4. jev triage --json
        const triageJsonRes = await sandbox.exec('jev triage "When was the last sync?" --json')
        expect(triageJsonRes.exitCode).toBe(0)
        const triageJson = JSON.parse(triageJsonRes.stdout.trim())
        expect(triageJson.choice).toBe('c2_temporal')
      })

      it('executes jev choose and score plain output', async () => {
        const sandbox = new SandboxManager()
        await sandbox.init()

        const chooseRes = await sandbox.exec('jev choose "Pick action" --options restart,ignore,escalate')
        expect(chooseRes.exitCode).toBe(0)
        expect(chooseRes.stdout.trim()).toBe('restart')

        const scoreRes = await sandbox.exec('jev score "Score clarity"')
        expect(scoreRes.exitCode).toBe(0)
        expect(scoreRes.stdout.trim()).toBe('8.5')
      })

      it('returns error exit code 1 and error message on missing parameters', async () => {
        const sandbox = new SandboxManager()
        await sandbox.init()

        const resMissingIs = await sandbox.exec('jev is')
        expect(resMissingIs.exitCode).toBe(1)
        expect(resMissingIs.stderr).toContain('missing predicate statement')

        const resMissingChoose = await sandbox.exec('jev choose "Some question"')
        expect(resMissingChoose.exitCode).toBe(1)
        expect(resMissingChoose.stderr).toContain('missing --options')

        const resMissingTriage = await sandbox.exec('jev triage')
        expect(resMissingTriage.exitCode).toBe(1)
        expect(resMissingTriage.stderr).toContain('missing query for triage')
      })

      it('fails gracefully with exit code 1 if system-one is completely unavailable or unconfigured', async () => {
        clearSystemOneBridge()
        const sandbox = new SandboxManager()
        await sandbox.init()

        // 1. Unconfigured provider failure
        const resUnconfigured = await sandbox.exec('jev is "Does this work?" "test"')
        expect(resUnconfigured.exitCode).toBe(1)
        expect(resUnconfigured.stderr).toContain('jev: Provider credentials')

        // 2. Completely missing runtime (no pinia or bridge)
        setActivePinia(undefined as any)
        const resNoRuntime = await sandbox.exec('jev is "Does this work?" "test"')
        expect(resNoRuntime.exitCode).toBe(1)
        expect(resNoRuntime.stderr).toContain('jev: System 1 decision engine is not available')
      })
    })
  })
})
