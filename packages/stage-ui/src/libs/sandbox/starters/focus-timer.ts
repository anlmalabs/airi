import type { WidgetExportManifest } from '../export'

export const FOCUS_TIMER_STARTER: WidgetExportManifest = {
  version: '1.0',
  id: 'starter-focus-timer',
  title: 'Focus Timer ⏱️',
  scope: 'global',
  surface: 'panel',
  target: 'sidepanel',
  state: {
    mode: 'focus',
    durationMinutes: 25,
    remainingSeconds: 1500,
    isRunning: false,
    completedSessions: 0,
  },
  sourcePath: '/workspace/focus_timer.ts',
  sourceCode: `interface FocusTimerState {
  mode: 'focus' | 'break';
  durationMinutes: number;
  remainingSeconds: number;
  isRunning: boolean;
  completedSessions: number;
}

const FOCUS_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;
const CIRC = 2 * Math.PI * 88;

const DEFAULTS: FocusTimerState = {
  mode: 'focus',
  durationMinutes: 25,
  remainingSeconds: FOCUS_SECONDS,
  isRunning: false,
  completedSessions: 0,
};

const CSS = \`
.ft{font-family:ui-monospace,Menlo,monospace;display:flex;flex-direction:column;align-items:center;gap:10px;
    padding:16px;border-radius:16px;background:linear-gradient(180deg,#12201a,#0b1411);color:#dff5e6;
    user-select:none;-webkit-user-select:none;touch-action:manipulation}
.ft-ring{position:relative;width:186px;height:186px;cursor:pointer}
.ft-ring svg{width:100%;height:100%;transform:rotate(-90deg);display:block}
.ft-track{fill:none;stroke:#1f3a2e;stroke-width:8}
.ft-bar{fill:none;stroke:#5be0a0;stroke-width:8;stroke-linecap:round;transition:stroke-dashoffset .3s linear,stroke .3s}
.ft-face{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;pointer-events:none}
.ft-mode{font-size:10px;letter-spacing:.2em;color:#7fd6a4}
.ft-time{font-size:38px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.ft-hint{font-size:10px;letter-spacing:.07em;color:#6b8a7a}
.ft-foot{display:flex;align-items:center;gap:12px;font-size:12px;color:#9ec9b1}
.ft-reset{background:#1b2f26;border:1px solid #2c4a3b;color:#bfe7cf;border-radius:8px;
          width:26px;height:26px;cursor:pointer;font-size:12px;line-height:1;padding:0}
.ft-reset:hover{background:#24402f}
.ft.brk .ft-bar{stroke:#f0c46a}
.ft.brk .ft-mode{color:#e8c477}
\`;

export default function mount(ctx: any) {
  const { container, setState, onStateChange } = ctx;
  let s: FocusTimerState = { ...DEFAULTS, ...(ctx.state || {}) };
  let loop: any = null;
  let endAt = 0;
  let pressTimer: any = null;
  let longPressed = false;

  const style = document.createElement('style');
  style.textContent = CSS;

  const wrap = document.createElement('div');
  wrap.className = 'ft';
  wrap.innerHTML = \`
    <div class="ft-ring">
      <svg viewBox="0 0 200 200">
        <circle class="ft-track" cx="100" cy="100" r="88"></circle>
        <circle class="ft-bar" cx="100" cy="100" r="88"></circle>
      </svg>
      <div class="ft-face">
        <div class="ft-mode">FOCUS</div>
        <div class="ft-time">25:00</div>
        <div class="ft-hint">tap to start</div>
      </div>
    </div>
    <div class="ft-foot">
      <span class="ft-sessions">0 sessions</span>
      <button class="ft-reset" title="reset">⟲</button>
    </div>
  \`;

  container.innerHTML = '';
  container.appendChild(style);
  container.appendChild(wrap);

  const q = (sel: string) => wrap.querySelector(sel) as HTMLElement;
  const bar = q('.ft-bar') as unknown as SVGCircleElement;
  bar.style.strokeDasharray = String(CIRC);

  const totalFor = () => (s.mode === 'focus' ? FOCUS_SECONDS : BREAK_SECONDS);

  const fmt = (t: number) =>
    String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');

  function render() {
    const total = totalFor();
    const elapsed = Math.max(0, total - s.remainingSeconds);
    bar.style.strokeDashoffset = String(CIRC * (1 - elapsed / total));

    q('.ft-time').textContent = fmt(s.remainingSeconds);
    q('.ft-mode').textContent = s.mode === 'focus' ? 'FOCUS' : 'BREAK';
    q('.ft-sessions').textContent =
      s.completedSessions + (s.completedSessions === 1 ? ' session' : ' sessions');
    q('.ft-hint').textContent = s.isRunning
      ? 'tap to pause'
      : s.remainingSeconds === total
      ? 'tap to start'
      : 'tap to resume';

    wrap.classList.toggle('brk', s.mode === 'break');
  }

  function persist() {
    try {
      if (typeof setState === 'function') setState({ ...s });
    } catch (e) {
      /* state channel unavailable — UI still ticks locally */
    }
  }

  function stopLoop() {
    if (loop) clearInterval(loop);
    loop = null;
  }

  function startLoop() {
    stopLoop();
    endAt = Date.now() + s.remainingSeconds * 1000;
    loop = setInterval(() => {
      const left = Math.max(0, Math.round((endAt - Date.now()) / 1000));
      if (left === s.remainingSeconds) return;
      s.remainingSeconds = left;
      if (left === 0) complete();
      else {
        persist();
        render();
      }
    }, 200);
  }

  function complete() {
    stopLoop();
    s.isRunning = false;
    if (s.mode === 'focus') {
      s.completedSessions += 1;
      s.mode = 'break';
      s.remainingSeconds = BREAK_SECONDS;
    } else {
      s.mode = 'focus';
      s.remainingSeconds = FOCUS_SECONDS;
    }
    persist();
    render();
  }

  function toggle() {
    if (s.remainingSeconds <= 0) return;
    s.isRunning = !s.isRunning;
    if (s.isRunning) startLoop();
    else stopLoop();
    persist();
    render();
  }

  function reset() {
    stopLoop();
    s.mode = 'focus';
    s.durationMinutes = 25;
    s.remainingSeconds = FOCUS_SECONDS;
    s.isRunning = false;
    persist();
    render();
  }

  const ring = q('.ft-ring');
  ring.addEventListener('pointerdown', () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      reset();
    }, 650);
  });
  const release = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    if (!longPressed) toggle();
  };
  ring.addEventListener('pointerup', release);
  ring.addEventListener('pointerleave', () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  });
  q('.ft-reset').addEventListener('pointerdown', (e) => e.stopPropagation());
  q('.ft-reset').addEventListener('click', reset);

  if (typeof onStateChange === 'function') {
    onStateChange((incoming: any) => {
      const next: FocusTimerState = { ...DEFAULTS, ...(incoming || {}) };
      if (JSON.stringify(next) === JSON.stringify(s)) return;
      s = next;
      if (s.isRunning) startLoop();
      else stopLoop();
      render();
    });
  }

  render();
  if (s.isRunning) startLoop();
  persist();
}
`,
  code: `const FOCUS_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;
const CIRC = 2 * Math.PI * 88;
const DEFAULTS = {
    mode: 'focus',
    durationMinutes: 25,
    remainingSeconds: FOCUS_SECONDS,
    isRunning: false,
    completedSessions: 0,
};
const CSS = \`
.ft{font-family:ui-monospace,Menlo,monospace;display:flex;flex-direction:column;align-items:center;gap:10px;
    padding:16px;border-radius:16px;background:linear-gradient(180deg,#12201a,#0b1411);color:#dff5e6;
    user-select:none;-webkit-user-select:none;touch-action:manipulation}
.ft-ring{position:relative;width:186px;height:186px;cursor:pointer}
.ft-ring svg{width:100%;height:100%;transform:rotate(-90deg);display:block}
.ft-track{fill:none;stroke:#1f3a2e;stroke-width:8}
.ft-bar{fill:none;stroke:#5be0a0;stroke-width:8;stroke-linecap:round;transition:stroke-dashoffset .3s linear,stroke .3s}
.ft-face{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;pointer-events:none}
.ft-mode{font-size:10px;letter-spacing:.2em;color:#7fd6a4}
.ft-time{font-size:38px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.ft-hint{font-size:10px;letter-spacing:.07em;color:#6b8a7a}
.ft-foot{display:flex;align-items:center;gap:12px;font-size:12px;color:#9ec9b1}
.ft-reset{background:#1b2f26;border:1px solid #2c4a3b;color:#bfe7cf;border-radius:8px;
          width:26px;height:26px;cursor:pointer;font-size:12px;line-height:1;padding:0}
.ft-reset:hover{background:#24402f}
.ft.brk .ft-bar{stroke:#f0c46a}
.ft.brk .ft-mode{color:#e8c477}
\`;
export default function mount(ctx) {
    const { container, setState, onStateChange } = ctx;
    let s = { ...DEFAULTS, ...(ctx.state || {}) };
    let loop = null;
    let endAt = 0;
    let pressTimer = null;
    let longPressed = false;
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'ft';
    wrap.innerHTML = \`
    <div class="ft-ring">
      <svg viewBox="0 0 200 200">
        <circle class="ft-track" cx="100" cy="100" r="88"></circle>
        <circle class="ft-bar" cx="100" cy="100" r="88"></circle>
      </svg>
      <div class="ft-face">
        <div class="ft-mode">FOCUS</div>
        <div class="ft-time">25:00</div>
        <div class="ft-hint">tap to start</div>
      </div>
    </div>
    <div class="ft-foot">
      <span class="ft-sessions">0 sessions</span>
      <button class="ft-reset" title="reset">⟲</button>
    </div>
  \`;
    container.innerHTML = '';
    container.appendChild(style);
    container.appendChild(wrap);
    const q = (sel) => wrap.querySelector(sel);
    const bar = q('.ft-bar');
    bar.style.strokeDasharray = String(CIRC);
    const totalFor = () => (s.mode === 'focus' ? FOCUS_SECONDS : BREAK_SECONDS);
    const fmt = (t) => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
    function render() {
        const total = totalFor();
        const elapsed = Math.max(0, total - s.remainingSeconds);
        bar.style.strokeDashoffset = String(CIRC * (1 - elapsed / total));
        q('.ft-time').textContent = fmt(s.remainingSeconds);
        q('.ft-mode').textContent = s.mode === 'focus' ? 'FOCUS' : 'BREAK';
        q('.ft-sessions').textContent =
            s.completedSessions + (s.completedSessions === 1 ? ' session' : ' sessions');
        q('.ft-hint').textContent = s.isRunning
            ? 'tap to pause'
            : s.remainingSeconds === total
                ? 'tap to start'
                : 'tap to resume';
        wrap.classList.toggle('brk', s.mode === 'break');
    }
    function persist() {
        try {
            if (typeof setState === 'function')
                setState({ ...s });
        }
        catch (e) {
            /* state channel unavailable — UI still ticks locally */
        }
    }
    function stopLoop() {
        if (loop)
            clearInterval(loop);
        loop = null;
    }
    function startLoop() {
        stopLoop();
        endAt = Date.now() + s.remainingSeconds * 1000;
        loop = setInterval(() => {
            const left = Math.max(0, Math.round((endAt - Date.now()) / 1000));
            if (left === s.remainingSeconds)
                return;
            s.remainingSeconds = left;
            if (left === 0)
                complete();
            else {
                persist();
                render();
            }
        }, 200);
    }
    function complete() {
        stopLoop();
        s.isRunning = false;
        if (s.mode === 'focus') {
            s.completedSessions += 1;
            s.mode = 'break';
            s.remainingSeconds = BREAK_SECONDS;
        }
        else {
            s.mode = 'focus';
            s.remainingSeconds = FOCUS_SECONDS;
        }
        persist();
        render();
    }
    function toggle() {
        if (s.remainingSeconds <= 0)
            return;
        s.isRunning = !s.isRunning;
        if (s.isRunning)
            startLoop();
        else
            stopLoop();
        persist();
        render();
    }
    function reset() {
        stopLoop();
        s.mode = 'focus';
        s.durationMinutes = 25;
        s.remainingSeconds = FOCUS_SECONDS;
        s.isRunning = false;
        persist();
        render();
    }
    const ring = q('.ft-ring');
    ring.addEventListener('pointerdown', () => {
        longPressed = false;
        pressTimer = setTimeout(() => {
            longPressed = true;
            reset();
        }, 650);
    });
    const release = () => {
        if (pressTimer)
            clearTimeout(pressTimer);
        pressTimer = null;
        if (!longPressed)
            toggle();
    };
    ring.addEventListener('pointerup', release);
    ring.addEventListener('pointerleave', () => {
        if (pressTimer)
            clearTimeout(pressTimer);
        pressTimer = null;
    });
    q('.ft-reset').addEventListener('pointerdown', (e) => e.stopPropagation());
    q('.ft-reset').addEventListener('click', reset);
    if (typeof onStateChange === 'function') {
        onStateChange((incoming) => {
            const next = { ...DEFAULTS, ...(incoming || {}) };
            if (JSON.stringify(next) === JSON.stringify(s))
                return;
            s = next;
            if (s.isRunning)
                startLoop();
            else
                stopLoop();
            render();
        });
    }
    render();
    if (s.isRunning)
        startLoop();
    persist();
}
`,
  exportedAt: 1791999858456,
}
