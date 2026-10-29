// M6-S0 Korean IME recorder (docs/plans/mvp-m6-text-plan.md, sections 7 and 9): a playground
// page, not product code. A person types into a hidden textarea with the real Microsoft Korean
// IME; the page logs every key, input, composition, selection and focus event with the textarea's
// value and selection, and exports the trace as JSON. The traces feed the M6b host-mapping unit
// tests and CDP replay. `window.__vectorStudioM6S0Recorder` exposes the trace for the smoke script.

type CaseSpec = Readonly<{ id: string; title: string; steps: readonly string[] }>;

// The section 9 recorder cases. Keys are for the Korean 2-set (두벌식) layout.
const CASES: readonly CaseSpec[] = [
  {
    id: 'final-consonant-move',
    title: 'Final consonant moves into the next syllable',
    steps: [
      'Selecting this case ticks "Clear textarea after each commit" (the product reset). Record one run with it on, then untick it, Clear log and record one run with it off.',
      'Turn on the Korean IME (한/영 key) and click the input box.',
      'Type r k r k (ㄱ ㅏ ㄱ ㅏ): 가 → 각 → 가가. The ㄱ of 각 moves into the second syllable.',
      'Then type s k (ㄴ ㅏ) and r k s (ㄱ ㅏ ㄴ) once more, then Space.',
      'Look in the log for compositionend directly followed by compositionstart with the same beforeMessage id. With the reset on, check that no m6s0-reset falls between them and the text is not lost.',
    ],
  },
  {
    id: 'backspace-after-commit',
    title: 'Backspace in an empty textarea after a commit',
    steps: [
      'Tick "Clear textarea after each commit" (the product holds only the active composition).',
      'Type g k s (한), then press Space to commit; the textarea is cleared.',
      'Press Backspace twice in the now empty textarea.',
      'Then type g k s (한) again and press Enter, then Backspace once.',
    ],
  },
  {
    id: 'click-keeps-focus',
    title: 'Click during composition, focus kept (pointerdown prevented)',
    steps: [
      'Click the input box and type g k (하, still composing).',
      'Click the "pointerdown prevented" button.',
      'Type s (하 → 한) and note whether the composition continued or was committed.',
      'Repeat once with the "mousedown prevented" button.',
    ],
  },
  {
    id: 'click-moves-focus',
    title: 'Click during composition, focus moves',
    steps: [
      'Click the input box and type g k (하, still composing).',
      'Click the "default (focus moves)" button.',
      'Click the input box again and type s k (나).',
    ],
  },
  {
    id: 'arrows-during-composition',
    title: 'Arrow keys during composition',
    steps: [
      'Click the input box and type a b c (Latin, IME in English mode) then switch to Korean.',
      'Type g k (하, composing) and press ←.',
      'Type g k and press →; type g k and press ↑; type g k and press ↓.',
    ],
  },
  {
    id: 'escape-during-composition',
    title: 'Escape during composition',
    steps: [
      'Click the input box and type g k s (한, composing).',
      'Press Escape. Note whether 한 stays, disappears or is committed.',
      'Type g k s again, then press Escape twice.',
    ],
  },
  {
    id: 'host-force-end',
    title: 'Host force-ends a composition (M6-E4 interrupt)',
    steps: [
      'Click the input box and type g k s (한, composing).',
      'Click "host force-end": it blurs the textarea, clears it and focuses it again, as M6-E4 plans for a host command during a composition.',
      'Watch for a late compositionend after the m6s0-force-end entries (M6-E4 drops it). Then type g k (하) to check that a new composition starts cleanly.',
      'Repeat once with two syllables composing: type g k s r k (한가), then force-end.',
    ],
  },
  {
    id: 'free',
    title: 'Free typing',
    steps: ['Type anything; describe it in the notes field.'],
  },
];

type TraceEvent = Record<string, unknown>;

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('recorder root missing');

