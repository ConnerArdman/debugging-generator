/**
 * Build configuration for `@debuggen/local-service`.
 *
 * This workspace is the local coordination process (AAP 0.1.3, 0.7.1 Group 2):
 * the HTTP (hono) and WebSocket (ws) surfaces on `127.0.0.1`, the `node:sqlite`
 * session store, the session state machine, the six-stage pipeline with its
 * versioned prompt files, adapter-driven instrumentation, telemetry ingestion
 * with redaction and correlation, panel generation with validation and
 * fallback, source-open forwarding, the dev-server launcher and end-of-session
 * cleanup.
 *
 * Unlike every `packages/*` sibling, this is an **application**, not a library:
 * nothing imports it, so there are no declarations to emit and no `exports` map
 * to satisfy beyond a single runnable file. What this configuration must put on
 * disk is therefore exactly three paths, and they are contracts written down in
 * four other files:
 *
 *   dist/main.js           dist/main.js.map           dist/store/schema.sql
 *
 * - `package.json` names `dist/main.js` as `main`, as its only `exports`
 *   condition and as the target of `"start": "node dist/main.js"`.
 * - the root `playwright.config.ts` `webServer` entry runs
 *   `node apps/local-service/dist/main.js` from the repository root and waits
 *   for `GET ${serviceUrl}/health` to answer, so both the artefact path and the
 *   health route are immovable: every browser and end-to-end suite starts the
 *   service this way (AAP 0.8.3).
 * - `apps/local-service/src/store/db.ts` resolves the store DDL relative to its
 *   own module URL and, in the bundled layout, that URL is `dist/main.js` — see
 *   the schema asset contract below.
 * - `apps/vscode-extension/esbuild.mjs` performs its *own* full bundle of these
 *   sources into `dist/service/main.js` for the VSIX (AAP 0.7.1 Group 3). It
 *   does not read this file, which is why nothing here may be a precondition
 *   for the service being runnable: the `schema.sql` handling below is a
 *   *layout* guarantee for one of the loader's candidate paths, never the only
 *   way the DDL can be found.
 *
 * ## Why the `@debuggen/*` dependencies stay external
 *
 * The seven workspace packages and the six third-party runtime dependencies are
 * left external (tsup's default for `dependencies`, restated in `external`
 * below), so `dist/main.js` resolves them at run time through the pnpm
 * workspace symlinks in `node_modules`. That is deliberate and it is what makes
 * `pnpm -r build` order load-bearing: the eight packages build first — their
 * `dist/` is what each `exports` map points at — and this workspace builds
 * after them. Inlining them here would produce a second copy of `zod`, of the
 * telemetry event schemas and of the ts-morph-backed patch layer, and would
 * defeat the single-definition rule AAP 0.4.2 states for every cross-process
 * type.
 *
 * The VSIX is the one artefact that *does* want everything in one file, and it
 * gets that from its own esbuild step rather than from a second mode here.
 *
 * ## The `schema.sql` asset contract
 *
 * `src/store/schema.sql` is data, executed verbatim by `node:sqlite`'s
 * `DatabaseSync.exec()`. `src/store/db.ts` finds it by probing, first hit wins:
 *
 *   1. an inlined DDL string passed in by the caller — the packaged-VSIX path,
 *      where `apps/vscode-extension/esbuild.mjs` inlines the file as a string
 *      and no filesystem read happens at all;
 *   2. `new URL('./schema.sql', import.meta.url)` — correct under
 *      `pnpm dev` (`tsx watch src/main.ts`), where that module's URL is
 *      `src/store/db.ts` and the DDL sits beside it;
 *   3. `new URL('./store/schema.sql', import.meta.url)` — correct for the
 *      bundled service, where the whole program has collapsed into
 *      `dist/main.js` and the DDL must therefore sit at `dist/store/schema.sql`.
 *
 * Candidate 3 is this file's responsibility, and the only one: the `onSuccess`
 * hook at the bottom copies the file there byte for byte after every successful
 * build, and refuses to finish the build when the source is missing, is not a
 * regular file, or is empty. A service that starts without its DDL cannot
 * migrate its database, so that failure belongs at build time — named, with the
 * path in the message — rather than at first run, several processes away from
 * the cause.
 *
 * `prompts/**` is deliberately **not** copied. The prompt loader resolves
 * `new URL('../prompts', import.meta.url)`, which points at
 * `apps/local-service/prompts` from `src/**` and from `dist/main.js` alike
 * because both sit exactly one level below the workspace root, and
 * `DEBUGGEN_PROMPTS_DIR` overrides it for the VSIX-embedded copy. A copy under
 * `dist/` would be a second, drifting source of prompt text and would break the
 * AAP 0.5.3 invariant that prompts are versioned repository files.
 *
 * ## Relationship to `tsc -b`
 *
 * `tsconfig.json` is `composite` and `emitDeclarationOnly` and writes into
 * `apps/local-service/.tsbuild`: that is the `pnpm typecheck` gate, not a build.
 * Shipping artefacts come from this file and land in `dist/`, which `.gitignore`
 * and `.prettierignore` both exclude, so the output is regenerated from source
 * on every CI run and never committed. `pnpm verify` runs `pnpm build` before
 * `pnpm typecheck` precisely because the dependencies are resolved through their
 * built `dist/`.
 *
 * ## Determinism
 *
 * Two builds of one commit must produce byte-identical output, so nothing here
 * varies with a clock, a build counter or an ambient variable: no `define`, no
 * `env`, no `banner`, no `shims`, no timestamp and no version stamp. In
 * particular, **no configuration value is baked into the bundle**. Everything
 * the service needs — `DEBUGGEN_HOST`, `DEBUGGEN_PORT`, `DEBUGGEN_HOME`,
 * `DEBUGGEN_PROVIDER`, `DEBUGGEN_MODEL`, `ANTHROPIC_API_KEY`, `DATABASE_URL` —
 * is read from the environment at run time by `src/config.ts`, so only the
 * variable *names* ever appear in `dist/main.js` and a credential can never be
 * compiled in (AAP 0.5.2, 0.5.6).
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsup';

/**
 * Absolute path of this workspace, derived from this module's own URL rather
 * than from `process.cwd()`, so the asset step reads and writes the same two
 * paths however tsup was started.
 *
 * Note the asymmetry it protects against: tsup resolves the `entry` and
 * `tsconfig` options below against the *process* working directory, so the
 * supported invocations are the ones that run with this workspace as their cwd
 * (`pnpm --filter @debuggen/local-service build`, and this workspace's step of
 * `pnpm -r build`). An asset path resolved the same way would silently follow a
 * different cwd — writing into, or reading from, whichever directory the command
 * happened to start in — and that failure would be far harder to read than a
 * missing entry point.
 */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Workspace-relative POSIX path of the store DDL, as authored. */
