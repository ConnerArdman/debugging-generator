/**
 * `clean-clone` — the clean-checkout ordering proof (AAP §0.7.1 Group 5, §0.8.5).
 *
 * AAP §0.7.1 Group 5 requires this spec by name: it "clones the repository into a temp
 * directory and runs `pnpm install --frozen-lockfile && pnpm build` and, in a second fresh
 * clone, `pnpm install --frozen-lockfile && pnpm typecheck`, proving both orderings work
 * standalone". Both orderings rest on the same prerequisite — the demo's generated Prisma
 * client, which the root `build` (`pnpm demo:generate && pnpm -r build`) and `typecheck`
 * (`pnpm demo:generate && tsc -b`) scripts each produce first — and the second clone is what
 * proves `typecheck` does not secretly depend on `build` having run. One clone run twice would
 * prove nothing, so there are two, created independently and checked to share nothing.
 *
 * ## What a "clone" is here
 *
 * The working-tree content of every tracked file, copied by `copyTrackedTree()`
 * (`./helpers/repo`), which enumerates paths with `git ls-files -z` and never creates, reads,
 * copies or archives `.git/`. That is not a convenience: the repository's `origin` URL embeds a
 * live access token (AAP §0.2.1), so a real `git clone` — or any copy of `.git` — could carry
 * it into build logs, caches or the uploaded Playwright report. Starting from the tracked files
 * is exactly what a fresh checkout contains, minus the repository metadata; each clone is
 * asserted to hold no `.git` at all, which is the "no dependence on the remote" guarantee
 * stated as a test. This spec runs no `git remote`/`git config` (`runGit` refuses both) and
 * never prints an environment.
 *
 * ## What each clone proves
 *
 * - **clone-1 — install, then build.** Every artefact the rest of the suite depends on exists
 *   and is non-empty: the service bundle, the unpacked Chrome extension, the browser agent and
 *   Node preload, the prebuild copy of the agent (so `@debuggen/telemetry` built before the
 *   extension), every `dist/` target the workspaces' `exports`/`main` fields name, the Next.js
 *   build of the demo, and the generated Prisma client (so `demo:generate` ran first).
 * - **clone-2 — install, then typecheck, and nothing else.** `pnpm typecheck` exits 0 while no
 *   workspace has a `dist/`, no `.next/` and no copied agent exist — so it needed only `prisma
 *   generate`, whose client it produced — and the solution build wrote its `.tsbuild/`
 *   declarations. Cross-package types resolve on such a tree through the second entry of each
 *   package's `types` fallback array (`["./dist/…d.ts", "./src/…ts"]`), which `tsc -b` redirects
 *   to the referenced project's own declarations.
 * - **both** — `--frozen-lockfile` was honoured: the copied `pnpm-lock.yaml` is byte-identical
 *   to the checkout's before install and unchanged after every command, so a stale committed
 *   lockfile fails here rather than being silently rewritten.
 *
 * ## What this spec deliberately does NOT run inside the clones
 *
 * `pnpm test`, `lint`, `format:check` and the guard scripts (`check:secrets`,
 * `check:no-hardcoding`, `check:no-residual-instrumentation`). Those gates run on the real
 * checkout in CI's `verify` job; the clones have no `.git`, and `check-secrets` and
 * `check-no-residual-instrumentation` enumerate content with git, so they cannot work there.
 * Do not "improve" this spec by adding them — it would fail for a reason unrelated to the
 * orderings it exists to prove.
 *
 * ## Cost, environment and the local escape hatch
 *
 * Two installs, a full monorepo build and a solution-wide typecheck. The installs need registry
 * access; with a warm pnpm content-addressable store (CI's cache, or a developer machine that
 * has installed this lockfile before) packages are linked rather than downloaded, which turns
 * tens of minutes into a few. Every command streams its output line by line, prefixed with the
 * clone and the command, plus a heartbeat every 30 s (`runCommand` in `./helpers/repo`), so a
 * quiet install is never mistaken for a hang; each full log is attached to the Playwright
 * report (`playwright-report/`, git-ignored).
 *
 * The children inherit only `sanitizedEnv()`'s allowlist — no `NODE_OPTIONS` (the e2e run may
 * carry the telemetry `--import` preload, which would silently instrument a clone build), no
 * `DEBUGGEN_*`, no model key, nothing credential-shaped — plus `CI=1`, the credential-free
 * `DATABASE_URL` placeholder CI's `verify` job uses (`prisma.config.ts` resolves the variable;
 * nothing here connects to a database) and `NEXT_TELEMETRY_DISABLED=1`. A probe asserts that
 * environment from inside a child before anything else runs.
 *
 * The spec runs by default. Locally only, `DEBUGGEN_SKIP_CLEAN_CLONE=1` skips it with a
 * reported reason; under `CI` it can never be skipped.
 *
 * Nothing is written inside the checkout: both clones live under `os.tmpdir()` (created with
 * `fs.mkdtemp`) and are removed in `afterAll`, so sibling specs' `git status` assertions are
 * unaffected.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BUILD_TIMEOUT_MS,
  CommandFailedError,
  INSTALL_TIMEOUT_MS,
  SHORT_COMMAND_TIMEOUT_MS,
  TYPECHECK_TIMEOUT_MS,
  copyTrackedTree,
  expect,
  listTrackedFiles,
  repoPath,
  repoRoot,
  runCommand,
  runPnpm,
  test,
} from './helpers/fixtures';
import type { CommandResult, CopyTrackedTreeResult } from './helpers/fixtures';

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------

/** `fs.mkdtemp` prefix of both clones, under `os.tmpdir()`. */
const CLONE_DIR_PREFIX = 'debuggen-clean-clone-';

