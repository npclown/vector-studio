# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e26-harness.spec.ts >> e26-ui0-pointer-busy-10k/v1 r3
- Location: tests\e26\e26-harness.spec.ts:757:5

# Error details

```
Error: the font-load change loaded

expect(received).toBe(expected) // Object.is equality

Expected: "loaded"
Received: "error"
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e2]:
    - toolbar "tools" [ref=e3]:
      - button "select" [pressed] [ref=e4]
      - button "rectangle" [ref=e5]
      - button "ellipse" [ref=e6]
      - button "line" [ref=e7]
      - button "frame" [ref=e8]
      - button "path" [ref=e9]
      - button "text" [ref=e10]
      - button "group" [ref=e11]
      - button "mask" [ref=e12]
      - button "ungroup" [disabled] [ref=e13]
      - button "undo" [ref=e14]
      - button "redo" [disabled] [ref=e15]
      - button "delete" [ref=e16]
      - button "toggle closed" [disabled] [ref=e17]
      - button "star" [ref=e18]
      - group "file" [ref=e19]:
        - button "Save file" [ref=e20]
        - button "Open file" [ref=e21]
    - generic [ref=e22]:
      - group "pages" [ref=e23]:
        - navigation [ref=e24]:
          - button "Page 1" [pressed] [ref=e25]
          - button "Page 2" [ref=e26]
        - button "add page" [ref=e27]
        - button "remove page" [ref=e28]
      - toolbar "view and symbols" [ref=e29]:
        - group "zoom" [ref=e30]:
          - button "zoom in" [ref=e31]
          - button "zoom out" [ref=e32]
          - button "fit" [ref=e33]
          - button "selection" [ref=e34]
          - button "100%" [ref=e35]
          - status [ref=e36]: 51.59%
        - group "symbols" [ref=e37]:
          - button "symbol" [ref=e38]
          - button "instance" [disabled] [ref=e39]
          - button "detach" [disabled] [ref=e40]
    - generic [ref=e41]:
      - generic [ref=e43]:
        - textbox "Text input"
      - complementary "Appearance" [ref=e45]:
        - group "Fill" [ref=e46]:
          - combobox "Fill type" [ref=e49]:
            - option "none"
            - option "solid" [selected]
            - option "linear"
            - option "radial"
          - generic [ref=e50]:
            - textbox "Fill colour" [ref=e51]:
              - /placeholder: mixed
            - textbox "Fill alpha" [ref=e52]: "1"
        - group "Stroke" [ref=e53]:
          - generic [ref=e56]:
            - checkbox "Stroke" [checked=mixed] [ref=e57]
            - text: stroke
          - combobox "Stroke type" [ref=e59]:
            - option "solid" [selected]
            - option "linear"
            - option "radial"
          - generic [ref=e60]:
            - textbox "Stroke colour" [ref=e61]: "#796c7a"
            - textbox "Stroke alpha" [ref=e62]: "1"
          - generic [ref=e63]:
            - textbox "Stroke width" [ref=e64]: "2"
            - combobox "Stroke cap" [ref=e65]:
              - option "butt" [selected]
              - option "round"
              - option "square"
            - combobox "Stroke join" [ref=e66]:
              - option "miter"
              - option "round" [selected]
              - option "bevel"
            - textbox "Miter limit" [ref=e67]: "4"
          - generic [ref=e68]:
            - textbox "Dash pattern" [ref=e69]
            - textbox "Dash phase" [disabled] [ref=e70]
        - group "Layer" [ref=e71]:
          - generic [ref=e73]:
            - slider "Opacity" [ref=e74]: "0.5"
            - status "Opacity value" [ref=e75]: "0.5"
        - group "Corner radii" [ref=e76]:
          - generic [ref=e78]:
            - button "Link corner radii" [pressed] [ref=e79]: link
            - textbox "Corner radius top left" [ref=e80]: "0"
            - textbox "Corner radius top right" [ref=e81]: "0"
            - textbox "Corner radius bottom right" [ref=e82]: "11"
            - textbox "Corner radius bottom left" [ref=e83]: "0"
    - paragraph [ref=e84]:
      - text: revision 251, 647 nodes, 2 selected
      - generic [ref=e85]: "scope: page"
      - generic [ref=e86]: "persist: saved 2"
  - alert [ref=e87]
```

