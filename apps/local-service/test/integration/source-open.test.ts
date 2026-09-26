/**
 * Integration suite `source-open` (AAP §0.8.3): click-to-source over the live
 * WebSocket, judged against a real temporary filesystem.
 *
 * `src/source/open.test.ts` already pins the handler's rejection table against
 * in-memory ports. What only this suite can show is the composed service doing
 * it end to end, booted through `startService` by `./harness.js`:
 *
 * - **Forwarding over the wire.** A `source.open` sent by the DevTools
 *   connection bound to a session reaches exactly the session's VS Code
 *   connection — no other client kind, and not the editor of another project —
 *   as a fresh envelope whose location is deep-equal to what was sent, its
 *   `confidence` included. The service forwards; it never re-resolves
 *   (`src/source/open.ts` deliberately does not import `src/source/resolve.ts`),
 *   and every resolver of `SOURCE_RESOLVED_BY` is sent with a confidence that
 *   differs from its default, so a re-stamp would be caught.
 * - **The target is pinned.** Every forward carries `pinned`: the file relative
 *   to the canonical root with every link resolved, and the device and inode of
 *   a `bigint` `lstat` of it. A link re-pointed out of the project while the
 *   frame waits for the editor leaves the pin naming the file that was proved,
 *   so an editor enforcing it refuses; a frame that arrives already carrying a
 *   pin is refused before anything is forwarded.
 * - **Containment against a real directory layout.** The copied fixture
 *   project gets a real prefix sibling (`<projectRoot>-evil`, which a bare
 *   `startsWith` would wrongly accept) and real symbolic links planted at run
 *   time: one inside the project that stays inside (accepted), and several
 *   inside the project that lead out of it — to a file, to the prefix sibling,
 *   through an interior directory link, and round a cycle — which only the
 *   `realpath` layer can catch. Every lexically hostile path (`..`, absolute
 *   POSIX, Windows drive, UNC, control characters, the lexical prefix sibling)
 *   is refused by payload validation before any filesystem work, and every row
 *   leaves its would-be target byte-identical.
 * - **Authority from the store and the principal.** The project root a path is
 *   judged against is the stored `SessionRecord`'s, never anything the frame
 *   says; a DevTools connection may open source only for the session bound to
 *   its own tab; a server agent is refused; the page agent cannot even hold a
 *   principal on the socket.
 * - **Non-delivery is an answer, not a failure.** With no editor connected the
 *   handler's outcome is `delivered: false` / `no-editor-client`; the service
 *   answers the sender with `source.result` `no-editor`, `ref` = the sender's
 *   own frame id — the cue for the extension's
 *   `vscode://debuggen.debug-generator/open` fallback — and no `error`, and the
 *   sender's connection stays open. Nothing is queued for an editor that
 *   connects later.
 * - **Delivery is not opening.** A forwarded location is answered to its sender
 *   only once the editor has answered the forwarded frame: the editor's
 *   `opened` or `failed` (with its code) reaches the sender as `source.result`
 *   under the sender's own `ref`, and nothing is claimed before that. Only an
 *   editor whose workspace covers the session may answer — an editor of another
 *   project and a DevTools connection are refused — and an answer for a frame
 *   the service never forwarded is accepted and relayed to nobody. A frame
 *   whose id is too long for a `source.result` `ref` is refused before it is
 *   forwarded, so no location is opened that its sender could not hear about.
 * - **Privacy.** No error payload, no relayed result and no captured log record
 *   carries an absolute outside path, a symbolic link's target, file content or
 *   a credential. A refusal by the handler — whose sentence may name the
 *   requested project-relative file — is answered as a `failed` `source.result`
 *   to the sender alone, never as a session-less `error` frame; only refusals
 *   made before the handler runs (payload validation, role, binding), whose
 *   sentences quote nothing from the request, are `error` replies.
 *
 * Every path this suite plants lives inside the `fs.mkdtemp` containers of the
 * harness's project copies; the committed corpus under `test/fixtures/**` is
 * only ever read, and the last test proves the copies and the corpus
 * byte-identical with `assertTreeUnchanged`. Sessions are created through the
 * service's own `SessionManager` rather than `POST /sessions`, so no pipeline
 * run instruments the copies behind the suite's back: whatever the tree
 * assertion proves is a statement about `source.open` alone.
 *
 * No error code and no message type is typed out as a string: codes are read
 * from `DEBUGGEN_ERROR_CODES`, and the two message types this suite exchanges
 * are read from the registry of the protocol module that owns them, by the
 * payload schema each one maps to.
 */

import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, realpath, symlink, unlink } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPES,
  SOURCE_MESSAGE_PAYLOADS,
  encodeMessage,
  isMessageOfType,
  parseMessage,
  parseSourceOpenPayload,
  parseSourceResultPayload,
  sourceOpenPayloadSchema,
  sourceResultPayloadSchema,
} from '@debuggen/protocol';
import type {
  ErrorPayload,
  MessageType,
  ProtocolMessage,
  SessionRecord,
  SourceOpenPayload,
  SourceResultPayload,
} from '@debuggen/protocol';
import {
  DEBUGGEN_ERROR_CODES,
  DEFAULT_RESOLUTION_CONFIDENCE,
  SOURCE_RESOLVED_BY,
  isErr,
  isWithin,
  newMessageId,
  parseSourceLocation,
  toPosix,
} from '@debuggen/shared';
import type { DebuggenErrorCode, SourceLocation, SourceResolvedBy } from '@debuggen/shared';
import { createFileExclusive, sha256OfFile } from '@debuggen/shared/node';

