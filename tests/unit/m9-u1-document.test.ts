// MVP M9-U1 (M9 contract, sections 3.1 and 3.2, M9-A01 and M9-A02): the v2 document generates
// deterministically with the section 3.1 counts and its pinned digest, `parseDocument` accepts
// it, its text uses only the committed subset; every M9 scenario has a configuration, a
// configuration hash and a stable ID; the v2 typical view holds 900 to 1,100 drawn leaves (text
// bounds from the committed font's recorded layouts) and every drawn leaf is inside the viewport
// at F; and the v1 scenarios are unchanged (their hashes re-pinned at E41-U4 for schema v7).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDocument, type TextNode } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  configurationHash,
  contains,
  contentBounds,
  e26Configuration,
  E26_SCENARIOS,
  E26_TYPICAL_VISIBLE,
  editDragOffset,
  fittedCamera,
  loadScenarioDocument,
  M9_FONT_LOAD,
  M9_SCENARIOS,
  M9_TYPING,
  M9_WINDOW,
  m9CameraClaims,
  m9Cameras,
  m9Configuration,
  m9LayoutTableSha256,
  panZoomCamera,
  sha256,
  typicalCamera,
  visibility,
  worldViewport,
} from '../e26/scenarios.js';
import { m1A13MoveSelection } from '../m1-a13/document.js';
import {
  generateM9V2Document,
  graphemeCount,
  inSubset,
  M9_SECOND_FAMILY,
  M9_SUBSET_HANGUL,
  M9_TEST_FAMILY,
  M9_V2_PROJECTED,
  M9_V2_SEED,
  m9DocumentSha256,
  m9TypingTarget,
  m9V2Counts,
} from '../m9/document.js';
import {
  M9_LAYOUT_TABLE,
  m9LayoutDiff,
  m9LayoutRequests,
  readM9LayoutTable,
  requestKey,
  type CompactLayout,
  type M9LayoutTable,
} from '../m9/layouts.js';

const root = path.resolve(import.meta.dirname, '../..');
const generated = generateM9V2Document();
const loaded = loadScenarioDocument('m9-v2');

/**
 * Pinned digest of the canonical generated v2 document (U1); a change is a new version. The
 * M9-U1 pre-run fix (run boundaries at word starts) changed it from 6104db99…0407, and schema v7
 * (E41-U4: `effects: []` on every node, E41-S1) from cae67383…895c, and schema v8 (the v8
 * scaffold of 2026-11-12) from 876b1868…dfd89.
 */
const M9_V2_SHA256 = '2f74ad3be7ff3664b378e5a99715c848b71dfa1fb77a48ab2c9d1f5bb4fd9275';
/** The section 3.1 counts, pinned. */
const COUNTS = {
  documentNodes: 10_000,
  page1Nodes: 8_480,
  page2Nodes: 1_520,
  page1Projected: 10_985,
  fromExpansion: 1_008,
  instanceSceneNodes: 1_344,
  instances: 112,
  scaledInstances: 56,
  overriddenInstances: 6,
  textNodes: 200,
  textClusters: 6_975,
  secondFamilyTextNodes: 50,
  sourceTextNodes: 1,
  clustersMoved: 55,
};
/** The v2 typical view (U1, by v1's rule over the recorded layouts), pinned. */
const TYPICAL_ZOOM = 0.5159188439084609;
const TYPICAL_VISIBLE = 999;
const TYPICAL_VISIBLE_DPR2 = 997;
const DRAWN_LEAVES = 6_809;
/**
 * The configuration hashes at DPR 1, five repetitions: the v1 ones as at 75be15b, re-pinned at
 * E41-U4, where the loaded documents became schema v7 (E41-S1) and so did each configuration's
 * `schemaVersion` and document digest, and again at the v8 scaffold (2026-11-12) for v8.
 */