const SCHEMA_SQL_SOURCE = 'src/store/schema.sql';

/**
 * Workspace-relative POSIX path of the copy the bundled service loads. This is
 * candidate 3 of the probe order documented in the header: `dist/main.js`
 * resolves `new URL('./store/schema.sql', import.meta.url)` to exactly this
 * path, so the `store/` segment is part of the contract and the file must not be
 * flattened into `dist/`.
 */
const SCHEMA_SQL_OUTPUT = 'dist/store/schema.sql';

/**
 * What to do about a missing or unusable DDL, printed with every failure of the
 * asset step so the message is self-diagnosing in a CI log.
 */
const SCHEMA_SQL_HINT = [
  `${SCHEMA_SQL_SOURCE} is the complete data definition of the session store: the`,
  'service executes it verbatim through node:sqlite DatabaseSync.exec() on start-up',
  'and cannot migrate its database without it (AAP 0.4.2). It is authored, not',
  'generated, so restore it from version control rather than regenerating it, then',
  'build again with `pnpm --filter @debuggen/local-service build`.',
  '',
  'It is never substituted with an empty file: an empty DDL would produce a service',
  'that opens a database with no tables and fails on its first query, which is the',
  'one failure mode that looks like a successful build.',
].join('\n');

/**
 * Failure of the store-DDL asset step. A distinct class so the message tsup
 * prints is attributable at a glance: a throw from a function `onSuccess`
 * propagates through tsup 8.5.1's `buildAll()` to the CLI's error handler, which
 * logs `error.stack` and sets a non-zero exit code — which is what fails
 * `pnpm build`, and with it `pnpm verify` and CI.
 *
 * `stack` is replaced with the name and message alone, deliberately. Every
 * condition this class reports is "the DDL this build must copy is not usable",
 * and the message already names the path and what to do about it; the default
 * stack would bury that under frames from inside tsup's own plumbing, in a
 * transpiled copy of this very file whose line numbers mean nothing to a reader.
 * Any *unexpected* error — a permission failure on the write, a full disk — is
 * not a `SchemaAssetError` and keeps its full stack.
 */
