import type {
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneColor,
} from '@vector-studio/contracts';

/** Frozen deterministic workload identities from the P1 measurement contract. */
export const P1_SCENARIOS = Object.freeze([
  'p1-pan-zoom-1k/v1',
  'p1-pan-zoom-10k/v1',
  'p1-cull-10k/v1',
  'p1-single-transform-10k/v1',
] as const);

export type P1Scenario = (typeof P1_SCENARIOS)[number];

type P1ScenarioDefinition = Readonly<{
  population: number;
  columns: number;
  rows: number;
  centers: 'pan-zoom-grid' | 'cull-grid';
  positionJitter: boolean;
  expectedVisible: number;
  camera: 'pan-zoom' | 'fixed-cull';
  nodeTrajectory: 'none' | 'single-transform';
}>;

/**
 * A JSON-serializable expansion of every literal and reference window used by the
 * deterministic P1 workloads. Formulae are retained as strings so records can
 * identify the arithmetic without serializing executable code.
 */
export const P1_CONFIGURATION = deepFreeze({
  version: 'p1-primitives-workloads/v1',
  canvas: {
    cssWidth: 1280,
    cssHeight: 720,
    physicalWidth: 1280,
    physicalHeight: 720,
    devicePixelRatio: 1,
    colorSpace: 'srgb',
    alphaMode: 'premultiplied',
    preferredFormat: 'preferred-non-srgb-unorm',
    clearColor: [0.08, 0.1, 0.14, 1],
    sampleCount: 4,
  },
  referenceWindow: {
    repetitions: 5,
    warmupStartMs: 0,
    warmupEndMs: 5000,
    measuredStartMs: 5000,
    measuredEndMs: 15000,
    continuous: true,
  },
  random: {
    seed: 0x50310001,
    multiplier: 1664525,
    increment: 1013904223,
    wordFormula: '(Math.imul(1664525, ((0x50310001 ^ i) >>> 0)) + 1013904223) >>> 0',
    channelFormula: '((u >>> (8 * j)) & 255) / 255',
    jitterFormula: '2 * q - 1',
  },
  scene: {
    documentId: 'p1-benchmark',
    initialRevision: 0,
    idPrefix: 'p1-',
    idDigits: 5,
    rootOrder: 'increasing-index',
    parentId: null,
    visible: true,
    opacityFormula: '0.5 + 0.25 * (i % 3)',
    fillFormula: ['0.2 + 0.6 * q0', '0.2 + 0.6 * q1', '0.2 + 0.6 * q2', '0.45 + 0.4 * q3'],
    strokeFormula: ['0.8 - 0.6 * q2', '0.8 - 0.6 * q1', '0.8 - 0.6 * q0', '0.65'],
  },
  primitives: {
    rectangle: { width: 3, height: 2, cornerRadii: [0, 0, 0, 0], strokeWidth: 0.5 },
    roundedRectangle: {
      width: 3,
      height: 3,
      cornerRadii: [0.5, 1, 0.5, 1],
      strokeWidth: 0.5,
    },
    ellipse: { width: 3, height: 2, strokeWidth: 0.5 },
    line: { start: [-1.75, 0], end: [1.75, 0], cap: 'butt', strokeWidth: 1 },
    maximumStrokeInclusiveExtent: 1.75,
    cullingGuardPhysicalPixels: 2,
  },
  trajectory: {
    periodMs: 10000,
    thetaFormula: '2 * Math.PI * ((elapsedMs % 10000) / 10000)',
    panZoom: {
      cameraXFormula: '20 + 20 * Math.sin(theta)',
      cameraYFormula: '10 + 10 * Math.cos(theta)',
      zoomFormula: '1.05 + 0.05 * Math.sin(theta + Math.PI / 3)',
    },
    fixedCull: { cameraX: 0, cameraY: 0, zoom: 1.5 },
    singleTransform: {
      nodeId: 'p1-00000',
      centerXFormula: '10 + 4 * Math.sin(theta)',
      centerYFormula: '10 + 4 * (Math.cos(theta) - 1)',
      transformFormula: '[1, 0, 0, 1, centerX - 1.5, centerY - 1]',
    },
  },
  scenarios: {
    'p1-pan-zoom-1k/v1': {
      population: 1000,
      columns: 40,
      rows: 25,
      centers: 'pan-zoom-grid',
      positionJitter: true,
      expectedVisible: 1000,
      camera: 'pan-zoom',
      nodeTrajectory: 'none',
    },
    'p1-pan-zoom-10k/v1': {
      population: 10000,
      columns: 100,
      rows: 100,
      centers: 'pan-zoom-grid',
      positionJitter: true,
      expectedVisible: 10000,
      camera: 'pan-zoom',
      nodeTrajectory: 'none',
    },
    'p1-cull-10k/v1': {
      population: 10000,
      columns: 100,
      rows: 100,
      centers: 'cull-grid',
      positionJitter: false,
      expectedVisible: 1032,
      camera: 'fixed-cull',
      nodeTrajectory: 'none',
    },
    'p1-single-transform-10k/v1': {
      population: 10000,
      columns: 100,
      rows: 100,
      centers: 'cull-grid',
      positionJitter: false,
      expectedVisible: 1032,
      camera: 'fixed-cull',
      nodeTrajectory: 'single-transform',
    },
  } satisfies Record<P1Scenario, P1ScenarioDefinition>,
});

