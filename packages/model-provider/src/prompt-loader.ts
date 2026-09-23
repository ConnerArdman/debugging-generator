/**
 * The one way this product reads a prompt.
 *
 * Prompts are **versioned repository files** — `prompts/<stage>/vNNN.md` under
 * the local service — and they are **immutable once committed**: a change to a
 * prompt is a new `vNNN+1.md` file plus a manifest update, never an edit to a
 * file that a stored session already cites (AAP 0.5.3). No prompt string lives
 * in a module anywhere in this repository, which is exactly why this file
 * exists: every stage of the reasoning pipeline asks it for the text it is
 * about to send, and the versions it answered with are recorded on the session
 * so a stored analysis or panel can always be read back against the precise
 * instructions that produced it.
 *
 * Three things follow from that, and they shape everything below.
 *
 * 1. **A missing prompt is a typed error, never a substitute.** This module
 *    contains no prompt text at all: no default system message, no fallback
 *    body, no sample. Producing a result without traversing the real pipeline
 *    is the one thing the product may never do (AAP 0.5.4), and a loader that
 *    quietly supplied its own words when a file was absent would do precisely
 *    that — invisibly, and with the session recording a version that never
 *    rendered.
 * 2. **Every path is guarded four times.** The stage and version reaching this
 *    module can originate in a manifest on disk or in a stored session record,
 *    so neither is trusted: a value is checked against the closed stage set,
 *    then against the version pattern, then as a relative path, and finally by
 *    resolving the candidate and requiring it to stay inside the prompts
 *    directory's own real path. The fourth check is the only one that can see a
 *    symbolic link planted *inside* the prompts directory pointing out of it,
 *    which the string-level helpers in `@debuggen/shared` document as beyond
 *    their reach.
 * 3. **Failures are returned, not thrown.** Every entry point answers a
 *    `Result` carrying a `DebuggenError` with a code from the closed
 *    vocabulary, so a stage can report "the prompt for this stage could not be
 *    loaded" to the developer with a hint, instead of unwinding through a
 *    pipeline that has instrumentation installed in somebody's working tree.
 *
 * ## Why the filesystem calls are synchronous
 *
 * `realpathSync`, `statSync` and the `openSync`/`fstatSync`/`readSync` sequence
 * in {@link readBoundedFile} throughout, deliberately. A prompt file is a few
 * kilobytes of Markdown; it is read at a stage boundary, once, with nothing else
 * waiting on the event loop; and the manifest and every body are cached after
 * the first read. What the synchronous form buys is the signature: `load()`
 * returns a plain `Result` rather than a `Promise<Result>`, so a stage that
 * needs a prompt in the middle of building a request does not become
 * asynchronous for the sake of a 2 kB read, and a test asserting a rejection
 * needs no await. The asynchronous form would cost a microtask per read and buy
 * nothing measurable.
 *
 * ## Why the read is an open, a stat and a bounded loop rather than one call
 *
 * `readFileSync(path, 'utf8')` would read whatever is at the path, of whatever
 * kind and of whatever size. Neither is acceptable for a path that a manifest
 * on disk, an environment variable or a stored session record contributed to:
 * a named pipe planted at a prompt path blocks the whole service forever on a
 * blocking open, a character device streams without end, and a large regular
 * file is decoded into memory in one piece before anything can object. So the
 * read opens the resolved path with no-follow, non-blocking semantics, requires
 * `fstat` to report a **regular file**, refuses a size above the subject's own
 * ceiling *before* reading a byte, and then reads exactly that many bytes. See
 * {@link readBoundedFile} for each step and {@link MAX_MANIFEST_BYTES} and
 * {@link MAX_PROMPT_BYTES} for the two ceilings.
 *
 * ## What this module never does
 *
 * - **It never imports the local service.** The prompts directory is runtime
 *   data discovered by path, not a compile-time dependency: `apps/local-service`
 *   is not in this package's dependency set, importing it would invert the
 *   package graph, and the repository's lint configuration fails the build on
 *   the attempt. The directory arrives as an option from the caller or as an
 *   environment variable — nothing more.
 * - **It never guesses a directory.** See {@link createPromptLoader} for why
 *   there is no third resolution channel.
 * - **It never puts file contents in an error.** A rejection names the stage,
 *   the version and the paths involved. A prompt body is an input to a model
 *   call, and an error object travels into logs and across a process boundary
 *   into two user interfaces; the two must not meet.
 *
 * @example
 * ```ts
 * const loader = createPromptLoader({ promptsDir: resolvedPromptsDirectory });
 *
 * const prompt = loader.load('analyze');
 * if (isErr(prompt)) {
 *   // `prompt.error.code`, `.message` and `.hint` are what the stage reports.
 *   return prompt;
 * }
 *
 * // Every placeholder the loaded version names, and the analysis stage's own
 * // file names these: a value short of that set is a typed failure naming the
 * // keys that were missing, never a prompt with a gap in it.
 * const rendered = renderPrompt(prompt.value.text, {
 *   question: developerQuestion,
 *   understanding: understandingJson,
 *   captureSummary: captureSummaryJson,
 *   codeExcerpts: excerptsJson,
 *   outputSchema: renderedJsonSchema,
 * });
 * ```
 *
 * @packageDocumentation
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import {
  DebuggenError,
  err,
  isErr,
  isSafeRelativePath,
  isWithin,
  joinPosix,
  noopLogger,
  ok,
  type Logger,
  type Result,
} from '@debuggen/shared';

import {
  PROMPT_STAGES,
  PROMPT_VERSION_PATTERN,
  isPromptStage,
  promptStageSchema,
  type PromptStage,
  type PromptVersion,
} from './types.js';

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

/**
 * The environment variable that names the prompts directory.
 *
 * The second of the two resolution channels documented on
 * {@link createPromptLoader}, and the one that makes the packaged editor
 * extension work: its build copies the service's `prompts/**` tree into the
 * extension, and the host spawns the embedded service with this variable
 * pointing at the copy (AAP 0.7.1). Kept module-private on purpose — the name
 * belongs in the hint of a configuration error, where a developer reads it,
 * rather than in this package's public surface, where a consumer might start
 * setting it from code instead of configuring the loader directly.
 */
const PROMPTS_DIR_ENV_VAR = 'DEBUGGEN_PROMPTS_DIR';

/** The manifest's file name, directly inside the prompts directory. */
const MANIFEST_FILE_NAME = 'manifest.json';

/** The extension every prompt file carries: they are Markdown documents. */
const PROMPT_FILE_EXTENSION = '.md';

/**
 * The most bytes `manifest.json` may occupy — 64 KiB.
 *
 * Sized against what a manifest *is*: a version number and one entry per stage,
 * each naming a current version and, optionally, the versions written so far.
 * Six stages with an `available` list of a dozen versions each is a few hundred
 * bytes, and this repository's convention of explaining a JSON file in `"// …"`
 * keys adds a few hundred more. 64 KiB is therefore two orders of magnitude of
 * headroom over the largest manifest that could be meant seriously, which is
 * the point of a ceiling: it never fires for a real file, and it fires
 * immediately for something that is not a manifest at all.
 */
const MAX_MANIFEST_BYTES = 64 * 1024;

/**
 * The most bytes one prompt file may occupy — 256 KiB.
 *
 * A prompt body carries the stage's instructions, its output contract and its
 * rules, and that is all it carries: the stage's JSON Schema, the node or
 * adapter catalog, the code excerpts and the capture aggregates all arrive at
 * *render* time as placeholder values (see {@link renderPrompt}), never as
 * committed text. A few kilobytes is therefore the natural size of one of these
 * files, and 256 KiB leaves room for a far longer document than any stage needs
 * while still bounding what a single `load()` can pull into memory and hand to
 * a model call.
 *
 * Deliberately a *separate* constant from {@link MAX_MANIFEST_BYTES} rather than
 * one shared "file limit": the two subjects have different sizes for different
 * reasons, and a single number would have to be the larger of the two, which
 * would stop the manifest's ceiling saying anything useful.
 */
const MAX_PROMPT_BYTES = 256 * 1024;

/** 64 KiB, spelled for the failure a developer reads. */
const MAX_MANIFEST_BYTES_LABEL = '64 KiB';

/** 256 KiB, spelled for the failure a developer reads. */
const MAX_PROMPT_BYTES_LABEL = '256 KiB';