class SchemaAssetError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${SCHEMA_SQL_HINT}`);
    this.name = 'SchemaAssetError';
    this.stack = `${this.name}: ${this.message}`;
  }
}

/**
 * Copies `src/store/schema.sql` to `dist/store/schema.sql`, byte for byte.
 *
 * Runs as tsup's `onSuccess` hook, which tsup 8.5.1 invokes after the output
 * directory has been cleaned and after esbuild has written the JavaScript — in
 * that order, verified against its build sequence
 * (clean -> esbuild -> copy public dir -> onSuccess) rather than assumed, since
 * the reverse order would have `clean: true` delete this file on every build. In
 * watch mode the hook runs again after every rebuild, so the copy stays in step
 * with the bundle.
 *
 * `copyFile` rather than read-then-write: the DDL is executed verbatim by
 * SQLite and is read by the store's drift tests, so it must never be
 * transformed, re-encoded, minified or re-indented — not even by a well-meant
 * newline normalisation. The size of the destination is compared with the source
 * afterwards so a truncated write (a full disk) fails here instead of at the
 * service's first start.
 *
 * `dist/store/` is created defensively: esbuild has already made `dist/` by the
 * time this runs, but the subdirectory is this step's own and the hook must not
 * depend on another writer for it.
 */
async function copySchemaSql(): Promise<void> {
  const source = path.join(PACKAGE_DIR, ...SCHEMA_SQL_SOURCE.split('/'));
  const output = path.join(PACKAGE_DIR, ...SCHEMA_SQL_OUTPUT.split('/'));

  // `stat` rather than `existsSync`: it follows symlinks, so a dangling link is
  // reported as missing (its `stat` rejects) and a link to a real file is
  // accepted, which is what `copyFile` would do with it anyway.
  const sourceStats = await stat(source).catch(() => null);

  if (sourceStats === null) {
    throw new SchemaAssetError(`cannot emit ${SCHEMA_SQL_OUTPUT}: ${SCHEMA_SQL_SOURCE} is missing`);
  }

  if (!sourceStats.isFile()) {
    throw new SchemaAssetError(
      `cannot emit ${SCHEMA_SQL_OUTPUT}: ${SCHEMA_SQL_SOURCE} is not a regular file`,
    );
  }

  if (sourceStats.size === 0) {
    throw new SchemaAssetError(`cannot emit ${SCHEMA_SQL_OUTPUT}: ${SCHEMA_SQL_SOURCE} is empty`);
  }

  await mkdir(path.dirname(output), { recursive: true });
  await copyFile(source, output);

  const outputStats = await stat(output);
  if (outputStats.size !== sourceStats.size) {
    throw new SchemaAssetError(
      `emitted ${SCHEMA_SQL_OUTPUT} is ${String(outputStats.size)} bytes, ` +
        `but ${SCHEMA_SQL_SOURCE} is ${String(sourceStats.size)} bytes`,
    );
  }
}

export default defineConfig({
  /**
   * One entry, in the object form, because the key *is* the output basename:
   * this states `dist/main.js` rather than leaving it to be inferred. The array
   * form would derive the name by stripping the longest common directory of the
   * inputs — it agrees for a single entry today and would silently disagree the
   * moment the entry list or the source layout changed, and the drift would not
   * surface here. It would surface as `Cannot find module` from
   * `pnpm --filter @debuggen/local-service start`, from the `webServer` command
   * in `playwright.config.ts` and from `package.json`'s `main` at once.
   *
   * `src/main.ts` is the only entry the service has: it loads the environment,
   * validates configuration, prepares `$DEBUGGEN_HOME`, opens the store, runs
   * modification reconciliation and the retention purge, and then serves HTTP
   * and WebSocket from one Node server. Everything else in `src/**` is reached
   * through imports from there, so the bundle is the whole program.
   */
  entry: {
    main: 'src/main.ts',
  },

  outDir: 'dist',

  /**
   * ESM only, and it is the honest format rather than a preference:
   * `package.json` declares `"type": "module"`, `tsconfig.json` type-checks the
   * program under `module: "NodeNext"` (which is why every relative specifier in
   * `src/**` carries an explicit `.js`), and the artefact is loaded by
   * `node dist/main.js`. A CJS output would additionally break the `import.meta.url`
   * the store's DDL loader and the prompt loader resolve their paths from.
   */
  format: ['esm'],

  /**
   * The Node baseline of this workspace, and the one place where this
   * configuration deliberately differs from the `es2023` of every `packages/*`
   * sibling. Those are libraries that also run in Chrome 153 and in the VS Code
   * webview, so they downlevel to the language edition `tsconfig.base.json`
   * names; this artefact runs on exactly one runtime, the Node 24.21.0 that
   * `package.json` `engines` and `.nvmrc` pin, so naming that runtime lets
   * esbuild leave every construct it implements natively alone. Nothing is
   * transformed that the runtime already understands, which keeps the emitted
   * JavaScript close to the authored source and the sourcemaps below readable
   * when a stack frame has to be read in anger.
   */
  target: 'node24',

  /**
   * A Node process, stated rather than inherited. It is the opposite choice from
   * `packages/protocol` and `packages/telemetry`, which use `neutral` precisely
   * so that a Node builtin cannot be externalised behind their backs: here the
   * builtins are the point. `node:sqlite` is the session store, `node:http`
   * carries both the HTTP and the WebSocket surfaces, `node:fs`/`node:path`
   * own the `$DEBUGGEN_HOME` tree and the file backups, `node:child_process`
   * launches the dev server and `node:crypto` hashes credentials, so esbuild
   * must keep all of them external and must resolve packages through Node's own
   * `main`/`exports` conditions.
   */
  platform: 'node',

  /**
   * No declarations: nothing imports this workspace. `package.json` exposes
   * `dist/main.js` as an executable, not as a module surface, and declares no
   * `types` field, so a `.d.ts` here would be an artefact with no consumer —
   * while costing a full extra TypeScript program per build. The declarations
   * `pnpm typecheck` needs are emitted by `tsc -b` into `.tsbuild/`, from the
   * `composite` + `emitDeclarationOnly` settings in `tsconfig.json`, which is a
   * separate gate with its own output directory.
   *
   * Switching this on would also drag in the `ignoreDeprecations: '6.0'`
   * acknowledgement the sibling libraries carry, because tsup 8.5.1 injects
   * `baseUrl` into its declaration program and TypeScript 6.0.3 rejects that
   * option outright (TS5101). With `dts: false` no such program exists.
   */
  dts: false,

  /**
   * Load-bearing, and the single most consequential line in this file for the
   * running service. tsup 8.5.1 still defaults `removeNodeProtocol` to `true`,
   * which rewrites every `node:x` specifier to a bare `x` and marks it external.
   * For most builtins that is merely untidy; for the two the store depends on it
   * is fatal, because Node exposes them under the prefixed name *only*:
   * `import { DatabaseSync } from 'node:sqlite'` works and
   * `import ... from 'sqlite'` resolves to nothing at all (or, worse, to an
   * unrelated package in `node_modules`). The failure would appear at start-up,
   * inside the bundle, with a specifier that does not exist anywhere in the
   * sources — so the rewrite is switched off and the sources' own specifiers are
   * what the artefact carries. A review greps `dist/main.js` for `"node:sqlite"`
   * to confirm it.
   */
  removeNodeProtocol: false,

  /**
   * External sourcemap beside the bundle, `dist/main.js.map`. The service is the
   * process that reconciles file modifications, revokes credentials and cleans up
   * instrumentation, so a stack frame from it must point at the TypeScript line
   * that wrote the file rather than at a column of a single bundled line. Node
   * reads the map when it is started with `--enable-source-maps`; `pino` records
   * the raw stack either way, and both are useless without it.
   */
  sourcemap: true,

  /**
   * `dist/` is wiped before each build, so a file left behind by an earlier
   * layout — a renamed entry, a removed asset — can never masquerade as a current
   * artefact for `node dist/main.js`. Cleaning is unconditionally safe here
   * because the tsup run is this workspace's only build step (`"build": "tsup"`)
   * and the one thing it writes outside esbuild's control, the DDL copy, is
   * written by `onSuccess` *after* the clean.
   */
  clean: true,

  /**
   * No shared chunks. Chunk names are content-addressed, so splitting would put
   * files in `dist/` whose names nothing states — and the contract this build has
   * to honour is a single loadable file at a single path. It also keeps every
   * `import.meta.url` in the program equal to `dist/main.js`: the store's DDL
   * loader and the prompt loader resolve their paths from that value, and with
   * splitting on, the module that reads it can be emitted into a chunk with a
   * URL of its own.
   */
  splitting: false,

  /**
   * A local developer tool that is never shipped over a network: there is no
   * byte budget to win, and minified output would cost exactly the diagnosis
   * this service exists to support. The one artefact in the repository that is
   * size-sensitive, the VSIX, is produced by `apps/vscode-extension`'s own
   * esbuild step, which makes its own choice.
   */
  minify: false,

  /**
   * Stated rather than inherited. The whole of `src/**` collapses into
   * `dist/main.js`, which is what lets `node dist/main.js` run from the
   * repository root — as `playwright.config.ts` does — with no relative import
   * graph to resolve and no `.js`-suffixed specifier left to satisfy. Only the
   * `external` list below survives as bare specifiers.
   */
  bundle: true,

  /**
   * Resolved relative to this file, so esbuild's transform reads this
   * workspace's own `tsconfig.json`: NodeNext resolution (which is what maps the
   * `.js`-suffixed relative specifiers of `src/**` back to their `.ts` sources),
   * `target: "ES2023"`, and the `types: ["node"]` ambient set. Not the config
   * that happens to sit above the process's working directory.
   *
   * Deliberately NOT set, each for its own reason:
   * - `treeshake`: an application entry has nothing to shake — everything
   *   reachable from `src/main.ts` is code the service runs — so the extra
   *   rollup pass would only add build time, re-append a second
   *   `sourceMappingURL` comment to the output, and put an import kept for its
   *   side effect at the mercy of a purity heuristic.
   * - `noExternal`: see `external` below. Inlining a workspace package would
   *   duplicate a cross-process type definition, which AAP 0.4.2 calls a defect.
   * - `publicDir`: it copies a directory's *contents* into the root of `outDir`,
   *   which would both flatten `store/schema.sql` to `dist/schema.sql` — the path
   *   the loader does not probe — and copy every sibling of the DDL, meaning the
   *   store's TypeScript sources. The `onSuccess` hook copies the one file to the
   *   one path instead.
   * - `shims`: the sources are real ESM and use `import.meta.url` directly; a
   *   `__dirname`/`import.meta.url` shim would rewrite the very expression the
   *   DDL and prompt loaders depend on.
   * - `banner`, `footer`, `define`, `env`: nothing may be injected into this
   *   bundle. Configuration and credentials are read from the environment at run
   *   time by `src/config.ts`, so the artefact stays identical between a
   *   developer's machine, CI and a packaged VSIX (AAP 0.5.6).
   */
  tsconfig: './tsconfig.json',

  /**
   * Every runtime `dependency` of `package.json`, stated explicitly as each
   * `packages/*` sibling states its own. tsup keeps `dependencies` and
   * `peerDependencies` external by default, but that default is derived from the
   * manifest at build time and is therefore not a guarantee this workspace can
   * rely on: a dependency moved between fields — or a future default — would
   * silently start inlining code that must not be inlined. Node builtins need no
   * entry; `platform: 'node'` above already externalises them.
   *
   * The seven `@debuggen/*` packages must stay bare specifiers so they resolve
   * through the pnpm workspace links and their own `exports` maps at run time,
   * which is the same graph `tsconfig.json`'s project references and the
   * topological `pnpm -r build` describe (AAP 0.2.2). That is what keeps one
   * definition of each cross-process shape — the `SourceLocation` schema, the
   * telemetry events, the plans and modification records, the panel
   * specifications, the messages and the session record — shared with the
   * extensions rather than copied into this bundle.
   *
   * Each third-party entry has its own reason to survive as a bare specifier:
   *
   * - `pino` resolves its transports and its worker thread from its own package
   *   directory at run time; a bundled copy cannot find them.
   * - `ws` loads an optional native accelerator (`bufferutil`,
   *   `utf-8-validate`) through a guarded `require`, and its `WebSocketServer`
   *   must be the same class the `@types/ws` declarations describe.
   * - `hono` and `@hono/node-server` ship deep `exports` maps whose conditions
   *   Node applies per subpath; the adapter additionally builds its
   *   Request/Response bridge directly on the `node:http` objects of the server
   *   it creates, so it must be the copy Node loaded, not a rebundled one.
   * - `dotenv` and `zod` are ordinary libraries, and `zod` in particular must be
   *   a single instance in this process: the service parses a model's output
   *   against `@debuggen/panel-schema`'s schemas and then sends the parsed value
   *   through `@debuggen/protocol`'s message schemas, so a second copy compiled
   *   in here would give those layers separate registries of Zod internals and a
   *   valid message could be rejected at the boundary.
   */
  external: [
    '@debuggen/code-analysis',
    '@debuggen/instrumentation',
    '@debuggen/model-provider',
    '@debuggen/panel-schema',
    '@debuggen/protocol',
    '@debuggen/shared',
    '@debuggen/telemetry',
    '@hono/node-server',
    'dotenv',
    'hono',
    'pino',
    'ws',
    'zod',
  ],

  /**
   * The store-DDL asset step: the third candidate of the loader's probe order
   * exists because this hook puts it there. See `copySchemaSql` above for the
   * ordering guarantee it relies on, and the file header for the contract it
   * satisfies.
   */
  onSuccess: copySchemaSql,
});
