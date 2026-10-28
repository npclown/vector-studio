import {
  IDENTITY,
  WHITE,
  container,
  ellipse,
  leaf,
  multiply,
  polygon,
  rect,
  rotate,
  scale,
  translate,
  type Affine,
  type P4Item,
  type P4Leaf,
  type Rgba,
  type View,
} from '../support/p4-clip-oracle.js';

// P4 contract, unit U5: the image cases of the headed clip and mask spec (P4-A02 to A05, A10).
// Every case is centred on world point CENTRE, and its camera maps CENTRE to the frame centre at
// every DPR, so the same case runs at DPR 1 and 2 (at DPR 2 it shows half the world extent).

export const FRAME = Object.freeze({ width: 512, height: 320 });
export const CENTRE = Object.freeze({ x: 200, y: 120 });

export type ImageCase = Readonly<{
  id: string;
  criterion: 'P4-A02' | 'P4-A03' | 'P4-A04' | 'P4-A05' | 'P4-A10';
  items: readonly P4Item[];
  zoom: number;
  /** Camera centre in the world; CENTRE when absent. */
  centre?: Readonly<{ x: number; y: number }>;
  /**
   * The one opaque content leaf whose clip chain the edge check multiplies; edge pixels are
   * checked where it covers and every other drawn leaf does not.
   */
  edgeContent?: string;
  /**
   * No edge check: the case's edges are not one opaque content leaf's (P4-A05, A10). Any other
   * case with a clip level must name `edgeContent`.
   */
  interiorOnly?: true;
  /** Mask sources are coloured, content is white: any coloured pixel means a source painted. */
  grey?: boolean;
  /** Named world probes for P4-A05, with their roles. */
  named?: readonly Readonly<{ name: string; x: number; y: number }>[];
  /** The items the oracle evaluates, when the product draws less than `items` (P4-A10). */
  expectedItems?: readonly P4Item[];
  /** P4-A10: the diagnostics the case must add, by code and node id; nothing else. */
  diagnostics?: readonly Readonly<{ code: string; nodeId: string }>[];
}>;

export function viewOf(
  zoom: number,
  devicePixelRatio: number,
  centre: Readonly<{ x: number; y: number }> = CENTRE,
): View {
  const factor = zoom * devicePixelRatio;
  return {
    camera: {
      position: {
        x: centre.x - FRAME.width / 2 / factor,
        y: centre.y - FRAME.height / 2 / factor,
      },
      zoom,
    },
    devicePixelRatio,
    width: FRAME.width,
    height: FRAME.height,
  };
}

/** An opaque leaf covering four frame extents at `zoom` around `centre`. */
export function cover(
  id: string,
  zoom: number,
  fill: Rgba = WHITE,
  centre: Readonly<{ x: number; y: number }> = CENTRE,
): P4Leaf {
  const span = (4 * FRAME.width) / zoom;
  return leaf(id, rect(span, span), translate(centre.x - span / 2, centre.y - span / 2), fill);
}

/** A path covering the same area as `cover`, so the content is meshed by the real port. */
export function coverPath(id: string, zoom: number): P4Leaf {
  const span = (4 * FRAME.width) / zoom;
  const x = CENTRE.x - span / 2;
  const y = CENTRE.y - span / 2;
  return leaf(id, polygon([[0, 0, span, 0, span, span, 0, span]]), translate(x, y));
}

/** A rect clip of width x height centred on (cx, cy), rotated by `degrees` about its centre. */
function centredRect(
  id: string,
  degrees: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
  children: readonly P4Item[],
  base: Affine = IDENTITY,
) {
  return container(
    id,
    multiply(base, rotate(degrees, cx, cy)),
    {
      kind: 'rect',
      x: -width / 2,
      y: -height / 2,
      width,
      height,
    },
    children,
  );
}

/** A02: a parent rotating 30° about CENTRE, and its child's placement in the parent's space. */
const PARENT = multiply(rotate(30, CENTRE.x, CENTRE.y), translate(-CENTRE.x, -CENTRE.y));
const CHILD_OF_PARENT = multiply(translate(CENTRE.x, CENTRE.y), scale(1.2));

const SOURCE_BLUE: Rgba = { r: 0.1, g: 0.2, b: 1, a: 0.6 };

/** A five-point star (pentagram) around the origin: nonzero fills its centre, evenodd does not. */
function star(radius: number): number[] {
  const points: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const angle = -Math.PI / 2 + (index * 4 * Math.PI) / 5;
    points.push(radius * Math.cos(angle), radius * Math.sin(angle));
  }
  return points;
}

/** A mask container at the identity over a white cover, with `source` as its first child. */
function maskOver(id: string, source: P4Leaf, zoom = 1, content?: P4Leaf): P4Item {
  return container(id, IDENTITY, { kind: 'mask' }, [
    source,
    content ?? cover(`${id}-content`, zoom),
  ]);
}

