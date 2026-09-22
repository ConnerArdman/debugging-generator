/**
 * Tests for `./prompt-loader.ts`: the only way this product reads a prompt.
 *
 * Three properties are what this suite exists for, and each of them fails
 * silently in production if it is not pinned here:
 *
 * 1. **No path escapes the prompts directory.** The stage and version reaching
 *    the loader can come from a manifest on disk or from a stored session
 *    record, so the cases below drive the adversarial inputs the base package's
 *    own path suite established — traversal in leading, interior and bare
 *    position, an absolute path, a NUL byte, a control character, a
 *    prefix-sibling directory — and, crucially, the one thing a string check
 *    cannot see: a **symbolic link planted inside the prompts directory** whose
 *    target lies outside it, both at the file position and at the stage
 *    directory position.
 * 2. **A superseded version still loads.** `loadVersion` exists so a reopened
 *    session and a follow-up question can be answered with the prompt versions
 *    recorded on the session, which are historical the moment a prompt is
 *    bumped. The cases here load a version that is neither `current` nor listed
 *    in `available`, and one with the manifest deliberately corrupted, because
 *    a future "tightening" of that method to manifest-only would break session
 *    reopening on a code path no manifest test touches.
 * 3. **A missing prompt is an error, never a substitute.** Every failure is
 *    asserted by `DebuggenError` code, so a loader that started inventing a
 *    body — the one thing AAP 0.5.4 forbids — could not pass.
 * 4. **Only a bounded, regular file is ever read.** The loader opens with
 *    no-follow, non-blocking semantics and refuses anything that is not a
 *    regular file no larger than its subject's ceiling, so the cases under
 *    *the bounded read* plant a named pipe and a directory at a prompt path and
 *    drive both ceilings from one byte either side. Those are the failures that
 *    are invisible in a passing read: a loader that called `readFileSync`
 *    answers identically for every well-formed file here and hangs forever on
 *    the pipe.
 * 5. **The prompts this product ships load.** The cases under *the shipped
 *    prompt tree* read `apps/local-service/prompts` out of the checkout itself,
 *    so a manifest that names a version no file provides — or a prompt whose
 *    placeholders have drifted from the stage that renders it — fails here
 *    rather than at the first stage of a developer's first session.
 *
 * ## How caching is observed without mocking the filesystem
 *
 * The loader takes no filesystem seam, deliberately: its options are a
 * directory, an environment, a cache switch and a logger. Counting calls on a
 * spy is not available either, and not by choice: the module under test binds
 * `node:fs` through named ESM imports, and Vitest refuses the spy outright —
 * *"Cannot spy on export \"readFileSync\". Module namespace is not configurable
 * in ESM."* — so a read counter would have to mock the whole of `node:fs`,
 * including the `realpath` and `stat` calls the containment guard depends on,
 * and the symlink cases in this file would then be asserting against the mock
 * rather than against the filesystem.
 *
 * So the cases below observe caching the way a developer would — by
 * **rewriting the file on disk between calls** and asserting which content
 * comes back. A cached read returns the first content, `clearCache()` and
 * `cache: false` return the new content. That is the stronger assertion of the
 * two in any case: it proves what the caller receives rather than how the
 * module got it, and it cannot be satisfied by a mock that has drifted from
 * `node:fs`.
 *
 * ## How "nothing was opened" is proved
 *
 * Several cases claim a rejected stage or version never becomes a filesystem
 * call. With no spy available, they prove it by **ordering**: the loader is
 * pointed at a prompts directory that does not exist, so any code path that
 * consults the filesystem answers `CONFIG_INVALID` ("does not exist") and the
 * guard answers `FS_UNSAFE_PATH`. Reading the guard's code back from a loader
 * whose directory could not have been statted is the observation — an
 * implementation that resolved the root first, or that built the path and
 * opened it, could not produce it.
 *
 * ## Habits
 *
 * - **One fresh sandbox per test**, created with `mkdtemp` and resolved through
 *   `realpath`, so a temp directory that is itself reached through a link
 *   cannot make a containment assertion pass or fail for the wrong reason. Each
 *   is removed afterwards whether the case passed or failed, and nothing reads
 *   or writes the checkout.
 * - **The environment is injected, never mutated.** Every loader gets an
 *   explicit `env` record, so no case can leak `DEBUGGEN_PROMPTS_DIR` into
 *   another file of the same Vitest worker.
 * - **Symlink cases are guarded by capability**, not by platform name: a
 *   hardened or containerised runner may refuse `symlink`, and that must read
 *   as "this host cannot host the case" rather than as a loader defect.
 * - **Fixture prompt bodies are generic.** They name a stage and a version and
 *   nothing else: no identifier or route from any application appears in this
 *   file, which is the same rule the product source lives under (AAP 0.5.4).
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  isErr,
  isOk,
  isWithin,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';

import { PROMPT_STAGES, PROMPT_VERSION_PATTERN, type PromptStage } from './types.js';
import {
  createPromptLoader,
  promptManifestSchema,
  renderPrompt,
  type PromptLoader,
} from './prompt-loader.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/** Sandboxes created by the current test, removed by `afterEach`. */
const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * A private temporary directory, resolved through `realpath`.
 *
 * The resolution matters: on a host whose temp directory is itself a symbolic
 * link, an unresolved sandbox path would make every containment assertion in
 * this file compare two different spellings of the same place.
 */
function createSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'debuggen-prompt-loader-'));
  sandboxes.push(dir);
  return realpathSync(dir);
}

/**
 * The body written for a stage and version; generic by design.
 *
 * It carries two `{{placeholder}}` tokens because a real prompt does: every
 * stage's file names at least its output schema and its evidence-citation
 * rule. Seeding them here means the cases that load a body can hand it
 * straight to {@link renderPrompt}, so the loader and the renderer are
 * exercised across the seam they meet at rather than only in isolation.
 */
function promptBody(stage: string, version: string): string {
  return (
    `# ${stage} ${version}\n\nInstructions for the ${stage} stage, revision ${version}.\n\n` +
    'Return output matching {{schema}}, and cite evidence as {{evidenceRule}}.\n'
  );
}

/** Writes `manifest.json` with the given stage entries. */
function writeManifest(promptsDir: string, manifest: unknown): void {
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(
    join(promptsDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

/** Writes one prompt file, creating its stage directory. */
function writePrompt(promptsDir: string, stage: string, version: string, body?: string): string {
  const stageDir = join(promptsDir, stage);
  mkdirSync(stageDir, { recursive: true });
  const path = join(stageDir, `${version}.md`);
  writeFileSync(path, body ?? promptBody(stage, version), 'utf8');
  return path;
}

/**
 * A complete, valid prompt tree: every stage present at `version`, and a
 * manifest naming that version as current.
 */
function seedPromptTree(promptsDir: string, version = 'v001'): string {
  for (const stage of PROMPT_STAGES) {
    writePrompt(promptsDir, stage, version);
  }
  writeManifest(promptsDir, {
    version: 1,
    stages: Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, { current: version }])),
  });
  return promptsDir;
}

/** A loader over a seeded tree, with an empty injected environment. */
function loaderFor(promptsDir: string, cache = true): PromptLoader {
  return createPromptLoader({ promptsDir, env: {}, cache });
}