/**
 * An `fs.constants` flag, or `0` when this platform does not define it.
 *
 * `O_NOFOLLOW` does not exist on Windows, and a missing constant reaches this
 * module as `undefined`; `undefined | flag` is `NaN`, and `openSync` with `NaN`
 * flags is an error rather than a default. Degrading a platform's absent flag
 * to `0` — the identity of bitwise or — keeps the flag word a number
 * everywhere, so a platform without the hardening still gets the ordinary
 * read-only open and the checks that follow it, which are where the actual
 * refusals happen.
 */
function openFlag(flag: number | undefined): number {
  return typeof flag === 'number' && Number.isInteger(flag) ? flag : 0;
}

/**
 * The flags every contained read opens with.
 *
 * - `O_RDONLY` — nothing in this module writes.
 * - `O_NOFOLLOW` — the final component must not be a symbolic link. The path
 *   handed to `open` has already been through `realpath` and proved contained,
 *   so a link at it *now* means the file was replaced between the two calls;
 *   the open fails with `ELOOP` and {@link readBoundedFile} reports that swap as
 *   a policy refusal instead of reading a file nothing checked.
 * - `O_NONBLOCK` — **this is the flag that stops a planted named pipe hanging
 *   the service.** Opening a FIFO for reading blocks until a writer appears,
 *   which for a FIFO with no writer is forever, and a synchronous loader has no
 *   timeout to fall back on; with this flag the same open returns immediately
 *   and `fstat` then rejects the kind. It has no effect on a regular file,
 *   which is the only kind that survives the check that follows.
 */
const READ_OPEN_FLAGS =
  openFlag(fsConstants.O_RDONLY) |
  openFlag(fsConstants.O_NOFOLLOW) |
  openFlag(fsConstants.O_NONBLOCK);

/**
 * The recovery instruction attached to every configuration failure about the
 * directory itself.
 *
 * Names *both* channels, in precedence order, because a developer hitting this
 * has no way to tell from the outside which one was meant to apply.
 */
const DIRECTORY_HINT =
  `Pass 'promptsDir' to createPromptLoader(), or set ${PROMPTS_DIR_ENV_VAR} to the ` +
  'directory that holds the versioned prompt files and their manifest.';

/** Characters kept when an untrusted value is quoted in an error message. */
const MAX_REPORTED_LENGTH = 120;

/** What a control character becomes in a reported value. */
const REPLACEMENT_CHARACTER = '\uFFFD';

/** The most schema issues a manifest rejection carries in its details. */
const MAX_REPORTED_ISSUES = 10;

/** The most unused value keys a single debug line names. */
const MAX_REPORTED_UNUSED_KEYS = 20;

/**
 * The substitutions a caller who supplied none is treated as having passed.
 *
 * {@link renderPrompt} asks for a record, so `null` and `undefined` can only
 * reach it through a cast, through an untyped JavaScript call site, or as a
 * context object a builder returned empty — and all three happen. Standing an
 * empty record in at the door is what keeps this module's one promise intact:
 * every malformed input leaves as a `Result`, and nothing leaves as a thrown
 * `TypeError`, which no caller written against a `Result`-returning function
 * is positioned to catch.
 *
 * Frozen because every such call shares this one instance, and a renderer must
 * not be able to hand a caller a mutable object that later calls will see.
 */
const NO_PROMPT_VALUES: Readonly<Record<string, string | number | boolean>> = Object.freeze({});

/**
 * The placeholder grammar, as a source string rather than a shared instance.
 *
 * `{{key}}`, with optional whitespace inside the braces and a key of letters,
 * digits, underscores and dots. That is the entire template language — see
 * {@link renderPrompt} for why it has no others.
 *
 * Stored as source and compiled per call because the compiled form needs the
 * `g` flag to visit every placeholder, and a global regular expression carries
 * a mutable `lastIndex`. `String.prototype.replace` does reset it, but a shared
 * instance would still be one refactor away from a scanner that does not — the
 * bug class where the same input matches, then does not, then matches again.
 */
const PLACEHOLDER_SOURCE = '\\{\\{\\s*([A-Za-z0-9_.]+)\\s*\\}\\}';

// ---------------------------------------------------------------------------
// The manifest contract
// ---------------------------------------------------------------------------

/**
 * One stage's entry in the prompt manifest.
 *
 * `current` is the version every new session uses for that stage. `available`
 * is advisory: a record of the versions that have been written, useful when a
 * developer is deciding what to bump to, and **not** a permission list —
 * {@link PromptLoader.loadVersion} deliberately does not consult it, for the
 * reason documented there.
 *
 * Deliberately **not** a strict object. Unknown members are stripped rather
 * than rejected, so a manifest may carry documentation alongside its data (this
 * repository's JSON files conventionally explain themselves in `"// …"` keys)
 * without the loader refusing to start. The strictness that matters is one
 * level up, on the stage keys themselves.
 */
export const promptManifestEntrySchema = z.object({
  current: z.string().regex(PROMPT_VERSION_PATTERN),
  available: z.array(z.string().regex(PROMPT_VERSION_PATTERN)).optional(),
});

/** One stage's entry in the manifest; see {@link promptManifestEntrySchema}. */
export type PromptManifestEntry = z.infer<typeof promptManifestEntrySchema>;

/**
 * The schema of the prompt manifest — `manifest.json`, directly inside the
 * prompts directory.
 *
 * ```json
 * {
 *   "version": 1,
 *   "stages": {
 *     "understand": { "current": "v001" },
 *     "investigate": { "current": "v001", "available": ["v001"] }
 *   }
 * }
 * ```
 *
 * Three properties of this schema are load-bearing, and each was verified
 * against the pinned Zod release rather than assumed:
 *
 * - **Every stage is required.** `z.record` with an enum key schema is
 *   exhaustive in Zod 4: a manifest that omits a stage fails to parse. The
 *   loader checks completeness a second time anyway, so that the failure a
 *   developer reads *names the missing stages* instead of reporting an
 *   `undefined` per absent key.
 * - **An unknown stage key is rejected.** The same construct refuses a key that
 *   is not one of the six stage names, so `"analyse"` for `"analyze"` fails at
 *   load — when a developer is looking at the manifest — rather than at the one
 *   stage that could not find its prompt, halfway through a session with
 *   instrumentation already installed. Documentation keys therefore belong at
 *   the top level or inside a stage entry, never among the stage keys.
 * - **`version` is the literal `1`.** The manifest is data this product reads on
 *   every start; a second shape gets a second version number and an explicit
 *   branch, never a silently tolerated variation.
 *
 * Exported so that whoever authors or edits a manifest can validate it with the
 * same schema the loader applies, rather than against a copy of it.
 */
export const promptManifestSchema = z.object({
  version: z.literal(1),
  stages: z.record(promptStageSchema, promptManifestEntrySchema),
});

/** The parsed prompt manifest; see {@link promptManifestSchema}. */
export type PromptManifest = z.infer<typeof promptManifestSchema>;

/**
 * A prompt file the loader read: which stage and version it is, its text, and
 * where it came from.
 *
 * The published contract is `{ stage, version, text }` — the three members a
 * stage needs to render a prompt and to record on the session what it rendered.
 * `text` is the name the content carries, and the only one: there is no `body`
 * alias, because two names for one string is how a caller ends up sending the
 * stale one.
 *
 * `text` is the file's content with a UTF-8 byte-order mark removed if one was
 * present and with exactly one trailing newline. Nothing else is touched: a
 * prompt embeds a JSON Schema, fenced examples and an evidence-citation rule,
 * and a loader that reformatted any of that would change what the model was
 * asked without anything recording the change.
 *
 * `path` is an **additive diagnostic** member beside that contract, not part of
 * it: the resolved absolute path of the file that was read — the real path,
 * after symbolic links, which is the path that was proven to be inside the
 * prompts directory. It exists because a log line and a session record cite it
 * when a developer asks which file a stage actually used, and nothing in the
 * pipeline is expected to read it to obtain the prompt.
 */
export interface PromptFile {
  /** The stage this prompt instructs. */
  readonly stage: PromptStage;

  /** The version stem that was loaded, matching {@link PROMPT_VERSION_PATTERN}. */
  readonly version: PromptVersion;

  /** The prompt text; see the interface documentation for the normalisation. */
  readonly text: string;

