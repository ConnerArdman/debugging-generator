# Integration fixtures — `apps/local-service/test/fixtures`

The contract for this folder, for authors and reviewers of the suites under
`apps/local-service/test/integration/`. This folder may not hold a module that could encode these
rules, so this file is where they live.

## Purpose

Committed, read-only inputs for the twelve `local-service-integration` suites: `session-lifecycle`,
`ws-protocol`, `telemetry-ingest`, `pipeline-deterministic`, `cleanup-conflict`, `source-open`,
`panel-fallback`, `panel-data`, `binding`, `followup`, `auth` and `concurrency`. Every file is one
of three things: a payload a suite sends to the in-process service, an expectation a suite asserts
against the service's answer, or the `sample-project/` corpus the service indexes and instruments.

## Invariants

- **Not program files.** `apps/local-service/tsconfig.json` excludes `test/fixtures/**` from the
  typecheck program, and `apps/local-service/vitest.config.ts` (like the root `vitest.config.ts`)
  keeps `test/fixtures/**` and `**/test/fixtures/**` out of collection — the treatment
  `packages/instrumentation/test/fixtures/project-a` gets. So **no `.ts`/`.js` helper, loader,
  builder or barrel may be added here**: it would be neither type-checked nor collected. Suites
  read a file with `node:fs`, `JSON.parse` it and validate the value with the owning zod schema
  (see [File index](#file-index)), which is also what proves a committed fixture still
  matches its schema. Typed builders belong in `apps/local-service/test/integration/`. The
  `.ts`/`.tsx` files under `sample-project/` are target source that no suite imports.
- **Read-only and byte-stable.** No test writes, patches or deletes anything here. A suite that
  needs a mutable project copies `sample-project/` into an `fs.mkdtemp` directory and instruments
  the copy; a suite that needs a modified payload edits an in-memory copy. Instrumentation must be
  reversible and recorded, and these files are its reference state: after `pnpm test:integration`
  the committed bytes and `git status` are unchanged.
- **No secrets, ever.** Every byte must pass `scripts/check-secrets.mjs` (`pnpm check:secrets`),
  which scans every tracked file. Credential-shaped material exists only as sentinels (see
  [Sentinel protocol](#sentinel-protocol)).
- **Formatted.** Nothing here is listed in the root `.prettierignore` (unlike
  `packages/telemetry/test/fixtures/`), so every JSON and Markdown file must satisfy
  `prettier --check .`.

## Shared conventions

| Convention               | Applies to                                                                                       | Rule                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bare JSON array          | the five `telemetry-*.json` batches and `ingest-redaction-input.json`                            | The file is `TelemetryEventIngress[]`. Spread it into `{ events }` for a `telemetry.event` payload or `{ projectRoot, events }` for `POST /telemetry/ingest`; never pass a wrapper to a strict payload schema.                                 |
| Bare authoring payload   | the four `model-output-*.json` files                                                             | The file is exactly what a model stage returns — no envelope, label or expected-result field. A wrapper would make the suite fail on the wrapper, the wrong reason, and a rejection test would then pass vacuously.                            |
| Wrapper with named cases | `ingest-redaction-expected.json`, `panel-data-cases.json`, `panel-data-expected-trace-tree.json` | A JSON object whose `description` names its interpreter and contract, followed by named sections or cases.                                                                                                                                     |
| Time                     | all telemetry                                                                                    | One base epoch, `1789819200000` (`2026-09-19T12:00:00.000Z`). `startTime` is base + a per-event offset, an epoch-millisecond double; `duration` is milliseconds.                                                                               |
| Event ids                | all telemetry                                                                                    | `evt_` + two-letter batch tag + 14 zero-padded digits: 16 characters after the prefix, the shape `@debuggen/shared` mints. Lexicographic order equals emission order because `id` is the stable secondary sort key of every panel-data source. |
| Producer ids and `seq`   | all telemetry                                                                                    | `prd_browser…` / `prd_server…` + the zero-padded batch ordinal, 16 characters after the prefix. `seq` runs from 1 per producer without gaps.                                                                                                   |
| Span ids                 | all telemetry                                                                                    | 16 hex characters; each batch owns one block, named by its first non-zero hex digit (see [Id registry](#id-registry)).                                                                                                                         |
| Ingestion                | `panel-data-cases.json`                                                                          | A fixture is ingested at most once per store: the store refuses an event id already stored under another session. Two cases' `ingest` lists are either identical (one shared capture) or disjoint.                                             |

## Ingress-only rule

The telemetry batches are `TelemetryEventIngress`, owned by `packages/telemetry/src/schema/event.ts`
(`telemetryEventIngressSchema`, a strict object). They never carry `sessionId`, `captureId` or
`ingestSeq` (assigned by the service at ingest), a `request_key` attribute (computed at ingest from
the unredacted URL) or the correlator's orphan flags `orphaned` / `orphanedParentSpanId` (set during
correlation). The strict schema rejects any of them. A deliberate orphan is an ordinary event whose
`parentSpanId` names a span no batch contains.

## Id registry

Every id below is taken. A new fixture picks values outside this table.

| Tag  | Fixture                                    | `traceId`                          | Span block · ids                            | Producer ids                                   | Events |
| ---- | ------------------------------------------ | ---------------------------------- | ------------------------------------------- | ---------------------------------------------- | -----: |
| `ct` | `telemetry-trace-cross-tier.json`          | `7f2a4c6e8b0d1f3a5c7e9b0d2f4a6c8e` | `a` · `0000000000000a01`–`0000000000000a09` | `prd_browser000000001`, `prd_server0000000001` |      9 |
| `rs` | `telemetry-renders-state.json`             | `1c3e5a7092b4d6f81a3c5e709b2d4f68` | `b` · `0000000000000b01`–`0000000000000b22` | `prd_browser000000002`                         |     34 |
| `rq` | `telemetry-requests-queries.json`          | `2d4f608a1c3e5709b2d4f6081a3c5e70` | `c` · `0000000000000c01`–`0000000000000c0f` | `prd_browser000000003`, `prd_server0000000003` |     15 |
| `pe` | `telemetry-perf-errors.json`               | `3e5a7c9e0b2d4f6a8c0e2a4c6e8a0c2e` | `d` · `0000000000000d01`–`0000000000000d0b` | `prd_browser000000004`, `prd_server0000000004` |     11 |
| `vl` | `telemetry-volume-paging.json`             | `4a6c8e0a2c4e6a8c0e2a4c6e8a0c2e4a` | `e` · `0000000000e00001`–`0000000000e00220` | `prd_browser000000005`                         |    220 |
| `rx` | `ingest-redaction-input.json`              | `5b7d9f0a2c4e6a8c0e2a4c6e8a0c2e5b` | `f` · `0000000000000f01`–`0000000000000f0e` | `prd_browser000000006`, `prd_server0000000006` |     14 |
| `zz` | `model-output-panel-semantic-invalid.json` | `9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a` | —                                           | —                                              |      — |

Reserved values that must never be ingested, because a test depends on their absence:

- `evt_zz00000000000001`–`evt_zz00000000000003` and trace `9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a` —
  the evidence and trace filter that `model-output-panel-semantic-invalid.json` cites.
- Span `0000000000000aff` — the missing parent of the orphan `evt_ct00000000000009`.
- Trace `ffffffffffffffffffffffffffffffff` — the unknown-trace probe of the
  `panel-data-cases.json` case `events-empty-unknown-trace`.

Next free values: the hex letters `a`–`f` are all taken, so the next span block is a digit
(`1`–`9`) in the same position; the next producer ordinal is `7`.

## File index

| File                                       | Contents                                                                                                                                                                                                                               | Consumer suite(s)                                                                                                                            | Validated by                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry-trace-cross-tier.json`          | One trace across three tiers: interaction → `fetch` → `http.server` → `route.handler` → `function` → `db.query`, an `async-continuation` render, a commit, and an orphan `db.query`.                                                   | `panel-data` (with `panel-data-expected-trace-tree.json`); `panel-fallback` (the capture `model-output-valid-panel.json` is checked against) | `telemetryEventIngressSchema`, `packages/telemetry/src/schema/event.ts`                                                                                                                        |
| `telemetry-renders-state.json`             | Browser only: 1 interaction, 3 commits, 25 renders covering every trigger class (`props`, `state`, `context`, `unchanged`, `unknown`), 5 state transitions and one component-tree snapshot.                                            | `panel-data`                                                                                                                                 | same                                                                                                                                                                                           |
| `telemetry-requests-queries.json`          | 4 byte-identical same-parameter `fetch`es with distinct-parameter controls, 1 `xhr`, 1 outbound `http.client`, 5 `db.query` spans.                                                                                                     | `panel-data`                                                                                                                                 | same                                                                                                                                                                                           |
| `telemetry-perf-errors.json`               | Navigation, 2 resource entries, 3 long tasks, 2 browser errors, 1 `server.error`, 1 `fetch`.                                                                                                                                           | `panel-data`                                                                                                                                 | same                                                                                                                                                                                           |
| `telemetry-volume-paging.json`             | One interaction root with 219 `perf.entry` children, including a 10-way `startTime` tie and a 10-way `duration` tie.                                                                                                                   | `panel-data` (paging, limits, stable tie ordering)                                                                                           | same                                                                                                                                                                                           |
| `ingest-redaction-input.json`              | 14 events carrying 12 sentinels in headers, query strings, SQL, prop and state previews and log attributes, plus body and row attributes that must be dropped.                                                                         | `telemetry-ingest`                                                                                                                           | same; parses before sentinel substitution                                                                                                                                                      |
| `ingest-redaction-expected.json`           | `markers`, `sentinels`, per-event `events` expectations and `requestKeyGroups` for the batch above.                                                                                                                                    | `telemetry-ingest`                                                                                                                           | interpreted by the suite; `markers` asserted against `packages/telemetry/src/redaction/rules.ts` and `packages/telemetry/src/schema/attributes.ts`                                             |
| `model-output-invalid-plan.json`           | Plan authoring payload: one target without `symbol`, one with the unknown type `sql-trace`, one whose `file` leaves the project root.                                                                                                  | `pipeline-deterministic` (rejection → runtime-only default plan)                                                                             | `instrumentationPlanInputSchema`, `packages/instrumentation/src/schema/plan.ts` — must fail                                                                                                    |
| `model-output-invalid-panel.json`          | Panel authoring payload: unknown node type `heatmap`, a `table` reading the unknown source `logs`, an unknown metric id, a `sourceLink` carrying a `source`.                                                                           | `panel-fallback`                                                                                                                             | `panelSpecInputSchema`, `packages/panel-schema/src/input.ts` — must fail                                                                                                                       |
| `model-output-valid-panel.json`            | Panel authoring payload in the string-`summary` form: metric cards, a timeline over the `ct` trace, a section with a span table and a query table, a source link.                                                                      | `panel-fallback`                                                                                                                             | `panelSpecInputSchema`, then normalization and semantic validation against a capture holding `telemetry-trace-cross-tier.json` — must pass                                                     |
| `model-output-panel-semantic-invalid.json` | Schema-valid panel in the object-`summary` form whose evidence ids and trace filter exist in no capture.                                                                                                                               | `panel-fallback`                                                                                                                             | passes `panelSpecInputSchema`; must fail `packages/panel-schema/src/semantic.ts`                                                                                                               |
| `panel-data-cases.json`                    | 29 table-driven cases for `POST /sessions/:id/panel-data`, with `constants`, `caseFields` and the closed `vocabulary`.                                                                                                                 | `panel-data`                                                                                                                                 | each `query` by `panelDataRequestSchema`, `packages/protocol/src/http.ts` (the one `surface: "resolver"` case must be refused); `constants` against `packages/panel-schema/src/nodes/query.ts` |
| `panel-data-expected-trace-tree.json`      | The full expected `trace` result for batch `ct`: result keys, node count, root, depth-first pre-order, nested tree and orphan placement.                                                                                               | `panel-data` (`deferTo` of case `trace-cross-tier`)                                                                                          | the response by `packages/protocol/src/http.ts`                                                                                                                                                |
| `sample-project/**`                        | The instrumentation-target corpus (see [below](#the-sample-project-corpus)). Every `source.file` in the five `telemetry-*.json` batches resolves to a file in it; `ingest-redaction-input.json` exercises redaction only and does not. | every suite that creates a session; patched by `session-lifecycle`, `cleanup-conflict` and `followup`; resolved against by `source-open`     | indexed by `@debuggen/code-analysis`, patched by `@debuggen/instrumentation`                                                                                                                   |

## Sentinel protocol

`ingest-redaction-input.json` holds no sensitive material. Every sensitive slot holds a
`{{UPPER_SNAKE}}` token, and the suite, in an in-memory copy of the parsed batch, replaces each
token with a value it assembles at runtime **from fragments it owns**, so no complete credential
exists in any committed file. `ingest-redaction-expected.json` then drives the assertions:

- `sentinels[]` maps each token to `ruleId`, the deny-list rule the substituted material must match
  (`null` only where removal is positional and holds for any material), and `expect`, the class the
  slot collapses to: `marker`, `mask` or `scrubbed`.
- `markers` records the replacement strings and the preview length; the suite asserts they equal
  the constants exported by `packages/telemetry/src/redaction/rules.ts` and
  `packages/telemetry/src/schema/attributes.ts`, so a changed constant fails loudly.
- `requestKeyGroups` records only equality relations (`mustGroup`, `mustNotGroup`): the per-session
  HMAC key is random, so a literal digest would be meaningless.

The split that trips people up: values that would _look_ sensitive are sentinels, while values
that merely need _masking for display_ — benign trail slugs in query strings, benign inline SQL
literals — are written literally. `request_key` is computed from the **unredacted** URL, so
pre-masking those values would make distinct requests collide and silently void the
duplicate-detection assertion.

Describe a new sentinel's material in words (for example "a provider-key-prefixed string"). Never
commit an example value or fragments a reader could join into one.

## Expectation vocabularies

Both vocabularies are closed: a key outside the list is a defect in the fixture.

**`ingest-redaction-expected.json`**

| Level                 | Keys                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `events[]` entry      | `id`, `redactedMarker`, `attributes`, `absentAttributes` (keys that must not exist on the redacted event)          |
| `attributes[].expect` | exactly one of `equals`, `marker`, `mask`, `unchanged`, `maxLength`, `excludesSubstitutedSentinel`, `elementCount` |
| `sentinels[].expect`  | `marker`, `mask`, `scrubbed`                                                                                       |

**`panel-data-cases.json`** — `expect` keys, each defined in the file's own `vocabulary` object:
`paged`, `total`, `count`, `hasNextOffset`, `nextOffset`, `firstId`, `lastId`, `orderedIds`,
`groups`, `values`, `nodeCount`, `maxDepth`, `origin`, `nodeKinds`, `deferTo`.

Two rules bite:

- `hasNextOffset: false` means `nextOffset` is **present and `null`**, never absent: protocol's
  `dataPageShape` (`packages/protocol/src/http.ts`) declares it required and nullable, and `null`
  marks the last page.
- The object-valued sources `trace`, `componentTree` and `graph` (`paged: false`) carry **no paging
  envelope**: `total`, `limit`, `offset` and `nextOffset` are all absent.

Every case carries a `derivation` sentence stating how each expected value follows from the
ingested fixtures and the documented resolver contract. A mismatch with the running service is a
finding against the service; a fixture must never be fitted to a buggy implementation.

## The `sample-project` corpus

- **What it is.** `fixture-trailhead-guide`, a small App-Router-shaped Next.js target: a root
  layout and page, one route handler (`app/api/trail-report/route.ts`), three components, a
  provider, a `pg` pool and one service module, with its own standalone `tsconfig.json`
  (`noEmit`, `jsx: "preserve"`, `@/*` paths). It sits outside the pnpm workspace globs (`apps/*`
  and `packages/*` match direct children only), declares a foreign `packageManager`, and is never
  installed or run; `next.config.mjs` exists only as a framework-detection signal.
- **Why self-contained.** The `local-service-integration` project must not depend on the root
  `tests/fixtures/sample-next-app`, which belongs to the Playwright generalization run; a suite may
  accept that path only as an optional override.
- **How to use it.** Copy it into an `fs.mkdtemp` directory before indexing or instrumenting it. The
  real installer patches files and the real cleanup restores them; neither may touch the committed
  corpus.
- **Vocabulary.** Its identifiers come from a trail-conditions domain and share no application
  name with `apps/demo-app`, `packages/instrumentation/test/fixtures/project-a` or
  `packages/code-analysis/test/fixtures/sample-next-app`; overlaps are limited to React, DOM and
  `pg` platform names. This is the generalization requirement of AAP §0.5.4 and §0.8.4 — a suite
  passing here proves the pipeline found its evidence without demo knowledge — not decoration.

## What is deliberately not here

- **Recorded model responses.** AAP §0.2.5 ships none. The `model-output-*.json` files are
  _authored_ valid and invalid inputs for the validation and rejection paths, not recordings.
- **Byte-level-malformed payloads.** `prettier --check .` parses every committed JSON file, so an
  undecodable WebSocket frame is built as a string at runtime by `ws-protocol.test.ts`.
- **Session, analysis or panel output records.** The real pipeline produces them under
  `DEBUGGEN_PROVIDER=deterministic`.
- **A `.env` file or credential of any kind.**

## Adding a fixture

1. Take an unused `traceId`, span-id block, batch tag and producer ordinal from the
   [Id registry](#id-registry), and add the new row there.
2. Keep the [ingress-only rule](#ingress-only-rule): no service-assigned field, no orphan flag, no
   `request_key`.
3. Derive every expectation from the fixture bytes and the documented contract, and record how
   (a `derivation` sentence for a panel-data case).
4. Keep the trail-domain vocabulary; never borrow a name from `apps/demo-app`.
5. Validate: the file parses, the owning zod schema accepts (or, for a rejection fixture, refuses)
   it, and `pnpm check:secrets` and `prettier --check` both pass.
