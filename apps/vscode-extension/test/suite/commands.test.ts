/**
 * The extension-host gate on command registration (AAP 0.7.1 Group 3, 0.8.3,
 * 0.8.5): it makes it impossible to contribute a command without registering
 * it, or to register one that is not contributed.
 *
 * WHY A HOST SUITE. `src/commands/index.ts` types its handler table as
 * `Record<CommandId, CommandHandler>` over the {@link COMMAND_IDS} tuple, so an
 * id missing from the table is a compile error. The compiler cannot see
 * `package.json` or the editor's command registry, though, and the manifest
 * declares no `onCommand:` activation events (AAP 0.2.4): a contributed id that
 * `activate()` never registers appears in the Command Palette and fails when
 * invoked. This suite is the runtime half of the guarantee, run inside a real
 * VS Code by `pnpm test:vscode`:
 *
 *   1. three sets must be identical — {@link COMMAND_IDS}, the
 *      `contributes.commands[].command` values of the loaded manifest, and the
 *      `debuggen.*` ids in `vscode.commands.getCommands(true)` after the
 *      extension has been activated through the helper. A drift names every
 *      offending id and the set(s) it is missing from; exact sizes are asserted
 *      as well, so a duplicate manifest entry cannot hide behind set semantics;
 *   2. `EXTENSION_ID` of `test/helpers.ts` is the manifest's
 *      `<publisher>.<name>`;
 *   3. the commands that require an argument are exactly the ones hidden from
 *      the Command Palette (`menus.commandPalette` entries with
 *      `when: "false"`), in both directions.
 *
 * WHAT THE REGISTRATION BLOCK NEVER DOES. It executes none of the extension's
 * registered commands: registration presence and manifest shape are what it
 * proves, and running `debuggen.rotateServiceToken` or `debuggen.purgeSessions`
 * would destroy state. It opens no network connection, spawns no process and
 * writes no file; the run's throwaway `DEBUGGEN_HOME`, the deterministic
 * provider and the generic fixture workspace come from `.vscode-test.mjs`.
 *
 * THE SESSION LIFECYCLE BLOCK. A second `describe` proves the editor's
 * session handoff — the invariant that the editor tracks at most one live
 * session and never replaces it in the store before the service has answered
 * `session.end` for it, which is what makes `deactivate()`'s single-session end
 * sufficient (AAP 0.5.1). It calls the exported `startSession`,
 * `reopenSession` and `endSession` functions directly — never through
 * `vscode.commands` — with a `CommandContext` built from doubles: the real
 * `ExtensionState`; a scripted service client whose every call is recorded in
 * order and which answers from the test's own script (so no socket or HTTP
 * request exists); a UI double that records notices, failures, confirmations
 * and the command ids it was asked to run without running any of them; guards
 * that answer a fixture project; and a recording logger. Every double outside
 * what the commands are expected to touch is a strict proxy that fails the
 * test on first use.
 *
 * THE REAL-SERVICE BLOCK. A third `describe`, "session lifecycle against a
 * real service", proves the same handoffs where the doubles cannot: against
 * the embedded service bundle (`dist/service/main.js`, deterministic
 * provider, spawned on a `findFreePort()` loopback port with its own throwaway
 * `DEBUGGEN_HOME`) whose real installer patches a scratch copy of
 * `apps/local-service/test/fixtures/sample-project`, and whose real cleanup
 * restores it. Every file of that copy is snapshotted (bytes and SHA-256)
 * before anything runs; a stand-in dev server, launched by the service's own
 * launcher, lets sessions be created. The commands run with a `CommandContext`
 * around the real `createServiceClient`:
 *
 *   - the editor credential is read from the service's `auth.json` by
 *     `createEditorCredentialStore`;
 *   - the socket announces the scratch project, and — wired as `activate()`
 *     wires it — the socket to the service owning the session in view is
 *     kept across a URL switch (`retainedEndpoint`) and released on the store
 *     change that moves the session elsewhere (`pruneRetainedConnections`);
 *   - the service-URL configuration can be switched the way a
 *     `debuggen.serviceUrl` change does;
 *   - HTTP goes over a direct `node:http` transport, because the extension
 *     host's platform `fetch` fails in VS Code 1.139 (see
 *     `loopbackHttpFetch`);
 *   - the client is wrapped only to log, in order, every `session.create`,
 *     `session.end`, `session.get` and `modifications.list`, with the endpoint
 *     it was addressed to and its answer, while the transport logs every
 *     request as it left.
 *
 * The rest of the context is real too: the `ExtensionState`, fed the pushed
 * frames exactly as `subscribeInbound` in `src/extension.ts` feeds it, and
 * the `SessionViewProvider`, resolved into a substitute webview whose command
 * runner sends `debuggen.startSession` to `startSession`. At every request,
 * every answer and every change of the active session the log also records
 * which project files differ from the snapshot at that instant, so "restored
 * before the next session existed" is observed, not inferred. The cases:
 *
 *   1. reopen handoff (INT-F26, API-F32): S1 patched through `startSession`;
 *      a second live session S2, created beside it, patching another file;
 *      `reopenSession(S2)` accepted. S1's end is answered `clean`, and S1's
 *      files equal the snapshot, before S2 becomes active.
 *      `endSessionsForShutdown` (deactivation's session work) then ends S2
 *      alone, the wire carries that one request, and the tree equals the
 *      snapshot.
 *   2. webview Retry (FE-F24): S1 patched. The service reports failed
 *      `instrument` steps, and the store is given what a failed stage pushes
 *      (`instrumentation.failed`, a `failed` record; see
 *      `failAtInstrument`). The view's `retryStage` restarts through
 *      `debuggen.startSession`, whose `session.create` is sent only after S1's
 *      end answered `clean`, with every file byte-identical to the snapshot.
 *   3. webview Retry with a conflict (FE-F24): a developer edit to S1's
 *      patched file makes the end answer `conflict`. Nothing is created, S1
 *      stays in view ended, and the notice names the file and its backup
 *      (AAP 0.5.5). The file keeps the developer's bytes, the backup the
 *      original.
 *   4. the owning endpoint with two real services (API-F30, INT-F19): S1
 *      patched at service A, then `debuggen.serviceUrl` switched to service B,
 *      which holds A's editor credential but not S1. A start at B, and in a
 *      fresh run the shutdown routine, must end S1 at A with its files
 *      restored, before anything is created at B; B must never receive a
 *      request about S1.
 *   5. deactivation in VS Code's order (API-F30, INT-F19): S1 patched at A;
 *      `endSessionsForShutdown` runs and, in the same synchronous turn, the
 *      store, the credential store and the client are disposed, as the
 *      extension host disposes `context.subscriptions` right after
 *      `deactivate()` returns its promise. The socket must stay open until
 *      the end settled, S1 must be ended `clean` at A by one request, and
 *      every file must equal the snapshot.
 *
 * Every child process is spawned through `spawnTracked`, every directory
 * through `createScratchDir`. After each case, `afterEach` stops the dev
 * servers the case launched (at each service that launched one, through a
 * teardown client of its own when the case disposed the editor side), releases
 * the editor side and stops the services. It then checks that no stand-in dev
 * server outlived them, runs `cleanupScratch()`, and fails when anything
 * survived.
 *
 * MOCHA GLOBALS. The `@vscode/test-cli` runner supplies Mocha's `bdd`
 * interface as globals and this workspace declares no `@types/mocha` (see the
 * `compilerOptions.types` notes in `tsconfig.json`), so the globals this suite
 * calls are declared below in module scope, as the sibling suites do.
 *
 * @module apps/vscode-extension/test/suite/commands
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  MODIFICATIONS_PAGE_DEFAULT_LIMIT,
  buildPath,
  healthPath,
  parseInstrumentationFailedPayload,
  parseSessionRecord,
} from '@debuggen/protocol';
import type {
  ConnectionState,
  DevServerLaunchResponse,
  FetchLike,
  HttpCallOptions,
  HttpFetchInit,
  HttpResponseLike,
  ListPageRequest,
  MessageType,
  ModificationConflict,
  ModificationRecord,
  ModificationsResponse,
  SessionCreateRequest,
  SessionEndResponse,
  SessionProgressPayload,
  SessionRecord,
} from '@debuggen/protocol';
import { DebuggenError, err, isErr, ok, toPosix, unwrap } from '@debuggen/shared';
import type { DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';

import {
  DEFAULT_SHUTDOWN_TIMEOUTS,
  MAX_CONFLICT_SENTENCES,
  SESSION_CREATE_TIMEOUT_MS,
  endSession,
  endSessionsForShutdown,
} from '../../src/commands/end-session';
import type {
  ShutdownReport,
  ShutdownState,
  ShutdownTimeouts,
} from '../../src/commands/end-session';
import { COMMAND_IDS } from '../../src/commands/index';
import type {
  CommandContext,
  CommandDiscovery,
  CommandGuards,
  CommandId,
  CommandNotice,
  CommandUi,
  DestructiveConfirmation,
  FailureNoticeOptions,
} from '../../src/commands/index';
import { reopenSession } from '../../src/commands/reopen-session';
import { showModifications } from '../../src/commands/show-modifications';
import { startSession } from '../../src/commands/start-session';
import { createEditorCredentialStore } from '../../src/service/auth';
import {
  CONNECTION_HOLD_TIMEOUT_MS,
  ENDPOINT_SOCKET_OPEN_TIMEOUT_MS,
  createServiceClient,
} from '../../src/service/client';
import type {
  ServiceClient,
  ServiceClientConfiguration,
  SessionEndpointCallOptions,
} from '../../src/service/client';
import type { ProjectRootInfo } from '../../src/service/discovery';
import { ExtensionState } from '../../src/state';
import { SessionViewProvider } from '../../src/views/session-view-provider';
import type { SessionsTreeProvider } from '../../src/views/sessions-tree';
import type { HostToWebviewMessage } from '../../src/webview-messages';
import {
  EXTENSION_ID,
  SESSIONS_VIEW_ID,
  SESSION_VIEW_ID,
  activateExtensionOnce,
  cleanupScratch,
  closeAllEditors,
  createScratchDir,
  extensionDevelopmentRoot,
  findFreePort,
  hermeticEnv,
  listTrackedProcesses,
  readExtensionManifest,
  repositoryRoot,
  resolveNodeExecutable,
  spawnTracked,
  stopTrackedProcesses,
  waitFor,
  waitForHttpOk,
} from '../helpers';
import type { ExtensionManifest, ManifestMenuItem, ProcessExit, TrackedProcess } from '../helpers';

// ---------------------------------------------------------------------------
// Mocha's bdd globals, as provided by the @vscode/test-cli runner
// ---------------------------------------------------------------------------

/** The part of Mocha's test and hook context (`this`) this suite uses. */
interface MochaRunnableContext {
  timeout(ms: number): unknown;
}

/** A test or hook body: synchronous, or a promise mocha awaits. */
type MochaRunnable = (this: MochaRunnableContext) => void | Promise<void>;

declare function describe(title: string, body: () => void): void;
declare function it(title: string, body: MochaRunnable): void;
declare function after(body: MochaRunnable): void;
declare function beforeEach(body: MochaRunnable): void;
declare function afterEach(body: MochaRunnable): void;

// ---------------------------------------------------------------------------
// The contract under test, stated once
// ---------------------------------------------------------------------------

/**
 * The number of commands AAP 0.7.1 Group 3 contributes. Stated as a number,
 * not derived from any of the three sets, so that growing or shrinking all of
 * them together is still a visible, reviewed change to this file.
 */
const EXPECTED_COMMAND_COUNT = 12;

/** The namespace of every command id this extension contributes or registers. */
const COMMAND_NAMESPACE = 'debuggen.';

/**
 * The commands that cannot run without an argument, and therefore must be
 * hidden from the Command Palette, which invokes a command with none:
 *
 * - `debuggen.openSource` — `src/commands/open-source.ts` opens the location
 *   it is given: a bare `SourceLocation` or a `{ location }` envelope, parsed
 *   as untrusted input. There is nothing to open without one.
 * - `debuggen.reopenSession` — `src/commands/reopen-session.ts` reopens the
 *   session whose id it receives; that id comes from the Sessions tree, whose
 *   session rows carry `command: { command: 'debuggen.reopenSession',
 *   arguments: [id] }` (`src/views/sessions-tree.ts`), and from the row's
 *   inline action.
 *
 * Adding a third argument-taking command must be a conscious update here, and
 * of `menus.commandPalette` in `package.json`; `satisfies` keeps every entry a
 * real {@link CommandId} at compile time.
 */
const ARGUMENT_TAKING_COMMANDS = [
  'debuggen.openSource',
  'debuggen.reopenSession',
] as const satisfies readonly CommandId[];

/** The exact `when` clause the manifest authors to hide a command from the palette. */
const HIDDEN_FROM_PALETTE_WHEN = 'false';

/**
 * The suffixes of the commands VS Code itself registers for every contributed
 * view `<viewId>` — the workbench's view actions `<viewId>.focus`, `.open`,
 * `.removeView`, `.resetViewLocation` and `.toggleVisibility`, exactly the
 * `debuggen.session.*` and `debuggen.sessions.*` ids a run of this suite
 * observes in the registry. They are generated from the two contributed view
 * ids in `contributes.views`, not from `contributes.commands`, so leaving them
 * in the registry set would fail the comparison for the wrong reason.
 *
 * The filter is deliberately this narrow — an exact `<contributed view id>.<one
 * of these suffixes>` match, never a bare `debuggen.session.` /
 * `debuggen.sessions.` prefix — so that a genuine command the extension
 * registers inside a view's namespace (say `debuggen.sessions.refresh`) is
 * never swallowed: it stays in the comparison and fails it until contributed.
 * Should a future editor generate a new suffix, the comparison names that id
 * as "only in registry"; add the suffix here once it is confirmed to come from
 * the workbench.
 */
const VIEW_GENERATED_COMMAND_SUFFIXES: readonly string[] = Object.freeze([
  'focus',
  'open',
  'removeView',
  'resetViewLocation',
  'toggleVisibility',
]);

/**
 * The generated command every contributed view must have. `src/commands/`
 * reveals the session view through `debuggen.session.focus`, so its presence
 * is also what proves the filter above matches ids that really exist.
 */
const VIEW_FOCUS_SUFFIX = 'focus';

/**
 * Budget of a test that activates the extension. Activation constructs the
 * service client, views and commands; the fixture settings point the client at
 * an unbindable port with auto-start off, so nothing is waited for beyond the
 * extension host itself. Generous because the host's CPU is shared.
 */
const ACTIVATION_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Set comparison with named drift
// ---------------------------------------------------------------------------

/** Ids in ascending order, for stable messages. */
function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/** Every id that occurs more than once in `ids`, each named once. */
function duplicatesOf(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      repeated.add(id);
    }
    seen.add(id);
  }
  return sorted(repeated);
}

/**
 * The drift between labelled sets, one line per id that is not in all of
 * them: `only in <label>: <id>` when a single set holds it, otherwise
 * `missing from <labels>: <id>`. An empty result means the sets are identical.
 */