/** A recording logger, so the debug diagnostics can be asserted. */
interface RecordedLog {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

function recordingLogger(): { readonly logger: Logger; readonly records: RecordedLog[] } {
  const records: RecordedLog[] = [];
  const record = (level: string) => (message: string, fields?: LogFields) => {
    records.push({ level, message, fields });
  };
  const logger: Logger = {
    level: 'debug',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    child: () => logger,
  };
  return { logger, records };
}

/** Whether this host lets the test process create a symbolic link at all. */
const CAN_SYMLINK = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'debuggen-symlink-probe-'));
  try {
    writeFileSync(join(probe, 'target.txt'), 'probe', 'utf8');
    symlinkSync(join(probe, 'target.txt'), join(probe, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/**
 * Creates a named pipe, the way a shell would.
 *
 * `node:fs` has no `mkfifo`, so the one portable way to plant a FIFO from a
 * test is the POSIX utility. Failure is reported as `false` rather than thrown
 * for the same reason {@link CAN_SYMLINK} exists: a Windows runner, an image
 * without coreutils and a hardened sandbox must read as "this host cannot host
 * the case", never as a loader defect.
 */
function tryMakeFifo(path: string): boolean {
  try {
    execFileSync('mkfifo', [path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Whether this host lets the test process create a named pipe at all. */
const CAN_MKFIFO = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'debuggen-fifo-probe-'));
  try {
    return tryMakeFifo(join(probe, 'probe.fifo'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/**
 * The error of a result that must have failed.
 *
 * Asserts the failure carries a real `DebuggenError` as well as returning it,
 * so a case cannot pass against a rejection that lost its code on the way out.
 * The code is additionally required to be a member of the **closed**
 * `DEBUGGEN_ERROR_CODES` vocabulary: every failure in this file therefore
 * carries a code two user interfaces and the protocol's `error` payload already
 * know how to render, and an invented string — `'prompt_missing'`, say — fails
 * here rather than reaching a panel as an unrenderable code.
 */
function errorOf<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (isOk(result)) {
    throw new Error('Expected a failed result, but the call succeeded.');
  }
  if (!DebuggenError.is(result.error)) {
    throw new Error('Expected the failure to carry a DebuggenError.');
  }
  if (!(DEBUGGEN_ERROR_CODES as readonly string[]).includes(result.error.code)) {
    throw new Error(`'${result.error.code}' is not one of DEBUGGEN_ERROR_CODES.`);
  }
  return result.error;
}

/**
 * The value of a result that must have succeeded.
 *
 * The counterpart to {@link errorOf}: it removes the `isOk(...) ? ... : ''`
 * ternaries a narrowing-only assertion needs, so a case that meant to assert a
 * body cannot quietly assert a fallback string instead.
 */
function valueOf<T>(result: Result<T, DebuggenError>): T {
  if (isErr(result)) {
    throw new Error(`Expected a successful result, but it failed: ${result.error.message}`);
  }
  return result.value;
}

/**
 * Everything a failure reports, as one searchable string: message, hint and
 * details.
 *
 * Used by the cases that assert an *absence* — that no prompt body and no
 * foreign file's contents travelled into a rejection. Asserting against the
 * message alone would miss a leak through `details`, which is the field an
 * error's JSON payload carries furthest.
 */
function reportOf(error: DebuggenError): string {
  return [error.message, error.hint ?? '', JSON.stringify(error.details ?? {})].join('\n');
}

/*
 * ---------------------------------------------------------------------------
 * The manifest contract
 * ---------------------------------------------------------------------------
 */

/**
 * Version stems no manifest and no session record may name. Shared by the
 * schema cases, the manifest cases and the traversal guard, so all three refuse
 * exactly the same vocabulary — a value that one layer accepts and another
 * refuses is the gap this table exists to close.
 */
const ILLEGAL_VERSIONS: readonly string[] = ['1', 'v1', 'v0001', 'v001.md', 'V001', ''];

describe('PROMPT_VERSION_PATTERN', () => {
  it('matches a three-digit stem and nothing else', () => {
    expect(PROMPT_VERSION_PATTERN.test('v001')).toBe(true);
    expect(PROMPT_VERSION_PATTERN.test('v999')).toBe(true);
    for (const version of ILLEGAL_VERSIONS) {
      expect(PROMPT_VERSION_PATTERN.test(version)).toBe(false);
    }
  });

  it('carries no global flag, so repeated tests of one value agree', () => {
    // A `g` regular expression keeps a mutable `lastIndex`, which makes
    // `.test()` answer true, then false, then true for the same input. The
    // loader calls this pattern once per stage of a manifest and again on every
    // `loadVersion`, so a stateful instance would admit a rejected version on
    // every second call — and pass any test that checks one value once.
    expect(PROMPT_VERSION_PATTERN.global).toBe(false);
    expect(PROMPT_VERSION_PATTERN.flags).toBe('');
    expect(PROMPT_VERSION_PATTERN.test('v001')).toBe(true);
    expect(PROMPT_VERSION_PATTERN.test('v001')).toBe(true);
    expect(PROMPT_VERSION_PATTERN.lastIndex).toBe(0);
  });
});

describe('promptManifestSchema', () => {
  it('accepts a manifest that names a current version for every stage', () => {
    const manifest = {
      version: 1,
      stages: Object.fromEntries(
        PROMPT_STAGES.map((stage) => [stage, { current: 'v001', available: ['v001'] }]),
      ),
    };

    const parsed = promptManifestSchema.safeParse(manifest);

    expect(parsed.success).toBe(true);
  });

  it('rejects a manifest that omits a stage', () => {
    const manifest = {
      version: 1,
      stages: { understand: { current: 'v001' } },
    };

    expect(promptManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects an unknown stage key and names it, so a typo fails at load', () => {
    const stages: Record<string, { current: string }> = Object.fromEntries(
      PROMPT_STAGES.map((stage) => [stage, { current: 'v001' }]),
    );
    // A plausible misspelling of a real stage, complete beside it: the
    // manifest is otherwise valid, so only the unknown key can fail it.
    stages.analyse = { current: 'v001' };

    const parsed = promptManifestSchema.safeParse({ version: 1, stages });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toContain('analyse');
  });

  it('rejects a missing stage by naming the key that has no entry', () => {
    const parsed = promptManifestSchema.safeParse({
      version: 1,
      stages: Object.fromEntries(
        PROMPT_STAGES.filter((stage) => stage !== 'investigate').map((stage) => [
          stage,
          { current: 'v001' },
        ]),
      ),
    });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toContain('investigate');
  });

  for (const current of ILLEGAL_VERSIONS) {
    it(`rejects the current version ${JSON.stringify(current)}`, () => {
      const stages = Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, { current: 'v001' }]));

      const parsed = promptManifestSchema.safeParse({
        version: 1,
        stages: { ...stages, plan: { current } },
      });

      expect(parsed.success).toBe(false);
    });

    it(`rejects ${JSON.stringify(current)} in an available list`, () => {
      const stages = Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, { current: 'v001' }]));

      const parsed = promptManifestSchema.safeParse({
        version: 1,
        stages: { ...stages, plan: { current: 'v001', available: ['v001', current] } },
      });

      expect(parsed.success).toBe(false);
    });
  }

  it('rejects a manifest whose version is not the literal 1', () => {
    const stages = Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, { current: 'v001' }]));

    expect(promptManifestSchema.safeParse({ version: 2, stages }).success).toBe(false);
  });

  it('tolerates documentation members beside the data it requires', () => {
    const stages = Object.fromEntries(
      PROMPT_STAGES.map((stage) => [stage, { current: 'v001', '// note': 'why this version' }]),
    );

    const parsed = promptManifestSchema.safeParse({
      version: 1,
      '// purpose': 'selects the current prompt version per stage',
      stages,
    });

    expect(parsed.success).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Directory resolution
 * ---------------------------------------------------------------------------
 */

describe('createPromptLoader directory resolution', () => {
  it('exposes the configured directory and manifest path for diagnostics', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));

    const loader = loaderFor(promptsDir);

    expect(loader.promptsDir).toBe(promptsDir);
    expect(loader.manifestPath).toBe(join(promptsDir, 'manifest.json'));
  });

  it('performs no I/O at construction time, even for a directory that is absent', () => {
    const loader = createPromptLoader({ promptsDir: join(createSandbox(), 'absent'), env: {} });

    expect(loader.promptsDir.endsWith('absent')).toBe(true);
  });

  it('reads the directory from DEBUGGEN_PROMPTS_DIR when no option is given', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));

    const loader = createPromptLoader({ env: { DEBUGGEN_PROMPTS_DIR: promptsDir } });
    const prompt = loader.load('understand');

    expect(isOk(prompt)).toBe(true);
    expect(loader.promptsDir).toBe(promptsDir);
  });

  it('prefers an explicit option over the environment variable', () => {
    const sandbox = createSandbox();
    const chosen = seedPromptTree(join(sandbox, 'chosen'));
    const ignored = seedPromptTree(join(sandbox, 'ignored'), 'v002');

    const loader = createPromptLoader({
      promptsDir: chosen,
      env: { DEBUGGEN_PROMPTS_DIR: ignored },
    });
    const prompt = loader.load('plan');

    expect(isOk(prompt)).toBe(true);
    expect(loader.promptsDir).toBe(chosen);
    expect(isOk(prompt) ? prompt.value.version : '').toBe('v001');
  });

  it('treats a blank option as absent and falls through to the environment', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));

    const loader = createPromptLoader({
      promptsDir: '   ',
      env: { DEBUGGEN_PROMPTS_DIR: promptsDir },
    });

    expect(loader.promptsDir).toBe(promptsDir);
    expect(isOk(loader.load('followup'))).toBe(true);
  });

  it('fails with a configuration error naming both channels when neither is set', () => {
    const loader = createPromptLoader({ env: { DEBUGGEN_PROMPTS_DIR: '' } });

    const error = errorOf(loader.load('analyze'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(loader.promptsDir).toBe('');
    expect(loader.manifestPath).toBe('');
    expect(error.hint).toContain('promptsDir');
    expect(error.hint).toContain('DEBUGGEN_PROMPTS_DIR');
  });

  it('does not guess a directory when the variable is absent altogether', () => {
    // `env: {}` is the packaged case with nothing configured: no variable at
    // all, rather than a variable set to the empty string. A loader that fell
    // back to a `process.cwd()`-relative guess would answer something here —
    // the assertions below are that it answers nothing, and says which two
    // channels could have supplied a directory.
    const loader = createPromptLoader({ env: {} });

    const error = errorOf(loader.load('investigate'));

    expect(loader.promptsDir).toBe('');
    expect(loader.manifestPath).toBe('');
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('No prompts directory is configured');
    expect(error.hint).toContain('promptsDir');
    expect(error.hint).toContain('DEBUGGEN_PROMPTS_DIR');
    // Nothing on disk was consulted, so no path can appear in the report.
    expect(reportOf(error)).not.toContain(process.cwd());
  });

  it('distinguishes an absent directory from a path that is not a directory', () => {
    const sandbox = createSandbox();
    const absent = join(sandbox, 'absent');
    const notADirectory = join(sandbox, 'prompts');
    writeFileSync(notADirectory, 'not a directory\n', 'utf8');

    const absentError = errorOf(loaderFor(absent).load('understand'));
    const fileError = errorOf(loaderFor(notADirectory).load('understand'));

    expect(absentError.code).toBe('CONFIG_INVALID');
    expect(absentError.message).toContain('does not exist');
    expect(absentError.details?.promptsDir).toBe(absent);

    expect(fileError.code).toBe('CONFIG_INVALID');
    expect(fileError.message).toContain('is not a directory');
    expect(fileError.details?.promptsDir).toBe(notADirectory);

    // Two conditions with two different fixes: "point me somewhere that
    // exists" and "point me at a directory, not a file".
    expect(fileError.message).not.toBe(absentError.message);
    // The file's contents are not what the failure is about, and do not travel.
    expect(reportOf(fileError)).not.toContain('not a directory\n');
  });

  it('reports a configured path that is not a usable path at all', () => {
    const error = errorOf(loaderFor(`${createSandbox()}/prompts\u0000`).load('understand'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('is not a usable path');
    expect(error.message).not.toContain('\u0000');
  });

  it('reports a prompt path that is a directory rather than a file', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    rmSync(join(promptsDir, 'plan', 'v001.md'));
    mkdirSync(join(promptsDir, 'plan', 'v001.md'), { recursive: true });

    const error = errorOf(loaderFor(promptsDir).load('plan'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('is a directory, not a file');
  });

  it('resolves a relative directory against the working directory and says so', () => {
    const { logger, records } = recordingLogger();

    createPromptLoader({ promptsDir: 'prompts-relative', env: {}, logger });

    expect(records.some((entry) => entry.level === 'debug')).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Manifest loading and version selection
 * ---------------------------------------------------------------------------
 */

describe('PromptLoader.load', () => {
  it('loads the version the manifest names as current', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writePrompt(promptsDir, 'analyze', 'v002');
    writeManifest(promptsDir, {
      version: 1,
      stages: Object.fromEntries(
        PROMPT_STAGES.map((stage) => [
          stage,
          { current: stage === 'analyze' ? 'v002' : 'v001', available: ['v001', 'v002'] },
        ]),
      ),
    });

    const prompt = loaderFor(promptsDir).load('analyze');

    expect(isOk(prompt)).toBe(true);
    if (isOk(prompt)) {
      expect(prompt.value.stage).toBe('analyze');
      expect(prompt.value.version).toBe('v002');
      expect(prompt.value.path).toBe(join(promptsDir, 'analyze', 'v002.md'));
      expect(prompt.value.text).toContain('v002');
    }
  });

  it('loads a prompt for every known stage', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const loader = loaderFor(promptsDir);

    // The tuple is iterated rather than the six names listed, so a stage added
    // to PROMPT_STAGES is covered by this case in the same edit.
    for (const stage of PROMPT_STAGES) {
      const prompt = valueOf(loader.load(stage));

      expect(prompt.stage).toBe(stage);
      expect(prompt.version).toBe('v001');
      expect(isAbsolute(prompt.path)).toBe(true);
      // Inside the sandbox, and inside this stage's own directory.
      expect(isWithin(promptsDir, prompt.path)).toBe(true);
      expect(prompt.path).toBe(join(promptsDir, stage, 'v001.md'));
      expect(prompt.text.length).toBeGreaterThan(0);
      expect(prompt.text).toContain(stage);
    }
  });

  it('publishes exactly stage, version and text, plus the diagnostic path', () => {
    // The published shape itself, pinned by its own keys rather than by the
    // members a case happens to read. The contract is `{ stage, version, text
    // }` — `text` is the content a stage renders and `version` is what the
    // session records as its provenance — with `path` as an additive
    // diagnostic. A rename of the content member, or a second alias for it
    // alongside (`body`, say, kept "for compatibility"), passes every other
    // case in this file and fails here: one string with two names is how a
    // caller ends up sending the stale one.
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));

    const prompt = valueOf(loaderFor(promptsDir).load('understand'));

    expect(Object.keys(prompt).sort()).toEqual(['path', 'stage', 'text', 'version']);
    expect(typeof prompt.text).toBe('string');
    expect(Object.hasOwn(prompt, 'body')).toBe(false);
    // Frozen, so a stage cannot edit the text of a prompt whose version it has
    // already recorded on the session.
    expect(Object.isFrozen(prompt)).toBe(true);
  });

  it('loads the current version even when a higher one sits beside it', () => {
    // The manifest, not the filenames, selects the version: a stage pinned to
    // 'v001' with 'v002' already written on disk must load 'v001'. A loader
    // that sorted the directory, or took the last entry it read, would answer
    // 'v002' here and would silently move every new session onto an
    // unreviewed prompt the moment one was added.
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writePrompt(promptsDir, 'investigate', 'v002');
    writePrompt(promptsDir, 'investigate', 'v003');

    const prompt = valueOf(loaderFor(promptsDir).load('investigate'));

    expect(prompt.version).toBe('v001');
    expect(prompt.text).toContain('revision v001');
  });

  it('reports the missing stages when the manifest leaves one out', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writeManifest(promptsDir, {
      version: 1,
      stages: Object.fromEntries(
        PROMPT_STAGES.filter((stage) => stage !== 'followup').map((stage) => [
          stage,
          { current: 'v001' },
        ]),
      ),
    });

    const error = errorOf(loaderFor(promptsDir).load('understand'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(JSON.stringify(error.details)).toContain('followup');
  });

  it('refuses a manifest whose version is not the literal 1', () => {
    // The manifest is data this product reads on every start. A second shape
    // gets a second version number and an explicit branch here, never a
    // silently tolerated variation.
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writeManifest(promptsDir, {
      version: 2,
      stages: Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, { current: 'v001' }])),
    });

    const error = errorOf(loaderFor(promptsDir).load('understand'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('does not match the manifest schema');
    expect(JSON.stringify(error.details)).toContain('version');
  });

  it('refuses an unknown stage key and names it in the failure', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writeManifest(promptsDir, {
      version: 1,
      stages: {
        ...Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, { current: 'v001' }])),
        analyse: { current: 'v001' },
      },
    });

    // The failure has to name the key: a developer reading it is looking at a
    // manifest whose six real entries are all correct, and the only actionable
    // fact is which seventh key is not recognised.
    const error = errorOf(loaderFor(promptsDir).load('understand'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(JSON.stringify(error.details)).toContain('analyse');
  });

  for (const current of ILLEGAL_VERSIONS) {
    it(`refuses a manifest whose current version is ${JSON.stringify(current)}`, () => {
      const promptsDir = join(createSandbox(), 'prompts');
      seedPromptTree(promptsDir);
      writeManifest(promptsDir, {
        version: 1,
        stages: {
          ...Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, { current: 'v001' }])),
          plan: { current },
        },
      });

      const error = errorOf(loaderFor(promptsDir).load('plan'));

      expect(error.code).toBe('CONFIG_INVALID');
      // The version never became a path: the manifest is refused as a whole,
      // so nothing was opened under the stage directory.
      expect(reportOf(error)).not.toContain(join(promptsDir, 'plan', `${current}.md`));
    });
  }

  it('reports invalid JSON without quoting the file', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writeFileSync(
      join(promptsDir, 'manifest.json'),
      '{ "version": 1, "stages": { "understand": { "current": "v001" } ',
      'utf8',
    );

    const error = errorOf(loaderFor(promptsDir).load('understand'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toBe('The prompt manifest is not valid JSON.');
    expect(JSON.stringify(error.details)).not.toContain('current');
  });

  it('reports an absent manifest distinguishably from an absent directory', () => {
    const sandbox = createSandbox();
    const promptsDir = join(sandbox, 'prompts');
    for (const stage of PROMPT_STAGES) {
      writePrompt(promptsDir, stage, 'v001');
    }

    const noManifest = errorOf(loaderFor(promptsDir).load('understand'));
    const noDirectory = errorOf(loaderFor(join(sandbox, 'absent')).load('understand'));

    expect(noManifest.code).toBe('CONFIG_INVALID');
    expect(noManifest.message).toContain('The prompt manifest was not found');
    expect(noManifest.hint).toContain('manifest.json');

    // "The tree is there but has no manifest" and "there is no tree" are two
    // different mistakes with two different fixes, so the two failures must not
    // read the same. The hint is what a developer acts on.
    expect(noDirectory.message).toContain('does not exist');
    expect(noManifest.message).not.toBe(noDirectory.message);
    expect(noManifest.hint).not.toBe(noDirectory.hint);
  });

  it('reports a prompt file the manifest names but the tree does not have', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    rmSync(join(promptsDir, 'plan', 'v001.md'));

    const error = errorOf(loaderFor(promptsDir).load('plan'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('was not found');
  });

  it('refuses an empty prompt file rather than sending nothing to a model', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writeFileSync(join(promptsDir, 'plan', 'v001.md'), '   \n\n', 'utf8');

    const error = errorOf(loaderFor(promptsDir).load('plan'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('is empty');
  });

  it('strips a byte-order mark and normalises the trailing newline', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writeFileSync(
      join(promptsDir, 'plan', 'v001.md'),
      '\uFEFF# plan\n\nBody text.\n\n\n  \n',
      'utf8',
    );

    const prompt = loaderFor(promptsDir).load('plan');

    expect(isOk(prompt)).toBe(true);
    if (isOk(prompt)) {
      expect(prompt.value.text.startsWith('# plan')).toBe(true);
      expect(prompt.value.text).toBe('# plan\n\nBody text.\n');
    }
  });

  it('rejects a stage outside the known set before it can become a path', () => {
    const loader = loaderFor(seedPromptTree(join(createSandbox(), 'prompts')));

    const error = errorOf(loader.load('../../etc' as unknown as PromptStage));

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.message).toContain('is not a known prompt stage');
  });
});

