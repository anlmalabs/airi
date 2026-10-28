import type { WidgetExportManifest } from '../export'

export const LIVE2D_MENU_DRIVER_STARTER: WidgetExportManifest = {
  version: '1.0',
  id: 'starter-live2d-menu-driver',
  title: 'Live2D Controller (Generic) 🎮',
  scope: 'global',
  surface: 'panel',
  target: 'sidepanel',
  state: {
    activeStance: null,
    lastDispatch: null,
  },
  sourcePath: '/workspace/live2d_menu_driver.ts',
  sourceCode: `import type { AiriWidgetContext } from './types/airi-widget';

export interface Live2dWidgetSkin {
  title?: string;
  subtitle?: string;
  accentColor?: 'emerald' | 'cyan' | 'amber' | 'rose' | 'violet';
  customTrackTitles?: Record<string, string>;
  customGroupLabels?: Record<string, string>;
  poseAnchorMotion?: string;
}

interface DriverState {
  skin?: Live2dWidgetSkin;
  activeStance?: string | null;
  lastDispatch?: string | null;
  [key: string]: any;
}

const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c] || c);

export default function mount(context: AiriWidgetContext<DriverState>) {
  const { container, sidecar, state, setState, onStateChange, onUpdate } = context;

  let currentSidecar = sidecar;
  let currentState: DriverState = state || {};

  const root = document.createElement('div');
  root.className = 'live2d-menu-shell p-3 rounded-2xl font-sans text-xs select-none transition-colors duration-200';
  container.appendChild(root);

  function dispatchTarget(target: string) {
    if (!target) return;
    try {
      window.parent.postMessage({
        type: 'airi:live2d:dispatch',
        target,
      }, '*');
    } catch {}

    setState(prev => ({
      ...prev,
      lastDispatch: target,
      dispatchedAt: Date.now(),
    }));
  }

  function dispatchRawCommand(command: string) {
    if (!command) return;
    try {
      window.parent.postMessage({
        type: 'airi:live2d:command',
        command,
      }, '*');
    } catch {}

    setState(prev => ({
      ...prev,
      lastDispatch: command,
      dispatchedAt: Date.now(),
    }));
  }

  function render() {
    const live2d = (currentSidecar as any)?.live2d;
    const skin: Live2dWidgetSkin = currentState?.skin || {};

    const accent = skin.accentColor || 'cyan';
    const accentClass = accent === 'emerald'
      ? 'text-emerald-400 border-emerald-500/30'
      : accent === 'amber'
      ? 'text-amber-400 border-amber-500/30'
      : accent === 'rose'
      ? 'text-rose-400 border-rose-500/30'
      : accent === 'violet'
      ? 'text-violet-400 border-violet-500/30'
      : 'text-cyan-400 border-cyan-500/30';

    const hasModel = Boolean(live2d?.hasModel || live2d?.modelId);

    if (!hasModel && !live2d?.hasDsl) {
      root.innerHTML = \`
        <div class="text-center py-6 px-3 border border-neutral-800/80 rounded-xl bg-neutral-900/40 text-neutral-400">
          <div class="text-2xl mb-1">🎮</div>
          <div class="font-bold text-neutral-200 mb-0.5">\${esc(skin.title || 'Live2D Controller')}</div>
          <div class="text-[11px] text-neutral-500">Awaiting active Live2D model...</div>
        </div>
      \`;
      return;
    }

    const title = skin.title || live2d.modelId || 'Live2D Model';
    const subtitle = skin.subtitle || (live2d.activeMotion ? \`Motion: \${live2d.activeMotion.group}\` : 'Gimmick Deck Active');

    // Extract hit areas
    const enabledSet = new Set(Array.isArray(live2d.enabledHitAreas) ? live2d.enabledHitAreas : []);
    const hitAreas: Array<{ name: string; id?: string; motion?: string; enabled?: boolean }> =
      Array.isArray(live2d.hitAreas) && live2d.hitAreas.length
        ? live2d.hitAreas
        : Array.from(enabledSet).map(name => ({ name, enabled: true }));

    // Extract sound tracks for Jukebox
    const reactions: Array<{ group: string; text?: string; sound?: string }> =
      Array.isArray(live2d.reactions) ? live2d.reactions : [];

    const audioTracks = reactions.filter(r => r.sound && (r.sound.endsWith('.mp3') || r.sound.endsWith('.wav')));

    // Extract dialogue groups (prefix aggregation)
    const dialogueMap = new Map<string, { group: string; label: string; count: number }>();
    for (const r of reactions) {
      const g = r.group;
      const baseLabel = skin.customGroupLabels?.[g] || r.text || g;
      if (!dialogueMap.has(g)) {
        dialogueMap.set(g, { group: g, label: baseLabel, count: 1 });
      } else {
        dialogueMap.get(g)!.count += 1;
      }
    }
    const dialogueGroups = Array.from(dialogueMap.values());

    root.innerHTML = \`
      <!-- Header HUD -->
      <div class="flex items-center justify-between border-b \${accentClass} pb-2 mb-3">
        <div class="flex items-center gap-2">
          <span class="inline-block w-2 h-2 rounded-full \${hasModel ? 'bg-emerald-400 animate-pulse' : 'bg-neutral-600'}"></span>
          <span class="font-mono font-bold tracking-wider \${accentClass}">\${esc(title)}</span>
        </div>
        <span class="text-[10px] text-neutral-400 font-mono">\${esc(subtitle)}</span>
      </div>

      <!-- Pose Stance Anchor -->
      <div class="rounded-xl bg-neutral-900/60 border border-neutral-800/80 p-2.5 mb-3 flex items-center justify-between">
        <div class="min-w-0 pr-2">
          <div class="font-semibold text-neutral-200 text-[11px]">Stance Anchor</div>
          <div class="text-[9px] text-neutral-500 truncate font-mono">
            \${currentState.activeStance ? esc(currentState.activeStance) : 'Dynamic / Follows Stage'}
          </div>
        </div>
        <button id="anchor-btn" class="px-2.5 py-1 rounded bg-neutral-800 text-[10px] font-semibold text-neutral-200 hover:bg-neutral-700 transition">
          \${currentState.activeStance ? 'Clear' : 'Lock Stance'}
        </button>
      </div>

      <!-- Jukebox Audio Tracks -->
      \${audioTracks.length ? \`
        <div class="mb-3">
          <div class="text-[10px] font-bold tracking-wider uppercase text-neutral-400 mb-1.5 flex items-center justify-between">
            <span>🎵 Audio Tracks (\${audioTracks.length})</span>
            <button id="stop-audio-btn" class="text-[9px] text-neutral-500 hover:text-rose-400 font-mono transition">⏹ Stop</button>
          </div>
          <div class="grid grid-cols-2 gap-1.5 max-h-28 overflow-y-auto pr-1">
            \${audioTracks.map((t, idx) => {
              const display = skin.customTrackTitles?.[t.group] || t.text || t.group;
              return \`
                <button data-track="\${esc(t.group)}" class="track-btn px-2 py-1 rounded bg-neutral-900/80 border border-neutral-800 text-left truncate text-neutral-300 hover:border-cyan-500/50 hover:text-white transition">
                  ▶ \${esc(display)}
                </button>
              \`;
            }).join('')}
          </div>
        </div>
      \` : ''}

      <!-- Interactive Voice Topics -->
      \${dialogueGroups.length ? \`
        <div class="mb-3">
          <div class="text-[10px] font-bold tracking-wider uppercase text-neutral-400 mb-1.5">💬 Voice Topics (\${dialogueGroups.length})</div>
          <div class="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pr-1">
            \${dialogueGroups.map(d => \`
              <button data-group="\${esc(d.group)}" class="topic-btn px-2.5 py-1 rounded-lg bg-neutral-900/80 border border-neutral-800 text-neutral-200 hover:border-cyan-500/40 hover:text-white transition flex items-center gap-1">
                <span>\${esc(d.label)}</span>
                \${d.count > 1 ? \`<span class="text-[9px] text-neutral-500 font-mono">(\${d.count})</span>\` : ''}
              </button>
            \`).join('')}
          </div>
        </div>
      \` : ''}

      <!-- Tactile Hit Areas -->
      \${hitAreas.length ? \`
        <div>
          <div class="text-[10px] font-bold tracking-wider uppercase text-neutral-400 mb-1.5 flex items-center justify-between">
            <span>👆 Tactile Hit Areas (\${hitAreas.length})</span>
            <span class="text-[9px] text-neutral-500 font-mono">\${enabledSet.size} active</span>
          </div>
          <div class="max-h-36 overflow-y-auto pr-1 divide-y divide-neutral-800/40">
            \${hitAreas.map(h => {
              const isEnabled = enabledSet.has(h.name);
              const target = h.motion || h.name;
              return \`
                <div class="flex items-center justify-between gap-1.5 py-1.5">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 text-[11px] text-neutral-200">
                      <span class="inline-block w-1.5 h-1.5 rounded-full shrink-0 \${isEnabled ? 'bg-emerald-400' : 'bg-neutral-600'}"></span>
                      <span class="truncate">\${esc(h.name)}</span>
                    </div>
                    \${h.motion && h.motion !== h.name ? \`<div class="text-[9px] text-neutral-500 font-mono truncate">➔ \${esc(h.motion)}</div>\` : ''}
                  </div>
                  <button data-hit="\${esc(target)}" class="hit-btn px-2 py-0.5 rounded bg-neutral-800 text-[10px] font-semibold text-neutral-300 hover:bg-neutral-700 transition">
                    Trigger
                  </button>
                </div>
              \`;
            }).join('')}
          </div>
        </div>
      \` : ''}
    \`;

    // Wire listeners
    root.querySelector('#anchor-btn')?.addEventListener('click', () => {
      const nextStance = currentState.activeStance ? null : (live2d?.activeMotion?.group || skin.poseAnchorMotion || 'idle');
      setState(prev => ({ ...prev, activeStance: nextStance }));
      if (nextStance) {
        dispatchTarget(nextStance);
      }
    });

    root.querySelector('#stop-audio-btn')?.addEventListener('click', () => {
      dispatchRawCommand('stop_sound 0');
    });

    root.querySelectorAll('.track-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const track = (e.currentTarget as HTMLElement).dataset.track;
        if (track) dispatchTarget(track);
      });
    });

    root.querySelectorAll('.topic-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const group = (e.currentTarget as HTMLElement).dataset.group;
        if (group) dispatchTarget(group);
      });
    });

    root.querySelectorAll('.hit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const hit = (e.currentTarget as HTMLElement).dataset.hit;
        if (hit) dispatchTarget(hit);
      });
    });
  }

  render();

  const unsubState = onStateChange((newState: any) => {
    currentState = newState || {};
    render();
  });

  const unsubSidecar = onUpdate((newSidecar: any) => {
    currentSidecar = newSidecar;
    render();
  });

  return () => {
    unsubState();
    unsubSidecar();
  };
}
`,
  code: `const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
export default function mount(context) {
    const { container, sidecar, state, setState, onStateChange, onUpdate } = context;
    let currentSidecar = sidecar;
    let currentState = state || {};
    const root = document.createElement('div');
    root.className = 'live2d-menu-shell p-3 rounded-2xl font-sans text-xs select-none transition-colors duration-200';
    container.appendChild(root);
    function dispatchTarget(target) {
        if (!target)
            return;
        try {
            window.parent.postMessage({
                type: 'airi:live2d:dispatch',
                target,
            }, '*');
        }
        catch { }
        setState(prev => ({
            ...prev,
            lastDispatch: target,
            dispatchedAt: Date.now(),
        }));
    }
    function dispatchRawCommand(command) {
        if (!command)
            return;
        try {
            window.parent.postMessage({
                type: 'airi:live2d:command',
                command,
            }, '*');
        }
        catch { }
        setState(prev => ({
            ...prev,
            lastDispatch: command,
            dispatchedAt: Date.now(),
        }));
    }
    function render() {
        const live2d = currentSidecar?.live2d;
        const skin = currentState?.skin || {};
        const accent = skin.accentColor || 'cyan';
        const accentClass = accent === 'emerald'
            ? 'text-emerald-400 border-emerald-500/30'
            : accent === 'amber'
                ? 'text-amber-400 border-amber-500/30'
                : accent === 'rose'
                    ? 'text-rose-400 border-rose-500/30'
                    : accent === 'violet'
                        ? 'text-violet-400 border-violet-500/30'
                        : 'text-cyan-400 border-cyan-500/30';
        const hasModel = Boolean(live2d?.hasModel || live2d?.modelId);
        if (!hasModel && !live2d?.hasDsl) {
            root.innerHTML = \`
        <div class="text-center py-6 px-3 border border-neutral-800/80 rounded-xl bg-neutral-900/40 text-neutral-400">
          <div class="text-2xl mb-1">🎮</div>
          <div class="font-bold text-neutral-200 mb-0.5">\${esc(skin.title || 'Live2D Controller')}</div>
          <div class="text-[11px] text-neutral-500">Awaiting active Live2D model...</div>
        </div>
      \`;
            return;
        }
        const title = skin.title || live2d.modelId || 'Live2D Model';
        const subtitle = skin.subtitle || (live2d.activeMotion ? \`Motion: \${live2d.activeMotion.group}\` : 'Gimmick Deck Active');
        const enabledSet = new Set(Array.isArray(live2d.enabledHitAreas) ? live2d.enabledHitAreas : []);
        const hitAreas = Array.isArray(live2d.hitAreas) && live2d.hitAreas.length
            ? live2d.hitAreas
            : Array.from(enabledSet).map(name => ({ name, enabled: true }));
        const reactions = Array.isArray(live2d.reactions) ? live2d.reactions : [];
        const audioTracks = reactions.filter(r => r.sound && (r.sound.endsWith('.mp3') || r.sound.endsWith('.wav')));
        const dialogueMap = new Map();
        for (const r of reactions) {
            const g = r.group;
            const baseLabel = skin.customGroupLabels?.[g] || r.text || g;
            if (!dialogueMap.has(g)) {
                dialogueMap.set(g, { group: g, label: baseLabel, count: 1 });
            }
            else {
                dialogueMap.get(g).count += 1;
            }
        }
        const dialogueGroups = Array.from(dialogueMap.values());
        root.innerHTML = \`
      <div class="flex items-center justify-between border-b \${accentClass} pb-2 mb-3">
        <div class="flex items-center gap-2">
          <span class="inline-block w-2 h-2 rounded-full \${hasModel ? 'bg-emerald-400 animate-pulse' : 'bg-neutral-600'}"></span>
          <span class="font-mono font-bold tracking-wider \${accentClass}">\${esc(title)}</span>
        </div>
        <span class="text-[10px] text-neutral-400 font-mono">\${esc(subtitle)}</span>
      </div>

      <div class="rounded-xl bg-neutral-900/60 border border-neutral-800/80 p-2.5 mb-3 flex items-center justify-between">
        <div class="min-w-0 pr-2">
          <div class="font-semibold text-neutral-200 text-[11px]">Stance Anchor</div>
          <div class="text-[9px] text-neutral-500 truncate font-mono">
            \${currentState.activeStance ? esc(currentState.activeStance) : 'Dynamic / Follows Stage'}
          </div>
        </div>
        <button id="anchor-btn" class="px-2.5 py-1 rounded bg-neutral-800 text-[10px] font-semibold text-neutral-200 hover:bg-neutral-700 transition">
          \${currentState.activeStance ? 'Clear' : 'Lock Stance'}
        </button>
      </div>

      \${audioTracks.length ? \`
        <div class="mb-3">
          <div class="text-[10px] font-bold tracking-wider uppercase text-neutral-400 mb-1.5 flex items-center justify-between">
            <span>🎵 Audio Tracks (\${audioTracks.length})</span>
            <button id="stop-audio-btn" class="text-[9px] text-neutral-500 hover:text-rose-400 font-mono transition">⏹ Stop</button>
          </div>
          <div class="grid grid-cols-2 gap-1.5 max-h-28 overflow-y-auto pr-1">
            \${audioTracks.map((t) => {
            const display = skin.customTrackTitles?.[t.group] || t.text || t.group;
            return \`
                <button data-track="\${esc(t.group)}" class="track-btn px-2 py-1 rounded bg-neutral-900/80 border border-neutral-800 text-left truncate text-neutral-300 hover:border-cyan-500/50 hover:text-white transition">
                  ▶ \${esc(display)}
                </button>
              \`;
        }).join('')}
          </div>
        </div>
      \` : ''}

      \${dialogueGroups.length ? \`
        <div class="mb-3">
          <div class="text-[10px] font-bold tracking-wider uppercase text-neutral-400 mb-1.5">💬 Voice Topics (\${dialogueGroups.length})</div>
          <div class="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pr-1">
            \${dialogueGroups.map(d => \`
              <button data-group="\${esc(d.group)}" class="topic-btn px-2.5 py-1 rounded-lg bg-neutral-900/80 border border-neutral-800 text-neutral-200 hover:border-cyan-500/40 hover:text-white transition flex items-center gap-1">
                <span>\${esc(d.label)}</span>
                \${d.count > 1 ? \`<span class="text-[9px] text-neutral-500 font-mono">(\${d.count})</span>\` : ''}
              </button>
            \`).join('')}
          </div>
        </div>
      \` : ''}

      \${hitAreas.length ? \`
        <div>
          <div class="text-[10px] font-bold tracking-wider uppercase text-neutral-400 mb-1.5 flex items-center justify-between">
            <span>👆 Tactile Hit Areas (\${hitAreas.length})</span>
            <span class="text-[9px] text-neutral-500 font-mono">\${enabledSet.size} active</span>
          </div>
          <div class="max-h-36 overflow-y-auto pr-1 divide-y divide-neutral-800/40">
            \${hitAreas.map(h => {
            const isEnabled = enabledSet.has(h.name);
            const target = h.motion || h.name;
            return \`
                <div class="flex items-center justify-between gap-1.5 py-1.5">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 text-[11px] text-neutral-200">
                      <span class="inline-block w-1.5 h-1.5 rounded-full shrink-0 \${isEnabled ? 'bg-emerald-400' : 'bg-neutral-600'}"></span>
                      <span class="truncate">\${esc(h.name)}</span>
                    </div>
                    \${h.motion && h.motion !== h.name ? \`<div class="text-[9px] text-neutral-500 font-mono truncate">➔ \${esc(h.motion)}</div>\` : ''}
                  </div>
                  <button data-hit="\${esc(target)}" class="hit-btn px-2 py-0.5 rounded bg-neutral-800 text-[10px] font-semibold text-neutral-300 hover:bg-neutral-700 transition">
                    Trigger
                  </button>
                </div>
              \`;
        }).join('')}
          </div>
        </div>
      \` : ''}
    \`;
        root.querySelector('#anchor-btn')?.addEventListener('click', () => {
            const nextStance = currentState.activeStance ? null : (live2d?.activeMotion?.group || skin.poseAnchorMotion || 'idle');
            setState(prev => ({ ...prev, activeStance: nextStance }));
            if (nextStance) {
                dispatchTarget(nextStance);
            }
        });
        root.querySelector('#stop-audio-btn')?.addEventListener('click', () => {
            dispatchRawCommand('stop_sound 0');
        });
        root.querySelectorAll('.track-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const track = e.currentTarget.dataset.track;
                if (track)
                    dispatchTarget(track);
            });
        });
        root.querySelectorAll('.topic-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const group = e.currentTarget.dataset.group;
                if (group)
                    dispatchTarget(group);
            });
        });
        root.querySelectorAll('.hit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const hit = e.currentTarget.dataset.hit;
                if (hit)
                    dispatchTarget(hit);
            });
        });
    }
    render();
    const unsubState = onStateChange((newState) => {
        currentState = newState || {};
        render();
    });
    const unsubSidecar = onUpdate((newSidecar) => {
        currentSidecar = newSidecar;
        render();
    });
    return () => {
        unsubState();
        unsubSidecar();
    };
}
`,
  exportedAt: 1792001000000,
}