app.innerHTML = `
<style>
  .wrap { max-width: 1180px; margin: 0 auto; padding: 16px; display: grid; gap: 12px;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .card { background: #fff; border: 1px solid #d8dce4; border-radius: 8px; padding: 12px; }
  h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 14px; margin: 0 0 8px; }
  label { display: block; font-size: 13px; margin: 4px 0; }
  input[type=text], textarea.notes { width: 100%; box-sizing: border-box; font: inherit; }
  .cases button.case { display: block; width: 100%; text-align: left; margin: 2px 0;
    padding: 6px 8px; border: 1px solid #d8dce4; border-radius: 6px; background: #fafbfc; }
  .cases button.case[aria-pressed=true] { background: #e3edff; border-color: #6a8cd8; }
  ol { margin: 4px 0 0 18px; padding: 0; font-size: 13px; }
  #stage { position: relative; height: 88px; border: 2px dashed #9aa5b8; border-radius: 8px;
    background: #fff; cursor: text; display: flex; align-items: center; padding: 0 12px; }
  #stage.focused { border-color: #2f6fe0; border-style: solid; }
  #mirror { font-size: 28px; white-space: pre; font-family: "Malgun Gothic", sans-serif; }
  #mirror .sel { background: #cfe0ff; } #mirror .caret { border-left: 2px solid #2f6fe0; }
  #sink { position: absolute; left: 12px; top: 24px; width: 40px; height: 40px; opacity: 0;
    resize: none; border: 0; padding: 0; font-size: 28px; }
  #sink.shown { opacity: 1; border: 1px solid #c33; width: 240px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .row button { padding: 6px 10px; }
  #log { font: 11px/1.35 ui-monospace, Consolas, monospace; height: 420px; overflow: auto;
    background: #0f1420; color: #d6deeb; padding: 8px; border-radius: 6px; white-space: pre; }
  .full { grid-column: 1 / -1; }
  @media (max-width: 800px) { .wrap { grid-template-columns: minmax(0, 1fr); } }
</style>
<div class="wrap">
  <div class="card full">
    <h1>M6-S0 Korean IME recorder</h1>
    <div style="font-size: 13px">Pick a case, follow its steps with the real Microsoft Korean IME,
    then export. Record every case once with the current IME and once with "Use previous version of
    Microsoft IME" (Settings › Time &amp; language › Language &amp; region › Korean › Language options ›
    Microsoft IME › Keyboard options › Compatibility; the path varies by build). Clear the log between cases or keep one trace per IME version.</div>
  </div>
  <div class="card cases"><h2>Cases</h2><div id="cases"></div></div>
  <div class="card">
    <h2 id="case-title"></h2><ol id="case-steps"></ol>
    <div style="margin-top: 12px" id="stage"><span id="mirror"></span>
      <textarea id="sink" spellcheck="false" autocomplete="off" autocorrect="off"
        autocapitalize="off"></textarea></div>
    <div class="row">
      <button id="btn-prevent-pointer" type="button">pointerdown prevented</button>
      <button id="btn-prevent-mouse" type="button">mousedown prevented</button>
      <button id="btn-default" type="button">default (focus moves)</button>
      <button id="btn-force-end" type="button">host force-end (blur, reset, refocus)</button>
    </div>
    <label><input type="checkbox" id="clear-after-commit" /> Clear textarea after each commit
      (compositionend not followed by compositionstart in the same task)</label>
    <label><input type="checkbox" id="show-sink" /> Show the textarea (debug)</label>
  </div>
  <div class="card">
    <h2>Run metadata</h2>
    <label>Microsoft IME version (Settings or the IME's About)<input type="text" id="ime-version"
      placeholder="e.g. 10.0.26100.1" /></label>
    <label>IME mode
      <select id="ime-toggle"><option value="current">Current version</option>
      <option value="previous">"Use previous version of Microsoft IME" on</option></select></label>
    <label>Windows version (winver)<input type="text" id="os-version" placeholder="e.g. 11 24H2 26100.4652" /></label>
    <label>Notes<textarea class="notes" id="notes" rows="3"></textarea></label>
  </div>
  <div class="card">
    <h2>Export</h2>
    <div id="summary" style="font-size: 13px"></div>
    <div class="row">
      <button id="btn-download" type="button">Download JSON</button>
      <button id="btn-copy" type="button">Copy JSON</button>
      <button id="btn-mark" type="button">Add marker</button>
      <button id="btn-clear" type="button">Clear log</button>
    </div>
    <div id="export-status" style="font-size: 12px; margin-top: 6px"></div>
  </div>
  <div class="card full"><h2>Log</h2><div id="log"></div></div>
</div>`;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing`);
  return found as T;
}

const sink = element<HTMLTextAreaElement>('sink');
const stage = element<HTMLDivElement>('stage');
const mirror = element<HTMLSpanElement>('mirror');
const logElement = element<HTMLDivElement>('log');
const clearAfterCommit = element<HTMLInputElement>('clear-after-commit');

let activeCase: CaseSpec = CASES[0] ?? { id: 'free', title: 'Free', steps: [] };
const events: TraceEvent[] = [];
let startedAt = new Date().toISOString();
let seq = 0;

// Event grouping. `beforeMessage`: the first event after the last group closed opens a new id and
// posts a MessageChannel message; every event seen before that message runs shares the id.
// `beforeTimeout` does the same with setTimeout(0). Neither is a true task id: an input task
// queued before the posted message also shares it. "Same task" in M6-E4 means "the same
// beforeMessage id", because M6b defines its textarea reset by this same posted-message mechanism.
let messageGroup = 0;
let messageOpen = false;
const channel = new MessageChannel();
channel.port1.onmessage = () => {
  messageOpen = false;
  pendingClear?.();
};
function beforeMessage(): number {
  if (!messageOpen) {
    messageOpen = true;
    messageGroup += 1;
    channel.port2.postMessage(null);
  }
  return messageGroup;
}
let timeoutGroup = 0;
let timeoutOpen = false;
function beforeTimeout(): number {
  if (!timeoutOpen) {
    timeoutOpen = true;
    timeoutGroup += 1;
    setTimeout(() => {
      timeoutOpen = false;
    }, 0);
  }
  return timeoutGroup;
}
let frame = 0;
const tick = () => {
  frame += 1;
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

// The product's planned reset (M6-E4): clear only after a compositionend that no
// compositionstart follows in the same task.
let pendingClear: (() => void) | null = null;

function describeTarget(target: EventTarget | null): string {
  if (target === document) return 'document';
  if (target === window) return 'window';
  if (target instanceof HTMLElement)
    return target.id ? `#${target.id}` : target.tagName.toLowerCase();
  return target === null ? 'null' : Object.prototype.toString.call(target);
}