export type P1Configuration = typeof P1_CONFIGURATION;

export type P1Workload = Readonly<{
  scenario: P1Scenario;
  snapshot: RenderSceneSnapshot;
  configuration: P1Configuration;
}>;

export function createP1Workload(scenario: P1Scenario): P1Workload {
  const definition = scenarioDefinition(scenario);
  const nodes = Array.from({ length: definition.population }, (_, index) =>
    nodeFor(scenario, index),
  );
  return {
    scenario,
    snapshot: {
      identity: { documentId: P1_CONFIGURATION.scene.documentId, pageId: scenario },
      revision: P1_CONFIGURATION.scene.initialRevision,
      nodes,
      rootOrder: nodes.map(({ id }) => id),
    },
    configuration: P1_CONFIGURATION,
  };
}

export function cameraAt(scenario: P1Scenario, elapsedMs: number): RenderCamera {
  const definition = scenarioDefinition(scenario);
  assertElapsedMs(elapsedMs);
  if (definition.camera === 'fixed-cull') {
    return {
      position: {
        x: P1_CONFIGURATION.trajectory.fixedCull.cameraX,
        y: P1_CONFIGURATION.trajectory.fixedCull.cameraY,
      },
      zoom: P1_CONFIGURATION.trajectory.fixedCull.zoom,
    };
  }
  const theta = thetaAt(elapsedMs);
  return {
    position: { x: 20 + 20 * Math.sin(theta), y: 10 + 10 * Math.cos(theta) },
    zoom: 1.05 + 0.05 * Math.sin(theta + Math.PI / 3),
  };
}

/** Returns a fresh S4 replacement node only; callers own revisions and change sets. */
export function nodeAt(workload: P1Workload, elapsedMs: number): RenderNodeSnapshot | null {
  const definition = scenarioDefinition(workload.scenario);
  assertElapsedMs(elapsedMs);
  if (definition.nodeTrajectory !== 'single-transform') return null;
  const theta = thetaAt(elapsedMs);
  return nodeFor(workload.scenario, 0, {
    x: 10 + 4 * Math.sin(theta),
    y: 10 + 4 * (Math.cos(theta) - 1),
  });
}

export function expectedVisible(scenario: P1Scenario): number {
  return scenarioDefinition(scenario).expectedVisible;
}

