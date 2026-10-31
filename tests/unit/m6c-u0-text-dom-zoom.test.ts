import { describe, expect, it } from 'vitest';
import { cancelLayoutZoom, layoutZoom } from '../../packages/text-dom/src/measure.js';

// MVP M6c-U0 (docs/plans/mvp-m6c-gpu-text-contract.md, section 3; docs/evidence/m6c-u0/README.md):
// text-dom cancels the page's layout zoom on its measurement host, so Chromium rounds font
// metrics at the same size at every browser zoom and real device scale. `layoutZoom` reads that
// zoom from the layout unit, since `devicePixelRatio` reports CDP's emulated ratio while layout
// stays at the real one. The DOM side is checked in a browser by docs/evidence/m6c-u0/probe.mjs
// and the M6a headed spec.

/**
 * A host whose width reads back as Chromium lays it out at the page's layout zoom `layoutAt`
 * times its own `zoom` (ignored when `honourZoom` is false): floored to 1/64 layout px, reported
 * in page px. Chromium keeps the effective zoom in float, so a product within 1e-9 of 1 is 1.
 */
function host(layoutAt: number, honourZoom = true, rendered = true) {
  const style = new Map<string, string>();
  const element = {
    style: {
      setProperty(property: string, value: string) {
        style.set(property, value);
      },
    },
    getClientRects() {
      return rendered ? [{}] : [];
    },
    getBoundingClientRect() {
      if (!rendered) return { width: 0 } as DOMRect;
      const css = Number.parseFloat(style.get('width') ?? '0');
      const own = honourZoom ? Number.parseFloat(style.get('zoom') ?? '1') : 1;
      let effective = layoutAt * own;
      if (Math.abs(effective - 1) <= 1e-9) effective = 1;
      return { width: (Math.floor(css * effective * 64) / 64 / effective) * own } as DOMRect;
    },
  };
  return { element: element as unknown as HTMLElement, style };
}

describe('M6c-U0 layoutZoom', () => {
  it.each([1.25, 1.5, 1.875, 2, 1.100000023841858, 0.8999999761581421, 0.5, 0.25, 3, 31])(
    'gives the layout zoom when devicePixelRatio reports it (%s)',
    (ratio) => {
      const { element, style } = host(ratio);
      expect(layoutZoom(element, ratio)).toBe(ratio);
      expect(style.get('zoom')).toBe('1');
      expect(style.get('width')).toBe('0');
    },
  );

  it.each([1, 1.25, 1.5, 2, 0.5, 3])(
    'gives 1 under emulation, laid out at 1 with the ratio %s reported',
    (ratio) => {
      expect(layoutZoom(host(1).element, ratio)).toBe(1);
    },
  );

  it.each([
    [1.25, 1],
    [1.25, 1.5],
    [1.5, 1.25],
    [1.875, 2],
  ])('gives the real layout zoom %s under an emulated ratio %s', (layoutAt, ratio) => {
    expect(layoutZoom(host(layoutAt).element, ratio)).toBeCloseTo(layoutAt, 12);
  });

  it('snaps a float32 reading to the reported ratio', () => {
    // At E = 1.25 the 1/64 px width reads one unit, as float32, and the 1/128 px width reads 0.
    const { element } = host(1.25);
    const reading = Math.fround(1 / 80);
    let calls = 0;
    element.getBoundingClientRect = () => ({ width: calls++ === 0 ? reading : 0 }) as DOMRect;
    expect(reading).not.toBe(1 / 80);
    expect(layoutZoom(element, 1.25)).toBe(1.25);
  });

  it.each([64, 1 / 128, 0])('gives null when the zoom is out of range (%s)', (layoutAt) => {
    const { element, style } = host(layoutAt);
    if (layoutAt === 0) element.getBoundingClientRect = () => ({ width: 0 }) as DOMRect;
    expect(layoutZoom(element, 1.25)).toBeNull();
    expect(style.get('width')).toBe('0');
  });

  it('gives null without reading when the host has no layout box (not rendered)', () => {
    const { element } = host(1.25, true, false);
    let reads = 0;
    element.getBoundingClientRect = () => {
      reads += 1;
      return { width: 0 } as DOMRect;
    };
    expect(layoutZoom(element, 1.25)).toBeNull();
    expect(reads).toBe(0);
  });
});

describe('M6c-U0 cancelLayoutZoom', () => {
  it.each([1.25, 1.5, 1.875, 2, 0.8999999761581421])(
    'sets zoom 1/E on the host and checks it lays out at 1 (%s)',
    (ratio) => {
      const { element, style } = host(ratio);
      expect(cancelLayoutZoom(element, ratio)).toBe(ratio);
      expect(style.get('zoom')).toBe(String(1 / ratio));
      expect(style.get('width')).toBe('0');
    },
  );

  it('leaves zoom 1 when the page is laid out at 1', () => {
    const { element, style } = host(1);
    expect(cancelLayoutZoom(element, 1.25)).toBe(1);
    expect(style.get('zoom')).toBe('1');
  });

  it('gives null with zoom 1 when the host is not rendered, so the caller does not keep it', () => {
    const { element, style } = host(1.25, true, false);
    expect(cancelLayoutZoom(element, 1.25)).toBeNull();
    expect(style.get('zoom')).toBe('1');
  });

  it('falls back to 1 when the host does not lay out at zoom 1 after cancelling', () => {
    const { element, style } = host(1.25, false);
    expect(cancelLayoutZoom(element, 1.25)).toBe(1);
    expect(style.get('zoom')).toBe('1');
    expect(style.get('width')).toBe('0');
  });
});