function record(event: Event, extra: Record<string, unknown> = {}): void {
  const entry: TraceEvent = {
    seq: (seq += 1),
    t: Math.round(event.timeStamp * 1000) / 1000,
    now: Math.round(performance.now() * 1000) / 1000,
    beforeMessage: beforeMessage(),
    beforeTimeout: beforeTimeout(),
    frame,
    case: activeCase.id,
    type: event.type,
    target: describeTarget(event.target),
    trusted: event.isTrusted,
    cancelable: event.cancelable,
  };
  if (event instanceof KeyboardEvent) {
    Object.assign(entry, {
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      which: event.which,
      isComposing: event.isComposing,
      repeat: event.repeat,
      location: event.location,
      mods: { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey },
    });
  }
  if (event instanceof InputEvent) {
    Object.assign(entry, {
      inputType: event.inputType,
      data: event.data,
      isComposing: event.isComposing,
    });
  }
  if (event instanceof CompositionEvent) Object.assign(entry, { data: event.data });
  if (event instanceof FocusEvent)
    Object.assign(entry, { relatedTarget: describeTarget(event.relatedTarget) });
  if (event instanceof PointerEvent) {
    Object.assign(entry, {
      pointerType: event.pointerType,
      button: event.button,
      defaultPrevented: event.defaultPrevented,
    });
  } else if (event instanceof MouseEvent) {
    Object.assign(entry, { button: event.button, defaultPrevented: event.defaultPrevented });
  }
  Object.assign(entry, {
    value: sink.value,
    selectionStart: sink.selectionStart,
    selectionEnd: sink.selectionEnd,
    selectionDirection: sink.selectionDirection,
    activeElement: describeTarget(document.activeElement),
    ...extra,
  });
  events.push(entry);
  appendLog(entry);
  render();
}

function appendLog(entry: TraceEvent): void {
  const parts = [
    String(entry.seq).padStart(4),
    `t${String(entry.task).padStart(4)}`,
    String(entry.type).padEnd(18),
  ];
  for (const key of ['key', 'code', 'keyCode', 'isComposing', 'inputType', 'data']) {
    if (key in entry) parts.push(`${key}=${JSON.stringify(entry[key])}`);
  }
  parts.push(
    `value=${JSON.stringify(entry.value)} sel=${String(entry.selectionStart)}..${String(entry.selectionEnd)}`,
  );
  if (entry.type === 'focus' || entry.type === 'blur')
    parts.push(`active=${String(entry.activeElement)}`);
  const line = document.createElement('div');
  line.textContent = parts.join(' ');
  logElement.append(line);
  logElement.scrollTop = logElement.scrollHeight;
}