/*
 * ---------------------------------------------------------------------------
 * versions()
 * ---------------------------------------------------------------------------
 */

describe('PromptLoader.versions', () => {
  it('returns one current version per stage, frozen', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writePrompt(promptsDir, 'followup', 'v003');
    writeManifest(promptsDir, {
      version: 1,
      stages: Object.fromEntries(
        PROMPT_STAGES.map((stage) => [stage, { current: stage === 'followup' ? 'v003' : 'v001' }]),
      ),
    });

    const versions = valueOf(loaderFor(promptsDir).versions());

    expect(Object.keys(versions).sort()).toEqual([...PROMPT_STAGES].sort());
    // Exactly one entry per stage, each the version that stage's manifest entry
    // names — this record is what a session persists as its prompt-version map,
    // so a stage missing from it, or carrying another stage's version, would be
    // recorded as the provenance of an artifact it did not produce.
    for (const stage of PROMPT_STAGES) {
      expect(versions[stage]).toBe(stage === 'followup' ? 'v003' : 'v001');
    }
    expect(Object.isFrozen(versions)).toBe(true);
  });

  it('fails rather than answering a partial map', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writeManifest(promptsDir, { version: 1, stages: { understand: { current: 'v001' } } });

    const error = errorOf(loaderFor(promptsDir).versions());

    expect(error.code).toBe('CONFIG_INVALID');
  });
});