import { SOURCE_OPEN_REJECTIONS } from '../../src/source/open.js';
import type {
  SourceOpenPin,
  SourceOpenRejection,
  SourceOpenUndelivered,
} from '../../src/source/open.js';
import {
  DEFAULT_FIXTURE_PROJECT,
  HARNESS_TIMEOUTS,
  assertTreeUnchanged,
  fixturePath,
  isUnauthorizedClose,
  startHarness,
  waitFor,
} from './harness.js';
import type {
  CapturedLogRecord,
  DevtoolsConnection,
  FixtureProjectCopy,
  Harness,
  HarnessMessage,
  HarnessWsClient,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary, read from its owners
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every error code, keyed by itself and built from `DEBUGGEN_ERROR_CODES`, so
 * `CODE.FS_UNSAFE_PATH` is both compile-checked and read from the shared
 * vocabulary rather than typed out.
 */
const CODE = Object.freeze(
  Object.fromEntries(DEBUGGEN_ERROR_CODES.map((code) => [code, code])),
) as { readonly [C in DebuggenErrorCode]: C };

/** The handler's refusal vocabulary, keyed by itself and built from `SOURCE_OPEN_REJECTIONS`. */
const REJECTION = Object.freeze(
  Object.fromEntries(SOURCE_OPEN_REJECTIONS.map((rejection) => [rejection, rejection])),
) as { readonly [R in SourceOpenRejection]: R };

/** The source-navigation registry: wire name → payload schema. */
type SourceRegistry = typeof SOURCE_MESSAGE_PAYLOADS;

/** The registry key whose payload schema is `S` — a single literal for each distinct schema. */
type SourceMessageTypeOf<S> = {
  [K in keyof SourceRegistry]: SourceRegistry[K] extends S ? K : never;
}[keyof SourceRegistry] &
  MessageType;

/**
 * The wire name under which `SOURCE_MESSAGE_PAYLOADS` — the registry
 * `packages/protocol/src/messages/source.ts` contributes to the envelope union,
 * the one place each wire name is written — registers `schema`.
 *
 * Looked up by schema identity, so no wire name is restated here, and proved to
 * be exactly one key that is also a member of `MESSAGE_TYPES`.
 */
function sourceMessageTypeOf<S extends SourceRegistry[keyof SourceRegistry]>(
  schema: S,
): SourceMessageTypeOf<S> {
  const declared = Object.entries(SOURCE_MESSAGE_PAYLOADS)
    .filter(([, candidate]) => candidate === schema)
    .map(([key]) => key)
    .filter((key): key is SourceMessageTypeOf<S> => MESSAGE_TYPES.some((type) => type === key));
  const [only, ...others] = declared;
  if (only === undefined || others.length > 0) {
    throw new Error('The source registry must declare the schema under exactly one message type.');
  }
  return only;
}

/** The request under test, read from its owning registry. */
const SOURCE_OPEN = sourceMessageTypeOf(sourceOpenPayloadSchema);

/** The answer to it, read from the same registry. */
const SOURCE_RESULT = sourceMessageTypeOf(sourceResultPayloadSchema);

/** A received `source.open` envelope. */
type SourceOpenMessage = HarnessMessage<typeof SOURCE_OPEN>;

/** What an editor may answer a forwarded location with: its payload without the correlation. */
type EditorAnswer =
  | { readonly status: 'opened' }
  | Pick<Extract<SourceResultPayload, { readonly status: 'failed' }>, 'status' | 'error'>;

/**
 * The handler's outcome when the location passed every check but no editor was
 * connected — typed against `src/source/open.ts`, so a renamed reason breaks
 * this suite's compile rather than its meaning.
 */
const NO_EDITOR_CLIENT: SourceOpenUndelivered['reason'] = 'no-editor-client';

/** The `subsystem` binding every record of `src/source/open.ts` carries. */
const SOURCE_SUBSYSTEM = 'source';

/* -------------------------------------------------------------------------------------------------
 * The fixture layout
 * ---------------------------------------------------------------------------------------------- */

/** A real source file of `test/fixtures/sample-project`, and a symbol and line inside it. */
const SERVICE_FILE = 'src/server/services/trail-report.service.ts';
const SERVICE_SYMBOL = 'loadTrailReport';
const SERVICE_LINE = 88;

/** An in-project link to {@link SERVICE_FILE}, planted beside it with a relative target. */
const ALIAS_LINK = 'src/server/services/trail-report.alias.ts';

/** An in-project link whose absolute target is a file outside the project. */
const ESCAPE_LINK = 'src/escape.ts';

/** An in-project link whose absolute target lies in the prefix sibling `<projectRoot>-evil`. */
const SIBLING_LINK = 'src/sibling.ts';

/** An in-project directory link to a directory outside the project. */
const VENDOR_LINK = 'src/vendor';

/** A two-link cycle inside the project. */
const LOOP_LINK_A = 'src/loop-a.ts';
const LOOP_LINK_B = 'src/loop-b.ts';

/** Nothing exists here, in either project. */
const MISSING_FILE = 'src/server/services/trail-report.missing.ts';

/** A directory, not a file. */
const DIRECTORY_ENTRY = 'src/server';

/** A regular file planted in the second project only. */
const OTHER_PROJECT_FILE = 'src/server/services/other-project-only.service.ts';

/** The suffix that makes the prefix sibling: `<projectRoot>-evil` starts with `<projectRoot>`. */
const SIBLING_SUFFIX = '-evil';

/** The inspected tabs of the two DevTools connections. */
const TAB_A = 4101;
const TAB_B = 4102;

/** What was planted, and the evidence the planted targets are never touched. */
interface Sandbox {
  /** The session's project root (the harness's default copy). */
  readonly root: string;
  /** `<root>-evil`: a sibling directory whose name merely starts with the root's. */
  readonly siblingDir: string;
  /** A decoy file inside {@link Sandbox.siblingDir}. */
  readonly siblingFile: string;
  /** A directory beside the project, inside the copy's container. */
  readonly outsideDir: string;
  /** A file inside {@link Sandbox.outsideDir}. */
  readonly outsideFile: string;
  /** Every entry planted inside a project copy, removed again by the last test. */
  readonly planted: readonly string[];
  /** SHA-256 of each would-be target, taken when it was written. */
  readonly targetHashes: ReadonlyMap<string, string>;
  /** Random content markers written into the planted files. */
  readonly markers: readonly string[];
}

/** Everything the suite's tests share, built once by {@link setUp}. */
interface SuiteState {
  readonly harness: Harness;
  readonly sandbox: Sandbox;
  readonly projectA: FixtureProjectCopy;
  readonly projectB: FixtureProjectCopy;
  readonly sessionA: SessionRecord;
  readonly sessionB: SessionRecord;
  readonly editorA: HarnessWsClient;
  readonly editorB: HarnessWsClient;
  readonly devtoolsA: DevtoolsConnection;
  readonly devtoolsB: DevtoolsConnection;
}

/* -------------------------------------------------------------------------------------------------
 * Suite state
 * ---------------------------------------------------------------------------------------------- */

/** The running harness; assigned as soon as it exists so a failed setup is still torn down. */
let harness: Harness | undefined;

/** The shared state, once {@link setUp} completed. */
let suite: SuiteState | undefined;

/** Every connection whose inbox is inspected for forwarded frames after each request. */
const watched: HarnessWsClient[] = [];

/** Every `error` payload any request of this suite was answered with — the privacy sweep's input. */
const errorReplies: ErrorPayload[] = [];

/** Every `source.result` any sender of this suite received — also swept for privacy. */
const resultReplies: SourceResultPayload[] = [];

/** Every credential handed to a connection of this suite, by label — none may ever be echoed. */
const credentials: { readonly label: string; readonly value: string }[] = [];

/** The shared state. @throws Error When the setup did not complete. */
function state(): SuiteState {
  if (suite === undefined) {
    throw new Error('The source-open suite setup did not complete.');
  }
  return suite;
}

/* -------------------------------------------------------------------------------------------------
 * Building locations
 * ---------------------------------------------------------------------------------------------- */

/** A random, distinctive marker for file content that must never surface anywhere. */
function uniqueMarker(label: string): string {
  return `${label}-${randomBytes(12).toString('hex')}`;
}

/** The resolver a request variant uses: every member of `SOURCE_RESOLVED_BY` in turn. */
function resolverFor(variant: number): SourceResolvedBy {
  const resolvedBy = SOURCE_RESOLVED_BY[variant % SOURCE_RESOLVED_BY.length];
  if (resolvedBy === undefined) {
    throw new Error('SOURCE_RESOLVED_BY is empty.');
  }
  return resolvedBy;
}

/**
 * A confidence that is valid but deliberately **not** the resolver's default,
 * so a service that re-resolved or re-stamped the location would be caught.
 */
function offDefaultConfidence(resolvedBy: SourceResolvedBy): number {
  const standard = DEFAULT_RESOLUTION_CONFIDENCE[resolvedBy];
  const skewed = standard >= 0.5 ? standard - 0.217 : standard + 0.217;
  return Math.round(skewed * 1000) / 1000;
}

/**
 * A well-formed location, built through `parseSourceLocation` so that the only
 * thing any request varies is the property under test.
 *
 * @param file A project-relative file the shared schema accepts.
 * @param variant Picks the resolver, the position and whether the optional
 * `symbol`/`endLine` pair is present.
 */
function locationFor(file: string, variant = 0): SourceLocation {
  const resolvedBy = resolverFor(variant);
  const line = SERVICE_LINE + variant;
  const parsed = parseSourceLocation({
    file,
    line,
    column: 3 + variant,
    resolvedBy,
    confidence: offDefaultConfidence(resolvedBy),
    ...(variant % 2 === 0 ? { symbol: SERVICE_SYMBOL, endLine: line + 24 } : {}),
  });
  if (isErr(parsed)) {
    throw new Error(
      `The suite's own location for ${file} did not validate: ${parsed.error.message}`,
    );
  }
  return parsed.value;
}

/**
 * A location that is well-formed in every field except `file`: the parsed
 * {@link locationFor} value with only its path replaced. The protocol client
 * validates nothing on send, so the hostile path reaches the service verbatim.
 */
function withFile(file: string, variant = 0): SourceLocation {
  return { ...locationFor(SERVICE_FILE, variant), file };
}

/* -------------------------------------------------------------------------------------------------
 * The sandbox
 * ---------------------------------------------------------------------------------------------- */

/** One symbolic link planted inside the session's project copy. */
interface PlantedLink {
  /** Project-relative path of the link. */
  readonly path: string;
  /** The link's target text, absolute or relative to the link's directory. */
  readonly target: string;
  /** `dir` for a directory link. */
  readonly type?: 'dir' | 'file';
}

/** A tiny TypeScript module whose only content is a marker. */
function markerModule(name: string, marker: string): string {
  return `export const ${name} = '${marker}';\n`;
}

/**
 * Lays out the real directory structure the containment rows need, entirely
 * inside the two copies' `fs.mkdtemp` containers:
 *
 * ```text
 * <container A>/
 *   sample-project/                  the session's project root
 *     src/server/services/trail-report.alias.ts -> trail-report.service.ts
 *     src/escape.ts                  -> <container A>/outside-<hex>/secret.ts
 *     src/sibling.ts                 -> <container A>/sample-project-evil/decoy.service.ts
 *     src/vendor/                    -> <container A>/outside-<hex>/
 *     src/loop-a.ts -> loop-b.ts, src/loop-b.ts -> loop-a.ts
 *   sample-project-evil/decoy.service.ts   the prefix sibling
 *   outside-<hex>/secret.ts
 * <container B>/sample-project/src/server/services/other-project-only.service.ts
 * ```
 */
async function plantSandbox(
  projectA: FixtureProjectCopy,
  projectB: FixtureProjectCopy,
): Promise<Sandbox> {
  const root = projectA.root;
  const markers = [uniqueMarker('decoy'), uniqueMarker('secret'), uniqueMarker('other')];
  const [decoyMarker, secretMarker, otherMarker] = markers;
  if (decoyMarker === undefined || secretMarker === undefined || otherMarker === undefined) {
    throw new Error('Three content markers are needed.');
  }

  const siblingDir = `${root}${SIBLING_SUFFIX}`;
  await mkdir(siblingDir, { mode: 0o700 });
  const siblingFile = toPosix(join(siblingDir, 'decoy.service.ts'));
  createFileExclusive(siblingFile, markerModule('decoy', decoyMarker), {
    requireSecureParents: false,
  });

  const outsideDir = toPosix(join(projectA.container, `outside-${randomBytes(6).toString('hex')}`));
  await mkdir(outsideDir, { mode: 0o700 });
  const outsideFile = toPosix(join(outsideDir, 'secret.ts'));
  createFileExclusive(outsideFile, markerModule('secret', secretMarker), {
    requireSecureParents: false,
  });

  const links: readonly PlantedLink[] = [
    { path: ALIAS_LINK, target: basename(SERVICE_FILE) },
    { path: ESCAPE_LINK, target: outsideFile },
    { path: SIBLING_LINK, target: siblingFile },
    { path: VENDOR_LINK, target: outsideDir, type: 'dir' },
    { path: LOOP_LINK_A, target: basename(LOOP_LINK_B) },
    { path: LOOP_LINK_B, target: basename(LOOP_LINK_A) },
  ];
  const planted: string[] = [];
  for (const link of links) {
    const at = join(root, link.path);
    await symlink(link.target, at, link.type);
    planted.push(at);
  }

  const otherOnly = join(projectB.root, OTHER_PROJECT_FILE);
  createFileExclusive(otherOnly, markerModule('otherProjectOnly', otherMarker), {
    requireSecureParents: false,
  });
  planted.push(otherOnly);

  const targetHashes = new Map<string, string>([
    [outsideFile, await sha256OfFile(outsideFile)],
    [siblingFile, await sha256OfFile(siblingFile)],
    [otherOnly, await sha256OfFile(otherOnly)],
  ]);

  return Object.freeze({
    root,
    siblingDir,
    siblingFile,
    outsideDir,
    outsideFile,
    planted,
    targetHashes,
    markers,
  });
}

/** Asserts that every would-be target still holds exactly the bytes it was written with. */
async function expectTargetsUntouched(sandbox: Sandbox): Promise<void> {
  for (const [path, hash] of sandbox.targetHashes) {
    expect(await sha256OfFile(path), `a planted target changed: ${basename(path)}`).toBe(hash);
  }
}

/**
 * Every value that must never surface in an error payload or a log record,
 * with a label to report instead of the value itself.
 */
function forbiddenValues(
  sandbox: Sandbox,
): readonly { readonly label: string; readonly value: string }[] {
  return [
    { label: 'the outside directory', value: sandbox.outsideDir },
    { label: 'the outside file (the escaping link target)', value: sandbox.outsideFile },
    { label: 'the prefix-sibling directory', value: sandbox.siblingDir },
    { label: 'the prefix-sibling decoy (the sibling link target)', value: sandbox.siblingFile },
    ...sandbox.markers.map((marker, index) => ({
      label: `planted file content #${String(index)}`,
      value: marker,
    })),
    ...credentials,
  ];
}

/** The labels of every forbidden value found in any of `haystacks`. */
function leaksIn(sandbox: Sandbox, haystacks: readonly string[]): string[] {
  return forbiddenValues(sandbox)
    .filter(({ value }) => haystacks.some((haystack) => haystack.includes(value)))
    .map(({ label }) => label);
}

/* -------------------------------------------------------------------------------------------------
 * Sessions and connections
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates a stored session for a project copy: a stand-in dev server launched
 * through the service's real launcher supplies the dev-server URL, and the
 * service's own `SessionManager` stores the record — the `SessionRecord` whose
 * `projectRoot` every `source.open` for the session is judged against.
 */
async function openSession(target: Harness, project: FixtureProjectCopy): Promise<SessionRecord> {
  const launched = await target.launchDevServer(project.root);
  if (isErr(launched)) {
    throw new Error(
      `devServer.launch was refused (${launched.error.code}): ${launched.error.message}`,
    );
  }
  const created = await target.manager.create({
    projectRoot: project.root,
    question: 'Why does the trail report take so long to open?',
    devServerUrl: launched.value.devServerUrl,
  });
  if (isErr(created)) {
    throw new Error(
      `The session could not be created (${created.error.code}): ${created.error.message}`,
    );
  }
  return created.value;
}

/** Binds a DevTools connection's inspected tab to a session, through `session.bind`. */
async function bindTab(
  target: Harness,
  devtools: DevtoolsConnection,
  session: SessionRecord,
  tabId: number,
): Promise<void> {
  const url = session.devServerUrl;
  const bound = await target.bindTab(devtools.client, {
    tabId,
    url,
    origin: new URL(url).origin,
    sessionId: session.id,
  });
  if (isErr(bound)) {
    throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
  }
  expect(bound.value.payload.sessionId).toBe(session.id);
}

/** Starts tracking a connection's inbox, and its credential for the privacy sweep. */
function watch(
  client: HarnessWsClient,
  credential?: { readonly label: string; readonly value: string },
): void {
  watched.push(client);
  if (credential !== undefined) {
    credentials.push(credential);
  }
}

/** The harness, the sandbox, two stored sessions, two editors and two bound DevTools tabs. */
async function setUp(): Promise<SuiteState> {
  const started = await startHarness();
  harness = started;
  credentials.push({ label: 'the editor credential', value: started.editorToken });

  const projectA = started.requireProject();
  const projectB = await started.copyFixtureProject();
  const sandbox = await plantSandbox(projectA, projectB);

  const sessionA = await openSession(started, projectA);
  const sessionB = await openSession(started, projectB);

  const editorA = await started.editor(projectA.root);
  const editorB = await started.editor(projectB.root);
  const devtoolsA = await started.connectDevtools({ tabId: TAB_A });
  const devtoolsB = await started.connectDevtools({ tabId: TAB_B });
  await bindTab(started, devtoolsA, sessionA, TAB_A);
  await bindTab(started, devtoolsB, sessionB, TAB_B);

  watch(editorA);
  watch(editorB);
  watch(devtoolsA.client, {
    label: 'the DevTools credential of tab A',
    value: devtoolsA.credential.token,
  });
  watch(devtoolsB.client, {
    label: 'the DevTools credential of tab B',
    value: devtoolsB.credential.token,
  });

  return Object.freeze({
    harness: started,
    sandbox,
    projectA,
    projectB,
    sessionA,
    sessionB,
    editorA,
    editorB,
    devtoolsA,
    devtoolsB,
  });
}

/* -------------------------------------------------------------------------------------------------
 * Observing one request end to end
 * ---------------------------------------------------------------------------------------------- */

/** One `source.open` frame some watched connection received because of a request. */
interface Forwarded {
  readonly recipient: HarnessWsClient;
  readonly message: SourceOpenMessage;
}

/** Everything one request caused. */
interface Observation {
  /** The id of the frame sent — the `ref` any `error` reply carries. */
  readonly frameId: string;
  /** The `error` replies the sender received for the frame. */
  readonly errors: readonly ErrorPayload[];
  /**
   * The `source.result` answers the sender had received for the frame by the
   * time its frame was provably handled: the `no-editor` answer arrives within
   * that window, an editor's answer only after the editor has spoken.
   */
  readonly results: readonly SourceResultPayload[];
  /** Every `source.open` any watched connection received while the request was handled. */
  readonly forwarded: readonly Forwarded[];
  /** The log records the service wrote while the request was handled. */
  readonly records: readonly CapturedLogRecord[];
}

/** Whether a frame is a `source.open`. */
function isSourceOpen(message: ProtocolMessage): message is SourceOpenMessage {
  return isMessageOfType(message, SOURCE_OPEN);
}

/** The `source.result` payloads a connection received whose `ref` names `frameId`. */
function resultsFor(client: HarnessWsClient, frameId: string): SourceResultPayload[] {
  return client.received.flatMap((message) =>
    isMessageOfType(message, SOURCE_RESULT) && message.payload.ref === frameId
      ? [message.payload]
      : [],
  );
}

/** Every `source.result` any watched connection received since its mark. */
function resultsSince(
  marks: readonly { readonly client: HarnessWsClient; readonly mark: number }[],
): SourceResultPayload[] {
  return marks.flatMap(({ client, mark }) =>
    client.received
      .slice(mark)
      .flatMap((message) => (isMessageOfType(message, SOURCE_RESULT) ? [message.payload] : [])),
  );
}

/** Inbox positions of every live watched connection, taken before a request. */
function markInboxes(): readonly { readonly client: HarnessWsClient; readonly mark: number }[] {
  return watched
    .filter((client) => client.authenticated)
    .map((client) => ({ client, mark: client.received.length }));
}

/**
 * Flushes every marked connection, then collects the `source.open` frames each
 * received since its mark.
 *
 * A forwarded frame is written to its recipient's socket while the sender's
 * frame is being handled, i.e. before the sender's barrier is answered; the
 * recipient's own barrier, sent afterwards, is answered on the same socket
 * after it. So once both barriers are answered, anything forwarded is in the
 * recipient's transcript — and "nothing arrived" is a proof, not a timeout.
 */
async function collectForwarded(
  marks: readonly { readonly client: HarnessWsClient; readonly mark: number }[],
  alreadyFlushed?: HarnessWsClient,
): Promise<Forwarded[]> {
  for (const { client } of marks) {
    if (client !== alreadyFlushed && client.authenticated) {
      await client.flush();
    }
  }
  return marks.flatMap(({ client, mark }) =>
    client.received
      .slice(mark)
      .filter(isSourceOpen)
      .map((message) => ({ recipient: client, message })),
  );
}

/**
 * Sends one frame with `write`, waits until the service has provably handled
 * it, and reports what it caused.
 */
async function observe(sender: HarnessWsClient, write: () => string): Promise<Observation> {
  const { harness: target } = state();
  const marks = markInboxes();
  const logMark = target.logger.records.length;

  const frameId = write();
  const answered = await sender.flush();
  if (!answered) {
    throw new Error(
      `The sending connection closed before its frame was handled: ${sender.describe()}`,
    );
  }

  const forwarded = await collectForwarded(marks, sender);
  const errors = sender.errorsFor(frameId);
  const results = resultsFor(sender, frameId);
  errorReplies.push(...errors);
  resultReplies.push(...results);
  return { frameId, errors, results, forwarded, records: target.logger.records.slice(logMark) };
}

/**
 * Has `editor` answer the `source.open` it received with `answer`, under the
 * forwarded frame's own id as `ref`, and proves the service handled the answer
 * without refusing it.
 *
 * @returns The id of the answer frame.
 */
async function answerAsEditor(
  editor: HarnessWsClient,
  forwarded: SourceOpenMessage,
  answer: EditorAnswer,
): Promise<string> {
  const receipt = editor.send(SOURCE_RESULT, {
    ...answer,
    sessionId: forwarded.payload.sessionId,
    ref: forwarded.id,
  });
  if (isErr(receipt.result) || receipt.result.value !== 'sent') {
    throw new Error(`The ${SOURCE_RESULT} frame was not written: ${editor.describe()}`);
  }
  expect(await editor.flush(), 'the editor closed before its answer was handled').toBe(true);
  expect(editor.errorsFor(receipt.id), 'the service refused the editor answer').toEqual([]);
  return receipt.id;
}

/**
 * Waits for the one `source.result` the sender receives for its frame, and
 * proves it is a well-formed answer naming the sender's own frame and session.
 */
async function relayedResult(
  sender: HarnessWsClient,
  frameId: string,
  sessionId: string,
): Promise<SourceResultPayload> {
  const message = await waitFor(
    sender,
    SOURCE_RESULT,
    (candidate) => candidate.payload.ref === frameId,
    HARNESS_TIMEOUTS.message,
  );
  const payload = parseSourceResultPayload(message.payload);
  if (isErr(payload)) {
    throw new Error(`The relayed ${SOURCE_RESULT} does not validate: ${payload.error.message}`);
  }
  expect(payload.value.sessionId).toBe(sessionId);
  expect(message.sessionId).toBe(sessionId);
  expect(resultsFor(sender, frameId), 'a request is answered exactly once').toHaveLength(1);
  resultReplies.push(payload.value);
  return payload.value;
}

/** A writer sending `payload` through the protocol client's typed `send`. */
function typedFrame(sender: HarnessWsClient, payload: SourceOpenPayload): () => string {
  return () => {
    const receipt = sender.send(SOURCE_OPEN, payload);
    if (isErr(receipt.result) || receipt.result.value !== 'sent') {
      throw new Error(`The ${SOURCE_OPEN} frame was not written: ${sender.describe()}`);
    }
    return receipt.id;
  };
}

/**
 * A writer sending a hand-built frame on the live socket — for a payload the
 * typed `send` cannot express, such as one carrying a key the strict payload
 * schema does not declare.
 */
function rawFrame(
  sender: HarnessWsClient,
  sessionId: string,
  payload: Readonly<Record<string, unknown>>,
): () => string {
  return () => {
    const id = newMessageId();
    sender.sendRaw(JSON.stringify({ id, type: SOURCE_OPEN, sessionId, ts: Date.now(), payload }));
    return id;
  };
}

/** A connection, described for an assertion diff without dumping the client object. */
function describeRecipient(client: HarnessWsClient): string {
  const { identity } = client;
  return identity.tabId === undefined
    ? `${identity.client} ${identity.projectRoot ?? '(no project)'}`
    : `${identity.client} tab ${String(identity.tabId)}`;
}

/** Who received a forwarded frame, described. */
function recipientsOf(observation: Observation): string[] {
  return observation.forwarded.map(({ recipient }) => describeRecipient(recipient));
}

/**
 * Asserts the request was answered with exactly one `error` reply carrying
 * `code` and naming the frame, and that nothing was forwarded to anyone.
 */
function expectErrorReply(observation: Observation, code: DebuggenErrorCode): ErrorPayload {
  expect(observation.errors.map((reply) => reply.code)).toEqual([code]);
  expect(recipientsOf(observation), 'no connection may receive a refused location').toEqual([]);
  expect(observation.results, 'a refused request is answered by its error alone').toEqual([]);
  const [reply] = observation.errors;
  if (reply === undefined) {
    throw new Error('An error reply was asserted and is missing.');
  }
  expect(reply.ref).toBe(observation.frameId);
  return reply;
}

/**
 * Asserts the handler's refusal was answered with exactly one `failed`
 * `source.result` carrying `code` and naming the frame — never with an `error`
 * reply, which is session-less and so relayed by a Chrome service worker to
 * every panel it serves, while the refusal's sentence may quote the requested
 * file — and that nothing was forwarded to anyone.
 */
function expectRefusedResult(
  observation: Observation,
  code: DebuggenErrorCode,
): Extract<SourceResultPayload, { status: 'failed' }>['error'] {
  expect(
    observation.errors,
    'a handler refusal never travels as a session-less error frame',
  ).toEqual([]);
  expect(recipientsOf(observation), 'no connection may receive a refused location').toEqual([]);
  const [result, ...extra] = observation.results;
  expect(extra, 'a refused request is answered once').toEqual([]);
  if (result?.status !== 'failed') {
    throw new Error(
      `A failed source.result was asserted; got ${result === undefined ? 'none' : result.status}.`,
    );
  }
  expect(result.ref).toBe(observation.frameId);
  expect(result.error.code).toBe(code);
  return result.error;
}

/**
 * Asserts the request was forwarded exactly once, to `recipient` only, that the
 * sender received no `error` reply, and that nothing was claimed to the sender
 * yet: delivery to an editor is not an answer until the editor gives one.
 */
function expectForwardedOnlyTo(
  observation: Observation,
  recipient: HarnessWsClient,
): SourceOpenMessage {
  expect(observation.errors).toEqual([]);
  expect(observation.results, 'nothing is answered before the editor answers').toEqual([]);
  expect(recipientsOf(observation)).toEqual([describeRecipient(recipient)]);
  const [only] = observation.forwarded;
  if (only === undefined) {
    throw new Error('A forwarded frame was asserted and is missing.');
  }
  expect(
    only.recipient === recipient,
    'the frame reached another connection of the same kind',
  ).toBe(true);
  return only.message;
}

/**
 * The pin a forward of a file under `root` must carry: `file` as given, relative
 * to the canonical root, and the device and inode of a non-following `bigint`
 * `lstat` of it, in canonical decimal.
 */
async function pinOf(root: string, file: string): Promise<SourceOpenPin> {
  const stats = await lstat(join(await realpath(root), file), { bigint: true });
  return { file, dev: String(stats.dev), ino: String(stats.ino) };
}

/**
 * What an editor enforcing the pin concludes about a forwarded frame, by the
 * rule the pin states: resolve the location against the canonical project
 * root, and open only a regular file inside it whose relative path and `bigint`
 * identity equal the pin. A location that no longer resolves is a refusal.
 */
async function pinStillMatches(root: string, message: SourceOpenMessage): Promise<boolean> {
  const { location, pinned } = message.payload;
  if (pinned === undefined) {
    return false;
  }
  const canonicalRoot = toPosix(await realpath(root));
  let target: string;
  try {
    target = toPosix(await realpath(join(canonicalRoot, location.file)));
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error) {
      return false;
    }
    throw error;
  }
  if (!isWithin(canonicalRoot, target)) {
    return false;
  }
  const stats = await lstat(target, { bigint: true });
  return (
    stats.isFile() &&
    toPosix(relative(canonicalRoot, target)) === pinned.file &&
    String(stats.dev) === pinned.dev &&
    String(stats.ino) === pinned.ino
  );
}