function nodeFor(
  scenario: P1Scenario,
  index: number,
  centerOverride?: Readonly<{ x: number; y: number }>,
): RenderNodeSnapshot {
  const center = centerOverride ?? centerFor(scenario, index);
  const q = randomChannels(index);
  const fill: SceneColor = {
    r: 0.2 + 0.6 * q[0],
    g: 0.2 + 0.6 * q[1],
    b: 0.2 + 0.6 * q[2],
    a: 0.45 + 0.4 * q[3],
  };
  const strokeColor: SceneColor = {
    r: 0.8 - 0.6 * q[2],
    g: 0.8 - 0.6 * q[1],
    b: 0.8 - 0.6 * q[0],
    a: 0.65,
  };
  const common = {
    id: nodeId(index),
    parentId: null,
    visible: true,
    opacity: 0.5 + 0.25 * (index % 3),
  } as const;
  switch (index % 4) {
    case 0:
      return {
        ...common,
        kind: 'primitive',
        transform: [1, 0, 0, 1, center.x - 1.5, center.y - 1],
        geometry: { kind: 'rectangle', width: 3, height: 2, cornerRadii: [0, 0, 0, 0] },
        style: { fill, stroke: { color: strokeColor, width: 0.5 } },
      };
    case 1:
      return {
        ...common,
        kind: 'primitive',
        transform: [1, 0, 0, 1, center.x - 1.5, center.y - 1.5],
        geometry: { kind: 'rectangle', width: 3, height: 3, cornerRadii: [0.5, 1, 0.5, 1] },
        style: { fill, stroke: { color: strokeColor, width: 0.5 } },
      };
    case 2:
      return {
        ...common,
        kind: 'primitive',
        transform: [1, 0, 0, 1, center.x - 1.5, center.y - 1],
        geometry: { kind: 'ellipse', width: 3, height: 2 },
        style: { fill, stroke: { color: strokeColor, width: 0.5 } },
      };
    default:
      return {
        ...common,
        kind: 'primitive',
        transform: [1, 0, 0, 1, center.x, center.y],
        geometry: { kind: 'line', start: { x: -1.75, y: 0 }, end: { x: 1.75, y: 0 } },
        style: { fill: null, stroke: { color: strokeColor, width: 1 } },
      };
  }
}

function centerFor(scenario: P1Scenario, index: number): Readonly<{ x: number; y: number }> {
  const definition = scenarioDefinition(scenario);
  const column = index % definition.columns;
  const row = Math.floor(index / definition.columns);
  if (definition.centers === 'cull-grid') return { x: 10 + 20 * column, y: 10 + 20 * row };
  const [q0, q1] = randomChannels(index);
  return {
    x: 180 + (900 * column) / (definition.columns - 1) + 2 * q0 - 1,
    y: 160 + (400 * row) / (definition.rows - 1) + 2 * q1 - 1,
  };
}

function randomChannels(index: number): readonly [number, number, number, number] {
  const u =
    (Math.imul(P1_CONFIGURATION.random.multiplier, (P1_CONFIGURATION.random.seed ^ index) >>> 0) +
      P1_CONFIGURATION.random.increment) >>>
    0;
  return [
    (u & 255) / 255,
    ((u >>> 8) & 255) / 255,
    ((u >>> 16) & 255) / 255,
    ((u >>> 24) & 255) / 255,
  ];
}

function nodeId(index: number): string {
  return `${P1_CONFIGURATION.scene.idPrefix}${index.toString().padStart(P1_CONFIGURATION.scene.idDigits, '0')}`;
}

function thetaAt(elapsedMs: number): number {
  return (
    2 *
    Math.PI *
    ((elapsedMs % P1_CONFIGURATION.trajectory.periodMs) / P1_CONFIGURATION.trajectory.periodMs)
  );
}

function scenarioDefinition(scenario: P1Scenario): P1ScenarioDefinition {
  if (!P1_SCENARIOS.includes(scenario))
    throw new RangeError(`Unknown P1 scenario: ${String(scenario)}`);
  return P1_CONFIGURATION.scenarios[scenario];
}

function assertElapsedMs(elapsedMs: number): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
    throw new RangeError('P1 elapsed time must be finite and non-negative.');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
