# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e26-harness.spec.ts >> e26-pointer-busy-10k/v2 r1
- Location: tests\e26\e26-harness.spec.ts:772:5

# Error details

```
Error: the release was applied

expect(received).toBe(expected) // Object.is equality

Expected: 2
Received: 1
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
      - generic [ref=e45]:
        - region "layers" [ref=e46]:
          - toolbar "arrange" [ref=e47]:
            - button "forward" [ref=e48]
            - button "backward" [ref=e49]
            - button "front" [ref=e50]
            - button "back" [ref=e51]
          - list "layer list" [ref=e53]:
            - listitem [ref=e54]:
              - button "e9250" [ref=e55]
              - generic [ref=e56]: ellipse
              - button "hide" [ref=e57]
            - listitem [ref=e58]:
              - button "expand" [ref=e59]: ▸
              - button "f211" [ref=e60]
              - generic [ref=e61]: frame
              - button "hide" [ref=e62]
            - listitem [ref=e63]:
              - button "expand" [ref=e64]: ▸
              - button "f197" [ref=e65]
              - generic [ref=e66]: frame
              - button "hide" [ref=e67]
            - listitem [ref=e68]:
              - button "expand" [ref=e69]: ▸
              - button "f183" [ref=e70]
              - generic [ref=e71]: frame
              - button "hide" [ref=e72]
            - listitem [ref=e73]:
              - button "expand" [ref=e74]: ▸
              - button "f169" [ref=e75]
              - generic [ref=e76]: frame
              - button "hide" [ref=e77]
            - listitem [ref=e78]:
              - button "expand" [ref=e79]: ▸
              - button "f155" [ref=e80]
              - generic [ref=e81]: frame
              - button "hide" [ref=e82]
            - listitem [ref=e83]:
              - button "expand" [ref=e84]: ▸
              - button "f141" [ref=e85]
              - generic [ref=e86]: frame
              - button "hide" [ref=e87]
            - listitem [ref=e88]:
              - button "expand" [ref=e89]: ▸
              - button "f127" [ref=e90]
              - generic [ref=e91]: frame
              - button "hide" [ref=e92]
            - listitem [ref=e93]:
              - button "expand" [ref=e94]: ▸
              - button "f113" [ref=e95]
              - generic [ref=e96]: frame
              - button "hide" [ref=e97]
            - listitem [ref=e98]:
              - button "expand" [ref=e99]: ▸
              - button "f99" [ref=e100]
              - generic [ref=e101]: frame
              - button "hide" [ref=e102]
            - listitem [ref=e103]:
              - button "expand" [ref=e104]: ▸
              - button "f85" [ref=e105]
              - generic [ref=e106]: frame
              - button "hide" [ref=e107]
            - listitem [ref=e108]:
              - button "expand" [ref=e109]: ▸
              - button "f71" [ref=e110]
              - generic [ref=e111]: frame
              - button "hide" [ref=e112]
            - listitem [ref=e113]:
              - button "expand" [ref=e114]: ▸
              - button "f57" [ref=e115]
              - generic [ref=e116]: frame
              - button "hide" [ref=e117]
            - listitem [ref=e118]:
              - button "expand" [ref=e119]: ▸
              - button "f43" [ref=e120]
              - generic [ref=e121]: frame
              - button "hide" [ref=e122]
            - listitem [ref=e123]:
              - button "expand" [ref=e124]: ▸
              - button "f29" [ref=e125]
              - generic [ref=e126]: frame
              - button "hide" [ref=e127]
            - listitem [ref=e128]:
              - button "expand" [ref=e129]: ▸
              - button "f15" [ref=e130]
              - generic [ref=e131]: frame
              - button "hide" [ref=e132]
            - listitem [ref=e133]:
              - button "collapse" [expanded] [ref=e134]: ▾
              - button "f1" [ref=e135]
              - generic [ref=e136]: frame
              - button "hide" [ref=e137]
            - listitem [ref=e138]:
              - button "l14" [ref=e139]
              - generic [ref=e140]: line
              - button "hide" [ref=e141]
            - listitem [ref=e142]:
              - button "expand" [ref=e143]: ▸
              - button "m10" [ref=e144]
              - generic [ref=e145]: maskGroup
              - button "hide" [ref=e146]
            - listitem [ref=e147]:
              - button "collapse" [expanded] [ref=e148]: ▾
              - button "g3" [ref=e149]
              - generic [ref=e150]: group
              - button "hide" [ref=e151]
            - listitem [ref=e152]:
              - button "expand" [ref=e153]: ▸
              - button "g7" [ref=e154]
              - generic [ref=e155]: group
              - button "hide" [ref=e156]
            - listitem [ref=e157]:
              - button "p6" [ref=e158]
              - generic [ref=e159]: path
              - button "hide" [ref=e160]
            - listitem [ref=e161]:
              - button "e5" [pressed] [ref=e162]
              - generic [ref=e163]: ellipse
              - button "hide" [ref=e164]
            - listitem [ref=e165]:
              - button "r4" [pressed] [ref=e166]
              - generic [ref=e167]: rectangle
              - button "hide" [ref=e168]
            - listitem [ref=e169]:
              - button "r2" [ref=e170]
              - generic [ref=e171]: rectangle
              - button "hide" [ref=e172]
        - region "Properties" [ref=e173]:
          - complementary "Appearance" [ref=e174]:
            - group "Fill" [ref=e175]:
              - combobox "Fill type" [ref=e178]:
                - option "none"
                - option "solid" [selected]
                - option "linear"
                - option "radial"
              - generic [ref=e179]:
                - textbox "Fill colour" [ref=e180]:
                  - /placeholder: mixed
                - textbox "Fill alpha" [ref=e181]: "1"
            - group "Stroke" [ref=e182]:
              - generic [ref=e185]:
                - checkbox "Stroke" [checked=mixed] [ref=e186]
                - text: stroke
              - combobox "Stroke type" [ref=e188]:
                - option "solid" [selected]
                - option "linear"
                - option "radial"
              - generic [ref=e189]:
                - textbox "Stroke colour" [ref=e190]: "#796c7a"
                - textbox "Stroke alpha" [ref=e191]: "1"
              - generic [ref=e192]:
                - textbox "Stroke width" [ref=e193]: "2"
                - combobox "Stroke cap" [ref=e194]:
                  - option "butt" [selected]
                  - option "round"
                  - option "square"
                - combobox "Stroke join" [ref=e195]:
                  - option "miter"
                  - option "round" [selected]
                  - option "bevel"
                - textbox "Miter limit" [ref=e196]: "4"
              - generic [ref=e197]:
                - textbox "Dash pattern" [ref=e198]
                - textbox "Dash phase" [disabled] [ref=e199]
            - group "Layer" [ref=e200]:
              - generic [ref=e202]:
                - slider "Opacity" [ref=e203]: "0.5"
                - status "Opacity value" [ref=e204]: "0.5"
            - group "Corner radii" [ref=e205]:
              - generic [ref=e207]:
                - button "Link corner radii" [pressed] [ref=e208]: link
                - textbox "Corner radius top left" [ref=e209]: "0"
                - textbox "Corner radius top right" [ref=e210]: "0"
                - textbox "Corner radius bottom right" [ref=e211]: "11"
                - textbox "Corner radius bottom left" [ref=e212]: "0"
          - generic [ref=e213]:
            - group "Transform" [ref=e214]:
              - generic [ref=e216]:
                - textbox "X" [disabled] [ref=e217]:
                  - /placeholder: mixed
                - textbox "Y" [disabled] [ref=e218]: "0"
                - textbox "W" [disabled] [ref=e219]:
                  - /placeholder: mixed
                - textbox "H" [disabled] [ref=e220]: "30"
                - textbox "Rotation" [disabled] [ref=e221]: "0"
            - group "Name and visibility" [ref=e222]:
              - generic [ref=e224]:
                - textbox "Name" [disabled] [ref=e225]:
                  - /placeholder: mixed
                - generic [ref=e226]:
                  - checkbox "Visible" [checked] [disabled] [ref=e227]
                  - text: visible
        - region "Star" [ref=e228]:
          - heading [level=2] [ref=e229]:
            - button "Star" [expanded] [ref=e230]
          - generic [ref=e232]:
            - button "Create star" [ref=e233]
            - paragraph [ref=e234]: select one star
    - paragraph [ref=e235]:
      - text: revision 28, 647 nodes, 2 selected
      - generic [ref=e236]: "scope: page"
      - generic [ref=e237]: "persist: saved 2"
  - alert [ref=e238]
```