  /**
   * The resolved absolute path of the file that was read.
   *
   * Diagnostic and additive: see the interface documentation.
   */
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Reporting untrusted values safely
// ---------------------------------------------------------------------------

/**
 * Renders a value for an error message: truncated, with every control
 * character replaced, and never invoking the value's own `toString`.
 *
 * The values this quotes are rejected stages and versions, so by definition
 * they failed a check and may be anything at all — a path fragment, a control
 * sequence, a value of the wrong type entirely. A raw NUL terminates a path
 * early in the C string APIs behind a filesystem call, and an ESC begins a
 * terminal escape sequence in whatever renders the log line, so neither may
 * survive into a message.
 *
 * `@debuggen/shared` applies the same policy inside its path helpers, but keeps
 * that helper module-private, so this is a deliberate local equivalent rather
 * than a missed import. A non-string is described by its type instead of
 * stringified: a caller that reached this module through a cast must not get a
 * foreign `toString` called on the failure path.
 */
function reportable(value: unknown): string {
  if (typeof value !== 'string') {
    return `<${typeof value}>`;
  }

  const truncated =
    value.length > MAX_REPORTED_LENGTH ? `${value.slice(0, MAX_REPORTED_LENGTH)}…` : value;

  let safe = '';
  for (let index = 0; index < truncated.length; index += 1) {
    const code = truncated.charCodeAt(index);
    // C0 (NUL through US), DELETE and C1. Surrogates are far above this range,
    // so a non-ASCII file name passes through untouched.
    safe +=
      code <= 0x1f || (code >= 0x7f && code <= 0x9f)
        ? REPLACEMENT_CHARACTER
        : truncated.charAt(index);
  }
  return safe;
}

/**
 * The POSIX error code of a thrown filesystem error, when it has one.
 *
 * Read structurally rather than through an `instanceof Error` check: the value
 * arrives from a builtin, and the only property that matters is `code`.
 */
function errnoOf(caught: unknown): string | undefined {
  if (typeof caught === 'object' && caught !== null && 'code' in caught) {
    const code: unknown = (caught as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Whether a thrown filesystem error is Node refusing the *argument* rather than
 * the filesystem refusing the operation.
 *
 * A path carrying a NUL byte, or a value of the wrong type reaching a builtin
 * through a cast, arrives as an `ERR_INVALID_ARG_*` code and not as an errno.
 * That is a configuration mistake with a fix a developer can act on, so it is
 * reported as one instead of as an unexplained internal failure.
 */
function isInvalidArgument(caught: unknown): boolean {
  return errnoOf(caught)?.startsWith('ERR_INVALID_ARG') === true;
}

/**
 * Whether a thrown filesystem error means "there is nothing at that path".
 *
 * `ENOENT` is the plain case; `ENOTDIR` is the same fact reported one component
 * earlier, when a path names a file where a directory was expected. Keeping
 * them together is what lets a missing prompt be reported as a missing prompt
 * rather than as an unexplained internal failure.
 */
function isMissingEntry(caught: unknown): boolean {
  const code = errnoOf(caught);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Summarises Zod issues for an error's details: one short line per issue,
 * bounded in count, with control characters removed.
 *
 * Issue messages describe *structure* — which key was absent, which key was not
 * recognised, which pattern a version failed — and a manifest's keys are the
 * product's own stage names. No prompt text passes through here, which is the
 * property that matters: a manifest rejection has to be actionable without
 * quoting any file's contents.
 */
function summarizeIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): readonly string[] {
  return issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    // Every segment through `String` rather than `Array.prototype.join`: a Zod
    // path segment is a `PropertyKey`, and `join` throws on a symbol.
    const path =
      issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '<root>';
    return reportable(`${path}: ${issue.message}`);
  });
}

// ---------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------

/**
 * A configuration failure: the prompts directory, the manifest or a prompt file
 * is absent, unreadable or not what it has to be.
 *
 * `CONFIG_INVALID` is the code for all of them, and that is the closed
 * vocabulary's intent — "a process could not make sense of its own
 * configuration or environment, and nothing else can be attempted". A prompt
 * tree is configuration in exactly that sense: versioned files the product
 * ships and a directory it is pointed at.
 */
function configFailure(
  message: string,
  details: Readonly<Record<string, unknown>>,
  hint: string,
): DebuggenError {
  return new DebuggenError('CONFIG_INVALID', message, { hint, details });
}

/**
 * The recovery instruction on a rejected stage, version or relative path: what
 * a legal prompt address looks like.
 */
const UNSAFE_ADDRESS_HINT =
  'A prompt is addressed by a stage name from the known set and a version of the form ' +
  "'vNNN'; nothing else can name a prompt file.";

/**
 * A rejected stage, version or relative path — or a resolved path this module
 * refuses to read.
 *
 * `FS_UNSAFE_PATH` is the closed vocabulary's *policy* refusal — a path this
 * product will not construct or open, as opposed to a path that escaped a root
 * (which is {@link containmentFailure}) or a path that simply is not there
 * (which is a configuration failure). For the four address checks nothing is
 * touched on disk before this is raised: the value never becomes a filesystem
 * call.
 *
 * @param message What was refused.
 * @param details The stage, version and paths already known to the caller;
 * never any file's contents.
 * @param hint The recovery instruction. Defaults to {@link UNSAFE_ADDRESS_HINT},
 * which is what every address rejection reports; the one caller that overrides
 * it is the no-follow open in {@link readBoundedFile}, where the address was
 * legal and it is the *file* that was swapped, so a hint about version spelling
 * would send a developer to the wrong place.
 */
function unsafePathFailure(
  message: string,
  details: Readonly<Record<string, unknown>>,
  hint: string = UNSAFE_ADDRESS_HINT,
): DebuggenError {
  return new DebuggenError('FS_UNSAFE_PATH', message, { hint, details });
}

/**
 * A containment failure: a candidate resolved outside the prompts directory.
 *
 * In practice this means a symbolic link inside the prompts directory whose
 * target lies elsewhere, since the three checks before it have already refused
 * every string-level escape. `PATH_OUTSIDE_PROJECT` is the code the shared path
 * helpers raise for the same class of failure, so a user interface that already
 * explains a containment refusal explains this one too.
 *
 * The details name the stage, the version and the prompts directory — all
 * already known to the caller — and deliberately **not** the path the link
 * resolved to. A refusal must not become an oracle for probing the developer's
 * disk, which is the same reason the shared helpers withhold it.
 */
function containmentFailure(details: Readonly<Record<string, unknown>>): DebuggenError {
  return new DebuggenError(
    'PATH_OUTSIDE_PROJECT',
    'The prompt file resolved to a location outside the prompts directory and was not read.',
    {
      hint:
        'Remove the symbolic link that leads out of the prompts directory, or point the loader ' +
        'at the directory that genuinely holds the prompt files.',
      details,
    },
  );
}

/**
 * An unexpected filesystem failure.
 *
 * `INTERNAL` is the last resort of the closed vocabulary and is used here only
 * for what it is meant for: an errno that is not "absent" and not a containment
 * refusal — a permission denial, a symbolic-link loop, an I/O error. The errno
 * travels in the details and the original error as the cause, so the report is
 * actionable even though the code is generic.
 */
function unexpectedFsFailure(
  message: string,
  details: Readonly<Record<string, unknown>>,
  cause: unknown,
): DebuggenError {
  return new DebuggenError('INTERNAL', message, {
    hint: 'Check the permissions and ownership of the prompts directory and its contents.',
    details,
    cause,
  });
}

// ---------------------------------------------------------------------------
// The loader's public surface
// ---------------------------------------------------------------------------

/**
 * How a {@link PromptLoader} is configured. Every member is optional and every
 * default is stated on the member.
 */
export interface PromptLoaderOptions {
  /**
   * The directory holding the versioned prompt files and their manifest.
   *
   * The first and highest-precedence resolution channel, and the one the local
   * service uses: it knows where its own prompts are and passes the path
   * explicitly. A relative path is resolved against the process working
   * directory; a blank value counts as not provided. When absent, the
   * environment is consulted — see {@link createPromptLoader}.
   */
  readonly promptsDir?: string;

  /**
   * The environment to read {@link PROMPTS_DIR_ENV_VAR} from.
   *
   * Injectable so a test can describe an environment without mutating the one
   * the test runner shares between files. Defaults to `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /**
   * Whether to cache the manifest and the prompt bodies. Defaults to `true`.
   *
   * Caching is sound *because a committed prompt file never changes*: a new
   * version is a new file. Pass `false` while iterating on a prompt in a
   * development loop, or in a test that rewrites a fixture between calls, and
   * every call reads from disk again.
   */
  readonly cache?: boolean;

  /**
   * Where diagnostics go. Defaults to `noopLogger`, so a library that loads a
   * prompt writes nothing anywhere until its host process supplies a logger.
   *
   * Only paths, stages, versions and value *keys* are ever logged — never a
   * prompt body and never a rendered value.
   */
  readonly logger?: Logger;
}

/**
 * Reads versioned prompt files by stage and version.
 *
 * Obtained from {@link createPromptLoader}. Every method returns a `Result`;
 * none throws.
 */
export interface PromptLoader {
  /**
   * The configured prompts directory, as an absolute path.
   *
   * Diagnostic: it is what a log line or a session record cites when a
   * developer asks where prompts were read from. This is the *configured* path,
   * resolved to absolute but not followed through symbolic links, and it is
   * **not** validated at construction time — the empty string means neither
   * resolution channel supplied one, in which case every method returns a
   * configuration error naming both channels.
   */
  readonly promptsDir: string;

  /**
   * The absolute path of `manifest.json` inside {@link promptsDir}, or the
   * empty string when no directory is configured. Diagnostic, with the same
   * caveats.
   */
  readonly manifestPath: string;

  /**
   * Loads the version the manifest names as current for `stage`.
   *
   * This is what a new session uses. The manifest is read (and cached) on the
   * first call.
   *
   * @param stage The stage whose prompt is wanted.
   * @returns The prompt file, or a typed failure: `CONFIG_INVALID` when the
   * directory, the manifest or the file is absent or unusable,
   * `FS_UNSAFE_PATH` when the stage or the manifest's version is not a legal
   * prompt address, `PATH_OUTSIDE_PROJECT` when the file resolves out of the
   * prompts directory, `INTERNAL` for an unexpected filesystem error.
   */
  load(stage: PromptStage): Result<PromptFile, DebuggenError>;

  /**
   * Loads an **explicitly named** version, whatever the manifest currently
   * says.
   *
   * This method deliberately does **not** require `version` to be the stage's
   * current version, nor to appear in that stage's `available` list, nor
   * indeed for the manifest to be readable at all — it never reads the
   * manifest. That is its entire purpose: a reopened session and a follow-up
   * question must be answered with the prompt versions recorded on the session
   * record, and those are frequently *superseded* versions, because a prompt
   * bump is exactly the event that makes a stored session's versions
   * historical. Restricting this to the manifest would break session reopening
   * the first time a prompt version is bumped, and would do so silently, on a
   * code path (reopen, follow-up) that no unit test of the manifest exercises.
   *
   * All four path checks still apply — the closed stage set, the version
   * pattern, the relative-path check and real-path containment — so "any
   * version" means any *legally named* version that is genuinely inside the
   * prompts directory, never an arbitrary path.
   *
   * @param stage The stage whose prompt is wanted.
   * @param version The version stem, of the form `vNNN`.
   * @returns The prompt file, or the same failure vocabulary as {@link load}.
   */
  loadVersion(stage: PromptStage, version: string): Result<PromptFile, DebuggenError>;

  /**
   * The current version of every stage, exactly as persisted on a session
   * record's prompt-version map.
   *
   * Always complete: one entry per known stage, or a failure naming the stages
   * the manifest left out. The returned record is frozen.
   */
  versions(): Result<Readonly<Record<PromptStage, PromptVersion>>, DebuggenError>;

  /**
   * Drops the cached manifest, the cached bodies and the cached directory
   * resolution, so the next call reads from disk again.
   *
   * For a development loop that edits a prompt in place and for a test that
   * rewrites a fixture. A session that has already recorded its versions is
   * unaffected: clearing a cache cannot change which version a stage asks for.
   */
  clearCache(): void;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * The prompts directory, validated once: as configured, and as the real path
 * that containment is measured against.
 */
interface PromptRoot {
  /** The configured absolute path, symbolic links not followed. */
  readonly configuredDir: string;

  /** The same directory after `realpath`; the root of the containment check. */
  readonly realDir: string;
}

/** A manifest that parsed and proved complete, with what was derived from it. */
interface ManifestState {
  /** The resolved absolute path the manifest was read from. */
  readonly path: string;

  /** The parsed manifest. */
  readonly manifest: PromptManifest;

  /** The current version of every stage, frozen and total. */
  readonly currents: Readonly<Record<PromptStage, PromptVersion>>;
}

/**
 * What is being read, in the words its failures use — and the ceiling that
 * applies to it.
 *
 * One record per subject, supplied by the caller that knows which subject it is
 * asking for: `readManifest` passes the manifest's vocabulary and
 * {@link MAX_MANIFEST_BYTES}, `loadFile` the prompt's and
 * {@link MAX_PROMPT_BYTES}. That is why the ceiling travels here rather than
 * living as one constant inside the read: the two subjects are bounded
 * separately, for reasons stated on each constant.
 */
interface ReadSubject {
  /** The subject as a sentence subject, e.g. `'The prompt manifest'`. */
  readonly label: string;

  /** What to do when the subject is not there. */
  readonly missingHint: string;

  /** The most bytes this subject may occupy. */
  readonly maxBytes: number;

  /** {@link maxBytes} as a developer reads it, e.g. `'64 KiB'`. */
  readonly maxBytesLabel: string;

  /** What to do when the subject is larger than {@link maxBytes}. */
  readonly oversizeHint: string;

  /** Facts the caller already knows, attached to every failure. */
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * How `fstat` describes something that is not a regular file: a noun phrase for
 * the message, and a token for the details.
 *
 * Both, because the two fields are read by different audiences. The phrase
 * completes the sentence a developer reads — "… is a named pipe, not a file." —
 * while the token is what a log aggregator or a user interface can group on
 * without parsing English.
 */
interface FileKind {
  /** The noun phrase, with its article: `'a directory'`, `'a named pipe'`. */
  readonly phrase: string;

  /** The machine-readable kind: `'directory'`, `'fifo'`, `'unknown'`. */
  readonly token: string;
}

/**
 * Names the kind of an opened descriptor that is not a regular file.
 *
 * Every POSIX kind a path inside a prompts directory could plausibly be is
 * named, because the point of the failure is to tell a developer *what* is at
 * the path: "a directory" is a stage directory left where a version file should
 * be, "a named pipe" is the hazard the non-blocking open exists for, and a
 * device or a socket is something that has no business in a prompt tree at all.
 * The final fallback covers a kind this platform reports that none of the
 * predicates claim — an honest "something else" beats an inaccurate guess.
 */
function describeFileKind(stats: Stats): FileKind {
  if (stats.isDirectory()) {
    return { phrase: 'a directory', token: 'directory' };
  }
  if (stats.isFIFO()) {
    return { phrase: 'a named pipe', token: 'fifo' };
  }
  if (stats.isSocket()) {
    return { phrase: 'a socket', token: 'socket' };
  }
  if (stats.isCharacterDevice()) {
    return { phrase: 'a character device', token: 'character-device' };
  }
  if (stats.isBlockDevice()) {
    return { phrase: 'a block device', token: 'block-device' };
  }
  if (stats.isSymbolicLink()) {
    return { phrase: 'a symbolic link', token: 'symbolic-link' };
  }
  return { phrase: 'an entry of an unrecognised kind', token: 'unknown' };
}

/**
 * Opens an already-resolved, already-contained path with no-follow,
 * non-blocking semantics, requires a regular file, refuses a size above the
 * subject's ceiling **before reading**, reads exactly that many bytes and
 * decodes them as UTF-8.
 *
 * The order is the whole of the hardening, so each step says what it is for:
 *
 * 1. **Open** with {@link READ_OPEN_FLAGS}. A named pipe returns a descriptor
 *    immediately instead of blocking; a symbolic link that appeared since
 *    `realpath` fails with `ELOOP` and is reported as a policy refusal, because
 *    the file that was checked is no longer the file at the path.
 * 2. **`fstat` the descriptor**, not the path: what is measured and what is
 *    read are then provably the same object, with no second lookup in between.
 *    A directory opens perfectly well read-only on Linux, and a character
 *    device opens and reports a size of zero, so this check — not the open — is
 *    what refuses a kind that is not a regular file.
 * 3. **Compare `size` against the ceiling** before a byte is read, so an
 *    oversized file costs one `open` and one `fstat` rather than its own length
 *    in memory.
 * 4. **Read exactly `size` bytes** in a loop, then probe for one more. A short
 *    read means the file was truncated under us and a successful probe means it
 *    grew: either way the bytes in hand are not the file, and a *typed failure*
 *    is the only honest answer — a silently truncated prompt would be sent to a
 *    model with its output schema or its rules missing from the end.
 * 5. **Close in a `finally`**, so no descriptor survives any of the failures
 *    above.
 *
 * No file contents reach any failure this returns: the details carry the
 * subject's own facts, the path, and sizes.
 *
 * @param realPath The resolved path to open; already proved inside the root.
 * @param candidate The path as it was addressed, for the "not found" message.
 * @param subject See {@link ReadSubject}.
 * @param logger Where a failed `close` is reported; the read's own result is
 * never changed by it.
 * @returns The decoded text, or a typed failure.
 */
function readBoundedFile(
  realPath: string,
  candidate: string,
  subject: ReadSubject,
  logger: Logger,
): Result<string, DebuggenError> {
  let fd: number;
  try {
    fd = openSync(realPath, READ_OPEN_FLAGS);
  } catch (caught) {
    const errno = errnoOf(caught);
    if (isMissingEntry(caught)) {
      return err(
        configFailure(
          `${subject.label} was not found at '${reportable(candidate)}'.`,
          { ...subject.details, path: candidate },
          subject.missingHint,
        ),
      );
    }
    if (errno === 'ELOOP') {
      // `realpath` had already resolved this path and it was not a link, so a
      // link at it now means the file was replaced between the two calls. The
      // open refused to follow it, which is the point of the flag.
      return err(
        unsafePathFailure(
          `${subject.label} was replaced by a symbolic link while it was being opened, and was not read.`,
          { ...subject.details, path: realPath, errno },
          'A prompt file is opened without following symbolic links. The path resolved to a real ' +
            'file a moment earlier and is a link now: remove the link, then load again.',
        ),
      );
    }
    return err(
      unexpectedFsFailure(
        `${subject.label} could not be opened.`,
        { ...subject.details, path: realPath, errno: errno ?? 'unknown' },
        caught,
      ),
    );
  }

  try {
    let stats: Stats;
    try {
      stats = fstatSync(fd);
    } catch (caught) {
      return err(
        unexpectedFsFailure(
          `${subject.label} could not be inspected after it was opened.`,
          { ...subject.details, path: realPath, errno: errnoOf(caught) ?? 'unknown' },
          caught,
        ),
      );
    }

    if (!stats.isFile()) {
      const kind = describeFileKind(stats);
      return err(
        configFailure(
          `${subject.label} is ${kind.phrase}, not a file.`,
          { ...subject.details, path: realPath, kind: kind.token },
          subject.missingHint,
        ),
      );
    }

    if (stats.size > subject.maxBytes) {
      return err(
        configFailure(
          `${subject.label} is larger than the ${subject.maxBytesLabel} this loader reads.`,
          {
            ...subject.details,
            path: realPath,
            bytes: stats.size,
            maxBytes: subject.maxBytes,
          },
          subject.oversizeHint,
        ),
      );
    }

    // Zero-filled rather than `allocUnsafe`: the buffer is decoded only after
    // every byte of it has been read, and a zeroed buffer keeps a future change
    // to that logic from ever decoding uninitialised heap memory into a prompt.
    const buffer = Buffer.alloc(stats.size);
    let filled = 0;
    try {
      while (filled < buffer.length) {
        // `null` position: read from the descriptor's own offset, so the loop
        // advances rather than re-reading the first chunk.
        const read = readSync(fd, buffer, filled, buffer.length - filled, null);
        if (read === 0) {
          break;
        }
        filled += read;
      }

      if (filled < buffer.length) {
        return err(changedUnderReadFailure(subject, realPath, stats.size, filled));
      }

      // One byte past the size that was measured. Reading it means the file
      // grew while the loop ran, so what was read is a prefix of the file
      // rather than the file — for a prompt, an instruction set with its end
      // missing.
      const probe = Buffer.alloc(1);
      if (readSync(fd, probe, 0, 1, null) > 0) {
        return err(changedUnderReadFailure(subject, realPath, stats.size, stats.size + 1));
      }
    } catch (caught) {
      return err(
        unexpectedFsFailure(
          `${subject.label} could not be read.`,
          { ...subject.details, path: realPath, errno: errnoOf(caught) ?? 'unknown' },
          caught,
        ),
      );
    }

    // `toString('utf8')` decodes exactly as `readFileSync(path, 'utf8')` does,
    // byte-order mark included, so {@link normalizeBody} and the manifest
    // parser see precisely what they saw before the read was hardened.
    return ok(buffer.toString('utf8'));
  } finally {
    try {
      closeSync(fd);
    } catch (caught) {
      // A descriptor that will not close cannot change what was already read,
      // and throwing here would replace a good result — or a precise failure —
      // with an error about cleanup. It is reported instead, because a host
      // process seeing this repeatedly is leaking descriptors.
      logger.warn('A prompt file descriptor could not be closed', {
        path: realPath,
        errno: errnoOf(caught) ?? 'unknown',
      });
    }
  }
}

/**
 * The failure for a subject whose length changed between the `fstat` and the
 * end of the read.
 *
 * `CONFIG_INVALID`, not `INTERNAL`: nothing is wrong with this process — a
 * prompt file is immutable once committed, so a file changing under a read
 * means something is writing into the prompts directory while the service reads
 * from it, which is a fact about the environment and has an action attached to
 * it. The sizes travel; no content does.
 */
function changedUnderReadFailure(
  subject: ReadSubject,
  realPath: string,
  expectedBytes: number,
  observedBytes: number,
): DebuggenError {
  return configFailure(
    `${subject.label} changed size while it was being read, so it was not used.`,
    { ...subject.details, path: realPath, expectedBytes, observedBytes },
    'A committed prompt file never changes: a new version is a new file plus a manifest update. ' +
      'Wait for whatever is writing this file to finish, then load again.',
  );
}

/** A file that was read from inside the prompts directory. */
interface ContainedFile {
  /** The resolved absolute path that was proven to be inside the root. */
  readonly realPath: string;

  /** The file's decoded text, exactly as read. */
  readonly text: string;
}

/**
 * Normalises a prompt file's content into the published {@link PromptFile.text}:
 * byte-order mark removed, exactly one trailing newline, nothing else changed.
 *
 * `trimEnd` rather than a `/\s+$/` replacement — same result, linear, and with
 * no regular expression to backtrack over a long run of trailing whitespace. A
 * file that holds nothing but whitespace normalises to the empty string, which
 * the caller reports as an empty prompt rather than sending to a model.
 */
function normalizeBody(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const trimmed = withoutBom.trimEnd();
  return trimmed.length === 0 ? '' : `${trimmed}\n`;
}

/** A value that is absent, empty or only whitespace, reported as absent. */
function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.trim().length === 0 ? undefined : value;
}

/**
 * Applies the two resolution channels in precedence order and returns an
 * absolute path, or the empty string when neither supplied one.
 *
 * A blank value counts as absent in **both** channels: an environment variable
 * set to the empty string is the conventional way of saying "unset", and a
 * caller whose computed path came out empty has not configured a directory
 * either. Whichever channel wins, a relative path is resolved against the
 * process working directory — resolving a path a caller deliberately provided
 * is not the same thing as inventing one, which {@link createPromptLoader}
 * explains at length.
 */
function configuredPromptsDir(
  promptsDir: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  logger: Logger,
): string {
  const fromOption = blankToUndefined(promptsDir);
  const fromEnv = blankToUndefined(env[PROMPTS_DIR_ENV_VAR]);
  const configured = fromOption ?? fromEnv;

  if (configured === undefined) {
    return '';
  }

  if (!isAbsolute(configured)) {
    logger.debug('Resolving a relative prompts directory against the working directory', {
      promptsDir: reportable(configured),
      source: fromOption !== undefined ? 'option' : PROMPTS_DIR_ENV_VAR,
    });
  }

  return resolve(configured);
}

/**
 * Check 1 of the traversal guard: the stage must be one of the six known
 * stages.
 *
 * This is the check that matters most, and it runs before any string becomes
 * part of a path: a closed set defeats `'../../etc'`, an absolute path, an
 * encoded traversal and a value of the wrong type in one comparison, because
 * none of them is a member of it. The stage is typed as {@link PromptStage} at
 * every call site, so reaching this with anything else means the value came
 * from a manifest, a stored session record or a cast — which is exactly the
 * traffic a guard is for.
 *
 * @returns The rejection, or `undefined` when the stage is known.
 */
function rejectStage(stage: unknown): DebuggenError | undefined {
  if (isPromptStage(stage)) {
    return undefined;
  }
  return unsafePathFailure(
    `'${reportable(stage)}' is not a known prompt stage, so it cannot address a prompt file.`,
    { stage: reportable(stage), knownStages: [...PROMPT_STAGES] },
  );
}

/**
 * Check 2 of the traversal guard: the version must be a `vNNN` stem.
 *
 * A fixed-width, digits-only stem is not a stylistic preference here: it is
 * what makes `'..'`, `'.'`, a path separator, an encoded separator, an absolute
 * path and an extension of any kind impossible to express as a version. The
 * pattern is `@debuggen/model-provider`'s own, shared with the manifest schema,
 * so the two can never diverge.
 *
 * @returns The rejection, or `undefined` when the version is well formed.
 */
function rejectVersion(version: unknown): DebuggenError | undefined {
  if (typeof version === 'string' && PROMPT_VERSION_PATTERN.test(version)) {
    return undefined;
  }
  return unsafePathFailure(
    `'${reportable(version)}' is not a prompt version; a version is 'v' followed by exactly three digits.`,
    { version: reportable(version) },
  );
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/**
 * Builds a {@link PromptLoader} over a directory of versioned prompt files.
 *
 * ## Where the directory comes from, and why there is no third channel
 *
 * In precedence order:
 *
 * 1. `options.promptsDir`, when it is a non-blank string. The local service
 *    passes it: it owns the prompts and knows where they are.
 * 2. the `DEBUGGEN_PROMPTS_DIR` environment variable. The packaged editor
 *    extension needs this one: its build copies the service's prompt tree into
 *    the extension and the host spawns the embedded service with the variable
 *    pointing at the copy, so the service finds its prompts in a layout it
 *    could not have computed.
 * 3. **nothing.** With neither channel supplied, every method returns a
 *    `CONFIG_INVALID` failure whose hint names both.
 *
 * The absent third channel is the deliberate part. A path derived from
 * `process.cwd()` or from this module's own URL would be wrong in at least one
 * of the layouts this package is shipped in — bundled into the service's
 * output, and bundled again into the packaged extension, where the prompts sit
 * beside the bundle rather than in the repository tree the source path implies.
 * A guess that happens to work in development and silently resolves to a stale
 * or absent directory in a package is worse than a refusal: the refusal is one
 * error with a hint, while the guess is a stage rendering the wrong version of
 * a prompt with the session recording the right one.
 *
 * ## Caching
 *
 * On by default, and sound because **a committed prompt file never changes** —
 * a prompt change is a new `vNNN+1.md` plus a manifest update, so a cached body
 * cannot go stale under a running session. Cached are the directory
 * resolution, the parsed manifest and each prompt body keyed by stage and
 * version. **Only successes are cached**: a failure is never remembered, so a
 * directory that appears a moment later, or a manifest a developer has just
 * fixed, is picked up on the next call rather than sticking for the lifetime of
 * the loader. Pass `cache: false` to read from disk every time, and
 * {@link PromptLoader.clearCache} to drop what has been cached.
 *
 * @param options See {@link PromptLoaderOptions}; every member has a default.
 * @returns A frozen loader. Construction performs **no** I/O and cannot fail:
 * the directory is validated on first use, so a caller can build a loader
 * during start-up and report a configuration problem where it can be handled.
 */
export function createPromptLoader(options: PromptLoaderOptions = {}): PromptLoader {
  const env = options.env ?? process.env;
  const cacheEnabled = options.cache ?? true;
  const logger = options.logger ?? noopLogger;
  const configuredDir = configuredPromptsDir(options.promptsDir, env, logger);
  const manifestPath = configuredDir.length === 0 ? '' : join(configuredDir, MANIFEST_FILE_NAME);

  /** Successful directory resolution, when caching is on. */
  let rootCache: PromptRoot | undefined;

  /** The parsed, complete manifest, when caching is on. */
  let manifestCache: ManifestState | undefined;

  /** Loaded bodies by `` `${stage}:${version}` ``, when caching is on. */
  const fileCache = new Map<string, PromptFile>();

  /**
   * Validates the configured directory and resolves its real path — the root
   * every containment check is measured against.
   */
  function resolveRoot(): Result<PromptRoot, DebuggenError> {
    if (rootCache !== undefined) {
      return ok(rootCache);
    }

    if (configuredDir.length === 0) {
      return err(
        configFailure(
          'No prompts directory is configured, so no prompt can be loaded.',
          { envVar: PROMPTS_DIR_ENV_VAR },
          DIRECTORY_HINT,
        ),
      );
    }

    let stats: Stats | undefined;
    try {
      // `throwIfNoEntry: false` turns the common "not there" case into a value
      // instead of an exception; every other errno still throws and is
      // reported as an unexpected failure with its code attached.
      stats = statSync(configuredDir, { throwIfNoEntry: false });
    } catch (caught) {
      if (isInvalidArgument(caught)) {
        return err(
          configFailure(
            `The configured prompts path '${reportable(configuredDir)}' is not a usable path.`,
            { promptsDir: reportable(configuredDir), errno: errnoOf(caught) ?? 'unknown' },
            DIRECTORY_HINT,
          ),
        );
      }
      return err(
        unexpectedFsFailure(
          `The prompts directory '${reportable(configuredDir)}' could not be inspected.`,
          { promptsDir: configuredDir, errno: errnoOf(caught) ?? 'unknown' },
          caught,
        ),
      );
    }

    if (stats === undefined) {
      return err(
        configFailure(
          `The prompts directory '${reportable(configuredDir)}' does not exist.`,
          { promptsDir: configuredDir },
          DIRECTORY_HINT,
        ),
      );
    }

    if (!stats.isDirectory()) {
      return err(
        configFailure(
          `The configured prompts path '${reportable(configuredDir)}' is not a directory.`,
          { promptsDir: configuredDir },
          DIRECTORY_HINT,
        ),
      );
    }

    let realDir: string;
    try {
      realDir = realpathSync(configuredDir);
    } catch (caught) {
      return err(
        unexpectedFsFailure(
          `The prompts directory '${reportable(configuredDir)}' could not be resolved.`,
          { promptsDir: configuredDir, errno: errnoOf(caught) ?? 'unknown' },
          caught,
        ),
      );
    }

    const root: PromptRoot = { configuredDir, realDir };
    if (cacheEnabled) {
      rootCache = root;
    }
    return ok(root);
  }

  /**
   * Check 4 of the traversal guard, and the read itself.
   *
   * The candidate is built from the root's **real** path and the already
   * validated segments, then resolved with `realpath` and required to be inside
   * that root. This is the only check that can see a symbolic link planted
   * inside the prompts directory whose target lies outside it: the three
   * string-level checks before it work on the path as written, and
   * `@debuggen/shared`'s own documentation records that a link is beyond their
   * reach. `isWithin` matches on equality or root-plus-separator only, so a
   * sibling directory whose name merely starts with the root's is correctly not
   * inside it.
   *
   * A path that does not exist is reported as the subject being absent, never
   * as a containment failure: the two conditions have different causes and
   * different fixes, and collapsing them would send a developer looking for a
   * symbolic link that is not there.
   *
   * The read that follows opens the **resolved** path rather than the
   * candidate, so the bytes returned come from the location that was actually
   * checked, and it opens it with {@link READ_OPEN_FLAGS} — so a symbolic link
   * that appeared at that path since `realpath` answered is refused at the open
   * rather than followed, which is the narrow window this pair of calls used to
   * leave open. What remains, and is deliberately not chased, is one resolved
   * *regular file inside the root* being exchanged for another in the same
   * instant: closing that would mean holding a descriptor on each path
   * component and opening relative to it, and the subject here is the
   * developer's own prompt tree on their own machine rather than a path arriving
   * from a page or a socket — which is the case `@debuggen/shared`'s hardened
   * filesystem entry exists for. Whatever is read is, in every case, a regular
   * file inside the prompts directory and no larger than the subject's ceiling:
   * see {@link readBoundedFile}.
   */
  function readContained(
    root: PromptRoot,
    segments: readonly string[],
    subject: ReadSubject,
  ): Result<ContainedFile, DebuggenError> {
    const candidate = join(root.realDir, ...segments);

    let realPath: string;
    try {
      realPath = realpathSync(candidate);
    } catch (caught) {
      if (isMissingEntry(caught)) {
        return err(
          configFailure(
            `${subject.label} was not found at '${reportable(candidate)}'.`,
            { ...subject.details, path: candidate },
            subject.missingHint,
          ),
        );
      }
      return err(
        unexpectedFsFailure(
          `${subject.label} could not be resolved.`,
          { ...subject.details, path: candidate, errno: errnoOf(caught) ?? 'unknown' },
          caught,
        ),
      );
    }

    if (!isWithin(root.realDir, realPath)) {
      return err(
        containmentFailure({
          ...subject.details,
          promptsDir: root.realDir,
          relativePath: segments.join('/'),
        }),
      );
    }

    // Kind, ceiling and read, in that order: a directory in the file position
    // is refused by the kind check rather than by an `EISDIR` from a read that
    // had already been attempted.
    const text = readBoundedFile(realPath, candidate, subject, logger);
    if (isErr(text)) {
      return text;
    }

    return ok({ realPath, text: text.value });
  }

  /**
   * Reads, parses and completeness-checks the manifest, caching the result.
   *
   * The completeness check is what turns Zod's per-key `undefined` issues into
   * one sentence naming the stages a manifest left out. It also re-checks each
   * `current` against the version pattern: redundant against today's schema,
   * and the thing that keeps the guarantee if that schema is ever loosened.
   */
  function readManifest(): Result<ManifestState, DebuggenError> {
    if (manifestCache !== undefined) {
      return ok(manifestCache);
    }

    const root = resolveRoot();
    if (isErr(root)) {
      return root;
    }

    const file = readContained(root.value, [MANIFEST_FILE_NAME], {
      label: 'The prompt manifest',
      missingHint: `Add '${MANIFEST_FILE_NAME}' to the prompts directory, naming the current version of every stage.`,
      maxBytes: MAX_MANIFEST_BYTES,
      maxBytesLabel: MAX_MANIFEST_BYTES_LABEL,
      oversizeHint:
        'A manifest names the current version of every stage and is a few hundred bytes; check ' +
        'that the prompts directory is a prompt tree and not another directory that happens to ' +
        `hold a '${MANIFEST_FILE_NAME}'.`,
      details: { promptsDir: root.value.realDir, manifestFile: MANIFEST_FILE_NAME },
    });
    if (isErr(file)) {
      return file;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(file.value.text);
    } catch {
      // The thrown `SyntaxError`'s message quotes the offending fragment of the
      // file, so it is deliberately neither attached as a cause nor included
      // here: an error object travels into logs and across a process boundary,
      // and file contents do not follow it. The path and the size are enough
      // to find the file and see that it was read.
      return err(
        configFailure(
          'The prompt manifest is not valid JSON.',
          { manifestPath: file.value.realPath, bytes: file.value.text.length },
          'Correct the JSON syntax of the manifest; every stage needs an entry naming its current version.',
        ),
      );
    }

    const parsed = promptManifestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return err(
        configFailure(
          'The prompt manifest does not match the manifest schema.',
          { manifestPath: file.value.realPath, issues: summarizeIssues(parsed.error.issues) },
          `Every stage needs an entry of the form { "current": "vNNN" }; unknown stage keys are refused, and ${PROMPT_STAGES.length} stages are known.`,
        ),
      );
    }

    // A Zod record keyed by an enum yields a total record, so this widening is
    // only so the loop below can ask whether a key is there without the
    // compiler insisting it must be — the runtime answer is what the check is
    // for, and it survives a future switch to a partial record.
    const entries: Readonly<Record<string, PromptManifestEntry | undefined>> = parsed.data.stages;

    const currents: Partial<Record<PromptStage, PromptVersion>> = {};
    const unusable: PromptStage[] = [];
    for (const stage of PROMPT_STAGES) {
      const entry = entries[stage];
      if (entry === undefined || !PROMPT_VERSION_PATTERN.test(entry.current)) {
        unusable.push(stage);
        continue;
      }
      currents[stage] = entry.current;
    }

    if (unusable.length > 0) {
      return err(
        configFailure(
          `The prompt manifest has no usable current version for: ${unusable.join(', ')}.`,
          { manifestPath: file.value.realPath, stages: unusable },
          'Give every stage an entry naming a current version of the form "vNNN".',
        ),
      );
    }

    const state: ManifestState = {
      path: file.value.realPath,
      manifest: parsed.data,
      // Every stage was assigned above — the loop pushes onto `unusable`
      // otherwise, and an unusable stage has already returned — so the partial
      // record is total here and the assertion cannot outlive that fact.
      currents: Object.freeze(currents as Record<PromptStage, PromptVersion>),
    };

    if (cacheEnabled) {
      manifestCache = state;
    }

    logger.debug('Loaded prompt manifest', {
      manifestPath: state.path,
      manifestVersion: state.manifest.version,
      versions: { ...state.currents },
    });

    return ok(state);
  }

  /**
   * The single funnel every prompt read passes through: the four checks, the
   * read, the normalisation and the cache.
   *
   * Checks 1 and 2 run here as well as at the entry points. That is not
   * duplication for its own sake: this is the only function that turns a stage
   * and a version into a path, so the guarantee belongs where the path is
   * built, and a future caller added inside this module inherits it.
   */
  function loadFile(stage: PromptStage, version: PromptVersion): Result<PromptFile, DebuggenError> {
    const stageRejection = rejectStage(stage);
    if (stageRejection !== undefined) {
      return err(stageRejection);
    }

    const versionRejection = rejectVersion(version);
    if (versionRejection !== undefined) {
      return err(versionRejection);
    }

    const cacheKey = `${stage}:${version}`;
    if (cacheEnabled) {
      const cached = fileCache.get(cacheKey);
      if (cached !== undefined) {
        return ok(cached);
      }
    }

    const fileName = `${version}${PROMPT_FILE_EXTENSION}`;

    // Check 3: the relative path as a string, through the shared validator
    // that refuses an empty or whitespace path, a control character, a
    // backslash, an absolute or drive-letter path and any surviving '..'.
    // Cheap, and it holds even if checks 1 and 2 are ever weakened.
    const relativePath = joinPosix(stage, fileName);
    if (!isSafeRelativePath(relativePath)) {
      return err(
        unsafePathFailure(
          `'${reportable(relativePath)}' is not a safe relative path and was not opened.`,
          { stage, version, relativePath: reportable(relativePath) },
        ),
      );
    }

    const root = resolveRoot();
    if (isErr(root)) {
      return root;
    }

    const file = readContained(root.value, [stage, fileName], {
      label: `The prompt file for stage '${stage}' version '${version}'`,
      missingHint: `Add '${relativePath}' to the prompts directory, or ask for a version that exists.`,
      maxBytes: MAX_PROMPT_BYTES,
      maxBytesLabel: MAX_PROMPT_BYTES_LABEL,
      oversizeHint:
        'A prompt file holds one stage\u2019s instructions and is a few kilobytes: the output ' +
        'schema, the catalogs and the captured evidence are supplied as placeholder values at ' +
        'render time, not committed into the file.',
      details: { stage, version },
    });
    if (isErr(file)) {
      return file;
    }

    const text = normalizeBody(file.value.text);
    if (text.length === 0) {
      // An empty prompt is never legitimate: the stage would call the model with
      // no instructions, no output schema and no citation rule, and the result
      // would fail validation later with nothing pointing back at the cause.
      return err(
        configFailure(
          `The prompt file for stage '${stage}' version '${version}' is empty.`,
          { stage, version, path: file.value.realPath },
          'A prompt file must contain the stage instructions; an empty file cannot be sent to a model.',
        ),
      );
    }

    // The published contract first, the diagnostic path last, in the order
    // {@link PromptFile} declares them.
    const promptFile: PromptFile = Object.freeze({
      stage,
      version,
      text,
      path: file.value.realPath,
    });

    if (cacheEnabled) {
      fileCache.set(cacheKey, promptFile);
    }

    logger.debug('Loaded prompt file', {
      stage,
      version,
      path: promptFile.path,
      bytes: text.length,
    });

    return ok(promptFile);
  }

  function load(stage: PromptStage): Result<PromptFile, DebuggenError> {
    // Validated before the manifest is touched, so an unknown stage is reported
    // as an unknown stage rather than as a manifest that is missing an entry
    // for it.
    const stageRejection = rejectStage(stage);
    if (stageRejection !== undefined) {
      return err(stageRejection);
    }

    const manifest = readManifest();
    if (isErr(manifest)) {
      return manifest;
    }

    return loadFile(stage, manifest.value.currents[stage]);
  }

  function loadVersion(stage: PromptStage, version: string): Result<PromptFile, DebuggenError> {
    // No manifest read, by design: see `PromptLoader.loadVersion`. A reopened
    // session's recorded version is frequently a superseded one, and it must
    // load whatever the manifest says today — and even when the manifest itself
    // is unreadable.
    return loadFile(stage, version);
  }

  function versions(): Result<Readonly<Record<PromptStage, PromptVersion>>, DebuggenError> {
    const manifest = readManifest();
    if (isErr(manifest)) {
      return manifest;
    }
    return ok(manifest.value.currents);
  }

  function clearCache(): void {
    rootCache = undefined;
    manifestCache = undefined;
    fileCache.clear();
  }

  const loader: PromptLoader = {
    promptsDir: configuredDir,
    manifestPath,
    load,
    loadVersion,
    versions,
    clearCache,
  };

  return Object.freeze(loader);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Substitutes `{{key}}` placeholders in a prompt body, and does nothing else.
 *
 * ## Logic-free, deliberately
 *
 * The grammar is one production: `{{key}}`, where `key` is letters, digits,
 * underscores and dots, with optional whitespace inside the braces. There are
 * **no** conditionals, loops, filters, nested expressions, defaults or
 * partials, and adding one is a product decision rather than a convenience. A
 * prompt is a document a human wrote and reviewed, immutable once committed and
 * cited by version on every session that used it; the moment its text can
 * branch, what a stored session "used" stops being readable from the file and
 * two runs of the same version can say different things.
 *
 * ## A missing value is an error, not an empty string
 *
 * Every `{{key}}` with no supplied value is collected and reported together, in
 * one failure naming all of them, because the alternative is silent
 * degradation: these prompts embed the stage's JSON Schema and its
 * evidence-citation rule, so dropping a placeholder produces a model call with
 * no output schema or no citation requirement — and then an artifact that fails
 * validation for a reason that points nowhere near the cause. Failing here
 * names the missing keys and the stage's prompt version instead.
 *
 * Supplying a value the template does not reference is fine, and intentionally
 * so: a caller assembling one context object for several stages legitimately
 * passes a superset. The unused keys are logged at `debug` — the keys only,
 * never the values, which are derived from the developer's source code and
 * captured telemetry.
 *
 * ## Supplying nothing at all is the same as supplying an empty record
 *
 * A `null` or `undefined` in the `values` position is a caller-side defect the
 * signature already forbids, and it is handled rather than thrown on: "no
 * substitutions are available" is exactly what an empty record means here, so
 * one stands in and the ordinary rules then apply unchanged — a template that
 * names placeholders fails below naming every one of them, and a template that
 * names none renders unchanged, there being nothing to substitute. The defect
 * is still recorded, at `debug` and in the failure's `details.valuesSupplied`,
 * so it reads as "the call arrived with no values" rather than as "the object
 * was missing these keys" and the developer looks at the call site instead of
 * at their key names.
 *
 * What must never happen is the alternative: both accesses to this argument —
 * the presence check per placeholder and the unused-key diagnostic — are
 * `Object` operations that reject a nullish receiver, so an unguarded renderer
 * throws a `TypeError` out of a function that every caller invokes for its
 * `Result`. A stage would lose its typed failure, its hint and its session
 * status to an exception nothing on that path is written to catch.
 *
 * ## The single-pass guarantee
 *
 * One left-to-right pass, and substituted text is **never re-scanned**. A value
 * containing `{{something}}` is emitted literally and cannot expand further.
 * That is a security property, not a performance one: values carry code
 * excerpts, span attributes and a developer's own question, so a re-scanning
 * renderer would let captured data name a placeholder and pull another value
 * into a position the prompt author never wrote.
 *
 * @param template The prompt text, normally {@link PromptFile.text}.
 * @param values The substitutions. Strings are inserted as they are; numbers
 * and booleans are stringified without locale involvement, so the same input
 * renders identically on every machine. A nullish argument is read as
 * {@link NO_PROMPT_VALUES}, an empty record.
 * @param logger Where the unused-key and no-values diagnostics go. Defaults to
 * `noopLogger`, which is why the two-argument call is the ordinary one.
 * @returns The rendered prompt, or `CONFIG_INVALID` naming every placeholder
 * that had no value — a mismatch between a versioned prompt file and the code
 * that renders it, or a caller that supplied no values at all, which the
 * failure's `details.valuesSupplied` distinguishes — or `INTERNAL` when the
 * template is not a string or a value's runtime type is not one the signature
 * permits, neither of which anything but a cast can produce.
 *
 * @example
 * ```ts
 * const rendered = renderPrompt('Return output matching {{schema}}.', {
 *   schema: jsonSchemaText,
 * });
 * ```
 */
export function renderPrompt(
  template: string,
  values: Readonly<Record<string, string | number | boolean>>,
  logger: Logger = noopLogger,
): Result<string, DebuggenError> {
  if (typeof template !== 'string') {
    return err(
      new DebuggenError('INTERNAL', 'A prompt template must be a string.', {
        hint: 'Render the text of a loaded prompt file.',
        details: { templateType: typeof template },
      }),
    );
  }

  // Declared as a record and checked anyway, exactly as the template above is.
  // Left unchecked, a nullish argument reaches `Object.hasOwn(values, key)` in
  // the scan below — or `Object.keys(values)` in the unused-key diagnostic, for
  // a template that names no placeholder at all — and both throw `TypeError:
  // Cannot convert undefined or null to object` past every `Result` this
  // module returns.
  //
  // The condition is read off a widened alias rather than off `values`: the
  // declared type is not nullable, so a check written against the parameter is
  // one the compiler narrows away as dead, and the next reader deletes.
  const argument: unknown = values;
  const nothingSupplied = argument === null || argument === undefined;
  const supplied = nothingSupplied ? NO_PROMPT_VALUES : values;

  if (nothingSupplied) {
    // A caller bug rather than a prompt bug, so it is recorded beside the
    // unused-key diagnostic rather than raised on its own: with placeholders
    // present the failure below already names every one of them, and with none
    // present there is nothing to fail about. The type is logged, never a
    // value — there is none to log here, and the habit is what keeps this
    // module's diagnostics free of the developer's code and telemetry.
    logger.debug('No placeholder values were supplied to render a prompt', {
      valuesType: argument === null ? 'null' : 'undefined',
    });
  }

  const missing = new Set<string>();
  const unusable = new Set<string>();
  const used = new Set<string>();

  // An explicit scanner rather than a replacer callback, for two reasons: the
  // capture group arrives typed instead of as `any`, and the cursor makes the
  // single-pass guarantee visible — every character of the output comes either
  // from a slice of the original template or from one substituted value, and
  // nothing written to the output is ever examined again.
  const pattern = new RegExp(PLACEHOLDER_SOURCE, 'g');
  let out = '';
  let cursor = 0;

  for (const match of template.matchAll(pattern)) {
    const placeholder = match[0];
    const key = match[1];

    out += template.slice(cursor, match.index);
    cursor = match.index + placeholder.length;

    if (key === undefined) {
      // The pattern has exactly one group, so this cannot happen through it;
      // emitting the placeholder verbatim is the honest answer for a match
      // whose key could not be read, rather than dropping text from a prompt.
      out += placeholder;
      continue;
    }

    // `Object.hasOwn`, never a bare property read: a key may legally contain
    // underscores, so '__proto__' matches the grammar, and an inherited member
    // must not become a substitution.
    const value: unknown = Object.hasOwn(supplied, key) ? supplied[key] : undefined;

    if (value === undefined || value === null) {
      missing.add(key);
      out += placeholder;
      continue;
    }

    if (typeof value === 'string') {
      used.add(key);
      out += value;
      continue;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        // 'NaN' and 'Infinity' are not measurements; a prompt must not carry
        // one as though it were.
        unusable.add(key);
        out += placeholder;
        continue;
      }
      used.add(key);
      out += String(value);
      continue;
    }

    if (typeof value === 'boolean') {
      used.add(key);
      out += String(value);
      continue;
    }

    unusable.add(key);
    out += placeholder;
  }

  out += template.slice(cursor);

  if (missing.size > 0) {
    const keys = [...missing].sort();
    return err(
      new DebuggenError(
        'CONFIG_INVALID',
        `The prompt template names ${keys.length} placeholder(s) with no supplied value: ${keys.join(', ')}.`,
        {
          hint:
            'Supply a value for every placeholder the prompt names, or write a new prompt version ' +
            'that does not name it.',
          // `valuesSupplied` appears only when it is false, and says which of
          // two very different call-site mistakes this is: an object that lacks
          // some keys, or no object at all.
          details: nothingSupplied
            ? { missingPlaceholders: keys, valuesSupplied: false }
            : { missingPlaceholders: keys },
        },
      ),
    );
  }

  if (unusable.size > 0) {
    const keys = [...unusable].sort();
    return err(
      new DebuggenError(
        'INTERNAL',
        `The values supplied for ${keys.length} placeholder(s) cannot be rendered: ${keys.join(', ')}.`,
        {
          hint: 'A placeholder value must be a string, a finite number or a boolean.',
          details: { unusablePlaceholders: keys },
        },
      ),
    );
  }

  const unused = Object.keys(supplied).filter((key) => !used.has(key));
  if (unused.length > 0) {
    logger.debug('Prompt template does not reference every supplied value', {
      unusedKeys: unused.slice(0, MAX_REPORTED_UNUSED_KEYS).sort(),
      unusedCount: unused.length,
    });
  }

  return ok(out);
}
