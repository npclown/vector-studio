/**
 * P3 Alt-A1 AL-OB5 unit OB5-U2 (`docs/plans/p3-al-ob5-workload-scenario-proposal.md` sections
 * 3.4, 4 and 5): the pinned reference configuration hash, the statistics, each verdict, INVALID
 * on each output-identity item, INCONCLUSIVE on each other validity item, and every tamper case
 * of `validateOb5Record`, on synthetic records shaped as the runner writes them.
 */
import { describe, expect, it } from 'vitest';
import type { FillMeshResult } from '@vector-studio/contracts';
import { configHash } from './p3-b0/analysis.js';
import { generateCellPaths } from './p3-b0/corpus.js';
import type { LadderEntry } from './p3-fill-ladder/dump.js';
import {
  analyze,
  exportFold,
  fnvHex,
  kernelSourceSha256,
  OB5_CORPUS_SHA256,
  oracleInputs,
  oracleNames,
  pageOptions,
  scenarioConfig,
  sha256Hex,
  validateOb5Record,
  VALIDITY_IDS,
  type NativeOutput,
  type Ob5Record,
  type ValidityId,
} from './p3-al-ob5/analysis.js';
import {
  encodeOb5DecisionCorpus,
  encodeOb5ObservationCorpus,
  ob5DecisionCells,
} from './p3-al-ob5/corpus.js';
import {
  editOrder,
  pathFold,
  setOrder,
  type Ob5Capture,
  type Ob5Sample,
  type Ob5SetCapture,
} from '../geometry-benchmark/p3-al-ob5/workload.js';

/** The reference configuration hash, recorded in the plan with OB5-U2. */
const REFERENCE_CONFIG_HASH = 'cb23d4ca9d6c2908597ba3a146234a0d6a5ace4dd0512bff0881a627205ea651';

type Profile = 'functional' | 'reference';
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type MutableRecord = Mutable<Omit<Ob5Record, 'analysis'>> & { analysis?: unknown };

const WASM = 'ab'.repeat(32);
const corpus = encodeOb5DecisionCorpus();
const observationCorpus = encodeOb5ObservationCorpus();
const CORPUS = { sha256: sha256Hex(corpus), bytes: corpus.length, fnv: fnvHex(corpus) };
const OBSERVATION = {
  sha256: sha256Hex(observationCorpus),
  bytes: observationCorpus.length,
  fnv: fnvHex(observationCorpus),
};
const MANIFEST = {
  'packages/geometry-wasm/kernel/src/lib.rs': '11'.repeat(32),
  'packages/geometry-wasm/kernel/Cargo.toml': '22'.repeat(32),
  'packages/geometry-wasm/kernel/Cargo.lock': '33'.repeat(32),
};

const hex = (value: number) => value.toString(16).padStart(16, '0');
const pathChecksum = (set: number, path: number) => hex(set * 1_000_000 + path + 1);
const batchChecksum = (set: number) => hex(0xb000 + set);
const chain = (set: number, repetition: number) => hex(0xc000 + 16 * set + repetition);

interface Shape {
  initMs: number;
  editMs: number;
}

function browserSample(startMs: number, ms: number, checksum: string): Ob5Sample {
  return {
    startMs,
    endMs: startMs + ms,
    checksum,
    epochDelta: 1,
    storageStable: true,
    batchFailures: 0,
  };
}