const sourceAt = (degrees: number) => rotate(degrees, CENTRE.x, CENTRE.y);

export const RECT_CASES: readonly ImageCase[] = [
  {
    id: 'a02-axis-top-level',
    criterion: 'P4-A02',
    zoom: 1,
    items: [centredRect('g', 0, CENTRE.x, CENTRE.y, 160, 100, [cover('c', 1)])],
    edgeContent: 'c',
  },
  ...[15, 45].map((degrees): ImageCase => ({
    id: `a02-rotated-${degrees}`,
    criterion: 'P4-A02',
    zoom: 1,
    items: [centredRect('g', degrees, CENTRE.x, CENTRE.y, 160, 100, [cover('c', 1)])],
    edgeContent: 'c',
  })),
  ...[0.5, 2].map((factor): ImageCase => ({
    id: `a02-scaled-${factor}`,
    criterion: 'P4-A02',
    zoom: 1,
    items: [
      container(
        'g',
        multiply(translate(CENTRE.x, CENTRE.y), multiply(rotate(10), scale(factor))),
        {
          kind: 'rect',
          x: -80 / factor,
          y: -50 / factor,
          width: 160 / factor,
          height: 100 / factor,
        },
        [cover('c', 1)],
      ),
    ],
    edgeContent: 'c',
  })),
  {
    id: 'a02-sheared-0.25',
    criterion: 'P4-A02',
    zoom: 1,
    items: [
      container(
        'g',
        multiply(translate(CENTRE.x, CENTRE.y), [1, 0, 0.25, 1, 0, 0]),
        { kind: 'rect', x: -80, y: -50, width: 160, height: 100 },
        [cover('c', 1)],
      ),
    ],
    edgeContent: 'c',
  },
  {
    id: 'a02-zoom-0.01',
    criterion: 'P4-A02',
    zoom: 0.01,
    items: [centredRect('g', 15, CENTRE.x, CENTRE.y, 16_000, 10_000, [cover('c', 0.01)])],
    edgeContent: 'c',
  },
  {
    id: 'a02-zoom-64',
    criterion: 'P4-A02',
    zoom: 64,
    items: [centredRect('g', 15, CENTRE.x, CENTRE.y, 2.5, 1.5625, [cover('c', 64)])],
    edgeContent: 'c',
  },
  {
    id: 'a02-under-transformed-parent',
    criterion: 'P4-A02',
    zoom: 1,
    // The clip is placed in the parent's space: the parent rotates by 30° about CENTRE and the
    // clip container scales by 1.2 inside it, so a wrong composition moves every edge.
    items: [
      container('p', PARENT, null, [
        centredRect('g', 0, 0, 0, 150, 90, [cover('c', 1)], multiply(PARENT, CHILD_OF_PARENT)),
      ]),
    ],
    edgeContent: 'c',
  },
  ...[0, 30].map((degrees): ImageCase => ({
    id: `a02-narrower-than-1px-${degrees}`,
    criterion: 'P4-A02',
    zoom: 1,
    items: [centredRect('g', degrees, CENTRE.x, CENTRE.y, 0.45, 100, [cover('c', 1)])],
    edgeContent: 'c',
  })),
  {
    id: 'a02-coloured-content',
    criterion: 'P4-A02',
    zoom: 1,
    items: [
      centredRect('g', 15, CENTRE.x, CENTRE.y, 160, 100, [
        cover('c', 1, { r: 0.2, g: 0.6, b: 0.9, a: 1 }),
      ]),
    ],
    edgeContent: 'c',
  },
  {
    id: 'a02-two-rect-levels',
    criterion: 'P4-A02',
    zoom: 1,
    items: [
      centredRect('g', 10, CENTRE.x - 10, CENTRE.y, 170, 110, [
        centredRect('h', -25, CENTRE.x + 15, CENTRE.y + 5, 150, 100, [cover('c', 1)]),
      ]),
    ],
    edgeContent: 'c',
  },
];

