/**
 * `@debuggen/shared` — the browser-safe entry of this monorepo's base package.
 *
 * This package is the foundation of the `@debuggen` package graph: every other
 * workspace imports it, and it imports none of them. That one-way direction is
 * what keeps the graph acyclic, and it is why a type several layers need — the
 * source location a runtime item carries and a click-to-source request travels
 * with — is *defined* here rather than imported into here.
 *
 * ## Two entries, deliberately disjoint
 *
 * The package publishes exactly two entries, and the boundary between them is a
 * guarantee rather than a convention:
 *
 * - `"."` — **this file** (`src/index.ts`), and it is **browser-safe**. It
 *   reaches for no platform builtin and no platform-only global, so it can be
 *   bundled into the MAIN-world telemetry agent that is injected into the
 *   inspected page at `document_start`, into the DevTools panel, into the
 *   editor webview and into the component library those two surfaces share —
 *   while remaining loadable, unchanged, by the local service, by the telemetry
 *   preload inside the target project's dev server and by the repository's
 *   command-line scripts.
 * - `"./node"` (the barrel under `src/node`) — **Node-only**. It holds SHA-256
 *   and HMAC-SHA-256 hashing, used to record a file's exact content before it is
 *   instrumented and to key request grouping without retaining the value that
 *   was grouped, plus the hardened `0700`/`0600` filesystem creator that
 *   verifies a parent directory and refuses to follow a symlink at the final
 *   path component. Both need Node's cryptography and filesystem builtins
 *   (`node:crypto`, `node:fs`), which no browser bundle can resolve — hence a
 *   second entry instead of one convenient barrel.
 *
 * A consumer that needs both imports both:
 *
 * @example
 * ```ts
 * import { newSessionId, type Result } from '@debuggen/shared';
 * import { sha256Hex } from '@debuggen/shared/node';
 * ```
 *
 * This file therefore never re-exports the Node entry, however tempting a
 * single import path is: one such re-export would drag a cryptography and a
 * filesystem builtin into the page agent's bundle and break it at
 * `document_start`, where no bundler polyfill is available to cover for it. The
 * sibling `index.test.ts` is the tripwire: it scans the modules in this
 * directory for platform specifiers and asserts that the hashing and
 * filesystem symbols are absent from what this entry exports.
 *
 * ## What lives behind this entry
 *
 * The modules are re-exported below in dependency order, which is also the
 * package's internal layering — `errors` is the root of the module graph,
 * `result` builds on it, and everything else builds on those two:
 *
 * - `errors` — the closed error-code vocabulary and the `DebuggenError` class
 *   that carries one of those codes, a developer-facing hint and diagnostic
 *   details across a process boundary.
 * - `result` — the `Result<T, E>` union with `ok`/`err`, the `isOk`/`isErr`
 *   guards, `map`/`mapErr`/`andThen`, `unwrap`/`unwrapOr`, `tryCatch`,
 *   `fromPromise` and `collect`, for the operations that fail as a matter of
 *   course rather than exceptionally.
 * - `assert` — `assert`, `assertDefined`, `assertNever` and `fail`: invariant
 *   checks that narrow types and throw a coded error, kept in production
 *   builds rather than compiled out of them.
 * - `ids` — the identifier types and their generators: the hexadecimal trace
 *   and span ids the W3C trace-context header requires, the prefixed session,
 *   capture, panel, analysis, modification, action, event, message and producer
 *   ids, and the guards that re-validate a value read back out of the store.
 * - `time` — the epoch-millisecond time base every tier normalises to:
 *   the current time at millisecond and at sub-millisecond precision, the
 *   conversions from a high-resolution tuple and from a page-relative
 *   measurement, rounding, and ISO-8601 formatting in both directions.
 * - `paths` — POSIX-only path handling, deliberately without a platform path
 *   module, plus the containment gate (`isWithin`, `isSafeRelativePath`,
 *   `toProjectRelative`, `resolveWithinProject`) that keeps a path arriving
 *   from another process inside the project root it claims to belong to.
 * - `logger` — the `Logger` interface, its level vocabulary and comparison
 *   helper, a console implementation and a no-op instance, so a library can
 *   log without choosing a logging backend for its host process.
 * - `source-location` — the one definition of the source-location schema and
 *   its inferred type, the shape a runtime item carries so a single click can
 *   open the right file, line and column in the editor.
 *
 * Importing this module has no side effect: every export is a declaration, the
 * package manifest declares `"sideEffects": false`, and nothing here reads an
 * environment variable, mutates a global or performs I/O at load time. A
 * bundler is free to drop whatever a consumer does not use.
 *
 * @packageDocumentation
 */

export * from './errors.js';
export * from './result.js';
export * from './assert.js';
export * from './ids.js';
export * from './time.js';
export * from './paths.js';
export * from './logger.js';
export * from './source-location.js';
