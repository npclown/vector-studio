# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e26-harness.spec.ts >> e26-pointer-busy-10k/v2 r1
- Location: tests\e26\e26-harness.spec.ts:668:5

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
      - text: revision 109, 647 nodes, 2 selected
      - generic [ref=e236]: "scope: page"
      - generic [ref=e237]: "persist: saved 2"
  - alert [ref=e238]
```

# Test source

```ts
  1016 |               .getEntriesByName('m9-font-load', 'measure')
  1017 |               .map((entry) => ({ startMs: entry.startTime, durationMs: entry.duration })),
  1018 |             undoDepth: history.undoDepth,
  1019 |             mode: hook.backend()!.getStatistics().mode,
  1020 |             lifecycle: hook.backend()!.getStatistics().lifecycle,
  1021 |             recoveryAttempts: hook.backend()!.getStatistics().recoveryAttempts,
  1022 |           };
  1023 |         },
  1024 |         { downMs, upMs, upHandledMs },
  1025 |       );
  1026 |       const samples = state.latencies
  1027 |         .filter((entry) => entry.doneMs !== null && Number.isFinite(entry.doneMs))
  1028 |         .map((entry) => entry.doneMs! - entry.inputMs);
  1029 |       const overlaps = (task: { startMs: number; durationMs: number }) =>
  1030 |         state.isolations.some(
  1031 |           (measure) =>
  1032 |             task.startMs < measure.startMs + measure.durationMs &&
  1033 |             measure.startMs < task.startMs + task.durationMs,
  1034 |         );
  1035 |       // M9-Q3: a long task overlapping the font-load change is flagged, never exempt.
  1036 |       const overlapsFontLoad = (task: { startMs: number; durationMs: number }) =>
  1037 |         state.fontLoadMeasures.some(
  1038 |           (measure) =>
  1039 |             task.startMs < measure.startMs + measure.durationMs &&
  1040 |             measure.startMs < task.startMs + task.durationMs,
  1041 |         );
  1042 |       const longOver50 = state.longTasks.filter((task) => task.durationMs > 50);
  1043 |       const writesDuringPress = state.writes.filter(
  1044 |         (write) => write.startMs > downMs && write.startMs < upHandledMs,
  1045 |       );
  1046 |       const firstAfterUp = state.writes.find((write) => write.startMs >= upHandledMs) ?? null;
  1047 |       const presenceEnd = await presence(page);
  1048 |       const open_ = (entry: (typeof state.latencies)[number]) =>
  1049 |         entry.failed !== true && (entry.doneMs === null || Number.isNaN(entry.doneMs));
  1050 |       // M9-U1: each page error placed against the press and the font-load change (page clock).
  1051 |       const fontStartMs = state.fontLoads[0]?.startMs ?? null;
  1052 |       const pageErrors = probe.pageErrors.map((entry) => ({
  1053 |         ...entry,
  1054 |         sinceDownMs: entry.atMs - downMs,
  1055 |         sinceFontLoadMs: fontStartMs === null ? null : entry.atMs - fontStartMs,
  1056 |       }));
  1057 |       const result = {
  1058 |         ...base,
  1059 |         environment: env,
  1060 |         presence: { start: presenceStart, end: presenceEnd },
  1061 |         errors,
  1062 |         pageErrors,
  1063 |         consoleErrors,
  1064 |         downMs,
  1065 |         upMs,
  1066 |         upHandledMs,
  1067 |         probe,
  1068 |         loadWriteOk,
  1069 |         moves,
  1070 |         expectedMoves: E26_DRIVERS.latencyDurationMs / E26_DRIVERS.latencyCadenceMs,
  1071 |         sentAtMs,
  1072 |         lastOffset: last,
  1073 |         pointerToWorkDoneMs: summary(samples),
  1074 |         boundMs: scenario.latencyBoundMs,
  1075 |         // Not ended and not failed after the settle, claimed by a submission or not.
  1076 |         unresolved: state.latencies.filter(open_).length,
  1077 |         failed: state.latencies.filter((entry) => entry.failed === true).length,
  1078 |         noChange: state.noChangeMoves.length,
  1079 |         longTasksAvailable: state.longTasksAvailable,
  1080 |         longTasksOver50: longOver50.map((task) => ({
  1081 |           ...task,
  1082 |           isolation: overlaps(task),
  1083 |           ...(m9 === undefined ? {} : { fontLoad: overlapsFontLoad(task) }),
  1084 |         })),
  1085 |         ...(m9 === undefined
  1086 |           ? {}
  1087 |           : { layers, fontLoad: { armed: fontLoad, status: fontStatus, loads: state.fontLoads } }),
  1088 |         isolations: state.isolations,
  1089 |         rejections: state.rejections,
  1090 |         writesDuringPress,
  1091 |         firstWriteAfterUpMs: firstAfterUp === null ? null : firstAfterUp.startMs - upHandledMs,
  1092 |         // setStyle (busy only) and the move, each one undo step: the pointer up was applied.
  1093 |         undoDepth: state.undoDepth,
  1094 |         expectedUndoDepth: busy ? 2 : 1,
  1095 |         state,
  1096 |       };
  1097 |       record(slug, result);
  1098 |       expectValidRun(state, {
  1099 |         errors,
  1100 |         expectedDpr: dpr,
  1101 |         pageDpr: env.devicePixelRatio,
  1102 |         start: presenceStart,
  1103 |         end: presenceEnd,
  1104 |       });
  1105 |       expect(loadWriteOk, 'the load write succeeded').toBe(true);
  1106 |       // Canvas presses only (tests/e26/probe.ts): the layer toggles are the only other presses.
  1107 |       expect(probe.downs.length, 'one press').toBe(1);
  1108 |       expect(probe.ups.length, 'one release').toBe(1);
  1109 |       expect(probe.otherDowns, 'presses outside the canvas: the layer toggles').toEqual(
  1110 |         (layers?.expanded ?? []).map((id) => `layer-toggle-${id}`),
  1111 |       );
  1112 |       expect(state.mode).toBe('on-demand');
  1113 |       expect(result.failed).toBe(0);
  1114 |       expect(result.unresolved).toBe(0);
  1115 |       expect(samples.length, 'moves that produced a revision').toBeGreaterThan(0);
