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
 *
 * ## How caching is observed without mocking the filesystem
 *
 * The loader takes no filesystem seam, deliberately: its options are a
 * directory, an environment, a cache switch and a logger. So the cases below
 * observe caching the way a developer would — by **rewriting the file on disk
 * between calls** and asserting which content comes back. A cached read returns
 * the first content, `clearCache()` and `cache: false` return the new content.
 * That is a stronger assertion than counting calls on a spy: it proves what the
 * caller receives rather than how the module got it, and it cannot be satisfied
 * by a mock that drifts from `node:fs`.
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

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DebuggenError,
  isErr,
  isOk,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';

import { PROMPT_STAGES, type PromptStage } from './types.js';
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

/** The body written for a stage and version; generic by design. */
function promptBody(stage: string, version: string): string {
  return `# ${stage} ${version}\n\nInstructions for the ${stage} stage, revision ${version}.\n`;
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
 * The error of a result that must have failed.
 *
 * Asserts the failure carries a real `DebuggenError` as well as returning it,
 * so a case cannot pass against a rejection that lost its code on the way out.
 */
function errorOf<T>(result: Result<T, DebuggenError>): DebuggenError {
  if (isOk(result)) {
    throw new Error('Expected a failed result, but the call succeeded.');
  }
  if (!DebuggenError.is(result.error)) {
    throw new Error('Expected the failure to carry a DebuggenError.');
  }
  return result.error;
}

/*
 * ---------------------------------------------------------------------------
 * The manifest contract
 * ---------------------------------------------------------------------------
 */

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

  it('rejects an unknown stage key, so a typo fails at load', () => {
    const stages: Record<string, { current: string }> = Object.fromEntries(
      PROMPT_STAGES.map((stage) => [stage, { current: 'v001' }]),
    );
    stages.analyse = { current: 'v001' };

    const parsed = promptManifestSchema.safeParse({ version: 1, stages });

    expect(parsed.success).toBe(false);
  });

  it('rejects a version that is not a three-digit vNNN stem', () => {
    const stages = Object.fromEntries(PROMPT_STAGES.map((stage) => [stage, { current: 'v001' }]));
    const parsed = promptManifestSchema.safeParse({
      version: 1,
      stages: { ...stages, plan: { current: 'v1' } },
    });

    expect(parsed.success).toBe(false);
  });

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

  it('fails when the configured directory does not exist', () => {
    const error = errorOf(loaderFor(join(createSandbox(), 'absent')).load('understand'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('does not exist');
  });

  it('fails when the configured path is a file rather than a directory', () => {
    const sandbox = createSandbox();
    const notADirectory = join(sandbox, 'prompts');
    writeFileSync(notADirectory, 'not a directory\n', 'utf8');

    const error = errorOf(loaderFor(notADirectory).load('understand'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('is not a directory');
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
      expect(prompt.value.body).toContain('v002');
    }
  });

  it('loads a prompt for every known stage', () => {
    const loader = loaderFor(seedPromptTree(join(createSandbox(), 'prompts')));

    for (const stage of PROMPT_STAGES) {
      const prompt = loader.load(stage);
      expect(isOk(prompt)).toBe(true);
      expect(isOk(prompt) ? prompt.value.stage : undefined).toBe(stage);
    }
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

  it('reports an absent manifest as a configuration failure', () => {
    const promptsDir = join(createSandbox(), 'prompts');
    for (const stage of PROMPT_STAGES) {
      writePrompt(promptsDir, stage, 'v001');
    }

    const error = errorOf(loaderFor(promptsDir).load('understand'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('The prompt manifest was not found');
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
      expect(prompt.value.body.startsWith('# plan')).toBe(true);
      expect(prompt.value.body).toBe('# plan\n\nBody text.\n');
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

    const result = loaderFor(promptsDir).versions();

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(Object.keys(result.value).sort()).toEqual([...PROMPT_STAGES].sort());
      expect(result.value.followup).toBe('v003');
      expect(result.value.understand).toBe('v001');
      expect(Object.isFrozen(result.value)).toBe(true);
    }
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

    const superseded = loaderFor(promptsDir).loadVersion('analyze', 'v001');

    expect(isOk(superseded)).toBe(true);
    expect(isOk(superseded) ? superseded.value.version : '').toBe('v001');
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

  it('reports a version that was recorded but is no longer on disk', () => {
    const loader = loaderFor(seedPromptTree(join(createSandbox(), 'prompts')));

    const error = errorOf(loader.loadVersion('plan', 'v009'));

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain("version 'v009'");
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
      writeFileSync(secret, '# not a prompt\n', 'utf8');
      symlinkSync(secret, join(promptsDir, 'plan', 'v002.md'));

      const error = errorOf(loaderFor(promptsDir).loadVersion('plan', 'v002'));

      expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
      expect(JSON.stringify(error.details)).not.toContain('secret.md');
    },
  );

  it.skipIf(!CAN_SYMLINK)(
    'refuses a stage directory that is a symbolic link out of the prompts directory',
    () => {
      const sandbox = createSandbox();
      const promptsDir = seedPromptTree(join(sandbox, 'prompts'));
      const outside = join(sandbox, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'v001.md'), '# not a prompt\n', 'utf8');
      rmSync(join(promptsDir, 'followup'), { recursive: true, force: true });
      symlinkSync(outside, join(promptsDir, 'followup'));

      const error = errorOf(loaderFor(promptsDir).loadVersion('followup', 'v001'));

      expect(error.code).toBe('PATH_OUTSIDE_PROJECT');
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
 * Caching
 * ---------------------------------------------------------------------------
 */

describe('caching', () => {
  it('serves a second load from the cache, so the file is read once', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const loader = loaderFor(promptsDir);

    const first = loader.load('understand');
    writeFileSync(join(promptsDir, 'understand', 'v001.md'), '# rewritten\n', 'utf8');
    const second = loader.load('understand');

    expect(isOk(first) ? first.value.body : '').toContain('Instructions for the understand stage');
    expect(isOk(second) ? second.value.body : '').toBe(
      isOk(first) ? first.value.body : 'different',
    );
  });

  it('reads from disk again after clearCache', () => {
    const promptsDir = seedPromptTree(join(createSandbox(), 'prompts'));
    const loader = loaderFor(promptsDir);

    loader.load('understand');
    writeFileSync(join(promptsDir, 'understand', 'v001.md'), '# rewritten\n', 'utf8');
    loader.clearCache();
    const afterClear = loader.load('understand');

    expect(isOk(afterClear) ? afterClear.value.body : '').toBe('# rewritten\n');
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

    expect(isOk(second) ? second.value.body : '').toBe('# rewritten\n');
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

  it('returns the template unchanged when it names no placeholder', () => {
    const template = 'A prompt with braces that are not placeholders: { } {{ }} {{-}}.';

    const result = renderPrompt(template, { unused: 'value' });

    expect(isOk(result) ? result.value : '').toBe(template);
  });

  it('reports every missing placeholder in one failure', () => {
    const result = renderPrompt('{{schema}} {{evidenceRule}} {{stage}}', { stage: 'plan' });

    const error = errorOf(result);

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('evidenceRule');
    expect(error.message).toContain('schema');
    expect(error.details?.missingPlaceholders).toEqual(['evidenceRule', 'schema']);
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
});