function render(): void {
  const value = sink.value;
  const start = sink.selectionStart;
  const end = sink.selectionEnd;
  mirror.replaceChildren();
  const before = document.createElement('span');
  before.textContent = value.slice(0, start);
  const selected = document.createElement('span');
  selected.className = start === end ? 'caret' : 'sel';
  selected.textContent = value.slice(start, end);
  const after = document.createElement('span');
  after.textContent = value.slice(end);
  mirror.append(before, selected, after);
  element('summary').textContent =
    `${events.length} events · case ${activeCase.id} · started ${startedAt}`;
}

const SINK_EVENTS = [
  'keydown',
  'keyup',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'focus',
  'blur',
  'selectionchange',
  'select',
] as const;
for (const type of SINK_EVENTS) sink.addEventListener(type, (event) => record(event));
// Document-level selectionchange only while the textarea is focused (the notes fields are noise).
document.addEventListener('selectionchange', (event) => {
  if (document.activeElement === sink) record(event);
});
window.addEventListener('blur', (event) => {
  if (event.target === window) record(event);
});
window.addEventListener('focus', (event) => {
  if (event.target === window) record(event);
});

sink.addEventListener('compositionstart', () => {
  pendingClear = null;
});
sink.addEventListener('compositionend', () => {
  if (!clearAfterCommit.checked) return;
  // Runs when this task's close message is processed, unless a compositionstart came first.
  pendingClear = () => {
    pendingClear = null;
    if (sink.value === '') return;
    sink.value = '';
    record(new Event('m6s0-reset'), { note: 'textarea cleared after commit' });
  };
});
// A non-IME insertion (Space, Latin letters) is a commit too.
sink.addEventListener('input', (event) => {
  if (!clearAfterCommit.checked || event.isComposing) return;
  if (event.inputType === 'insertCompositionText') return;
  pendingClear = () => {
    pendingClear = null;
    if (sink.value === '') return;
    sink.value = '';
    record(new Event('m6s0-reset'), { note: 'textarea cleared after input' });
  };
});

sink.addEventListener('focus', () => stage.classList.add('focused'));
sink.addEventListener('blur', () => stage.classList.remove('focused'));
stage.addEventListener('pointerdown', (event) => {
  if (event.target !== sink) {
    event.preventDefault();
    sink.focus();
  }
});

function clickButton(id: string, prevent: 'pointerdown' | 'mousedown' | null): void {
  const button = element<HTMLButtonElement>(id);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const) {
    button.addEventListener(type, (event) => {
      if (prevent === type) event.preventDefault();
      record(event, { control: id, prevented: prevent === type });
      if (type === 'click') {
        // Where focus ended up once the click's default actions ran.
        setTimeout(() => record(new Event('m6s0-after-click'), { control: id }), 0);
      }
    });
  }
}
clickButton('btn-prevent-pointer', 'pointerdown');
clickButton('btn-prevent-mouse', 'mousedown');
clickButton('btn-default', null);

function selectCase(spec: CaseSpec): void {
  activeCase = spec;
  for (const button of document.querySelectorAll<HTMLButtonElement>('button.case')) {
    button.setAttribute('aria-pressed', String(button.dataset.case === spec.id));
  }
  element('case-title').textContent = spec.title;
  const steps = element('case-steps');
  steps.replaceChildren(
    ...spec.steps.map((step) => {
      const item = document.createElement('li');
      item.textContent = step;
      return item;
    }),
  );
  if (spec.id === 'backspace-after-commit' || spec.id === 'final-consonant-move') {
    clearAfterCommit.checked = true;
  }
  record(new Event('m6s0-case'), { note: spec.title });
}

const caseList = element('cases');
for (const spec of CASES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'case';
  button.dataset.case = spec.id;
  button.textContent = spec.title;
  button.addEventListener('click', () => {
    selectCase(spec);
    sink.focus();
  });
  caseList.append(button);
}

element('show-sink').addEventListener('change', (event) => {
  sink.classList.toggle('shown', (event.target as HTMLInputElement).checked);
});

type UaData = { getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> };

