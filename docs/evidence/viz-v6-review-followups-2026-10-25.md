# V-6: V-1 and V-3 review follow-ups (2026-10-25)

Visualization track, Light tier. Code follow-ups from the [R0 review closeout](r0-review-closeout-2026-10-23.md) (V-1 follow-ups 2 to 4, V-3 follow-ups 1 and 5). Functional evidence only; precision stays UNVERIFIED. No package, shared surface, threshold or acceptance criterion changes.

| Follow-up | Change |
| --- | --- |
| V-1 #2, status crediting | The page feeds the target-status tracker the editor's applied states (`AppearanceEditor.applied`) instead of the queued ones. Notices are emitted synchronously right after the prepare that built them (`webgpu-backend.ts`, `#emitPathMeshNotices`), so a notice is filed under the key the renderer had when it built the mesh, not under a newer queued edit. |
| V-1 #3, zoom clear | `TargetStatusTracker.zoomChanged` drops every state-failure record of a paint, not only the latest notice. Section 3.4 clears state failures at the next zoom-bucket or port change; the page calls `zoomChanged` on any zoom change, which predates V-6 and is covered by the "may have cleared" label. |
| V-1 #4, field validity | A successful commit from a slider or its number field clears `aria-invalid` and the message on both fields of the pair (width, miter limit, opacity). |
| V-3 #1, R2 mesh gate | R2 gates the path-mesh `entries` and `bytes` after the loss window against the no-loss E state, and records both as `observed.r2.meshCache`. |
| V-3 #5, delta assert | The spec's `delta()` throws when either snapshot's `pathMesh` is null, so a missing pipeline cannot pass a `[0, 0]` prediction. |

Tests: two unit tests (crediting through the page wiring; zoom clears every state failure) and a V-1 GPU spec step in a6 (a width-slider commit clears the number field's `aria-invalid` and message). Independent review: READY WITH FOLLOW-UPS, follow-ups 1 to 3 applied; follow-up 4 (the opacity slider's `input` does not mirror into its number field) predates V-6 and stays as is. Validation is in the PR. The headed V-1 and V-3 specs run on the user's PC after the V-4 VZ4-U3 headed run; until then they are NOT RUN.
