# Document schema v8: one unreleased version for the gap-list items

Status: **ADOPTED 2026-11-12**. Visualization track, shared by items V-31 to V-40 (the ten Figma gap-list features the user asked for on 2026-11-12, "1~10번까지 다 진행해줘"). Owner of the schema-version rule below; each item's contract owns its own fields.

## Rule

- The scaffold PR (#571) introduces schema v8 with exactly v7's shape. `migrateV7toV8` changes only `schemaVersion`.
- Until v8 is released (V-23's alpha publish), the items add their fields to the **unreleased v8** without a further bump, in merge order. A new field is optional on input, and reading an older input, or a v8 input written before the field existed, fills its default.
- An item that must replace a field rather than add one records that exception in its own contract (V-35 replaces `fill` by `fills`). It also keeps reading the old v8 form until release.
- Documents, persistence envelopes and clipboard fragments are written at v8 from the scaffold on. A build from before the scaffold rejects them with `document.unsupported-version`. The project has no released build, so this is accepted.

## Where a field addition goes

Every item that adds a v8 field touches all of these, so no path returns a v8 document without the field:

1. `packages/model/src/types.ts`: the V8 node types.
2. `packages/model/src/parse.ts`: a `Schema` dimension (`none` / `added` / `read`, as `effects` has). Set it to `added` on every schema that reads an older input into v8 (`V2_TO_V7` … `V6_TO_V7` and `V7_TO_V8`) and to `read` on `V8`. Leave it `none` on the schemas that only produce an older version (`migrateV6toV7` and earlier).
3. `packages/model/src/serialize.ts`: the canonical key order.
4. `packages/editor-core/src/clipboard.ts` `readFields`: the default for fragments below v8.
5. Tests: a v7 input still reads (see `tests/unit/v8-schema.test.ts`), and `tests/support/schema-v7.ts`, whose helpers write the latest version.

## Validation

`tests/unit/v8-schema.test.ts` feeds real v7 inputs through `parseDocument`, `validateAnyDocument`, `parseEnvelope` and paste, and checks that `validateDocument` and `validateFragmentTree` reject v7 and 9.
