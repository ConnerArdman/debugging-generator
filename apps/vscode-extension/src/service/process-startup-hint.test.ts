/**
 * Tests for `./process.ts`: how the embedded service's start-up failure report
 * is read back, and what of it a surfaced failure may carry.
 *
 * The service's `main.ts` reports a failed start as a `debuggen: <CODE>:
 * <message>` line, optionally followed by a `debuggen: hint: <hint>` line. The
 * code (a closed vocabulary) and the service's message become the surfaced
 * error; the hint does **not** (CWE-532): a hint read back from a child's
 * stderr can relay text the editor must never place in a notification — a dev
 * server's output, a path, a value — so the surfaced hint is always the fixed
 * pointer to the "Debug Generator Service" output channel, where the service's
 * whole report, hint included, is visible.
 *
 * ## The `vscode` substitute
 *
 * The editor supplies the `vscode` module at runtime and no installable
 * package provides it, so `vi.mock` registers a factory for the bare
 * specifier. Every seam this module would read from it — settings, the
 * configuration-change event, the output channel — is injected here, so the
 * substitute is empty namespaces: a stray call would fail loudly rather than
 * reach a real editor.
 *
 * Nothing here spawns a process or dials a socket: the child is an
 * `EventEmitter` driven by hand and the health probe always refuses.
 */

import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DebuggenError, err, ok } from '@debuggen/shared';

import {
  SERVICE_OUTPUT_CHANNEL_NAME,
  createServiceProcess,
  parseStartupFailure,
  type ChildProcessLike,
  type ServiceOutputChannel,
  type ServiceProcess,
  type ServiceProcessDeps,
  type SpawnLike,
} from './process';

vi.mock('vscode', () => ({ workspace: {}, window: {} }));

/** The hint every surfaced start-up failure carries: the output channel, never the child's words. */
const SERVICE_OUTPUT_HINT = `Open the "${SERVICE_OUTPUT_CHANNEL_NAME}" output for the reason, then run "Debug Generator: Start Local Service".`;

/**
 * Text a child could relay on its hint line — a dev server's source frame and
 * a query value — joined at runtime so the fragments are unmistakable.
 */
const RELAYED_FRAGMENTS: readonly string[] = [
  ['const', 'marginFloor', '=', 'ledgerTotals'].join(' '),
  ['account', ['acct', 'sentinel', '4417'].join('-')].join('='),
];

/** The hint line a service would print after its failure line. */
const RELAYED_HINT_LINE = `debuggen: hint: Last output: ${RELAYED_FRAGMENTS.join(' | ')}`;

