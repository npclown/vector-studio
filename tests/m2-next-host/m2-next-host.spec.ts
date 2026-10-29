import type { Command, Editor, EditorEvent } from '@vector-studio/editor-core';
import type { DocumentV5, Frame } from '@vector-studio/model';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// M2-U8 (MVP M2 contract, section 8): M2-A13, the next-host page's M2 interactions through
// EditorCanvas with real input in headed Chrome and Edge. Copy, cut and paste go through the
// system clipboard by the browser's own Ctrl+C, X and V (DOM clipboard events, section 6), also
// into a second tab of the same browser context; the default keymap runs undo, redo, delete,
// group, nudge, reorder, zoom and frame entry (Enter, Escape and double-click), and every
// DEFAULT_KEYMAP chord is pressed once and seen to reach the editor (section 7: the keydown is
// prevented, which EditorCanvas does only when the editor consumed it, and its action's effect
// is checked); Alt-drag duplicates and Alt-click cycles an overlapping stack. The page's zoom
// controls, snap overlay, scope indicator, rotate cursor and toolbar ungroup are checked too.
// Shortcuts under an active Korean IME are UNVERIFIED: Playwright cannot drive an OS IME, so this
// spec does not simulate one. Results are read through the page's `?test=1` hook, as in M1-A12.
//
// The `chromium-smoke` project (M2_NEXT_HOST_CHROMIUM, playwright.m2-next-host.config.ts) runs
// headless without WebGPU: the renderer may fail there, and input does not depend on it. It is
// a functional smoke run of the spec, not M2-A13 evidence.

declare global {
  interface Window {
    /** The next-host page's test hook, present with `?test=1` (apps/next-host/app/page.tsx). */
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
    /** Every keydown, seen at the window after the page's handlers ran (installed below). */
    __m2Keys?: { key: string; code: string; prevented: boolean; target: string }[];
  }
}

type Point = Readonly<{ x: number; y: number }>;

const MARKER = 'vector-studio/fragment\n';
const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0.2, g: 0.4, b: 0.8, a: 1 };

/**
 * The scene, created through commands at zoom 1: a mask-source triangle `p`, rectangles `a` and
 * `b`, a top-level frame `F` holding a group `g` of `c` and `d`, and four overlapping squares
 * `s1` to `s4` for overlap cycling. Every shape is filled, so its inside is hittable.
 */
const SCENE: readonly (readonly [string, Command])[] = [
  [
    'p',
    {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [20, 20, 80, 20, 50, 80],
      fill: BLUE,
    },
  ],
  ['a', { type: 'createRectangle', frame: { x: 100, y: 100, width: 80, height: 60 }, fill: RED }],
  ['b', { type: 'createRectangle', frame: { x: 240, y: 100, width: 80, height: 60 }, fill: BLUE }],
  ['F', { type: 'createFrame', frame: { x: 100, y: 260, width: 300, height: 200 } }],
  ['s1', { type: 'createRectangle', frame: { x: 520, y: 100, width: 120, height: 120 } }],
  ['s2', { type: 'createRectangle', frame: { x: 540, y: 120, width: 120, height: 120 } }],
  ['s3', { type: 'createRectangle', frame: { x: 560, y: 140, width: 120, height: 120 } }],
  ['s4', { type: 'createRectangle', frame: { x: 580, y: 160, width: 120, height: 120 } }],
];
/** Points in page space, at zoom 1 with the camera at the origin. */
const AT = {
  a: { x: 140, y: 130 },
  b: { x: 280, y: 130 },
  c: { x: 170, y: 320 },
  frameBackground: { x: 120, y: 440 },
  stack: { x: 600, y: 180 },
  empty: { x: 800, y: 560 },
} as const;

type Ids = Readonly<
  Record<'p' | 'a' | 'b' | 'F' | 'g' | 'c' | 'd' | 's1' | 's2' | 's3' | 's4', string>
>;