async function trace(): Promise<Record<string, unknown>> {
  const uaData = (navigator as Navigator & { userAgentData?: UaData }).userAgentData;
  const keyboard = (
    navigator as Navigator & {
      keyboard?: { getLayoutMap(): Promise<Map<string, string>> };
    }
  ).keyboard;
  let layout: Record<string, string> | null = null;
  try {
    const map = keyboard ? await keyboard.getLayoutMap() : null;
    if (map)
      layout = Object.fromEntries(
        ['KeyQ', 'KeyA', 'KeyR', 'KeyK'].map((code) => [code, map.get(code) ?? '']),
      );
  } catch {
    layout = null;
  }
  return {
    kind: 'vector-studio/m6-s0-ime-trace',
    version: 1,
    startedAt,
    exportedAt: new Date().toISOString(),
    metadata: {
      imeVersion: element<HTMLInputElement>('ime-version').value,
      imeToggle: element<HTMLSelectElement>('ime-toggle').value,
      osVersion: element<HTMLInputElement>('os-version').value,
      notes: element<HTMLTextAreaElement>('notes').value,
      clearAfterCommit: clearAfterCommit.checked,
      userAgent: navigator.userAgent,
      userAgentData: uaData
        ? await uaData
            .getHighEntropyValues([
              'platform',
              'platformVersion',
              'fullVersionList',
              'architecture',
            ])
            .catch(() => null)
        : null,
      languages: navigator.languages,
      devicePixelRatio: window.devicePixelRatio,
      keyboardLayoutSample: layout,
      grouping:
        'beforeMessage: events seen before a posted MessageChannel message runs; beforeTimeout: the same with setTimeout(0); neither is a true task id',
      warnings: exportWarnings(),
    },
    cases: CASES.map(({ id, title }) => ({ id, title })),
    events,
  };
}

function fileName(): string {
  const toggle = element<HTMLSelectElement>('ime-toggle').value;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `m6-s0-ime-trace-${toggle}-${stamp}.json`;
}

// M6-E4's host force-end: blur, reset and refocus during a composition. pointerdown is prevented
// so the click itself does not move focus; the trace shows whether a late compositionend follows.
const forceEnd = element<HTMLButtonElement>('btn-force-end');
forceEnd.addEventListener('pointerdown', (event) => event.preventDefault());
forceEnd.addEventListener('mousedown', (event) => event.preventDefault());
forceEnd.addEventListener('click', (event) => {
  record(event, { control: 'btn-force-end', note: 'force-end: before blur' });
  sink.blur();
  record(new Event('m6s0-force-end'), { note: 'after blur' });
  sink.value = '';
  record(new Event('m6s0-force-end'), { note: 'after reset' });
  sink.focus();
  record(new Event('m6s0-force-end'), { note: 'after refocus' });
});

function exportWarnings(): string[] {
  return element<HTMLInputElement>('ime-version').value.trim() === ''
    ? ['IME version is empty: fill it in before keeping this trace']
    : [];
}

function exportStatus(message: string): void {
  const warnings = exportWarnings();
  element('export-status').textContent = warnings.length
    ? `${message}. Warning: ${warnings.join('; ')}`
    : message;
}

element('btn-download').addEventListener('click', () => {
  void trace().then((data) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(
      new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }),
    );
    link.download = fileName();
    link.click();
    exportStatus(`Downloaded ${link.download}`);
  });
});
element('btn-copy').addEventListener('click', () => {
  void trace()
    .then((data) => navigator.clipboard.writeText(`${JSON.stringify(data, null, 2)}\n`))
    .then(
      () => exportStatus(`Copied ${events.length} events`),
      (error: unknown) => (element('export-status').textContent = `Copy failed: ${String(error)}`),
    );
});
element('btn-mark').addEventListener('click', () => {
  record(new Event('m6s0-marker'), { note: element<HTMLTextAreaElement>('notes').value });
  sink.focus();
});
element('btn-clear').addEventListener('click', () => {
  events.length = 0;
  startedAt = new Date().toISOString();
  logElement.replaceChildren();
  sink.value = '';
  render();
});

const recorderApi = {
  trace,
  events: () => events,
  cases: CASES,
  selectCase: (id: string) => {
    const spec = CASES.find((item) => item.id === id);
    if (!spec) throw new Error(`unknown case ${id}`);
    selectCase(spec);
  },
};
(
  window as unknown as { __vectorStudioM6S0Recorder: typeof recorderApi }
).__vectorStudioM6S0Recorder = recorderApi;

selectCase(activeCase);
