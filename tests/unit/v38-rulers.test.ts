import type { NodeV8 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  GUIDE_LIMIT,
  dragStale,
  guideAt,
  guideValue,
  mayPickGuide,
  releaseRemoves,
  releasedGuides,
  rulerStep,
  rulerTicks,
  type GuideDrag,
  type PickState,
} from '../../apps/next-host/src/v38-rulers-model';
import {
  addGridCommand,
  gridNumberCommand,
  gridNumberKeys,
  gridOpacityCommand,
  gridTypeCommand,
  layoutGridTarget,
  newLayoutGrid,
  removeGridCommand,
  toggleGridCommand,
  type GridHolder,
} from '../../packages/ui/src/layout-grid-model';

// V-38 contract, V38-A05 (V38-H1, H2: ruler ticks and the guide drag model) and V38-A06 (V38-U1:
// the layout grid section's commands).

const camera = (x: number, y: number, zoom: number) => ({ position: { x, y }, zoom });

describe('V38-A05 ruler ticks', () => {
  it('picks 1, 2 or 5 × 10^k at least 50 px apart', () => {
    expect([1, 0.5, 0.2, 0.1, 2, 10, 64].map(rulerStep)).toEqual([50, 100, 500, 500, 50, 5, 1]);
  });

  it('labels the majors in view and puts minors between them', () => {
    const ticks = rulerTicks(-30, 1, 200);
    expect(ticks.step).toBe(50);
    expect(ticks.major.map((tick) => [tick.px, tick.label])).toEqual([
      [30, '0'],
      [80, '50'],
      [130, '100'],
      [180, '150'],
    ]);
    // A tenth of 50 at zoom 1 is 5 px apart: minors every 5 units, majors excluded.
    expect(ticks.minor.slice(0, 3)).toEqual([0, 5, 10]);
    expect(ticks.minor.includes(30)).toBe(false);
    // At zoom 2 the step is 50 too (100 px), so minors are a tenth (10 px).
    expect(rulerTicks(0, 2, 100).minor[0]).toBe(10);
  });
});

describe('V38-A05 guides: picking, pick-up precedence and the drag result', () => {
  const guides = [
    { axis: 'x', value: 100 },
    { axis: 'y', value: 50 },
  ] as const;

  it('picks the guide within 3 px', () => {
    const view = camera(0, 0, 2);
    expect(guideAt(guides, view, 203, 0)).toBe(0);
    expect(guideAt(guides, view, 204, 0)).toBeNull();
    expect(guideAt(guides, view, 500, 98)).toBe(1);
  });

  const state = (over: Partial<PickState> = {}): PickState => ({
    tool: 'select',
    busy: false,
    corners: null,
    camera: camera(0, 0, 1),
    ...over,
  });
  const box = [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 200, y: 150 },
    { x: 100, y: 150 },
  ];

  it('picks up only with the select tool, idle, away from the selection box and rotate zone', () => {
    expect(mayPickGuide(state(), 10, 10)).toBe(true);
    expect(mayPickGuide(state({ tool: 'rectangle' }), 10, 10)).toBe(false);
    expect(mayPickGuide(state({ busy: true }), 10, 10)).toBe(false);
    expect(mayPickGuide(state({ corners: box }), 150, 125)).toBe(false);
    // 12 px past the top-left corner diagonally is in the M2 rotate zone (18 px).
    expect(mayPickGuide(state({ corners: box }), 112 - 24, 88)).toBe(false);
    expect(mayPickGuide(state({ corners: box }), 220, 125)).toBe(true);
    // A zoomed view measures in CSS px.
    expect(mayPickGuide(state({ corners: box, camera: camera(0, 0, 2) }), 430, 250)).toBe(true);
    expect(mayPickGuide(state({ corners: box, camera: camera(0, 0, 2) }), 410, 250)).toBe(false);
    // A horizontal line (zero height) measures across from it.
    const line = [box[0]!, box[1]!, box[1]!, box[0]!];
    expect(mayPickGuide(state({ corners: line }), 150, 110)).toBe(false);
    expect(mayPickGuide(state({ corners: line }), 150, 130)).toBe(true);
  });

  it('rounds and clamps values, removes on its own ruler or outside, and writes the list', () => {
    expect(guideValue(10.5)).toBe(11);
    expect(guideValue(-0.2)).toBe(0);
    expect(guideValue(5e7)).toBe(GUIDE_LIMIT);
    expect(releaseRemoves('y', 300, 10, 800, 600)).toBe(true);
    expect(releaseRemoves('y', 10, 300, 800, 600)).toBe(false);
    expect(releaseRemoves('x', 10, 300, 800, 600)).toBe(true);
    expect(releaseRemoves('x', 300, 700, 800, 600)).toBe(true);
    const drag = (index: number | null, value: number): GuideDrag => ({
      axis: 'x',
      index,
      value,
      page: 'p',
      revision: 3,
    });
    expect(releasedGuides(guides, drag(null, 7), false)).toEqual([
      ...guides,
      { axis: 'x', value: 7 },
    ]);
    expect(releasedGuides(guides, drag(null, 7), true)).toBeNull();
    expect(releasedGuides(guides, drag(0, 7), false)).toEqual([{ axis: 'x', value: 7 }, guides[1]]);
    expect(releasedGuides(guides, drag(0, 7), true)).toEqual([guides[1]]);
    expect(releasedGuides(guides, drag(5, 7), true)).toBeNull();
    expect(dragStale(drag(0, 7), 3, 'p')).toBe(false);
    expect(dragStale(drag(0, 7), 4, 'p')).toBe(true);
    expect(dragStale(drag(0, 7), 3, 'q')).toBe(true);
  });
});