/** Records every keydown at the window, after React's document-level handlers. */
async function recordKeys(context: BrowserContext) {
  await context.addInitScript(() => {
    window.__m2Keys = [];
    window.addEventListener('keydown', (event) => {
      const target = event.target as Element | null;
      window.__m2Keys!.push({
        key: event.key,
        code: event.code,
        prevented: event.defaultPrevented,
        target: target?.nodeName ?? '',
      });
    });
  });
}

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1');
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  if (test.info().project.name === 'chromium-smoke') {
    // No WebGPU adapter is required for input; wait only for the renderer to settle.
    await expect(status).not.toHaveAttribute('data-renderer', 'pending', { timeout: 30_000 });
  } else {
    await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 30_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
  }
  /**
   * A page point on screen with the editor's current camera and the canvas content box's
   * current place (inside its border), both read at call time.
   */
  const screen = async (p: Point): Promise<Point> => {
    const { origin, position, zoom } = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      const rect = canvas.getBoundingClientRect();
      return {
        origin: { x: rect.left + canvas.clientLeft, y: rect.top + canvas.clientTop },
        ...window.__p5Host!.editor.query({ type: 'viewport' }),
      };
    });
    return { x: origin.x + (p.x - position.x) * zoom, y: origin.y + (p.y - position.y) * zoom };
  };
  return { errors, status, screen };
}

/** Creates the scene through commands (each one undoable step) and clears the selection. */
async function build(page: Page): Promise<Ids> {
  const ids = await page.evaluate((script: string) => {
    const { editor } = window.__p5Host!;
    const run = (command: Command) => {
      const result = editor.execute(command);
      if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
      return result.ids;
    };
    const out: Record<string, string> = {};
    for (const [name, command] of JSON.parse(script) as [string, Command][]) {
      out[name] = run(command)[0]!;
    }
    // Creation frames are in page space (M1 contract, section 4.1).
    out.c = run({
      type: 'createRectangle',
      frame: { x: 140, y: 300, width: 60, height: 40 },
      parent: out.F!,
      fill: { r: 0, g: 0.6, b: 0, a: 1 },
    })[0]!;
    out.d = run({
      type: 'createRectangle',
      frame: { x: 240, y: 300, width: 60, height: 40 },
      parent: out.F!,
      fill: { r: 0, g: 0.6, b: 0, a: 1 },
    })[0]!;
    out.g = run({ type: 'groupNodes', ids: [out.c, out.d], kind: 'group' })[0]!;
    // Paint order: p, a, b, F, s1 to s4 on the page.
    run({ type: 'setSelection', ids: [] });
    return out;
  }, JSON.stringify(SCENE));
  return ids as Ids;
}

async function readDocument(page: Page): Promise<DocumentV5> {
  const text = await page.evaluate(() =>
    JSON.stringify(window.__p5Host!.editor.query({ type: 'document' })),
  );
  return JSON.parse(text) as DocumentV5;
}

async function snapshotOf(page: Page) {
  return page.evaluate(() => {
    const { editor } = window.__p5Host!;
    const value = editor.getSnapshot();
    return {
      tool: value.tool,
      selection: [...value.selection],
      scope: value.scope,
      zoom: value.viewport.zoom,
      position: { ...value.viewport.position },
      history: { ...value.history },
      clipboard: editor.query({ type: 'clipboard' }),
    };
  });
}

async function pageChildren(page: Page): Promise<string[]> {
  const document = await readDocument(page);
  return [...document.pages[0]!.children];
}

async function frameOf(page: Page, id: string): Promise<Frame | null> {
  return (await readDocument(page)).nodes[id]?.frame ?? null;
}

async function focusCanvas(page: Page) {
  await page.locator('canvas').focus();
}

/** A Playwright key for a canonical-or-written chord: Mod is Ctrl, or Meta on macOS. */
function playwrightKey(chord: string): string {
  const parts = chord.split('+');
  const key = parts.pop()!;
  const modifiers = parts.map((part) =>
    part === 'Mod' ? 'ControlOrMeta' : part === 'Ctrl' ? 'Control' : part,
  );
  const shifted: Record<string, string> = {
    '!': 'Digit1',
    '@': 'Digit2',
    ')': 'Digit0',
    '}': 'BracketRight',
    '{': 'BracketLeft',
  };
  const plain: Record<string, string> = {
    ']': 'BracketRight',
    '[': 'BracketLeft',
    '=': 'Equal',
    '-': 'Minus',
  };
  const token = /^[A-Z]$/u.test(key) ? `Key${key}` : (shifted[key] ?? plain[key] ?? key);
  return [...modifiers, token].join('+');
}