# Test source

```ts
  1159 |       );
  1160 |       const latencySplit = state.measures === null ? null : pairLatencySplit(state);
  1161 |       const samples = state.latencies
  1162 |         .filter((entry) => entry.doneMs !== null && Number.isFinite(entry.doneMs))
  1163 |         .map((entry) => entry.doneMs! - entry.inputMs);
  1164 |       const overlaps = (task: { startMs: number; durationMs: number }) =>
  1165 |         state.isolations.some(
  1166 |           (measure) =>
  1167 |             task.startMs < measure.startMs + measure.durationMs &&
  1168 |             measure.startMs < task.startMs + task.durationMs,
  1169 |         );
  1170 |       // M9-Q3: a long task overlapping the font-load change is flagged, never exempt.
  1171 |       const overlapsFontLoad = (task: { startMs: number; durationMs: number }) =>
  1172 |         state.fontLoadMeasures.some(
  1173 |           (measure) =>
  1174 |             task.startMs < measure.startMs + measure.durationMs &&
  1175 |             measure.startMs < task.startMs + task.durationMs,
  1176 |         );
  1177 |       const longOver50 = state.longTasks.filter((task) => task.durationMs > 50);
  1178 |       const writesDuringPress = state.writes.filter(
  1179 |         (write) => write.startMs > downMs && write.startMs < upHandledMs,
  1180 |       );
  1181 |       const firstAfterUp = state.writes.find((write) => write.startMs >= upHandledMs) ?? null;
  1182 |       const presenceEnd = await presence(page);
  1183 |       const open_ = (entry: (typeof state.latencies)[number]) =>
  1184 |         entry.failed !== true && (entry.doneMs === null || Number.isNaN(entry.doneMs));
  1185 |       // M9-U1: each page error placed against the press and the font-load change (page clock).
  1186 |       const fontStartMs = state.fontLoads[0]?.startMs ?? null;
  1187 |       const pageErrors = probe.pageErrors.map((entry) => ({
  1188 |         ...entry,
  1189 |         sinceDownMs: entry.atMs - downMs,
  1190 |         sinceFontLoadMs: fontStartMs === null ? null : entry.atMs - fontStartMs,
  1191 |       }));
  1192 |       const result = {
  1193 |         ...base,
  1194 |         environment: env,
  1195 |         presence: { start: presenceStart, end: presenceEnd },
  1196 |         errors,
  1197 |         pageErrors,
  1198 |         consoleErrors,
  1199 |         downMs,
  1200 |         upMs,
  1201 |         upHandledMs,
  1202 |         probe,
  1203 |         loadWriteOk,
  1204 |         moves,
  1205 |         expectedMoves: E26_DRIVERS.latencyDurationMs / E26_DRIVERS.latencyCadenceMs,
  1206 |         sentAtMs,
  1207 |         lastOffset: last,
  1208 |         pointerToWorkDoneMs: summary(samples),
  1209 |         boundMs: scenario.latencyBoundMs,
  1210 |         splitEnabled,
  1211 |         split: latencySplit?.split ?? null,
  1212 |         splitPairs: latencySplit?.pairs ?? null,
  1213 |         // Not ended and not failed after the settle, claimed by a submission or not.
  1214 |         unresolved: state.latencies.filter(open_).length,
  1215 |         failed: state.latencies.filter((entry) => entry.failed === true).length,
  1216 |         noChange: state.noChangeMoves.length,
  1217 |         longTasksAvailable: state.longTasksAvailable,
  1218 |         longTasksOver50: longOver50.map((task) => ({
  1219 |           ...task,
  1220 |           isolation: overlaps(task),
  1221 |           ...(m9 === undefined ? {} : { fontLoad: overlapsFontLoad(task) }),
  1222 |         })),
  1223 |         ...(m9 === undefined
  1224 |           ? {}
  1225 |           : { layers, fontLoad: { armed: fontLoad, status: fontStatus, loads: state.fontLoads } }),
  1226 |         isolations: state.isolations,
  1227 |         rejections: state.rejections,
  1228 |         writesDuringPress,
  1229 |         firstWriteAfterUpMs: firstAfterUp === null ? null : firstAfterUp.startMs - upHandledMs,
  1230 |         // setStyle (busy only) and the move, each one undo step: the pointer up was applied.
  1231 |         undoDepth: state.undoDepth,
  1232 |         expectedUndoDepth: busy ? 2 : 1,
  1233 |         state,
  1234 |       };
  1235 |       record(slug, result);
  1236 |       expectValidRun(state, {
  1237 |         errors,
  1238 |         expectedDpr: dpr,
  1239 |         pageDpr: env.devicePixelRatio,
  1240 |         start: presenceStart,
  1241 |         end: presenceEnd,
  1242 |       });
  1243 |       expect(loadWriteOk, 'the load write succeeded').toBe(true);
  1244 |       // Canvas presses only (tests/e26/probe.ts): the layer toggles are the only other presses.
  1245 |       expect(probe.downs.length, 'one press').toBe(1);
  1246 |       expect(probe.ups.length, 'one release').toBe(1);
  1247 |       expect(probe.otherDowns, 'presses outside the canvas: the layer toggles').toEqual(
  1248 |         (layers?.expanded ?? []).map((id) => `layer-toggle-${id}`),
  1249 |       );
  1250 |       expect(state.mode).toBe('on-demand');
  1251 |       expect(result.failed).toBe(0);
  1252 |       expect(result.unresolved).toBe(0);
  1253 |       expect(samples.length, 'moves that produced a revision').toBeGreaterThan(0);
  1254 |       expect(result.undoDepth, 'the release was applied').toBe(result.expectedUndoDepth);
  1255 |       if (busy) expect(result.rejections).toBe(1);
  1256 |       if (layers !== null) expect(layers.rows, 'layer rows shown').toBe(layers.expectedRows);
  1257 |       if (fontLoad !== null) {
  1258 |         expect(state.fontLoads, 'one font-load change').toHaveLength(1);
> 1259 |         expect(fontStatus, 'the font-load change loaded').toBe('loaded');
       |                                                           ^ Error: the font-load change loaded
  1260 |         // A real change: the port's generation and the scene revision both advanced.
  1261 |         const [load] = state.fontLoads;
  1262 |         expect(load!.generationAfter!, 'the text port generation advanced').toBeGreaterThan(
  1263 |           load!.generationBefore,
  1264 |         );
  1265 |         expect(load!.revisionAfter!, 'the scene revision advanced').toBeGreaterThan(
  1266 |           load!.revisionBefore,
  1267 |         );
  1268 |       }
  1269 |     });
  1270 |   }
  1271 | }
  1272 | 
  1273 | // E26-U6b (E26-A06): isolation of the M1-A13 page with one and with 16 persistent rejections.
  1274 | const isolationRuns =
  1275 |   filter.length === 0 || filter.some((entry) => E26_ISOLATION.id.startsWith(entry));
  1276 | for (let repetition = 1; isolationRuns && repetition <= repetitions; repetition += 1) {
  1277 |   test(`${E26_ISOLATION.id} r${repetition}`, async ({ page, browser }, testInfo) => {
  1278 |     test.skip(v2Project(testInfo.project.name), 'a v1 scenario: v1 projects only');
  1279 |     test.skip(memoryVariant, 'the memory variant runs the frame runs only');
  1280 |     if (!smoke)
  1281 |       expect(dirty, 'a clean working tree, so the recorded commit is what ran').toBe(false);
  1282 |     const dpr = testInfo.project.use.deviceScaleFactor ?? 1;
  1283 |     const document = loaded(E26_ISOLATION.document);
  1284 |     const targets = isolationTargets(document);
  1285 |     const configuration = {
  1286 |       isolation: E26_ISOLATION,
  1287 |       documentSha256: sha256(canonicalJson(document.generated)),
  1288 |       schemaVersion: document.document.schemaVersion,
  1289 |       sceneNodes: document.projection.nodes.size,
  1290 |       targets,
  1291 |       devicePixelRatio: dpr,
  1292 |       repetitions,
  1293 |     };
  1294 |     const slug = `${testInfo.project.name}--${E26_ISOLATION.id.replace(/[^a-z0-9-]+/gi, '_')}--r${repetition}`;
  1295 |     const { errors, consoleErrors } = await installProbe(page);
  1296 |     await open(page, `doc=${E26_ISOLATION.document}&isolation=1`, errors);
  1297 |     const env = await environment(page);
  1298 |     const start = await presence(page);
  1299 |     const run = await page.evaluate(
  1300 |       async ({ doc, replaceRuns, one, sixteen }) => {
  1301 |         const hook = window.__e26Bench!;
  1302 |         const editor = hook.editor()!;
  1303 |         const backend = hook.backend()!;
  1304 |         const response = await fetch(`/e26-bench-doc.json?doc=${doc}`, { cache: 'no-store' });
  1305 |         const value: unknown = await response.json();
  1306 |         const runStartMs = performance.now();
  1307 |         const settleErrors: string[] = [];
  1308 |         // Each load is one command; the next starts after its frame's work is done.
  1309 |         const settle = async () => {
  1310 |           await new Promise((resolve) => requestAnimationFrame(resolve));
  1311 |           await new Promise((resolve) => requestAnimationFrame(resolve));
  1312 |           await backend.waitForSubmittedWork().catch((error: unknown) => {
  1313 |             settleErrors.push(String(error));
  1314 |           });
  1315 |         };
  1316 |         // The command's own time, and the scene rejections it reported.
  1317 |         const load = () => {
  1318 |           const rejected: string[] = [];
  1319 |           const unsubscribe = editor.subscribe((event) => {
  1320 |             if (event.type === 'diagnostic' && event.code === 'editor.scene-rejected') {
  1321 |               rejected.push(...(event.nodeIds ?? []));
  1322 |             }
  1323 |           });
  1324 |           const start = performance.now();
  1325 |           const result = editor.execute({ type: 'loadDocument', document: value });
  1326 |           const commandMs = performance.now() - start;
  1327 |           unsubscribe();
  1328 |           return {
  1329 |             error: result.ok ? null : (result.code ?? 'failed'),
  1330 |             commandMs,
  1331 |             rejected: [...rejected].sort(),
  1332 |           };
  1333 |         };
  1334 |         const loadErrors: string[] = [];
  1335 |         const replaces: { durationMs: number; nodes: number; status: string; commandMs: number }[] =
  1336 |           [];
  1337 |         for (let i = 0; i < replaceRuns; i += 1) {
  1338 |           const before = hook.replaces.length;
  1339 |           const loaded = load();
  1340 |           if (loaded.error !== null) loadErrors.push(loaded.error);
  1341 |           if (loaded.rejected.length > 0) loadErrors.push(`rejected ${loaded.rejected.join(',')}`);
  1342 |           const sent = hook.replaces.slice(before).filter((entry) => entry.nodes > 0);
  1343 |           replaces.push(
  1344 |             ...sent.map(({ durationMs, nodes, status }) => ({
  1345 |               durationMs,
  1346 |               nodes,
  1347 |               status,
  1348 |               commandMs: loaded.commandMs,
  1349 |             })),
  1350 |           );
  1351 |           await settle();
  1352 |         }
  1353 |         const isolate = async (ids: readonly string[]) => {
  1354 |           const rejections = hook.rejections();
  1355 |           const measures = hook.isolations().length;
  1356 |           hook.armReject(ids, 'persistent');
  1357 |           const loaded = load();
  1358 |           hook.disarmReject();
  1359 |           // The measure is taken by a microtask queued at the first rejection.
```