/*
 * ---------------------------------------------------------------------------
 * loadVersion: the reopened-session path
 * ---------------------------------------------------------------------------
 */

describe('PromptLoader.loadVersion', () => {
  it('loads a superseded version that is neither current nor listed as available', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writePrompt(promptsDir, 'analyze', 'v002');
    writePrompt(promptsDir, 'analyze', 'v003');
    writeManifest(promptsDir, {
      version: 1,
      stages: Object.fromEntries(
        PROMPT_STAGES.map((stage) => [
          stage,
          // 'v001' is deliberately absent from `available` for the analyze
          // stage: a session that used it must still be able to reopen.
          { current: stage === 'analyze' ? 'v003' : 'v001', available: ['v003'] },
        ]),
      ),
    });

    const loader = loaderFor(promptsDir);
    const superseded = valueOf(loader.loadVersion('analyze', 'v001'));

    // THIS CASE IS A TRIPWIRE. `loadVersion` deliberately ignores the manifest:
    // a reopened session and a follow-up question are answered with the
    // versions recorded on `SessionRecord.promptVersions`, and a prompt bump is
    // precisely the event that makes those versions historical. Tightening this
    // method to "the manifest's current version only" — or to its `available`
    // list, which this fixture omits 'v001' from on purpose — would break
    // session reopening on the first bump, silently, on a code path no manifest
    // test touches. If this case ever fails, the reopen path is broken; do not
    // "fix" it by relaxing the assertion.
    expect(superseded.version).toBe('v001');
    expect(superseded.text).toContain('revision v001');
    expect(superseded.path).toBe(join(promptsDir, 'analyze', 'v001.md'));
    // The manifest's own answer is still the current version, unaffected.
    expect(valueOf(loader.load('analyze')).version).toBe('v003');
  });

  it('loads a recorded version even when the manifest is unreadable', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    writeFileSync(join(promptsDir, 'manifest.json'), 'not json at all', 'utf8');

    const loader = loaderFor(promptsDir);

    // The manifest-dependent path fails; the session-recorded path does not.
    expect(isErr(loader.load('understand'))).toBe(true);
    expect(isOk(loader.loadVersion('understand', 'v001'))).toBe(true);
  });

  it('reports a version that was recorded but is no longer on disk as not found', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const loader = loaderFor(promptsDir);

    const error = errorOf(loader.loadVersion('plan', 'v999'));

    // Not found, and reported as such: 'v999' is a perfectly legal address, so
    // this is neither a policy refusal (`FS_UNSAFE_PATH`) nor an escape from
    // the prompts directory (`PATH_OUTSIDE_PROJECT`). Collapsing the three
    // would send a developer hunting for a symbolic link that is not there.
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.code).not.toBe('PATH_OUTSIDE_PROJECT');
    expect(error.code).not.toBe('FS_UNSAFE_PATH');
    expect(error.message).toContain("version 'v999'");
    expect(error.message).toContain('was not found');
    expect(error.hint).toContain('plan/v999.md');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The traversal guard
 * ---------------------------------------------------------------------------
 */