/**
 * A written chord's canonical form (M2 contract, section 7) for this spec's chords: `Mod` is
 * Ctrl, or Meta on macOS; modifiers in the order Ctrl, Meta, Alt, Shift; a letter is `KeyX`.
 */
function canonical(chord: string, mac: boolean): string {
  const parts = chord.split('+');
  const key = parts.pop()!;
  const order = ['Ctrl', 'Meta', 'Alt', 'Shift'];
  const modifiers = parts
    .map((part) => (part === 'Mod' ? (mac ? 'Meta' : 'Ctrl') : part))
    .sort((x, y) => order.indexOf(x) - order.indexOf(y));
  return [...modifiers, /^[A-Za-z]$/u.test(key) ? `Key${key.toUpperCase()}` : key].join('+');
}

/** Presses a chord on the focused canvas and returns the keydown records it produced. */
async function press(page: Page, chord: string) {
  await page.evaluate(() => {
    window.__m2Keys!.length = 0;
  });
  await page.keyboard.press(playwrightKey(chord));
  const keys = await page.evaluate(() => [...window.__m2Keys!]);
  // Modifier keydowns come first; the chord's own key is the last one.
  return keys[keys.length - 1]!;
}

/** Presses a chord and expects the editor to have consumed it on the canvas. */
async function pressConsumed(page: Page, chord: string) {
  const key = await press(page, chord);
  expect(key, `${chord} reached the canvas and was consumed`).toMatchObject({
    target: 'CANVAS',
    prevented: true,
  });
  return key;
}

async function click(page: Page, at: Point, modifiers: ('Shift' | 'Alt')[] = []) {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click(at.x, at.y);
  for (const key of modifiers) await page.keyboard.up(key);
}

async function drag(page: Page, from: Point, to: Point, release = true) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  if (release) await page.mouse.up();
}

async function setSnapping(page: Page, enabled: boolean) {
  await page.evaluate(
    (on) => window.__p5Host!.editor.execute({ type: 'setSnapping', enabled: on }),
    enabled,
  );
}

async function expectClean(page: Page, errors: readonly string[]) {
  const diagnostics = await page.evaluate(() =>
    window.__p5Host!.events.filter((event) => event.type === 'diagnostic'),
  );
  expect(diagnostics).toEqual([]);
  expect(errors).toEqual([]);
}

test.beforeEach(async ({ context }) => {
  await recordKeys(context);
});

