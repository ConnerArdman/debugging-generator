# Source-map fixtures

Eight hand-authored artifacts — five JavaScript chunks and three `.map` files — that _look_ like the JavaScript chunks and source maps a Next.js dev server serves, paired with the corpus in [`../sample-next-app`](../sample-next-app). Nothing here came out of a bundler: every byte was written by hand and every mapping was computed against the committed bytes. They exist so the three modules under `packages/code-analysis/src/source-map/` — `fetch-map.ts`, `resolver.ts` and `normalize.ts` — can be unit-tested with no dev server, no `next` install and no real network: a test serves this folder over a throwaway `node:http` server bound to `127.0.0.1` and points the module under test at that origin.

Counting this document, the folder holds **nine tracked files, and that is the whole of it**. [The inventory](#the-inventory-nine-files-eight-artifacts-and-this-document) states the set as a count, because three `.map` paths a reader may expect to find here are absent on purpose and their absence is coverage — see [absent by design](#absent-by-design-three-map-paths-that-must-never-exist) before concluding that anything is missing.

This file is documentation of test input. It is not a fixture, no test parses it and nothing imports it. Its job is to spare the next author from decoding VLQ `mappings` by hand — the expectation tables below are the assertions, already decoded.

> The consuming modules did not exist when this folder was committed; `packages/code-analysis/src` was empty. That is deliberate. The fixtures and this contract were authored first so the modules can be written against a fixed, documented input set, and this document is the handoff.

## The inventory: nine files, eight artifacts and this document

| #   | File                                       | Kind          | What it is here for                                                         |
| --- | ------------------------------------------ | ------------- | --------------------------------------------------------------------------- |
| 1   | `webpack-basin-page.js`                    | chunk         | webpack URL form; directive names the same stem                             |
| 2   | `webpack-basin-page.js.map`                | map file      | the map named by file 1's directive; the only map carrying `sourcesContent` |
| 3   | `turbopack-gauge-route.js`                 | chunk         | Turbopack form; directive names the same stem                               |
| 4   | `turbopack-gauge-route.js.map`             | map file      | the map named by file 3's directive; the folder's only **sectioned** map    |
| 5   | `turbopack-station-widget.js`              | chunk         | directive names a **differently hashed** stem                               |
| 6   | `turbopack-station-widget-6f3ad91c.js.map` | map file      | the map named by file 5's directive, reachable through nothing else         |
| 7   | `inline-map-basin-detail.js`               | chunk + map   | the map travels inside the chunk, in a `data:` URI                          |
| 8   | `unmapped-observatory-runtime.js`          | chunk         | no directive at all — the negative case                                     |
| 9   | `README.md`                                | this contract | documentation of test input; no test parses it and nothing imports it       |

**The arithmetic, because it is easy to get wrong.** Five chunks; four of them resolve to a map; but only **three `.map` files**, because the fourth map is embedded in chunk 7 rather than served from a file. Each map file belongs to exactly one chunk, and the gauge pair (3 and 4) is one of those three pairs rather than an addition to a smaller base set. So `5 + 3 + 1 = 9` files is the complete folder, and a count of ten has either counted one pair twice or expected one of the three paths below.

### Absent by design: three `.map` paths that must never exist

| Path that must stay absent            | What its absence covers                                                                                                                     | Why it may not be created                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turbopack-station-widget.js.map`     | the comment-driven pairing of chunk 5: a resolver deriving `<chunk>.js.map` from the chunk's filename must find nothing and fail the lookup | the mismatch is the fixture. A same-stem sibling would let a name-deriving resolver succeed by accident, and `fetch-map.ts` exists precisely not to derive a map name            |
| `inline-map-basin-detail.js.map`      | the inline branch of chunk 7: the payload is decoded in place, with no HTTP request, and a fallback request for this path must find nothing | the map travels inside that chunk. A sibling file would resolve for a module that ignored the `data:` URI and fell back to a fetch, which is the failure this fixture must catch |
| `unmapped-observatory-runtime.js.map` | the negative branch of chunk 8: a chunk with no map at all, so a frame pointing into it comes back unresolved instead of mis-resolved       | absence is that fixture's whole payload. A map here — even a correct one — would delete the only proof that a missing map degrades cleanly rather than being guessed at          |

Adding any of the three raises the file count to ten and deletes the branch it stands for in the same edit. A completeness check that wants a number should assert all four facts together — nine files, five chunks, three map files, these three paths absent — which is what item 1 of the [validation checklist](#validation-checklist) does.

## Why this folder sits beside `sample-next-app` rather than inside it

- A chunk is an HTTP artifact. In production the resolver fetches it from the dev server and it is never part of the indexed project, so placing it in the project tree would misrepresent the input.
- `.next/` is git-ignored, so the realistic in-project location for dev-server output cannot hold a committed fixture at all.
- Keeping `.js` and `.map` artifacts out of `../sample-next-app` keeps them out of the indexer's file set and out of `search/text-search.ts` results, so a fixture can never perturb a corpus assertion.

## Chunk and map pairing

Each row is one branch of `fetch-map.ts`. Do not collapse the set: dropping a row deletes its branch's only coverage, and nothing else in the suite would fail. Five rows, four of which reach a map, but three map files: the fourth map is embedded in its chunk and the fifth row has none, which is why the [inventory](#the-inventory-nine-files-eight-artifacts-and-this-document) is nine files rather than ten.

| Chunk                             | How its map is located                                  | Map file                                   | Branch it covers                                                                        |
| --------------------------------- | ------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `webpack-basin-page.js`           | `sourceMappingURL` comment naming the same stem (l. 52) | `webpack-basin-page.js.map`                | webpack URL form; `sourcesContent` present; carries the one rejectable dependency frame |
| `turbopack-gauge-route.js`        | `sourceMappingURL` comment naming the same stem (l. 74) | `turbopack-gauge-route.js.map`             | **sectioned** map through `AnyMap`; percent-encoded dynamic segment; route-group folder |
| `turbopack-station-widget.js`     | comment naming a **different**, hashed stem (l. 40)     | `turbopack-station-widget-6f3ad91c.js.map` | pairing driven only by the comment, not by the filename; `sourcesContent` absent        |
| `inline-map-basin-detail.js`      | inline `data:` URI (l. 30)                              | — (embedded in the chunk)                  | inline payload, resolved with no HTTP request                                           |
| `unmapped-observatory-runtime.js` | not located — the chunk carries no directive            | —                                          | negative case: no map exists and none may be guessed                                    |

## Coordinate convention

Read this once before using any table below.

- Every **Generated** and **Original** cell is `line:column` in **raw source-map coordinates**, exactly as `originalPositionFor` takes and returns them: **line is 1-based, column is 0-based**.
- `SourceLocation` (AAP §0.2.3) is **1-based in both line and column**, so a resolver returns `column + 1`. That conversion belongs to `resolver.ts`. These fixtures and tables stay in raw coordinates so a test can assert the library's own output without an intervening adjustment.
- `sources[i]` is the index in the map's own `sources` array. For the sectioned map it is the index in the **flattened** array `AnyMap` exposes, not in a section's array.
- `originalPositionFor` returns the **resolved** source URL, with `./` collapsed: the raw entry `webpack://_N_E/./src/lib/http.ts` comes back as `webpack://_N_E/src/lib/http.ts`. Assert against `map.sources[i]` for the raw form and `map.resolvedSources[i]` for what a lookup returns.
- A `name` of `—` means the segment has four fields and carries no `names` index at all, so `originalPositionFor` reports `name: null` for that position. Where a table names a symbol, the segment has five fields and the fifth is that `names` index.
- The **Token at the generated position** column is a reading aid, elided with `…` where the real line is long. It is not a byte-for-byte quotation; the chunk file is.

## `webpack-basin-page.js` → `webpack-basin-page.js.map`

52 lines, directive on line 52. Map `file` is `webpack-basin-page.js`; `names` is `["handleReadoutClick", "fetchGaugeIndex"]`.

| Generated | `sources[i]`               | Original | `name`               | Token at the generated position                      |
| --------- | -------------------------- | -------- | -------------------- | ---------------------------------------------------- |
| `16:6`    | `[2]` react.development.js | `15:0`   | —                    | `const react = __webpack_require__(…)`               |
| `19:6`    | `[0]` GaugeReadout.tsx     | `40:2`   | —                    | `function handleReadoutClick(gaugeId) {`             |
| `19:15`   | `[0]` GaugeReadout.tsx     | `40:8`   | `handleReadoutClick` | the identifier on that same generated line           |
| `20:8`    | `[0]` GaugeReadout.tsx     | `41:4`   | —                    | `const indexRequest = fetch('/api/gauges');`         |
| `37:6`    | `[1]` http.ts              | `21:0`   | —                    | `async function fetchGaugeIndex(request) {`          |
| `37:21`   | `[1]` http.ts              | `21:22`  | `fetchGaugeIndex`    | the identifier on that same generated line           |
| `44:8`    | `[1]` http.ts              | `28:2`   | —                    | `const response = await fetch('/api/gauges', init);` |

Generated line 16 maps into `node_modules` on purpose: it is the frame `normalize.ts` must reject, and it is the reason this fixture — not one of the others — carries three sources.

## `turbopack-gauge-route.js` → `turbopack-gauge-route.js.map` (sectioned)

74 lines, directive on line 74. `offset.line` and `offset.column` are **0-based**, so a section's first generated line is `offset.line + 1` and the generated line you query is `offset.line + <section-local line>`.

| Section | `offset`                  | First generated line | Chunk region                                                 | `names`               |
| ------- | ------------------------- | -------------------- | ------------------------------------------------------------ | --------------------- |
| 0       | `{ line: 0, column: 0 }`  | 1                    | region 1 of 3, the dynamic gauge route handler (l. 6–25)     | `["GET"]`             |
| 1       | `{ line: 26, column: 0 }` | 27                   | region 2 of 3, the basin and station server layer (l. 27–47) | `["summarizeBasin"]`  |
| 2       | `{ line: 48, column: 0 }` | 49                   | region 3 of 3, the basin detail page (l. 49–71)              | `["BasinDetailPage"]` |

Section 0 declares one source, section 1 declares two and section 2 declares one. Flattened through `AnyMap`, `sources` holds those four entries in section sequence and `names` is `["GET", "summarizeBasin", "BasinDetailPage"]`.

| Generated (absolute) | Section · local line | flattened `sources[i]`   | Original | `name`            |
| -------------------- | -------------------- | ------------------------ | -------- | ----------------- |
| `13:21`              | 0 · 13               | `[0]` route.ts           | `65:22`  | `GET`             |
| `14:8`               | 0 · 14               | `[0]` route.ts           | `69:2`   | —                 |
| `15:8`               | 0 · 15               | `[0]` route.ts           | `71:2`   | —                 |
| `40:21`              | 1 · 14               | `[1]` station-service.ts | `88:22`  | `summarizeBasin`  |
| `41:8`               | 1 · 15               | `[1]` station-service.ts | `90:2`   | —                 |
| `45:8`               | 1 · 19               | `[2]` BasinSummary.tsx   | `61:2`   | —                 |
| `59:21`              | 2 · 11               | `[3]` page.tsx           | `58:30`  | `BasinDetailPage` |
| `61:8`               | 2 · 13               | `[3]` page.tsx           | `62:2`   | —                 |
| `66:12`              | 2 · 18               | `[3]` page.tsx           | `69:6`   | —                 |

The `45:8` row is the one that proves flattening: it resolves into section 1's _second_ source, so an implementation that assumes one source per section gets it wrong while every other row still passes.

## `turbopack-station-widget.js` → `turbopack-station-widget-6f3ad91c.js.map`

40 lines, directive on line 40. The map's `file` field is `turbopack-station-widget.js` while its own filename carries a hash suffix, so the directive is the only thing that pairs them — a resolver that derives `<chunk>.js.map` from the chunk name finds nothing here, and `turbopack-station-widget.js.map` must stay absent for exactly that reason (see [absent by design](#absent-by-design-three-map-paths-that-must-never-exist)).

`sources` is `["turbopack:///[project]/src/widgets/GaugeReadout.tsx", "turbopack:///[project]/src/lib/http.ts"]` and `names` is `["handleReadoutClick", "fetchGaugeIndex"]`. The chunk declares the `http.ts` module first (line 6) and `GaugeReadout.tsx` second (line 14), so the first mapped generated line resolves through `sources[1]`; index and declaration sequence deliberately disagree.

| Generated | `sources[i]`           | Original | `name`               | Token at the generated position                                       |
| --------- | ---------------------- | -------- | -------------------- | --------------------------------------------------------------------- |
| `9:6`     | `[1]` http.ts          | `21:7`   | —                    | `async function fetchGaugeIndex() {`                                  |
| `9:21`    | `[1]` http.ts          | `21:22`  | `fetchGaugeIndex`    | the identifier on that same generated line                            |
| `10:8`    | `[1]` http.ts          | `28:2`   | —                    | `const response = await fetch('/api/gauges', { cache: 'no-store' });` |
| `23:8`    | `[0]` GaugeReadout.tsx | `40:2`   | —                    | `const handleReadoutClick = useCallback(async () => {`                |
| `23:14`   | `[0]` GaugeReadout.tsx | `40:8`   | `handleReadoutClick` | the identifier on that same generated line                            |

## `inline-map-basin-detail.js` (map embedded)

30 lines, directive on line 30. `sources` is a single entry and `names` is `["BasinDetailPage"]`.

| Generated | `sources[i]`   | Original | `name`            | Token at the generated position                                       |
| --------- | -------------- | -------- | ----------------- | --------------------------------------------------------------------- |
| `12:21`   | `[0]` page.tsx | `58:30`  | `BasinDetailPage` | `async function BasinDetailPage(props) {`                             |
| `13:8`    | `[0]` page.tsx | `59:2`   | —                 | `const routeParams = await props.params;`                             |
| `15:8`    | `[0]` page.tsx | `62:2`   | —                 | `const gauges = await stationService.summarizeBasin(routeParams.id);` |

## Source URL normalisation

`normalize.ts` turns a `sources` entry into a path relative to the indexed project root. Every entry in this folder must normalise to a path that **really exists** under `../sample-next-app/`; the dependency frame is the single deliberate exception and must be rejected rather than normalised. That cross-folder contract is the load-bearing invariant here, and it is why the corpus is authored first.

| `sources` entry                                                | Expected project-relative path           | Appears in           |
| -------------------------------------------------------------- | ---------------------------------------- | -------------------- |
| `webpack://_N_E/./src/widgets/GaugeReadout.tsx`                | `src/widgets/GaugeReadout.tsx`           | webpack map          |
| `webpack://_N_E/./src/lib/http.ts`                             | `src/lib/http.ts`                        | webpack map          |
| `webpack://_N_E/./node_modules/react/cjs/react.development.js` | **REJECTED (dependency frame)**          | webpack map          |
| `webpack://_N_E/./app/(observatory)/basins/[id]/page.tsx`      | `app/(observatory)/basins/[id]/page.tsx` | inline map           |
| `turbopack:///[project]/app/api/gauges/%5Bid%5D/route.ts`      | `app/api/gauges/[id]/route.ts`           | sectioned, section 0 |
| `turbopack:///[project]/src/lib/station-service.ts`            | `src/lib/station-service.ts`             | sectioned, section 1 |
| `turbopack:///_N_E/src/widgets/BasinSummary.tsx`               | `src/widgets/BasinSummary.tsx`           | sectioned, section 1 |
| `turbopack:///./app/(observatory)/basins/%5Bid%5D/page.tsx`    | `app/(observatory)/basins/[id]/page.tsx` | sectioned, section 2 |
| `turbopack:///[project]/src/widgets/GaugeReadout.tsx`          | `src/widgets/GaugeReadout.tsx`           | station-widget map   |
| `turbopack:///[project]/src/lib/http.ts`                       | `src/lib/http.ts`                        | station-widget map   |

Four prefix forms are exercised: `webpack://<namespace>/` with a `./` prefix, `turbopack:///` with a `[project]/` root marker, `turbopack:///` with an `_N_E/` namespace, and `turbopack:///` with a bare `./`. The last two sources in the table repeat paths that already appear under the webpack scheme, so a test can assert that both schemes converge on the same project-relative path.

**Two bracket conventions, both present on purpose.**

- **Dynamic segments.** webpack keeps the brackets literal — `basins/[id]/page.tsx`. Turbopack percent-encodes them — `gauges/%5Bid%5D/route.ts`. A normaliser must therefore percent-decode, and must not mistake `[id]` for a placeholder to strip.
- **Route groups.** `(observatory)` is literal in **both** schemes and must survive normalisation unchanged. It is a real directory on disk (`../sample-next-app/app/(observatory)/`), so dropping it — as a route-group-aware URL mapper would — yields a path that does not exist.

## `sourcesContent`: present in one map, absent in three

| Map                                        | `sourcesContent`                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `webpack-basin-page.js.map`                | present, three entries: `[0]` 1976 characters, `[1]` 1175 characters, `[2]` **`null`** (the `node_modules` index) |
| `turbopack-gauge-route.js.map`             | absent from every section                                                                                         |
| `turbopack-station-widget-6f3ad91c.js.map` | absent                                                                                                            |
| inline map in `inline-map-basin-detail.js` | absent                                                                                                            |

That split _is_ the coverage. The webpack map exercises the "original content travelled with the map" path, including `sourceContentFor(map, map.resolvedSources[2]) === null`, which means "content withheld for this source" and must not be read as "file missing". The three maps without the field exercise the resolver's fallback of reading the file from the project on disk.

For tests that compare recovered text:

- `sourcesContent[0]` is an exact **prefix** of `../sample-next-app/src/widgets/GaugeReadout.tsx`: 44 of its 69 lines. Both mapped original lines (40 and 41) fall inside the prefix, so embedded content and on-disk content agree at every mapped position.
- `sourcesContent[1]` is **byte-identical** to `../sample-next-app/src/lib/http.ts` (35 lines).

> Do not "helpfully" add `sourcesContent` to the two Turbopack maps or the inline map. One such edit deletes the read-from-disk fallback coverage entirely and no assertion anywhere would report it.

## Sectioned maps: `AnyMap`, never `TraceMap`

`turbopack-gauge-route.js.map` is the only fixture with a `sections` array, so it is this path's only coverage.

- `new AnyMap(raw)` is the correct constructor. In `@jridgewell/trace-mapping` 0.3.31 the canonical export name is `FlattenMap` and `AnyMap` is an alias of it — `AnyMap === FlattenMap` evaluates to `true` — so either name works.
- `new TraceMap(raw)` **throws**, and what it throws in 0.3.31 is worth knowing before writing the assertion: `TypeError: Cannot read properties of undefined (reading 'map')`. The constructor's own guard message — `TraceMap passed sectioned source map, please use FlattenMap export instead` — is unreachable, because `sources.map(…)` runs before the `sections` check and `sources` is `undefined` on a sectioned map. **Assert that it throws, not what the message says**; the message is an implementation detail of the version pinned today.
- `AnyMap` flattens. It concatenates the sections' `sources` and `names` in section sequence and shifts each section's mappings by that section's `offset`, so `decodedMappings` and `originalPositionFor` both work in absolute generated coordinates. Section-local coordinates appear nowhere in its output — they are listed in the table above only so a maintainer can find a segment in the section it was authored in.

## The inline map's payload

The directive on line 30 of `inline-map-basin-detail.js` has the prefix `data:application/json;charset=utf-8;base64,` followed by 256 characters of payload:

```text
eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5saW5lLW1hcC1iYXNpbi1kZXRhaWwuanMiLCJzb3VyY2VzIjpbIndlYnBhY2s6Ly9fTl9FLy4vYXBwLyhvYnNlcnZhdG9yeSkvYmFzaW5zL1tpZF0vcGFnZS50c3giXSwibmFtZXMiOlsiQmFzaW5EZXRhaWxQYWdlIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7OztxQkF5RDhCQTtRQUM1Qjs7UUFHQSJ9
```

Decoded, verbatim — one line, no trailing newline:

```text
{"version":3,"file":"inline-map-basin-detail.js","sources":["webpack://_N_E/./app/(observatory)/basins/[id]/page.tsx"],"names":["BasinDetailPage"],"mappings":";;;;;;;;;;;qBAyD8BA;QAC5B;;QAGA"}
```

This fixture must resolve with **no HTTP request at all**: `fetch-map.ts` reads the payload out of the directive and must not fall back to requesting `inline-map-basin-detail.js.map`, which does not exist and must never be added — a sibling map file would answer that fallback and hide the very mistake this fixture catches.

## The negative case

`unmapped-observatory-runtime.js` is 41 lines and contains **zero** occurrences of the `sourceMappingURL` substring, and no `.map` file accompanies it — not now and not later, because absence is this fixture's entire payload (see [absent by design](#absent-by-design-three-map-paths-that-must-never-exist)). `fetch-map.ts` must report absence cleanly:

- no throw and no rejected promise;
- no request for a guessed `unmapped-observatory-runtime.js.map`, and no request for anything else — a test asserting this counts the requests its loopback server received;
- a result the resolver can act on, meaning "this chunk has no map", so a frame pointing into it is returned unresolved rather than mis-resolved against a neighbouring chunk's map.

## Regenerating a map

The sequence below is mandatory. Taking the steps in any other arrangement silently corrupts every number in this document.

1. **Format the chunk with Prettier first.** These chunks are committed formatted rather than minified, so every generated line and column belongs to Prettier's output. Compute mappings only against bytes that have already been through `prettier --write`.
2. **Compute the mappings against the committed bytes**, by reading the chunk file from disk — never against a draft held inside the generator script.
3. **Round-trip verify, then update this document in the same commit.** Editing one mapped line of a chunk invalidates that chunk's map and its table here in the same breath.

The method needs nothing beyond the dependency the package already pins. `packages/code-analysis/package.json` declares exactly `@debuggen/shared`, `@jridgewell/trace-mapping` 0.3.31 and `ts-morph` 28.0.0, and no development dependencies; that is the whole toolbox for these fixtures.

- Build the map in **decoded** form. `mappings` is an array of generated lines, where index 0 is generated line 1, and each line is an array of segments: `[generatedColumn, sourcesIndex, sourceLine, sourceColumn]`, or `[generatedColumn, sourcesIndex, sourceLine, sourceColumn, namesIndex]` when the segment carries a name. `generatedColumn`, `sourceLine` and `sourceColumn` are all **0-based**, so `sourceLine` is one less than the line number you read in the editor.
- Hand the decoded map to `TraceMap` and take the VLQ string from `encodedMappings`. **Never hand-encode VLQ.** Every `mappings` string in this folder came out of `encodedMappings`, and each one re-encodes to itself byte-for-byte, which is the round-trip check step 3 refers to.
- For the sectioned map, build and encode each section's `map` independently, then assemble the `sections` array with its `offset` values by hand. `AnyMap` reads the assembled document; it does not help produce it.
- Run the generator **from an OS temp directory**, writing its output there and copying the result into place. No script that produces these artifacts belongs in the repository, and nothing under `packages/code-analysis` may be written by one.

Print the package's ESM entry, which is what lets a script outside the repository import it:

```sh
cd packages/code-analysis
node --input-type=module -e "console.log(import.meta.resolve('@jridgewell/trace-mapping'))"
```

Then pass that `file://` URL to the generator:

```js
// $TMPDIR/regen.mjs — reads the repository, writes only to the temp directory.
// Run as: node "$TMPDIR/regen.mjs" '<the file:// URL printed above>' '<absolute path of the chunk>'
const [entry, chunkPath] = process.argv.slice(2);
const { TraceMap, encodedMappings, originalPositionFor } = await import(entry);
const { readFileSync } = await import('node:fs');

const lines = readFileSync(chunkPath, 'utf8').split('\n');
// lines[n] is generated line n + 1; print it while authoring to confirm each segment
// sits on the token you intend rather than on whitespace.

const sources = ['webpack://_N_E/./src/widgets/GaugeReadout.tsx'];
const names = ['handleReadoutClick'];
const decoded = lines.map(() => []);
decoded[18] = [
  [6, 0, 39, 2],
  [15, 0, 39, 8, 0],
]; // generated line 19, columns 6 and 15 -> sources[0] line 40, columns 2 and 8, names[0]

const mappings = encodedMappings(new TraceMap({ version: 3, sources, names, mappings: decoded }));
console.log(mappings);
console.log(
  originalPositionFor(new TraceMap({ version: 3, sources, names, mappings }), {
    line: 19,
    column: 15,
  }),
);
```

## Maintenance rules

- **Nine files, and no tenth map.** The [inventory](#the-inventory-nine-files-eight-artifacts-and-this-document) is the roster: five chunks, three map files, this document. Do not add a fourth `.map` to "complete" the set — the only three paths one could be added at are [absent by design](#absent-by-design-three-map-paths-that-must-never-exist), and each addition deletes a branch. If a completeness pass reports nine of ten, it has counted a chunk/map pair twice; reconcile it against the inventory table rather than by creating a file.
- **No new dependencies.** `@jridgewell/trace-mapping` 0.3.31 is the only tool these fixtures need and it is already a runtime dependency of the package. Do not reach for a second source-map library, a map-generation helper, or a real bundler to maintain them: an added dependency fails the gate, and artifacts produced by a real build are ones nobody can hand-verify against the tables above.
- **Stay out of ignored paths.** Never move these files under `.next/`, `dist/`, `out/`, `coverage/` or `node_modules/`, and never add a `.env` or `.env.*` file here. Those directories are git-ignored and those filenames are rejected outright, so a test reading an untracked fixture would pass on the author's machine for the wrong reason and fail on a fresh clone.
- **Keep the invented vocabulary.** Every name, path and payload in this folder comes from `../sample-next-app`: observatory, basin, gauge, station, reading, drift. Nothing here may name or paraphrase the demo application under `apps/demo-app`. `scripts/check-no-hardcoding.mjs` reads `.md`, `.json` and `.txt` under the product trees as text, and knowledge of that application leaking into a product package is exactly what it fails on. Its defects are documented in `docs/DEMO.md` and nowhere else, this file included.
- **No secrets, and nothing shaped like one.** `scripts/check-secrets.mjs` scans every tracked file here and nothing in this folder is allowlisted. Keep the base64 payload and its decoding inside fenced blocks, never on a line whose preceding name reads as a credential, and add no connection string carrying credentials, no token-shaped string and no key header.
- **Prettier is not waived.** `.prettierignore` exempts build output and generated code, not this tree, and `prettier --check .` is blocking. Commit exactly `prettier --write` output — including its table alignment, which it rewrites on every save.
- **No test files here.** This tree is excluded from `tsc -b` (`packages/code-analysis/tsconfig.json` excludes `test/fixtures/**`), from ESLint (the global ignore `**/test/fixtures/**`) and from Vitest collection (the `code-analysis` project collects only `packages/code-analysis/src/**/*.test.ts`). A file named `*.test.ts` or `*.spec.ts` here would be type-checked by nothing, linted by nothing and run by nothing. Tests live beside the modules they cover.
- **This folder is not the root `tests/fixtures/sample-next-app`.** That separate tree is the Playwright generalization target and the corpus the no-hardcoding gate subtracts from its policy. The two must not be conflated, and nothing here imports from it or refers to it as an input.
- **Fixtures are read-only inputs.** A test that needs to mutate one copies the folder to an OS temp directory first — `cp(source, destination, { recursive: true })` from `node:fs/promises` under `os.tmpdir()` — and works on the copy, so `git status --porcelain packages/code-analysis` stays empty after `pnpm test`. No symlinks and no nested `.git` in this tree.

## Validation checklist

Runnable from the repository root after any change here.

1. The inventory is intact — nine files, five chunks, three map files, three absences: `ls packages/code-analysis/test/fixtures/source-maps | wc -l` prints `9`, the folder's `*.js` glob matches five names and its `*.js.map` glob three, and `ls` finds none of `turbopack-station-widget.js.map`, `inline-map-basin-detail.js.map` or `unmapped-observatory-runtime.js.map`. A pass reporting nine of ten has counted a chunk/map pair twice — the [inventory](#the-inventory-nine-files-eight-artifacts-and-this-document) table is the roster, not an estimate.
2. Nothing in this folder is ignored: `git check-ignore -v packages/code-analysis/test/fixtures/source-maps/*` prints nothing and exits non-zero, which is the pass.
3. Gates are green: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm --filter @debuggen/code-analysis test` (the package-scoped run of the `code-analysis` Vitest project; `pnpm test` runs the whole suite), `pnpm check:secrets` and `pnpm check:no-hardcoding`. Until the first colocated test lands under `packages/code-analysis/src`, that project run exits 1 with `No test files found` — an empty selector, not a failure of anything in this folder.
4. `git status --porcelain packages/code-analysis` is empty after the test run, proving no test wrote into this tree.
5. Parse smoke check: every `.map` here loads — the sectioned one through `AnyMap`, the other two through `TraceMap`, and the inline one after base64-decoding the directive; each `sourceMappingURL` resolves to the map named in the pairing table; `unmapped-observatory-runtime.js` has none.
6. Cross-folder contract: every `sources` entry normalises to a path that exists under `../sample-next-app/`, with `node_modules/react/cjs/react.development.js` the only deliberate exception.
7. Round-trip: re-encoding each map's decoded mappings reproduces the committed `mappings` string byte-for-byte, and every row of every expectation table above still matches what `originalPositionFor` returns.
