/**
 * The Node-only half of `@debuggen/shared`: the parts of the foundation package
 * that a page cannot provide.
 *
 * This module is the barrel behind the package's second export condition. A
 * consumer reaches it as `@debuggen/shared/node`, which the `exports` map in
 * `packages/shared/package.json` resolves to `dist/node/index.js` — the output
 * of the second of the two fixed entries declared in
 * `packages/shared/tsup.config.ts`. The path is part of that contract rather
 * than a convention: tsup derives each output path from its entry key, and the
 * `exports` map names `dist/node/index.js` literally, so moving or renaming
 * this file changes a published path and every Node-side workspace stops
 * resolving the package's second entry.
 *
 * ## Why the package has two entries
 *
 * The root entry (`.`) is bundled into a page. It is imported by the MAIN-world
 * telemetry agent — injected at `document_start`, before the framework under
 * observation loads — by the design-system renderer, by the browser extension's
 * panel and by the editor's webview. None of those can resolve a `node:`
 * specifier: the agent is a standalone bundle with no module loader or polyfill
 * layer behind it at runtime, so a single `node:crypto` or `node:fs` edge
 * reaching the root entry breaks that bundle outright instead of degrading it.
 * The root entry therefore stays browser-safe, and everything that needs a
 * runtime builtin lives here, one export condition further along, where only
 * Node ever loads it.
 *
 * ## What is behind `./node`
 *
 * - `./hash.js` — SHA-256 over text, bytes or a file, one framed digest over an
 *   ordered list of parts, and keyed HMAC-SHA256. These are the digests the
 *   product persists and compares: the recorded hashes that make a reversible
 *   source edit provably reversible, the stored form of a credential or a
 *   one-time code, the static-analysis cache key, and the keyed identity that
 *   lets two byte-identical requests be recognised as the same request.
 * - `./safe-fs.js` — the hardened filesystem creator: `0700` directories and
 *   `0600` files for the product's own state directory, ownership and
 *   permission checks on every parent, a refusal to follow a symlink planted at
 *   a path it was asked to create, and atomic mode-preserving replacement of a
 *   file inside a developer's project.
 *
 * ## The rule for consumers
 *
 * The two entries are disjoint, and this barrel deliberately never re-exports
 * the root one. A module that needs both sides imports both:
 *
 * ```ts
 * import { tryCatch, type Result } from '@debuggen/shared';
 * import { sha256OfFileSync } from '@debuggen/shared/node';
 * ```
 *
 * Folding the root barrel in here "so consumers only need one import" would
 * copy every browser-safe symbol into the Node bundle as well, leaving the
 * monorepo with two independently reachable copies of one set of types and the
 * boundary above with no meaning. Two import statements are the cheaper half of
 * that trade.
 *
 * ## How the boundary is enforced
 *
 * The sibling entry-boundary test (`packages/shared/src/index.test.ts`) is the
 * tripwire, in both directions. It statically scans the non-test modules
 * directly under `src`, excluding `src/node`, for a `node:` specifier or a
 * `require(` call; it asserts that `src/index.ts` carries no re-export of
 * anything under `./node/`; and it asserts that the root barrel exports none of
 * this entry's symbols — among them `sha256Hex`, `stableHash`,
 * `hmacSha256Hex`, `createFileExclusive`, `atomicReplaceFile` and
 * `SECURE_FILE_MODE`. A convenience re-export added on either side of the
 * boundary fails that test instead of reaching a page.
 *
 * ## Shape of this module
 *
 * Two re-exports and nothing else: no default export, no wrapper, no
 * re-declared type, no version constant, and no work at load time — importing
 * this barrel opens no file, reads no environment variable and touches no
 * global. Deciding *where* the product's state directory lives belongs to the
 * service's configuration module, which reads the environment and passes the
 * resulting paths in. `export *` is used rather than a hand-listed set because
 * it forwards values and types alike and cannot drift as the two modules behind
 * it evolve; a type that ever needs forwarding on its own would be written as
 * `export type { … }`, which `verbatimModuleSyntax` and `isolatedModules`
 * require. Every relative specifier carries an explicit `.js` extension, as
 * NodeNext resolution demands.
 */

export * from './hash.js';
export * from './safe-fs.js';