/**
 * The credential-free placeholder CI's `verify` job exports (AAP §0.7.1 Group 0). It carries no
 * user and no password, so `pnpm check:secrets` has nothing to find, and it is only ever passed
 * in a child's environment — never written to a file. `prisma generate` and `next build` read
 * the variable's presence; neither opens a connection (every demo page is `force-dynamic`).
 */
const DATABASE_URL_PLACEHOLDER = 'postgresql://localhost:5432/placeholder';

/**
 * The deliberate values every clone command runs with, merged by `sanitizedEnv()` over its
 * allowlist. Everything else a child sees is inherited from that allowlist only.
 */
const CLONE_COMMAND_ENV: Readonly<Record<string, string>> = Object.freeze({
  CI: '1',
  DATABASE_URL: DATABASE_URL_PLACEHOLDER,
  NEXT_TELEMETRY_DISABLED: '1',
});

/**
 * Copying ~900 tracked files, the environment probe, the artefact checks and the log
 * attachments of one clone — everything in a test except its two long commands.
 */
const SETUP_ALLOWANCE_MS = 5 * 60_000;

/** clone-1's whole budget: the two command budgets of `./helpers/repo` plus setup. */
const BUILD_ORDERING_TIMEOUT_MS = INSTALL_TIMEOUT_MS + BUILD_TIMEOUT_MS + SETUP_ALLOWANCE_MS;

/** clone-2's whole budget: the two command budgets of `./helpers/repo` plus setup. */
const TYPECHECK_ORDERING_TIMEOUT_MS =
  INSTALL_TIMEOUT_MS + TYPECHECK_TIMEOUT_MS + SETUP_ALLOWANCE_MS;

/** Removing two trees that each hold a linked `node_modules/` and build output. */
const CLEANUP_TIMEOUT_MS = 10 * 60_000;

/** Root files without which an install, a build or a typecheck cannot even start. */
const REQUIRED_ROOT_FILES = Object.freeze([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '.npmrc',
  '.nvmrc',
  'tsconfig.json',
  'tsconfig.base.json',
]);

/**
 * The twelve workspaces of AAP §0.2.2. The spec also derives the workspace list from the
 * tracked manifests (`apps/*` and `packages/*`, the globs of `pnpm-workspace.yaml`), so a
 * workspace added later is covered without editing this list; this list is the floor.
 */
const EXPECTED_WORKSPACES = Object.freeze([
  'apps/chrome-extension',
  'apps/demo-app',
  'apps/local-service',
  'apps/vscode-extension',
  'packages/code-analysis',
  'packages/instrumentation',
  'packages/model-provider',
  'packages/panel-renderer',
  'packages/panel-schema',
  'packages/protocol',
  'packages/shared',
  'packages/telemetry',
]);