function browserSet(
  profile: Profile,
  setIndex: number,
  repetition: number,
  shape: Shape,
): Ob5SetCapture {
  const config = scenarioConfig(profile);
  const cell = config.corpus.cells[setIndex]!;
  const expected = config.expectation.sets[setIndex]!;
  const paths = cell.paths;
  const checksums = Array.from({ length: paths }, (_, path) => pathChecksum(setIndex, path));
  const order = editOrder(config.sampling.edit.paths, repetition);
  const batch = batchChecksum(setIndex);
  return {
    set: cell.id,
    paths,
    preparation: { ...browserSample(0, 900, batch), epochDelta: 3, storageStable: false },
    statuses: Array.from({ length: paths }, () => 'ok'),
    vertices: Array.from({ length: paths }, () => expected.vertices),
    triangles: Array.from({ length: paths }, () => expected.triangles),
    boundaryPairs: Array.from({ length: paths }, () => expected.boundaryPairs),
    pathChecksums: checksums,
    warmup: Array.from({ length: config.sampling.init.warmup }, (_, index) =>
      browserSample(1000 * (index + 1), shape.initMs, batch),
    ),
    timed: Array.from({ length: config.sampling.init.timed }, (_, index) =>
      browserSample(10_000 + 1000 * index, shape.initMs, batch),
    ),
    editWarmup: { paths: [0, 1, 2], checksums: checksums.slice(0, 3) },
    edits: {
      order,
      startMs: order.map((_, index) => 50_000 + 10 * index),
      endMs: order.map((_, index) => 50_000 + 10 * index + shape.editMs),
      checksums: order.map((path) => checksums[path]!),
      epochDeltas: order.map(() => 1),
      storageStable: order.map(() => true),
      statuses: order.map(() => 'ok'),
      chain: chain(setIndex, repetition),
    },
    cold: { ...browserSample(90_000, 950, batch), epochDelta: 3, storageStable: false },
    renderer: {
      startMs: 100_000,
      endMs: 101_000,
      draws: paths,
      regionOnly: cell.lambda === 8 ? paths : 0,
      fringed: cell.lambda === 8 ? 0 : paths,
      toleranceExponents: [-3],
      builderCalls: cell.lambda === 8 ? 0 : paths,
      builderMs: cell.lambda === 8 ? 0 : 500,
      notices: cell.lambda === 8 ? { 'fringe-work-cap': paths } : {},
      portCalls: 1,
      epochDelta: 1,
      storageStable: true,
    },
  };
}

function capture(profile: Profile, repetition: number, shape: Shape): Ob5Capture {
  const config = scenarioConfig(profile);
  const ids = config.corpus.cells.map((cell) => cell.id);
  const order = setOrder(ids, repetition);
  return {
    schema: 'p3-al-ob5-capture/v1',
    options: { ...pageOptions(config, WASM), repetition },
    wasmSha256: WASM,
    corpusSha256: OB5_CORPUS_SHA256,
    adapter: { operationId: 'geometry-wasm/fill-v0+r2', portVersion: 0 },
    crossOriginIsolated: true,
    clockProbe: {
      attempts: 10,
      durationMs: 1,
      positiveIncrementsMs: [0.005],
      minimumQuantumMs: 0.005,
    },
    setup: { fetchMs: 1, compileMs: 1, decodeMs: 1 },
    order,
    sets: order.map((id) => browserSet(profile, ids.indexOf(id), repetition, shape)),
    linearMemoryBytes: 40_000_000,
    environment: {
      visibilityStart: 'visible',
      visibilityEnd: 'visible',
      visibilityEvents: [],
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      screen: { width: 1920, height: 1080 },
      navigator: { userAgent: 'test', platform: 'Win32', hardwareConcurrency: 16 },
    },
    errors: [],
  };
}

function nativeOutput(profile: Profile, repetition: number): NativeOutput {
  const config = scenarioConfig(profile);
  const ids = config.corpus.cells.map((cell) => cell.id);
  const order = setOrder(ids, repetition);
  const samples = (count: number, checksum: (index: number) => string, ns: number) => ({
    ns: Array.from({ length: count }, () => ns),
    checksums: Array.from({ length: count }, (_, index) => checksum(index)),
    batchStatuses: Array.from({ length: count }, () => 0),
    allocations: Array.from({ length: count }, () => 0),
  });
  return {
    kind: 'ob5-native',
    repetition,
    revision: 2,
    clockQuantumNs: 100,
    corpus: { bytes: CORPUS.bytes, fnv: CORPUS.fnv },
    setOrder: order,
    sets: order.map((id) => {
      const setIndex = ids.indexOf(id);
      const cell = config.corpus.cells[setIndex]!;
      const expected = config.expectation.sets[setIndex]!;
      const paths = cell.paths;
      const checksums = Array.from({ length: paths }, (_, path) => pathChecksum(setIndex, path));
      const edits = editOrder(config.sampling.edit.paths, repetition);
      const batch = batchChecksum(setIndex);
      return {
        set: id,
        paths,
        inputBytes: 1,
        preparation: { ns: 1e9, batchStatus: 0, checksum: batch },
        statuses: Array.from({ length: paths }, () => 0),
        vertices: Array.from({ length: paths }, () => expected.vertices),
        triangles: Array.from({ length: paths }, () => expected.triangles),
        boundaryPairs: Array.from({ length: paths }, () => expected.boundaryPairs),
        pathChecksums: checksums,
        warmup: samples(config.sampling.init.warmup, () => batch, 3e8),
        timed: samples(config.sampling.init.timed, () => batch, 3e8),
        editWarmup: { paths: [0, 1, 2], checksums: checksums.slice(0, 3) },
        editOrder: edits,
        edits: samples(edits.length, (index) => checksums[edits[index]!]!, 4e5),
        editChain: chain(setIndex, repetition),
        storageStable: true,
        rungs: Array.from({ length: paths }, () => 'fast'),
        reasons: Array.from({ length: paths }, () => null),
        steps: Array.from({ length: paths }, () => null),
        meshes: Array.from({ length: paths }, () => 1),
        flatCommands: Array.from({ length: paths }, () => expected.flatCommands),
      };
    }),
  };
}

