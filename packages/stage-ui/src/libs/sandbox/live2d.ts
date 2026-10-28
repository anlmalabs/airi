export const LIVE2D_DSL_BRIDGE_CHANNEL = 'live2d-dsl-bridge'
export const LIVE2D_PROJECTION_PATH = '/workspace/.airi/live2d.json'

export function postLive2dDispatch(target: string): boolean {
  try {
    if (!target)
      return false
    const channel = new BroadcastChannel(LIVE2D_DSL_BRIDGE_CHANNEL)
    channel.postMessage({ type: 'dsl-widget-dispatch', target })
    channel.close()
    return true
  }
  catch {
    return false
  }
}

export function postLive2dCommand(command: string): boolean {
  try {
    if (!command)
      return false
    const channel = new BroadcastChannel(LIVE2D_DSL_BRIDGE_CHANNEL)
    channel.postMessage({ type: 'dsl-widget-command', command })
    channel.close()
    return true
  }
  catch {
    return false
  }
}

export function parseLive2dProjection(text: string | null | undefined): any | null {
  if (!text)
    return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  }
  catch {
    return null
  }
}

export function formatLive2dState(projection: any): string {
  if (!projection) {
    return 'No Live2D projection yet. Load a Live2D model on stage first.\n'
  }
  const motion = projection.activeMotion
    ? `${projection.activeMotion.group}${projection.activeMotion.index !== undefined ? `:${projection.activeMotion.index}` : ''}`
    : '(none)'
  const lastDispatch = projection.lastDispatch
  const last = lastDispatch
    ? `${lastDispatch.kind} "${lastDispatch.target}"`
    : '(none)'
  const lines = [
    `model: ${projection.modelId || '(unknown)'}${projection.live ? '' : ' [snapshot]'}${projection.hasModel ? '' : ' [no model]'}`,
    `motion: ${motion}`,
    `gates: ${projection.enabledHitAreas?.length ?? 0}/${projection.hitAreasCount ?? 0} open`,
    `last: ${last}`,
    `dsl: ${projection.hasDsl ? 'yes' : 'no'} (${projection.hitAreasCount ?? 0} zones, ${projection.reactionsCount ?? 0} sounds)`,
  ]
  return `${lines.join('\n')}\n`
}

export function formatLive2dHits(projection: any, enabledOnly: boolean): string {
  if (!projection || !Array.isArray(projection.hitAreas) || projection.hitAreas.length === 0) {
    return 'No hit areas discovered yet. Load a creator-scripted Live2D model on stage first.\n'
  }
  const open = new Set(Array.isArray(projection.enabledHitAreas) ? projection.enabledHitAreas : [])
  const rows = projection.hitAreas
    .filter((h: any) => h?.name && (!enabledOnly || open.has(h.name)))
    .map((h: any) => {
      const dot = open.has(h.name) ? '●' : '○'
      const route = h.motion && h.motion !== h.name ? ` -> ${h.motion}` : ''
      return `${dot} ${h.name}${route}`
    })
  if (rows.length === 0)
    return 'All hit areas are currently gated closed.\n'
  return `${rows.join('\n')}\n`
}