test('M2-A13 section 7: every default chord reaches the editor', async ({ page }) => {
  const { errors, screen } = await open(page);
  const ids = await build(page);
  const keymap = await page.evaluate(() => window.__p5Host!.editor.query({ type: 'keymap' }));
  const mac = await page.evaluate(() => /^Mac/u.test(navigator.platform));
  const pressed = new Set<string>();
  const step = async (chord: string) => {
    await pressConsumed(page, chord);
    pressed.add(chord);
  };
  await click(page, await screen(AT.empty));
  await focusCanvas(page);

  // Tools.
  for (const [chord, tool] of [
    ['R', 'rectangle'],
    ['O', 'ellipse'],
    ['L', 'line'],
    ['F', 'frame'],
    ['P', 'path'],
    ['V', 'select'],
  ] as const) {
    await step(chord);
    expect((await snapshotOf(page)).tool).toBe(tool);
  }

  // Select all, group, ungroup, then undo twice and redo by both chords.
  await step('Mod+A');
  const all = await pageChildren(page);
  expect((await snapshotOf(page)).selection).toEqual(all);
  await step('Mod+G');
  const [group] = (await snapshotOf(page)).selection;
  expect((await readDocument(page)).nodes[group!]).toMatchObject({ type: 'group', children: all });
  await step('Mod+Shift+G');
  expect((await snapshotOf(page)).selection).toEqual(all);
  expect(await pageChildren(page)).toEqual(all);
  const { undoDepth } = (await snapshotOf(page)).history;
  await step('Mod+Z');
  expect(await pageChildren(page)).toEqual([group]);
  await press(page, 'Mod+Z');
  expect(await pageChildren(page)).toEqual(all);
  expect((await snapshotOf(page)).history).toEqual({ undoDepth: undoDepth - 2, redoDepth: 2 });
  await step('Mod+Shift+Z');
  expect(await pageChildren(page)).toEqual([group]);
  await step('Mod+Y');
  expect(await pageChildren(page)).toEqual(all);
  expect((await snapshotOf(page)).history).toEqual({ undoDepth, redoDepth: 0 });

  // Duplicate, Delete and Backspace.
  await click(page, await screen(AT.a));
  expect((await snapshotOf(page)).selection).toEqual([ids.a]);
  await step('Mod+D');
  const [copy] = (await snapshotOf(page)).selection;
  expect(copy).not.toBe(ids.a);
  expect(await frameOf(page, copy!)).toEqual(await frameOf(page, ids.a));
  await step('Delete');
  expect(await frameOf(page, copy!)).toBeNull();
  await click(page, await screen(AT.b));
  await step('Backspace');
  expect(await frameOf(page, ids.b)).toBeNull();

  // Nudge: 1 and, with Shift, 10 page units.
  await click(page, await screen(AT.a));
  const nudges = [
    ['ArrowLeft', -1, 0],
    ['ArrowRight', 1, 0],
    ['ArrowUp', 0, -1],
    ['ArrowDown', 0, 1],
    ['Shift+ArrowLeft', -10, 0],
    ['Shift+ArrowRight', 10, 0],
    ['Shift+ArrowUp', 0, -10],
    ['Shift+ArrowDown', 0, 10],
  ] as const;
  for (const [chord, dx, dy] of nudges) {
    const before = (await frameOf(page, ids.a))!;
    await step(chord);
    expect(await frameOf(page, ids.a)).toEqual({ ...before, x: before.x + dx, y: before.y + dy });
  }

  // Reorder `a` within the page.
  const index = async () => (await pageChildren(page)).indexOf(ids.a);
  const start = await index();
  await step('Mod+]');
  expect(await index()).toBe(start + 1);
  await step('Mod+[');
  expect(await index()).toBe(start);
  await step('Mod+Shift+}');
  expect(await index()).toBe((await pageChildren(page)).length - 1);
  await step('Mod+Shift+{');
  expect(await index()).toBe(0);

  // Mask group: the bottom child of a mask group is its mask source and must be a path. `a` is at
  // the back now, below the triangle `p`, so bring `a` to the front first; then select `p` and
  // `a`, mask (`p` masks `a`) and undo.
  await press(page, 'Mod+Shift+}');
  await click(page, await screen({ x: 50, y: 30 }));
  await click(page, await screen(AT.a), ['Shift']);
  expect([...(await snapshotOf(page)).selection].sort()).toEqual([ids.a, ids.p].sort());
  await step('Mod+Alt+M');
  const [mask] = (await snapshotOf(page)).selection;
  expect((await readDocument(page)).nodes[mask!]).toMatchObject({
    type: 'maskGroup',
    children: [ids.p, ids.a],
  });
  await press(page, 'Mod+Z');

  // Zoom: in and out about the viewport centre, to the selection, to fit and to 100%.
  // About the viewport centre c = (480, 320) of the 960 x 640 canvas (M2 contract, section 3):
  // position1 = c - (c - position0) * (z0 / z1), so (0, 0) at zoom 1 becomes (240, 160) at
  // zoom 2 and returns to (0, 0) at zoom 1, all exact in binary64.
  await click(page, await screen(AT.a));
  expect(await snapshotOf(page)).toMatchObject({ zoom: 1, position: { x: 0, y: 0 } });
  await step('=');
  expect(await snapshotOf(page)).toMatchObject({ zoom: 2, position: { x: 240, y: 160 } });
  await step('-');
  expect(await snapshotOf(page)).toMatchObject({ zoom: 1, position: { x: 0, y: 0 } });
  await step('Shift+@');
  // The selection `a` (80 x 60) in a 960 x 640 viewport: min((960 - 64) / 80, (640 - 64) / 60).
  expect((await snapshotOf(page)).zoom).toBe(Math.min((960 - 64) / 80, (640 - 64) / 60));
  await step('Shift+!');
  // Fit: the visible children span x 20..700 and y 20..460 (`b` was deleted above).
  expect((await snapshotOf(page)).zoom).toBe(Math.min((960 - 64) / 680, (640 - 64) / 440));
  await step('Shift+)');
  expect((await snapshotOf(page)).zoom).toBe(1);
  await page.evaluate(() =>
    window.__p5Host!.editor.execute({
      type: 'setViewport',
      camera: { position: { x: 0, y: 0 }, zoom: 1 },
    }),
  );

  // Frame entry: Enter into the selected frame selects its children; Escape leaves it.
  await click(page, await screen(AT.frameBackground));
  expect((await snapshotOf(page)).selection).toEqual([ids.F]);
  await step('Enter');
  expect(await snapshotOf(page)).toMatchObject({ scope: ids.F, selection: [ids.g] });
  await step('Escape');
  expect(await snapshotOf(page)).toMatchObject({ scope: null, selection: [ids.F] });

  // Every chord of the effective keymap (the defaults; no extension or host layer binds one)
  // was pressed and consumed.
  const expected = keymap.map((binding) => binding.chord).sort();
  expect([...pressed].map((chord) => canonical(chord, mac)).sort()).toEqual(expected);
  await expectClean(page, errors);
});

