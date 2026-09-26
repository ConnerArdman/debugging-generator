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
 * A real `git clone` of the commit under test, made by `cloneRepository()` (`./helpers/repo`):
 * the source is the LOCAL checkout's absolute path — never a URL, never the checkout's remote —
 * cloned with `--no-local --no-checkout --template=` into an empty directory under
 * `os.tmpdir()` and detached at the commit the checkout's `HEAD` named when the suite started
 * (`git rev-parse --verify HEAD^{commit}`). What is tested is exactly what a fresh checkout of
 * that commit contains: an uncommitted edit, a staged deletion or an untracked file in the
 * checkout can neither break nor rescue it, and a checkout with uncommitted changes is
 * reported by an annotation saying the clones test the commit, not the working tree.
 *
 * The checkout's `.git/config` carries a live access token in its `origin` URL (AAP §0.2.1),
 * and it cannot reach a clone: a clone never copies its source's configuration, the clone's own
 * `origin` (which names only the local path) is removed, and no git output is echoed. Each
 * clone is then asserted to be self-contained and pristine — `HEAD` is the target commit, `git
 * ls-files` equals the commit's `git ls-tree`, the root manifests and every workspace are
 * present, the only `.env*` files outside `.git/` are the two committed examples, there is no
 * remote and no `objects/info/alternates`, and nothing is modified, untracked or ignored. Every
 * metadata check is an `lstat` or a git command that prints paths and object ids: this spec
 * never opens a file under any `.git/`, runs no `git remote`/`git config` of its own (`runGit`
 * refuses both) and never prints an environment.
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
 * - **both** — `--frozen-lockfile` was honoured and nothing rewrote the tree: each clone's
 *   `pnpm-lock.yaml` is the committed blob (`git hash-object` in the clone equals `git rev-parse
 *   <commit>:pnpm-lock.yaml`) and byte-identical to the other clone's, it is unchanged after
 *   every command, and after the last command `git status --porcelain --untracked-files=no` in
 *   the clone is empty. A stale committed lockfile, or a build step that rewrites a tracked file
 *   (a generated file that drifted from its committed copy), fails here instead of passing on
 *   a tree nobody committed.
 *
 * ## What this spec deliberately does NOT run inside the clones
 *
 * `pnpm test`, `lint`, `format:check` and the guard scripts (`check:secrets`,
 * `check:no-hardcoding`, `check:no-residual-instrumentation`). Those gates run on the real
 * checkout in CI's `verify` job, and this spec exists to prove the two orderings, not to repeat
 * that job: each would add minutes per clone and could fail for a reason unrelated to install,
 * build or typecheck standing alone. Do not "improve" this spec by adding them.
 *
 * ## Cost and environment
 *
 * Two local clones (seconds each, no network), two installs, a full monorepo build and a
 * solution-wide typecheck. The installs need registry access; with a warm pnpm
 * content-addressable store (CI's cache, or a developer machine that has installed this
 * lockfile before) packages are linked rather than downloaded, which turns tens of minutes
 * into a few. Every command streams its output line by line, prefixed with the clone and the
 * command, plus a heartbeat every 30 s (`runCommand` in `./helpers/repo`), so a
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
 * This is an acceptance proof, so it has no skip switch: every run of the `e2e` project runs
 * both clones, locally exactly as under `CI`.
 *
 * Nothing is written inside the checkout: both clones live under `os.tmpdir()` (created with
 * `fs.mkdtemp`) and are removed in `afterAll`, so sibling specs' `git status` assertions are
 * unaffected.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test } from './helpers/fixtures';