/**
 * Asserts a forwarded frame is a valid `source.open` envelope of its own whose
 * payload is exactly what was sent — the location deep-equal, `confidence`
 * and `resolvedBy` untouched — plus the pin of `canonicalFile`, the file the
 * location resolves to under `root`.
 */
async function expectFaithfulForward(
  message: SourceOpenMessage,
  sessionId: string,
  location: SourceLocation,
  sentFrameId: string,
  pin: { readonly root: string; readonly canonicalFile: string },
): Promise<void> {
  const reparsed = parseMessage(JSON.parse(encodeMessage(message)));
  if (isErr(reparsed)) {
    throw new Error(`The forwarded frame does not re-parse: ${reparsed.error.message}`);
  }
  expect(isMessageOfType(reparsed.value, SOURCE_OPEN)).toBe(true);

  const payload = parseSourceOpenPayload(message.payload);
  if (isErr(payload)) {
    throw new Error(`The forwarded payload does not validate: ${payload.error.message}`);
  }
  expect(payload.value).toStrictEqual({
    sessionId,
    location,
    pinned: await pinOf(pin.root, pin.canonicalFile),
  });
  expect(message.sessionId).toBe(sessionId);
  expect(message.id, 'the service forwards a fresh envelope, not the sender frame').not.toBe(
    sentFrameId,
  );
  expect(await pinStillMatches(pin.root, message), 'an editor enforcing the pin opens it').toBe(
    true,
  );
}