# Test source

```ts
  1197 |         { downMs, upMs, upHandledMs, splitEnabled },
  1198 |       );
  1199 |       const latencySplit = state.measures === null ? null : pairLatencySplit(state);
  1200 |       const samples = state.latencies
  1201 |         .filter((entry) => entry.doneMs !== null && Number.isFinite(entry.doneMs))
  1202 |         .map((entry) => entry.doneMs! - entry.inputMs);
  1203 |       const overlaps = (task: { startMs: number; durationMs: number }) =>
  1204 |         state.isolations.some(
  1205 |           (measure) =>
  1206 |             task.startMs < measure.startMs + measure.durationMs &&
  1207 |             measure.startMs < task.startMs + task.durationMs,
  1208 |         );
  1209 |       // M9-Q3: a long task overlapping the font-load change is flagged, never exempt.
  1210 |       const overlapsFontLoad = (task: { startMs: number; durationMs: number }) =>
  1211 |         state.fontLoadMeasures.some(
  1212 |           (measure) =>
  1213 |             task.startMs < measure.startMs + measure.durationMs &&
  1214 |             measure.startMs < task.startMs + task.durationMs,
  1215 |         );
  1216 |       const longOver50 = state.longTasks.filter((task) => task.durationMs > 50);
  1217 |       const writesDuringPress = state.writes.filter(
  1218 |         (write) => write.startMs > downMs && write.startMs < upHandledMs,
  1219 |       );
  1220 |       const firstAfterUp = state.writes.find((write) => write.startMs >= upHandledMs) ?? null;
  1221 |       const presenceEnd = await presence(page);
  1222 |       const open_ = (entry: (typeof state.latencies)[number]) =>
  1223 |         entry.failed !== true && (entry.doneMs === null || Number.isNaN(entry.doneMs));
  1224 |       // M9-U1: each page error placed against the press and the font-load change (page clock).
  1225 |       const fontStartMs = state.fontLoads[0]?.startMs ?? null;
  1226 |       const pageErrors = probe.pageErrors.map((entry) => ({
  1227 |         ...entry,
  1228 |         sinceDownMs: entry.atMs - downMs,
  1229 |         sinceFontLoadMs: fontStartMs === null ? null : entry.atMs - fontStartMs,
  1230 |       }));
  1231 |       const result = {
  1232 |         ...base,
  1233 |         environment: env,
  1234 |         presence: { start: presenceStart, end: presenceEnd },
  1235 |         errors,
  1236 |         pageErrors,
  1237 |         consoleErrors,
  1238 |         downMs,
  1239 |         upMs,
  1240 |         upHandledMs,
  1241 |         probe,
  1242 |         loadWriteOk,
  1243 |         moves,
  1244 |         expectedMoves: E26_DRIVERS.latencyDurationMs / E26_DRIVERS.latencyCadenceMs,
  1245 |         sentAtMs,
  1246 |         lastOffset: last,
  1247 |         pointerToWorkDoneMs: summary(samples),
  1248 |         boundMs: scenario.latencyBoundMs,
  1249 |         splitEnabled,
  1250 |         split: latencySplit?.split ?? null,
  1251 |         splitPairs: latencySplit?.pairs ?? null,
  1252 |         // Not ended and not failed after the settle, claimed by a submission or not.
  1253 |         unresolved: state.latencies.filter(open_).length,
  1254 |         failed: state.latencies.filter((entry) => entry.failed === true).length,
  1255 |         noChange: state.noChangeMoves.length,
  1256 |         longTasksAvailable: state.longTasksAvailable,
  1257 |         longTasksOver50: longOver50.map((task) => ({
  1258 |           ...task,
  1259 |           isolation: overlaps(task),
  1260 |           ...(m9 === undefined ? {} : { fontLoad: overlapsFontLoad(task) }),
  1261 |         })),
  1262 |         ...(m9 === undefined
  1263 |           ? {}
  1264 |           : { layers, fontLoad: { armed: fontLoad, status: fontStatus, loads: state.fontLoads } }),
  1265 |         isolations: state.isolations,
  1266 |         rejections: state.rejections,
  1267 |         writesDuringPress,
  1268 |         firstWriteAfterUpMs: firstAfterUp === null ? null : firstAfterUp.startMs - upHandledMs,
  1269 |         // setStyle (busy only) and the move, each one undo step: the pointer up was applied.
  1270 |         undoDepth: state.undoDepth,
  1271 |         expectedUndoDepth: busy ? 2 : 1,
  1272 |         state,
  1273 |         ...(capture === null
  1274 |           ? {}
  1275 |           : { presentmon: { ...(await finishPresentMon(capture)), syncBefore, syncAfter } }),
  1276 |       };
  1277 |       openCapture = null;
  1278 |       record(slug, result);
  1279 |       expectValidRun(state, {
  1280 |         errors,
  1281 |         expectedDpr: dpr,
  1282 |         pageDpr: env.devicePixelRatio,
  1283 |         start: presenceStart,
  1284 |         end: presenceEnd,
  1285 |       });
  1286 |       expect(loadWriteOk, 'the load write succeeded').toBe(true);
  1287 |       // Canvas presses only (tests/e26/probe.ts): the layer toggles are the only other presses.
  1288 |       expect(probe.downs.length, 'one press').toBe(1);
  1289 |       expect(probe.ups.length, 'one release').toBe(1);
  1290 |       expect(probe.otherDowns, 'presses outside the canvas: the layer toggles').toEqual(
  1291 |         (layers?.expanded ?? []).map((id) => `layer-toggle-${id}`),
  1292 |       );
  1293 |       expect(state.mode).toBe('on-demand');
  1294 |       expect(result.failed).toBe(0);
  1295 |       expect(result.unresolved).toBe(0);
  1296 |       expect(samples.length, 'moves that produced a revision').toBeGreaterThan(0);
> 1297 |       expect(result.undoDepth, 'the release was applied').toBe(result.expectedUndoDepth);
       |                                                           ^ Error: the release was applied
  1298 |       if (busy) expect(result.rejections).toBe(1);
  1299 |       if (layers !== null) expect(layers.rows, 'layer rows shown').toBe(layers.expectedRows);
  1300 |       if (fontLoad !== null) {
  1301 |         expect(state.fontLoads, 'one font-load change').toHaveLength(1);
  1302 |         expect(fontStatus, 'the font-load change loaded').toBe('loaded');
  1303 |         // A real change: the port's generation and the scene revision both advanced.
  1304 |         const [load] = state.fontLoads;
  1305 |         expect(load!.generationAfter!, 'the text port generation advanced').toBeGreaterThan(
  1306 |           load!.generationBefore,
  1307 |         );
  1308 |         expect(load!.revisionAfter!, 'the scene revision advanced').toBeGreaterThan(
  1309 |           load!.revisionBefore,
  1310 |         );
  1311 |       }
  1312 |     });
  1313 |   }
  1314 | }
  1315 | 
  1316 | // E26-U6b (E26-A06): isolation of the M1-A13 page with one and with 16 persistent rejections.
  1317 | const isolationRuns =
  1318 |   filter.length === 0 || filter.some((entry) => E26_ISOLATION.id.startsWith(entry));
  1319 | for (let repetition = 1; isolationRuns && repetition <= repetitions; repetition += 1) {
  1320 |   test(`${E26_ISOLATION.id} r${repetition}`, async ({ page, browser }, testInfo) => {
  1321 |     test.skip(v2Project(testInfo.project.name), 'a v1 scenario: v1 projects only');
  1322 |     test.skip(memoryVariant, 'the memory variant runs the frame runs only');
  1323 |     if (!smoke)
  1324 |       expect(dirty, 'a clean working tree, so the recorded commit is what ran').toBe(false);
  1325 |     const dpr = testInfo.project.use.deviceScaleFactor ?? 1;
  1326 |     const document = loaded(E26_ISOLATION.document);
  1327 |     const targets = isolationTargets(document);
  1328 |     const configuration = {
  1329 |       isolation: E26_ISOLATION,
  1330 |       documentSha256: sha256(canonicalJson(document.generated)),
  1331 |       schemaVersion: document.document.schemaVersion,
  1332 |       sceneNodes: document.projection.nodes.size,
  1333 |       targets,
  1334 |       devicePixelRatio: dpr,
  1335 |       repetitions,
  1336 |     };
  1337 |     const slug = `${testInfo.project.name}--${E26_ISOLATION.id.replace(/[^a-z0-9-]+/gi, '_')}--r${repetition}`;
  1338 |     const { errors, consoleErrors } = await installProbe(page);
  1339 |     await open(page, `doc=${E26_ISOLATION.document}&isolation=1`, errors);
  1340 |     const env = await environment(page);
  1341 |     const start = await presence(page);
  1342 |     const run = await page.evaluate(
  1343 |       async ({ doc, replaceRuns, one, sixteen }) => {
  1344 |         const hook = window.__e26Bench!;
  1345 |         const editor = hook.editor()!;
  1346 |         const backend = hook.backend()!;
  1347 |         const response = await fetch(`/e26-bench-doc.json?doc=${doc}`, { cache: 'no-store' });
  1348 |         const value: unknown = await response.json();
  1349 |         const runStartMs = performance.now();
  1350 |         const settleErrors: string[] = [];
  1351 |         // Each load is one command; the next starts after its frame's work is done.
  1352 |         const settle = async () => {
  1353 |           await new Promise((resolve) => requestAnimationFrame(resolve));
  1354 |           await new Promise((resolve) => requestAnimationFrame(resolve));
  1355 |           await backend.waitForSubmittedWork().catch((error: unknown) => {
  1356 |             settleErrors.push(String(error));
  1357 |           });
  1358 |         };
  1359 |         // The command's own time, and the scene rejections it reported.
  1360 |         const load = () => {
  1361 |           const rejected: string[] = [];
  1362 |           const unsubscribe = editor.subscribe((event) => {
  1363 |             if (event.type === 'diagnostic' && event.code === 'editor.scene-rejected') {
  1364 |               rejected.push(...(event.nodeIds ?? []));
  1365 |             }
  1366 |           });
  1367 |           const start = performance.now();
  1368 |           const result = editor.execute({ type: 'loadDocument', document: value });
  1369 |           const commandMs = performance.now() - start;
  1370 |           unsubscribe();
  1371 |           return {
  1372 |             error: result.ok ? null : (result.code ?? 'failed'),
  1373 |             commandMs,
  1374 |             rejected: [...rejected].sort(),
  1375 |           };
  1376 |         };
  1377 |         const loadErrors: string[] = [];
  1378 |         const replaces: { durationMs: number; nodes: number; status: string; commandMs: number }[] =
  1379 |           [];
  1380 |         for (let i = 0; i < replaceRuns; i += 1) {
  1381 |           const before = hook.replaces.length;
  1382 |           const loaded = load();
  1383 |           if (loaded.error !== null) loadErrors.push(loaded.error);
  1384 |           if (loaded.rejected.length > 0) loadErrors.push(`rejected ${loaded.rejected.join(',')}`);
  1385 |           const sent = hook.replaces.slice(before).filter((entry) => entry.nodes > 0);
  1386 |           replaces.push(
  1387 |             ...sent.map(({ durationMs, nodes, status }) => ({
  1388 |               durationMs,
  1389 |               nodes,
  1390 |               status,
  1391 |               commandMs: loaded.commandMs,
  1392 |             })),
  1393 |           );
  1394 |           await settle();
  1395 |         }
  1396 |         const isolate = async (ids: readonly string[]) => {
  1397 |           const rejections = hook.rejections();
```