function oracle(profile: Profile): MutableRecord['oracle'] {
  const ids = ob5DecisionCells().map((cell) => cell.id);
  const exportChecksums: { [name: string]: string } = {};
  for (const name of oracleNames(profile)) {
    const set = name.slice(4, name.lastIndexOf('#'));
    const index = Number(name.slice(name.lastIndexOf('#') + 1));
    exportChecksums[name] = pathChecksum(ids.indexOf(set), index);
  }
  const passing = (checked: number) => ({ checked, failures: [] as string[] });
  const entries = oracleNames(profile).length;
  return {
    dump: { sha256: 'cd'.repeat(32), bytes: 1, entries, revision: 2 },
    gates: {
      'SL-O1': passing(entries),
      'SL-O2': passing(entries),
      'SL-O3': passing(entries),
      'AL-I2': passing(0),
      harness: passing(entries),
    },
    meshCheck: { count: 0, entries: [] },
    exportChecksums,
    perSet: [],
    slivers: [],
    geometricError: [],
    alI3: { prefix: entries, other: 0 },
  };
}

function record(profile: Profile, shape: Shape = { initMs: 500, editMs: 1 }): MutableRecord {
  const config = scenarioConfig(profile);
  const repetitions = config.sampling.repetitions;
  const kernel = kernelSourceSha256(MANIFEST);
  const browsers = (['chrome', 'edge'] as const).flatMap((project) =>
    Array.from({ length: repetitions }, (_, repetition) => ({
      schema: 'p3-al-ob5-browser/v1' as const,
      project,
      channel: project === 'chrome' ? 'chrome' : 'msedge',
      browserVersion: '150.0',
      launchFlags: ['--enable-automation'],
      repetition,
      startedAt: '2026-10-21T00:00:00.000Z',
      recordedAt: '2026-10-21T00:01:00.000Z',
      instrumentation: { headed: true, tracing: false, video: false, devtools: false },
      capture: capture(profile, repetition, shape),
      error: null,
    })),
  );
  const base = {
    schemaVersion: 1 as const,
    scenario: {
      id: config.scenario.id,
      version: config.scenario.version,
      profile,
      config,
      configHash: configHash(config),
    },
    run: {
      runId: 'test',
      runner: config.runner,
      command: `pnpm benchmark:p3-al-ob5 --profile ${profile}`,
      utcStart: '2026-10-21T00:00:00.000Z',
      utcEnd: '2026-10-21T01:00:00.000Z',
      timezone: 'Asia/Seoul',
      commit: 'f'.repeat(40),
      dirty: false,
      dirtyFiles: [],
      sourceManifest: MANIFEST,
      commitCheck: { commit: 'f'.repeat(40), checked: 3, mismatches: [] },
    },
    environment: {
      observedAt: '2026-10-21T00:00:00.000Z',
      os: { type: 'Windows_NT' },
      cpu: 'test CPU',
      logicalCores: 16,
      memoryBytes: 2 ** 34,
      power: { value: 'AC', source: 'operator' },
      backgroundLoad: { value: 'idle', source: 'operator' },
      quietMachine: { value: 'quiet', source: 'chat' },
      processListing: { sha256: '00'.repeat(32) },
      gpu: { applicable: false, reason: 'no GPU work is measured' },
    },
    builds: {
      wasm: { sha256: WASM, bytes: 1, kernelSourceSha256: kernel },
      native: {
        toolchain: { release: '1.94.1' },
        target: 'x86_64-pc-windows-msvc',
        profile: 'release',
        rustflags: ['--remap-path-prefix'],
        knownOverhead: ['unwind'],
        kernelSourceSha256: kernel,
      },
      page: {
        files: [
          { path: 'corpus.bin', sha256: OB5_CORPUS_SHA256 },
          { path: 'geometry.wasm', sha256: WASM },
          { path: 'index.html', sha256: '44'.repeat(32) },
        ],
      },
    },
    corpus: CORPUS,
    observationCorpus: OBSERVATION,
    native: {
      repetitions: Array.from({ length: repetitions }, (_, repetition) =>
        nativeOutput(profile, repetition),
      ),
      failures: [],
    },
    observation: null,
    oracle: oracle(profile),
    browsers,
    failures: [],
  };
  return structuredClone(base) as unknown as MutableRecord;
}