const V1_HASHES = {
  'e26-mixed-view-edit-10k/v1': '68becdb1e8f2aeff40f584ad03b0ed7b9eb581b10a2485142ca423d391085f7f',
  'e26-mixed-all-edit-10k/v1': '1b705292b0827cea5b55d27a6e56bf8de68738f7957d51b4a857f25eaac999fe',
  'e26-mixed-all-pan-10k/v1': 'd498d6d424e7be5b0f6fccfb046db5874a74ff1ca3ead8e8e71559fcedae1e16',
  'e26-simple-stress-10k/v1': '9dadf652cb33762d015140734a6524da90a74d7684ad2ba2f2fe514661539494',
  'e26-pointer-busy-10k/v1': '3e1f82b533b8e71ae297601725ab17608524862cff6df1ed68802441ef42090e',
};
const V2_HASHES = {
  'e26-mixed-view-edit-10k/v2': '7e7ab91e760d65c516c9cba29484aedbb8ce14a759fe7a1e80d626f59966ffda',
  'e26-mixed-all-edit-10k/v2': '7a2838c0e6db5a586c6682aba417388abc812b998b7d2c87493c5c7a4e862a96',
  'e26-mixed-all-pan-10k/v2': '4cc6bdd2a003785b9fa9c28d88b48789bcd066ff34e3790d01f4ed6fedbbf6de',
  'e26-simple-stress-10k/v2': 'ec3cba8e56bfb16aaff4fa80f52438c53c987bd7da6d9788678514325921ec53',
  'e26-pointer-busy-10k/v2': '2b0d21397fadd5421c1a131cd5773efda6a5c6d65a3238af9074e1ec1e4112d0',
  'm9-typing-10k/v1': '1bd8f1f8a76cd52792e06a12bd7bd7d90c94b1de2f4618389b37c93c86a8e579',
};

/** Generating, projecting and hashing 10,000 nodes takes seconds. */
const SLOW = 60_000;