test('M2-A13: frame entry by double-click, the scope indicator and the toolbar ungroup', async ({
  page,
}) => {
  const { errors, screen, status } = await open(page);
  const ids = await build(page);

  // A top-level frame's background: the frame becomes the scope with an empty selection.
  const background = await screen(AT.frameBackground);
  await page.mouse.dblclick(background.x, background.y);
  expect(await snapshotOf(page)).toMatchObject({ scope: ids.F, selection: [] });
  await expect(status).toHaveAttribute('data-scope', ids.F);
  await expect(page.getByTestId('scope')).toHaveAttribute('data-scope', ids.F);
  await expect(page.getByTestId('scope-label')).toHaveText(`scope: Frame (${ids.F})`);

  // Inside it, the group under `c` is entered and `c` selected.
  const c = await screen(AT.c);
  await page.mouse.dblclick(c.x, c.y);
  expect(await snapshotOf(page)).toMatchObject({ scope: ids.g, selection: [ids.c] });
  await expect(page.getByTestId('scope')).toHaveAttribute('data-scope', ids.g);
  // The outline is the group's page box: c and d span x 140..300, y 300..340 at zoom 1.
  const outline = ((await page.getByTestId('scope').getAttribute('points')) ?? '').split(' ');
  expect(outline).toEqual(['140,300', '300,300', '300,340', '140,340']);

  // Escape selects the group and leaves to the page (the top-level frame is not a scope target).
  await pressConsumed(page, 'Escape');
  expect(await snapshotOf(page)).toMatchObject({ scope: null, selection: [ids.g] });
  await expect(page.getByTestId('scope')).toHaveCount(0);
  await expect(page.getByTestId('scope-label')).toHaveText('scope: page');
  await pressConsumed(page, 'Escape');
  expect((await snapshotOf(page)).selection).toEqual([]);

  // The toolbar's ungroup selects the released children, as the ungroup action does.
  await click(page, await screen(AT.c));
  expect((await snapshotOf(page)).selection).toEqual([ids.g]);
  await page.getByTestId('ungroup').click();
  expect((await snapshotOf(page)).selection).toEqual([ids.c, ids.d]);
  expect((await readDocument(page)).nodes[ids.g]).toBeUndefined();
  // And Mod+Shift+G does the same after the group is restored.
  await page.getByTestId('undo').click();
  await focusCanvas(page);
  await click(page, await screen(AT.c));
  await pressConsumed(page, 'Mod+Shift+G');
  expect((await snapshotOf(page)).selection).toEqual([ids.c, ids.d]);
  await expectClean(page, errors);
});

