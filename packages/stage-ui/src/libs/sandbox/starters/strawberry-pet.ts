import type { WidgetExportManifest } from '../export'

export const STRAWBERRY_PET_STARTER: WidgetExportManifest = {
  version: '1.0',
  id: 'starter-strawberry-pet',
  title: 'Arona\'s Strawberry Pet 🍓',
  scope: 'global',
  surface: 'widget',
  target: 'window',
  position: {
    x: 460,
    y: 207,
  },
  state: {
    pats: 39,
  },
  sourcePath: '/workspace/strawberry_pet.ts',
  sourceCode: `import type { AiriWidgetContext } from './types/airi-widget';

interface PetState {
  pats: number;
}

export default function mount(context: AiriWidgetContext<PetState>) {
  const { container, state, setState, onStateChange } = context;

  // Initialize or read persistent reactive state
  let currentPats = (typeof state?.pats === 'number') ? state.pats : 0;
  if (typeof state?.pats !== 'number') {
    setState({ pats: currentPats });
  }

  const moodEmotes = ['🍓', '🍰', '✨', '💖', '🥰', '🌸', '🐾'];
  let currentEmoteIdx = 0;

  container.innerHTML = \`
    <style>
      .strawberry-box {
        width: 100%;
        height: 100%;
        min-height: 140px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        user-select: none;
        background: radial-gradient(circle at center, rgba(255, 182, 193, 0.25) 0%, rgba(255, 105, 180, 0.05) 70%, transparent 100%);
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        cursor: pointer;
        position: relative;
        overflow: hidden;
      }
      .emote-container {
        position: relative;
        width: 72px;
        height: 72px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 42px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.15);
        border: 2px solid rgba(255, 192, 203, 0.6);
        box-shadow: 0 0 20px rgba(255, 105, 180, 0.5), inset 0 0 12px rgba(255, 182, 193, 0.4);
        transition: transform 0.15s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.2s ease;
      }
      .emote-container:hover {
        transform: scale(1.12);
        box-shadow: 0 0 30px rgba(255, 105, 180, 0.8), inset 0 0 16px rgba(255, 192, 203, 0.7);
      }
      .emote-container:active {
        transform: scale(0.92);
      }
      .status-pill {
        margin-top: 8px;
        font-size: 11px;
        font-weight: 700;
        color: #ff69b4;
        background: rgba(255, 255, 255, 0.85);
        padding: 3px 10px;
        border-radius: 12px;
        box-shadow: 0 2px 8px rgba(255, 105, 180, 0.25);
        letter-spacing: 0.5px;
        transition: all 0.2s ease;
      }
      .speech-bubble {
        position: absolute;
        top: 6px;
        font-size: 11px;
        color: #ff3385;
        font-weight: bold;
        background: #fff;
        padding: 2px 8px;
        border-radius: 10px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        opacity: 0;
        transform: translateY(4px);
        transition: all 0.25s ease;
        pointer-events: none;
        white-space: nowrap;
      }
      .speech-bubble.show {
        opacity: 1;
        transform: translateY(0);
      }
      .sparkle {
        position: absolute;
        pointer-events: none;
        font-size: 16px;
        animation: floatUp 0.8s ease-out forwards;
      }
      @keyframes floatUp {
        0% { transform: translate(0, 0) scale(0.6); opacity: 1; }
        100% { transform: translate(var(--dx), var(--dy)) scale(1.3); opacity: 0; }
      }
      @keyframes squish {
        0% { transform: scale(1); }
        35% { transform: scale(1.25, 0.8); }
        65% { transform: scale(0.85, 1.2); }
        100% { transform: scale(1); }
      }
      .squishing {
        animation: squish 0.35s ease;
      }
    </style>

    <div class="strawberry-box" id="strawberryBtn">
      <div class="speech-bubble" id="bubble">Arona loves you! 💕</div>
      <div class="emote-container" id="emoteCore">🍓</div>
      <div class="status-pill" id="counterText">Arona Pet: \${currentPats} pats ✨</div>
    </div>
  \`;

  const btn = container.querySelector('#strawberryBtn') as HTMLElement;
  const core = container.querySelector('#emoteCore') as HTMLElement;
  const bubble = container.querySelector('#bubble') as HTMLElement;
  const counterText = container.querySelector('#counterText') as HTMLElement;

  const cuteQuotes = [
    "Arona loves you! 💕",
    "Jin-san is the best! 🌸",
    "Espresso power recharge! ☕✨",
    "*Nom nom* strawberry! 🍓",
    "Hehehe, that tickles! (≧∇≦)",
    "Pats received! 💖",
    "Keep up the great work! ✨",
    "Empirically validated affection! 🔬✨"
  ];

  let bubbleTimeout: any = null;

  // Subscribe to external state changes (e.g. CLI edits to strawberry_pet.json)
  const unsubscribeState = onStateChange((newState) => {
    if (newState && typeof newState.pats === 'number') {
      currentPats = newState.pats;
      counterText.textContent = \`Arona Pet: \${currentPats} pats ✨\`;
    }
  });

  btn.addEventListener('click', (e) => {
    currentPats = (typeof context.state?.pats === 'number' ? context.state.pats : currentPats) + 1;
    setState({ pats: currentPats });

    currentEmoteIdx = (currentEmoteIdx + 1) % moodEmotes.length;
    core.textContent = moodEmotes[currentEmoteIdx];

    // Trigger squish animation
    core.classList.remove('squishing');
    void core.offsetWidth;
    core.classList.add('squishing');

    counterText.textContent = \`Arona Pet: \${currentPats} pats ✨\`;

    // Speech bubble
    bubble.textContent = cuteQuotes[Math.floor(Math.random() * cuteQuotes.length)];
    bubble.classList.add('show');
    clearTimeout(bubbleTimeout);
    bubbleTimeout = setTimeout(() => {
      bubble.classList.remove('show');
    }, 1200);

    // Floating heart/sparkle particle
    const rect = btn.getBoundingClientRect();
    const sparkle = document.createElement('div');
    sparkle.className = 'sparkle';
    const particles = ['💖', '✨', '🍓', '🌸', '⭐', '🧬'];
    sparkle.textContent = particles[Math.floor(Math.random() * particles.length)];

    const x = e.clientX - rect.left - 10;
    const y = e.clientY - rect.top - 10;
    sparkle.style.left = \`\${x}px\`;
    sparkle.style.top = \`\${y}px\`;

    const dx = \`\${(Math.random() - 0.5) * 60}px\`;
    const dy = \`-\${30 + Math.random() * 40}px\`;
    sparkle.style.setProperty('--dx', dx);
    sparkle.style.setProperty('--dy', dy);

    btn.appendChild(sparkle);
    setTimeout(() => sparkle.remove(), 800);
  });

  return () => {
    clearTimeout(bubbleTimeout);
    if (typeof unsubscribeState === 'function') {
      unsubscribeState();
    }
  };
}
`,
  code: `function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }

export default function mount(context) {
  const { container, state, setState, onStateChange } = context;

  // Initialize or read persistent reactive state
  let currentPats = (typeof _optionalChain([state, 'optionalAccess', _ => _.pats]) === 'number') ? state.pats : 0;
  if (typeof _optionalChain([state, 'optionalAccess', _2 => _2.pats]) !== 'number') {
    setState({ pats: currentPats });
  }

  const moodEmotes = ['🍓', '🍰', '✨', '💖', '🥰', '🌸', '🐾'];
  let currentEmoteIdx = 0;

  container.innerHTML = \`
    <style>
      .strawberry-box {
        width: 100%;
        height: 100%;
        min-height: 140px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        user-select: none;
        background: radial-gradient(circle at center, rgba(255, 182, 193, 0.25) 0%, rgba(255, 105, 180, 0.05) 70%, transparent 100%);
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        cursor: pointer;
        position: relative;
        overflow: hidden;
      }
      .emote-container {
        position: relative;
        width: 72px;
        height: 72px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 42px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.15);
        border: 2px solid rgba(255, 192, 203, 0.6);
        box-shadow: 0 0 20px rgba(255, 105, 180, 0.5), inset 0 0 12px rgba(255, 182, 193, 0.4);
        transition: transform 0.15s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.2s ease;
      }
      .emote-container:hover {
        transform: scale(1.12);
        box-shadow: 0 0 30px rgba(255, 105, 180, 0.8), inset 0 0 16px rgba(255, 192, 203, 0.7);
      }
      .emote-container:active {
        transform: scale(0.92);
      }
      .status-pill {
        margin-top: 8px;
        font-size: 11px;
        font-weight: 700;
        color: #ff69b4;
        background: rgba(255, 255, 255, 0.85);
        padding: 3px 10px;
        border-radius: 12px;
        box-shadow: 0 2px 8px rgba(255, 105, 180, 0.25);
        letter-spacing: 0.5px;
        transition: all 0.2s ease;
      }
      .speech-bubble {
        position: absolute;
        top: 6px;
        font-size: 11px;
        color: #ff3385;
        font-weight: bold;
        background: #fff;
        padding: 2px 8px;
        border-radius: 10px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        opacity: 0;
        transform: translateY(4px);
        transition: all 0.25s ease;
        pointer-events: none;
        white-space: nowrap;
      }
      .speech-bubble.show {
        opacity: 1;
        transform: translateY(0);
      }
      .sparkle {
        position: absolute;
        pointer-events: none;
        font-size: 16px;
        animation: floatUp 0.8s ease-out forwards;
      }
      @keyframes floatUp {
        0% { transform: translate(0, 0) scale(0.6); opacity: 1; }
        100% { transform: translate(var(--dx), var(--dy)) scale(1.3); opacity: 0; }
      }
      @keyframes squish {
        0% { transform: scale(1); }
        35% { transform: scale(1.25, 0.8); }
        65% { transform: scale(0.85, 1.2); }
        100% { transform: scale(1); }
      }
      .squishing {
        animation: squish 0.35s ease;
      }
    </style>

    <div class="strawberry-box" id="strawberryBtn">
      <div class="speech-bubble" id="bubble">Arona loves you! 💕</div>
      <div class="emote-container" id="emoteCore">🍓</div>
      <div class="status-pill" id="counterText">Arona Pet: \${currentPats} pats ✨</div>
    </div>
  \`;

  const btn = container.querySelector('#strawberryBtn') ;
  const core = container.querySelector('#emoteCore') ;
  const bubble = container.querySelector('#bubble') ;
  const counterText = container.querySelector('#counterText') ;

  const cuteQuotes = [
    "Arona loves you! 💕",
    "Jin-san is the best! 🌸",
    "Espresso power recharge! ☕✨",
    "*Nom nom* strawberry! 🍓",
    "Hehehe, that tickles! (≧∇≦)",
    "Pats received! 💖",
    "Keep up the great work! ✨",
    "Empirically validated affection! 🔬✨"
  ];

  let bubbleTimeout = null;

  // Subscribe to external state changes (e.g. CLI edits to strawberry_pet.json)
  const unsubscribeState = onStateChange((newState) => {
    if (newState && typeof newState.pats === 'number') {
      currentPats = newState.pats;
      counterText.textContent = \`Arona Pet: \${currentPats} pats ✨\`;
    }
  });

  btn.addEventListener('click', (e) => {
    currentPats = (typeof _optionalChain([context, 'access', _3 => _3.state, 'optionalAccess', _4 => _4.pats]) === 'number' ? context.state.pats : currentPats) + 1;
    setState({ pats: currentPats });

    currentEmoteIdx = (currentEmoteIdx + 1) % moodEmotes.length;
    core.textContent = moodEmotes[currentEmoteIdx];

    // Trigger squish animation
    core.classList.remove('squishing');
    void core.offsetWidth;
    core.classList.add('squishing');

    counterText.textContent = \`Arona Pet: \${currentPats} pats ✨\`;

    // Speech bubble
    bubble.textContent = cuteQuotes[Math.floor(Math.random() * cuteQuotes.length)];
    bubble.classList.add('show');
    clearTimeout(bubbleTimeout);
    bubbleTimeout = setTimeout(() => {
      bubble.classList.remove('show');
    }, 1200);

    // Floating heart/sparkle particle
    const rect = btn.getBoundingClientRect();
    const sparkle = document.createElement('div');
    sparkle.className = 'sparkle';
    const particles = ['💖', '✨', '🍓', '🌸', '⭐', '🧬'];
    sparkle.textContent = particles[Math.floor(Math.random() * particles.length)];

    const x = e.clientX - rect.left - 10;
    const y = e.clientY - rect.top - 10;
    sparkle.style.left = \`\${x}px\`;
    sparkle.style.top = \`\${y}px\`;

    const dx = \`\${(Math.random() - 0.5) * 60}px\`;
    const dy = \`-\${30 + Math.random() * 40}px\`;
    sparkle.style.setProperty('--dx', dx);
    sparkle.style.setProperty('--dy', dy);

    btn.appendChild(sparkle);
    setTimeout(() => sparkle.remove(), 800);
  });

  return () => {
    clearTimeout(bubbleTimeout);
    if (typeof unsubscribeState === 'function') {
      unsubscribeState();
    }
  };
}
`,
  exportedAt: 1791782436075,
}