describe('the traversal guard', () => {
  const rejectedVersions: readonly string[] = [
    '..',
    '.',
    '../v001',
    'v001/../../../etc/passwd',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'v001.md',
    'v1',
    'v0001',
    'V001',
    'v00a',
    '%2e%2e%2fv001',
    'v001\u0000',
    'v001\u001b[0m',
    '',
    '   ',
  ];

  for (const version of rejectedVersions) {
    it(`refuses the version ${JSON.stringify(version)} without touching the filesystem`, () => {
      const loader = loaderFor(seedPromptTree(join(createSandbox(), 'prompts')));

      const error = errorOf(loader.loadVersion('plan', version));

      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(error.message).toContain('is not a prompt version');
    });
  }

  const rejectedStages: readonly string[] = [
    '..',
    '../plan',
    'plan/../../etc',
    '/plan',
    'plan\u0000',
    'analyse',
    '',
  ];

  for (const stage of rejectedStages) {
    it(`refuses the stage ${JSON.stringify(stage)} before it becomes a path`, () => {
      const loader = loaderFor(seedPromptTree(join(createSandbox(), 'prompts')));

      const error = errorOf(loader.loadVersion(stage as unknown as PromptStage, 'v001'));

      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(error.message).toContain('is not a known prompt stage');
    });
  }

  it('rejects a malformed version before the filesystem is consulted at all', () => {
    // The ordering proof described in this file's header: the prompts directory
    // does not exist, so every code path that touches the filesystem answers
    // CONFIG_INVALID. Reading FS_UNSAFE_PATH back from this loader is the
    // observation that the guard ran first and nothing was opened.
    const absentDir = join(createSandbox(), 'absent');
    const loader = loaderFor(absentDir);

    const guarded = errorOf(loader.loadVersion('plan', '../../etc/passwd'));
    const wouldTouchDisk = errorOf(loader.loadVersion('plan', 'v001'));

    expect(guarded.code).toBe('FS_UNSAFE_PATH');
    expect(wouldTouchDisk.code).toBe('CONFIG_INVALID');
    expect(wouldTouchDisk.message).toContain('does not exist');
    // Nothing about the directory appears in the guard's report, because the
    // guard never asked about it.
    expect(reportOf(guarded)).not.toContain(absentDir);
  });

  it('refuses an illegally named file that genuinely exists on disk', () => {
    // Existence is not an argument. Each of these files is written into the
    // stage directory under a name outside PROMPT_VERSION_PATTERN, and each is
    // then asked for by exactly the name it has: a loader that built the path
    // from the caller's string and opened whatever was there would succeed,
    // which is the failure mode this asserts against.
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const loader = loaderFor(promptsDir);

    for (const stem of ['v1', 'v0001', 'latest', 'v001.md']) {
      writeFileSync(join(promptsDir, 'plan', `${stem}.md`), `# ${stem}\n`, 'utf8');

      const error = errorOf(loader.loadVersion('plan', stem));

      expect(error.code).toBe('FS_UNSAFE_PATH');
      expect(error.message).toContain('is not a prompt version');
    }
  });

  it('does not open the file an unguarded implementation would have computed', () => {
    // The complement of the ordering proof: here the directory is real and a
    // readable file is planted at exactly the path a naive
    // `join(promptsDir, stage, version + '.md')` produces for an empty stage —
    // '<promptsDir>/v001.md'. The call must still fail, so the assertion is
    // that the guard, and not the absence of a file, is what refused it.
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const plantedPath = join(promptsDir, 'v001.md');
    writeFileSync(plantedPath, '# reachable only by a loader that does not guard\n', 'utf8');

    const error = errorOf(loaderFor(promptsDir).loadVersion('' as unknown as PromptStage, 'v001'));

    expect(error.code).toBe('FS_UNSAFE_PATH');
    expect(error.message).toContain('is not a known prompt stage');
    expect(reportOf(error)).not.toContain('reachable only by a loader that does not guard');
    expect(reportOf(error)).not.toContain(plantedPath);
  });

  it('rejects an unknown stage before the filesystem is consulted at all', () => {
    const absentDir = join(createSandbox(), 'absent');
    const loader = loaderFor(absentDir);

    // Both entry points refuse it, and neither consults the manifest or the
    // directory: `load` would otherwise have to read the manifest to discover
    // which version to ask for.
    const viaLoad = errorOf(loader.load('/absolute' as unknown as PromptStage));
    const viaLoadVersion = errorOf(
      loader.loadVersion('../../etc' as unknown as PromptStage, 'v001'),
    );

    expect(viaLoad.code).toBe('FS_UNSAFE_PATH');
    expect(viaLoadVersion.code).toBe('FS_UNSAFE_PATH');
    expect(reportOf(viaLoad)).not.toContain(absentDir);
    expect(reportOf(viaLoadVersion)).not.toContain(absentDir);
    // The report names the closed set a stage has to come from, which is the
    // one actionable fact about the rejection.
    expect(JSON.stringify(viaLoad.details)).toContain('understand');
  });

  it('does not echo a control character back into the failure message', () => {
    const loader = loaderFor(seedPromptTree(join(createSandbox(), 'prompts')));

    const error = errorOf(loader.loadVersion('plan', 'v001\u0000\u001b'));

    expect(error.message).not.toContain('\u0000');
    expect(error.message).not.toContain('\u001b');
    expect(error.message).toContain('\uFFFD');
  });

  it.skipIf(!CAN_SYMLINK)(
    'refuses a prompt file that is a symbolic link out of the prompts directory',
    () => {
      const sandbox = createSandbox();
      const promptsDir = seedPromptTree(join(sandbox, 'prompts'));
      const outside = join(sandbox, 'outside');
      mkdirSync(outside, { recursive: true });
      const secret = join(outside, 'secret.md');
      // A distinctive marker, so the assertions below can prove the bytes of
      // the linked-to file never reached the failure that refused to read it.
      writeFileSync(secret, '# not a prompt\nTHE-CONTENTS-OF-THE-LINKED-FILE\n', 'utf8');
      symlinkSync(secret, join(promptsDir, 'plan', 'v002.md'));

      const error = errorOf(loaderFor(promptsDir).loadVersion('plan', 'v002'));

      expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
      // Neither the contents nor the location the link pointed at: a refusal
      // must not become an oracle for probing the developer's disk, and an
      // error object travels into logs and across a process boundary into two
      // user interfaces.
      const report = reportOf(error);
      expect(report).not.toContain('THE-CONTENTS-OF-THE-LINKED-FILE');
      expect(report).not.toContain('secret.md');
      expect(report).not.toContain(outside);
      // What it does say is the stage, the version and the root — everything
      // the caller already knew.
      expect(error.details?.stage).toBe('plan');
      expect(error.details?.version).toBe('v002');
      expect(error.details?.promptsDir).toBe(promptsDir);
    },
  );

  it.skipIf(!CAN_SYMLINK)(
    'refuses a stage directory that is a symbolic link out of the prompts directory',
    () => {
      const sandbox = createSandbox();
      const promptsDir = seedPromptTree(join(sandbox, 'prompts'));
      const outside = join(sandbox, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(
        join(outside, 'v001.md'),
        '# not a prompt\nTHE-CONTENTS-OF-THE-LINKED-DIRECTORY\n',
        'utf8',
      );
      rmSync(join(promptsDir, 'followup'), { recursive: true, force: true });
      symlinkSync(outside, join(promptsDir, 'followup'));

      // The containment check applies to the whole resolved path, not just its
      // last component: the file name here is a perfectly ordinary 'v001.md',
      // and only the directory it sits in leads out of the prompts tree. The
      // stage directory is also the position `load` would traverse, so both
      // entry points are asserted.
      const loader = loaderFor(promptsDir);
      const viaLoadVersion = errorOf(loader.loadVersion('followup', 'v001'));
      const viaLoad = errorOf(loader.load('followup'));

      expect(viaLoadVersion.code).toBe('PATH_OUTSIDE_PROJECT');
      expect(viaLoad.code).toBe('PATH_OUTSIDE_PROJECT');
      expect(reportOf(viaLoadVersion)).not.toContain('THE-CONTENTS-OF-THE-LINKED-DIRECTORY');
      expect(reportOf(viaLoadVersion)).not.toContain(outside);
    },
  );

  it.skipIf(!CAN_SYMLINK)('treats a prefix-sibling directory as outside the root', () => {
    const sandbox = createSandbox();
    const promptsDir = seedPromptTree(join(sandbox, 'prompts'));
    // '<dir>-other' shares the root's textual prefix and is NOT inside it.
    const sibling = join(sandbox, 'prompts-other');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'v002.md'), '# not a prompt\n', 'utf8');
    symlinkSync(join(sibling, 'v002.md'), join(promptsDir, 'plan', 'v002.md'));

    const error = errorOf(loaderFor(promptsDir).loadVersion('plan', 'v002'));

    expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
  });

  it.skipIf(!CAN_SYMLINK)('accepts a link that stays inside the prompts directory', () => {
    const sandbox = createSandbox();
    const promptsDir = seedPromptTree(join(sandbox, 'prompts'));
    symlinkSync(join(promptsDir, 'plan', 'v001.md'), join(promptsDir, 'plan', 'v002.md'));

    const prompt = loaderFor(promptsDir).loadVersion('plan', 'v002');

    expect(isOk(prompt)).toBe(true);
    // The resolved real path is reported, which is the file that was read.
    expect(isOk(prompt) ? prompt.value.path : '').toBe(join(promptsDir, 'plan', 'v001.md'));
  });
});

/*
 * ---------------------------------------------------------------------------
 * The bounded read
 * ---------------------------------------------------------------------------
 *
 * The loader opens a resolved prompt path with no-follow, non-blocking
 * semantics, requires `fstat` to report a regular file, and refuses a size
 * above the subject's ceiling before it reads a byte. The cases below drive
 * each of those decisions from the outside, because every one of them is
 * invisible in a passing read: a loader that called `readFileSync` answers
 * identically for every well-formed file in this suite and hangs forever on the
 * first case here.
 */

/**
 * The loader's two documented ceilings, restated.
 *
 * They are module constants rather than exports on purpose — a ceiling is not
 * something a caller configures — so these cases pin the *behaviour* at the
 * boundary instead of reading the numbers back. Restating them here is what
 * makes a silent change to either one fail: the case that loads a body one byte
 * under the prompt ceiling, and the case that refuses one byte over it, cannot
 * both pass if the number moves.
 */
const PROMPT_BYTE_CEILING = 256 * 1024;
const MANIFEST_BYTE_CEILING = 64 * 1024;

/**
 * A well-formed prompt body of exactly `bytes` bytes.
 *
 * ASCII only, so a character is a byte and the size a case asks for is the size
 * on disk, and terminated with a single newline and no other trailing
 * whitespace, so the loader's normalisation returns the string unchanged — which
 * is what lets a case assert the loaded text byte for byte rather than merely
 * asserting its length.
 */
function paddedPrompt(bytes: number): string {
  const header = '# prompt\n\nInstructions for a stage.\n\n';
  const padding = bytes - header.length - 1;
  if (padding < 0) {
    throw new Error(`A padded prompt needs at least ${header.length + 1} bytes.`);
  }
  return `${header}${'x'.repeat(padding)}\n`;
}