test('M2-A13: Alt-drag duplicates and Alt-click cycles an overlapping stack', async ({ page }) => {
  const { errors, screen } = await open(page);
  const ids = await build(page);
  await setSnapping(page, false);

  // Alt-drag `a` by (300, 0): a copy moves, the original stays, one undo step.
  await click(page, await screen(AT.a));
  const before = await snapshotOf(page);
  await page.keyboard.down('Alt');
  await drag(page, await screen(AT.a), await screen({ x: AT.a.x + 300, y: AT.a.y }));
  await page.keyboard.up('Alt');
  const after = await snapshotOf(page);
  const [copy] = after.selection;
  expect(copy).not.toBe(ids.a);
  expect(await frameOf(page, ids.a)).toEqual({ x: 100, y: 100, width: 80, height: 60 });
  expect(await frameOf(page, copy!)).toEqual({ x: 400, y: 100, width: 80, height: 60 });
  expect(after.history.undoDepth).toBe(before.history.undoDepth + 1);
  const children = await pageChildren(page);
  expect(children.indexOf(copy!)).toBe(children.indexOf(ids.a) + 1);

  // Escape during an Alt-drag cancels it: no copy, the original selected again.
  await click(page, await screen(AT.b));
  const count = (await pageChildren(page)).length;
  await page.keyboard.down('Alt');
  await drag(page, await screen(AT.b), await screen({ x: AT.b.x, y: AT.b.y + 120 }), false);
  expect((await pageChildren(page)).length).toBe(count + 1);
  await page.keyboard.up('Alt');
  const escape = await press(page, 'Escape');
  expect(escape).toMatchObject({ target: 'CANVAS', prevented: true });
  await page.mouse.up();
  expect((await pageChildren(page)).length).toBe(count);
  expect((await snapshotOf(page)).selection).toEqual([ids.b]);
  expect(await frameOf(page, ids.b)).toEqual({ x: 240, y: 100, width: 80, height: 60 });

  // Alt-click without movement cycles the stack under the point, top first, and wraps.
  await click(page, await screen(AT.empty));
  expect((await snapshotOf(page)).selection).toEqual([]);
  const seen: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    await click(page, await screen(AT.stack), ['Alt']);
    seen.push(...(await snapshotOf(page)).selection);
  }
  expect(seen).toEqual([ids.s4, ids.s3, ids.s2, ids.s1, ids.s4]);
  await expectClean(page, errors);
});