function withAnalysis(value: MutableRecord): MutableRecord {
  const copy = structuredClone(value);
  delete copy.analysis;
  return { ...copy, analysis: JSON.parse(JSON.stringify(analyze(copy))) as unknown };
}

const failing = (value: MutableRecord) =>
  analyze(value as Ob5Record)
    .checks.filter((item) => !item.pass)
    .map((item) => item.id);

const reference = record('reference');
const functional = record('functional');
const firstSet = (value: MutableRecord, project = 0) => value.browsers[project]!.capture!.sets[0]!;

describe('AL-OB5 configuration', () => {
  it('pins the reference configuration hash', () => {
    expect(configHash(scenarioConfig('reference'))).toBe(REFERENCE_CONFIG_HASH);
  });

  it('fixes the sampling of section 3.3 and the budgets', () => {
    const ref = scenarioConfig('reference');
    expect(ref.sampling.repetitions).toBe(5);
    expect(ref.sampling.init).toMatchObject({ warmup: 3, timed: 20 });
    expect(ref.sampling.edit).toMatchObject({
      paths: 1000,
      seed: 0x0b5e0000,
      warmupPaths: [0, 1, 2],
    });
    expect(ref.oracle.pathsPerSet).toBe(1000);
    expect(ref.clock).toMatchObject({ initQuantumMultiple: 100, editQuantumMaxMs: 0.04 });
    expect(ref.decision.budgets).toEqual({ initialMs: 1000, editMs: 4, meshBytes: 64 * 2 ** 20 });
    const fun = scenarioConfig('functional');
    expect(fun.sampling.repetitions).toBe(1);
    expect(fun.sampling.init).toMatchObject({ warmup: 1, timed: 2 });
    expect(fun.sampling.edit.paths).toBe(100);
    expect(fun.oracle.pathsPerSet).toBe(10);
    expect(
      ref.expectation.sets.map((item) => [
        item.set,
        item.vertices,
        item.triangles,
        item.flatCommands,
      ]),
    ).toEqual([
      ['OB5-W2', 64, 62, 66],
      ['OB5-W4', 128, 126, 130],
      ['OB5-W8', 256, 254, 258],
    ]);
  });

  it('builds the oracle inputs from prefixes of the decision sets', () => {
    expect(oracleNames('functional')).toHaveLength(30);
    expect(oracleNames('reference')).toHaveLength(3000);
    const inputs = oracleInputs('functional');
    const cell = ob5DecisionCells()[2]!;
    const nine = inputs.find((input) => input.name === `ob5/${cell.id}#9`)!;
    expect(nine.kind === 'path' && nine.points).toEqual(generateCellPaths(cell, 10)[9]!.points);
  });

  it('folds a dumped export exactly as the page folds the port result', () => {
    const positions = Float64Array.from([0, 0, 10, 0, 10, 10, 0, 10]);
    const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
    const boundaryEdges = Uint32Array.from([0, 1, 1, 2, 2, 3, 3, 0]);
    const result: FillMeshResult = {
      requestId: 0,
      toleranceExponent: -3,
      status: 'ok',
      mesh: { positions, indices, boundaryEdges, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
    };
    const bits = (value: number) => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, value);
      return view.getBigUint64(0).toString(16).padStart(16, '0');
    };
    const entry = {
      export: {
        batchStatus: 0,
        pathStatus: 0,
        positions: [0, 1, 2, 3].map((v) => [bits(positions[2 * v]!), bits(positions[2 * v + 1]!)]),
        triangles: [
          [0, 1, 2],
          [0, 2, 3],
        ],
        boundaryEdges: [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 0],
        ],
      },
    } as unknown as LadderEntry;
    expect(exportFold(entry)).toBe(pathFold(result));
  });
});

