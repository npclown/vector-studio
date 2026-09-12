import { describe, expect, it } from 'vitest';
import type { VisualFixture } from '../support/p1-visual-corpus.js';
import {
  invalidContainerSnapshot,
  precisionFixtures,
  visualCullingFixture,
  visualFixtures,
} from '../support/p1-visual-corpus.js';
import { inspectPixels } from '../support/p1-visual-oracle.js';

function setPixel(bytes: Uint8Array, width: number, x: number, y: number, rgba: readonly number[]) {
  bytes.set(rgba, (y * width + x) * 4);
}

function rectangleImage(
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  rgba: readonly number[] = [255, 255, 255, 255],
): Uint8Array {
  const bytes = new Uint8Array(width * height * 4);
  for (let y = top; y < bottom; y += 1)
    for (let x = left; x < right; x += 1) setPixel(bytes, width, x, y, rgba);
  return bytes;
}

describe('P1 headed visual corpus', () => {
  it('has literal V01-V07 coverage and a separately explicit V06 rejection input', () => {
    const ids = visualFixtures().map(({ id }) => id);
    for (const required of ['V01-', 'V02-', 'V03-', 'V04-', 'V05-', 'V06-', 'V07-'])
      expect(ids.some((id) => id.startsWith(required))).toBe(true);
    expect(invalidContainerSnapshot().nodes[0]).toMatchObject({ kind: 'container', opacity: 0.5 });
    expect(visualCullingFixture().expectedVisibleIds).toEqual([
      'left-touch',
      'right-touch',
      'top-touch',
      'bottom-touch',
    ]);
    for (const id of ['V02-fill-stroke-opacity', 'V03-overlap-forward', 'V03-overlap-reversed'])
      expect(visualFixtures().find((fixture) => fixture.id === id)?.transparent).toBe(true);
    expect(
      visualFixtures()
        .filter(({ transparent }) => transparent)
        .map(({ id }) => id),
    ).toEqual(['V02-fill-stroke-opacity', 'V03-overlap-forward', 'V03-overlap-reversed']);
  });
  it('generates the full stable N02 Cartesian product for each accepted DPR', () => {
    for (const dpr of [1, 1.5, 2]) {
      const fixtures = precisionFixtures(dpr);
      expect(fixtures).toHaveLength(504);
      expect(new Set(fixtures.map(({ id }) => id)).size).toBe(504);
    }
  });
  it('accepts exact premultiplied transparent pixels and reports a concrete sample mismatch', () => {
    const fixture = visualFixtures().find(({ id }) => id === 'V03-overlap-forward')!;
    const rgba = new Uint8Array(640 * 360 * 4);
    const report = inspectPixels(fixture, 1, 640, 360, rgba);
    expect(report.pass).toBe(false);
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.failures[0]).toMatch(/RGBA|edge color disagreement/);
  });
  it('rejects both a shifted contour and an expanded contour by more than one physical pixel', () => {
    const fixture: VisualFixture = {
      id: 'oracle-mutation',
      transparent: true,
      camera: { position: { x: 0, y: 0 }, zoom: 1 },
      snapshot: {
        identity: { documentId: 'fixture-doc', pageId: 'fixture-page' },
        revision: 0,
        rootOrder: ['shape'],
        nodes: [
          {
            id: 'shape',
            parentId: null,
            kind: 'primitive',
            transform: [1, 0, 0, 1, 20, 20],
            visible: true,
            opacity: 1,
            geometry: { kind: 'rectangle', width: 20, height: 20, cornerRadii: [0, 0, 0, 0] },
            style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
          },
        ],
      },
    };
    const image = (left: number, top: number, right: number, bottom: number) =>
      rectangleImage(64, 64, left, top, right, bottom);
    const baseline = inspectPixels(fixture, 1, 64, 64, image(20, 20, 40, 40));
    expect(baseline.pass, JSON.stringify(baseline.failures)).toBe(true);
    expect(inspectPixels(fixture, 1, 64, 64, image(21, 20, 41, 40)).pass).toBe(true);
    expect(inspectPixels(fixture, 1, 64, 64, image(22, 20, 42, 40)).pass).toBe(false);
    expect(inspectPixels(fixture, 1, 64, 64, image(18, 18, 42, 42)).pass).toBe(false);
    expect(inspectPixels(fixture, 1, 64, 64, new Uint8Array(64 * 64 * 4)).pass).toBe(false);
    expect(
      inspectPixels(fixture, 1, 64, 64, rectangleImage(64, 64, 20, 20, 40, 40, [255, 0, 0, 255]))
        .pass,
    ).toBe(false);
  });
  it('uses exact binary premultiplied colors only beyond both centered-stroke contours', () => {
    const fixture = visualFixtures().find(({ id }) => id === 'V02-fill-stroke-opacity')!;
    const bytes = new Uint8Array(96 * 72 * 4);
    for (let y = 0; y < 72; y += 1) {
      for (let x = 0; x < 96; x += 1) {
        const localX = x + 0.5 - 20.25;
        const localY = y + 0.5 - 20.5;
        const distance = Math.max(-localX, localX - 40, -localY, localY - 30);
        if (Math.abs(distance) <= 2) setPixel(bytes, 96, x, y, [128, 0, 0, 128]);
        else if (distance <= 0) setPixel(bytes, 96, x, y, [0, 0, 128, 128]);
      }
    }
    const report = inspectPixels(fixture, 1, 96, 72, bytes);
    expect(report.pass, JSON.stringify(report.failures)).toBe(true);
    expect(
      report.samples.some(({ expected }) => expected[0] === 0.5 && expected[3] === 0.5),
      JSON.stringify(report.samples),
    ).toBe(true);
    expect(report.samples.some(({ expected }) => expected[2] === 0.5 && expected[3] === 0.5)).toBe(
      true,
    );
  });
  it('accepts the literal forward and reverse V03 premultiplied overlap colors', () => {
    for (const [id, overlap] of [
      ['V03-overlap-forward', [64, 0, 128, 191]],
      ['V03-overlap-reversed', [128, 0, 64, 191]],
    ] as const) {
      const fixture = visualFixtures().find((candidate) => candidate.id === id)!;
      const bytes = new Uint8Array(160 * 140 * 4);
      for (let y = 30; y < 110; y += 1)
        for (let x = 30; x < 110; x += 1) setPixel(bytes, 160, x, y, [128, 0, 0, 128]);
      for (let y = 50; y < 130; y += 1)
        for (let x = 50; x < 130; x += 1)
          setPixel(bytes, 160, x, y, x < 110 && y < 110 ? overlap : [0, 0, 128, 128]);
      const report = inspectPixels(fixture, 1, 160, 140, bytes);
      expect(report.pass, `${id}: ${JSON.stringify(report.failures)}`).toBe(true);
      expect(
        report.samples.some(
          ({ expected }) =>
            Math.abs(expected[0] - overlap[0] / 255) <= 2 / 255 &&
            Math.abs(expected[2] - overlap[2] / 255) <= 2 / 255 &&
            expected[3] === 0.75,
        ),
      ).toBe(true);
    }
  });
  it('checks the complete blank V06 surface and catches a rogue degenerate fragment', () => {
    const fixture = visualFixtures().find(({ id }) => id === 'V06-hidden-degenerate')!;
    const blank = new Uint8Array(64 * 64 * 4);
    for (let index = 3; index < blank.length; index += 4) blank[index] = 255;
    expect(inspectPixels(fixture, 1, 64, 64, blank).pass).toBe(true);
    const rogue = blank.slice();
    setPixel(rogue, 64, 20, 20, [255, 255, 255, 255]);
    expect(inspectPixels(fixture, 1, 64, 64, rogue).pass).toBe(false);
  });
  it('uses transformed analytic distance for the one-pixel edge gate', () => {
    const fixture: VisualFixture = {
      id: 'oracle-affine-mutation',
      transparent: true,
      camera: { position: { x: 0, y: 0 }, zoom: 1 },
      snapshot: {
        identity: { documentId: 'fixture-doc', pageId: 'fixture-page' },
        revision: 0,
        rootOrder: ['shape'],
        nodes: [
          {
            id: 'shape',
            parentId: null,
            kind: 'primitive',
            transform: [2, 0, 0, 0.5, 20, 20],
            visible: true,
            opacity: 1,
            geometry: { kind: 'rectangle', width: 10, height: 20, cornerRadii: [0, 0, 0, 0] },
            style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
          },
        ],
      },
    };
    expect(inspectPixels(fixture, 1, 64, 64, rectangleImage(64, 64, 20, 20, 40, 30)).pass).toBe(
      true,
    );
    const shifted = inspectPixels(fixture, 1, 64, 64, rectangleImage(64, 64, 22, 20, 42, 30));
    expect(shifted.pass).toBe(false);
    expect(shifted.edgeMaximumError).toBeGreaterThan(1);
  });
  it('separates V05 low-coverage AA fringe from line edge location and requires geometry', () => {
    const fixture = visualFixtures().find(({ id }) => id === 'V05-butt-line-scale')!;
    const image = (left: number, right: number) => {
      const bytes = new Uint8Array(160 * 180 * 4);
      for (let index = 3; index < bytes.length; index += 4) bytes[index] = 255;
      for (let x = left; x < right; x += 1) setPixel(bytes, 160, x, 140, [255, 255, 255, 255]);
      return bytes;
    };
    const baseline = image(20, 100);
    setPixel(baseline, 160, 101, 139, [28, 28, 28, 255]);
    const baselineReport = inspectPixels(fixture, 1, 160, 180, baseline);
    expect(baselineReport.pass, JSON.stringify(baselineReport.failures)).toBe(true);
    expect(
      baselineReport.edgeComparisons.some(
        ({ position, actual, classifiedRegion }) =>
          position.x === 101 &&
          position.y === 139 &&
          actual[0] === 28 / 255 &&
          classifiedRegion[0] === 0,
      ),
    ).toBe(true);

    expect(inspectPixels(fixture, 1, 160, 180, image(0, 0)).pass).toBe(false);
    expect(inspectPixels(fixture, 1, 160, 180, image(22, 102)).pass).toBe(false);
    expect(inspectPixels(fixture, 1, 160, 180, image(18, 102)).pass).toBe(false);
  });
  it('finds the nearest full-period ellipse point across the zero-angle wrap', () => {
    const fixture: VisualFixture = {
      id: 'oracle-periodic-ellipse',
      transparent: true,
      camera: { position: { x: 0, y: 0 }, zoom: 1 },
      snapshot: {
        identity: { documentId: 'fixture-doc', pageId: 'fixture-page' },
        revision: 0,
        rootOrder: ['circle'],
        nodes: [
          {
            id: 'circle',
            parentId: null,
            kind: 'primitive',
            transform: [1, 0, 0, 1, 20.25, 20.5],
            visible: true,
            opacity: 1,
            geometry: { kind: 'ellipse', width: 40, height: 40 },
            style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
          },
        ],
      },
    };
    const expanded = new Uint8Array(80 * 80 * 4);
    for (let y = 0; y < 80; y += 1)
      for (let x = 0; x < 80; x += 1)
        if (Math.hypot(x + 0.5 - 40.25, y + 0.5 - 40.5) <= 21)
          setPixel(expanded, 80, x, y, [255, 255, 255, 255]);
    const report = inspectPixels(fixture, 1, 80, 80, expanded);
    expect(report.pass, JSON.stringify(report.failures)).toBe(true);
    const wrapped = report.edgeComparisons.find(
      ({ position }) => position.x === 60 && position.y === 39,
    );
    expect(wrapped?.analyticDistance).toBeLessThan(0.3);
  });
});