/** A tracked workspace manifest, matched against a POSIX, repository-relative path. */
const WORKSPACE_MANIFEST_PATTERN = /^((?:apps|packages)\/[^/]+)\/package\.json$/;

/** The only `.env*` files a clone may contain: the two committed examples (AAP §0.3.4). */
const ALLOWED_ENV_FILES = Object.freeze(['.env.example', 'apps/demo-app/.env.example']);

/** Where `prisma generate` writes the demo's client (`generator client { output }`). */
const GENERATED_PRISMA_CLIENT_DIR = 'apps/demo-app/src/generated/prisma';

/** The entry module the `prisma-client` generator always emits into that directory. */
const GENERATED_PRISMA_CLIENT_ENTRY = `${GENERATED_PRISMA_CLIENT_DIR}/client.ts`;

/** The browser agent as built by `packages/telemetry/esbuild.agent.mjs`. */
const AGENT_BUNDLE = 'packages/telemetry/dist/browser-agent.iife.js';

/** The agent as copied by `scripts/copy-agent.mjs`, the Chrome extension's `prebuild` step. */
const AGENT_COPY = 'apps/chrome-extension/public/agent.iife.js';

/** The unpacked Manifest V3 extension both Playwright projects load. */
const CHROME_MANIFEST = 'apps/chrome-extension/dist/manifest.json';

/** A build output that must exist after clone-1's build, and why it matters. */
interface BuildArtifact {
  /** POSIX path relative to the clone root. */
  readonly path: string;
  /** Printed with a failure, so a missing artefact names the step that should have written it. */
  readonly why: string;
}

/**
 * The artefacts the rest of the suite (and the product) consume directly. The `exports`/`main`
 * targets of every workspace are added to these at run time from the clone's own manifests.
 */
const REQUIRED_BUILD_ARTIFACTS: readonly BuildArtifact[] = Object.freeze([
  {
    path: 'apps/local-service/dist/main.js',
    why: 'the service bundle (tsup) that playwright.config.ts starts as its webServer',
  },
  { path: CHROME_MANIFEST, why: 'the unpacked MV3 extension (Vite + crxjs) the suites load' },
  {
    path: AGENT_COPY,
    why: 'the chrome-extension prebuild copy (scripts/copy-agent.mjs) - proves @debuggen/telemetry built first',
  },
  {
    path: AGENT_BUNDLE,
    why: 'the MAIN-world browser agent (packages/telemetry/esbuild.agent.mjs)',
  },
  {
    path: 'packages/telemetry/dist/node/register.mjs',
    why: 'the Node preload the dev-server launcher attaches (packages/telemetry/esbuild.node.mjs)',
  },
  { path: 'packages/protocol/dist/index.js', why: 'the protocol runtime every surface imports' },
  { path: 'packages/protocol/dist/index.d.ts', why: 'the protocol declarations (tsup dts)' },
  {
    path: 'packages/panel-renderer/dist/styles.css',
    why: 'the renderer stylesheet both UIs load (exports["./styles.css"])',
  },
  { path: GENERATED_PRISMA_CLIENT_ENTRY, why: 'the Prisma client demo:generate writes first' },
  { path: 'apps/demo-app/.next/BUILD_ID', why: 'the `next build` of the demo storefront' },
]);

/**
 * Names a child must never see, compared in the probe: the runtime preload channel, the model
 * key, the product's own configuration and anything a name marks as a credential. Mirrors (and
 * independently re-checks) the policy of `sanitizedEnv()` in `./helpers/repo`.
 */
const FORBIDDEN_CHILD_ENV_PATTERN =
  '^(NODE_OPTIONS|NPM_CONFIG_NODE_OPTIONS|ANTHROPIC_API_KEY)$|^DEBUGGEN_|TOKEN|SECRET|PASSWORD';

/**
 * Run inside a clone with the exact environment the long commands get. It prints variable
 * NAMES matching the forbidden pattern (expected: none) and two booleans — never a value.
 * `process.argv[1]` is the expected `DATABASE_URL`, `process.argv[2]` the pattern.
 */