describe('AL-OB5 analysis', () => {
  it('passes every validity item on a complete record', () => {
    expect(failing(reference)).toEqual([]);
    expect(failing(functional)).toEqual([]);
    expect(analyze(functional as Ob5Record).verdict).toBe('NONE');
  });

  it('computes T, t_edit and M as section 3.4 fixes them', () => {
    const value = structuredClone(reference);
    // One repetition of one browser and set is slower: the maximum of medians decides.
    const slow = value.browsers[3]!.capture!.sets[1]!;
    slow.timed.forEach((sample, index) => {
      sample.endMs = sample.startMs + (index < 10 ? 700 : 800);
    });
    slow.edits.endMs = slow.edits.startMs.map((start, index) => start + (index >= 940 ? 3 : 1));
    const analysis = analyze(value);
    expect(analysis.T).toBe(700);
    expect(analysis.Tp95).toBe(800);
    expect(analysis.tEdit).toBe(3);
    expect(analysis.meshBytes).toBe(1000 * (16 * 256 + 12 * 254));
    expect(analysis.payloadBytes).toBe(1000 * (16 * 256 + 12 * 254 + 8 * 256));
    expect(analysis.verdict).toBe('FEASIBLE');
  });

  it('gives each verdict', () => {
    expect(analyze(reference as Ob5Record).verdict).toBe('FEASIBLE');
    const slow = record('reference', { initMs: 1200, editMs: 1 });
    const result = analyze(slow);
    expect(result.verdict).toBe('INFEASIBLE');
    expect(result.reason).toContain('T 1200.0 ms');
    const slowEdit = analyze(record('reference', { initMs: 500, editMs: 5 }));
    expect(slowEdit.verdict).toBe('INFEASIBLE');
    expect(slowEdit.reason).toContain('t_edit');
    const notIsolated = structuredClone(reference);
    notIsolated.browsers[0]!.capture!.crossOriginIsolated = false;
    expect(analyze(notIsolated as Ob5Record).verdict).toBe('INCONCLUSIVE');
    const mismatch = structuredClone(reference);
    for (const sample of firstSet(mismatch).timed) sample.checksum = 'ffffffffffffffff';
    expect(analyze(mismatch as Ob5Record).verdict).toBe('INVALID');
  });

  it('is INVALID on a fold mismatch with native, even for an otherwise valid run', () => {
    const value = structuredClone(reference);
    const set = firstSet(value);
    for (const sample of [set.preparation, ...set.warmup, ...set.timed, set.cold])
      sample.checksum = 'eeeeeeeeeeeeeeee';
    expect(failing(value)).toEqual(['OB5-V1']);
    const analysis = analyze(value);
    expect(analysis.verdict).toBe('INVALID');
    const edit = structuredClone(reference);
    firstSet(edit).edits.chain = 'dddddddddddddddd';
    expect(failing(edit)).toEqual(['OB5-V1']);
    expect(analyze(edit as Ob5Record).verdict).toBe('INVALID');
  });

  const identity: [ValidityId, (value: MutableRecord) => void][] = [
    [
      'OB5-V2',
      (value) => {
        firstSet(value).edits.checksums[0] = 'cccccccccccccccc';
      },
    ],
    [
      'OB5-V3',
      (value) => {
        for (const item of value.browsers)
          item.capture!.sets.forEach((set) => (set.vertices[5] = 7));
        for (const output of value.native!.repetitions)
          output.sets.forEach((set) => (set.vertices[5] = 7));
      },
    ],
    [
      'OB5-V7',
      (value) => {
        value.oracle!.gates['SL-O1'].failures.push('ob5/OB5-W8#3: unsound');
      },
    ],
    [
      'OB5-V8',
      (value) => {
        value.oracle!.meshCheck = { count: 1, entries: ['ob5/OB5-W2#0'] };
      },
    ],
  ];
  for (const [id, mutate] of identity)
    it(`is INVALID when the output-identity item ${id} fails`, () => {
      const value = structuredClone(reference);
      mutate(value);
      expect(failing(value)).toEqual([id]);
      expect(analyze(value as Ob5Record).verdict).toBe('INVALID');
    });

  const others: [ValidityId, (value: MutableRecord) => void][] = [
    [
      'OB5-V4',
      (value) => {
        value.browsers[0]!.capture!.adapter = {
          operationId: 'geometry-wasm/fill-v0',
          portVersion: 0,
        };
      },
    ],
    [
      'OB5-V5',
      (value) => {
        firstSet(value).edits.statuses[4] = 'work-limit';
      },
    ],
    [
      'OB5-V6',
      (value) => {
        value.native!.repetitions[0]!.sets[0]!.rungs[2] = 'exact';
      },
    ],
    [
      'OB5-V9',
      (value) => {
        firstSet(value).timed[0]!.epochDelta = 2;
      },
    ],
    [
      'OB5-V10',
      (value) => {
        value.browsers[1]!.capture!.clockProbe.minimumQuantumMs = 0.1;
      },
    ],
    [
      'OB5-V11',
      (value) => {
        value.browsers[0]!.capture!.environment.visibilityEvents.push({ atMs: 5, state: 'hidden' });
      },
    ],
    [
      'OB5-V12',
      (value) => {
        value.browsers.pop();
      },
    ],
    [
      'OB5-V13',
      (value) => {
        value.run.dirty = true;
      },
    ],
    [
      'OB5-V14',
      (value) => {
        (value.environment as { quietMachine: unknown }).quietMachine = null;
      },
    ],
  ];
  for (const [id, mutate] of others)
    it(`is INCONCLUSIVE when ${id} alone fails`, () => {
      const value = structuredClone(reference);
      mutate(value);
      expect(failing(value)).toEqual([id]);
      expect(analyze(value as Ob5Record).verdict).toBe('INCONCLUSIVE');
    });

  it('names every validity item once', () => {
    expect(analyze(reference as Ob5Record).checks.map((item) => item.id)).toEqual([
      ...VALIDITY_IDS,
    ]);
  });

  it('does not require a clean tree for the functional profile', () => {
    const value = structuredClone(functional);
    value.run.dirty = true;
    expect(failing(value)).toEqual([]);
  });
});