describe('parseStartupFailure', () => {
  it('returns the code and message, and no hint, when a hint line follows', () => {
    const reported = parseStartupFailure([
      'service starting',
      'debuggen: DEV_SERVER_LAUNCH_FAILED: The dev server could not be launched.',
      RELAYED_HINT_LINE,
    ]);

    expect(reported).toStrictEqual({
      code: 'DEV_SERVER_LAUNCH_FAILED',
      message: 'The dev server could not be launched.',
    });
    expect(reported).not.toHaveProperty('hint');
    expect(Object.isFrozen(reported)).toBe(true);
    for (const fragment of RELAYED_FRAGMENTS) {
      expect(JSON.stringify(reported)).not.toContain(fragment);
    }
  });

  it('returns the code and message when no hint line follows', () => {
    expect(
      parseStartupFailure(['debuggen: CONFIG_INVALID: DEBUGGEN_PORT must be an integer.']),
    ).toStrictEqual({ code: 'CONFIG_INVALID', message: 'DEBUGGEN_PORT must be an integer.' });
  });

  it('lets the last failure line win', () => {
    expect(
      parseStartupFailure([
        'debuggen: CONFIG_INVALID: The first report.',
        'debuggen: hint: first hint',
        'debuggen: STORE_ERROR: The last report.',
        'debuggen: hint: last hint',
      ]),
    ).toStrictEqual({ code: 'STORE_ERROR', message: 'The last report.' });
  });

  it.each([
    { label: 'only a hint line', lines: ['debuggen: hint: CONFIG_INVALID: not a failure'] },
    { label: 'an unknown code', lines: ['debuggen: NOT_A_CODE: Something happened.'] },
    { label: 'an empty message', lines: ['debuggen: CONFIG_INVALID:   '] },
    { label: 'no separator', lines: ['debuggen: CONFIG_INVALID'] },
    { label: 'ordinary output', lines: ['listening on 127.0.0.1', ''] },
    { label: 'nothing', lines: [] },
  ])('returns undefined for $label', ({ lines }) => {
    expect(parseStartupFailure(lines)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The surfaced failure, through the real supervisor over a fake child
// ---------------------------------------------------------------------------

/** A child that prints its report on stderr, closes its pipes and exits when told to. */
class FakeServiceChild extends EventEmitter implements ChildProcessLike {
  readonly pid = 4_242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();

  kill(): boolean {
    return true;
  }

  /** Print `lines` on stderr, end both streams, then exit with `code`. */
  failWith(lines: readonly string[], code: number): void {
    this.stderr.emit('data', `${lines.join('\n')}\n`);
    for (const stream of [this.stdout, this.stderr]) {
      stream.emit('end');
      stream.emit('close');
    }
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

/** An output channel that records every line it is given. */
function recordingChannel(): { readonly channel: ServiceOutputChannel; readonly lines: string[] } {
  const lines: string[] = [];
  const channel: ServiceOutputChannel = {
    append: (value) => {
      lines.push(value);
    },
    appendLine: (value) => {
      lines.push(value);
    },
    clear: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  };
  return { channel, lines };
}

const processes: ServiceProcess[] = [];

afterEach(() => {
  for (const service of processes.splice(0)) {
    service.dispose();
  }
});

/** A supervisor whose every seam is a double, spawning `child` on its first start. */
function createSupervisor(child: FakeServiceChild): {
  readonly service: ServiceProcess;
  readonly spawn: ReturnType<typeof vi.fn<SpawnLike>>;
  readonly outputLines: string[];
} {
  const { channel, lines } = recordingChannel();
  const spawn = vi.fn<SpawnLike>(() => child);
  const deps: ServiceProcessDeps = {
    paths: {
      serviceMain: '/opt/editor/extensions/debug-generator/dist/service/main.js',
      servicePromptsDir: '/opt/editor/extensions/debug-generator/dist/service/prompts',
    },
    probe: {
      health: () =>
        Promise.resolve(
          err(new DebuggenError('TRANSPORT_DISCONNECTED', 'Nothing answers at this address.')),
        ),
    },
    credential: {
      paths: () =>
        ok({
          debuggenHome: '/home/dev/.debuggen',
          authFilePath: '/home/dev/.debuggen/auth.json',
        }),
      ensure: () => Promise.resolve(ok(['editor', 'suite', 'credential'].join('-'))),
      waitForCredential: () => Promise.resolve(ok(['editor', 'suite', 'credential'].join('-'))),
    },
    env: { PATH: '/usr/bin:/bin' },
    spawn,
    readSettings: () => ({
      autoStartService: true,
      serviceUrl: 'http://127.0.0.1:43117',
      providerExplicit: undefined,
      providerDefault: 'deterministic',
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    createOutputChannel: () => channel,
    pathKind: (target) => (target.endsWith('prompts') ? 'directory' : 'file'),
    isExecutable: () => true,
    execPath: '/usr/bin/node',
    versions: { node: '24.21.0' },
    platform: 'linux',
  };
  const service = createServiceProcess(deps);
  processes.push(service);
  return { service, spawn, outputLines: lines };
}

describe('a service that exits before it answers', () => {
  it("surfaces the service's code and message with the output-channel hint, never its hint line", async () => {
    const child = new FakeServiceChild();
    const { service, spawn, outputLines } = createSupervisor(child);

    const pending = service.ensureRunning({ userInitiated: true });
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(1);
    });
    child.failWith(
      [
        'debuggen: DEV_SERVER_LAUNCH_FAILED: The dev server could not be launched.',
        RELAYED_HINT_LINE,
      ],
      1,
    );
    const result = await pending;

    expect(result.ok).toBe(false);
    const error = result.ok ? undefined : result.error;
    expect(error).toBeInstanceOf(DebuggenError);
    expect(error?.code).toBe('DEV_SERVER_LAUNCH_FAILED');
    expect(error?.message).toBe('The dev server could not be launched.');
    expect(error?.hint).toBe(SERVICE_OUTPUT_HINT);
    expect(error?.details).toStrictEqual({ reason: 'exited', exitCode: 1, signal: null });
    const surfaced = JSON.stringify({
      message: error?.message,
      hint: error?.hint,
      details: error?.details,
    });
    for (const fragment of RELAYED_FRAGMENTS) {
      expect(surfaced).not.toContain(fragment);
    }
    expect(service.status.error?.hint).toBe(SERVICE_OUTPUT_HINT);
    // The full report stays where the hint points: the output channel.
    expect(outputLines.join('\n')).toContain('debuggen: hint:');
  });

  it('surfaces the exit itself with the same hint when the service printed no report', async () => {
    const child = new FakeServiceChild();
    const { service, spawn } = createSupervisor(child);

    const pending = service.ensureRunning({ userInitiated: true });
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(1);
    });
    child.failWith(['unexpected end of input'], 3);
    const result = await pending;

    const error = result.ok ? undefined : result.error;
    expect(error?.code).toBe('TRANSPORT_DISCONNECTED');
    expect(error?.message).toContain('with exit code 3');
    expect(error?.hint).toBe(SERVICE_OUTPUT_HINT);
  });
});