describe('M9-A01: the v2 document', () => {
  it(
    'generates deterministically, matching its pinned digest, and parseDocument accepts it',
    () => {
      expect(m9DocumentSha256(generated)).toBe(M9_V2_SHA256);
      expect(m9DocumentSha256(generateM9V2Document(M9_V2_SEED))).toBe(M9_V2_SHA256);
      // The digest is the configuration's: sha256 of the canonical JSON.
      expect(sha256(canonicalJson(generated))).toBe(M9_V2_SHA256);
      expect(m9DocumentSha256(generateM9V2Document(M9_V2_SEED + 1))).not.toBe(M9_V2_SHA256);
      const parsed = parseDocument(JSON.stringify(generated));
      expect(parsed.ok).toBe(true);
      expect(generated.schemaVersion).toBe(8);
      // Built at the current version: parsing changes nothing.
      if (parsed.ok) expect(JSON.parse(JSON.stringify(parsed.document))).toEqual(generated);
    },
    SLOW,
  );

  it(
    'has the section 3.1 counts',
    () => {
      const counts = m9V2Counts(generated);
      expect(counts).toEqual(COUNTS);
      expect(counts.documentNodes).toBe(10_000);
      expect(counts.page1Projected).toBeGreaterThanOrEqual(M9_V2_PROJECTED.min);
      expect(counts.page1Projected).toBeLessThanOrEqual(M9_V2_PROJECTED.max);
      expect(counts.fromExpansion).toBeGreaterThanOrEqual(1_000);
      expect(counts.textNodes).toBe(200);
      expect(counts.textClusters).toBeGreaterThanOrEqual(6_000);
      expect(counts.scaledInstances * 2).toBe(counts.instances);
      // The editor's projection with the recorded layouts counts the same scene nodes.
      expect(loaded.projection.nodes.size).toBe(COUNTS.page1Projected);
    },
    SLOW,
  );

  it(
    'has ten 10-node sources on page 2, one with a text node, and keeps the move selection',
    () => {
      const symbols = Object.values(generated.nodes).filter((node) => node.type === 'symbol');
      expect(symbols).toHaveLength(10);
      for (const symbol of symbols) {
        expect(symbol.parent).toBe('page-2');
        let count = 0;
        const visit = (id: string) => {
          count += 1;
          const children = generated.nodes[id]!.children as string[] | undefined;
          for (const child of children ?? []) visit(child);
        };
        visit(symbol.id);
        expect(count).toBe(10);
      }
      // Cluster 0 (the move selection's) is M1-A13's, unchanged.
      const { group, ids } = m1A13MoveSelection(generated as never);
      expect(generated.nodes[ids[0]]!.type).toBe('rectangle');
      expect(generated.nodes[ids[1]]!.type).toBe('ellipse');
      expect(generated.pages[0]!.children[0]).toBe(generated.nodes[group]!.parent);
      // No instance or text inside a mask group or in cluster 0.
      for (const node of Object.values(generated.nodes)) {
        if (node.type !== 'instance' && node.type !== 'text') continue;
        if (node.parent.startsWith('m9-s')) continue;
        expect(generated.nodes[node.parent]!.type, node.id).toBe('group');
        expect(node.parent, node.id).not.toBe(group);
      }
    },
    SLOW,
  );

  it(
    'writes text only in the subset of the committed font, the 50 second-family nodes included',
    () => {
      // The subset's Hangul list is the README's.
      const readme = readFileSync(
        path.join(root, 'tests/fixtures/m6-text/fonts/README.md'),
        'utf8',
      );
      const listed = [...readme.matchAll(/U\+([0-9A-F]{4})(?=[,"])/gu)]
        .map((match) => Number.parseInt(match[1]!, 16))
        .filter((code) => code >= 0xac00 && code <= 0xd7a3);
      expect(listed).toEqual([...M9_SUBSET_HANGUL]);
      const texts = Object.values(generated.nodes).filter(
        (node): node is typeof node & TextNode => node.type === 'text',
      );
      for (const node of texts) {
        expect(node.runs.length).toBeGreaterThanOrEqual(1);
        expect(node.runs.length).toBeLessThanOrEqual(3);
        for (const run of node.runs) {
          expect(inSubset(run.text), run.text).toBe(true);
          expect([M9_TEST_FAMILY, M9_SECOND_FAMILY]).toContain(run.family);
        }
      }
      const instances = Object.values(generated.nodes).filter((node) => node.type === 'instance');
      for (const instance of instances) {
        for (const override of Object.values(instance.textOverrides as Record<string, TextNode>)) {
          for (const run of override.runs) expect(inSubset(run.text)).toBe(true);
        }
      }
      const sizing = texts.filter((node) => !node.id.startsWith('m9-s')).map((node) => node.sizing);
      expect(sizing.filter((mode) => mode === 'autoWidth')).toHaveLength(100);
      expect(sizing.filter((mode) => mode === 'autoHeight')).toHaveLength(100);
    },
    SLOW,
  );

  it(
    'starts every run after the first at a word start (no run boundary inside a word)',
    () => {
      let boundaries = 0;
      for (const node of Object.values(generated.nodes)) {
        if (node.type !== 'text') continue;
        const runs = (node as unknown as TextNode).runs;
        for (let r = 1; r < runs.length; r += 1) {
          boundaries += 1;
          expect(runs[r - 1]!.text.endsWith(' '), `${node.id} run ${r}`).toBe(true);
          expect(runs[r]!.text.startsWith(' '), `${node.id} run ${r}`).toBe(false);
        }
      }
      // 200 nodes with 1 + (j mod 3) runs, the 60-cluster target with one: 199 boundaries.
      expect(boundaries).toBe(199);
    },
    SLOW,
  );

  it(
    'has the 60-cluster ASCII typing target in the typical view',
    () => {
      const id = m9TypingTarget(generated);
      const node = generated.nodes[id] as unknown as TextNode;
      const text = node.runs.map((run) => run.text).join('');
      expect(text).toHaveLength(60);
      expect(graphemeCount(text)).toBe(60);
      expect(/^[\x20-\x7e]+$/u.test(text)).toBe(true);
      expect(node.visible).toBe(true);
      const box = loaded.bounds.get(id);
      expect(box).toBeTruthy();
      expect(contains(worldViewport(typicalCamera(loaded.bounds)), box!)).toBe(true);
    },
    SLOW,
  );
});

describe('M9-A02: the M9 scenarios', () => {
  it(
    'lists the six section 3.2 scenarios with stable IDs, targets and ui=1',
    () => {
      expect(
        M9_SCENARIOS.map((scenario) => [
          scenario.id,
          scenario.document,
          scenario.camera,
          scenario.interaction,
          scenario.frameCeilingMs,
          scenario.latencyBoundMs,
        ]),
      ).toEqual([
        ['e26-mixed-view-edit-10k/v2', 'm9-v2', 'typical', 'edit-drag', 16.7, null],
        ['e26-mixed-all-edit-10k/v2', 'm9-v2', 'fitted', 'edit-drag', 33.3, null],
        ['e26-mixed-all-pan-10k/v2', 'm9-v2', 'fitted', 'pan-zoom', 33.3, null],
        ['e26-simple-stress-10k/v2', 'stress', 'fitted', 'pan-zoom', 33.3, null],
        ['e26-pointer-busy-10k/v2', 'm9-v2', 'typical', 'latency-drag', null, 50],
        ['m9-typing-10k/v1', 'm9-v2', 'typical', 'typing', null, null],
      ]);
      for (const scenario of M9_SCENARIOS) {
        expect(scenario.m9).toMatchObject({ ui: true, window: M9_WINDOW });
        expect(scenario.seed).toBe(scenario.document === 'stress' ? 0x5031_0001 : M9_V2_SEED);
      }
      expect(M9_WINDOW).toEqual({ width: 1600, height: 1000 });
      expect(M9_SCENARIOS[4]).toMatchObject({
        persist: true,
        renderMode: 'on-demand',
        reject: { mode: 'once', armedAtMs: 1_000, target: 'moved-leaf' },
        setFillBeforeDownMs: 100,
        m9: { fontLoad: { armedAtMs: 2_000, family: M9_SECOND_FAMILY, mark: 'm9-font-load' } },
      });
      expect(M9_FONT_LOAD.family).toBe(M9_SECOND_FAMILY);
      expect(M9_SCENARIOS[5]).toMatchObject({
        persist: true,
        renderMode: 'on-demand',
        reject: null,
        setFillBeforeDownMs: null,
        m9: { fontLoad: null, typing: { offset: 60, intervalMs: 120 } },
      });
      expect(M9_TYPING.text).toHaveLength(40);
      expect(/^[\x21-\x7e]+$/u.test(M9_TYPING.text)).toBe(true);
      // v1 keeps its five scenarios, none with m9.
      expect(E26_SCENARIOS).toHaveLength(5);
      for (const scenario of E26_SCENARIOS) expect('m9' in scenario).toBe(false);
    },
    SLOW,
  );

  it(
    'pins every configuration hash and records the layer tree',
    () => {
      for (const scenario of E26_SCENARIOS) {
        const hash = configurationHash(e26Configuration(scenario, 1, 5));
        expect(hash, scenario.id).toBe(V1_HASHES[scenario.id as keyof typeof V1_HASHES]);
      }
      for (const scenario of M9_SCENARIOS) {
        const configuration = m9Configuration(
          scenario,
          1,
          5,
          scenario.document === 'm9-v2' ? loaded : undefined,
        );
        const hash = configurationHash(configuration);
        expect(hash, scenario.id).toBe(V2_HASHES[scenario.id as keyof typeof V2_HASHES]);
        expect(configuration.documentSha256).toBe(
          scenario.document === 'm9-v2'
            ? M9_V2_SHA256
            : 'dc5cf1a75b00e460fa638ec2197024287671beced964522a03d093ded541fae1',
        );
        expect(configuration.schemaVersion).toBe(8);
        if (scenario.document === 'm9-v2') {
          expect(configuration.m9.expanded).toEqual(['f1', 'g3']);
          expect(configuration.m9.layerRows).toBe(655);
          expect(configuration.m9.layoutTableSha256).toBe(
            sha256(
              canonicalJson(
                Object.fromEntries(
                  Object.entries(readM9LayoutTable(M9_LAYOUT_TABLE).layouts).map(
                    ([key, layout]) => [key, { ...layout, generation: 0 }],
                  ),
                ),
              ),
            ),
          );
          // Neither the recording browser nor the port generation counts.
          const table = readM9LayoutTable(M9_LAYOUT_TABLE);
          const [firstKey, first] = Object.entries(table.layouts)[0]!;
          expect(
            m9LayoutTableSha256({
              recordedWith: { url: '/elsewhere', browser: 'other 1' },
              layouts: { ...table.layouts, [firstKey]: { ...first, generation: 99 } },
            }),
          ).toBe(configuration.m9.layoutTableSha256);
          expect(
            m9LayoutTableSha256({
              ...table,
              layouts: { ...table.layouts, [firstKey]: { ...first, width: first.width + 1 } },
            }),
          ).not.toBe(configuration.m9.layoutTableSha256);
        } else {
          expect(configuration.m9).toMatchObject({ expanded: [], layerRows: 10_000 });
        }
        expect(configuration.m9.typingTarget).toBe(scenario.m9?.typing ? 'r18' : null);
        // Sensitive to the m9 record.
        const changed = { ...configuration, m9: { ...configuration.m9, layerRows: 1 } };
        expect(configurationHash(changed)).not.toBe(hash);
      }
    },
    SLOW,
  );

  it(
    'holds every page-1 text request in the recorded layout table',
    () => {
      const parsed = parseDocument(JSON.stringify(generated));
      if (!parsed.ok) throw new Error(parsed.code);
      const requests = m9LayoutRequests(parsed.document);
      const table = readM9LayoutTable();
      expect(Object.keys(table.layouts).sort()).toEqual(requests.map(requestKey));
      expect(requests).toHaveLength(207);
      // Every text leaf of page 1 has draw bounds from its layout.
      const textLeaves = [...loaded.projection.nodes.values()].filter(
        (node) => node.kind === 'text',
      );
      expect(textLeaves.length).toBeGreaterThan(200);
      for (const leaf of textLeaves) {
        if (loaded.bounds.has(leaf.id)) expect(loaded.bounds.get(leaf.id), leaf.id).not.toBeNull();
      }
    },
    SLOW,
  );

  it(
    'chooses a typical view with 900 to 1,100 drawn leaves at DPR 1 and 2',
    () => {
      const camera = typicalCamera(loaded.bounds);
      expect(camera.zoom).toBeCloseTo(TYPICAL_ZOOM, 9);
      expect(loaded.bounds.size).toBe(DRAWN_LEAVES);
      for (const dpr of [1, 2]) {
        const { visible, leaves } = visibility(loaded.bounds, camera, dpr);
        expect(visible).toBeGreaterThanOrEqual(E26_TYPICAL_VISIBLE.min);
        expect(visible).toBeLessThanOrEqual(E26_TYPICAL_VISIBLE.max);
        expect(visible).toBeLessThan(leaves);
      }
      expect(visibility(loaded.bounds, camera).visible).toBe(TYPICAL_VISIBLE);
      expect(visibility(loaded.bounds, camera, 2).visible).toBe(TYPICAL_VISIBLE_DPR2);
      expect(m9Configuration(M9_SCENARIOS[0]!, 1, 5, loaded).camera).toEqual(camera);
    },
    SLOW,
  );

  it(
    'fits every drawn leaf at F and along the whole pan and zoom path',
    () => {
      const fitted = fittedCamera(contentBounds(loaded.bounds));
      const all = (camera: typeof fitted) => {
        const { inside, leaves } = visibility(loaded.bounds, camera);
        return inside === leaves;
      };
      expect(all(fitted)).toBe(true);
      for (let t = 0; t < 10_000; t += 1) expect(all(panZoomCamera(fitted, t))).toBe(true);
    },
    SLOW,
  );

  it(
    'judges the camera claims over a table: the committed one holds, a broken one does not',
    () => {
      const cameras = m9Cameras(loaded);
      const committed = readM9LayoutTable();
      const claims = m9CameraClaims(loaded, cameras);
      expect(claims.holds).toBe(true);
      expect(claims.typical.atDpr.map((entry) => entry.visible)).toEqual([
        TYPICAL_VISIBLE,
        TYPICAL_VISIBLE_DPR2,
      ]);
      expect(claims.fitted).toMatchObject({ insideAtF: DRAWN_LEAVES, panFirstMissMs: null });
      expect(claims.moveSelection.holds).toBe(true);
      const perturb = (
        change: (layout: CompactLayout) => CompactLayout,
        pick = (key: string) => key === Object.keys(committed.layouts)[0],
      ): M9LayoutTable => ({
        recordedWith: { url: '/', browser: 'other 1' },
        layouts: Object.fromEntries(
          Object.entries(committed.layouts).map(([key, layout]) => [
            key,
            pick(key) ? change(layout) : layout,
          ]),
        ),
      });
      // Every number a hair off: reported, the claims still hold.
      const nudged = perturb(
        (layout) => ({
          ...layout,
          clusters: layout.clusters.map(
            ([start, end, line, run, x, y, advance]) =>
              [start, end, line, run, x + 0.0005, y, advance] as (typeof layout.clusters)[number],
          ),
        }),
        () => true,
      );
      const nudgedDiff = m9LayoutDiff(nudged, committed);
      expect(nudgedDiff.differing).toBe(207);
      expect(nudgedDiff.maxNumericDelta).toBeCloseTo(0.0005, 9);
      expect(nudgedDiff.lineBreaks).toEqual([]);
      expect(nudgedDiff.missing).toEqual([]);
      expect(m9CameraClaims(loadScenarioDocument('m9-v2', nudged), cameras).holds).toBe(true);
      // Other line breaks are listed by key.
      const [firstKey] = Object.keys(committed.layouts);
      const rebroken = perturb((layout) => ({
        ...layout,
        lines: layout.lines.map((line, index) =>
          index === 0 ? ([line[0], line[1] + 1, ...line.slice(2)] as typeof line) : line,
        ),
      }));
      const rebrokenDiff = m9LayoutDiff(rebroken, committed);
      expect(rebrokenDiff.differing).toBe(1);
      expect(rebrokenDiff.lineBreaks.map((entry) => entry.key)).toEqual([firstKey]);
      // A text leaf pushed far out of the content: F no longer holds every drawn leaf.
      const far = perturb(
        (layout) => ({
          ...layout,
          clusters: layout.clusters.map(
            ([start, end, line, run, x, y, advance]) =>
              [start, end, line, run, x + 1e5, y, advance] as (typeof layout.clusters)[number],
          ),
        }),
        () => true,
      );
      const broken = m9CameraClaims(loadScenarioDocument('m9-v2', far), cameras);
      expect(broken.fitted.holds).toBe(false);
      expect(broken.holds).toBe(false);
      expect(m9LayoutDiff({ ...committed, layouts: {} }, committed).missing).toHaveLength(207);
    },
    SLOW * 2,
  );

  it(
    'keeps the moved selection in the viewport through the edit drag at both cameras',
    () => {
      const { ids } = m1A13MoveSelection(generated as never);
      for (const camera of [
        fittedCamera(contentBounds(loaded.bounds)),
        typicalCamera(loaded.bounds),
      ]) {
        const view = worldViewport(camera);
        for (let t = 0; t < 10_000; t += 10) {
          const offset = editDragOffset(t);
          for (const id of ids) {
            const box = loaded.bounds.get(id)!;
            const dx = offset.x / camera.zoom;
            const dy = offset.y / camera.zoom;
            expect(
              contains(view, {
                minX: box.minX + dx,
                minY: box.minY + dy,
                maxX: box.maxX + dx,
                maxY: box.maxY + dy,
              }),
            ).toBe(true);
          }
        }
      }
    },
    SLOW,
  );
});