const ENV_PROBE_SCRIPT = [
  "const forbidden = new RegExp(process.argv[2], 'i');",
  'const names = Object.keys(process.env).filter((name) => forbidden.test(name)).sort();',
  'process.stdout.write(JSON.stringify({',
  '  forbidden: names,',
  "  ci: process.env.CI === '1',",
  '  databaseUrlIsPlaceholder: process.env.DATABASE_URL === process.argv[1],',
  '}));',
].join('\n');

// ---------------------------------------------------------------------------
// Shared state of the serial group
// ---------------------------------------------------------------------------

/** One of the two independent clones. */
interface CloneRoot {
  /** `clone-1` / `clone-2`: prefixes every echoed line, heartbeat, step and attachment. */
  readonly name: string;
  /** Absolute, symlink-resolved directory under `os.tmpdir()`. */
  readonly dir: string;
}

/** What the checkout looks like, computed once in `beforeAll` and compared against each clone. */
interface SourceFacts {
  /** Real path of the repository root. */
  readonly root: string;
  /** Every tracked path, POSIX and repository-relative. */
  readonly tracked: readonly string[];
  /** Workspace directories derived from the tracked manifests. */
  readonly workspaces: readonly string[];
  /** SHA-256 of the checkout's `pnpm-lock.yaml`. */
  readonly lockfileDigest: string;
}

/** Every directory `beforeAll` created, removed (best effort) by `afterAll`. */
const createdRoots: string[] = [];

let buildClone: CloneRoot | undefined;
let typecheckClone: CloneRoot | undefined;
let sourceFacts: SourceFacts | undefined;

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