describe('V38-A06 layout grid section model', () => {
  const frame = {
    id: 'F',
    name: 'F',
    parent: 'p',
    frame: { x: 0, y: 0, width: 100, height: 100 },
    rotation: 0,
    constraints: { horizontal: 'start', vertical: 'start' },
    opacity: 1,
    visible: true,
    type: 'frame',
    children: [],
    fill: null,
    stroke: null,
    effects: [],
  } as unknown as GridHolder;
  const withGrids = { ...frame, layoutGrids: [newLayoutGrid('columns')] } as GridHolder;

  it('targets one frame or symbol only', () => {
    expect(layoutGridTarget([frame])).toBe(frame);
    expect(layoutGridTarget([frame, frame])).toBeNull();
    expect(layoutGridTarget([{ ...frame, type: 'group' } as unknown as NodeV8])).toBeNull();
  });

  it('adds, edits and removes with one setNodeProps of the whole list', () => {
    expect(addGridCommand(frame, 'grid')).toEqual({
      type: 'setNodeProps',
      id: 'F',
      props: { layoutGrids: [newLayoutGrid('grid')] },
    });
    const props = (command: unknown) =>
      (command as { props: { layoutGrids: unknown[] } }).props.layoutGrids;
    expect(props(removeGridCommand(withGrids, 0))).toEqual([]);
    expect(props(toggleGridCommand(withGrids, 0))).toEqual([
      { ...newLayoutGrid('columns'), visible: false },
    ]);
    expect(props(gridTypeCommand(withGrids, 0, 'rows'))).toEqual([
      { ...newLayoutGrid('columns'), type: 'rows' },
    ]);
    expect(props(gridNumberCommand(withGrids, 0, 'gutter', '8'))).toEqual([
      { ...newLayoutGrid('columns'), gutter: 8 },
    ]);
    expect(gridNumberCommand(withGrids, 0, 'count', '2.5')).toBeNull();
    expect(gridNumberCommand(withGrids, 0, 'count', '0')).toBeNull();
    expect(gridNumberCommand(withGrids, 0, 'gutter', 'x')).toBeNull();
    expect(props(gridOpacityCommand(withGrids, 0, '50%'))).toEqual([
      { ...newLayoutGrid('columns'), color: { r: 1, g: 0, b: 0, a: 0.5 } },
    ]);
    expect(gridNumberKeys(newLayoutGrid('columns'))).toEqual(['count', 'gutter', 'offset']);
    expect(gridNumberKeys({ ...newLayoutGrid('rows'), align: 'center' } as never)).toEqual([
      'count',
      'size',
      'gutter',
    ]);
  });
});