> 1116 |       expect(result.undoDepth, 'the release was applied').toBe(result.expectedUndoDepth);
       |                                                           ^ Error: the release was applied
  1117 |       if (busy) expect(result.rejections).toBe(1);
  1118 |       if (layers !== null) expect(layers.rows, 'layer rows shown').toBe(layers.expectedRows);
  1119 |       if (fontLoad !== null) {
  1120 |         expect(state.fontLoads, 'one font-load change').toHaveLength(1);
  1121 |         expect(fontStatus, 'the font-load change loaded').toBe('loaded');
  1122 |         // A real change: the port's generation and the scene revision both advanced.
  1123 |         const [load] = state.fontLoads;
  1124 |         expect(load!.generationAfter!, 'the text port generation advanced').toBeGreaterThan(
  1125 |           load!.generationBefore,
  1126 |         );
  1127 |         expect(load!.revisionAfter!, 'the scene revision advanced').toBeGreaterThan(
  1128 |           load!.revisionBefore,
  1129 |         );
  1130 |       }
  1131 |     });
  1132 |   }
  1133 | }
  1134 | 
  1135 | // E26-U6b (E26-A06): isolation of the M1-A13 page with one and with 16 persistent rejections.
  1136 | const isolationRuns =
  1137 |   filter.length === 0 || filter.some((entry) => E26_ISOLATION.id.startsWith(entry));
  1138 | for (let repetition = 1; isolationRuns && repetition <= repetitions; repetition += 1) {
  1139 |   test(`${E26_ISOLATION.id} r${repetition}`, async ({ page, browser }, testInfo) => {
  1140 |     test.skip(v2Project(testInfo.project.name), 'a v1 scenario: v1 projects only');
  1141 |     test.skip(memoryVariant, 'the memory variant runs the frame runs only');
  1142 |     if (!smoke)
  1143 |       expect(dirty, 'a clean working tree, so the recorded commit is what ran').toBe(false);
  1144 |     const dpr = testInfo.project.use.deviceScaleFactor ?? 1;
  1145 |     const document = loaded(E26_ISOLATION.document);
  1146 |     const targets = isolationTargets(document);
  1147 |     const configuration = {
  1148 |       isolation: E26_ISOLATION,
  1149 |       documentSha256: sha256(canonicalJson(document.generated)),
  1150 |       schemaVersion: document.document.schemaVersion,
  1151 |       sceneNodes: document.projection.nodes.size,
  1152 |       targets,
  1153 |       devicePixelRatio: dpr,
  1154 |       repetitions,
  1155 |     };
  1156 |     const slug = `${testInfo.project.name}--${E26_ISOLATION.id.replace(/[^a-z0-9-]+/gi, '_')}--r${repetition}`;
  1157 |     const { errors, consoleErrors } = await installProbe(page);
  1158 |     await open(page, `doc=${E26_ISOLATION.document}&isolation=1`, errors);
  1159 |     const env = await environment(page);
  1160 |     const start = await presence(page);
  1161 |     const run = await page.evaluate(
  1162 |       async ({ doc, replaceRuns, one, sixteen }) => {
  1163 |         const hook = window.__e26Bench!;
  1164 |         const editor = hook.editor()!;
  1165 |         const backend = hook.backend()!;
  1166 |         const response = await fetch(`/e26-bench-doc.json?doc=${doc}`, { cache: 'no-store' });
  1167 |         const value: unknown = await response.json();
  1168 |         const runStartMs = performance.now();
  1169 |         const settleErrors: string[] = [];
  1170 |         // Each load is one command; the next starts after its frame's work is done.
  1171 |         const settle = async () => {
  1172 |           await new Promise((resolve) => requestAnimationFrame(resolve));
  1173 |           await new Promise((resolve) => requestAnimationFrame(resolve));
  1174 |           await backend.waitForSubmittedWork().catch((error: unknown) => {
  1175 |             settleErrors.push(String(error));
  1176 |           });
  1177 |         };
  1178 |         // The command's own time, and the scene rejections it reported.
  1179 |         const load = () => {
  1180 |           const rejected: string[] = [];
  1181 |           const unsubscribe = editor.subscribe((event) => {
  1182 |             if (event.type === 'diagnostic' && event.code === 'editor.scene-rejected') {
  1183 |               rejected.push(...(event.nodeIds ?? []));
  1184 |             }
  1185 |           });
  1186 |           const start = performance.now();
  1187 |           const result = editor.execute({ type: 'loadDocument', document: value });
  1188 |           const commandMs = performance.now() - start;
  1189 |           unsubscribe();
  1190 |           return {
  1191 |             error: result.ok ? null : (result.code ?? 'failed'),
  1192 |             commandMs,
  1193 |             rejected: [...rejected].sort(),
  1194 |           };
  1195 |         };
  1196 |         const loadErrors: string[] = [];
  1197 |         const replaces: { durationMs: number; nodes: number; status: string; commandMs: number }[] =
  1198 |           [];
  1199 |         for (let i = 0; i < replaceRuns; i += 1) {
  1200 |           const before = hook.replaces.length;
  1201 |           const loaded = load();
  1202 |           if (loaded.error !== null) loadErrors.push(loaded.error);
  1203 |           if (loaded.rejected.length > 0) loadErrors.push(`rejected ${loaded.rejected.join(',')}`);
  1204 |           const sent = hook.replaces.slice(before).filter((entry) => entry.nodes > 0);
  1205 |           replaces.push(
  1206 |             ...sent.map(({ durationMs, nodes, status }) => ({
  1207 |               durationMs,
  1208 |               nodes,
  1209 |               status,
  1210 |               commandMs: loaded.commandMs,
  1211 |             })),
  1212 |           );
  1213 |           await settle();
  1214 |         }
  1215 |         const isolate = async (ids: readonly string[]) => {
  1216 |           const rejections = hook.rejections();
```