test.describe('clean clone: install → build and install → typecheck each work standalone', () => {
  // Serial: the two clones compete for the same CPUs, disk and pnpm store, so they must never
  // overlap even if the worker count is raised, and the shared beforeAll/afterAll own both
  // temporary trees.
  test.describe.configure({ mode: 'serial' });

  test.skip(
    !process.env.CI && process.env.DEBUGGEN_SKIP_CLEAN_CLONE === '1',
    'DEBUGGEN_SKIP_CLEAN_CLONE=1 skips the clean-clone ordering proof locally (it is never skipped under CI).',
  );

  test.beforeAll(async () => {
    const root = await realpath(repoRoot());
    const tracked = await listTrackedFiles();
    sourceFacts = {
      root,
      tracked,
      workspaces: workspacesOf(tracked),
      lockfileDigest: await sha256Of(repoPath('pnpm-lock.yaml')),
    };

    const first = await createCloneRoot();
    const second = await createCloneRoot();
    // Two independent trees: distinct, neither nested in the other, neither inside (or
    // containing) the checkout. `copyTrackedTree()` re-checks the checkout boundary itself.
    expect(first, 'the two clones must be different directories').not.toBe(second);
    for (const [label, candidate, other] of [
      ['clone-1', first, second],
      ['clone-2', second, first],
    ] as const) {
      expect(isPathInside(candidate, other), `${label} (${candidate}) lies inside ${other}`).toBe(
        false,
      );
      expect(
        isPathInside(candidate, root),
        `${label} (${candidate}) lies inside the checkout`,
      ).toBe(false);
      expect(isPathInside(root, candidate), `${label} (${candidate}) contains the checkout`).toBe(
        false,
      );
    }
    buildClone = { name: 'clone-1', dir: first };
    typecheckClone = { name: 'clone-2', dir: second };
  });

  test.afterAll(async () => {
    test.setTimeout(CLEANUP_TIMEOUT_MS);
    // Best effort by design: a tree that cannot be fully removed is reported, never a failure
    // of the suite — the orderings were proven (or not) by the tests themselves.
    for (const dir of createdRoots.splice(0)) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
        process.stdout.write(`[clean-clone] removed ${dir}\n`);
      } catch (error) {
        console.warn(
          `[clean-clone] could not remove ${dir} (${describeError(error)}); delete it by hand.`,
        );
      }
    }
  });

  test('clone-1: pnpm install --frozen-lockfile && pnpm build', async () => {
    test.slow();
    test.setTimeout(BUILD_ORDERING_TIMEOUT_MS);
    const clone = requireClone(buildClone);
    const facts = requireFacts();

    await test.step(`${clone.name}: materialise the tracked tree`, async () => {
      await materialiseClone(clone, facts);
    });
    await test.step(`${clone.name}: verify the child environment`, async () => {
      await probeChildEnvironment(clone);
    });
    await test.step(`${clone.name}: pnpm install --frozen-lockfile`, async () => {
      await runInClone(clone, ['install', '--frozen-lockfile'], INSTALL_TIMEOUT_MS);
      await expectLockfileUnchanged(clone, facts, 'after pnpm install --frozen-lockfile');
    });
    await test.step(`${clone.name}: pnpm build`, async () => {
      await runInClone(clone, ['build'], BUILD_TIMEOUT_MS);
      await expectLockfileUnchanged(clone, facts, 'after pnpm build');
    });
    await test.step(`${clone.name}: every build artefact exists`, async () => {
      await expectBuildArtifacts(clone, facts);
    });
    await test.step(`${clone.name}: still no repository metadata`, async () => {
      expect(await pathExists(path.join(clone.dir, '.git')), `${clone.name} grew a .git`).toBe(
        false,
      );
    });
  });

  test('clone-2: pnpm install --frozen-lockfile && pnpm typecheck (no build)', async () => {
    test.slow();
    test.setTimeout(TYPECHECK_ORDERING_TIMEOUT_MS);
    const clone = requireClone(typecheckClone);
    const facts = requireFacts();

    await test.step(`${clone.name}: materialise the tracked tree`, async () => {
      await materialiseClone(clone, facts);
    });
    await test.step(`${clone.name}: verify the child environment`, async () => {
      await probeChildEnvironment(clone);
    });
    await test.step(`${clone.name}: pnpm install --frozen-lockfile`, async () => {
      await runInClone(clone, ['install', '--frozen-lockfile'], INSTALL_TIMEOUT_MS);
      await expectLockfileUnchanged(clone, facts, 'after pnpm install --frozen-lockfile');
    });
    await test.step(`${clone.name}: pnpm typecheck`, async () => {
      await runInClone(clone, ['typecheck'], TYPECHECK_TIMEOUT_MS);
      await expectLockfileUnchanged(clone, facts, 'after pnpm typecheck');
    });
    await test.step(`${clone.name}: typecheck needed prisma generate and nothing built`, async () => {
      await expectTypecheckStoodAlone(clone, facts);
    });
    await test.step(`${clone.name}: still no repository metadata`, async () => {
      expect(await pathExists(path.join(clone.dir, '.git')), `${clone.name} grew a .git`).toBe(
        false,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Materialising a clone
// ---------------------------------------------------------------------------

/** A fresh, empty, symlink-resolved directory under `os.tmpdir()`, registered for removal. */
async function createCloneRoot(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), CLONE_DIR_PREFIX));
  createdRoots.push(created);
  return realpath(created);
}

/**
 * Copy the tracked tree into `clone.dir` and prove the copy is what a fresh checkout would
 * start from: every tracked path accounted for, the manifests and configs every command needs,
 * every workspace, a byte-identical lockfile, exactly the tracked files on disk — and no `.git`
 * and no `.env*` beyond the two committed examples.
 */
async function materialiseClone(clone: CloneRoot, facts: SourceFacts): Promise<void> {
  const copy = await copyTrackedTree(clone.dir, { label: `${clone.name} copy` });
  expect(copy.dest, `${clone.name} was copied somewhere else`).toBe(clone.dir);
  if (copy.missing.length > 0) {
    // A tracked path deleted in the local working tree (never the case on a CI checkout).
    test.info().annotations.push({
      type: 'clean-clone',
      description: `${clone.name}: ${String(copy.missing.length)} tracked path(s) are missing from the working tree and were not copied: ${copy.missing.slice(0, 10).join(', ')}`,
    });
  }

  expectTrackedPathsAccountedFor(clone, copy, facts);

  const copied = new Set(copy.files);
  const missingRootFiles = REQUIRED_ROOT_FILES.filter((file) => !copied.has(file));
  expect(missingRootFiles, `${clone.name} lacks required root files`).toEqual([]);

  const missingWorkspaces = EXPECTED_WORKSPACES.filter((dir) => !facts.workspaces.includes(dir));
  expect(missingWorkspaces, 'workspaces of AAP §0.2.2 absent from the tracked tree').toEqual([]);
  const incompleteWorkspaces = facts.workspaces.filter(
    (dir) =>
      !copied.has(`${dir}/package.json`) ||
      !copy.files.some((file) => file.startsWith(`${dir}/`) && file !== `${dir}/package.json`),
  );
  expect(incompleteWorkspaces, `${clone.name}: workspaces copied incompletely`).toEqual([]);

  expect(
    await sha256Of(path.join(clone.dir, 'pnpm-lock.yaml')),
    `${clone.name}: the copied pnpm-lock.yaml differs from the checkout's`,
  ).toBe(facts.lockfileDigest);

  const inventory = await inventoryTree(clone.dir);
  expect(inventory.gitEntries, `${clone.name} contains repository metadata`).toEqual([]);
  expect(inventory.envFiles, `${clone.name} contains .env files beyond the examples`).toEqual([
    ...ALLOWED_ENV_FILES,
  ]);
  expect(
    inventory.fileCount,
    `${clone.name} holds files that are not tracked (or lost tracked ones) during the copy`,
  ).toBe(copy.files.length);
}

/** Every tracked path was either copied or reported missing, and nothing else was copied. */
function expectTrackedPathsAccountedFor(
  clone: CloneRoot,
  copy: CopyTrackedTreeResult,
  facts: SourceFacts,
): void {
  const accounted = new Set([...copy.files, ...copy.missing]);
  const unaccounted = facts.tracked.filter((file) => !accounted.has(file));
  expect(unaccounted, `${clone.name}: tracked paths neither copied nor reported`).toEqual([]);
  const tracked = new Set(facts.tracked);
  const extra = copy.files.filter((file) => !tracked.has(file));
  expect(extra, `${clone.name}: copied paths that are not tracked`).toEqual([]);
}

/** What a recursive walk of a freshly copied (not yet installed) clone found. */
interface TreeInventory {
  /** Every entry named `.git`, at any depth. */
  readonly gitEntries: readonly string[];
  /** Every non-directory entry whose name starts with `.env`, sorted. */
  readonly envFiles: readonly string[];
  /** Files and symbolic links (everything but directories). */
  readonly fileCount: number;
}

/**
 * Walk a clone before `pnpm install` has populated it — a few thousand entries at most — and
 * collect what must never be there. Names only; no file is opened.
 */
async function inventoryTree(root: string): Promise<TreeInventory> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const gitEntries: string[] = [];
  const envFiles: string[] = [];
  let fileCount = 0;
  for (const entry of entries) {
    const relative = toPosix(path.relative(root, path.join(entry.parentPath, entry.name)));
    if (entry.name.toLowerCase() === '.git') {
      gitEntries.push(relative);
    }
    if (entry.isDirectory()) {
      continue;
    }
    fileCount += 1;
    if (entry.name.startsWith('.env')) {
      envFiles.push(relative);
    }
  }
  return { gitEntries: gitEntries.sort(), envFiles: envFiles.sort(), fileCount };
}

// ---------------------------------------------------------------------------
// Running commands in a clone
// ---------------------------------------------------------------------------

/**
 * Prove, from inside a child started with the clone commands' exact environment, that nothing
 * forbidden was inherited and the two deliberate values arrived. The probe prints names and
 * booleans only, and nothing it prints is echoed.
 */
async function probeChildEnvironment(clone: CloneRoot): Promise<void> {
  const result = await runCommand(
    process.execPath,
    ['-e', ENV_PROBE_SCRIPT, DATABASE_URL_PLACEHOLDER, FORBIDDEN_CHILD_ENV_PATTERN],
    {
      cwd: clone.dir,
      timeoutMs: SHORT_COMMAND_TIMEOUT_MS,
      env: CLONE_COMMAND_ENV,
      label: `${clone.name} env probe`,
      echo: false,
      expectSuccess: true,
    },
  );
  const report: unknown = JSON.parse(result.stdout);
  expect(report, `${clone.name}: the child environment is not the sanitised one`).toEqual({
    forbidden: [],
    ci: true,
    databaseUrlIsPlaceholder: true,
  });
}

/**
 * Run `pnpm <args>` in the clone — `shell: false`, streamed with a heartbeat by `runPnpm` —
 * attach the captured log to the report whatever the outcome, and fail with the command's last
 * output lines unless it exited 0 within its budget.
 */
async function runInClone(
  clone: CloneRoot,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  const label = `${clone.name} pnpm ${args.join(' ')}`;
  const result = await runPnpm(args, {
    cwd: clone.dir,
    timeoutMs,
    env: CLONE_COMMAND_ENV,
    label,
  });
  await test.info().attach(`${label}.log`, {
    body: renderCommandLog(result),
    contentType: 'text/plain',
  });
  if (!result.ok) {
    throw new CommandFailedError(result);
  }
  return result;
}

/** The attached log: a header naming the outcome (never the environment), then the output. */
function renderCommandLog(result: CommandResult): string {
  const outcome = result.timedOut
    ? 'timed out'
    : result.spawnError !== null
      ? `could not start (${result.spawnError})`
      : result.code !== null
        ? `exit code ${String(result.code)}`
        : `ended by ${result.signal ?? 'an unknown cause'}`;
  return [
    `$ ${[result.command, ...result.args].join(' ')}`,
    `cwd: ${result.cwd}`,
    `outcome: ${outcome} after ${(result.durationMs / 1000).toFixed(1)}s`,
    `environment withheld (names only): ${result.envWithheld.length === 0 ? 'none' : result.envWithheld.join(', ')}`,
    `output truncated: ${result.truncated ? 'yes' : 'no'}`,
    '',
    result.combined,
  ].join('\n');
}

/** `--frozen-lockfile` was honoured: the clone's lockfile is still the checkout's, byte for byte. */
async function expectLockfileUnchanged(
  clone: CloneRoot,
  facts: SourceFacts,
  when: string,
): Promise<void> {
  expect(
    await sha256Of(path.join(clone.dir, 'pnpm-lock.yaml')),
    `${clone.name}: pnpm-lock.yaml changed ${when} - the committed lockfile is stale`,
  ).toBe(facts.lockfileDigest);
}

// ---------------------------------------------------------------------------
// What each ordering must have produced
// ---------------------------------------------------------------------------

/**
 * clone-1: every required artefact and every `dist/` target a workspace manifest declares is a
 * non-empty file, the generated Prisma client exists, the extension's agent is a verbatim copy
 * of the telemetry bundle, and the extension manifest is Manifest V3.
 */
async function expectBuildArtifacts(clone: CloneRoot, facts: SourceFacts): Promise<void> {
  const declared = await declaredDistTargets(clone.dir, facts.workspaces);
  const artifacts = new Map<string, string>();
  for (const artifact of [...REQUIRED_BUILD_ARTIFACTS, ...declared]) {
    if (!artifacts.has(artifact.path)) {
      artifacts.set(artifact.path, artifact.why);
    }
  }
  const problems: string[] = [];
  for (const [relative, why] of artifacts) {
    const size = await fileSize(inClone(clone, relative));
    if (size === undefined) {
      problems.push(`${relative} is missing - ${why}`);
    } else if (size === 0) {
      problems.push(`${relative} is empty - ${why}`);
    }
  }
  expect(problems, `${clone.name}: build artefacts missing or empty after pnpm build`).toEqual([]);

  const clientEntries = await readdir(inClone(clone, GENERATED_PRISMA_CLIENT_DIR));
  expect(
    clientEntries.length,
    `${clone.name}: the generated Prisma client is empty`,
  ).toBeGreaterThan(0);

  expect(
    await sha256Of(inClone(clone, AGENT_COPY)),
    `${clone.name}: ${AGENT_COPY} is not a verbatim copy of ${AGENT_BUNDLE}`,
  ).toBe(await sha256Of(inClone(clone, AGENT_BUNDLE)));

  const manifest: unknown = JSON.parse(await readFile(inClone(clone, CHROME_MANIFEST), 'utf8'));
  expect(manifest, `${clone.name}: ${CHROME_MANIFEST} is not a Manifest V3 manifest`).toMatchObject(
    { manifest_version: 3 },
  );
}

/**
 * clone-2: `pnpm typecheck` built nothing — no workspace has a `dist/`, the demo has no
 * `.next/` and the extension has no copied agent — yet it ran `prisma generate` (the client
 * exists) and the solution build walked the references (its `.tsbuild/` declarations exist).
 */
async function expectTypecheckStoodAlone(clone: CloneRoot, facts: SourceFacts): Promise<void> {
  const buildOutputs = [
    ...facts.workspaces.map((dir) => `${dir}/dist`),
    'apps/demo-app/.next',
    AGENT_COPY,
  ];
  const present: string[] = [];
  for (const relative of buildOutputs) {
    if (await pathExists(inClone(clone, relative))) {
      present.push(relative);
    }
  }
  expect(
    present,
    `${clone.name}: build output exists, so this clone did not prove typecheck stands alone`,
  ).toEqual([]);

  const required: readonly BuildArtifact[] = [
    {
      path: GENERATED_PRISMA_CLIENT_ENTRY,
      why: 'the Prisma client the root typecheck script generates first (demo:generate)',
    },
    {
      path: 'packages/protocol/.tsbuild/index.d.ts',
      why: 'the declarations tsc -b emits for a package that imports four workspace packages',
    },
    {
      path: 'tests/.tsbuild/tsconfig.tsbuildinfo',
      why: 'the build stamp of the last project in the root solution file',
    },
  ];
  const problems: string[] = [];
  for (const artifact of required) {
    const size = await fileSize(inClone(clone, artifact.path));
    if (size === undefined || size === 0) {
      problems.push(
        `${artifact.path} is ${size === undefined ? 'missing' : 'empty'} - ${artifact.why}`,
      );
    }
  }
  expect(problems, `${clone.name}: pnpm typecheck left expected outputs out`).toEqual([]);
}

/**
 * The `dist/` files the workspaces themselves promise, read from each copied manifest's
 * `exports` map and `main` field rather than guessed: a manifest naming a file its build does
 * not write fails here. Targets outside `dist/` (the `src/` fallback of a `types` array) and
 * pattern targets are not build outputs and are skipped.
 */
async function declaredDistTargets(
  cloneDir: string,
  workspaces: readonly string[],
): Promise<BuildArtifact[]> {
  const artifacts: BuildArtifact[] = [];
  for (const dir of workspaces) {
    const manifest: unknown = JSON.parse(
      await readFile(path.join(cloneDir, ...dir.split('/'), 'package.json'), 'utf8'),
    );
    if (!isRecord(manifest)) {
      throw new Error(`${dir}/package.json is not a JSON object`);
    }
    const targets = collectExportTargets(manifest.exports);
    if (typeof manifest.main === 'string') {
      targets.push(manifest.main);
    }
    for (const target of new Set(targets)) {
      const normalized = path.posix.normalize(target);
      if (normalized.startsWith('dist/') && !normalized.includes('*')) {
        artifacts.push({
          path: `${dir}/${normalized}`,
          why: `declared by ${dir}/package.json (exports/main)`,
        });
      }
    }
  }
  return artifacts;
}

/** Every string target of an `exports` value: plain, conditional, nested or a fallback array. */
function collectExportTargets(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry: unknown) => collectExportTargets(entry));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((entry) => collectExportTargets(entry));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function requireClone(clone: CloneRoot | undefined): CloneRoot {
  if (clone === undefined) {
    throw new Error('clean-clone: beforeAll did not create the clone directories');
  }
  return clone;
}

function requireFacts(): SourceFacts {
  if (sourceFacts === undefined) {
    throw new Error('clean-clone: beforeAll did not record the checkout facts');
  }
  return sourceFacts;
}

/** Workspace directories (`apps/*`, `packages/*`) that carry a tracked `package.json`. */
function workspacesOf(tracked: readonly string[]): string[] {
  const workspaces: string[] = [];
  for (const file of tracked) {
    const match = WORKSPACE_MANIFEST_PATTERN.exec(file);
    if (match?.[1] !== undefined) {
      workspaces.push(match[1]);
    }
  }
  return workspaces.sort();
}

/** A POSIX clone-relative path as a platform-native absolute path. */
function inClone(clone: CloneRoot, relative: string): string {
  return path.join(clone.dir, ...relative.split('/'));
}

/** The size of a regular file, or `undefined` when it is absent or not a regular file. */
async function fileSize(file: string): Promise<number | undefined> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : undefined;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      return undefined;
    }
    throw error;
  }
}

/** Whether anything (file, directory or link) exists at `file`, without following a link. */
async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

async function sha256Of(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

/** True when `candidate` is `parent` or lies below it (both already resolved). */
function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