// Straight from the foundation module: `./helpers/fixtures` re-exports only part of it, and
// the clone helpers (`cloneRepository`, `resolveHeadCommit`, `listCommitFiles`) are not among
// that part. Importing `./helpers/repo` evaluates nothing else (it imports no sibling helper).
import {
  BUILD_TIMEOUT_MS,
  CLONE_TIMEOUT_MS,
  CommandFailedError,
  INSTALL_TIMEOUT_MS,
  SHORT_COMMAND_TIMEOUT_MS,
  TYPECHECK_TIMEOUT_MS,
  cloneRepository,
  listCommitFiles,
  repoRoot,
  resolveHeadCommit,
  runCommand,
  runGit,
  runPnpm,
} from './helpers/repo';
import type { CommandResult } from './helpers/repo';

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
 * Everything in a test except its two long commands: the clone's two slow git steps (`git
 * clone --no-local` and the checkout) at their full {@link CLONE_TIMEOUT_MS} budget, plus five
 * minutes for its verification, the environment probe, the artefact checks, the tracked-tree
 * status and the log attachments.
 */
const SETUP_ALLOWANCE_MS = 2 * CLONE_TIMEOUT_MS + 5 * 60_000;

/** clone-1's whole budget: the two command budgets of `./helpers/repo` plus setup. */
const BUILD_ORDERING_TIMEOUT_MS = INSTALL_TIMEOUT_MS + BUILD_TIMEOUT_MS + SETUP_ALLOWANCE_MS;

/** clone-2's whole budget: the two command budgets of `./helpers/repo` plus setup. */
const TYPECHECK_ORDERING_TIMEOUT_MS =
  INSTALL_TIMEOUT_MS + TYPECHECK_TIMEOUT_MS + SETUP_ALLOWANCE_MS;

/** Removing two trees that each hold a linked `node_modules/` and build output. */
const CLEANUP_TIMEOUT_MS = 10 * 60_000;

/**
 * Removal attempts per clone root before teardown gives up on it and fails. Each attempt is an
 * `fs.rm` that itself retries transient errors (`EBUSY`, `ENOTEMPTY`, `EPERM`, ...), so this
 * outer loop covers a tree something else was still writing into when the first pass ran.
 */
const REMOVAL_ATTEMPTS = 3;

/** `fs.rm`'s own retries of a transient error within one attempt, and the pause between them. */
const RM_MAX_RETRIES = 3;
const RM_RETRY_DELAY_MS = 250;

/** Pause after a failed removal attempt, multiplied by the attempt number (1 s, then 2 s). */
const REMOVAL_BACKOFF_MS = 1_000;

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

/** The lockfile `--frozen-lockfile` must leave untouched, relative to the clone root. */
const LOCKFILE = 'pnpm-lock.yaml';

/** A full git object id: SHA-1 (40 hex digits) or SHA-256 (64). */
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** How many offending paths an assertion message lists before summarising the rest. */
const LISTED_PATHS_LIMIT = 20;

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

/**
 * The commit under test, computed once in `beforeAll` from the checkout and compared against
 * each clone. The tracked set and the lockfile blob are read from the commit object, not from
 * the working tree; only the two `uncommittedChanges*` fields describe the working tree.
 */
interface SourceFacts {
  /** Real path of the repository root. */
  readonly root: string;
  /** Full object id of the commit both clones check out: the checkout's `HEAD` at `beforeAll`. */
  readonly commit: string;
  /** Every path the commit tracks (`git ls-tree -r`), POSIX and repository-relative, sorted. */
  readonly tracked: readonly string[];
  /** Workspace directories derived from the commit's tracked manifests. */
  readonly workspaces: readonly string[];
  /** Blob id of the commit's `pnpm-lock.yaml` (`git rev-parse <commit>:pnpm-lock.yaml`). */
  readonly lockfileBlob: string;
  /**
   * Lines `git status --porcelain` printed in the checkout — a count, never the paths. Non-zero
   * means the working tree differs from the commit the clones test.
   */
  readonly uncommittedChanges: number;
  /** True when that status listing was truncated, so the count is a lower bound. */
  readonly uncommittedChangesTruncated: boolean;
}

/** Every directory `beforeAll` created; `afterAll` removes each and fails if one survives. */
const createdRoots: string[] = [];

/**
 * SHA-256 of each clone's `pnpm-lock.yaml` as checked out (keyed by clone name), recorded once
 * the file has been proven to be the committed blob; every later lockfile check compares to it.
 */
const lockfileDigests = new Map<string, string>();

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

  test.beforeAll(async () => {
    const root = await realpath(repoRoot());
    // Pin both clones to one immutable commit up front, so a commit landing in the checkout
    // while clone-1 builds cannot make clone-2 test something else.
    const commit = await resolveHeadCommit();
    const tracked = await listCommitFiles(commit);
    const status = await runGit(['status', '--porcelain'], { expectSuccess: true });
    sourceFacts = {
      root,
      commit,
      tracked,
      workspaces: workspacesOf(tracked),
      lockfileBlob: await gitObjectId(`${commit}:${LOCKFILE}`, root),
      uncommittedChanges: nonEmptyLines(status.stdout).length,
      uncommittedChangesTruncated: status.truncated,
    };

    const first = await createCloneRoot();
    const second = await createCloneRoot();
    // Two independent trees: distinct, neither nested in the other, neither inside (or
    // containing) the checkout. `cloneRepository()` re-checks the checkout boundary itself.
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
    // Strict by design: each clone holds a linked node_modules/ and a full build, so a tree left
    // behind is a teardown failure naming the path — never a warning a green run hides.
    await removeCreatedRoots();
  });

  test('clone-1: pnpm install --frozen-lockfile && pnpm build', async () => {
    test.slow();
    test.setTimeout(BUILD_ORDERING_TIMEOUT_MS);
    const clone = requireClone(buildClone);
    const facts = requireFacts();

    await test.step(`${clone.name}: git clone of the commit under test`, async () => {
      await materialiseClone(clone, facts);
    });
    await test.step(`${clone.name}: verify the child environment`, async () => {
      await probeChildEnvironment(clone);
    });
    await test.step(`${clone.name}: pnpm install --frozen-lockfile`, async () => {
      await runInClone(clone, ['install', '--frozen-lockfile'], INSTALL_TIMEOUT_MS);
      await expectLockfileUnchanged(clone, 'after pnpm install --frozen-lockfile');
    });
    await test.step(`${clone.name}: pnpm build`, async () => {
      await runInClone(clone, ['build'], BUILD_TIMEOUT_MS);
      await expectLockfileUnchanged(clone, 'after pnpm build');
    });
    await test.step(`${clone.name}: every build artefact exists`, async () => {
      await expectBuildArtifacts(clone, facts);
    });
    await test.step(`${clone.name}: every tracked file is unmodified`, async () => {
      await expectTrackedFilesUnmodified(
        clone,
        facts,
        'pnpm install --frozen-lockfile && pnpm build',
      );
    });
  });

  test('clone-2: pnpm install --frozen-lockfile && pnpm typecheck (no build)', async () => {
    test.slow();
    test.setTimeout(TYPECHECK_ORDERING_TIMEOUT_MS);
    const clone = requireClone(typecheckClone);
    const facts = requireFacts();

    await test.step(`${clone.name}: git clone of the commit under test`, async () => {
      await materialiseClone(clone, facts);
    });
    await test.step(`${clone.name}: verify the child environment`, async () => {
      await probeChildEnvironment(clone);
    });
    await test.step(`${clone.name}: pnpm install --frozen-lockfile`, async () => {
      await runInClone(clone, ['install', '--frozen-lockfile'], INSTALL_TIMEOUT_MS);
      await expectLockfileUnchanged(clone, 'after pnpm install --frozen-lockfile');
    });
    await test.step(`${clone.name}: pnpm typecheck`, async () => {
      await runInClone(clone, ['typecheck'], TYPECHECK_TIMEOUT_MS);
      await expectLockfileUnchanged(clone, 'after pnpm typecheck');
    });
    await test.step(`${clone.name}: typecheck needed prisma generate and nothing built`, async () => {
      await expectTypecheckStoodAlone(clone, facts);
    });
    await test.step(`${clone.name}: every tracked file is unmodified`, async () => {
      await expectTrackedFilesUnmodified(
        clone,
        facts,
        'pnpm install --frozen-lockfile && pnpm typecheck',
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
 * `git clone` the commit under test into `clone.dir` with `cloneRepository()` — which itself
 * refuses to resolve unless `HEAD` is the commit, the tree is pristine, no remote is left and
 * the object store is self-contained — and prove from this side that the clone is what a fresh
 * checkout of that commit contains: `HEAD` is the commit; the clone's index lists exactly the
 * commit's paths; the manifests and configs every command needs and every workspace are there;
 * the lockfile is the committed blob and identical in both clones; the files on disk are
 * exactly the tracked ones, with no `.env*` beyond the two committed examples; and the
 * repository is the clone's own.
 */
async function materialiseClone(clone: CloneRoot, facts: SourceFacts): Promise<void> {
  if (facts.uncommittedChanges > 0) {
    // A local run on an edited checkout: say plainly what is (and is not) being tested.
    test.info().annotations.push({
      type: 'clean-clone',
      description: `${clone.name}: the checkout has ${facts.uncommittedChangesTruncated ? 'at least ' : ''}${String(facts.uncommittedChanges)} uncommitted change(s) (git status --porcelain); this clone tests commit ${facts.commit}, not the working tree.`,
    });
  }

  const cloned = await cloneRepository(clone.dir, { commit: facts.commit, label: clone.name });
  expect(cloned.dest, `${clone.name} was cloned somewhere else`).toBe(clone.dir);
  expect(cloned.commit, `${clone.name}: cloneRepository() checked out another commit`).toBe(
    facts.commit,
  );
  expect(
    await gitObjectId('HEAD^{commit}', clone.dir),
    `${clone.name}: HEAD is not the commit under test`,
  ).toBe(facts.commit);

  expectSameTrackedPaths(clone, cloned.files, facts);

  const tracked = new Set(cloned.files);
  const missingRootFiles = REQUIRED_ROOT_FILES.filter((file) => !tracked.has(file));
  expect(missingRootFiles, `${clone.name} lacks required root files`).toEqual([]);

  const missingWorkspaces = EXPECTED_WORKSPACES.filter((dir) => !facts.workspaces.includes(dir));
  expect(missingWorkspaces, 'workspaces of AAP §0.2.2 absent from the commit').toEqual([]);
  const incompleteWorkspaces = facts.workspaces.filter(
    (dir) =>
      !tracked.has(`${dir}/package.json`) ||
      !cloned.files.some((file) => file.startsWith(`${dir}/`) && file !== `${dir}/package.json`),
  );
  expect(incompleteWorkspaces, `${clone.name}: workspaces checked out incompletely`).toEqual([]);

  await recordCommittedLockfile(clone, facts);

  const inventory = await inventoryTree(clone.dir);
  expect(
    inventory.nestedGitEntries,
    `${clone.name} contains repository metadata beyond its own .git`,
  ).toEqual([]);
  expect(inventory.envFiles, `${clone.name} contains .env files beyond the examples`).toEqual([
    ...ALLOWED_ENV_FILES,
  ]);
  expect(
    inventory.fileCount,
    `${clone.name} holds files on disk beyond (or short of) the ones the commit tracks`,
  ).toBe(cloned.files.length);

  await expectSelfContainedRepository(clone);
}

/** The clone's index (`git ls-files -z`) lists exactly the paths the commit tracks. */
function expectSameTrackedPaths(
  clone: CloneRoot,
  files: readonly string[],
  facts: SourceFacts,
): void {
  const inClone = new Set(files);
  const inCommit = new Set(facts.tracked);
  expect(
    listed(facts.tracked.filter((file) => !inClone.has(file))),
    `${clone.name}: paths commit ${facts.commit} tracks that the clone's index lacks`,
  ).toEqual([]);
  expect(
    listed(files.filter((file) => !inCommit.has(file))),
    `${clone.name}: paths in the clone's index that commit ${facts.commit} does not track`,
  ).toEqual([]);
}