export const MASK_CASES: readonly ImageCase[] = [
  ...(['nonzero', 'evenodd'] as const).map((fillRule): ImageCase => ({
    id: `a03-star-${fillRule}`,
    criterion: 'P4-A03',
    zoom: 1,
    items: [maskOver('m', leaf('s', polygon([star(70)], fillRule), sourceAt(8), SOURCE_BLUE))],
    edgeContent: 'm-content',
    grey: true,
  })),
  ...(['nonzero', 'evenodd'] as const).map((fillRule): ImageCase => ({
    id: `a03-hole-${fillRule}`,
    criterion: 'P4-A03',
    zoom: 1,
    items: [
      maskOver(
        'm',
        leaf(
          's',
          polygon(
            [
              [-70, -45, 70, -45, 70, 45, -70, 45],
              // Reversed inside for nonzero, same orientation for evenodd: a hole either way.
              fillRule === 'nonzero'
                ? [-30, -20, -30, 20, 30, 20, 30, -20]
                : [-30, -20, 30, -20, 30, 20, -30, 20],
            ],
            fillRule,
          ),
          sourceAt(20),
          SOURCE_BLUE,
        ),
      ),
    ],
    edgeContent: 'm-content',
    grey: true,
  })),
  {
    id: 'a03-fill-less-path-source',
    criterion: 'P4-A03',
    zoom: 1,
    items: [maskOver('m', leaf('s', polygon([star(70)]), sourceAt(-12), null))],
    edgeContent: 'm-content',
    grey: true,
  },
  {
    id: 'a03-hidden-path-source',
    criterion: 'P4-A03',
    zoom: 1,
    items: [
      maskOver(
        'm',
        leaf('s', polygon([star(70)]), sourceAt(-12), SOURCE_BLUE, {
          visible: false,
          opacity: 0.3,
        }),
      ),
    ],
    edgeContent: 'm-content',
    grey: true,
  },
  {
    id: 'a03-rectangle-source',
    criterion: 'P4-A03',
    zoom: 1,
    items: [
      maskOver(
        'm',
        leaf('s', rect(150, 90), multiply(sourceAt(20), translate(-75, -45)), SOURCE_BLUE),
      ),
    ],
    edgeContent: 'm-content',
    grey: true,
  },
  {
    id: 'a03-ellipse-source',
    criterion: 'P4-A03',
    zoom: 1,
    items: [
      maskOver(
        'm',
        leaf('s', ellipse(170, 100), multiply(sourceAt(20), translate(-85, -50)), SOURCE_BLUE),
      ),
    ],
    edgeContent: 'm-content',
    grey: true,
  },
  {
    id: 'a03-line-source',
    criterion: 'P4-A03',
    zoom: 1,
    items: [
      maskOver(
        'm',
        leaf('s', { kind: 'line', start: [-60, -30], end: [60, 30] }, sourceAt(0), null),
      ),
    ],
    edgeContent: 'm-content',
    grey: true,
  },
  {
    id: 'a03-path-source-path-content',
    criterion: 'P4-A03',
    zoom: 1,
    items: [
      maskOver(
        'm',
        leaf('s', polygon([star(70)], 'evenodd'), sourceAt(8), SOURCE_BLUE),
        1,
        coverPath('m-content', 1),
      ),
    ],
    edgeContent: 'm-content',
    grey: true,
  },
  {
    id: 'a03-ellipse-source-zoom-2.5',
    criterion: 'P4-A03',
    zoom: 2.5,
    centre: { x: CENTRE.x + 20.3, y: CENTRE.y - 7.7 },
    items: [
      maskOver(
        'm',
        leaf('s', ellipse(170, 100), multiply(sourceAt(20), translate(-85, -50)), SOURCE_BLUE),
        2.5,
      ),
    ],
    edgeContent: 'm-content',
    grey: true,
  },
];

/** A depth-`depth` chain of alternating rect and mask levels (rect first) over `content`. */
export function alternatingChain(depth: number, content: P4Leaf): P4Item {
  let inner: P4Item = content;
  for (let level = depth - 1; level >= 0; level -= 1) {
    const angle = (level * 40 * Math.PI) / 180;
    const cx = CENTRE.x + 12 * Math.cos(angle);
    const cy = CENTRE.y + 8 * Math.sin(angle);
    if (level % 2 === 0) {
      inner = centredRect(`l${level}`, 7 * level, cx, cy, 230, 150, [inner]);
    } else {
      const source = leaf(
        `l${level}-source`,
        ellipse(250, 170),
        multiply(rotate(11 * level, cx, cy), translate(-125, -85)),
        SOURCE_BLUE,
      );
      inner = container(`l${level}`, IDENTITY, { kind: 'mask' }, [source, inner]);
    }
  }
  return inner;
}

/**
 * Siblings drawn after a deep subtree (P4-A05, P4-K4): one inside the chain's region and one
 * where the chain's coverage is 0 (some level is out at every point of it, at DPR 1 and 2), so
 * a clip leaking onto the sibling would erase the second.
 */
const SIBLING = leaf('sibling', rect(40, 30), translate(CENTRE.x - 20, CENTRE.y - 15), {
  r: 0.9,
  g: 0.5,
  b: 0.1,
  a: 1,
});
const SIBLING_OUTSIDE = leaf(
  'sibling-outside',
  rect(30, 20),
  translate(CENTRE.x + 90, CENTRE.y + 52),
  { r: 0.1, g: 0.9, b: 0.6, a: 1 },
);

