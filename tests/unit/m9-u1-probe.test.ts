// MVP M9-U1 (M9 contract, section 3.2; E26 contract, section 3.5): the harness's page probe
// counts only canvas presses and releases. The laptop pre-run at 044e597 found that the layer
// toggles an M9 run clicks before the drag counted as presses, so `downs[0]` was a toggle click,
// no latency sample fell in the press window and "one press" failed (3 presses). This runs the
// probe's own function (tests/e26/probe.ts, the one the harness installs) against a stub window.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPageProbe, type Probe } from '../e26/probe.js';

const root = path.resolve(import.meta.dirname, '../..');

type Listener = (event: unknown) => void;
class StubCanvas {
  getAttribute() {
    return null;
  }
  readonly tagName = 'CANVAS';
}
class StubButton {
  constructor(private readonly testId: string | null) {}
  getAttribute(name: string) {
    return name === 'data-testid' ? this.testId : null;
  }
  readonly tagName = 'BUTTON';
}

function stub() {
  const listeners = new Map<string, Listener[]>();
  const add = (type: string, listener: Listener) =>
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  const target = { addEventListener: add } as Record<string, unknown>;
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { addEventListener: add });
  vi.stubGlobal('HTMLCanvasElement', StubCanvas);
  installPageProbe();
  const dispatch = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return { probe: target.__e26Probe as Probe, dispatch };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('M9-U1: the harness probe counts canvas presses only', () => {
  it('ignores the layer-toggle clicks before the drag and keeps the press timestamps', () => {
    const { probe, dispatch } = stub();
    const toggle = (id: string, at: number) => {
      const button = new StubButton(`layer-toggle-${id}`);
      dispatch('pointerdown', { target: button, timeStamp: at });
      dispatch('pointerup', { target: button, timeStamp: at + 1 });
    };
    toggle('f1', 5880);
    toggle('g3', 5952);
    const canvas = new StubCanvas();
    dispatch('pointerdown', { target: canvas, timeStamp: 6620 });
    dispatch('pointerup', { target: canvas, timeStamp: 10_640 });
    expect(probe.downs).toEqual([6620]);
    expect(probe.ups).toEqual([10_640]);
    expect(probe.downsHandled).toHaveLength(1);
    expect(probe.upsHandled).toHaveLength(1);
    expect(probe.otherDowns).toEqual(['layer-toggle-f1', 'layer-toggle-g3']);
    expect(probe.otherUps).toEqual(['layer-toggle-f1', 'layer-toggle-g3']);
    // A second canvas press is still a second press: "one press" stays meaningful.
    dispatch('pointerdown', { target: canvas, timeStamp: 11_000 });
    expect(probe.downs).toHaveLength(2);
    // A target without a test ID is named by its tag.
    dispatch('pointerdown', { target: new StubButton(null), timeStamp: 11_100 });
    expect(probe.otherDowns.at(-1)).toBe('BUTTON');
  });

  it('records page errors with their stack and page time', () => {
    const { probe, dispatch } = stub();
    const error = new Error('Minified React error #185');
    dispatch('error', { error, message: error.message });
    dispatch('unhandledrejection', { reason: 'plain' });
    expect(probe.pageErrors).toHaveLength(2);
    expect(probe.pageErrors[0]).toMatchObject({ kind: 'error', message: error.message });
    expect(probe.pageErrors[0]!.stack).toContain('Minified React error #185');
    expect(Number.isFinite(probe.pageErrors[0]!.atMs)).toBe(true);
    expect(probe.pageErrors[1]).toMatchObject({ kind: 'rejection', message: 'plain', stack: null });
  });

  it('is the probe the harness installs, and the harness asserts one canvas press', () => {
    const spec = readFileSync(path.join(root, 'tests/e26/e26-harness.spec.ts'), 'utf8');
    expect(spec).toContain('await page.addInitScript(installPageProbe);');
    // No second probe: the old inline listener is gone.
    expect(spec).not.toMatch(/addEventListener\(\s*'pointerdown'/u);
    expect(spec).toContain("expect(probe.downs.length, 'one press').toBe(1);");
    expect(spec).toContain('layers?.expanded.length ?? 0');
    // The probe's function is self-contained (Playwright serializes its source).
    const source = installPageProbe.toString();
    expect(source).not.toMatch(/\b(?:import|require)\b/u);
  });
});
