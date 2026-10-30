// MVP M4-A13 (M4 contract, section 9): a deterministic page of 10,000 stroked rectangles, for the
// load, projection, `setStyle` and frame time observation. It is built from indices alone, so
// the observation needs no committed JSON fixture. Each rectangle is 8 x 8 in a 100 x 100 grid
// of 10-unit cells, filled solid and stroked 1 unit wide (butt cap, miter limit 4, no dash).
// With a `round` join every rectangle projects as a P1 primitive; with a `miter` join each one
// projects as an M4-P4 outline path (M4-P3).

export const M4_A13_COUNT = 10_000;
export const M4_A13_PAGE = 'page';
const COLUMNS = 100;

export type M4A13Join = 'round' | 'miter';

export function generateM4A13Document(join: M4A13Join) {
  const nodes: Record<string, unknown> = {};
  const children: string[] = [];
  for (let index = 0; index < M4_A13_COUNT; index += 1) {
    const id = `R${index}`;
    children.push(id);
    nodes[id] = {
      id,
      name: id,
      parent: M4_A13_PAGE,
      frame: {
        x: (index % COLUMNS) * 10,
        y: Math.floor(index / COLUMNS) * 10,
        width: 8,
        height: 8,
      },
      rotation: 0,
      constraints: { horizontal: 'start', vertical: 'start' },
      opacity: 1,
      visible: true,
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: { r: (index % 7) / 6, g: 0.5, b: 1 - (index % 5) / 4, a: 1 },
      stroke: {
        color: { r: 0, g: 0, b: 0, a: 1 },
        width: 1,
        cap: 'butt',
        join,
        miterLimit: 4,
        dash: null,
      },
    };
  }
  return {
    schemaVersion: 6,
    id: `m4-a13-${join}`,
    pages: [{ id: M4_A13_PAGE, name: 'Page 1', children }],
    nodes,
  };
}