/**
 * The clone's `pnpm-lock.yaml` is the committed blob byte for byte (`git hash-object` in the
 * clone equals `git rev-parse <commit>:pnpm-lock.yaml` in the checkout) and identical to every
 * other clone's; its SHA-256 is recorded for {@link expectLockfileUnchanged}.
 */
async function recordCommittedLockfile(clone: CloneRoot, facts: SourceFacts): Promise<void> {
  expect(
    await gitBlobIdOf(clone, LOCKFILE),
    `${clone.name}: ${LOCKFILE} is not the committed blob of commit ${facts.commit}`,
  ).toBe(facts.lockfileBlob);
  const digest = await sha256Of(inClone(clone, LOCKFILE));
  for (const [other, otherDigest] of lockfileDigests) {
    if (other !== clone.name) {
      expect(digest, `${clone.name}'s ${LOCKFILE} differs from ${other}'s`).toBe(otherDigest);
    }
  }
  lockfileDigests.set(clone.name, digest);
}

/**
 * The clone owns its repository and refers to nothing outside itself: `.git` is a real
 * directory (not a gitlink file or a symbolic link), its object store borrows nothing
 * (`objects/info/alternates` is absent) and no remote-tracking ref survived the removal of the
 * remote. `lstat` calls and ref NAMES only — nothing under `.git/` is opened. That `git remote`
 * lists nothing was verified by `cloneRepository()`, which alone may run it (`runGit` refuses).
 */
