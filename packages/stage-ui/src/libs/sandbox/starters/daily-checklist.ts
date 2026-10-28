import type { WidgetExportManifest } from '../export'

export const DAILY_CHECKLIST_STARTER: WidgetExportManifest = {
  version: '1.0',
  id: 'starter-daily-checklist',
  title: 'Daily Checklist 📋',
  scope: 'global',
  surface: 'panel',
  target: 'sidepanel',
  state: {
    tasks: [
      { id: 'c1', text: 'pull evening dark roast', done: false },
      { id: 'c2', text: 'wipe down portafilters', done: false },
      { id: 'c3', text: 'review sync report', done: false },
    ],
  },
  sourcePath: '/workspace/daily_checklist.ts',
  sourceCode: `type Task = { id: string; text: string; done: boolean };
type State = { tasks: Task[] };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);

const uid = () => Math.random().toString(36).slice(2, 8);

/* ---- THEME LAYER -------------------------------------------------------
   Every colour below is a TOKEN. The DOM layer never names a colour, so the
   host flipping \`dark\` on the iframe root re-resolves all of them at once —
   no JS, no re-render, no remount. Values only exist in these two blocks.  */
const TOKENS = \`
.hc{
  --card:#FFF9F3; --ink:#7A4F33; --soft:#A8927F; --line:#EEE1D4;
  --pill:#F2E4D6; --acc:#C98A5B; --tick:#FFF9F3; --hover:rgba(201,138,91,.10);
}
:root.dark .hc, html.dark .hc{
  --card:#1B1612; --ink:#F1E4D6; --soft:#8B7A6C; --line:#30271F;
  --pill:#2A211A; --acc:#E8B48A; --tick:#1B1612; --hover:rgba(232,180,138,.12);
}\`;

const SHELL = \`
.hc{box-sizing:border-box;padding:12px 13px 10px;border-radius:16px;background:var(--card);
  color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  transition:background .18s ease,color .18s ease}
.hc input{width:100%;border:0;outline:0;background:transparent;font:inherit;color:var(--ink);
  padding:5px 2px 8px}
.hc input::placeholder{color:var(--soft)}
.hc ul{list-style:none;margin:2px 0 0;padding:0}
.hc li{display:flex;align-items:center;gap:9px;padding:7px 6px;border-radius:11px;
  cursor:pointer;user-select:none;transition:background .15s}
.hc li:hover{background:var(--hover)}
.hc .pill{width:16px;height:16px;flex:0 0 16px;border-radius:50%;border:1.6px solid var(--acc);
  position:relative;transition:background .18s,border-color .18s}
.hc li.done .pill{background:var(--acc)}
.hc li.done .pill::after{content:"✓";position:absolute;inset:0;color:var(--tick);
  font-size:11px;line-height:13px;text-align:center}
.hc .txt{flex:1;transition:opacity .18s}
.hc li.done .txt{text-decoration:line-through;opacity:.42}
.hc .x{opacity:0;color:var(--soft);font-size:15px;padding:0 4px;transition:opacity .15s,color .15s}
.hc li:hover .x{opacity:.8}
.hc .x:hover{color:var(--acc)}
.hc .empty{color:var(--soft);font-style:italic;padding:8px 4px;font-size:13px}
.hc .foot{display:flex;justify-content:space-between;align-items:center;margin-top:8px;
  padding-top:7px;border-top:1px solid var(--line);font-size:11.5px;color:var(--soft)}
.hc .spark{position:absolute;pointer-events:none;font-size:15px;animation:fly .95s ease-out forwards}
@keyframes fly{to{transform:translate(var(--dx),-80px) rotate(var(--rot));opacity:0}}
@media (prefers-reduced-motion:reduce){.hc .spark{animation:none;opacity:0}}\`;

export default function mount({ container, state, setState, onStateChange }: any) {
  const css = document.createElement('style');
  css.textContent = TOKENS + SHELL;
  container.appendChild(css);

  const root = document.createElement('div');
  root.className = 'hc';
  root.style.position = 'relative';
  root.innerHTML =
    \`<input placeholder="Add a task... \\u21B5" aria-label="Add a task" autocomplete="off"/>\` +
    \`<ul></ul><div class="foot"><span class="count"></span><span class="hint"></span></div>\`;
  container.appendChild(root);

  const input = root.querySelector('input') as HTMLInputElement;
  const ul = root.querySelector('ul') as HTMLUListElement;
  const count = root.querySelector('.count') as HTMLElement;
  const hint = root.querySelector('.hint') as HTMLElement;

  const taskOf = (): Task[] => (state && Array.isArray(state.tasks) ? state.tasks : []);
  let lastTapId = '';
  let lastTapAt = 0;

  function sparkle() {
    const glyphs = ['✨', '🎉', '⭐', '✨', '🎊'];
    for (let i = 0; i < 14; i++) {
      const s = document.createElement('span');
      s.className = 'spark';
      s.textContent = glyphs[i % glyphs.length];
      s.style.left = 12 + Math.random() * 76 + '%';
      s.style.top = 46 + Math.random() * 18 + '%';
      s.style.setProperty('--dx', (Math.random() * 60 - 30).toFixed(0) + 'px');
      s.style.setProperty('--rot', (Math.random() * 520 - 260).toFixed(0) + 'deg');
      s.style.animationDelay = (Math.random() * 0.22).toFixed(2) + 's';
      root.appendChild(s);
      setTimeout(() => s.remove(), 1300);
    }
  }

  function commit(tasks: Task[], celebrate: boolean) {
    setState({ tasks });
    render();
    if (celebrate) sparkle();
  }

  function toggle(id: string) {
    commit(taskOf().map(t => (t.id === id ? { ...t, done: !t.done } : t)), false);
  }
  function remove(id: string) {
    commit(taskOf().filter(t => t.id !== id), false);
  }

  function render() {
    const tasks = taskOf();
    ul.innerHTML = '';
    if (!tasks.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'nothing on the pad today \\u2014 enjoy the lull \\u2615';
      ul.appendChild(li);
    }
    for (const t of tasks) {
      const li = document.createElement('li');
      li.className = t.done ? 'done' : '';
      li.dataset.id = t.id;
      li.innerHTML = \`<span class="pill"></span><span class="txt">\${esc(t.text)}</span><span class="x">\\u00D7</span>\`;
      li.addEventListener('click', ev => {
        if ((ev.target as HTMLElement).classList.contains('x')) { remove(t.id); return; }
        const now = Date.now();
        if (lastTapId === t.id && now - lastTapAt < 320) { lastTapId = ''; remove(t.id); return; }
        lastTapId = t.id; lastTapAt = now;
        toggle(t.id);
      });
      ul.appendChild(li);
    }
    const done = tasks.filter(t => t.done).length;
    count.textContent = tasks.length ? \`\${done} / \${tasks.length} done\` : '';
    hint.textContent = tasks.length && done === tasks.length ? 'all clear \\u2728' : tasks.length ? '' : '';
  }

  input.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    commit([...taskOf(), { id: uid(), text, done: false }], false);
  });

  render();
  if (onStateChange) onStateChange(() => render());
}
`,
  code: `const esc = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 8);
/* ---- THEME LAYER -------------------------------------------------------
   Every colour below is a TOKEN. The DOM layer never names a colour, so the
   host flipping \`dark\` on the iframe root re-resolves all of them at once —
   no JS, no re-render, no remount. Values only exist in these two blocks.  */
const TOKENS = \`
.hc{
  --card:#FFF9F3; --ink:#7A4F33; --soft:#A8927F; --line:#EEE1D4;
  --pill:#F2E4D6; --acc:#C98A5B; --tick:#FFF9F3; --hover:rgba(201,138,91,.10);
}
:root.dark .hc, html.dark .hc{
  --card:#1B1612; --ink:#F1E4D6; --soft:#8B7A6C; --line:#30271F;
  --pill:#2A211A; --acc:#E8B48A; --tick:#1B1612; --hover:rgba(232,180,138,.12);
}\`;
const SHELL = \`
.hc{box-sizing:border-box;padding:12px 13px 10px;border-radius:16px;background:var(--card);
  color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  transition:background .18s ease,color .18s ease}
.hc input{width:100%;border:0;outline:0;background:transparent;font:inherit;color:var(--ink);
  padding:5px 2px 8px}
.hc input::placeholder{color:var(--soft)}
.hc ul{list-style:none;margin:2px 0 0;padding:0}
.hc li{display:flex;align-items:center;gap:9px;padding:7px 6px;border-radius:11px;
  cursor:pointer;user-select:none;transition:background .15s}
.hc li:hover{background:var(--hover)}
.hc .pill{width:16px;height:16px;flex:0 0 16px;border-radius:50%;border:1.6px solid var(--acc);
  position:relative;transition:background .18s,border-color .18s}
.hc li.done .pill{background:var(--acc)}
.hc li.done .pill::after{content:"✓";position:absolute;inset:0;color:var(--tick);
  font-size:11px;line-height:13px;text-align:center}
.hc .txt{flex:1;transition:opacity .18s}
.hc li.done .txt{text-decoration:line-through;opacity:.42}
.hc .x{opacity:0;color:var(--soft);font-size:15px;padding:0 4px;transition:opacity .15s,color .15s}
.hc li:hover .x{opacity:.8}
.hc .x:hover{color:var(--acc)}
.hc .empty{color:var(--soft);font-style:italic;padding:8px 4px;font-size:13px}
.hc .foot{display:flex;justify-content:space-between;align-items:center;margin-top:8px;
  padding-top:7px;border-top:1px solid var(--line);font-size:11.5px;color:var(--soft)}
.hc .spark{position:absolute;pointer-events:none;font-size:15px;animation:fly .95s ease-out forwards}
@keyframes fly{to{transform:translate(var(--dx),-80px) rotate(var(--rot));opacity:0}}
@media (prefers-reduced-motion:reduce){.hc .spark{animation:none;opacity:0}}\`;
export default function mount({ container, state, setState, onStateChange }) {
    const css = document.createElement('style');
    css.textContent = TOKENS + SHELL;
    container.appendChild(css);
    const root = document.createElement('div');
    root.className = 'hc';
    root.style.position = 'relative';
    root.innerHTML =
        \`<input placeholder="Add a task... \\u21B5" aria-label="Add a task" autocomplete="off"/>\` +
            \`<ul></ul><div class="foot"><span class="count"></span><span class="hint"></span></div>\`;
    container.appendChild(root);
    const input = root.querySelector('input');
    const ul = root.querySelector('ul');
    const count = root.querySelector('.count');
    const hint = root.querySelector('.hint');
    const taskOf = () => (state && Array.isArray(state.tasks) ? state.tasks : []);
    let lastTapId = '';
    let lastTapAt = 0;
    function sparkle() {
        const glyphs = ['✨', '🎉', '⭐', '✨', '🎊'];
        for (let i = 0; i < 14; i++) {
            const s = document.createElement('span');
            s.className = 'spark';
            s.textContent = glyphs[i % glyphs.length];
            s.style.left = 12 + Math.random() * 76 + '%';
            s.style.top = 46 + Math.random() * 18 + '%';
            s.style.setProperty('--dx', (Math.random() * 60 - 30).toFixed(0) + 'px');
            s.style.setProperty('--rot', (Math.random() * 520 - 260).toFixed(0) + 'deg');
            s.style.animationDelay = (Math.random() * 0.22).toFixed(2) + 's';
            root.appendChild(s);
            setTimeout(() => s.remove(), 1300);
        }
    }
    function commit(tasks, celebrate) {
        setState({ tasks });
        render();
        if (celebrate)
            sparkle();
    }
    function toggle(id) {
        commit(taskOf().map(t => (t.id === id ? { ...t, done: !t.done } : t)), false);
    }
    function remove(id) {
        commit(taskOf().filter(t => t.id !== id), false);
    }
    function render() {
        const tasks = taskOf();
        ul.innerHTML = '';
        if (!tasks.length) {
            const li = document.createElement('li');
            li.className = 'empty';
            li.textContent = 'nothing on the pad today \\u2014 enjoy the lull \\u2615';
            ul.appendChild(li);
        }
        for (const t of tasks) {
            const li = document.createElement('li');
            li.className = t.done ? 'done' : '';
            li.dataset.id = t.id;
            li.innerHTML = \`<span class="pill"></span><span class="txt">\${esc(t.text)}</span><span class="x">\\u00D7</span>\`;
            li.addEventListener('click', ev => {
                if (ev.target.classList.contains('x')) {
                    remove(t.id);
                    return;
                }
                const now = Date.now();
                if (lastTapId === t.id && now - lastTapAt < 320) {
                    lastTapId = '';
                    remove(t.id);
                    return;
                }
                lastTapId = t.id;
                lastTapAt = now;
                toggle(t.id);
            });
            ul.appendChild(li);
        }
        const done = tasks.filter(t => t.done).length;
        count.textContent = tasks.length ? \`\${done} / \${tasks.length} done\` : '';
        hint.textContent = tasks.length && done === tasks.length ? 'all clear \\u2728' : tasks.length ? '' : '';
    }
    input.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter')
            return;
        const text = input.value.trim();
        if (!text)
            return;
        input.value = '';
        commit([...taskOf(), { id: uid(), text, done: false }], false);
    });
    render();
    if (onStateChange)
        onStateChange(() => render());
}
`,
  exportedAt: 1792000945122,
}