describe('the bounded read', () => {
  it.skipIf(!CAN_MKFIFO)('refuses a named pipe at a prompt path instead of blocking on it', () => {
    // THE OBSERVATION IS THAT THIS CASE RETURNS AT ALL. The pipe below has no
    // writer and never gets one, so a blocking `open` — which is what
    // `readFileSync` performs — never returns, and this case would fail by the
    // runner's timeout with the whole file's worker stuck. It returns because
    // the loader puts O_NONBLOCK in its flag word, and then refuses the pipe on
    // its kind rather than on its contents, of which a pipe has none.
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const promptPath = join(promptsDir, 'plan', 'v001.md');
    rmSync(promptPath);
    expect(tryMakeFifo(promptPath)).toBe(true);

    const error = errorOf(loaderFor(promptsDir).load('plan'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('is a named pipe, not a file');
    // The kind travels as a token a log line can group on, and the path as the
    // one thing a developer needs in order to go and look.
    expect(error.details?.kind).toBe('fifo');
    expect(error.details?.path).toBe(promptPath);
  });

  it('refuses a stage directory in the file position on its kind', () => {
    // A directory opens perfectly well read-only, so the kind check is what
    // refuses this, not the open and not a failed read.
    const promptsDir = join(createSandbox(), 'prompts');
    seedPromptTree(promptsDir);
    const promptPath = join(promptsDir, 'analyze', 'v001.md');
    rmSync(promptPath);
    mkdirSync(promptPath, { recursive: true });
    writeFileSync(join(promptPath, 'inner.md'), '# not the prompt\n', 'utf8');

    const error = errorOf(loaderFor(promptsDir).load('analyze'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('is a directory, not a file');
    expect(error.details?.kind).toBe('directory');
    expect(reportOf(error)).not.toContain('not the prompt');
  });

  it('refuses a prompt file one byte over the ceiling, and quotes none of it', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const promptPath = join(promptsDir, 'understand', 'v001.md');
    // A marker in the first bytes of the file: an implementation that read the
    // file and then measured it would have the contents in hand at the moment
    // it built this failure, and the assertions below are what stop them
    // travelling into a log or across a process boundary.
    const marker = 'MARKER-INSIDE-THE-OVERSIZED-FILE';
    const oversized = `${marker}\n${'x'.repeat(PROMPT_BYTE_CEILING + 1 - marker.length - 2)}\n`;
    expect(oversized.length).toBe(PROMPT_BYTE_CEILING + 1);
    writeFileSync(promptPath, oversized, 'utf8');

    const error = errorOf(loaderFor(promptsDir).load('understand'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('larger than the 256 KiB');
    expect(error.details?.bytes).toBe(PROMPT_BYTE_CEILING + 1);
    expect(error.details?.maxBytes).toBe(PROMPT_BYTE_CEILING);
    expect(error.details?.path).toBe(promptPath);
    const report = reportOf(error);
    expect(report).not.toContain(marker);
    expect(report).not.toContain('xxxx');
  });

  it('reads an ordinary prompt of a few kilobytes unchanged', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const body = paddedPrompt(4 * 1024);
    writeFileSync(join(promptsDir, 'investigate', 'v001.md'), body, 'utf8');

    const prompt = valueOf(loaderFor(promptsDir).load('investigate'));

    expect(prompt.text).toBe(body);
    expect(prompt.text.length).toBe(4 * 1024);
  });

  it('reads a prompt one byte under the ceiling byte for byte', () => {
    // The read is a loop over a descriptor, so a body this size is assembled
    // from however many chunks the platform hands back. Byte-for-byte equality
    // is what proves the loop neither truncates at the first short read nor
    // repeats a chunk, and that the probe for a further byte does not consume
    // one.
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const body = paddedPrompt(PROMPT_BYTE_CEILING - 1);
    writeFileSync(join(promptsDir, 'generate-panel', 'v001.md'), body, 'utf8');

    const prompt = valueOf(loaderFor(promptsDir).load('generate-panel'));

    expect(prompt.text).toBe(body);
    expect(prompt.text.length).toBe(PROMPT_BYTE_CEILING - 1);
  });

  it('bounds the manifest separately from, and more tightly than, a prompt body', () => {
    // One size, two answers: the two subjects are bounded for different
    // reasons, and a single shared ceiling would have to be the larger of the
    // two, which would leave the manifest effectively unbounded.
    expect(MANIFEST_BYTE_CEILING).toBeLessThan(PROMPT_BYTE_CEILING);
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const betweenTheCeilings = MANIFEST_BYTE_CEILING + 1;
    const body = paddedPrompt(betweenTheCeilings);
    writeFileSync(join(promptsDir, 'followup', 'v001.md'), body, 'utf8');

    // Inside the prompt ceiling: it loads, and `loadVersion` reads no manifest,
    // so this half is settled before the manifest below is rewritten.
    expect(valueOf(loaderFor(promptsDir).loadVersion('followup', 'v001')).text).toBe(body);

    // The same length at the manifest's path. The padding sits in a
    // documentation key this repository's JSON convention allows and the
    // manifest schema tolerates, so the file would parse if it were read — which
    // is what makes the failure below about the ceiling and nothing else.
    writeManifest(promptsDir, {
      version: 1,
      '// padding': 'x'.repeat(MANIFEST_BYTE_CEILING),
      stages: Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, { current: 'v001' }])),
    });

    const error = errorOf(loaderFor(promptsDir).load('followup'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toBe('The prompt manifest is larger than the 64 KiB this loader reads.');
    expect(error.message).not.toContain('not valid JSON');
    expect(Number(error.details?.bytes)).toBeGreaterThan(MANIFEST_BYTE_CEILING);
    expect(error.details?.maxBytes).toBe(MANIFEST_BYTE_CEILING);
    expect(reportOf(error)).not.toContain('xxxx');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Caching
 * ---------------------------------------------------------------------------
 */

describe('caching', () => {
  // Technique: every case here rewrites the fixture on disk between calls and
  // asserts which content comes back, because a read counter is not available
  // in this harness — Vitest refuses `vi.spyOn(fs, 'readFileSync')` with
  // "Module namespace is not configurable in ESM", and mocking the whole of
  // `node:fs` would also replace the `realpath`/`stat` calls the containment
  // cases above depend on. See this file's header.
  it('serves a second load from the cache, so the file is read once', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const loader = loaderFor(promptsDir);

    const first = loader.load('understand');
    writeFileSync(join(promptsDir, 'understand', 'v001.md'), '# rewritten\n', 'utf8');
    const second = loader.load('understand');

    expect(isOk(first) ? first.value.text : '').toContain('Instructions for the understand stage');
    expect(isOk(second) ? second.value.text : '').toBe(
      isOk(first) ? first.value.text : 'different',
    );
  });

  it('reads from disk again after clearCache', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const loader = loaderFor(promptsDir);

    loader.load('understand');
    writeFileSync(join(promptsDir, 'understand', 'v001.md'), '# rewritten\n', 'utf8');
    loader.clearCache();
    const afterClear = loader.load('understand');

    expect(isOk(afterClear) ? afterClear.value.text : '').toBe('# rewritten\n');
  });

  it('re-reads the manifest after clearCache, so a version bump is picked up', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const loader = loaderFor(promptsDir);

    expect(isOk(loader.load('analyze')) ? 'v001' : '').toBe('v001');

    writePrompt(promptsDir, 'analyze', 'v002');
    writeManifest(promptsDir, {
      version: 1,
      stages: Object.fromEntries(
        PROMPT_STAGES.map((stage) => [stage, { current: stage === 'analyze' ? 'v002' : 'v001' }]),
      ),
    });

    const stillCached = loader.load('analyze');
    loader.clearCache();
    const afterClear = loader.load('analyze');

    expect(isOk(stillCached) ? stillCached.value.version : '').toBe('v001');
    expect(isOk(afterClear) ? afterClear.value.version : '').toBe('v002');
  });

  it('never caches, and never needs clearing, with cache: false', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const loader = loaderFor(promptsDir, false);

    loader.load('investigate');
    writeFileSync(join(promptsDir, 'investigate', 'v001.md'), '# rewritten\n', 'utf8');
    const second = loader.load('investigate');

    expect(isOk(second) ? second.value.text : '').toBe('# rewritten\n');
  });

  it('keeps one loader out of another loader\u2019s cache', () => {
    // Two prompt trees, two loaders, one shared stage and version. The cache
    // lives in each loader's own closure, so the second loader must read its
    // own tree rather than serve the first one's body — the packaged extension
    // and the service can be pointed at different trees in one process, and a
    // cache keyed by stage and version alone would answer with the wrong
    // prompt while the session recorded the right version.
    const sandbox = createSandbox();
    const first = join(sandbox, 'first');
    const second = join(sandbox, 'second');
    seedPromptTree(first);
    seedPromptTree(second);
    writeFileSync(join(first, 'plan', 'v001.md'), '# plan from the first tree\n', 'utf8');
    writeFileSync(join(second, 'plan', 'v001.md'), '# plan from the second tree\n', 'utf8');

    const firstLoader = loaderFor(first);
    const secondLoader = loaderFor(second);
    const fromFirst = valueOf(firstLoader.load('plan'));
    const fromSecond = valueOf(secondLoader.load('plan'));

    expect(fromFirst.text).toBe('# plan from the first tree\n');
    expect(fromSecond.text).toBe('# plan from the second tree\n');
    expect(fromFirst.path).toBe(join(first, 'plan', 'v001.md'));
    expect(fromSecond.path).toBe(join(second, 'plan', 'v001.md'));

    // Clearing one loader's cache leaves the other's intact.
    firstLoader.clearCache();
    writeFileSync(join(second, 'plan', 'v001.md'), '# rewritten\n', 'utf8');
    expect(valueOf(secondLoader.load('plan')).text).toBe('# plan from the second tree\n');
  });

  it('does not cache failures, so a directory that appears later is picked up', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    const loader = loaderFor(promptsDir);

    const beforeItExists = loader.load('understand');
    seedPromptTree(promptsDir);
    const afterItExists = loader.load('understand');

    expect(isErr(beforeItExists)).toBe(true);
    expect(isOk(afterItExists)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * renderPrompt
 * ---------------------------------------------------------------------------
 */

describe('renderPrompt', () => {
  it('substitutes every placeholder it is given a value for', () => {
    const result = renderPrompt('Return output matching {{schema}} for {{stage}}.', {
      schema: '{"type":"object"}',
      stage: 'analyze',
    });

    expect(isOk(result)).toBe(true);
    expect(isOk(result) ? result.value : '').toBe(
      'Return output matching {"type":"object"} for analyze.',
    );
  });

  it('accepts whitespace inside the braces and repeated placeholders', () => {
    const result = renderPrompt('{{ stage }} then {{stage}} then {{  stage  }}', {
      stage: 'plan',
    });

    expect(isOk(result) ? result.value : '').toBe('plan then plan then plan');
  });

  it('substitutes a dotted key, which is one key and not a path expression', () => {
    // '{{context.question}}' names the single key 'context.question'. There is
    // no object traversal: a caller supplies the flattened key, which keeps the
    // grammar to one production and keeps a nested value from being reachable
    // by a name a prompt author did not write.
    const result = renderPrompt('{{context.question}} for {{context.stage}}', {
      'context.question': 'why is this slow',
      'context.stage': 'analyze',
    });

    expect(valueOf(result)).toBe('why is this slow for analyze');
  });

  it('does not read a nested object for a dotted key', () => {
    const values = { context: { question: 'nested' } } as unknown as Record<string, string>;

    const error = errorOf(renderPrompt('{{context.question}}', values));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.details?.missingPlaceholders).toEqual(['context.question']);
  });

  it('returns the template unchanged when it names no placeholder', () => {
    const template = 'A prompt with braces that are not placeholders: { } {{ }} {{-}}.';

    const result = renderPrompt(template, { unused: 'value' });

    expect(isOk(result) ? result.value : '').toBe(template);
  });

  it('returns the empty string for an empty template', () => {
    expect(valueOf(renderPrompt('', {}))).toBe('');
    expect(valueOf(renderPrompt('', { stage: 'plan' }))).toBe('');
  });

  it('has no template language beyond {{key}}', () => {
    // Asserted so the "logic-free" property is documented by test rather than
    // by comment. What the single production means for each shape:
    //   * '{{#if …}}' and '{{/if}}' are not placeholders at all — '#' and '/'
    //     are outside the key grammar — so they survive verbatim and report no
    //     missing value. There are no conditionals.
    //   * '{{}}' has no key, so it is not a placeholder either.
    //   * '{{{key}}}' is the ordinary placeholder '{{key}}' with a literal
    //     brace on each side; there is no triple-brace "unescaped" form,
    //     because nothing is escaped in the first place.
    const conditional = '{{#if stage}}only when set{{/if}}';
    expect(valueOf(renderPrompt(conditional, { stage: 'plan' }))).toBe(conditional);

    const loop = '{{#each files}}[one file]{{/each}}';
    expect(valueOf(renderPrompt(loop, {}))).toBe(loop);

    expect(valueOf(renderPrompt('{{}} {{ }}', {}))).toBe('{{}} {{ }}');

    expect(valueOf(renderPrompt('{{{stage}}}', { stage: 'plan' }))).toBe('{plan}');

    // No filters, no defaults: the pipe and the fallback are part of the key
    // grammar of other template languages, not of this one, so neither is
    // recognised and neither is reported as missing.
    const filtered = '{{stage|upper}} {{stage or "none"}}';
    expect(valueOf(renderPrompt(filtered, { stage: 'plan' }))).toBe(filtered);
  });

  it('reports every missing placeholder in one failure', () => {
    // All of them, not the first: a stage's prompt embeds its output schema and
    // its evidence-citation rule, so a renderer that stopped at the first gap
    // would have the caller fix one placeholder, run again, and find the next —
    // and a renderer that substituted an empty string instead would produce a
    // model call with no schema and no citation requirement at all.
    const result = renderPrompt('{{schema}} {{evidenceRule}} {{stage}} {{schema}}', {
      stage: 'plan',
    });

    const error = errorOf(result);

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('evidenceRule');
    expect(error.message).toContain('schema');
    // The count is part of the message, and a key named twice counts once.
    expect(error.message).toContain('2 placeholder(s)');
    expect(error.details?.missingPlaceholders).toEqual(['evidenceRule', 'schema']);
    expect(error.details?.missingPlaceholders).toHaveLength(2);
  });

  it('never re-scans substituted text, so a value cannot name another placeholder', () => {
    const result = renderPrompt('{{question}} and {{stage}}', {
      question: 'why does {{stage}} appear here',
      stage: 'plan',
    });

    expect(isOk(result) ? result.value : '').toBe('why does {{stage}} appear here and plan');
  });

  it('stringifies numbers and booleans without locale involvement', () => {
    const result = renderPrompt('{{count}} {{ratio}} {{enabled}} {{disabled}}', {
      count: 1234567,
      ratio: 0.5,
      enabled: true,
      disabled: false,
    });

    expect(isOk(result) ? result.value : '').toBe('1234567 0.5 true false');
  });

  it('renders zero, false and the empty string rather than treating them as absent', () => {
    // The classic falsy bug: a truthiness check in place of a presence check
    // turns '0 duplicate requests' into ' duplicate requests' and 'false' into
    // nothing, which is a *factual* change to what the model is told. Presence
    // is what decides, so every one of these renders.
    const result = renderPrompt(
      'count={{count}} ratio={{ratio}} enabled={{enabled}} note={{note}}',
      { count: 0, ratio: -0, enabled: false, note: '' },
    );

    expect(valueOf(result)).toBe('count=0 ratio=0 enabled=false note=');
  });

  it('refuses a non-finite number rather than rendering NaN into a prompt', () => {
    const error = errorOf(renderPrompt('{{ratio}}', { ratio: Number.NaN }));

    expect(error.code).toBe('INTERNAL');
    expect(error.details?.unusablePlaceholders).toEqual(['ratio']);
  });

  it('refuses a value whose runtime type the signature does not permit', () => {
    const values = { payload: { nested: true } } as unknown as Record<string, string>;

    const error = errorOf(renderPrompt('{{payload}}', values));

    expect(error.code).toBe('INTERNAL');
  });

  it('does not substitute an inherited member for a prototype-shaped key', () => {
    const error = errorOf(renderPrompt('{{__proto__}} {{constructor}}', { stage: 'plan' }));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.details?.missingPlaceholders).toEqual(['__proto__', 'constructor']);
  });

  it('allows a superset of values and logs the unused keys, never their values', () => {
    const { logger, records } = recordingLogger();

    const result = renderPrompt('{{stage}}', { stage: 'plan', secretish: 'do-not-log' }, logger);

    expect(isOk(result)).toBe(true);
    const debugLines = records.filter((entry) => entry.level === 'debug');
    expect(debugLines).toHaveLength(1);
    expect(JSON.stringify(debugLines[0]?.fields)).toContain('secretish');
    expect(JSON.stringify(debugLines[0]?.fields)).not.toContain('do-not-log');
  });

  it('logs nothing when every supplied value is referenced', () => {
    const { logger, records } = recordingLogger();

    renderPrompt('{{stage}}', { stage: 'plan' }, logger);

    expect(records).toHaveLength(0);
  });

  it('refuses a template that is not a string', () => {
    const error = errorOf(renderPrompt(undefined as unknown as string, {}));

    expect(error.code).toBe('INTERNAL');
  });

  it('renders a text that came from the loader, and reports its unfilled tokens', () => {
    // The seam the two halves of this module meet at: a stage loads its
    // versioned file and renders it. Both directions are asserted on the same
    // body, because the failure mode that matters is a prompt file and the code
    // that renders it drifting apart — a token the caller no longer supplies.
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const loaded = valueOf(loaderFor(promptsDir).load('analyze'));

    const rendered = valueOf(
      renderPrompt(loaded.text, {
        schema: '{"type":"object"}',
        evidenceRule: 'every observed fact cites an event id',
      }),
    );

    expect(rendered).toContain('{"type":"object"}');
    expect(rendered).toContain('every observed fact cites an event id');
    expect(rendered).not.toContain('{{');
    // The prompt's own text is untouched around the substitutions.
    expect(rendered).toContain('Instructions for the analyze stage, revision v001.');

    const incomplete = errorOf(renderPrompt(loaded.text, { schema: '{"type":"object"}' }));

    expect(incomplete.code).toBe('CONFIG_INVALID');
    expect(incomplete.details?.missingPlaceholders).toEqual(['evidenceRule']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The shipped prompt tree
 * ---------------------------------------------------------------------------
 *
 * Every case above this point runs against a tree it seeded itself under
 * `mkdtemp`, which is what makes them hermetic — and what makes them blind to
 * the one prompt tree this product actually ships. The manifest in
 * `apps/local-service/prompts` pins a current version for all six stages, and a
 * version it names with no file behind it is a `CONFIG_INVALID` at the first
 * stage of a developer's first session, on a clean checkout, with every
 * synthetic case still green.
 *
 * So the cases below read the checkout. They locate the workspace root, parse
 * the real manifest with the schema the loader applies, load every current
 * prompt through `createPromptLoader`, and render each one with the exact
 * placeholder set its stage supplies. **They only read**: the shipped tree is
 * an input here, and the fingerprint asserted around them proves none of them
 * wrote into it.
 */

/**
 * The directory holding `pnpm-workspace.yaml`, found by walking up from this
 * file.
 *
 * Walked rather than computed: this file is compiled and run from several
 * working directories (the package, the repository root under `vitest --root`,
 * and a coverage run), so `process.cwd()` is not a fixed point, while this
 * module's own URL always is.
 *
 * Failure **throws**, and that is deliberate: a case that cannot find the tree
 * it is meant to be checking must fail loudly. Skipping instead would turn the
 * one closure test in this suite into a silent no-op the day the layout
 * changed, which is the failure mode it exists to prevent.
 */
function locateWorkspaceRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  const filesystemRoot = parsePath(start).root;
  let directory = start;

  for (;;) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      return directory;
    }
    if (directory === filesystemRoot) {
      throw new Error(
        `No 'pnpm-workspace.yaml' was found between '${start}' and the filesystem root, so the ` +
          'shipped prompt tree could not be located. Run this suite inside the repository.',
      );
    }
    directory = dirname(directory);
  }
}

/** The prompts directory this product ships, as an absolute real path. */
const SHIPPED_PROMPTS_DIR = realpathSync(
  join(locateWorkspaceRoot(), 'apps', 'local-service', 'prompts'),
);

/**
 * The placeholders each shipped prompt is allowed to name.
 *
 * This table is the contract between a versioned prompt file and the stage that
 * renders it, written out here so that a prompt edited to name a new input
 * fails in this suite rather than at the stage: `renderPrompt` treats every
 * token as a required key, so an unrecognised one is a `CONFIG_INVALID` on a
 * live session. A prompt that stops naming one of these fails here too, which
 * is the same drift seen from the other side.
 */
const SHIPPED_PLACEHOLDERS: Readonly<Record<PromptStage, readonly string[]>> = {
  understand: ['question', 'target', 'currentUrl', 'projectSummary', 'outputSchema'],
  investigate: [
    'question',
    'understanding',
    'toolCatalog',
    'queryResults',
    'remainingQueries',
    'outputSchema',
  ],
  plan: ['understanding', 'investigation', 'adapterCatalog', 'outputSchema'],
  analyze: ['question', 'understanding', 'captureSummary', 'codeExcerpts', 'outputSchema'],
  'generate-panel': ['question', 'analysis', 'nodeCatalog', 'captureOverview', 'outputSchema'],
  followup: [
    'followUpQuestion',
    'understanding',
    'plan',
    'captureSummary',
    'analysis',
    'panel',
    'outputSchema',
  ],
};

/**
 * Every `{{token}}` in a prompt, in the order it appears and with repeats kept.
 *
 * The pattern is the renderer's own grammar — `{{key}}` with optional
 * whitespace inside the braces — so what this returns is exactly the set of
 * keys `renderPrompt` will demand a value for.
 */
function tokensOf(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)) {
    const key = match[1];
    if (key !== undefined) {
      tokens.push(key);
    }
  }
  return tokens;
}

/** A distinct, recognisable value per placeholder, so a substitution is visible. */
function valuesFor(placeholders: readonly string[]): Record<string, string> {
  return Object.fromEntries(placeholders.map((key) => [key, `[value supplied for ${key}]`]));
}

/** The `vNNN` stems that genuinely exist as prompt files for one stage. */
function versionsOnDisk(stage: PromptStage): string[] {
  return readdirSync(join(SHIPPED_PROMPTS_DIR, stage), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -'.md'.length))
    .filter((stem) => PROMPT_VERSION_PATTERN.test(stem))
    .sort();
}

/** The shipped manifest, read as data rather than through the loader. */
function readShippedManifest(): unknown {
  return JSON.parse(readFileSync(join(SHIPPED_PROMPTS_DIR, 'manifest.json'), 'utf8'));
}

/**
 * Every file in the shipped tree with its byte length, as one sorted string.
 *
 * The read-only guarantee, made executable: the fingerprint is taken before
 * these cases run and compared after, so a case that wrote, rewrote or removed
 * anything in the checkout fails even though the assertion it was making
 * passed.
 */
function fingerprintShippedTree(): string {
  return readdirSync(SHIPPED_PROMPTS_DIR, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return `${path}:${readFileSync(path).length}`;
    })
    .sort()
    .join('\n');
}

describe('the shipped prompt tree', () => {
  let fingerprintBefore = '';

  beforeAll(() => {
    fingerprintBefore = fingerprintShippedTree();
  });

  afterAll(() => {
    expect(fingerprintShippedTree()).toBe(fingerprintBefore);
  });

  it('ships a manifest that parses against the schema the loader applies', () => {
    const parsed = promptManifestSchema.safeParse(readShippedManifest());

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.version).toBe(1);
    // Every stage, and only known stages: the schema refuses an unknown key, so
    // the check that adds anything here is completeness.
    expect(Object.keys(parsed.data.stages).sort()).toEqual([...PROMPT_STAGES].sort());
    for (const stage of PROMPT_STAGES) {
      const entry = parsed.data.stages[stage];
      expect(entry).toBeDefined();
      expect(PROMPT_VERSION_PATTERN.test(entry?.current ?? '')).toBe(true);
    }
  });

  it('answers a complete version map from the shipped manifest', () => {
    const loader = createPromptLoader({ promptsDir: SHIPPED_PROMPTS_DIR, env: {} });

    const versions = valueOf(loader.versions());

    expect(Object.keys(versions).sort()).toEqual([...PROMPT_STAGES].sort());
    for (const stage of PROMPT_STAGES) {
      expect(PROMPT_VERSION_PATTERN.test(versions[stage])).toBe(true);
    }
  });

  it('loads the current prompt of every stage out of the checkout', () => {
    // THIS IS THE CLOSURE CASE. It is the only one in this file that would fail
    // on a checkout whose manifest names a version no file provides — the state
    // this product shipped in before the six bodies existed, with every
    // synthetic case in this suite green.
    const loader = createPromptLoader({ promptsDir: SHIPPED_PROMPTS_DIR, env: {} });
    const versions = valueOf(loader.versions());

    for (const stage of PROMPT_STAGES) {
      const prompt = valueOf(loader.load(stage));

      expect(prompt.stage).toBe(stage);
      expect(prompt.version).toBe(versions[stage]);
      expect(prompt.text.trim().length).toBeGreaterThan(0);
      expect(isAbsolute(prompt.path)).toBe(true);
      expect(isWithin(SHIPPED_PROMPTS_DIR, prompt.path)).toBe(true);
      expect(prompt.path).toBe(join(SHIPPED_PROMPTS_DIR, stage, `${versions[stage]}.md`));
    }
  });

  it('lists in each available entry exactly the versions that exist on disk', () => {
    const parsed = promptManifestSchema.safeParse(readShippedManifest());
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    for (const stage of PROMPT_STAGES) {
      const onDisk = versionsOnDisk(stage);

      // The list is advisory — the loader never consults it — which is exactly
      // why it drifts unless something checks it. A developer reads it to
      // decide what to bump to.
      expect([...(parsed.data.stages[stage]?.available ?? [])].sort()).toEqual(onDisk);
      // And the version the manifest actually selects is one of them.
      expect(onDisk).toContain(parsed.data.stages[stage]?.current);
    }
  });

  it('renders every shipped prompt from its stage\u2019s own placeholder set', () => {
    const loader = createPromptLoader({ promptsDir: SHIPPED_PROMPTS_DIR, env: {} });

    for (const stage of PROMPT_STAGES) {
      const prompt = valueOf(loader.load(stage));
      const tokens = tokensOf(prompt.text);
      const declared = SHIPPED_PLACEHOLDERS[stage];

      // The prompt names neither more nor fewer inputs than its stage supplies.
      expect([...new Set(tokens)].sort()).toEqual([...declared].sort());

      const rendered = valueOf(renderPrompt(prompt.text, valuesFor(declared)));

      expect(rendered).not.toContain('{{');
      for (const key of declared) {
        expect(rendered).toContain(`[value supplied for ${key}]`);
      }
    }
  });

  it('names exactly the withheld key when a shipped prompt cannot be rendered', () => {
    const loader = createPromptLoader({ promptsDir: SHIPPED_PROMPTS_DIR, env: {} });

    for (const stage of PROMPT_STAGES) {
      const prompt = valueOf(loader.load(stage));
      const declared = SHIPPED_PLACEHOLDERS[stage];

      for (const withheld of declared) {
        const supplied = valuesFor(declared.filter((key) => key !== withheld));

        const error = errorOf(renderPrompt(prompt.text, supplied));

        expect(error.code).toBe('CONFIG_INVALID');
        expect(error.details?.missingPlaceholders).toEqual([withheld]);
      }
    }
  });

  it('names each of the planning prompt\u2019s inputs exactly once', () => {
    // The planning stage renders an understanding, an investigation and an
    // adapter catalog, any of which can be large, plus its output schema. Each
    // token is substituted wherever it appears, so a prompt that names one
    // twice sends that input twice — and this is the stage where that costs the
    // most.
    const loader = createPromptLoader({ promptsDir: SHIPPED_PROMPTS_DIR, env: {} });

    const tokens = tokensOf(valueOf(loader.load('plan')).text);

    expect(tokens.sort()).toEqual([...SHIPPED_PLACEHOLDERS.plan].sort());
  });
});