async function expectSelfContainedRepository(clone: CloneRoot): Promise<void> {
  const gitDir = inClone(clone, '.git');
  expect((await lstat(gitDir)).isDirectory(), `${clone.name}: .git is not a real directory`).toBe(
    true,
  );
  expect(
    await pathExists(path.join(gitDir, 'objects', 'info', 'alternates')),
    `${clone.name} borrows objects from another repository (objects/info/alternates exists)`,
  ).toBe(false);
  const remoteRefs = await runGit(['for-each-ref', '--format=%(refname)', 'refs/remotes'], {
    cwd: clone.dir,
    expectSuccess: true,
  });
  expect(
    listed(nonEmptyLines(remoteRefs.stdout)),
    `${clone.name} still has remote-tracking refs`,
  ).toEqual([]);
}

/** What a recursive walk of a fresh (not yet installed) clone found outside its `.git/`. */
interface TreeInventory {
  /** Every entry named `.git` other than the clone's own root `.git`, at any depth. */
  readonly nestedGitEntries: readonly string[];
  /** Every non-directory entry whose name starts with `.env`, sorted. */
  readonly envFiles: readonly string[];
  /** Files and symbolic links (everything but directories). */
  readonly fileCount: number;
}

/**
 * Walk a clone before `pnpm install` has populated it — a few thousand entries at most — and
 * collect what must never be there. The clone's own `.git/` subtree is skipped, never listed,
 * and no other `.git` entry is descended into. Names only; no file is opened.
 */