/** The records `src/source/open.ts` wrote while a request was handled. */
function handlerRecords(observation: Observation): readonly CapturedLogRecord[] {
  return observation.records.filter((record) => record.fields['subsystem'] === SOURCE_SUBSYSTEM);
}

/** Asserts the handler ran and recorded exactly one refusal of `rejection`, for `reason`. */
function expectHandlerRefusal(
  observation: Observation,
  rejection: SourceOpenRejection,
  reason: string,
): void {
  const records = handlerRecords(observation);
  expect(records.map((record) => record.fields['rejection'])).toEqual([rejection]);
  expect(records.map((record) => record.fields['reason'])).toEqual([reason]);
}

/** Asserts the handler never ran: the frame was refused before `src/source/open.ts` saw it. */
function expectHandlerNotReached(observation: Observation): void {
  expect(
    handlerRecords(observation).map((record) => record.message),
    'the handler (and with it every filesystem call) must not run',
  ).toEqual([]);
}

/** Asserts no forbidden value appears in a reply or in the records of one request. */
function expectNoLeak(sandbox: Sandbox, observation: Observation): void {
  const haystacks = [
    ...observation.errors.map((reply) => JSON.stringify(reply)),
    ...observation.results.map((result) => JSON.stringify(result)),
    ...observation.records.map((record) => record.line),
  ];
  expect(leaksIn(sandbox, haystacks)).toEqual([]);
}