describe('validateOb5Record', () => {
  const valid = withAnalysis(reference);
  const validFunctional = withAnalysis(functional);

  it('accepts complete records', () => {
    expect(() => validateOb5Record(valid as Ob5Record)).not.toThrow();
    expect(() => validateOb5Record(validFunctional as Ob5Record)).not.toThrow();
  });

  const tampers: [string, (value: MutableRecord) => void, RegExp][] = [
    ['a browser sample', (value) => (firstSet(value).timed[1]!.endMs += 3), /stored analysis/u],
    [
      'a native sample',
      (value) => {
        value.native!.repetitions[0]!.sets[0]!.timed.ns[0] = 9e8;
      },
      /stored analysis/u,
    ],
    [
      'a statistic',
      (value) => {
        (value.analysis as { T: number }).T = 1;
      },
      /stored analysis/u,
    ],
    [
      'a fold',
      (value) => (firstSet(value).warmup[0]!.checksum = '0000000000000001'),
      /stored analysis/u,
    ],
    [
      'a rung record',
      (value) => {
        value.native!.repetitions[0]!.sets[1]!.reasons[0] = 'CLEARANCE';
      },
      /stored analysis/u,
    ],
    [
      'M',
      (value) => {
        (value.analysis as { meshBytes: number }).meshBytes = 1;
      },
      /stored analysis/u,
    ],
    [
      'the verdict',
      (value) => {
        (value.analysis as { verdict: string }).verdict = 'INFEASIBLE';
      },
      /stored analysis/u,
    ],
    [
      'the configuration',
      (value) => {
        value.scenario.config.sampling.init.timed = 19;
        value.scenario.configHash = configHash(value.scenario.config);
      },
      /configuration differs/u,
    ],
    [
      'the configuration hash',
      (value) => (value.scenario.configHash = '0'.repeat(64)),
      /configuration hash/u,
    ],
    ['the corpus hash', (value) => (value.corpus.sha256 = '0'.repeat(64)), /corpus hash/u],
    [
      'the WASM hash',
      (value) => {
        value.builds.wasm.sha256 = 'cd'.repeat(32);
      },
      /WASM hash/u,
    ],
    [
      'the kernel-source hash',
      (value) => {
        value.builds.native.kernelSourceSha256 = '0'.repeat(64);
      },
      /kernel-source/u,
    ],
    [
      'an edit order',
      (value) => {
        const edits = firstSet(value).edits;
        [edits.order[0], edits.order[1]] = [edits.order[1]!, edits.order[0]!];
      },
      /stored analysis/u,
    ],
    [
      'a metadata item',
      (value) => {
        delete (value.environment as { cpu?: unknown }).cpu;
      },
      /stored analysis/u,
    ],
    [
      'the scenario identity',
      (value) => {
        value.scenario.version = 2;
      },
      /scenario identity/u,
    ],
  ];
  for (const [name, mutate, message] of tampers)
    it(`rejects a changed ${name}`, () => {
      const value = structuredClone(valid);
      mutate(value);
      expect(() => validateOb5Record(value as Ob5Record)).toThrow(message);
    });
});