async function inventoryTree(root: string): Promise<TreeInventory> {
  const nestedGitEntries: string[] = [];
  const envFiles: string[] = [];
  let fileCount = 0;
  const pending: string[] = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === '.git') {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.name.toLowerCase() === '.git') {
        nestedGitEntries.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      fileCount += 1;
      if (entry.name.startsWith('.env')) {
        envFiles.push(relative);
      }
    }
  }
  return { nestedGitEntries: nestedGitEntries.sort(), envFiles: envFiles.sort(), fileCount };
}

// ---------------------------------------------------------------------------
// Removing the clones
// ---------------------------------------------------------------------------

/**
 * Remove every root `beforeAll` created and prove each one gone. A root leaves `createdRoots`
 * only once `lstat` reports `ENOENT` for it; after every root has been tried, one error names
 * each survivor with the reason it persists, so teardown fails visibly instead of leaving
 * gigabytes behind under a green result. Git's pack files are read-only (`0444`), which `fs.rm`
 * with `force` removes all the same: unlinking needs only a writable parent directory.
 */
async function removeCreatedRoots(): Promise<void> {
  const survivors: string[] = [];
  for (const dir of [...createdRoots]) {
    const failure = await removeTree(dir);
    if (failure === undefined) {
      createdRoots.splice(createdRoots.indexOf(dir), 1);
      process.stdout.write(`[clean-clone] removed ${dir}\n`);
    } else {
      survivors.push(`${dir} - ${failure}`);
    }
  }
  if (survivors.length > 0) {
    throw new Error(
      `clean-clone: ${String(survivors.length)} temporary clone tree(s) persist after ${String(REMOVAL_ATTEMPTS)} removal attempts each; delete them by hand:\n${survivors.map((line) => `  ${line}`).join('\n')}`,
    );
  }
}

/**
 * Remove `dir` with up to {@link REMOVAL_ATTEMPTS} attempts, backing off between them, and
 * verify the removal. Resolves `undefined` once `dir` is verifiably gone, otherwise the reason
 * it persists after the last attempt (the `fs.rm` error, or what the verification found).
 */
async function removeTree(dir: string): Promise<string | undefined> {
  let failure = 'not attempted';
  for (let attempt = 1; attempt <= REMOVAL_ATTEMPTS; attempt += 1) {
    let rmError: string | undefined;
    try {
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: RM_MAX_RETRIES,
        retryDelay: RM_RETRY_DELAY_MS,
      });
    } catch (error) {
      rmError = describeError(error);
    }
    const remaining = await describeRemaining(dir);
    if (remaining === undefined) {
      return undefined;
    }
    failure =
      rmError === undefined
        ? `${remaining} although fs.rm reported success`
        : `${remaining}; fs.rm failed: ${rmError}`;
    if (attempt < REMOVAL_ATTEMPTS) {
      await delay(REMOVAL_BACKOFF_MS * attempt);
    }
  }
  return failure;
}

