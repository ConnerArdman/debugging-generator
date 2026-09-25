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
 * WHAT IT NEVER DOES. It executes none of the extension's commands:
 * registration presence and manifest shape are what it proves, and running
 * `debuggen.rotateServiceToken` or `debuggen.purgeSessions` would destroy
 * state. It opens no network connection, spawns no process and writes no file;
 * the run's throwaway `DEBUGGEN_HOME`, the deterministic provider and the
 * generic fixture workspace come from `.vscode-test.mjs`.
 *
 * MOCHA GLOBALS. The `@vscode/test-cli` runner supplies Mocha's `bdd`
 * interface as globals and this workspace declares no `@types/mocha` (see the
 * `compilerOptions.types` notes in `tsconfig.json`), so the globals this suite
 * calls are declared below in module scope, as the sibling suites do.
 *
 * @module apps/vscode-extension/test/suite/commands
 */

import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { COMMAND_IDS } from '../../src/commands/index';
import type { CommandId } from '../../src/commands/index';
import {
  EXTENSION_ID,
  SESSIONS_VIEW_ID,
  SESSION_VIEW_ID,
  activateExtensionOnce,
  cleanupScratch,
  closeAllEditors,
  readExtensionManifest,
  stopTrackedProcesses,
} from '../helpers';
import type { ExtensionManifest, ManifestMenuItem } from '../helpers';

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