function describeDrift(sets: Readonly<Record<string, ReadonlySet<string>>>): string[] {
  const labels = Object.keys(sets);
  const union = new Set<string>();
  for (const set of Object.values(sets)) {
    for (const id of set) {
      union.add(id);
    }
  }
  const lines: string[] = [];
  for (const id of sorted(union)) {
    const holding = labels.filter((label) => sets[label]?.has(id) === true);
    if (holding.length === labels.length) {
      continue;
    }
    const lacking = labels.filter((label) => !holding.includes(label));
    lines.push(
      holding.length === 1
        ? `only in ${holding.join('')}: ${id}`
        : `missing from ${lacking.join(', ')}: ${id}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Reading the manifest and the registry
// ---------------------------------------------------------------------------

/** The `contributes.commands[].command` ids, in authored order (duplicates kept). */
function contributedCommandIds(manifest: ExtensionManifest): string[] {
  return manifest.contributes.commands.map((entry) => entry.command);
}

/** Every contributed view id, across all view containers, in authored order. */
function contributedViewIds(manifest: ExtensionManifest): string[] {
  return Object.values(manifest.contributes.views).flatMap((views) => views.map((view) => view.id));
}

/** The `menus.commandPalette` entries exactly as authored (`[]` when absent). */
function commandPaletteEntries(manifest: ExtensionManifest): readonly ManifestMenuItem[] {
  return manifest.contributes.menus?.['commandPalette'] ?? [];
}

/**
 * Whether a `when` clause can never hold: `false` or `!true`, ignoring
 * whitespace and redundant outer parentheses. Anything else — a real context
 * key condition — merely restricts when the command is offered.
 */
function isFalsifyingWhen(when: string | undefined): boolean {
  if (when === undefined) {
    return false;
  }
  let clause = when.replace(/\s+/g, '');
  while (clause.startsWith('(') && clause.endsWith(')')) {
    clause = clause.slice(1, -1);
  }
  return clause === 'false' || clause === '!true';
}

/** Whether `id` is a command the workbench generates for one of `viewIds`. */
function isViewGeneratedCommand(id: string, viewIds: readonly string[]): boolean {
  return viewIds.some((viewId) =>
    VIEW_GENERATED_COMMAND_SUFFIXES.some((suffix) => id === `${viewId}.${suffix}`),
  );
}

/**
 * The registry, read after the extension is active: every non-internal
 * command id (`getCommands(true)` drops `_`-prefixed ones) in the extension's
 * namespace, split into the ids VS Code generated for the contributed views
 * and everything else.
 */
async function readRegistry(viewIds: readonly string[]): Promise<{
  readonly registered: ReadonlySet<string>;
  readonly viewGenerated: ReadonlySet<string>;
}> {
  const all = await vscode.commands.getCommands(true);
  const namespaced = all.filter((id) => id.startsWith(COMMAND_NAMESPACE));
  return {
    registered: new Set(namespaced.filter((id) => !isViewGeneratedCommand(id, viewIds))),
    viewGenerated: new Set(namespaced.filter((id) => isViewGeneratedCommand(id, viewIds))),
  };
}

/** Activates the extension through the shared, memoised helper and proves it is active. */
async function activate(): Promise<void> {
  const extension = await activateExtensionOnce();
  assert.equal(extension.id, EXTENSION_ID, 'activateExtensionOnce() returned another extension');
  assert.equal(extension.isActive, true, `${EXTENSION_ID} is not active after activation`);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('command registration (commands.test)', () => {
  after(async () => {
    // Every step runs even when an earlier one fails, and nothing is swallowed.
    const failures: unknown[] = [];
    for (const step of [closeAllEditors, cleanupScratch, stopTrackedProcesses]) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, `commands.test teardown: ${failures.length} steps failed`);
    }
  });

  it('EXTENSION_ID of the test helpers is the manifest\'s "<publisher>.<name>"', () => {
    const manifest = readExtensionManifest();
    assert.equal(
      `${manifest.publisher}.${manifest.name}`,
      EXTENSION_ID,
      'test/helpers.ts EXTENSION_ID has drifted from "publisher" and "name" in package.json',
    );
  });

  it(`COMMAND_IDS lists ${EXPECTED_COMMAND_COUNT} distinct ids in the "${COMMAND_NAMESPACE}" namespace`, () => {
    const ids: readonly string[] = COMMAND_IDS;
    assert.deepEqual(duplicatesOf(ids), [], 'COMMAND_IDS in src/commands/index.ts repeats an id');
    assert.equal(
      ids.length,
      EXPECTED_COMMAND_COUNT,
      `COMMAND_IDS holds ${ids.length} ids, not ${EXPECTED_COMMAND_COUNT}: ${ids.join(', ')}`,
    );
    assert.deepEqual(
      ids.filter((id) => !id.startsWith(COMMAND_NAMESPACE)),
      [],
      `every COMMAND_IDS entry must start with "${COMMAND_NAMESPACE}"`,
    );
  });

  it(`contributes.commands lists ${EXPECTED_COMMAND_COUNT} distinct ids in the "${COMMAND_NAMESPACE}" namespace`, () => {
    const ids = contributedCommandIds(readExtensionManifest());
    assert.deepEqual(
      duplicatesOf(ids),
      [],
      'contributes.commands in package.json contributes an id more than once',
    );
    assert.equal(
      ids.length,
      EXPECTED_COMMAND_COUNT,
      `contributes.commands holds ${ids.length} entries, not ${EXPECTED_COMMAND_COUNT}: ${ids.join(', ')}`,
    );
    assert.deepEqual(
      ids.filter((id) => !id.startsWith(COMMAND_NAMESPACE)),
      [],
      `every contributed command id must start with "${COMMAND_NAMESPACE}"`,
    );
  });

  it('COMMAND_IDS follows contributes.commands order', () => {
    // The order src/commands/index.ts documents and registers in.
    assert.deepEqual(
      [...COMMAND_IDS],
      contributedCommandIds(readExtensionManifest()),
      'COMMAND_IDS must list the contributed ids in package.json contributes.commands order',
    );
  });

  it('the contributed views are exactly the two whose generated commands the registry filter excludes', () => {
    const viewIds = contributedViewIds(readExtensionManifest());
    assert.deepEqual(
      sorted(viewIds),
      sorted([SESSION_VIEW_ID, SESSIONS_VIEW_ID]),
      'contributes.views has drifted from SESSION_VIEW_ID / SESSIONS_VIEW_ID in test/helpers.ts',
    );
  });

  it('COMMAND_IDS, contributes.commands and the registered debuggen.* commands are the same set', async function () {
    this.timeout(ACTIVATION_TIMEOUT_MS);
    const manifest = readExtensionManifest();
    const contributed = contributedCommandIds(manifest);
    const declared: readonly string[] = COMMAND_IDS;

    await activate();
    const { registered } = await readRegistry(contributedViewIds(manifest));

    const drift = describeDrift({
      COMMAND_IDS: new Set(declared),
      manifest: new Set(contributed),
      registry: registered,
    });
    assert.deepEqual(
      drift,
      [],
      `command sets differ — ${drift.join('; ')}. Contribute (package.json contributes.commands), ` +
        'declare (COMMAND_IDS) and register (registerCommands in src/commands/index.ts) every command together.',
    );

    // Set equality alone would let a repeated entry pass; the sizes cannot.
    assert.equal(new Set(declared).size, declared.length, 'COMMAND_IDS repeats an id');
    assert.equal(
      new Set(contributed).size,
      contributed.length,
      'contributes.commands repeats an id',
    );
    assert.equal(
      registered.size,
      EXPECTED_COMMAND_COUNT,
      `${registered.size} debuggen.* commands are registered, not ${EXPECTED_COMMAND_COUNT}: ${sorted(registered).join(', ')}`,
    );
    assert.equal(contributed.length, EXPECTED_COMMAND_COUNT);
    assert.equal(declared.length, EXPECTED_COMMAND_COUNT);
  });

  it('VS Code registered a focus command for every contributed view, and no declared id collides with a generated one', async function () {
    this.timeout(ACTIVATION_TIMEOUT_MS);
    const viewIds = contributedViewIds(readExtensionManifest());

    await activate();
    const { viewGenerated } = await readRegistry(viewIds);

    assert.deepEqual(
      viewIds.filter((viewId) => !viewGenerated.has(`${viewId}.${VIEW_FOCUS_SUFFIX}`)),
      [],
      `every contributed view must have its generated "<viewId>.${VIEW_FOCUS_SUFFIX}" command ` +
        `(generated ids seen: ${sorted(viewGenerated).join(', ') || 'none'})`,
    );
    const declared = new Set<string>(COMMAND_IDS);
    assert.deepEqual(
      sorted(viewGenerated).filter((id) => declared.has(id)),
      [],
      'a declared command id collides with an id VS Code generates for a view',
    );
  });

  it('exactly the argument-taking commands are hidden from the Command Palette', () => {
    const manifest = readExtensionManifest();
    const contributed = new Set(contributedCommandIds(manifest));
    const entries = commandPaletteEntries(manifest);

    // Every palette entry names a contributed command; an entry for anything
    // else is dead configuration that hides nothing.
    assert.deepEqual(
      entries.filter((entry) => entry.command === undefined || !contributed.has(entry.command)),
      [],
      'menus.commandPalette names a command that contributes.commands does not contribute',
    );

    // Both directions at once: an argument-taking command left visible is
    // "only in ARGUMENT_TAKING_COMMANDS"; an argument-free command hidden by a
    // clause that can never hold is "only in hidden".
    const hidden = new Set(
      entries
        .filter((entry) => isFalsifyingWhen(entry.when))
        .flatMap((entry) => (entry.command === undefined ? [] : [entry.command])),
    );
    const drift = describeDrift({
      ARGUMENT_TAKING_COMMANDS: new Set<string>(ARGUMENT_TAKING_COMMANDS),
      hidden,
    });
    assert.deepEqual(
      drift,
      [],
      `menus.commandPalette hides the wrong commands — ${drift.join('; ')}. Commands that require ` +
        `an argument need { "when": "${HIDDEN_FROM_PALETTE_WHEN}" }; commands that take none must stay in the palette.`,
    );

    // Each argument-taking command: contributed, and hidden by exactly one
    // entry whose clause is authored as "false".
    for (const id of ARGUMENT_TAKING_COMMANDS) {
      assert.equal(contributed.has(id), true, `${id} is not in contributes.commands`);
      const own = entries.filter((entry) => entry.command === id);
      assert.deepEqual(
        own.map((entry) => entry.when),
        [HIDDEN_FROM_PALETTE_WHEN],
        `${id} must have exactly one menus.commandPalette entry, with when "${HIDDEN_FROM_PALETTE_WHEN}"`,
      );
    }
    assert.equal(hidden.size, ARGUMENT_TAKING_COMMANDS.length);
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle: doubles
// ---------------------------------------------------------------------------

/** The fixture project every double answers with; never a real path on disk. */
const LIFECYCLE_PROJECT_ROOT = '/workspace/lifecycle-fixture';

/** The question every start sends. Only its absence from the log is asserted. */
const LIFECYCLE_QUESTION = 'Why does the list render twice after a filter change?';

/** A fixed epoch for the fixture records. */
const T0 = 1_700_000_000_000;

/**
 * The service `debuggen.serviceUrl` names when a case starts: the scripted
 * client reports it as its `baseUrl`, so every session a command creates or
 * reopens is owned by it.
 */
const ENDPOINT_A = 'http://127.0.0.1:9';

/** A second service, for the cases where `debuggen.serviceUrl` is switched mid-session. */
const ENDPOINT_B = 'http://127.0.0.1:10';

/** What the UI double answers when a notice offers actions. */
const OPEN_DIFF = 'Open diff';

/** The generated view-focus command the commands reveal the session view with. */
const SESSION_VIEW_FOCUS = `${SESSION_VIEW_ID}.focus`;

/** A complete, schema-shaped session record with the given id. */
function sessionRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    projectRoot: LIFECYCLE_PROJECT_ROOT,
    projectName: 'lifecycle-fixture',
    devServerUrl: 'http://127.0.0.1:3100',
    createdAt: T0,
    updatedAt: T0,
    status: 'ready',
    question: LIFECYCLE_QUESTION,
    followUps: [],
    relevantFiles: [],
    plans: [],
    modifications: [],
    captures: [],
    panelIds: [],
    analyses: [],
    cleanup: { status: 'pending', conflicts: [] },
    promptVersions: {},
    provider: { id: 'deterministic' },
    ...overrides,
  };
}

/** One applied patch of `sessionId`, so a record models an instrumented session. */
function appliedPatch(sessionId: string): ModificationRecord {
  return {
    id: `${sessionId}-mod-1`,
    sessionId,
    planVersion: 1,
    file: 'src/lib/timing.ts',
    originalHash: 'a'.repeat(64),
    backupPath: `/tmp/debuggen-home/backups/${sessionId}/${'a'.repeat(64)}`,
    instrumentedHash: 'b'.repeat(64),
    appliedAt: T0,
    status: 'applied',
    diff: '',
  };
}

/**
 * The conflict cleanup reports for the `index`-th patched file of `sessionId`:
 * edited while instrumented unless another reason is named.
 */
function conflictOf(
  sessionId: string,
  index: number,
  reason: ModificationConflict['reason'] = 'content-changed',
): ModificationConflict {
  const file = `src/lib/file-${String(index)}.ts`;
  const backupPath = `/tmp/debuggen-home/backups/${sessionId}/${String(index).repeat(64).slice(0, 64)}`;
  return {
    recordId: `${sessionId}-mod-${String(index)}`,
    sessionId,
    file,
    reason,
    expectedHash: 'b'.repeat(64),
    actualHash: 'c'.repeat(64),
    backupPath,
    detectedAt: T0 + 50,
    message: `${file} could not be restored (${reason}); the original is still at ${backupPath}.`,
  };
}

/** The AAP §0.5.5 sentence for a file edited while instrumented. */
function editedSentence(conflict: ModificationConflict): string {
  return `${conflict.file} was edited while instrumented. Debug Generator will not overwrite it. Original saved at ${conflict.backupPath}.`;
}

/** One `session.progress` row of `sessionId`. */
function progressRow(sessionId: string, message: string): SessionProgressPayload {
  return { sessionId, stage: 'understand', status: 'running', message };
}

/** A settled promise's callbacks, for a service answer the test releases itself. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let release: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (release === undefined) {
        throw new Error('deferred: the promise executor did not run');
      }
      release(value);
    },
  };
}

/** Lets every queued microtask and the current macrotask turn run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * A strict double: the members given, and a thrown error naming the member for
 * anything else a command reaches for — so a command that starts using another
 * collaborator fails here loudly instead of silently touching the real one.
 */
function strictDouble<T extends object>(label: string, members: Partial<T>): T {
  return new Proxy(members, {
    get(target, property, receiver): unknown {
      if (typeof property === 'string' && property !== 'then' && !Reflect.has(target, property)) {
        throw new Error(`${label}.${property} was used, but this suite does not script it`);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as T;
}

/**
 * The dev-server probe `debuggen.startSession` runs before it creates a
 * session, answered as "no dev-server URL is configured": the lifecycle suites
 * pin ending, creating and adopting sessions, so no URL is forwarded and every
 * create body stays `{ projectRoot, question }`.
 */
function noDevServerProbe(): Promise<Result<never, DebuggenError>> {
  return Promise.resolve(
    err(new DebuggenError('CONFIG_INVALID', 'No dev-server URL is configured in this suite.')),
  );
}

/** One recorded log call. */
interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A logger that records every call and emits nothing. */
function recordingLogger(entries: LogEntry[]): Logger {
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields });
    };
  const logger: Logger = {
    level: 'trace',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  };
  return logger;
}

/**
 * How the scripted client answers; a handler left unset fails the test when
 * called. `endpoint` is the service a call was addressed to: the call's
 * `options.endpoint`, or `baseUrl` when it named none — exactly where the real
 * client would send it.
 */
interface ClientScript {
  socket: ConnectionState;
  /** The client's current base URL (`debuggen.serviceUrl`); `undefined` models a refused setting. */
  baseUrl: string | undefined;
  create?: (request: SessionCreateRequest) => Promise<Result<SessionRecord, DebuggenError>>;
  end?: (
    sessionId: string,
    endpoint: string | undefined,
  ) => Promise<Result<SessionEndResponse, DebuggenError>>;
  get?: (
    sessionId: string,
    endpoint: string | undefined,
  ) => Promise<Result<SessionRecord, DebuggenError>>;
  /** Answers `modifications.list` with one page; build it with {@link journalPage}. */
  modifications?: (
    sessionId: string,
    endpoint: string | undefined,
    window: ListPageRequest | undefined,
  ) => Promise<Result<ModificationsResponse, DebuggenError>>;
}

/**
 * The `modifications.list` page the service answers for a journal of
 * `records` asked with its default window: every record, `total` their count,
 * and the end of the journal reached.
 */
function journalPage(records: readonly ModificationRecord[]): ModificationsResponse {
  return {
    modifications: [...records],
    total: records.length,
    limit: MODIFICATIONS_PAGE_DEFAULT_LIMIT,
    offset: 0,
    nextOffset: null,
  };
}

/** One session-scoped client call and the service it was addressed to. */
interface AddressedCall {
  readonly call: string;
  readonly endpoint: string | undefined;
}

/** What the UI double answers. */
interface UiAnswers {
  /** The answer of every `confirmDestructive`. */
  confirm: boolean;
  /** The action every notice that offers actions resolves with. */
  choice: string | undefined;
}

/** Everything one lifecycle case drives and inspects. */
interface LifecycleHarness {
  readonly state: ExtensionState;
  readonly ctx: CommandContext;
  readonly script: ClientScript;
  readonly answers: UiAnswers;
  /** Every client call, in order: `create`, `end:<id>`, `get:<id>`, `modifications:<id>`. */
  readonly calls: string[];
  /** Every session-scoped call with the service it was addressed to, in order. */
  readonly addressed: AddressedCall[];
  /** Every operation registered with `client.keepConnectionsFor`, in order. */
  readonly held: Promise<unknown>[];
  readonly createRequests: SessionCreateRequest[];
  /** The `timeoutMs` of every `createSession`, in order. */
  readonly createTimeouts: (number | undefined)[];
  readonly notices: CommandNotice[];
  readonly failures: {
    readonly error: DebuggenError;
    readonly options: FailureNoticeOptions | undefined;
  }[];
  readonly confirmations: DestructiveConfirmation[];
  /** Command ids the UI double was asked to run; none is executed. */
  readonly executed: string[];
  readonly logs: LogEntry[];
}

/** Rejects a client call the case did not script. */
function unscripted(operation: string): Promise<never> {
  return Promise.reject(
    new Error(`client.${operation} was called, but this case does not script it`),
  );
}

/** Builds the context the three commands run against, around a fresh store. */
function createLifecycleHarness(): LifecycleHarness {
  const state = new ExtensionState({
    serviceUrl: ENDPOINT_A,
    provider: 'deterministic',
  });
  const script: ClientScript = { socket: 'open', baseUrl: ENDPOINT_A };
  const answers: UiAnswers = { confirm: false, choice: undefined };
  const calls: string[] = [];
  const addressed: AddressedCall[] = [];
  const held: Promise<unknown>[] = [];
  const createRequests: SessionCreateRequest[] = [];
  const createTimeouts: (number | undefined)[] = [];
  const notices: CommandNotice[] = [];
  const failures: LifecycleHarness['failures'] = [];
  const confirmations: DestructiveConfirmation[] = [];
  const executed: string[] = [];
  const logs: LogEntry[] = [];

  /** Records a session-scoped call and resolves where it is addressed. */
  const address = (
    call: string,
    options: SessionEndpointCallOptions | undefined,
  ): string | undefined => {
    const endpoint = options?.endpoint ?? script.baseUrl;
    calls.push(call);
    addressed.push({ call, endpoint });
    return endpoint;
  };

  const client = strictDouble<ServiceClient>('client', {
    get state(): ConnectionState {
      return script.socket;
    },
    get baseUrl(): string | undefined {
      return script.baseUrl;
    },
    get configurationError(): DebuggenError | undefined {
      return script.baseUrl === undefined
        ? new DebuggenError('CONFIG_INVALID', 'debuggen.serviceUrl is not a loopback origin.')
        : undefined;
    },
    createSession: (request: SessionCreateRequest, options?: HttpCallOptions) => {
      calls.push('create');
      createRequests.push(structuredClone(request));
      createTimeouts.push(options?.timeoutMs);
      return script.create === undefined ? unscripted('createSession') : script.create(request);
    },
    endSession: (sessionId: string, options?: SessionEndpointCallOptions) => {
      const endpoint = address(`end:${sessionId}`, options);
      return script.end === undefined ? unscripted('endSession') : script.end(sessionId, endpoint);
    },
    getSession: (sessionId: string, options?: SessionEndpointCallOptions) => {
      const endpoint = address(`get:${sessionId}`, options);
      return script.get === undefined ? unscripted('getSession') : script.get(sessionId, endpoint);
    },
    getModifications: (
      sessionId: string,
      window?: ListPageRequest,
      options?: SessionEndpointCallOptions,
    ) => {
      const endpoint = address(`modifications:${sessionId}`, options);
      return script.modifications === undefined
        ? unscripted('getModifications')
        : script.modifications(sessionId, endpoint, window);
    },
    // No socket exists here: the hold is recorded, and the promise is handed
    // back unchanged, as the real client's contract states.
    keepConnectionsFor: <T>(operation: Promise<T>): Promise<T> => {
      held.push(operation);
      return operation;
    },
  });

  const ui: CommandUi = {
    notify: (notice) => {
      notices.push(notice);
      return Promise.resolve(
        notice.actions !== undefined && notice.actions.length > 0 ? answers.choice : undefined,
      );
    },
    notifyFailure: (error, options) => {
      failures.push({ error, options });
      return Promise.resolve(
        options?.actions !== undefined && options.actions.length > 0 ? answers.choice : undefined,
      );
    },
    confirmDestructive: (options) => {
      confirmations.push(options);
      return Promise.resolve(answers.confirm);
    },
    pick: () => Promise.reject(new Error('ui.pick was called, but this suite does not script it')),
    executeCommand: <T>(command: string): Promise<T> => {
      executed.push(command);
      return Promise.resolve(undefined as T);
    },
  };

  const project: ProjectRootInfo = {
    projectRoot: LIFECYCLE_PROJECT_ROOT,
    name: 'lifecycle-fixture',
    folderUri: vscode.Uri.file(LIFECYCLE_PROJECT_ROOT),
    folderIndex: 0,
  };
  const guards: CommandGuards = {
    requireActiveSession: () => {
      const sessionId = state.activeSessionId;
      if (sessionId === undefined) {
        notices.push({ level: 'warning', message: 'No active session.' });
        return undefined;
      }
      return { sessionId, session: state.activeSession };
    },
    requireWorkspaceProject: () => project,
  };

  const ctx: CommandContext = {
    state,
    client,
    serviceProcess: strictDouble('serviceProcess', {}),
    credentials: strictDouble('credentials', {}),
    sessionView: strictDouble<SessionViewProvider>('sessionView', {
      postFocus: () => undefined,
    }),
    sessionsTree: strictDouble<SessionsTreeProvider>('sessionsTree', {
      refresh: () => Promise.resolve(),
    }),
    logger: recordingLogger(logs),
    ui,
    guards,
    discovery: strictDouble<CommandDiscovery>('discovery', { probeDevServer: noDevServerProbe }),
    openSource: strictDouble('openSource', {}),
  };

  return {
    state,
    ctx,
    script,
    answers,
    calls,
    addressed,
    held,
    createRequests,
    createTimeouts,
    notices,
    failures,
    confirmations,
    executed,
    logs,
  };
}

/** Asserts the question never reached a log record (AAP 0.5.2). */
function assertQuestionNeverLogged(harness: LifecycleHarness): void {
  assert.equal(
    JSON.stringify(harness.logs).includes(LIFECYCLE_QUESTION),
    false,
    'the session question must never be logged',
  );
}

// ---------------------------------------------------------------------------
// Session lifecycle: cases
// ---------------------------------------------------------------------------

describe('session lifecycle (commands.test)', () => {
  let harness: LifecycleHarness;

  beforeEach(() => {
    harness = createLifecycleHarness();
  });

  afterEach(() => {
    harness.state.dispose();
  });

  it('start with a live session ends it before creating, and adopts the new session from the HTTP answer alone', async () => {
    const { state, script } = harness;
    state.adoptSession(sessionRecord('S1', { modifications: [appliedPatch('S1')] }), ENDPOINT_A);
    script.socket = 'closed';
    script.end = () => Promise.resolve(ok({ cleanup: 'clean' }));
    script.create = () =>
      Promise.resolve(ok(sessionRecord('S2', { status: 'created', updatedAt: T0 + 10 })));

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['end:S1', 'create'], 'S1 must be ended before S2 is created');
    assert.equal(state.activeSessionId, 'S2', 'the HTTP answer alone must make S2 active');
    assert.equal(state.activeSession?.status, 'created');
    assert.deepEqual(state.modifications, [], 'nothing of S1 may linger once S2 is adopted');
    assert.equal(state.sessionCreationPending, false, 'the creation window must be closed');
    assert.deepEqual(harness.failures, []);
    assert.deepEqual(
      harness.notices.map((notice) => notice.level),
      ['info'],
      'only the "live updates unavailable" notice is expected with the socket closed',
    );
    assert.equal(harness.createRequests[0]?.projectRoot, LIFECYCLE_PROJECT_ROOT);
    assert.equal('target' in (harness.createRequests[0] ?? {}), false);
    assert.deepEqual(harness.executed, [SESSION_VIEW_FOCUS]);
    assertQuestionNeverLogged(harness);
  });

  it('a refused end creates nothing and leaves the live session active behind one failure notice', async () => {
    const { state, script } = harness;
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT_A);
    script.end = () =>
      Promise.resolve(
        err(
          new DebuggenError('TRANSPORT_DISCONNECTED', 'The local service did not answer.', {
            hint: 'Run "Debug Generator: Start Local Service".',
          }),
        ),
      );

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['end:S1'], 'no session may be created while S1 is not ended');
    assert.equal(state.activeSessionId, 'S1');
    assert.equal(state.activeSession?.status, 'capturing');
    assert.equal(harness.failures.length, 1);
    assert.equal(harness.failures[0]?.error.code, 'TRANSPORT_DISCONNECTED');
    assert.match(harness.failures[0]?.options?.prefix ?? '', /new session was not started/);
    assert.match(
      harness.failures[0]?.options?.prefix ?? '',
      /instrumentation may still be installed/,
    );
    assert.deepEqual(harness.notices, []);
    assert.equal(state.sessionCreationPending, false);
  });

  it('a conflicted cleanup stops the start with an "Open diff" warning; asking again proceeds without a second end', async () => {
    const { state, script, answers } = harness;
    state.adoptSession(sessionRecord('S1', { modifications: [appliedPatch('S1')] }), ENDPOINT_A);
    answers.choice = OPEN_DIFF;
    script.end = () => Promise.resolve(ok({ cleanup: 'conflict' }));
    // The details cannot be loaded, so the notice keeps the status-only wording.
    const unavailable = () =>
      Promise.resolve(
        err(new DebuggenError('TRANSPORT_DISCONNECTED', 'The local service did not answer.')),
      );
    script.get = unavailable;
    script.modifications = unavailable;

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['end:S1', 'get:S1', 'modifications:S1']);
    assert.ok(harness.addressed.every((entry) => entry.endpoint === ENDPOINT_A));
    assert.equal(state.activeSessionId, 'S1', 'the ended session stays in view with its verdict');
    assert.equal(state.activeSession?.status, 'ended');
    assert.equal(state.cleanup.status, 'conflict');
    assert.equal(harness.notices.length, 1);
    assert.equal(harness.notices[0]?.level, 'warning');
    assert.deepEqual(harness.notices[0]?.actions, [OPEN_DIFF]);
    assert.equal(
      harness.notices[0]?.message,
      'The previous session ended, but a file edited while instrumented was left untouched; its original is preserved.',
    );
    assert.match(harness.notices[0]?.detail ?? '', /new question was not sent/);
    assert.deepEqual(harness.executed, [SESSION_VIEW_FOCUS, 'debuggen.showModifications']);

    script.create = () => Promise.resolve(ok(sessionRecord('S2', { status: 'created' })));
    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(
      harness.calls,
      ['end:S1', 'get:S1', 'modifications:S1', 'create'],
      'a settled verdict on screen lets the second start proceed without ending S1 again',
    );
    assert.equal(state.activeSessionId, 'S2');
    assert.equal(harness.notices.length, 1, 'the second start adds no notice with the socket open');
  });

  it('Retry of a failed, patched session awaits its end before the replacement session is created', async () => {
    const { state, script } = harness;
    const failed = sessionRecord('S1', { status: 'failed', modifications: [appliedPatch('S1')] });
    state.adoptSession(failed, ENDPOINT_A);
    const ending = deferred<Result<SessionEndResponse, DebuggenError>>();
    script.end = () => ending.promise;
    script.create = () => Promise.resolve(ok(sessionRecord('S2', { status: 'created' })));

    // The view's Retry of an early stage re-asks the failed session's own question.
    const retry = startSession(harness.ctx, { question: failed.question });
    await settle();

    assert.deepEqual(harness.calls, ['end:S1'], 'no session may be created while S1 is ending');
    assert.equal(state.activeSessionId, 'S1');

    ending.resolve(ok({ cleanup: 'clean' }));
    await retry;

    assert.deepEqual(harness.calls, ['end:S1', 'create']);
    assert.equal(state.activeSessionId, 'S2');
    assert.deepEqual(harness.failures, []);
  });

  it('a refused create keeps the previous record in view and closes the creation window', async () => {
    const { state, script } = harness;
    state.adoptSession(sessionRecord('S1', { status: 'generated' }), ENDPOINT_A);
    script.end = () => Promise.resolve(ok({ cleanup: 'clean' }));
    script.create = () =>
      Promise.resolve(err(new DebuggenError('PROJECT_NOT_FOUND', 'The project was not found.')));

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['end:S1', 'create']);
    assert.equal(state.activeSessionId, 'S1', 'the ended previous session stays in view');
    assert.equal(state.activeSession?.status, 'ended');
    assert.equal(state.cleanup.status, 'clean');
    assert.equal(harness.failures.length, 1);
    assert.equal(harness.failures[0]?.options?.prefix, 'Could not start a session');
    assert.equal(state.sessionCreationPending, false);
  });

  it('frames of the new session that beat the HTTP answer are replayed on adoption; a frame of an unrelated session is not adopted', async () => {
    const { state, script } = harness;
    script.create = () => {
      // Pushed while the request is in flight, as POST /sessions allows.
      state.applySessionRecord(
        sessionRecord('S2', { status: 'understanding', updatedAt: T0 + 20 }),
      );
      state.applyProgress(progressRow('S2', 'Understanding the question'));
      state.applySessionRecord(sessionRecord('S3', { status: 'investigating' }));
      state.applyProgress(progressRow('S3', 'Row of a session in another window'));
      assert.equal(state.activeSessionId, undefined, 'no push may make a session active');
      return Promise.resolve(ok(sessionRecord('S2', { status: 'created', updatedAt: T0 + 5 })));
    };

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['create'], 'no end is sent when nothing is active');
    assert.equal(state.activeSessionId, 'S2');
    assert.equal(
      state.activeSession?.status,
      'understanding',
      'the newer pushed record wins over the older HTTP answer',
    );
    assert.deepEqual(
      state.progress.map((row) => row.message),
      ['Understanding the question'],
      'exactly the held rows of S2 are replayed',
    );
    assert.equal(state.sessionCreationPending, false);

    // A later push for an unrelated session changes nothing either.
    state.applySessionRecord(sessionRecord('S3', { status: 'generated', updatedAt: T0 + 99 }));
    assert.equal(state.activeSessionId, 'S2');
  });

  it('a second start while one is in flight is refused rather than racing the first', async () => {
    const { state, script } = harness;
    const creating = deferred<Result<SessionRecord, DebuggenError>>();
    script.create = () => creating.promise;

    const first = startSession(harness.ctx, { question: LIFECYCLE_QUESTION });
    await settle();
    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['create'], 'the second start must send nothing');
    assert.equal(harness.notices.length, 1);
    assert.equal(harness.notices[0]?.level, 'info');

    creating.resolve(ok(sessionRecord('S2', { status: 'created' })));
    await first;
    assert.equal(state.activeSessionId, 'S2');
  });

  it('a session the service no longer stores is replaced without a failure', async () => {
    const { state, script } = harness;
    state.adoptSession(sessionRecord('S1', { status: 'ready' }), ENDPOINT_A);
    script.end = () =>
      Promise.resolve(err(new DebuggenError('SESSION_NOT_FOUND', 'No such session.')));
    script.create = () => Promise.resolve(ok(sessionRecord('S2', { status: 'created' })));

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['end:S1', 'create']);
    assert.equal(state.activeSessionId, 'S2');
    assert.deepEqual(harness.failures, []);
  });

  it('a session created while the store is being disposed is ended rather than orphaned', async () => {
    const { state, script } = harness;
    script.create = () => {
      state.dispose();
      return Promise.resolve(ok(sessionRecord('S2', { status: 'created' })));
    };
    script.end = () => Promise.resolve(ok({ cleanup: 'clean' }));

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['create', 'end:S2']);
    assert.deepEqual(harness.addressed, [{ call: 'end:S2', endpoint: ENDPOINT_A }]);
    assert.equal(state.activeSessionId, undefined, 'a disposed store adopts nothing');
  });

  it('reopening another session while the current one is live and declining the confirmation ends nothing', async () => {
    const { state, script, answers } = harness;
    state.adoptSession(sessionRecord('S1', { modifications: [appliedPatch('S1')] }), ENDPOINT_A);
    answers.confirm = false;
    script.get = (sessionId) =>
      Promise.resolve(ok(sessionRecord(sessionId, { status: 'ended', updatedAt: T0 + 30 })));

    await reopenSession(harness.ctx, 'S2');

    assert.deepEqual(harness.calls, ['get:S2'], 'declining must not end the current session');
    assert.equal(harness.confirmations.length, 1);
    assert.equal(harness.confirmations[0]?.confirmLabel, 'End and Reopen');
    assert.equal(state.activeSessionId, 'S1');
    assert.equal(state.activeSession?.status, 'ready');
    assert.deepEqual(
      state.modifications.map((modification) => modification.id),
      ['S1-mod-1'],
    );
    assert.deepEqual(harness.notices, [], 'declining is silent');
    assert.deepEqual(harness.failures, []);
    assert.deepEqual(harness.executed, [], 'the view is not revealed for a declined reopen');
    assert.equal(state.sessionCreationPending, false);
  });

  it('S1 patched → reopen S2 → deactivate: accepting ends S1 before S2 becomes the only session deactivate ends', async () => {
    const { state, script, answers } = harness;
    state.adoptSession(sessionRecord('S1', { modifications: [appliedPatch('S1')] }), ENDPOINT_A);
    answers.confirm = true;
    let activeWhenEnded: string | undefined;
    script.end = (sessionId) => {
      activeWhenEnded = state.activeSessionId;
      assert.equal(sessionId, 'S1');
      return Promise.resolve(ok({ cleanup: 'clean' }));
    };
    script.get = (sessionId) =>
      Promise.resolve(ok(sessionRecord(sessionId, { status: 'generated', updatedAt: T0 + 30 })));

    await reopenSession(harness.ctx, 'S2');

    assert.deepEqual(harness.calls, ['get:S2', 'end:S1']);
    assert.equal(activeWhenEnded, 'S1', 'S1 must be ended while it is still the tracked session');
    assert.equal(harness.confirmations.length, 1);
    // deactivate() ends exactly the active session when it is not ended: that
    // is S2 now, and S1 — the only other session this editor tracked — has
    // already been ended above, so no obligation is left behind.
    assert.equal(state.activeSessionId, 'S2');
    assert.notEqual(state.activeSession?.status, 'ended');
    assert.deepEqual(state.modifications, [], "none of S1's patches remain in view");
    assert.deepEqual(harness.executed, [SESSION_VIEW_FOCUS]);
    assert.deepEqual(harness.failures, []);
    assert.equal(state.sessionCreationPending, false);
  });

  it('reopening while the session in view has already ended asks nothing and sends no end', async () => {
    const { state, script } = harness;
    state.adoptSession(
      sessionRecord('S1', {
        status: 'ended',
        cleanup: { status: 'clean', completedAt: T0 + 1, conflicts: [] },
      }),
      ENDPOINT_A,
    );
    script.get = (sessionId) => Promise.resolve(ok(sessionRecord(sessionId, { status: 'ended' })));

    await reopenSession(harness.ctx, 'S2');

    assert.deepEqual(harness.calls, ['get:S2']);
    assert.deepEqual(harness.confirmations, []);
    assert.equal(state.activeSessionId, 'S2');
  });

  it('reopening the session already in view merges its record and resets nothing', async () => {
    const { state, script } = harness;
    state.adoptSession(sessionRecord('S1', { status: 'ready' }), ENDPOINT_A);
    state.applyProgress(progressRow('S1', 'Understanding the question'));
    script.get = (sessionId) =>
      Promise.resolve(ok(sessionRecord(sessionId, { status: 'capturing', updatedAt: T0 + 40 })));

    await reopenSession(harness.ctx, 'S1');

    assert.deepEqual(harness.calls, ['get:S1'], 'the session in view is never ended to reopen it');
    assert.deepEqual(harness.confirmations, []);
    assert.equal(state.activeSession?.status, 'capturing');
    assert.equal(state.progress.length, 1, 'progress rows of the session in view are kept');
  });

  it('debuggen.endSession records the answer in the store, so the view shows "ended" without a socket', async () => {
    const { state, script } = harness;
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT_A);
    state.applyCaptureStarted({ sessionId: 'S1', captureId: 'C1' });
    script.socket = 'closed';
    script.end = () => Promise.resolve(ok({ cleanup: 'clean' }));

    await endSession(harness.ctx);

    assert.deepEqual(harness.calls, ['end:S1']);
    assert.equal(state.activeSessionId, 'S1');
    assert.equal(state.activeSession?.status, 'ended');
    assert.equal(state.cleanup.status, 'clean');
    assert.equal(typeof state.cleanup.completedAt, 'number');
    assert.equal(state.captureState.active, false, 'ending closes the capture window');
    assert.equal(harness.notices.length, 1);
    assert.equal(harness.notices[0]?.level, 'warning', 'the socket is closed, so the notice warns');
  });

  // -------------------------------------------------------------------------
  // The owning endpoint
  // -------------------------------------------------------------------------

  it('a session is owned by the endpoint captured before POST /sessions, even if the URL changes mid-request', async () => {
    const { state, script } = harness;
    script.create = () => {
      // debuggen.serviceUrl changes while the request is in flight.
      script.baseUrl = ENDPOINT_B;
      return Promise.resolve(ok(sessionRecord('S1', { status: 'created' })));
    };

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.equal(state.activeSessionId, 'S1');
    assert.equal(state.activeSessionEndpoint, ENDPOINT_A, 'the answering service owns S1');
  });

  it('debuggen.endSession ends S1 at endpoint A after debuggen.serviceUrl was switched to B', async () => {
    const { state, script } = harness;
    script.create = () => Promise.resolve(ok(sessionRecord('S1', { status: 'created' })));
    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });
    script.baseUrl = ENDPOINT_B;
    script.end = (_sessionId, endpoint) =>
      Promise.resolve(
        endpoint === ENDPOINT_A
          ? ok({ cleanup: 'clean' })
          : err(new DebuggenError('SESSION_NOT_FOUND', 'No such session.')),
      );

    await endSession(harness.ctx);

    assert.deepEqual(
      harness.addressed.filter((entry) => entry.call === 'end:S1'),
      [{ call: 'end:S1', endpoint: ENDPOINT_A }],
      'the end must be addressed to the service that created S1',
    );
    assert.equal(state.activeSession?.status, 'ended');
    assert.deepEqual(harness.failures, []);
  });

  it("B's SESSION_NOT_FOUND is never proof: when owner A refuses, the start stops with a notice naming A and S1 stays active", async () => {
    const { state, script } = harness;
    state.adoptSession(
      sessionRecord('S1', { status: 'capturing', modifications: [appliedPatch('S1')] }),
      ENDPOINT_A,
    );
    script.baseUrl = ENDPOINT_B;
    script.end = (_sessionId, endpoint) =>
      Promise.resolve(
        endpoint === ENDPOINT_A
          ? err(
              new DebuggenError('TRANSPORT_DISCONNECTED', 'The local service did not answer.', {
                hint: 'Run "Debug Generator: Start Local Service".',
              }),
            )
          : err(new DebuggenError('SESSION_NOT_FOUND', 'No such session.')),
      );
    script.create = () => Promise.resolve(ok(sessionRecord('S2', { status: 'created' })));

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['end:S1'], 'nothing may be created while S1 is not ended');
    assert.deepEqual(harness.addressed, [{ call: 'end:S1', endpoint: ENDPOINT_A }]);
    assert.equal(state.activeSessionId, 'S1');
    assert.equal(state.activeSession?.status, 'capturing', 'S1 is not relinquished');
    assert.equal(state.activeSessionEndpoint, ENDPOINT_A);
    assert.equal(harness.failures.length, 1);
    const hint = harness.failures[0]?.error.hint ?? '';
    assert.equal(harness.failures[0]?.error.code, 'TRANSPORT_DISCONNECTED');
    assert.ok(hint.includes(ENDPOINT_A), `the notice must name the owning endpoint: ${hint}`);
    assert.match(hint, /debuggen\.serviceUrl/);
    assert.match(harness.failures[0]?.options?.prefix ?? '', /new session was not started/);
  });

  it('reopen adopts the session with the endpoint that answered GET /sessions/:id', async () => {
    const { state, script } = harness;
    script.get = (sessionId) => {
      script.baseUrl = ENDPOINT_B;
      return Promise.resolve(ok(sessionRecord(sessionId, { status: 'generated' })));
    };

    await reopenSession(harness.ctx, 'S2');

    assert.deepEqual(harness.addressed, [{ call: 'get:S2', endpoint: ENDPOINT_A }]);
    assert.equal(state.activeSessionId, 'S2');
    assert.equal(state.activeSessionEndpoint, ENDPOINT_A);
  });

  it('a refused debuggen.serviceUrl sends no create and reports the refusal once', async () => {
    const { state, script } = harness;
    script.baseUrl = undefined;

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, []);
    assert.equal(state.activeSessionId, undefined);
    assert.equal(harness.failures.length, 1);
    assert.equal(harness.failures[0]?.error.code, 'CONFIG_INVALID');
    assert.equal(harness.failures[0]?.options?.prefix, 'Could not start a session');
    assert.equal(state.sessionCreationPending, false);
  });

  // -------------------------------------------------------------------------
  // Shutdown: the gate, the create ledger and the one deactivation routine
  // -------------------------------------------------------------------------

  /**
   * Runs deactivation's session work exactly as `deactivate()` does: the gate
   * closes, then the one routine runs against the harness's store and client.
   */
  function shutdown(timeouts?: Partial<ShutdownTimeouts>): Promise<ShutdownReport> {
    harness.state.beginShutdown();
    return endSessionsForShutdown({
      state: harness.state,
      client: harness.ctx.client,
      logger: harness.ctx.logger,
      timeouts,
    });
  }

  /** A `SESSION_NOT_FOUND` answer, as a service that never held the session gives it. */
  function notFound(): Result<SessionEndResponse, DebuggenError> {
    return err(new DebuggenError('SESSION_NOT_FOUND', 'No such session.'));
  }

  it('the whole shutdown routine fits the active end bound, while a create keeps a budget a busy service can meet', () => {
    assert.ok(
      DEFAULT_SHUTDOWN_TIMEOUTS.createSettleMs + DEFAULT_SHUTDOWN_TIMEOUTS.createdEndMs <=
        DEFAULT_SHUTDOWN_TIMEOUTS.activeEndMs,
    );
    // A create that times out while the service is still storing it would be
    // reported as failed for a session that exists, so the request budget is
    // not squeezed into the shutdown window; a late answer is ended by the
    // start command itself (covered below).
    assert.ok(SESSION_CREATE_TIMEOUT_MS > DEFAULT_SHUTDOWN_TIMEOUTS.activeEndMs);
  });

  it("a disposal holds the client's sockets comfortably longer than the whole shutdown routine can take", () => {
    // The routine's total: the active end runs beside the creates' wait and
    // their ends, so the longer of the two branches bounds it.
    const routine = Math.max(
      DEFAULT_SHUTDOWN_TIMEOUTS.activeEndMs,
      DEFAULT_SHUTDOWN_TIMEOUTS.createSettleMs + DEFAULT_SHUTDOWN_TIMEOUTS.createdEndMs,
    );
    assert.ok(
      CONNECTION_HOLD_TIMEOUT_MS >= 2 * routine,
      `CONNECTION_HOLD_TIMEOUT_MS (${String(CONNECTION_HOLD_TIMEOUT_MS)} ms) must stay well above the ${String(routine)} ms shutdown bound`,
    );
    // A socket wait for another service takes at most half an end's budget.
    assert.ok(ENDPOINT_SOCKET_OPEN_TIMEOUT_MS < CONNECTION_HOLD_TIMEOUT_MS);
  });

  it('an unanswered create is reported with a hint and a Reopen Session action, since the service may have created the session', async () => {
    const { script } = harness;
    script.create = () =>
      Promise.resolve(
        err(
          new DebuggenError('TRANSPORT_DISCONNECTED', 'The session.create request timed out', {
            hint: 'The local service did not answer in time.',
          }),
        ),
      );
    harness.answers.choice = 'Reopen Session';
    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    const [failure] = harness.failures;
    assert.ok(failure !== undefined, 'one failure notice');
    assert.equal(harness.failures.length, 1);
    assert.equal(failure.error.code, 'TRANSPORT_DISCONNECTED');
    assert.equal(failure.options?.prefix, 'Could not start a session');
    assert.deepEqual(failure.options?.actions, ['Reopen Session']);
    assert.match(failure.error.hint ?? '', /The local service did not answer in time\./);
    assert.match(failure.error.hint ?? '', /may still have started the session/);
    assert.ok(harness.executed.includes('debuggen.reopenSession'));
    assert.equal(harness.state.activeSessionId, undefined);
    assert.equal(harness.state.sessionCreatesInFlight.length, 0);
  });

  it('a refused create is reported once without the Reopen Session action', async () => {
    harness.script.create = () =>
      Promise.resolve(err(new DebuggenError('DEV_SERVER_UNAVAILABLE', 'No dev server.')));
    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.equal(harness.failures.length, 1);
    assert.equal(harness.failures[0]?.options?.actions, undefined);
    assert.ok(!harness.executed.includes('debuggen.reopenSession'));
  });

  it('deactivation while a create is withheld waits for it, ends the created session at its endpoint before resolving, and sends no create after shutdown began', async () => {
    const { state, script } = harness;
    const answer = deferred<Result<SessionRecord, DebuggenError>>();
    script.create = () => answer.promise;
    script.end = () => Promise.resolve(ok({ cleanup: 'clean' }));
    const starting = startSession(harness.ctx, { question: LIFECYCLE_QUESTION });
    await settle();
    assert.deepEqual(harness.calls, ['create']);
    assert.deepEqual(harness.createTimeouts, [SESSION_CREATE_TIMEOUT_MS]);

    let report: ShutdownReport | undefined;
    const ending = shutdown().then((value) => {
      report = value;
      return value;
    });
    // VS Code disposes context.subscriptions right after deactivate() returns its promise.
    state.dispose();
    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });
    await settle();
    assert.equal(report, undefined, 'the routine must wait for the create in flight');
    assert.deepEqual(harness.calls, ['create'], 'no create may be sent once shutdown began');

    answer.resolve(ok(sessionRecord('S2', { status: 'created' })));
    const settled = await ending;
    await starting;

    assert.deepEqual(harness.calls, ['create', 'end:S2'], 'S2 is ended exactly once');
    assert.deepEqual(harness.addressed, [{ call: 'end:S2', endpoint: ENDPOINT_A }]);
    assert.deepEqual(settled, {
      ended: [{ sessionId: 'S2', endpoint: ENDPOINT_A, origin: 'created', cleanup: 'clean' }],
      unsettledCreates: 0,
      unowned: [],
    });
    assert.equal(
      state.activeSessionId,
      undefined,
      'a session created during shutdown is never adopted',
    );
    assert.deepEqual(state.sessionCreatesInFlight, []);
    assert.deepEqual(harness.notices, []);
    assert.deepEqual(harness.failures, []);
    assertQuestionNeverLogged(harness);
  });

  it('deactivation ends the active session synchronously at its owning endpoint A after debuggen.serviceUrl was switched to B', async () => {
    const { state, script } = harness;
    state.adoptSession(
      sessionRecord('S1', { status: 'capturing', modifications: [appliedPatch('S1')] }),
      ENDPOINT_A,
    );
    script.baseUrl = ENDPOINT_B;
    script.end = (_sessionId, endpoint) =>
      Promise.resolve(endpoint === ENDPOINT_A ? ok({ cleanup: 'clean' }) : notFound());

    const ending = shutdown();
    assert.deepEqual(
      harness.addressed,
      [{ call: 'end:S1', endpoint: ENDPOINT_A }],
      'the end is issued before the routine first awaits, so deactivate() can register it',
    );
    assert.equal(
      harness.held.length,
      1,
      'the routine registers its completion with keepConnectionsFor before it first awaits',
    );
    assert.equal(harness.held[0], ending, 'the held operation is the promise deactivate() awaits');
    state.dispose();
    const report = await ending;

    assert.deepEqual(harness.calls, ['end:S1']);
    assert.deepEqual(report.ended, [
      { sessionId: 'S1', endpoint: ENDPOINT_A, origin: 'active', cleanup: 'clean' },
    ]);
    assert.equal(report.unsettledCreates, 0);
  });

  it("after owner A refused the replacement, deactivation still targets S1 at A and never takes B's SESSION_NOT_FOUND", async () => {
    const { state, script } = harness;
    state.adoptSession(
      sessionRecord('S1', { status: 'capturing', modifications: [appliedPatch('S1')] }),
      ENDPOINT_A,
    );
    script.baseUrl = ENDPOINT_B;
    script.end = (_sessionId, endpoint) =>
      Promise.resolve(
        endpoint === ENDPOINT_A
          ? err(new DebuggenError('TRANSPORT_DISCONNECTED', 'The local service did not answer.'))
          : notFound(),
      );
    script.create = () => Promise.resolve(ok(sessionRecord('S2', { status: 'created' })));

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });
    assert.equal(state.activeSessionId, 'S1', 'the refused replacement keeps S1 active');

    const report = await shutdown();

    assert.deepEqual(harness.addressed, [
      { call: 'end:S1', endpoint: ENDPOINT_A },
      { call: 'end:S1', endpoint: ENDPOINT_A },
    ]);
    assert.deepEqual(report.ended, [
      { sessionId: 'S1', endpoint: ENDPOINT_A, origin: 'active', code: 'TRANSPORT_DISCONNECTED' },
    ]);
    assert.equal(state.activeSession?.status, 'capturing', 'an unanswered end records nothing');
  });

  it('start is refused once shutdown began: nothing is ended, created or shown', async () => {
    const { state } = harness;
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT_A);
    state.beginShutdown();

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.notices, []);
    assert.deepEqual(harness.failures, []);
    assert.equal(state.activeSessionId, 'S1');
    assert.ok(
      harness.logs.some(
        (entry) => entry.message === 'Session start refused because the extension is shutting down',
      ),
    );
  });

  it('a deactivate() that runs while the previous session is being ended stops the start before POST /sessions', async () => {
    const { state, script } = harness;
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT_A);
    script.end = () => {
      state.beginShutdown();
      return Promise.resolve(ok({ cleanup: 'clean' }));
    };

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['end:S1'], 'no create may follow once shutdown began');
    assert.equal(state.activeSessionId, 'S1');
    assert.equal(state.activeSession?.status, 'ended');
    assert.deepEqual(state.sessionCreatesInFlight, []);
  });

  it('reopen is refused once shutdown began, and a GET answered after shutdown began adopts nothing and asks nothing', async () => {
    const { state, script, answers } = harness;
    state.adoptSession(
      sessionRecord('S1', { status: 'capturing', modifications: [appliedPatch('S1')] }),
      ENDPOINT_A,
    );
    answers.confirm = true;
    script.get = (sessionId) => {
      state.beginShutdown();
      return Promise.resolve(ok(sessionRecord(sessionId, { status: 'generated' })));
    };

    await reopenSession(harness.ctx, 'S2');
    await reopenSession(harness.ctx, 'S3');

    assert.deepEqual(harness.calls, ['get:S2'], 'nothing is sent once shutdown began');
    assert.deepEqual(harness.confirmations, [], 'no confirmation is shown to a closing window');
    assert.equal(state.activeSessionId, 'S1');
    assert.deepEqual(harness.executed, []);
    assert.deepEqual(harness.notices, []);
  });

  it('a create answered after the routine stopped waiting is ended by the start command at its endpoint', async () => {
    const { state, script } = harness;
    const answer = deferred<Result<SessionRecord, DebuggenError>>();
    script.create = () => answer.promise;
    script.end = () => Promise.resolve(ok({ cleanup: 'clean' }));
    const starting = startSession(harness.ctx, { question: LIFECYCLE_QUESTION });
    await settle();

    const report = await shutdown({ createSettleMs: 5 });
    assert.deepEqual(report, { ended: [], unsettledCreates: 1, unowned: [] });

    script.baseUrl = ENDPOINT_B;
    answer.resolve(ok(sessionRecord('S2', { status: 'created' })));
    await starting;

    assert.deepEqual(harness.addressed, [{ call: 'end:S2', endpoint: ENDPOINT_A }]);
    assert.equal(state.activeSessionId, undefined);
  });

  it('a malformed shutdown bound keeps the default rather than skipping the wait for a create', async () => {
    const answer = deferred<Result<SessionRecord, DebuggenError>>();
    harness.script.create = () => answer.promise;
    harness.script.end = () => Promise.resolve(ok({ cleanup: 'clean' }));
    const starting = startSession(harness.ctx, { question: LIFECYCLE_QUESTION });
    await settle();

    const ending = shutdown({ createSettleMs: Number.NaN, createdEndMs: -1 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    answer.resolve(ok(sessionRecord('S2', { status: 'created' })));
    const report = await ending;
    await starting;

    assert.equal(report.unsettledCreates, 0, 'a NaN bound must not end the wait at once');
    assert.deepEqual(
      report.ended.map((outcome) => [outcome.sessionId, outcome.origin, outcome.cleanup]),
      [['S2', 'created', 'clean']],
    );
  });

  it('a live session whose owning endpoint is unknown is reported as unowned and never ended elsewhere', async () => {
    const live = sessionRecord('S1', { status: 'capturing' });
    const fake: ShutdownState = {
      beginShutdown: () => undefined,
      activeSession: live,
      activeSessionEndpoint: undefined,
      sessionCreatesInFlight: [],
      claimOrphanedSessions: () => [],
      hasAcknowledgedEnd: () => false,
      applySessionEnded: () => undefined,
    };

    const report = await endSessionsForShutdown({
      state: fake,
      client: harness.ctx.client,
      logger: harness.ctx.logger,
    });

    assert.deepEqual(harness.calls, []);
    assert.deepEqual(report, { ended: [], unsettledCreates: 0, unowned: ['S1'] });
  });

  // -------------------------------------------------------------------------
  // Conflict details without the WebSocket
  // -------------------------------------------------------------------------

  it('with the WebSocket closed, a conflicted debuggen.endSession names the file and its backup, and the store holds the conflicts and the journal', async () => {
    const { state, script, answers } = harness;
    const patch = { ...appliedPatch('S1'), file: 'src/lib/file-1.ts' };
    const conflict = conflictOf('S1', 1);
    const conflicted: ModificationRecord = { ...patch, status: 'conflict' };
    state.adoptSession(
      sessionRecord('S1', { status: 'capturing', modifications: [patch] }),
      ENDPOINT_A,
    );
    script.socket = 'closed';
    script.baseUrl = ENDPOINT_B;
    answers.choice = OPEN_DIFF;
    script.end = () => Promise.resolve(ok({ cleanup: 'conflict' }));
    script.get = (sessionId) =>
      Promise.resolve(
        ok(
          sessionRecord(sessionId, {
            status: 'ended',
            updatedAt: T0 + 60,
            modifications: [conflicted],
            cleanup: { status: 'conflict', completedAt: T0 + 60, conflicts: [conflict] },
          }),
        ),
      );
    script.modifications = () => Promise.resolve(ok(journalPage([conflicted])));

    await endSession(harness.ctx);

    assert.notEqual(harness.script.socket, 'open');
    assert.deepEqual(harness.addressed, [
      { call: 'end:S1', endpoint: ENDPOINT_A },
      { call: 'get:S1', endpoint: ENDPOINT_A },
      { call: 'modifications:S1', endpoint: ENDPOINT_A },
    ]);
    assert.equal(harness.notices.length, 1);
    const [notice] = harness.notices;
    assert.equal(notice?.message, editedSentence(conflict));
    assert.ok(notice?.message.includes(conflict.file));
    assert.ok(notice?.message.includes(conflict.backupPath));
    assert.deepEqual(notice?.actions, [OPEN_DIFF]);
    assert.doesNotMatch(notice?.detail ?? '', /cannot be shown live/);
    assert.equal(state.activeSession?.status, 'ended');
    assert.equal(state.cleanup.status, 'conflict');
    assert.deepEqual(state.cleanup.conflicts, [conflict], 'the store holds the conflict');
    assert.deepEqual(
      state.modifications.map((record) => [record.id, record.status, record.backupPath]),
      [[patch.id, 'conflict', patch.backupPath]],
      'the store holds the journal',
    );
    assert.deepEqual(harness.executed, ['debuggen.showModifications']);
    assert.equal(
      JSON.stringify(harness.logs).includes(conflict.backupPath),
      false,
      'no backup path reaches a log record',
    );
  });

  it(`a conflicted start names each conflicted file in one sentence, at most ${String(MAX_CONFLICT_SENTENCES)}, and counts the rest`, async () => {
    const { state, script } = harness;
    state.adoptSession(sessionRecord('S1', { status: 'capturing' }), ENDPOINT_A);
    script.socket = 'closed';
    const conflicts = [
      conflictOf('S1', 1),
      conflictOf('S1', 2, 'file-missing'),
      { ...conflictOf('S1', 1), recordId: 'S1-mod-1b' },
      conflictOf('S1', 3),
      conflictOf('S1', 4),
      conflictOf('S1', 5),
    ];
    script.end = () => Promise.resolve(ok({ cleanup: 'partial' }));
    script.get = (sessionId) =>
      Promise.resolve(
        ok(
          sessionRecord(sessionId, {
            status: 'ended',
            updatedAt: T0 + 60,
            cleanup: { status: 'partial', completedAt: T0 + 60, conflicts },
          }),
        ),
      );
    script.modifications = () => Promise.resolve(ok(journalPage([])));

    await startSession(harness.ctx, { question: LIFECYCLE_QUESTION });

    assert.deepEqual(harness.calls, ['end:S1', 'get:S1', 'modifications:S1'], 'nothing is created');
    const [notice] = harness.notices;
    assert.equal(
      notice?.message,
      'The previous session ended, but 5 files were left untouched. Debug Generator will not overwrite them.',
    );
    const detail = notice?.detail ?? '';
    const [first, second, , third] = conflicts;
    assert.ok(first !== undefined && second !== undefined && third !== undefined);
    assert.ok(detail.includes(editedSentence(first)), detail);
    assert.ok(detail.includes(second.message), 'another reason keeps the service wording');
    assert.ok(detail.includes(editedSentence(third)), detail);
    assert.equal(detail.split(first.file).length - 1, 1, 'one sentence per file');
    assert.ok(!detail.includes('src/lib/file-4.ts'), 'beyond the bound, files are counted');
    assert.match(detail, /2 more files were left untouched; "Open diff" lists every one\./);
    assert.match(detail, /new question was not sent/);
    assert.deepEqual(notice?.actions, [OPEN_DIFF]);
    assert.equal(state.cleanup.conflicts.length, conflicts.length);
  });

  it('debuggen.showModifications fetches the journal from the owning endpoint and projects it into the store', async () => {
    const { state, script } = harness;
    state.adoptSession(
      sessionRecord('S1', { status: 'ended', modifications: [appliedPatch('S1')] }),
      ENDPOINT_A,
    );
    script.baseUrl = ENDPOINT_B;
    script.socket = 'closed';
    script.modifications = () =>
      Promise.resolve(ok(journalPage([{ ...appliedPatch('S1'), status: 'reverted' }])));

    await showModifications(harness.ctx);

    assert.deepEqual(harness.addressed, [{ call: 'modifications:S1', endpoint: ENDPOINT_A }]);
    assert.deepEqual(
      state.modifications.map((record) => record.status),
      ['reverted'],
    );
    assert.equal(harness.notices.length, 1);
    assert.equal(harness.notices[0]?.message, '1 file modification is recorded for this session.');
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle against a real service: the service, the project, the tree
// ---------------------------------------------------------------------------

/**
 * A question whose deterministic plan patches exactly the fixture's route
 * handler — the plan `apps/local-service/test/integration/cleanup-conflict.test.ts`
 * drives against the same fixture — and that file, POSIX-relative.
 */
const ROUTE_QUESTION = 'Why is the trail report slow to load?';
const ROUTE_FILE = 'app/api/trail-report/route.ts';

/** A question whose deterministic plan patches exactly the fixture's database pool, and that file. */
const POOL_QUESTION = 'Why is queryTrailConditionReports slow?';
const POOL_FILE = 'src/server/db/pool.ts';

/**
 * Budget of one real-service case: up to two services, several patch and
 * cleanup round trips and the teardown, on a CPU shared with sibling clones.
 */
const REAL_CASE_TIMEOUT_MS = 300_000;

/** Budget of the teardown of one real-service case. */
const REAL_TEARDOWN_TIMEOUT_MS = 120_000;

/** How long a spawned service may take to answer `GET /health`. */
const SERVICE_HEALTH_TIMEOUT_MS = 60_000;

/** How long the pipeline may take to plan, apply and report a session's patches. */
const PATCH_TIMEOUT_MS = 90_000;

/**
 * How long the editor socket may take to open, and the service to admit the
 * project it announced. The client reports `open` once its hello is written,
 * not once the service processed it, so the first project-scoped call is
 * retried while it is answered {@link NOT_YET_ANNOUNCED}.
 */
const ANNOUNCE_TIMEOUT_MS = 30_000;

/** The refusal of a project-scoped call no live editor socket announced (AAP §0.5.6). */
const NOT_YET_ANNOUNCED: DebuggenErrorCode = 'PATH_OUTSIDE_PROJECT';

/**
 * How long the deactivation-order case holds its requests back before they
 * leave: the asynchronous credential resolution an end goes through once VS
 * Code disposed the credential store. Far longer than a loopback service needs
 * to process a socket close, so the order "close first, end second" is
 * deterministic rather than a race, and well inside the active end's bound.
 */
const CREDENTIAL_RESOLUTION_DELAY_MS = 250;

/** Budget of one `devServer.launch` or `devServer.stop` round trip. */
const DEV_SERVER_CALL_TIMEOUT_MS = 60_000;

/** How long a stand-in dev server may outlive the service that launched it. */
const DEV_SERVER_EXIT_TIMEOUT_MS = 15_000;

/**
 * A literal in the stand-in dev server's command line. Teardown only ever
 * signals a leftover pid whose `/proc/<pid>/cmdline` carries it, so nothing
 * but this suite's own stand-in can be hit.
 */
const STAND_IN_MARKER = 'debuggen-commands-test-stand-in';

/** The committed fixture the real service instruments; only ever copied. */
function sampleProjectFixture(): string {
  return path.join(repositoryRoot(), 'apps', 'local-service', 'test', 'fixtures', 'sample-project');
}

/**
 * The dev server command the service's launcher runs for the scratch project:
 * the stand-in of `apps/local-service/test/integration/harness.ts`, which
 * prints the `Local:` line the launcher detects and answers every request with
 * `ok`, run by the suite's Node ({@link resolveNodeExecutable}) — never by
 * `process.execPath`, which is Electron in the extension host. The launcher
 * runs it without a shell, so the single quotes are its literal quoting.
 */
function standInDevServerCommand(): string {
  const node = resolveNodeExecutable();
  if (node.includes("'")) {
    throw new Error(`The test Node path ${node} contains a single quote and cannot be quoted.`);
  }
  const script = [
    `const marker = "${STAND_IN_MARKER}";`,
    'const server = require("node:http").createServer((request, response) => {',
    ' response.end("ok"); });',
    'server.listen(0, "127.0.0.1", () => {',
    ' console.log("Local: http://127.0.0.1:" + String(server.address().port)); });',
    'process.on("SIGTERM", () => { server.close(() => process.exit(0)); });',
  ].join('');
  return `'${node}' -e '${script}'`;
}

/** One file of a snapshot: its bytes and their SHA-256 (AAP §0.8.3). */
interface TreeEntry {
  readonly bytes: Buffer;
  readonly sha256: string;
}

/** Every entry under a root, keyed by its POSIX path relative to that root. */
type TreeSnapshot = ReadonlyMap<string, TreeEntry>;

/** The lowercase hex SHA-256 of `bytes`, the form modification records carry. */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Snapshots every entry under `root`; nothing is skipped. A symlink or special
 * file is recorded by kind, so one appearing where a file was is a difference.
 */
function snapshotTree(root: string): TreeSnapshot {
  const entries = new Map<string, TreeEntry>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        entries.set(relative, { bytes, sha256: sha256(bytes) });
      } else {
        const kind = entry.isSymbolicLink() ? 'symlink' : 'special';
        entries.set(relative, { bytes: Buffer.alloc(0), sha256: `<${kind}>` });
      }
    }
  };
  walk(root);
  return entries;
}

/**
 * The paths under `root` that are not byte-identical to `snapshot` right now:
 * changed, missing or added, in ascending order. Empty means the tree is
 * exactly what the snapshot recorded.
 */
function differingFiles(root: string, snapshot: TreeSnapshot): string[] {
  const now = snapshotTree(root);
  const differing = new Set<string>();
  for (const [file, before] of snapshot) {
    const current = now.get(file);
    if (current?.sha256 !== before.sha256 || !current.bytes.equals(before.bytes)) {
      differing.add(file);
    }
  }
  for (const file of now.keys()) {
    if (!snapshot.has(file)) {
      differing.add(file);
    }
  }
  return sorted(differing);
}

/** The absolute path of a POSIX-relative project file. */
function projectFile(projectRoot: string, file: string): string {
  return path.join(projectRoot, ...file.split('/'));
}

/** One embedded service this suite spawned. */
interface RealService {
  /** How the timeline names it: `A`, `B`. */
  readonly label: string;
  /** Its throwaway `DEBUGGEN_HOME`: `auth.json`, `sessions.sqlite`, `backups/`. */
  readonly home: string;
  /** `http://127.0.0.1:<port>`: what `debuggen.serviceUrl` names to reach it. */
  readonly url: string;
  readonly process: TrackedProcess;
}

/** How a child process ended, for a failure message. */
function describeExit(exit: ProcessExit): string {
  if (exit.error !== undefined) {
    return `could not be started (${exit.error.message})`;
  }
  return exit.signal !== null
    ? `was ended by ${exit.signal}`
    : `exited with code ${String(exit.code)}`;
}

/** An unknown failure as one line, with its chain of causes. */
function describeFailure(failure: unknown): string {
  const parts: string[] = [];
  let current: unknown = failure;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    parts.push(
      current instanceof Error ? `${current.name}: ${current.message}` : JSON.stringify(current),
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' <- ');
}

/**
 * Spawns the embedded service bundle exactly as `test/suite/packaged-vsix.test.ts`
 * does — `dist/service/main.js` with its own prompt tree, a fresh
 * `DEBUGGEN_HOME`, a `findFreePort()` loopback port and the hermetic,
 * deterministic environment — and waits for `GET /health`. A service that
 * exits first fails at once, with its output.
 *
 * @param label How the timeline names it.
 * @param credentialOf A service whose editor credential this one must accept:
 * its `auth.json` is placed in the new home (`0700`, file `0600`) before the
 * service starts, which it adopts rather than minting its own — the "same
 * machine, second service" a `debuggen.serviceUrl` change can point at.
 */
async function startRealService(label: string, credentialOf?: RealService): Promise<RealService> {
  const root = createScratchDir(`commands-service-${label.toLowerCase()}-`);
  const home = path.join(root, 'service-home');
  const cwd = path.join(root, 'service-cwd');
  fs.mkdirSync(cwd);
  if (credentialOf !== undefined) {
    fs.mkdirSync(home, { mode: 0o700 });
    const credential = path.join(home, 'auth.json');
    fs.copyFileSync(path.join(credentialOf.home, 'auth.json'), credential);
    fs.chmodSync(credential, 0o600);
  }

  const extensionRoot = extensionDevelopmentRoot();
  const port = await findFreePort();
  const child = spawnTracked(
    resolveNodeExecutable(),
    [path.join(extensionRoot, 'dist', 'service', 'main.js')],
    {
      cwd,
      env: hermeticEnv({
        DEBUGGEN_HOME: home,
        DEBUGGEN_HOST: '127.0.0.1',
        DEBUGGEN_PORT: String(port),
        DEBUGGEN_PROMPTS_DIR: path.join(extensionRoot, 'dist', 'service', 'prompts'),
        DEBUGGEN_LOG_LEVEL: 'error',
      }),
    },
  );
  const url = `http://127.0.0.1:${String(port)}`;
  try {
    await Promise.race([
      waitForHttpOk(`${url}${healthPath()}`, {
        timeoutMs: SERVICE_HEALTH_TIMEOUT_MS,
        message: `service ${label} (${child.commandLine}) to answer GET ${healthPath()}`,
      }),
      child.exited.then((exit): never => {
        throw new Error(`Service ${label} ${describeExit(exit)} before it answered GET /health.`);
      }),
    ]);
  } catch (cause) {
    throw new Error(
      `${describeFailure(cause)}\n--- service ${label} output ---\n${child.output()}`,
      { cause },
    );
  }
  return { label, home, url, process: child };
}

// ---------------------------------------------------------------------------
// Session lifecycle against a real service: the recorded client and the view
// ---------------------------------------------------------------------------

/** The session-scoped client calls the timeline records. */
type RecordedCall = 'create' | 'end' | 'get' | 'modifications';

/**
 * One instant of a case, in order: a request the commands sent, its answer,
 * or a change of the store's active session — each with the project files
 * that differed from the snapshot at that instant.
 */
interface TimelineEvent {
  readonly kind: 'send' | 'answer' | 'active';
  readonly call?: RecordedCall;
  /** The session the call is about; for a create's answer, the created one. */
  readonly sessionId: string | undefined;
  /** Where the call went: its `options.endpoint`, else the client's base URL then. */
  readonly endpoint?: string | undefined;
  /** An answer's `ok`, `ok:<cleanup verdict>` for an end, or `err:<code>`. */
  readonly outcome?: string;
  readonly differing: readonly string[];
}

/** One HTTP request as it left the real client's transport. */
interface WireRequest {
  readonly method: string;
  readonly origin: string;
  readonly pathname: string;
}

/** One frame the service pushed, before the store filtered it. */
interface FrameRecord {
  readonly type: MessageType;
  readonly sessionId: string | undefined;
}

/**
 * The real client as the commands receive it: every member is the real one,
 * bound to it, except the four session-scoped calls, which are logged — the
 * send and the answer, each with the files differing from the snapshot at that
 * instant — and then passed through unchanged.
 */
function recordingClient(
  real: ServiceClient,
  record: (event: TimelineEvent) => void,
  differing: () => readonly string[],
): ServiceClient {
  const around = async <T>(
    call: RecordedCall,
    sessionId: string | undefined,
    endpoint: string | undefined,
    send: () => Promise<Result<T, DebuggenError>>,
    summarize: (value: T) => { readonly outcome: string; readonly sessionId?: string },
  ): Promise<Result<T, DebuggenError>> => {
    record({ kind: 'send', call, sessionId, endpoint, differing: differing() });
    const answer = await send();
    const described = answer.ok ? summarize(answer.value) : { outcome: `err:${answer.error.code}` };
    record({
      kind: 'answer',
      call,
      sessionId: described.sessionId ?? sessionId,
      endpoint,
      outcome: described.outcome,
      differing: differing(),
    });
    return answer;
  };
  const addressed = (options: SessionEndpointCallOptions | undefined): string | undefined =>
    options?.endpoint ?? real.baseUrl;

  const intercepted: Pick<
    ServiceClient,
    'createSession' | 'endSession' | 'getSession' | 'getModifications'
  > = {
    createSession: (request, options) =>
      around(
        'create',
        undefined,
        real.baseUrl,
        () => real.createSession(request, options),
        (created) => ({ outcome: 'ok', sessionId: created.id }),
      ),
    endSession: (sessionId, options) =>
      around(
        'end',
        sessionId,
        addressed(options),
        () => real.endSession(sessionId, options),
        (ended) => ({ outcome: `ok:${ended.cleanup}` }),
      ),
    getSession: (sessionId, options) =>
      around(
        'get',
        sessionId,
        addressed(options),
        () => real.getSession(sessionId, options),
        () => ({ outcome: 'ok' }),
      ),
    getModifications: (sessionId, window, options) =>
      around(
        'modifications',
        sessionId,
        addressed(options),
        () => real.getModifications(sessionId, window, options),
        () => ({ outcome: 'ok' }),
      ),
  };

  return new Proxy(real, {
    get(target, property): unknown {
      if (typeof property === 'string' && Object.hasOwn(intercepted, property)) {
        return Reflect.get(intercepted, property);
      }
      // The client keeps its state in private fields: every other member is
      // read from, and bound to, the real instance.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * The real client's HTTP transport in this suite: one direct `node:http`
 * request per call, `agent: false`, answering the {@link FetchLike} shape the
 * protocol client reads (status and body text).
 *
 * Why not the platform `fetch` the extension passes by default: inside the
 * extension host VS Code replaces `globalThis.fetch` with its proxy-resolving
 * implementation, which in VS Code 1.139 fails before sending anything
 * ("fetch failed" caused by "Cannot find module '../llhttp/llhttp-wasm.js'",
 * from the editor's bundled undici under `@vscode/proxy-agent`) — the same
 * reason `test/helpers.ts` probes over `node:http`. Every other layer — the
 * protocol client, its credential refresh, timeouts, route table and reply
 * schemas — is the real one. Redirects are not followed.
 */
function loopbackHttpFetch(url: string, init?: HttpFetchInit): Promise<HttpResponseLike> {
  return new Promise((resolve, reject) => {
    const body = init?.body;
    const headers: Record<string, string> = { ...init?.headers };
    if (body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const request = http.request(
      new URL(url),
      { method: init?.method ?? 'GET', headers, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: status >= 200 && status <= 299,
            status,
            statusText: response.statusMessage ?? '',
            text: () => Promise.resolve(text),
          });
        });
      },
    );
    request.on('error', reject);
    const signal = init?.signal;
    if (signal !== undefined && signal !== null) {
      const abort = (): void => {
        request.destroy(new Error('The request was aborted.'));
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener('abort', abort, { once: true });
        request.on('close', () => {
          signal.removeEventListener('abort', abort);
        });
      }
    }
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

/**
 * The `session.id` of a record frame, or the `sessionId` of any other payload
 * that carries one.
 */
function frameSessionId(payload: object): string | undefined {
  if ('session' in payload && typeof payload.session === 'object' && payload.session !== null) {
    const { session } = payload;
    return 'id' in session && typeof session.id === 'string' ? session.id : undefined;
  }
  return 'sessionId' in payload && typeof payload.sessionId === 'string'
    ? payload.sessionId
    : undefined;
}

/**
 * Feeds the store exactly as `subscribeInbound` in `src/extension.ts` does —
 * one mutator per frame, no filtering of its own (the mutators ignore a
 * session other than the active one) — and records every frame first. The
 * rows `subscribeInbound` only logs or hands to the editor (`session.bound`,
 * `source.open`, `error`) are recorded and go no further.
 */
function routeFramesIntoStore(
  client: ServiceClient,
  state: ExtensionState,
  frames: FrameRecord[],
): (() => void)[] {
  const seen = (type: MessageType, payload: object): void => {
    frames.push({ type, sessionId: frameSessionId(payload) });
  };
  return [
    client.on('session.created', (message) => {
      seen(message.type, message.payload);
      state.applySessionRecord(message.payload.session);
    }),
    client.on('session.updated', (message) => {
      seen(message.type, message.payload);
      state.applySessionRecord(message.payload.session);
    }),
    client.on('session.progress', (message) => {
      seen(message.type, message.payload);
      state.applyProgress(message.payload);
    }),
    client.on('session.bound', (message) => {
      seen(message.type, message.payload);
    }),
    client.on('target.selected', (message) => {
      seen(message.type, message.payload);
      state.applyTargetSelected(message.payload);
    }),
    client.on('instrumentation.plan', (message) => {
      seen(message.type, message.payload);
      state.applyInstrumentationPlan(message.payload);
    }),
    client.on('instrumentation.ready', (message) => {
      seen(message.type, message.payload);
      state.applyInstrumentationReady(message.payload);
    }),
    client.on('instrumentation.failed', (message) => {
      seen(message.type, message.payload);
      state.applyInstrumentationFailed(message.payload);
    }),
    client.on('capture.started', (message) => {
      seen(message.type, message.payload);
      state.applyCaptureStarted(message.payload);
    }),
    client.on('capture.stopped', (message) => {
      seen(message.type, message.payload);
      state.applyCaptureStopped(message.payload);
    }),
    client.on('analysis.completed', (message) => {
      seen(message.type, message.payload);
      state.applyAnalysis(message.payload.analysis);
    }),
    client.on('panel.generated', (message) => {
      seen(message.type, message.payload);
      state.applyPanelGenerated(message.payload);
    }),
    client.on('cleanup.completed', (message) => {
      seen(message.type, message.payload);
      state.applyCleanupCompleted(message.payload);
    }),
    client.on('source.open', (message) => {
      seen(message.type, message.payload);
    }),
    client.on('error', (message) => {
      seen(message.type, message.payload);
    }),
  ];
}

/** The substitute webview the session view is resolved into. */
interface SubstituteWebview {
  /** Every frame the host posted to it, in order. */
  readonly posted: HostToWebviewMessage[];
  /** Delivers `message` to the host as the webview's script would post it. */
  send(message: unknown): void;
}

/**
 * Resolves `provider` into a webview that records what the host posts and
 * lets the case post frames back — the shape `session-view-provider.test.ts`
 * resolves into — and announces it `ready`, as the bundle does on load.
 */
function resolveSubstituteWebview(provider: SessionViewProvider): SubstituteWebview {
  const posted: HostToWebviewMessage[] = [];
  let receive: ((message: unknown) => void) | undefined;
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-webview://commands-test',
    asWebviewUri: (target: vscode.Uri): vscode.Uri => target,
    onDidReceiveMessage: (listener: (message: unknown) => void): vscode.Disposable => {
      receive = listener;
      return new vscode.Disposable(() => {
        receive = undefined;
      });
    },
    postMessage: (message: unknown): Thenable<boolean> => {
      posted.push(message as HostToWebviewMessage);
      return Promise.resolve(true);
    },
  };
  const view = {
    webview,
    onDidDispose: (): vscode.Disposable => new vscode.Disposable(() => undefined),
  };
  provider.resolveWebviewView(
    view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    { isCancellationRequested: false } as vscode.CancellationToken,
  );
  const send = (message: unknown): void => {
    if (receive === undefined) {
      throw new Error('The session view did not subscribe to the substitute webview.');
    }
    receive(message);
  };
  send({ type: 'ready' });
  return { posted, send };
}

// ---------------------------------------------------------------------------
// Session lifecycle against a real service: the harness
// ---------------------------------------------------------------------------

/** One stand-in dev server a service launched for the scratch project. */
interface LaunchedDevServer {
  readonly service: RealService;
  readonly pid: number;
}

/** Everything one real-service case drives and inspects. */
interface RealHarness {
  /** The services of the case; the first is the one `debuggen.serviceUrl` names at start. */
  readonly services: readonly RealService[];
  /** The scratch copy of the fixture project the service instruments. */
  readonly project: string;
  /** The copy's snapshot, taken before anything ran. */
  readonly snapshot: TreeSnapshot;
  readonly state: ExtensionState;
  /** The real client, unwrapped: what the case polls with; never in the timeline. */
  readonly real: ServiceClient;
  readonly ctx: CommandContext;
  readonly view: SessionViewProvider;
  readonly webview: SubstituteWebview;
  readonly answers: UiAnswers;
  readonly timeline: TimelineEvent[];
  readonly wire: WireRequest[];
  /** Every request the transport could not complete, with its cause chain. */
  readonly transportFailures: string[];
  readonly frames: FrameRecord[];
  readonly notices: CommandNotice[];
  readonly failures: {
    readonly error: DebuggenError;
    readonly options: FailureNoticeOptions | undefined;
  }[];
  readonly confirmations: DestructiveConfirmation[];
  /** Command ids the UI double was asked to run; none is executed. */
  readonly executed: string[];
  /** Every `debuggen.startSession` the session view ran, as the promise of that run. */
  readonly viewRuns: Promise<void>[];
  readonly logs: LogEntry[];
  readonly devServers: LaunchedDevServer[];
  /** Releases the editor side (view, subscriptions, client, credential, store), once. */
  readonly release: () => void;
  /**
   * Disposes, in the caller's synchronous turn and in the order `activate()`
   * pushed them into `context.subscriptions`, what the extension host
   * disposes right after `deactivate()` returns its promise: the store, the
   * credential store and the client.
   */
  disposeLikeVsCode(): void;
  /** Whether the case disposed the editor side itself; its client then opens nothing any more. */
  isEditorDisposed(): boolean;
  /**
   * Makes every later request wait `ms` after it is recorded on the wire and
   * before it leaves — the time a request spends resolving its credential
   * asynchronously once VS Code has disposed the credential store's cache.
   */
  delayRequests(ms: number): void;
  /** The project files differing from the snapshot right now. */
  differing(): string[];
  /** Points `debuggen.serviceUrl` at `service`, the way a settings change does. */
  switchServiceUrl(service: RealService): void;
  /** The label of the service `endpoint` names, for readable assertions. */
  labelOf(endpoint: string | undefined): string;
}

/**
 * Builds the editor side of a case around the real services: the scratch
 * project and its snapshot; the editor credential read from the first
 * service's `auth.json`; the real client announcing the project, with a
 * switchable `debuggen.serviceUrl` and a transport that records each request
 * before sending it over {@link loopbackHttpFetch}; the real store fed as
 * `subscribeInbound` feeds it; the real session view in a substitute webview;
 * and the {@link CommandContext} of the lifecycle harness around all of it.
 * Resolves once the socket is open; a harness that cannot open releases what
 * it built before it throws.
 */
async function openRealHarness(services: readonly RealService[]): Promise<RealHarness> {
  const [initial] = services;
  if (initial === undefined) {
    throw new Error('openRealHarness needs at least one service.');
  }

  const fixture = sampleProjectFixture();
  const container = createScratchDir('commands-project-');
  const project = path.join(container, path.basename(fixture));
  fs.cpSync(fixture, project, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  const snapshot = snapshotTree(project);
  assert.deepEqual(
    differingFiles(fixture, snapshot),
    [],
    'the scratch copy is not byte-identical to the committed fixture',
  );
  assert.ok(snapshot.has(ROUTE_FILE) && snapshot.has(POOL_FILE), 'the fixture lost a patched file');

  const logs: LogEntry[] = [];
  const logger = recordingLogger(logs);
  // What the editor side holds, released last-in first-out, exactly once: by
  // the teardown, or right here when the harness cannot be opened.
  const release: (() => void)[] = [];
  const releaseAll = (): void => {
    for (const step of release.splice(0).reverse()) {
      step();
    }
  };

  // The editor credential, exactly as the extension reads it: from the
  // service's own state root.
  const credential = createEditorCredentialStore({ debuggenHome: initial.home, logger });
  release.push(() => {
    credential.dispose();
  });
  const token = await credential.waitForCredential({ timeoutMs: ANNOUNCE_TIMEOUT_MS });
  if (isErr(token)) {
    releaseAll();
    throw new Error(
      `The editor credential of service ${initial.label} could not be read: ${token.error.code}: ${token.error.message}`,
    );
  }

  // `debuggen.serviceUrl`, as a source the case can change.
  let serviceUrl = initial.url;
  const urlListeners = new Set<() => void>();
  const configuration: ServiceClientConfiguration = {
    readServiceUrl: () => serviceUrl,
    onDidChangeServiceUrl: (listener) => {
      urlListeners.add(listener);
      return {
        dispose: () => {
          urlListeners.delete(listener);
        },
      };
    },
  };

  const wire: WireRequest[] = [];
  const transportFailures: string[] = [];
  let requestDelayMs = 0;
  const transport: FetchLike = async (url, init) => {
    const target = new URL(url);
    const method = init?.method ?? 'GET';
    wire.push({ method, origin: target.origin, pathname: target.pathname });
    if (requestDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, requestDelayMs);
      });
    }
    try {
      return await loopbackHttpFetch(url, init);
    } catch (failure) {
      transportFailures.push(`${method} ${target.pathname}: ${describeFailure(failure)}`);
      throw failure;
    }
  };

  const state = new ExtensionState({ serviceUrl: initial.url, provider: 'deterministic' });
  release.push(() => {
    state.dispose();
  });

  // Wired exactly as `activate()` wires it: the socket to the service owning
  // the session in view survives a URL or project switch, and is released on
  // the store change that moves the session elsewhere.
  const real = createServiceClient({
    credential,
    projectRoot: project,
    logger,
    configuration,
    fetch: transport,
    retainedEndpoint: () => state.activeSessionEndpoint,
  });
  release.push(() => {
    real.dispose();
  });
  const pruneOnChange = state.onDidChange(() => {
    real.pruneRetainedConnections();
  });
  release.push(() => {
    pruneOnChange.dispose();
  });

  const timeline: TimelineEvent[] = [];
  const differing = (): string[] => differingFiles(project, snapshot);
  const client = recordingClient(
    real,
    (event) => {
      timeline.push(event);
    },
    differing,
  );

  const frames: FrameRecord[] = [];
  const unsubscribe = routeFramesIntoStore(real, state, frames);
  state.setConnectionStatus(real.state);
  unsubscribe.push(
    real.onStateChange((connection) => {
      state.setConnectionStatus(connection);
    }),
  );
  release.push(() => {
    for (const stop of unsubscribe) {
      stop();
    }
  });

  // Every change of the active session, with the tree at that instant.
  let observedActive = state.activeSessionId;
  const activeWatch = state.onDidChange(() => {
    const active = state.activeSessionId;
    if (active !== observedActive) {
      observedActive = active;
      timeline.push({ kind: 'active', sessionId: active, differing: differing() });
    }
  });
  release.push(() => {
    activeWatch.dispose();
  });

  const answers: UiAnswers = { confirm: false, choice: undefined };
  const notices: CommandNotice[] = [];
  const failures: RealHarness['failures'] = [];
  const confirmations: DestructiveConfirmation[] = [];
  const executed: string[] = [];
  const ui: CommandUi = {
    notify: (notice) => {
      notices.push(notice);
      return Promise.resolve(
        notice.actions !== undefined && notice.actions.length > 0 ? answers.choice : undefined,
      );
    },
    notifyFailure: (error, options) => {
      failures.push({ error, options });
      return Promise.resolve(
        options?.actions !== undefined && options.actions.length > 0 ? answers.choice : undefined,
      );
    },
    confirmDestructive: (options) => {
      confirmations.push(options);
      return Promise.resolve(answers.confirm);
    },
    pick: () => Promise.reject(new Error('ui.pick was called, but this suite does not script it')),
    executeCommand: <T>(command: string): Promise<T> => {
      executed.push(command);
      return Promise.resolve(undefined as T);
    },
  };

  const projectInfo: ProjectRootInfo = {
    projectRoot: project,
    name: path.basename(project),
    folderUri: vscode.Uri.file(project),
    folderIndex: 0,
  };
  const guards: CommandGuards = {
    requireActiveSession: () => {
      const sessionId = state.activeSessionId;
      if (sessionId === undefined) {
        notices.push({ level: 'warning', message: 'No active session.' });
        return undefined;
      }
      return { sessionId, session: state.activeSession };
    },
    requireWorkspaceProject: () => projectInfo,
  };

  // The real session view. Its command runner sends `debuggen.startSession`
  // — the only command a Retry of a stage up to `instrument` runs — to the
  // command itself, with the context below; anything else is refused loudly.
  const viewRuns: Promise<void>[] = [];
  const routing: { context?: CommandContext } = {};
  const view = new SessionViewProvider({
    extensionUri: vscode.Uri.file(extensionDevelopmentRoot()),
    state,
    client,
    logger,
    executeCommand: <T>(command: string, ...args: unknown[]): Thenable<T> => {
      const commandContext = routing.context;
      if (command !== 'debuggen.startSession' || commandContext === undefined) {
        return Promise.reject(
          new Error(`The session view ran ${command}, which this suite does not route.`),
        );
      }
      const run = startSession(commandContext, ...args);
      viewRuns.push(run);
      return run.then(() => undefined as T);
    },
  });
  release.push(() => {
    view.dispose();
  });

  const ctx: CommandContext = {
    state,
    client,
    serviceProcess: strictDouble('serviceProcess', {}),
    credentials: credential,
    sessionView: view,
    sessionsTree: strictDouble<SessionsTreeProvider>('sessionsTree', {
      refresh: () => Promise.resolve(),
    }),
    logger,
    ui,
    guards,
    discovery: strictDouble<CommandDiscovery>('discovery', { probeDevServer: noDevServerProbe }),
    openSource: strictDouble('openSource', {}),
  };
  routing.context = ctx;
  const webview = resolveSubstituteWebview(view);

  real.connect();
  try {
    await waitFor(() => real.state === 'open', {
      timeoutMs: ANNOUNCE_TIMEOUT_MS,
      message: `the editor socket to service ${initial.label} to open`,
    });
  } catch (failure) {
    releaseAll();
    throw failure;
  }

  let editorDisposed = false;
  return {
    services,
    project,
    snapshot,
    state,
    real,
    ctx,
    view,
    webview,
    answers,
    timeline,
    wire,
    transportFailures,
    frames,
    notices,
    failures,
    confirmations,
    executed,
    viewRuns,
    logs,
    devServers: [],
    release: releaseAll,
    disposeLikeVsCode: () => {
      editorDisposed = true;
      state.dispose();
      credential.dispose();
      real.dispose();
    },
    isEditorDisposed: () => editorDisposed,
    delayRequests: (ms) => {
      requestDelayMs = ms;
    },
    differing,
    switchServiceUrl: (service) => {
      serviceUrl = service.url;
      for (const listener of [...urlListeners]) {
        listener();
      }
    },
    labelOf: (endpoint) => {
      if (endpoint === undefined) {
        return 'no endpoint';
      }
      const origin = URL.canParse(endpoint) ? new URL(endpoint).origin : endpoint;
      return services.find((service) => new URL(service.url).origin === origin)?.label ?? endpoint;
    },
  };
}

/**
 * Runs a project-scoped call until the service admits it: while the socket's
 * hello has not been processed yet the answer is {@link NOT_YET_ANNOUNCED};
 * any other answer is final, and a failure throws with its code.
 */
async function untilAnnounced<T>(
  what: string,
  call: () => Promise<Result<T, DebuggenError>>,
): Promise<T> {
  const { answer } = await waitFor(
    async () => {
      const outcome = await call();
      return outcome.ok || outcome.error.code !== NOT_YET_ANNOUNCED
        ? { answer: outcome }
        : undefined;
    },
    { timeoutMs: ANNOUNCE_TIMEOUT_MS, intervalMs: 50, message: `${what} to be admitted` },
  );
  if (isErr(answer)) {
    throw new Error(`${what} failed: ${answer.error.code}: ${answer.error.message}`);
  }
  return answer.value;
}

/** Waits until the client's socket is open (after a switch, to the new service). */
async function waitForSocketOpen(h: RealHarness, service: RealService): Promise<void> {
  await waitFor(() => h.real.state === 'open' && h.labelOf(h.real.baseUrl) === service.label, {
    timeoutMs: ANNOUNCE_TIMEOUT_MS,
    message: `the editor socket to service ${service.label} to open`,
  });
}

/**
 * Has the service `debuggen.serviceUrl` names launch the stand-in dev server
 * for the scratch project — a session cannot be created without one — and
 * remembers its pid for teardown.
 */
async function launchStandInDevServer(h: RealHarness, service: RealService): Promise<void> {
  assert.equal(h.labelOf(h.real.baseUrl), service.label, 'the client does not name that service');
  let launched: DevServerLaunchResponse;
  try {
    launched = await untilAnnounced(`devServer.launch at service ${service.label}`, () =>
      h.real.launchDevServer(
        { projectRoot: h.project, command: standInDevServerCommand() },
        { timeoutMs: DEV_SERVER_CALL_TIMEOUT_MS },
      ),
    );
  } catch (failure) {
    throw new Error(
      `${describeFailure(failure)}; transport failures: ${JSON.stringify(h.transportFailures)}`,
      { cause: failure },
    );
  }
  h.devServers.push({ service, pid: launched.pid });
}

/**
 * Every record of `sessionId`'s journal at the service `debuggen.serviceUrl`
 * names, in applied order, read page by page (`modifications.list` answers one
 * page, bounded by count and diff budget) until the page that ends the journal.
 * The protocol's page schema only admits a `nextOffset` past every record of
 * its page, so each request moves forward and the walk ends.
 */
async function readJournal(
  h: RealHarness,
  sessionId: string,
): Promise<readonly ModificationRecord[]> {
  const records: ModificationRecord[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: ModificationsResponse = unwrap(
      await h.real.getModifications(sessionId, { offset }),
    );
    records.push(...page.modifications);
    offset = page.nextOffset;
  }
  return records;
}

/**
 * Waits until the real installer has patched `sessionId`: its
 * `instrumentation.ready` was pushed and its journal holds only applied
 * records — then proves each is real: the plan's files exactly, recorded from
 * the snapshot's bytes, and the file on disk now hashing to the record's
 * instrumented hash, which differs from the original.
 */
async function waitForPatched(
  h: RealHarness,
  sessionId: string,
  files: readonly string[],
): Promise<readonly ModificationRecord[]> {
  const records = await waitFor(
    async () => {
      if (!h.frames.some((f) => f.type === 'instrumentation.ready' && f.sessionId === sessionId)) {
        return undefined;
      }
      const listed = await readJournal(h, sessionId);
      return listed.length > 0 && listed.every((record) => record.status === 'applied')
        ? listed
        : undefined;
    },
    { timeoutMs: PATCH_TIMEOUT_MS, intervalMs: 100, message: `session ${sessionId} to be patched` },
  );
  assert.deepEqual(
    sorted(records.map((record) => record.file)),
    sorted(files),
    `session ${sessionId} patched other files than its plan names`,
  );
  for (const record of records) {
    assert.equal(
      record.originalHash,
      h.snapshot.get(record.file)?.sha256,
      `${record.file} was not recorded from the snapshot's bytes`,
    );
    assert.notEqual(record.instrumentedHash, record.originalHash, `${record.file} was not changed`);
    assert.equal(
      sha256(fs.readFileSync(projectFile(h.project, record.file))),
      record.instrumentedHash,
      `${record.file} on disk is not the instrumented file its record describes`,
    );
  }
  return records;
}

/** The statuses of `sessionId`'s journal at the service `debuggen.serviceUrl` names. */
async function journalStatuses(h: RealHarness, sessionId: string): Promise<string[]> {
  const records = await readJournal(h, sessionId);
  return records.map((record) => `${record.file}:${record.status}`);
}

/**
 * The timeline as lines: `send end:<id> @A [files]`, `answer … ok:clean [files]`,
 * `active <id> [files]` — without the `[files]` part when `withFiles` is off,
 * for the instants after a new session starts patching on its own schedule.
 */
function renderTimeline(
  h: RealHarness,
  events: readonly TimelineEvent[],
  withFiles = true,
): string[] {
  return events.map((event) => {
    const files = withFiles ? ` [${event.differing.join(', ')}]` : '';
    if (event.kind === 'active') {
      return `active ${event.sessionId ?? 'none'}${files}`;
    }
    const about = event.sessionId === undefined ? '' : `:${event.sessionId}`;
    const target = `${event.call ?? 'call'}${about} @${h.labelOf(event.endpoint)}`;
    return event.kind === 'send'
      ? `send ${target}${files}`
      : `answer ${target} ${event.outcome ?? 'unknown'}${files}`;
  });
}

/** The state the session view last posted to its webview. */
function lastPostedState(
  h: RealHarness,
): Extract<HostToWebviewMessage, { type: 'state' }>['state'] | undefined {
  for (let index = h.webview.posted.length - 1; index >= 0; index -= 1) {
    const message = h.webview.posted[index];
    if (message?.type === 'state') {
      return message.state;
    }
  }
  return undefined;
}

/**
 * Puts the store in the state the view offers Retry of `instrument` for.
 *
 * The real service reports a failure at that stage on its own — with no page
 * agent for a bound tab, every browser-side signal's step is pushed as a
 * `failed` `instrument` row, while the server-side patches stay applied — but
 * it has no route that fails an instrumented session outright (only its
 * in-process manager does, which is what the service integration suites
 * drive). So the case waits for the service's genuine failed row and then
 * delivers what the service would push for a failed stage: an
 * `instrumentation.failed` carrying that row's sentence, and the session's
 * record marked `failed` — both parsed by the protocol's own schemas and
 * applied through the store's public mutators, exactly where
 * `subscribeInbound` would apply them. The patches on disk are the real
 * installer's, untouched.
 */
async function failAtInstrument(
  h: RealHarness,
  sessionId: string,
  patched: readonly string[],
): Promise<void> {
  const failedRow = await waitFor(
    () => h.state.progress.find((row) => row.stage === 'instrument' && row.status === 'failed'),
    {
      timeoutMs: PATCH_TIMEOUT_MS,
      message: `the service to report a failed instrument step of ${sessionId}`,
    },
  );
  const record = h.state.activeSession;
  assert.equal(record?.id, sessionId, 'the failing session is not the one in view');
  h.state.applyInstrumentationFailed(
    unwrap(
      parseInstrumentationFailedPayload({
        sessionId,
        error: {
          code: 'AGENT_NOT_READY',
          message: failedRow.message,
          hint: 'Open the app in Chrome with the Debug Generator panel, then retry.',
        },
      }),
    ),
  );
  h.state.applySessionRecord(
    unwrap(
      parseSessionRecord({
        ...record,
        status: 'failed',
        updatedAt: Math.max(Date.now(), record.updatedAt + 1),
      }),
    ),
  );
  await settle();
  const posted = lastPostedState(h);
  assert.equal(
    posted?.failure?.stage,
    'instrument',
    'the view must show a failed instrument stage',
  );
  assert.equal(posted.session?.status, 'failed', 'the view must show the session failed');
  assert.deepEqual(
    h.differing(),
    sorted(patched),
    "the failure must leave the session's patches on disk",
  );
}

/**
 * Posts the webview's Retry frame for `stage`, as its failure banner's button
 * does, and waits for the command the view dispatched to finish.
 */
async function retryFromWebview(h: RealHarness, stage: string): Promise<void> {
  const before = h.viewRuns.length;
  // A request frame names itself with a fresh `requestId`, as the webview's own
  // controls do; the view refuses one without it as malformed.
  h.webview.send({ type: 'retryStage', requestId: `retry-${String(before)}`, stage });
  await waitFor(() => h.viewRuns.length > before, {
    timeoutMs: ANNOUNCE_TIMEOUT_MS,
    message: 'the session view to dispatch its Retry',
  });
  await Promise.all(h.viewRuns);
  await settle();
}

/** Asserts no question of the case reached a log record (AAP 0.5.2). */
function assertQuestionsNeverLogged(h: RealHarness, questions: readonly string[]): void {
  const logged = JSON.stringify(h.logs);
  for (const question of questions) {
    assert.equal(logged.includes(question), false, 'a session question must never be logged');
  }
}

/** Whether `pid` is a live process: present in `/proc` and not a zombie. */
function isLiveProcess(pid: number): boolean {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    return false;
  }
  const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
  return state !== 'Z' && state !== 'X';
}

/**
 * Stops the stand-in dev server at `service` through a client of the
 * teardown's own: for a case that disposed the editor side as VS Code does,
 * whose client opens no socket any more. It announces the scratch project
 * there with the same editor credential, exactly as the editor did, and is
 * released before this resolves.
 */
async function stopDevServerWithOwnClient(h: RealHarness, service: RealService): Promise<void> {
  const logger = recordingLogger([]);
  const credential = createEditorCredentialStore({ debuggenHome: service.home, logger });
  const client = createServiceClient({
    credential,
    projectRoot: h.project,
    logger,
    configuration: {
      readServiceUrl: () => service.url,
      onDidChangeServiceUrl: () => ({ dispose: () => undefined }),
    },
    fetch: loopbackHttpFetch,
  });
  try {
    client.connect();
    await waitFor(() => client.state === 'open', {
      timeoutMs: ANNOUNCE_TIMEOUT_MS,
      message: `the teardown socket to service ${service.label} to open`,
    });
    await untilAnnounced(`devServer.stop at service ${service.label}`, () =>
      client.stopDevServer({ projectRoot: h.project }, { timeoutMs: DEV_SERVER_CALL_TIMEOUT_MS }),
    );
  } finally {
    client.dispose();
    credential.dispose();
  }
}

/**
 * Tears one case down, in the order that leaves nothing behind: each service
 * that launched a stand-in stops it (over a socket announcing the project
 * there — the harness's own client's, or a teardown client's when the case
 * disposed the editor side), the editor side is released, the services are
 * stopped, and no
 * stand-in may outlive them — a survivor is killed only when its command line
 * carries {@link STAND_IN_MARKER}, and is reported.
 *
 * @returns Every problem found; empty when the teardown was clean.
 */
async function teardownRealHarness(h: RealHarness): Promise<string[]> {
  const problems: string[] = [];
  const launchers = [...new Set(h.devServers.map((launched) => launched.service))];
  for (const service of launchers) {
    try {
      if (h.isEditorDisposed()) {
        await stopDevServerWithOwnClient(h, service);
        continue;
      }
      h.switchServiceUrl(service);
      await waitForSocketOpen(h, service);
      await untilAnnounced(`devServer.stop at service ${service.label}`, () =>
        h.real.stopDevServer({ projectRoot: h.project }, { timeoutMs: DEV_SERVER_CALL_TIMEOUT_MS }),
      );
    } catch (failure) {
      problems.push(
        `stopping the dev server at service ${service.label}: ${describeFailure(failure)}`,
      );
    }
  }
  h.release();
  for (const service of h.services) {
    try {
      await service.process.stop();
    } catch (failure) {
      problems.push(`stopping service ${service.label}: ${describeFailure(failure)}`);
    }
  }
  for (const { service, pid } of h.devServers) {
    const exited = await waitFor(() => !isLiveProcess(pid), {
      timeoutMs: DEV_SERVER_EXIT_TIMEOUT_MS,
      message: `the stand-in dev server ${String(pid)} to exit`,
    }).then(
      () => true,
      () => false,
    );
    if (exited) {
      continue;
    }
    problems.push(`the stand-in dev server ${String(pid)} of service ${service.label} survived`);
    let commandLine: string;
    try {
      commandLine = fs.readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (commandLine.includes(STAND_IN_MARKER)) {
      process.kill(pid, 'SIGKILL');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Session lifecycle against a real service: cases
// ---------------------------------------------------------------------------

describe('session lifecycle against a real service (commands.test)', () => {
  /** The harness of the running case, torn down after it whatever its outcome. */
  const open: RealHarness[] = [];

  /** Opens a harness and registers it for teardown. */
  async function harnessFor(services: readonly RealService[]): Promise<RealHarness> {
    const h = await openRealHarness(services);
    open.push(h);
    return h;
  }

  afterEach(async function () {
    this.timeout(REAL_TEARDOWN_TIMEOUT_MS);
    const problems: string[] = [];
    for (const h of open.splice(0)) {
      problems.push(...(await teardownRealHarness(h)));
    }
    try {
      // Stops any service a case spawned before its harness opened, and
      // removes every scratch directory: projects, homes, backups.
      await cleanupScratch();
    } catch (failure) {
      problems.push(`cleanupScratch: ${describeFailure(failure)}`);
    }
    const survivors = listTrackedProcesses().map((tracked) => tracked.commandLine);
    if (survivors.length > 0) {
      problems.push(`tracked processes survived: ${survivors.join('; ')}`);
    }
    assert.deepEqual(problems, [], 'the case left something behind');
  });

  it('INT-F26/API-F32 — S1 patched, live S2 reopened: S1 is restored before S2 is active, and deactivation ends S2 alone', async function () {
    this.timeout(REAL_CASE_TIMEOUT_MS);
    const serviceA = await startRealService('A');
    const h = await harnessFor([serviceA]);
    await launchStandInDevServer(h, serviceA);

    // S1: the developer's question, through the command.
    await startSession(h.ctx, { question: ROUTE_QUESTION });
    assert.deepEqual(h.failures, [], 'the start of S1 failed');
    const s1 = h.state.activeSessionId;
    assert.ok(s1 !== undefined, 'S1 was not adopted');
    const endpointA = h.state.activeSessionEndpoint;
    assert.equal(h.labelOf(endpointA), 'A', 'S1 is not owned by service A');
    const s1Records = await waitForPatched(h, s1, [ROUTE_FILE]);

    // S2: a second live session, created beside S1 and never adopted.
    const s2 = unwrap(
      await h.real.createSession(
        { projectRoot: h.project, question: POOL_QUESTION },
        { timeoutMs: SESSION_CREATE_TIMEOUT_MS },
      ),
    ).id;
    await waitForPatched(h, s2, [POOL_FILE]);
    assert.equal(h.state.activeSessionId, s1, 'S2 must not have replaced S1 in the store');
    assert.deepEqual(h.differing(), sorted([ROUTE_FILE, POOL_FILE]));

    // Reopen S2 and accept ending S1.
    const bothPatched = sorted([ROUTE_FILE, POOL_FILE]).join(', ');
    h.answers.confirm = true;
    const handoff = h.timeline.length;
    await reopenSession(h.ctx, s2);
    await settle();

    assert.deepEqual(h.failures, [], 'the reopen reported a failure');
    assert.deepEqual(
      h.confirmations.map((confirmation) => confirmation.message),
      ['End the current session and reopen the selected one?'],
    );
    assert.deepEqual(
      renderTimeline(h, h.timeline.slice(handoff)),
      [
        `send get:${s2} @A [${bothPatched}]`,
        `answer get:${s2} @A ok [${bothPatched}]`,
        `send end:${s1} @A [${bothPatched}]`,
        // Answered clean with S1's file already byte-identical to the snapshot…
        `answer end:${s1} @A ok:clean [${POOL_FILE}]`,
        // …and only then does S2 become the active session.
        `active ${s2} [${POOL_FILE}]`,
      ],
      'the handoff must end S1 at A, restored, before S2 becomes active',
    );
    assert.equal(h.state.activeSessionId, s2);
    assert.equal(h.state.activeSessionEndpoint, endpointA, 'S2 must be owned by service A');
    assert.deepEqual(
      await journalStatuses(h, s1),
      s1Records.map((record) => `${record.file}:reverted`),
      "S1's modification records must be reverted",
    );
    assert.deepEqual(h.executed, [SESSION_VIEW_FOCUS, SESSION_VIEW_FOCUS]);

    // Deactivation's session work: S2 alone is ended, at A.
    const shutdown = h.timeline.length;
    const wireAtShutdown = h.wire.length;
    h.state.beginShutdown();
    const report = await endSessionsForShutdown({
      state: h.state,
      client: h.ctx.client,
      logger: h.ctx.logger,
    });

    assert.deepEqual(report, {
      ended: [{ sessionId: s2, endpoint: endpointA, origin: 'active', cleanup: 'clean' }],
      unsettledCreates: 0,
      unowned: [],
    });
    assert.deepEqual(renderTimeline(h, h.timeline.slice(shutdown)), [
      `send end:${s2} @A [${POOL_FILE}]`,
      `answer end:${s2} @A ok:clean []`,
    ]);
    assert.deepEqual(
      h.wire.slice(wireAtShutdown),
      [
        {
          method: 'POST',
          origin: new URL(serviceA.url).origin,
          pathname: buildPath('session.end', { id: s2 }),
        },
      ],
      'deactivation must send exactly one request: the end of S2 at A',
    );
    assert.deepEqual(h.differing(), [], 'the project must equal its snapshot after deactivation');
    assert.deepEqual(await journalStatuses(h, s2), [`${POOL_FILE}:reverted`]);
    assertQuestionsNeverLogged(h, [ROUTE_QUESTION, POOL_QUESTION]);
  });

  it('FE-F24 — webview Retry of a failed, patched session: the replacement is created only after S1 is ended and restored byte for byte', async function () {
    this.timeout(REAL_CASE_TIMEOUT_MS);
    const serviceA = await startRealService('A');
    const h = await harnessFor([serviceA]);
    await launchStandInDevServer(h, serviceA);

    await startSession(h.ctx, { question: ROUTE_QUESTION });
    const s1 = h.state.activeSessionId;
    assert.ok(s1 !== undefined, 'S1 was not adopted');
    const s1Records = await waitForPatched(h, s1, [ROUTE_FILE]);
    await failAtInstrument(h, s1, [ROUTE_FILE]);

    const retry = h.timeline.length;
    await retryFromWebview(h, 'instrument');

    assert.deepEqual(h.failures, [], 'the Retry reported a failure');
    assert.deepEqual(h.notices, [], 'a clean handoff shows no notice');
    const s2 = h.state.activeSessionId;
    assert.ok(s2 !== undefined && s2 !== s1, 'the Retry did not adopt a replacement session');
    const events = h.timeline.slice(retry);
    assert.deepEqual(
      renderTimeline(h, events.slice(0, 3)),
      [
        `send end:${s1} @A [${ROUTE_FILE}]`,
        `answer end:${s1} @A ok:clean []`,
        // The replacement is requested only now, with every file of S1 — and
        // of the project — byte-identical to the snapshot.
        'send create @A []',
      ],
      'the Retry must end and restore S1 before it sends the create',
    );
    assert.deepEqual(
      renderTimeline(h, events.slice(3), false),
      [`answer create:${s2} @A ok`, `active ${s2}`],
      'the Retry must adopt the session its create answered',
    );
    assert.deepEqual(
      await journalStatuses(h, s1),
      s1Records.map((record) => `${record.file}:reverted`),
    );
    assert.equal(
      h.state.activeSession?.question,
      ROUTE_QUESTION,
      "the Retry resends S1's question",
    );
    assert.equal(h.state.activeSessionEndpoint, h.real.baseUrl);
    assert.equal(h.state.failure, undefined, 'adopting the replacement clears the failure');
    assert.equal(lastPostedState(h)?.session?.id, s2, 'the view must show the replacement');
    assert.equal(lastPostedState(h)?.failure, undefined, 'the view must leave its failed state');
    assertQuestionsNeverLogged(h, [ROUTE_QUESTION]);
  });

  it('FE-F24 — webview Retry after a developer edit to the patched file: the end answers conflict, nothing is created, and file and backup are kept', async function () {
    this.timeout(REAL_CASE_TIMEOUT_MS);
    const serviceA = await startRealService('A');
    const h = await harnessFor([serviceA]);
    await launchStandInDevServer(h, serviceA);

    await startSession(h.ctx, { question: ROUTE_QUESTION });
    const s1 = h.state.activeSessionId;
    assert.ok(s1 !== undefined, 'S1 was not adopted');
    const [patch] = await waitForPatched(h, s1, [ROUTE_FILE]);
    assert.ok(patch !== undefined);
    await failAtInstrument(h, s1, [ROUTE_FILE]);

    // The developer keeps working in the instrumented file.
    const edited = projectFile(h.project, ROUTE_FILE);
    const developerBytes = Buffer.concat([
      fs.readFileSync(edited),
      Buffer.from('\n// Edited by the developer while the session was instrumented.\n'),
    ]);
    fs.writeFileSync(edited, developerBytes);

    const retry = h.timeline.length;
    await retryFromWebview(h, 'instrument');

    const events = h.timeline.slice(retry);
    assert.deepEqual(
      events.filter((event) => event.call === 'create'),
      [],
      'a conflicted cleanup must stop the Retry before POST /sessions',
    );
    assert.deepEqual(renderTimeline(h, events.slice(0, 2)), [
      `send end:${s1} @A [${ROUTE_FILE}]`,
      `answer end:${s1} @A ok:conflict [${ROUTE_FILE}]`,
    ]);
    // The notice's details come from the owner, in whichever order they answer.
    assert.deepEqual(
      sorted(renderTimeline(h, events.slice(2))),
      sorted([
        `send get:${s1} @A [${ROUTE_FILE}]`,
        `answer get:${s1} @A ok [${ROUTE_FILE}]`,
        `send modifications:${s1} @A [${ROUTE_FILE}]`,
        `answer modifications:${s1} @A ok [${ROUTE_FILE}]`,
      ]),
    );

    // The backup the service kept: <DEBUGGEN_HOME>/backups/<session>/<original hash>.
    const backup = path.join(serviceA.home, 'backups', s1, patch.originalHash);
    assert.deepEqual(h.failures, []);
    assert.deepEqual(
      h.notices.map((notice) => ({
        level: notice.level,
        message: notice.message,
        detail: notice.detail,
        actions: notice.actions,
      })),
      [
        {
          level: 'warning',
          message: `The previous session ended. ${ROUTE_FILE} was edited while instrumented. Debug Generator will not overwrite it. Original saved at ${backup}.`,
          detail: `The new question was not sent. Review the modifications with "${OPEN_DIFF}", then ask your question again.`,
          actions: [OPEN_DIFF],
        },
      ],
      'the notice must name the edited file and its backup (AAP 0.5.5)',
    );
    assert.equal(fs.readFileSync(edited).equals(developerBytes), true, 'the edit must be kept');
    const original = h.snapshot.get(ROUTE_FILE)?.bytes;
    assert.ok(original !== undefined);
    assert.equal(
      fs.readFileSync(backup).equals(original),
      true,
      'the backup must hold the original',
    );
    assert.deepEqual(h.differing(), [ROUTE_FILE], 'only the edited file differs from the snapshot');

    // S1 stays in view, ended, with its conflict; nothing replaced it.
    assert.equal(h.state.activeSessionId, s1);
    assert.equal(h.state.activeSession?.status, 'ended');
    assert.equal(h.state.cleanup.status, 'conflict');
    assert.deepEqual(
      h.state.cleanup.conflicts.map((conflict) => [
        conflict.file,
        conflict.reason,
        conflict.backupPath,
      ]),
      [[ROUTE_FILE, 'content-changed', backup]],
    );
    assert.deepEqual(await journalStatuses(h, s1), [`${ROUTE_FILE}:conflict`]);
    assert.equal(lastPostedState(h)?.session?.id, s1);
    assertQuestionsNeverLogged(h, [ROUTE_QUESTION]);
  });

  it('API-F30/INT-F19 — S1 patched at service A, debuggen.serviceUrl switched to B: a start at B ends S1 at A, restored, before any create, and B is never asked about S1', async function () {
    this.timeout(REAL_CASE_TIMEOUT_MS);
    const serviceA = await startRealService('A');
    const serviceB = await startRealService('B', serviceA);
    const h = await harnessFor([serviceA, serviceB]);
    await launchStandInDevServer(h, serviceA);

    await startSession(h.ctx, { question: ROUTE_QUESTION });
    const s1 = h.state.activeSessionId;
    assert.ok(s1 !== undefined, 'S1 was not adopted');
    assert.equal(h.labelOf(h.state.activeSessionEndpoint), 'A', 'S1 is not owned by service A');
    await waitForPatched(h, s1, [ROUTE_FILE]);

    // The developer points debuggen.serviceUrl at B, which serves the same
    // project with the same editor credential but has never seen S1.
    h.switchServiceUrl(serviceB);
    assert.equal(h.labelOf(h.real.baseUrl), 'B', 'the client did not follow the setting');
    await waitForSocketOpen(h, serviceB);
    await launchStandInDevServer(h, serviceB);
    assert.deepEqual(h.differing(), [ROUTE_FILE], 'S1 must still be patched after the switch');

    const start = h.timeline.length;
    const wireAtStart = h.wire.length;
    await startSession(h.ctx, { question: POOL_QUESTION });

    const events = h.timeline.slice(start);
    assert.deepEqual(
      renderTimeline(h, events.slice(0, 3)),
      [`send end:${s1} @A [${ROUTE_FILE}]`, `answer end:${s1} @A ok:clean []`, 'send create @B []'],
      'the start at B must end S1 at its owner A, restored, before it creates anything; ' +
        `failure notices: ${JSON.stringify(h.failures.map((failure) => `${failure.error.code}: ${failure.error.message}`))}`,
    );
    const s2 = h.state.activeSessionId;
    assert.ok(s2 !== undefined && s2 !== s1, 'the start did not adopt its session');
    assert.deepEqual(renderTimeline(h, events.slice(3), false), [
      `answer create:${s2} @B ok`,
      `active ${s2}`,
    ]);
    assert.equal(h.labelOf(h.state.activeSessionEndpoint), 'B', 'the new session is owned by B');
    assert.deepEqual(h.failures, []);
    assert.deepEqual(
      h.wire
        .slice(wireAtStart)
        .filter((request) => request.pathname.includes(s1))
        .map((request) => `${request.method} @${h.labelOf(request.origin)} ${request.pathname}`),
      [`POST @A ${buildPath('session.end', { id: s1 })}`],
      'S1 must be ended at A, and B must never receive a request about S1',
    );
    assertQuestionsNeverLogged(h, [ROUTE_QUESTION, POOL_QUESTION]);
  });

  it('API-F30/INT-F19 — S1 patched at service A, debuggen.serviceUrl switched to B: deactivation ends S1 at A, restored, and B never receives an end for S1', async function () {
    this.timeout(REAL_CASE_TIMEOUT_MS);
    const serviceA = await startRealService('A');
    const serviceB = await startRealService('B', serviceA);
    const h = await harnessFor([serviceA, serviceB]);
    await launchStandInDevServer(h, serviceA);

    await startSession(h.ctx, { question: ROUTE_QUESTION });
    const s1 = h.state.activeSessionId;
    assert.ok(s1 !== undefined, 'S1 was not adopted');
    const endpointA = h.state.activeSessionEndpoint;
    assert.equal(h.labelOf(endpointA), 'A', 'S1 is not owned by service A');
    await waitForPatched(h, s1, [ROUTE_FILE]);

    h.switchServiceUrl(serviceB);
    await waitForSocketOpen(h, serviceB);
    assert.deepEqual(h.differing(), [ROUTE_FILE], 'S1 must still be patched after the switch');

    // Deactivation's session work, with debuggen.serviceUrl naming B.
    const shutdown = h.timeline.length;
    const wireAtShutdown = h.wire.length;
    h.state.beginShutdown();
    const report = await endSessionsForShutdown({
      state: h.state,
      client: h.ctx.client,
      logger: h.ctx.logger,
    });

    assert.deepEqual(
      renderTimeline(h, h.timeline.slice(shutdown)),
      [`send end:${s1} @A [${ROUTE_FILE}]`, `answer end:${s1} @A ok:clean []`],
      'deactivation must end S1 at its owner A, and the end must restore it',
    );
    assert.deepEqual(report, {
      ended: [{ sessionId: s1, endpoint: endpointA, origin: 'active', cleanup: 'clean' }],
      unsettledCreates: 0,
      unowned: [],
    });
    assert.deepEqual(
      h.wire.slice(wireAtShutdown),
      [
        {
          method: 'POST',
          origin: new URL(serviceA.url).origin,
          pathname: buildPath('session.end', { id: s1 }),
        },
      ],
      'deactivation must send one request, the end of S1 at A; B must receive nothing',
    );
    assert.deepEqual(h.differing(), [], 'the project must equal its snapshot after deactivation');
  });

  it("API-F30/INT-F19 — deactivation in VS Code's order: the routine, then the store, credential store and client disposed in the same turn — S1 is ended clean at A and every file equals its snapshot", async function () {
    this.timeout(REAL_CASE_TIMEOUT_MS);
    const serviceA = await startRealService('A');
    const h = await harnessFor([serviceA]);
    await launchStandInDevServer(h, serviceA);

    await startSession(h.ctx, { question: ROUTE_QUESTION });
    const s1 = h.state.activeSessionId;
    assert.ok(s1 !== undefined, 'S1 was not adopted');
    const endpointA = h.state.activeSessionEndpoint;
    assert.equal(h.labelOf(endpointA), 'A', 'S1 is not owned by service A');
    await waitForPatched(h, s1, [ROUTE_FILE]);
    assert.deepEqual(h.differing(), [ROUTE_FILE], 'S1 must be patched before deactivation');

    // deactivate(): the gate and the routine; then, before any await, what
    // the extension host disposes right after deactivate() returns its
    // promise. The end's request is still resolving its credential when the
    // client is disposed — modelled by holding every request back long
    // enough for the service to process a socket close first — so a socket
    // closed at disposal would withdraw the project's announcement before the
    // end arrived, and the service would refuse it PATH_OUTSIDE_PROJECT.
    const shutdown = h.timeline.length;
    const wireAtShutdown = h.wire.length;
    h.delayRequests(CREDENTIAL_RESOLUTION_DELAY_MS);
    h.state.beginShutdown();
    const ending = endSessionsForShutdown({
      state: h.state,
      client: h.ctx.client,
      logger: h.ctx.logger,
    });
    h.disposeLikeVsCode();
    assert.equal(
      h.real.state,
      'open',
      'the disposal must keep the socket the end relies on open until the end settled',
    );
    const report = await ending;

    assert.deepEqual(report, {
      ended: [{ sessionId: s1, endpoint: endpointA, origin: 'active', cleanup: 'clean' }],
      unsettledCreates: 0,
      unowned: [],
    });
    assert.deepEqual(
      renderTimeline(h, h.timeline.slice(shutdown)),
      [`send end:${s1} @A [${ROUTE_FILE}]`, `answer end:${s1} @A ok:clean []`],
      'deactivation must end S1 at A, and the end must restore it',
    );
    assert.deepEqual(
      h.wire.slice(wireAtShutdown),
      [
        {
          method: 'POST',
          origin: new URL(serviceA.url).origin,
          pathname: buildPath('session.end', { id: s1 }),
        },
      ],
      'deactivation must send exactly one request: the end of S1 at A',
    );
    assert.equal(h.real.state, 'closed', 'the disposal closes the socket once the end settled');
    assert.deepEqual(h.differing(), [], 'every project file must equal its snapshot');
    assertQuestionsNeverLogged(h, [ROUTE_QUESTION]);
  });
});