/** `undefined` when `lstat` reports `dir` absent (`ENOENT`), otherwise what it found instead. */
async function describeRemaining(dir: string): Promise<string | undefined> {
  try {
    const info = await lstat(dir);
    return `still present (${info.isDirectory() ? 'directory' : 'non-directory'})`;
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
      ? undefined
      : `cannot be verified gone (lstat: ${describeError(error)})`;
  }
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

/**
 * `--frozen-lockfile` was honoured: the clone's lockfile is still, byte for byte, the committed
 * blob it held when {@link recordCommittedLockfile} checked it.
 */
async function expectLockfileUnchanged(clone: CloneRoot, when: string): Promise<void> {
  const expected = lockfileDigests.get(clone.name);
  if (expected === undefined) {
    throw new Error(`${clone.name}: no ${LOCKFILE} digest was recorded when the clone was made`);
  }
  expect(
    await sha256Of(inClone(clone, LOCKFILE)),
    `${clone.name}: ${LOCKFILE} changed ${when} - the committed lockfile is stale`,
  ).toBe(expected);
}

/**
 * After `commands`, the clone is still exactly the commit: `git status --porcelain
 * --untracked-files=no` lists nothing — no tracked file was modified, deleted or changed type
 * (build output and `node_modules/` are untracked and ignored, so they are not what this is
 * about) — `HEAD` has not moved, and the lockfile is still the committed blob.
 */
async function expectTrackedFilesUnmodified(
  clone: CloneRoot,
  facts: SourceFacts,
  commands: string,
): Promise<void> {
  const status = await runGit(['status', '--porcelain', '--untracked-files=no'], {
    cwd: clone.dir,
    expectSuccess: true,
  });
  expect(status.truncated, `${clone.name}: git status output was truncated`).toBe(false);
  expect(
    listed(nonEmptyLines(status.stdout)),
    `${clone.name}: ${commands} modified tracked files (git status --porcelain --untracked-files=no)`,
  ).toEqual([]);
  expect(
    await gitObjectId('HEAD^{commit}', clone.dir),
    `${clone.name}: HEAD moved during ${commands}`,
  ).toBe(facts.commit);
  expect(
    await gitBlobIdOf(clone, LOCKFILE),
    `${clone.name}: ${LOCKFILE} is no longer the committed blob after ${commands}`,
  ).toBe(facts.lockfileBlob);
  await expectLockfileUnchanged(clone, `after ${commands}`);
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
 * The `dist/` files the workspaces themselves promise, read from each cloned manifest's
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

/** The object id `git rev-parse --verify <revision>` names in the repository at `cwd`. */
async function gitObjectId(revision: string, cwd: string): Promise<string> {
  const result = await runGit(['rev-parse', '--verify', revision], { cwd, expectSuccess: true });
  return requireObjectId(result.stdout.trim(), `git rev-parse --verify ${revision} in ${cwd}`);
}

/** The blob id git computes for a clone's working-tree file (`git hash-object <path>`). */
async function gitBlobIdOf(clone: CloneRoot, relative: string): Promise<string> {
  const result = await runGit(['hash-object', relative], { cwd: clone.dir, expectSuccess: true });
  return requireObjectId(result.stdout.trim(), `git hash-object ${relative} in ${clone.name}`);
}

function requireObjectId(value: string, source: string): string {
  if (!OBJECT_ID_PATTERN.test(value)) {
    throw new Error(`${source} printed ${JSON.stringify(value.slice(0, 80))}, not an object id`);
  }
  return value;
}

/** The non-blank lines of a command's output. */
function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

/**
 * At most {@link LISTED_PATHS_LIMIT} entries plus one `… and N more` marker, so a failed
 * comparison of two ~900-path listings prints a readable excerpt; an empty list stays empty.
 */
function listed(entries: readonly string[]): string[] {
  if (entries.length <= LISTED_PATHS_LIMIT) {
    return [...entries];
  }
  return [
    ...entries.slice(0, LISTED_PATHS_LIMIT),
    `… and ${String(entries.length - LISTED_PATHS_LIMIT)} more`,
  ];
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