test('M2-A13: copy, cut and paste through the system clipboard, also in a second tab', async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
  const { errors, screen } = await open(page);
  const ids = await build(page);
  const systemClipboard = (target: Page) => target.evaluate(() => navigator.clipboard.readText());
  await page.evaluate(() => navigator.clipboard.writeText('seed'));

  // Ctrl+C is unbound: the browser's copy fires on the canvas and writes the fragment.
  await click(page, await screen(AT.a));
  const copyKey = await press(page, 'Mod+C');
  expect(copyKey).toMatchObject({ target: 'CANVAS', prevented: false });
  // Polled: the Windows clipboard can be briefly locked by another reader.
  const copied = (await snapshotOf(page)).clipboard!;
  expect(copied.startsWith(MARKER)).toBe(true);
  await expect.poll(() => systemClipboard(page)).toBe(copied);
  expect(JSON.parse(copied.slice(MARKER.length))).toMatchObject({ roots: [ids.a] });

  // Ctrl+V pastes it with a fresh ID at the same page placement and selects it.
  const beforePaste = await pageChildren(page);
  await press(page, 'Mod+V');
  const [pasted] = (await snapshotOf(page)).selection;
  expect(beforePaste).not.toContain(pasted);
  expect(await pageChildren(page)).toEqual([...beforePaste, pasted]);
  const document = await readDocument(page);
  expect(document.nodes[pasted!]).toMatchObject({
    type: 'rectangle',
    frame: { x: 100, y: 100, width: 80, height: 60 },
    fill: RED,
  });

  // Ctrl+X cuts `b` into the system clipboard in one undo step.
  await click(page, await screen(AT.b));
  const depth = (await snapshotOf(page)).history.undoDepth;
  await press(page, 'Mod+X');
  expect(await frameOf(page, ids.b)).toBeNull();
  expect((await snapshotOf(page)).history.undoDepth).toBe(depth + 1);
  const cut = (await snapshotOf(page)).clipboard!;
  await expect.poll(() => systemClipboard(page)).toBe(cut);
  expect(JSON.parse(cut.slice(MARKER.length))).toMatchObject({ roots: [ids.b] });

  // A second tab of the same context pastes it from the system clipboard: its own editor's
  // in-memory clipboard stays empty, so the text came through the DOM paste event.
  const other = await context.newPage();
  const second = await open(other);
  await click(other, await second.screen(AT.empty));
  expect((await snapshotOf(other)).clipboard).toBeNull();
  const pasteKey = await press(other, 'Mod+V');
  expect(pasteKey).toMatchObject({ target: 'CANVAS', prevented: false });
  const otherChildren = await pageChildren(other);
  expect(otherChildren).toHaveLength(1);
  expect((await readDocument(other)).nodes[otherChildren[0]!]).toMatchObject({
    type: 'rectangle',
    frame: { x: 240, y: 100, width: 80, height: 60 },
    fill: BLUE,
  });
  expect((await snapshotOf(other)).clipboard).toBeNull();
  // And back: the second tab moves its node to a new frame and copies it, which replaces the
  // first tab's cut in the system clipboard, and the first tab pastes that frame.
  const moved = otherChildren[0]!;
  expect((await snapshotOf(other)).selection).toEqual([moved]);
  await pressConsumed(other, 'Shift+ArrowRight');
  await pressConsumed(other, 'Shift+ArrowDown');
  expect(await frameOf(other, moved)).toEqual({ x: 250, y: 110, width: 80, height: 60 });
  const otherCopyKey = await press(other, 'Mod+C');
  expect(otherCopyKey).toMatchObject({ target: 'CANVAS', prevented: false });
  const otherCopied = (await snapshotOf(other)).clipboard!;
  await expect.poll(() => systemClipboard(other)).toBe(otherCopied);
  expect(otherCopied).not.toBe(cut);
  expect(JSON.parse(otherCopied.slice(MARKER.length))).toMatchObject({ roots: [moved] });
  await expectClean(other, second.errors);
  await other.close();
  await page.bringToFront();
  await click(page, await screen(AT.empty));
  const beforeBack = await pageChildren(page);
  await press(page, 'Mod+V');
  const back = (await pageChildren(page)).filter((id) => !beforeBack.includes(id));
  expect(back).toHaveLength(1);
  expect(await frameOf(page, back[0]!)).toEqual({ x: 250, y: 110, width: 80, height: 60 });
  await expectClean(page, errors);
});