export const NESTING_CASES: readonly ImageCase[] = [
  { id: 'a04-depth-0', criterion: 'P4-A04', zoom: 1, items: [cover('c', 1)], edgeContent: 'c' },
  ...[1, 2].map((depth): ImageCase => ({
    id: `a04-depth-${depth}`,
    criterion: 'P4-A04',
    zoom: 1,
    items: [alternatingChain(depth, cover('c', 1))],
    edgeContent: 'c',
    grey: true,
  })),
  {
    id: 'a04-depth-32-with-sibling',
    criterion: 'P4-A04',
    zoom: 1,
    items: [alternatingChain(32, cover('c', 1)), SIBLING, SIBLING_OUTSIDE],
    edgeContent: 'c',
    named: [
      { name: 'sibling-inside-depth-32-region', x: CENTRE.x, y: CENTRE.y },
      { name: 'sibling-outside-depth-32-region', x: CENTRE.x + 105, y: CENTRE.y + 62 },
    ],
  },
];

const HALF_RED: Rgba = { r: 1, g: 0.1, b: 0.1, a: 1 };
const HALF_BLUE: Rgba = { r: 0.1, g: 0.2, b: 1, a: 1 };

/** P4-A05: overlapping 0.5-opacity children inside two nested masks. */
export const OPACITY_CASE: ImageCase = {
  id: 'a05-overlap-in-nested-masks',
  criterion: 'P4-A05',
  interiorOnly: true,
  zoom: 1,
  items: [
    container('m1', IDENTITY, { kind: 'mask' }, [
      leaf('m1-source', ellipse(260, 180), translate(CENTRE.x - 130, CENTRE.y - 90), SOURCE_BLUE),
      container('m2', IDENTITY, { kind: 'mask' }, [
        leaf('m2-source', polygon([[-110, -70, 110, -70, 110, 70, -110, 70]]), sourceAt(10), null),
        leaf('a', rect(120, 80), translate(CENTRE.x - 90, CENTRE.y - 50), HALF_RED, {
          opacity: 0.5,
        }),
        leaf('b', ellipse(120, 80), translate(CENTRE.x - 30, CENTRE.y - 30), HALF_BLUE, {
          opacity: 0.5,
        }),
      ]),
    ]),
  ],
  named: [
    { name: 'overlap', x: CENTRE.x, y: CENTRE.y },
    { name: 'red-only', x: CENTRE.x - 70, y: CENTRE.y - 30 },
    { name: 'blue-only', x: CENTRE.x + 60, y: CENTRE.y + 30 },
  ],
};

/** A star of `count` points around CENTRE: past the fill-v0 work limit for a large count. */
function failingOutline(count: number): number[] {
  const points: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = index * 2.399963;
    const radius = 60 + 30 * Math.sin(index);
    points.push(radius * Math.cos(angle), radius * Math.sin(angle));
  }
  return points;
}

const MARKER = leaf('marker', rect(30, 20), translate(CENTRE.x + 70, CENTRE.y + 35), {
  r: 0.2,
  g: 0.9,
  b: 0.3,
  a: 1,
});

export const FAILURE_CASES: readonly ImageCase[] = [
  {
    id: 'a10-mask-source-fails-to-mesh',
    criterion: 'P4-A10',
    interiorOnly: true,
    zoom: 1,
    items: [
      maskOver('m', leaf('s', polygon([failingOutline(200_000)]), sourceAt(0), SOURCE_BLUE)),
      MARKER,
    ],
    // P4-K2: the source fails to mesh, so nothing of the mask's subtree is drawn.
    expectedItems: [MARKER],
    diagnostics: [{ code: 'render.path-mesh-failure', nodeId: 's' }],
  },
  {
    id: 'a10-singular-container',
    criterion: 'P4-A10',
    interiorOnly: true,
    zoom: 1,
    items: [
      container(
        'g',
        [0, 0, 0, 0, CENTRE.x, CENTRE.y],
        { kind: 'rect', x: -80, y: -50, width: 160, height: 100 },
        [cover('c', 1)],
      ),
      MARKER,
    ],
    diagnostics: [],
  },
  {
    id: 'a10-hidden-clip-container',
    criterion: 'P4-A10',
    interiorOnly: true,
    zoom: 1,
    items: [
      container(
        'g',
        rotate(15, CENTRE.x, CENTRE.y),
        { kind: 'rect', x: -80, y: -50, width: 160, height: 100 },
        [cover('c', 1)],
        { visible: false },
      ),
      container(
        'm',
        IDENTITY,
        { kind: 'mask' },
        [leaf('s', ellipse(100, 60), translate(CENTRE.x - 50, CENTRE.y - 30)), cover('d', 1)],
        { visible: false },
      ),
      MARKER,
    ],
    diagnostics: [],
  },
];