/* -------------------------------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------------------------- */

beforeAll(async () => {
  suite = await setUp();
});

afterAll(async () => {
  const running = harness;
  const containers =
    suite === undefined ? [] : [suite.projectA.container, suite.projectB.container];
  harness = undefined;
  suite = undefined;
  if (running === undefined) {
    return;
  }
  await running.assertNoLeaks();
  for (const container of containers) {
    await expect(access(container), 'a sandbox container outlived the suite').rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );
  }
});

/* -------------------------------------------------------------------------------------------------
 * The sandbox itself
 * ---------------------------------------------------------------------------------------------- */

describe('the sandbox', () => {
  it('holds a real prefix sibling and real links that lead out of the project', async () => {
    const { sandbox, projectA, projectB } = state();
    const { root } = sandbox;

    // A bare `startsWith(root)` would accept the sibling; the containment predicate must not.
    expect(sandbox.siblingFile.startsWith(root)).toBe(true);
    expect(isWithin(root, sandbox.siblingFile)).toBe(false);

    // Every escaping link is inside the project as text and outside it once resolved.
    for (const link of [
      ESCAPE_LINK,
      SIBLING_LINK,
      `${VENDOR_LINK}/${basename(sandbox.outsideFile)}`,
    ]) {
      const lexical = join(root, link);
      expect(isWithin(root, lexical)).toBe(true);
      expect(isWithin(root, await realpath(lexical))).toBe(false);
    }

    // The in-project link stays inside once resolved.
    expect(await realpath(join(root, ALIAS_LINK))).toBe(join(root, SERVICE_FILE));

    // Every planted entry lives inside a harness-owned mkdtemp container.
    const containers = [projectA.container, projectB.container];
    for (const path of [...sandbox.planted, sandbox.siblingDir, sandbox.outsideDir]) {
      expect(
        containers.some((container) => isWithin(container, path)),
        `${basename(path)} was planted outside the sandbox`,
      ).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------------------------------
 * The happy path
 * ---------------------------------------------------------------------------------------------- */

describe('forwarding a contained location to the editor', () => {
  const resolverRows = SOURCE_RESOLVED_BY.map((resolvedBy, variant) => ({ resolvedBy, variant }));

  it.each(resolverRows)(
    'forwards a $resolvedBy location exactly once, to the session editor only, unchanged',
    async ({ resolvedBy, variant }) => {
      const { devtoolsA, editorA, sessionA, sandbox } = state();
      const location = locationFor(SERVICE_FILE, variant);
      expect(location.resolvedBy).toBe(resolvedBy);
      expect(location.confidence).not.toBe(DEFAULT_RESOLUTION_CONFIDENCE[resolvedBy]);

      const observation = await observe(
        devtoolsA.client,
        typedFrame(devtoolsA.client, { sessionId: sessionA.id, location }),
      );

      const message = expectForwardedOnlyTo(observation, editorA);
      await expectFaithfulForward(message, sessionA.id, location, observation.frameId, {
        root: sandbox.root,
        canonicalFile: SERVICE_FILE,
      });
      // Forwarded, not re-resolved: the confidence travels exactly as it was sent.
      expect(message.payload.location.confidence).toBe(location.confidence);
      expect(handlerRecords(observation).map((record) => record.fields['delivered'])).toEqual([1]);
      expectNoLeak(sandbox, observation);

      // Only the editor's own answer is relayed, under the sender's ref, not the forward's.
      await answerAsEditor(editorA, message, { status: 'opened' });
      expect(await relayedResult(devtoolsA.client, observation.frameId, sessionA.id)).toEqual({
        sessionId: sessionA.id,
        ref: observation.frameId,
        status: 'opened',
      });
    },
  );

  it('accepts a file reached through a link that stays inside the project', async () => {
    const { devtoolsA, editorA, sessionA, sandbox } = state();
    const location = locationFor(ALIAS_LINK, 1);

    const observation = await observe(
      devtoolsA.client,
      typedFrame(devtoolsA.client, { sessionId: sessionA.id, location }),
    );

    const message = expectForwardedOnlyTo(observation, editorA);
    await expectFaithfulForward(message, sessionA.id, location, observation.frameId, {
      root: sandbox.root,
      canonicalFile: SERVICE_FILE,
    });
    // The location is forwarded as sent: the link's own name, never its canonical
    // target — which is what the pin names instead.
    expect(message.payload.location.file).toBe(ALIAS_LINK);
    expect(message.payload.pinned?.file).toBe(SERVICE_FILE);

    await answerAsEditor(editorA, message, { status: 'opened' });
    const relayed = await relayedResult(devtoolsA.client, observation.frameId, sessionA.id);
    expect(relayed.status).toBe('opened');
  });

  it('pins the proved file, so a link re-pointed out of the project while the frame is queued is refused', async () => {
    const { devtoolsA, editorA, sessionA, sandbox } = state();
    const location = locationFor(ALIAS_LINK, 5);
    const linkPath = join(sandbox.root, ALIAS_LINK);
    const proved = await pinOf(sandbox.root, SERVICE_FILE);

    const observation = await observe(
      devtoolsA.client,
      typedFrame(devtoolsA.client, { sessionId: sessionA.id, location }),
    );
    // The service checked the link while it stayed inside, and pinned its target.
    const message = expectForwardedOnlyTo(observation, editorA);
    await expectFaithfulForward(message, sessionA.id, location, observation.frameId, {
      root: sandbox.root,
      canonicalFile: SERVICE_FILE,
    });

    // The frame is delivered and waits for the editor to act; before it does, the
    // link is swapped to the outside file. The location still names the same link.
    try {
      await unlink(linkPath);
      await symlink(sandbox.outsideFile, linkPath);

      const canonicalRoot = toPosix(await realpath(sandbox.root));
      const nowResolved = toPosix(await realpath(linkPath));
      const now = await lstat(nowResolved, { bigint: true });
      expect(isWithin(canonicalRoot, nowResolved), 'the swapped link leads out').toBe(false);
      // What the editor now finds is not what the pin names ...
      expect({
        file: toPosix(relative(canonicalRoot, nowResolved)),
        dev: String(now.dev),
        ino: String(now.ino),
      }).not.toEqual(message.payload.pinned);
      expect(String(now.ino)).not.toBe(message.payload.pinned?.ino);
      // ... while the pin still names the file the service proved, so an editor
      // enforcing it refuses rather than opening the outside file.
      expect(message.payload.pinned).toEqual(proved);
      expect(await pinStillMatches(sandbox.root, message)).toBe(false);

      // That refusal is what the sender hears, under its own ref.
      await answerAsEditor(editorA, message, {
        status: 'failed',
        error: {
          code: CODE.FS_UNSAFE_PATH,
          message: 'The file changed after Debug Generator checked it, so VS Code did not open it.',
        },
      });
      const relayed = await relayedResult(devtoolsA.client, observation.frameId, sessionA.id);
      expect(relayed.status).toBe('failed');
    } finally {
      await unlink(linkPath);
      await symlink(basename(SERVICE_FILE), linkPath);
    }

    expect(await realpath(linkPath), 'the in-project link is restored').toBe(
      join(sandbox.root, SERVICE_FILE),
    );
    expectNoLeak(sandbox, observation);
    await expectTargetsUntouched(sandbox);
  });

  it('refuses a missing file distinctly from a containment refusal', async () => {
    const { devtoolsA, sessionA, sandbox } = state();

    const missing = await observe(
      devtoolsA.client,
      typedFrame(devtoolsA.client, {
        sessionId: sessionA.id,
        location: locationFor(MISSING_FILE, 2),
      }),
    );
    const missingReply = expectRefusedResult(missing, CODE.PROJECT_NOT_FOUND);
    expectHandlerRefusal(missing, REJECTION['file-missing'], 'not-found');
    // The answer — read only by the request that asked — may name the
    // project-relative file, never the absolute root.
    expect(missingReply.message).toContain(MISSING_FILE);
    expect(missingReply.message).not.toContain(sandbox.root);

    const directory = await observe(
      devtoolsA.client,
      typedFrame(devtoolsA.client, {
        sessionId: sessionA.id,
        location: locationFor(DIRECTORY_ENTRY, 3),
      }),
    );
    expectRefusedResult(directory, CODE.PROJECT_NOT_FOUND);
    expectHandlerRefusal(directory, REJECTION['file-missing'], 'not-a-file');

    const escaping = await observe(
      devtoolsA.client,
      typedFrame(devtoolsA.client, {
        sessionId: sessionA.id,
        location: locationFor(ESCAPE_LINK, 4),
      }),
    );
    const escapingReply = expectRefusedResult(escaping, CODE.FS_UNSAFE_PATH);
    expectHandlerRefusal(escaping, REJECTION['unsafe-path'], 'symlink-escapes-project-root');

    expect(missingReply.code).not.toBe(escapingReply.code);
    for (const observation of [missing, directory, escaping]) {
      expectNoLeak(sandbox, observation);
    }
    await expectTargetsUntouched(sandbox);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The editor's answer, relayed to the sender
 * ---------------------------------------------------------------------------------------------- */

describe('the editor answer, correlated to the sender request', () => {
  /** Forwards one contained location from tab A to editor A, and returns what was forwarded. */
  async function forwardFromTabA(variant: number): Promise<{
    readonly observation: Observation;
    readonly forwarded: SourceOpenMessage;
  }> {
    const { devtoolsA, editorA, sessionA } = state();
    const observation = await observe(
      devtoolsA.client,
      typedFrame(devtoolsA.client, {
        sessionId: sessionA.id,
        location: locationFor(SERVICE_FILE, variant),
      }),
    );
    return { observation, forwarded: expectForwardedOnlyTo(observation, editorA) };
  }

  it('relays an editor failure to the sender with its code, under the sender ref', async () => {
    const { devtoolsA, editorA, sessionA, sandbox } = state();
    const { observation, forwarded } = await forwardFromTabA(5);
    const failure: EditorAnswer = {
      status: 'failed',
      error: {
        code: CODE.PROJECT_NOT_FOUND,
        message: 'VS Code could not open the file at that location.',
        hint: 'Reopen the project folder in VS Code, then click the link again.',
      },
    };

    await answerAsEditor(editorA, forwarded, failure);

    expect(await relayedResult(devtoolsA.client, observation.frameId, sessionA.id)).toEqual({
      ...failure,
      sessionId: sessionA.id,
      ref: observation.frameId,
    });
    // A relayed failure is an answer, not a refusal of the sender's frame.
    expect(devtoolsA.client.errorsFor(observation.frameId)).toEqual([]);
    expectNoLeak(sandbox, observation);
  });

  it('lets no editor of another project settle it, and relays the rightful answer', async () => {
    const { devtoolsA, editorA, editorB, sessionA } = state();
    const { observation, forwarded } = await forwardFromTabA(6);
    const marks = markInboxes();

    // Editor B's workspace does not cover session A's project: its answer is refused.
    const intruding = editorB.send(SOURCE_RESULT, {
      sessionId: sessionA.id,
      ref: forwarded.id,
      status: 'opened',
    });
    expect(await editorB.flush()).toBe(true);
    expect(editorB.errorsFor(intruding.id).map((reply) => reply.code)).toEqual([CODE.UNAUTHORIZED]);
    errorReplies.push(...editorB.errorsFor(intruding.id));
    expect(await devtoolsA.client.flush()).toBe(true);
    expect(resultsFor(devtoolsA.client, observation.frameId)).toEqual([]);

    // The editor the location was forwarded to still settles it.
    await answerAsEditor(editorA, forwarded, { status: 'opened' });
    expect((await relayedResult(devtoolsA.client, observation.frameId, sessionA.id)).status).toBe(
      'opened',
    );
    expect(resultsSince(marks).map((result) => result.ref)).toEqual([observation.frameId]);
  });

  it('refuses a source.result sent by a DevTools connection', async () => {
    const { devtoolsA, editorA, sessionA } = state();
    const { observation, forwarded } = await forwardFromTabA(7);

    const spoofed = devtoolsA.client.send(SOURCE_RESULT, {
      sessionId: sessionA.id,
      ref: forwarded.id,
      status: 'opened',
    });
    expect(await devtoolsA.client.flush()).toBe(true);
    expect(devtoolsA.client.errorsFor(spoofed.id).map((reply) => reply.code)).toEqual([
      CODE.UNAUTHORIZED,
    ]);
    errorReplies.push(...devtoolsA.client.errorsFor(spoofed.id));
    // The panel cannot answer its own request: nothing was settled by it.
    expect(resultsFor(devtoolsA.client, observation.frameId)).toEqual([]);

    await answerAsEditor(editorA, forwarded, { status: 'opened' });
    expect((await relayedResult(devtoolsA.client, observation.frameId, sessionA.id)).status).toBe(
      'opened',
    );
  });

  it('accepts an answer to a frame it never forwarded, and relays it to nobody', async () => {
    const { editorA, sessionA } = state();
    const marks = markInboxes();

    const stray = editorA.send(SOURCE_RESULT, {
      sessionId: sessionA.id,
      ref: newMessageId(),
      status: 'opened',
    });
    expect(await editorA.flush()).toBe(true);

    // A late or unknown answer is normal: no error for the editor, no result for anyone.
    expect(editorA.errorsFor(stray.id)).toEqual([]);
    await collectForwarded(marks, editorA);
    expect(resultsSince(marks)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Containment
 * ---------------------------------------------------------------------------------------------- */

/** Which layer is expected to refuse a hostile path. */
type RefusingLayer = 'payload validation' | 'the realpath layer';

/** One row of the containment table. */
interface ContainmentRow {
  readonly name: string;
  /** The hostile `file`, computed from the real layout. */
  readonly file: (sandbox: Sandbox) => string;
  /** Who refuses it: the shared schema on decode, or the handler once links are resolved. */
  readonly refusedBy: RefusingLayer;
  /** For a realpath-layer refusal, the reason the handler records. */
  readonly reason?: string;
}

/** The containment rows: each one a path a correct gate refuses and a plausible one might not. */
const CONTAINMENT_ROWS: readonly ContainmentRow[] = [
  {
    name: 'a leading .. traversal',
    file: () => '../outside.ts',
    refusedBy: 'payload validation',
  },
  {
    name: 'an escape that re-enters a directory beside the project',
    file: () => 'src/../../other/file.ts',
    refusedBy: 'payload validation',
  },
  {
    name: 'a backslash traversal',
    file: () => 'src\\..\\..\\outside.ts',
    refusedBy: 'payload validation',
  },
  {
    name: 'a POSIX absolute path to a real file outside the project',
    file: (sandbox) => sandbox.outsideFile,
    refusedBy: 'payload validation',
  },
  {
    name: 'a POSIX absolute path even when it points inside the project',
    file: (sandbox) => join(sandbox.root, SERVICE_FILE),
    refusedBy: 'payload validation',
  },
  {
    name: 'a Windows drive path',
    file: () => 'C:\\Users\\developer\\secret.ts',
    refusedBy: 'payload validation',
  },
  {
    name: 'a Windows drive path written with forward slashes',
    file: () => 'C:/Users/developer/secret.ts',
    refusedBy: 'payload validation',
  },
  {
    name: 'a UNC path',
    file: () => '\\\\fileserver\\share\\secret.ts',
    refusedBy: 'payload validation',
  },
  {
    name: 'a UNC path written with forward slashes',
    file: () => '//fileserver/share/secret.ts',
    refusedBy: 'payload validation',
  },
  {
    name: 'a path truncated by a NUL character',
    file: () => `${SERVICE_FILE}\u0000.md`,
    refusedBy: 'payload validation',
  },
  {
    name: 'a path carrying a terminal escape sequence',
    file: () => 'src/\u001b[2Jreport.ts',
    refusedBy: 'payload validation',
  },
  {
    name: 'a path carrying a C1 control character',
    file: () => 'src/report\u009b.ts',
    refusedBy: 'payload validation',
  },
  {
    name: 'the prefix sibling, named lexically',
    file: (sandbox) => `../${basename(sandbox.siblingDir)}/${basename(sandbox.siblingFile)}`,
    refusedBy: 'payload validation',
  },
  {
    name: 'the prefix sibling, reached through a link inside the project',
    file: () => SIBLING_LINK,
    refusedBy: 'the realpath layer',
    reason: 'symlink-escapes-project-root',
  },
  {
    name: 'a link inside the project whose target escapes it',
    file: () => ESCAPE_LINK,
    refusedBy: 'the realpath layer',
    reason: 'symlink-escapes-project-root',
  },
  {
    name: 'an interior directory link that leads out of the project',
    file: (sandbox) => `${VENDOR_LINK}/${basename(sandbox.outsideFile)}`,
    refusedBy: 'the realpath layer',
    reason: 'symlink-escapes-project-root',
  },
  {
    name: 'a link cycle inside the project',
    file: () => LOOP_LINK_A,
    refusedBy: 'the realpath layer',
    reason: 'not-resolvable',
  },
];

describe('containment against the stored project root', () => {
  it.each(CONTAINMENT_ROWS.map((row, variant) => ({ ...row, variant })))(
    'refuses $name (refused by $refusedBy)',
    async (row) => {
      const { devtoolsA, sessionA, sandbox } = state();
      const hostile = row.file(sandbox);
      const location = withFile(hostile, row.variant);

      if (row.refusedBy === 'payload validation') {
        // Only the path is wrong: the shared schema refuses it on its own.
        expect(parseSourceLocation(location).ok).toBe(false);
      } else {
        // Well-formed and inside the project as text: only resolving links can tell.
        expect(parseSourceLocation(location).ok).toBe(true);
        expect(isWithin(sandbox.root, join(sandbox.root, hostile))).toBe(true);
      }

      const observation = await observe(
        devtoolsA.client,
        typedFrame(devtoolsA.client, { sessionId: sessionA.id, location }),
      );

      if (row.refusedBy === 'payload validation') {
        expectErrorReply(observation, CODE.PROTOCOL_INVALID_MESSAGE);
        expectHandlerNotReached(observation);
      } else {
        expectRefusedResult(observation, CODE.FS_UNSAFE_PATH);
        expectHandlerRefusal(observation, REJECTION['unsafe-path'], row.reason ?? '');
      }
      expectNoLeak(sandbox, observation);
      await expectTargetsUntouched(sandbox);
    },
  );

  /** Out-of-range positions, each sent on a path the filesystem layer would refuse differently. */
  const positionRows = [
    { name: 'line 0', line: 0, column: 1 },
    { name: 'a negative line', line: -7, column: 1 },
    { name: 'a fractional line', line: SERVICE_LINE + 0.5, column: 1 },
    { name: 'column 0', line: SERVICE_LINE, column: 0 },
    { name: 'a negative column', line: SERVICE_LINE, column: -2 },
    { name: 'a fractional column', line: SERVICE_LINE, column: 1.25 },
  ].flatMap((position) => [ESCAPE_LINK, MISSING_FILE].map((file) => ({ ...position, file })));

  it.each(positionRows)(
    'refuses $name by payload validation before any filesystem work ($file)',
    async ({ line, column, file }) => {
      const { devtoolsA, sessionA, sandbox } = state();
      // An odd variant carries no endLine, so only the position is out of range.
      const location: SourceLocation = { ...locationFor(file, 1), line, column };
      expect(location.endLine).toBeUndefined();
      expect(parseSourceLocation(location).ok).toBe(false);

      const observation = await observe(
        devtoolsA.client,
        typedFrame(devtoolsA.client, { sessionId: sessionA.id, location }),
      );

      // Had the filesystem been consulted, the link would be FS_UNSAFE_PATH and the
      // missing file PROJECT_NOT_FOUND; payload validation answers first.
      expectErrorReply(observation, CODE.PROTOCOL_INVALID_MESSAGE);
      expectHandlerNotReached(observation);
      expectNoLeak(sandbox, observation);
    },
  );
});

/* -------------------------------------------------------------------------------------------------
 * Authorization and the stored project root
 * ---------------------------------------------------------------------------------------------- */

describe('authorization and the stored project root', () => {
  it('judges every path against the root stored on the named session', async () => {
    const {
      harness: target,
      projectA,
      projectB,
      sessionA,
      sessionB,
      devtoolsA,
      editorB,
      sandbox,
    } = state();

    const stored = target.repos.sessions.get(sessionA.id);
    if (isErr(stored)) {
      throw new Error(`The stored session could not be read (${stored.error.code}).`);
    }
    expect(stored.value?.projectRoot).toBe(projectA.root);

    // The file exists in the second project only.
    await expect(access(join(projectB.root, OTHER_PROJECT_FILE))).resolves.toBeUndefined();
    await expect(access(join(projectA.root, OTHER_PROJECT_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const location = locationFor(OTHER_PROJECT_FILE, 2);

    // Named for the first session, it is judged against the first session's root.
    const againstA = await observe(
      devtoolsA.client,
      typedFrame(devtoolsA.client, { sessionId: sessionA.id, location }),
    );
    expectRefusedResult(againstA, CODE.PROJECT_NOT_FOUND);
    expectHandlerRefusal(againstA, REJECTION['file-missing'], 'not-found');

    // Named for the second session, the very same location resolves in its root and
    // reaches that session's editor alone.
    const againstB = await observe(
      editorB,
      typedFrame(editorB, { sessionId: sessionB.id, location }),
    );
    const message = expectForwardedOnlyTo(againstB, editorB);
    await expectFaithfulForward(message, sessionB.id, location, againstB.frameId, {
      root: projectB.root,
      canonicalFile: OTHER_PROJECT_FILE,
    });
    // An editor that asked is answered like a panel: by its own frame's ref.
    await answerAsEditor(editorB, message, { status: 'opened' });
    expect((await relayedResult(editorB, againstB.frameId, sessionB.id)).status).toBe('opened');

    expectNoLeak(sandbox, againstA);
    expectNoLeak(sandbox, againstB);
    await expectTargetsUntouched(sandbox);
  });

  it('refuses a payload that tries to carry a project root of its own', async () => {
    const { projectB, sessionA, devtoolsA, sandbox } = state();

    const smuggled = await observe(
      devtoolsA.client,
      rawFrame(devtoolsA.client, sessionA.id, {
        sessionId: sessionA.id,
        location: locationFor(OTHER_PROJECT_FILE, 3),
        projectRoot: projectB.root,
      }),
    );

    const reply = expectErrorReply(smuggled, CODE.PROTOCOL_INVALID_MESSAGE);
    expectHandlerNotReached(smuggled);
    // The unknown key may be named; its value — another project's root — never is.
    expect(reply.message).not.toContain(projectB.root);
    expectNoLeak(sandbox, smuggled);
  });

  it('refuses a frame that carries a pin of its own, before anything is forwarded', async () => {
    const { devtoolsA, editorA, sessionA, sandbox } = state();
    // Distinctive, well-formed identities: a reply or record quoting one is an echo.
    const devMarker = '918273645546372819';
    const inoMarker = '5647382910019283746';
    const pins: readonly SourceOpenPin[] = [
      // A page nominating the file it wants trusted ...
      { file: 'src/nominated.service.ts', dev: devMarker, ino: inoMarker },
      // ... and even a pin that truthfully describes the requested file: only the
      // service's own proof becomes a pin.
      await pinOf(sandbox.root, SERVICE_FILE),
    ];

    for (const [index, pinned] of pins.entries()) {
      for (const sender of [devtoolsA.client, editorA]) {
        // A location the service would otherwise forward to the editor.
        const location = locationFor(SERVICE_FILE, index);
        const refused = await observe(
          sender,
          typedFrame(sender, { sessionId: sessionA.id, location, pinned }),
        );

        const error = expectRefusedResult(refused, CODE.PROTOCOL_INVALID_MESSAGE);
        expectHandlerRefusal(refused, REJECTION['invalid-payload'], 'pin-not-permitted');
        const surfaces = [
          JSON.stringify(error),
          ...refused.records.map((record) => record.line),
        ].join('\n');
        for (const value of [devMarker, inoMarker, 'src/nominated.service.ts']) {
          expect(surfaces, 'the refusal quotes nothing of the supplied pin').not.toContain(value);
        }
        expectNoLeak(sandbox, refused);
      }
    }
    await expectTargetsUntouched(sandbox);
  });

  it('refuses an editor whose announced workspace does not cover the stored root', async () => {
    const { sessionA, editorB, sandbox } = state();

    const crossed = await observe(
      editorB,
      typedFrame(editorB, { sessionId: sessionA.id, location: locationFor(SERVICE_FILE, 4) }),
    );

    // The editor may not receive a frame about a session its workspace does not
    // cover, so the handler's refusal cannot be a `source.result`: it falls back
    // to an `error` reply whose sentence quotes nothing from the request.
    const reply = expectErrorReply(crossed, CODE.UNAUTHORIZED);
    expect(reply.message).not.toContain(SERVICE_FILE);
    expectHandlerRefusal(crossed, REJECTION['not-authorized'], 'project-out-of-scope');
    expectNoLeak(sandbox, crossed);
  });

  it('refuses a DevTools connection acting on a session bound to another tab', async () => {
    const { sessionA, devtoolsB, sandbox } = state();

    // Tab B is bound to the second session; the first session is bound to tab A.
    const foreign = await observe(
      devtoolsB.client,
      typedFrame(devtoolsB.client, { sessionId: sessionA.id, location: locationFor(SERVICE_FILE) }),
    );

    expectErrorReply(foreign, CODE.TAB_NOT_BOUND);
    expectNoLeak(sandbox, foreign);
  });

  it('refuses a dev-server agent', async () => {
    const { harness: target, projectA, sessionA, sandbox } = state();
    const issued = target.issueServerAgentCredential(projectA.root);
    const serverAgent = await target.ws({
      client: 'server-agent',
      projectRoot: projectA.root,
      token: issued.token,
    });
    expect(serverAgent.authenticated).toBe(true);
    watch(serverAgent, { label: 'the server-agent credential', value: issued.token });

    const refused = await observe(
      serverAgent,
      typedFrame(serverAgent, { sessionId: sessionA.id, location: locationFor(SERVICE_FILE, 1) }),
    );

    expectErrorReply(refused, CODE.UNAUTHORIZED);
    expectHandlerNotReached(refused);
    expectNoLeak(sandbox, refused);
  });

  it('gives the page agent no principal on the socket to send from', async () => {
    const { harness: target, sessionA, devtoolsA } = state();
    const marks = markInboxes();

    // The page agent holds no credential: a hello claiming to be it, even one
    // presenting a valid DevTools credential, is closed before any frame is handled.
    const agent = await target.ws({
      client: 'agent',
      tabId: TAB_A,
      token: devtoolsA.credential.token,
      origin: devtoolsA.credential.origin,
      awaitAuthentication: false,
    });
    agent.send(SOURCE_OPEN, { sessionId: sessionA.id, location: locationFor(SERVICE_FILE, 2) });
    const closed = await agent.waitForClose();
    await agent.close();

    expect(isUnauthorizedClose(closed)).toBe(true);
    expect(agent.authenticated).toBe(false);
    const forwarded = await collectForwarded(marks);
    expect(forwarded.map(({ recipient }) => describeRecipient(recipient))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * No editor connected
 * ---------------------------------------------------------------------------------------------- */

describe(`with no editor connected (the ${NO_EDITOR_CLIENT} outcome)`, () => {
  it('answers the sender with non-delivery and keeps its connection open', async () => {
    const { editorA, devtoolsA, sessionA, sandbox } = state();
    await editorA.close();
    expect(editorA.authenticated).toBe(false);
    const closesBefore = devtoolsA.client.closes.length;

    const location = locationFor(SERVICE_FILE, 3);
    const observation = await observe(
      devtoolsA.client,
      typedFrame(devtoolsA.client, { sessionId: sessionA.id, location }),
    );

    // The sender learns that nobody received the location — its cue for the
    // vscode:// URI fallback — as a source.result answer naming its own frame,
    // before its frame is provably handled, and never as an error.
    expect(observation.errors).toEqual([]);
    expect(observation.results).toEqual([
      { sessionId: sessionA.id, ref: observation.frameId, status: 'no-editor' },
    ]);
    expect(recipientsOf(observation), 'nobody was there to receive it').toEqual([]);

    // The handler itself succeeded: every check passed and the forward reached
    // no editor (`delivered: false`), with no rejection recorded.
    const records = handlerRecords(observation);
    expect(records.map((record) => record.fields['delivered'])).toEqual([0]);
    expect(records.map((record) => record.fields['rejection'])).toEqual([undefined]);
    expect(records.map((record) => record.fields['file'])).toEqual([location.file]);

    // A success with non-delivery does not break the sender's connection.
    expect(devtoolsA.client.closes).toHaveLength(closesBefore);
    expect(devtoolsA.client.authenticated).toBe(true);
    expect(await devtoolsA.client.flush()).toBe(true);
    expectNoLeak(sandbox, observation);
  });

  it('queues nothing for an editor that connects later, and delivers the next click to it', async () => {
    const { harness: target, projectA, devtoolsA, sessionA } = state();

    const lateEditor = await target.editor(projectA.root);
    watch(lateEditor);
    expect(await lateEditor.flush()).toBe(true);
    // The undelivered request is not replayed: it was answered, not deferred.
    expect(lateEditor.received.filter(isSourceOpen)).toEqual([]);

    const location = locationFor(SERVICE_FILE, 4);
    const observation = await observe(
      devtoolsA.client,
      typedFrame(devtoolsA.client, { sessionId: sessionA.id, location }),
    );
    const message = expectForwardedOnlyTo(observation, lateEditor);
    await expectFaithfulForward(message, sessionA.id, location, observation.frameId, {
      root: projectA.root,
      canonicalFile: SERVICE_FILE,
    });
    await answerAsEditor(lateEditor, message, { status: 'opened' });
    expect((await relayedResult(devtoolsA.client, observation.frameId, sessionA.id)).status).toBe(
      'opened',
    );
  });
});

/* -------------------------------------------------------------------------------------------------
 * A request its answer could not name
 * ---------------------------------------------------------------------------------------------- */

describe('a source.open whose frame id no source.result can reference', () => {
  it('is refused before anything is forwarded, so no location opens unanswered', async () => {
    const { harness: target, projectA, devtoolsA, sessionA } = state();
    // The live editor of the project (connected by the previous block), so a
    // forward would have somewhere to go.
    const editor = await target.editor(projectA.root);
    watch(editor);
    const marks = markInboxes();
    const receivedBefore = devtoolsA.client.received.length;
    const editorReceivedBefore = editor.received.length;

    // A valid envelope id (the envelope allows up to 128 characters) that is
    // longer than the 64 characters a `source.result` `ref` may carry.
    const longId = `msg_${'x'.repeat(96)}`;
    const location = locationFor(SERVICE_FILE, 5);
    devtoolsA.client.sendRaw(
      JSON.stringify({
        id: longId,
        type: SOURCE_OPEN,
        sessionId: sessionA.id,
        ts: Date.now(),
        payload: { sessionId: sessionA.id, location },
      }),
    );
    expect(await devtoolsA.client.flush()).toBe(true);

    const answers = devtoolsA.client.received.slice(receivedBefore);
    const refusals = answers.filter((message) => isMessageOfType(message, 'error'));
    expect(refusals.map((message) => message.payload)).toEqual([
      expect.objectContaining({ code: 'PROTOCOL_INVALID_MESSAGE' }),
    ]);
    expect(
      answers.filter((message) => isMessageOfType(message, 'source.result')),
      'nothing claims an outcome for a request that was never forwarded',
    ).toEqual([]);
    const forwarded = await collectForwarded(marks, devtoolsA.client);
    expect(forwarded.map(({ recipient }) => describeRecipient(recipient))).toEqual([]);
    expect(editor.received.slice(editorReceivedBefore).filter(isSourceOpen)).toEqual([]);
    expect(devtoolsA.client.authenticated).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Privacy, and the developer's tree
 * ---------------------------------------------------------------------------------------------- */

describe('privacy and the developer tree', () => {
  it('never echoes an outside path, a link target, file content or a credential', () => {
    const { harness: target, sandbox } = state();
    expect(errorReplies.length).toBeGreaterThan(CONTAINMENT_ROWS.length);
    expect(resultReplies.length).toBeGreaterThan(SOURCE_RESOLVED_BY.length);

    const haystacks = [
      ...errorReplies.map((reply) => JSON.stringify(reply)),
      ...resultReplies.map((result) => JSON.stringify(result)),
      ...target.logger.records.map((record) => record.line),
    ];
    expect(leaksIn(sandbox, haystacks)).toEqual([]);
  });

  it('writes nothing: the project copies and the committed corpus stay byte-identical', async () => {
    const { harness: target, sandbox, projectA, projectB, sessionA, sessionB } = state();

    // Every would-be target is intact; then the planted entries go. `unlink` removes a
    // link itself and never follows it.
    await expectTargetsUntouched(sandbox);
    for (const path of sandbox.planted) {
      await unlink(path);
    }

    await target.editor(projectA.root);
    await target.editor(projectB.root);
    for (const session of [sessionA, sessionB]) {
      const ended = await target.endSession(session.id);
      if (isErr(ended)) {
        throw new Error(`session.end was refused (${ended.error.code}): ${ended.error.message}`);
      }
      expect(ended.value.cleanup).toBe('clean');
    }

    await assertTreeUnchanged(projectA.root, projectA.snapshot);
    await assertTreeUnchanged(projectB.root, projectB.snapshot);
    await assertTreeUnchanged(fixturePath(DEFAULT_FIXTURE_PROJECT), projectA.snapshot);
  });
});