test('M2-A13 host: zoom controls, snap overlay and the rotate cursor', async ({ page }) => {
  const { errors, screen } = await open(page);
  const ids = await build(page);

  // Zoom controls and the shown zoom.
  const zoom = page.getByTestId('zoom');
  await expect(zoom).toHaveText('100%');
  await page.getByTestId('zoom-in').click();
  await expect(zoom).toHaveAttribute('data-zoom', '2');
  await expect(zoom).toHaveText('200%');
  await page.getByTestId('zoom-out').click();
  await expect(zoom).toHaveAttribute('data-zoom', '1');
  await expect(page.getByTestId('zoom-selection')).toBeDisabled();
  await click(page, await screen(AT.a));
  await page.getByTestId('zoom-selection').click();
  await expect(zoom).toHaveAttribute('data-zoom', String((640 - 64) / 60));
  await page.getByTestId('zoom-fit').click();
  const fit = (await snapshotOf(page)).zoom;
  await expect(zoom).toHaveAttribute('data-zoom', String(fit));
  await page.getByTestId('zoom-actual').click();
  await expect(zoom).toHaveAttribute('data-zoom', '1');
  await page.evaluate(() =>
    window.__p5Host!.editor.execute({
      type: 'setViewport',
      camera: { position: { x: 0, y: 0 }, zoom: 1 },
    }),
  );

  // Snap overlay: dragging `a` 4 units down snaps its top to `b`'s top (y = 100), and its left
  // edge sits on the frame's left edge (x = 100); the guides are drawn while the drag lasts.
  await drag(page, await screen(AT.a), await screen({ x: AT.a.x, y: AT.a.y + 4 }), false);
  const snap = await page.evaluate(() => window.__p5Host!.editor.query({ type: 'snap' }));
  expect(snap).not.toBeNull();
  expect(snap!.guides.length).toBeGreaterThan(0);
  expect(snap!.guides.some((guide) => guide.a.y === 100 && guide.b.y === 100)).toBe(true);
  await expect(page.getByTestId('snap-guide')).toHaveCount(snap!.guides.length);
  await page.mouse.up();
  await expect(page.getByTestId('snap')).toHaveCount(0);
  expect(await frameOf(page, ids.a)).toEqual({ x: 100, y: 100, width: 80, height: 60 });

  // Equal spacing: `a` and `b` are 60 apart (x 180 -> 240). Dragging `s1` (x 520..640) by -137
  // puts its left at 383, 3 from the same gap after `b` (320 + 60 = 380): the spacing offer wins
  // (no align offer is within 6), and the gaps are drawn while the drag lasts.
  const s1 = { x: 530, y: 110 };
  await drag(page, await screen(s1), await screen({ x: s1.x - 137, y: s1.y }), false);
  const spacing = await page.evaluate(() => window.__p5Host!.editor.query({ type: 'snap' }));
  expect(spacing!.gaps).toEqual([
    { a: { x: 180, y: 130 }, b: { x: 240, y: 130 } },
    { a: { x: 320, y: 130 }, b: { x: 380, y: 130 } },
  ]);
  await expect(page.getByTestId('snap-gap')).toHaveCount(2);
  await page.mouse.up();
  await expect(page.getByTestId('snap')).toHaveCount(0);
  expect(await frameOf(page, ids.s1)).toEqual({ x: 380, y: 100, width: 120, height: 120 });

  // Rotate cursor: outside the selected box near a corner, but not over its handle.
  await click(page, await screen(AT.b));
  const host = page.getByTestId('canvas-host');
  const zone = await screen({ x: 328, y: 92 });
  await page.mouse.move(zone.x, zone.y);
  await expect(host).toHaveAttribute('data-cursor', 'rotate');
  const middle = await screen(AT.b);
  await page.mouse.move(middle.x, middle.y);
  await expect(host).toHaveAttribute('data-cursor', 'default');
  const handle = await screen({ x: 321, y: 99 });
  await page.mouse.move(handle.x, handle.y);
  await expect(host).toHaveAttribute('data-cursor', 'default');

  // A Shift rotation from the zone steps by 15 degrees and shows the snapped angle, with
  // snapping on and, after an undo, with it off (the Shift step is section 4.1's, M2-U3 note 5).
  const shiftRotate = async () => {
    await page.mouse.move(zone.x, zone.y);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    const target = await screen({ x: 330, y: 190 });
    await page.mouse.move(target.x, target.y, { steps: 6 });
    const label = page.getByTestId('snap-angle');
    await expect(label).toHaveCount(1);
    const angle = Number(await label.getAttribute('data-angle'));
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const rotation = (await readDocument(page)).nodes[ids.b]!.rotation;
    expect(rotation).not.toBe(0);
    expect(rotation).toBeCloseTo(angle, 12);
    const steps = rotation / (Math.PI / 12);
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    await expect(page.getByTestId('snap')).toHaveCount(0);
  };
  await shiftRotate();
  await page.getByTestId('undo').click();
  expect((await readDocument(page)).nodes[ids.b]!.rotation).toBe(0);
  await setSnapping(page, false);
  await shiftRotate();
  await expectClean(page, errors);
});
