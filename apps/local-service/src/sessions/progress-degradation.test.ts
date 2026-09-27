/**
 * Tests for the AAP §0.5.5 degradation sentence of `./progress.ts` — "Could not
 * enable ‹signal›: ‹reason›. Continuing with: ‹enabled list›." — and for the
 * instrumentation stage's ✗ rows built with it.
 *
 * `unavailableSignalMessage` is the one composer of that sentence: the
 * checklist's ✗ rows, the instrumentation service's degradation notices and
 * its capture-time preload-gap rows all use it. Both user interfaces merge
 * progress rows by `(stage, message)`, so this suite pins what makes that merge
 * safe: every unavailable signal is one terminal `failed` row, worded once,
 * whose "Continuing with:" list names the signals actually enabled and never
 * the signal the row is about.
 */

import { describe, expect, it } from 'vitest';

import {
  CAPTURE_SIGNALS,
  buildReadiness,
  type CaptureSignal,
  type UnavailableSignal,
} from '@debuggen/instrumentation';
import { parseSessionProgressPayload } from '@debuggen/protocol';
import { newSessionId } from '@debuggen/shared';

import {
  CAPTURE_SIGNAL_LABELS,
  INSTRUMENTATION_ROW_ORDER,
  buildInstrumentationRows,
  unavailableSignalMessage,
  type ProgressRow,
} from './progress.js';

/* -------------------------------------------------------------------------------------------------
 * The sentence's fixed words, as AAP §0.5.5 prints them
 * ---------------------------------------------------------------------------------------------- */

const OPENING = 'Could not enable ';
const CONNECTIVE = ' Continuing with: ';
const NOTHING_CONFIRMED = 'no confirmed signal';

/** The bound, in code points, the composer keeps a sentence within. */
const MESSAGE_BOUND = 1000;

/* -------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

/** The list a sentence names after its connective, without the closing full stop. */
function continuationOf(message: string): string {
  const at = message.lastIndexOf(CONNECTIVE);

  if (at < 0 || !message.endsWith('.')) {
    throw new Error(`not a degradation sentence: ${message}`);
  }

  return message.slice(at + CONNECTIVE.length, -1);
}

/** The ✓ labels of a built report, in the order the rows show them. */
function checkedLabels(rows: readonly ProgressRow[]): string[] {
  return rows.filter((row) => row.status === 'done').map((row) => row.message);
}

/** The ✗ rows of a built report. */
function failedRowsOf(rows: readonly ProgressRow[]): ProgressRow[] {
  return rows.filter((row) => row.status === 'failed');
}

/** The labels of `signals`, de-duplicated and ordered as the ✓ rows are. */
function labelsInRowOrder(signals: readonly CaptureSignal[]): string[] {
  const labels = new Set<string>(signals.map((signal) => CAPTURE_SIGNAL_LABELS[signal]));

  return INSTRUMENTATION_ROW_ORDER.filter((label) => labels.has(label));
}

/* -------------------------------------------------------------------------------------------------
 * The composer
 * ---------------------------------------------------------------------------------------------- */

describe('unavailableSignalMessage', () => {
  const label = CAPTURE_SIGNAL_LABELS.pg;
  const reason = 'the driver hook refused to attach';
  const enabled = [CAPTURE_SIGNAL_LABELS.react, CAPTURE_SIGNAL_LABELS.fetch];

  it('names every enabled label after the connective, in the order given', () => {
    expect(unavailableSignalMessage(label, reason, enabled)).toBe(
      `${OPENING}${label}: ${reason}.${CONNECTIVE}${enabled.join(', ')}.`,
    );
    expect(
      unavailableSignalMessage(label, reason, [...enabled].reverse()),
      'the caller owns the order',
    ).toBe(`${OPENING}${label}: ${reason}.${CONNECTIVE}${[...enabled].reverse().join(', ')}.`);
  });

  it('says it continues with no confirmed signal when the enabled list is empty', () => {
    expect(unavailableSignalMessage(label, reason, [])).toBe(
      `${OPENING}${label}: ${reason}.${CONNECTIVE}${NOTHING_CONFIRMED}.`,
    );
  });

  it.each([
    { name: 'an empty string', value: '' },
    { name: 'whitespace and control characters', value: ' \n\t\u0085 ' },
    { name: 'full stops only', value: ' ... ' },
    { name: 'an absent reason', value: undefined },
    { name: 'a non-string reason', value: 42 },
  ])('keeps the connective and drops the reason clause for $name', ({ value }) => {
    expect(unavailableSignalMessage(label, value, enabled)).toBe(
      `${OPENING}${label}.${CONNECTIVE}${enabled.join(', ')}.`,
    );
    expect(unavailableSignalMessage(label, value, [])).toBe(
      `${OPENING}${label}.${CONNECTIVE}${NOTHING_CONFIRMED}.`,
    );
  });

  it('never lists the label it could not enable, however the caller spelled it', () => {
    expect(unavailableSignalMessage(label, reason, [label, ...enabled])).toBe(
      `${OPENING}${label}: ${reason}.${CONNECTIVE}${enabled.join(', ')}.`,
    );
    expect(
      unavailableSignalMessage(label, reason, [...enabled, ` ${label.replace(' ', '\n ')} `]),
    ).toBe(`${OPENING}${label}: ${reason}.${CONNECTIVE}${enabled.join(', ')}.`);
    expect(unavailableSignalMessage(label, reason, [label])).toBe(
      `${OPENING}${label}: ${reason}.${CONNECTIVE}${NOTHING_CONFIRMED}.`,
    );
  });

  it('writes label, reason and list as one line, dropping blanks and repeated labels', () => {
    const message = unavailableSignalMessage(
      `  ${label.replace(' ', '\r\n')}  `,
      `  the driver\thook\n refused to attach  `,
      [enabled[0] ?? '', '', ' \n ', enabled[1] ?? '', `${enabled[0] ?? ''} `],
    );

    expect(message).toBe(`${OPENING}${label}: ${reason}.${CONNECTIVE}${enabled.join(', ')}.`);
    expect(message).not.toMatch(/[\r\n\t]/u);
  });

  it('closes a reason that already ends in full stops exactly once', () => {
    expect(unavailableSignalMessage(label, `${reason}. . `, enabled)).toBe(
      `${OPENING}${label}: ${reason}.${CONNECTIVE}${enabled.join(', ')}.`,
    );
  });

  it('names a signal a third-party adapter defined by its own name', () => {
    expect(unavailableSignalMessage('sample-probe-signal', reason, enabled)).toBe(
      `${OPENING}sample-probe-signal: ${reason}.${CONNECTIVE}${enabled.join(', ')}.`,
    );
  });

  it.each([
    { name: 'an empty label', value: '' },
    { name: 'a whitespace-only label', value: ' \n ' },
  ])('composes no sentence for $name', ({ value }) => {
    expect(unavailableSignalMessage(value, reason, enabled)).toBeUndefined();
  });

  it('stays within its bound and the transport schema, cutting an overflowing list after a whole entry', () => {
    const many = Array.from(
      { length: 400 },
      (_, index) => `Sample signal ${String(index).padStart(3, '0')}`,
    );
    const longReason = 'r'.repeat(2000);

    const message = unavailableSignalMessage(label, longReason, many) ?? '';

    expect(Array.from(message).length).toBeLessThanOrEqual(MESSAGE_BOUND);
    expect(message.startsWith(`${OPENING}${label}: `)).toBe(true);
    expect(message.endsWith(' more.')).toBe(true);
    const listed = continuationOf(message).split(', ');
    const omission = listed.at(-1) ?? '';
    const shown = listed.slice(0, -1);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(many.slice(0, shown.length));
    expect(omission).toBe(`+${String(many.length - shown.length)} more`);
    expect(
      parseSessionProgressPayload({
        sessionId: newSessionId(),
        stage: 'instrument',
        status: 'failed',
        message,
      }).ok,
    ).toBe(true);
    expect(unavailableSignalMessage(label, longReason, many), 'deterministic').toBe(message);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The ✗ rows of the instrumentation stage
 * ---------------------------------------------------------------------------------------------- */

describe('buildInstrumentationRows — ✗ rows', () => {
  const pgGap: UnavailableSignal = {
    signal: 'pg',
    reason: 'the driver hook refused to attach',
    hint: 'Restart the sample dev server with the preload attached',
  };
  const errorsGap: UnavailableSignal = {
    signal: 'errors',
    reason: 'the page error listener was withheld',
    hint: 'Reload the sample page once',
  };

  it('reports each unavailable signal as one terminal failed row naming the ✓ labels', () => {
    const signals: readonly CaptureSignal[] = ['react', 'fetch', 'http', 'interactions'];
    const rows = buildInstrumentationRows({ signals, unavailable: [pgGap, errorsGap] });
    const checked = labelsInRowOrder(signals);

    expect(checkedLabels(rows)).toEqual(checked);
    expect(failedRowsOf(rows)).toStrictEqual([
      {
        stage: 'instrument',
        status: 'failed',
        message: unavailableSignalMessage(CAPTURE_SIGNAL_LABELS.pg, pgGap.reason, checked),
        detail: pgGap.hint,
      },
      {
        stage: 'instrument',
        status: 'failed',
        message: unavailableSignalMessage(CAPTURE_SIGNAL_LABELS.errors, errorsGap.reason, checked),
        detail: errorsGap.hint,
      },
    ]);
    for (const row of failedRowsOf(rows)) {
      expect(continuationOf(row.message)).toBe(checked.join(', '));
    }
    expect(rows.some((row) => row.status === 'running')).toBe(false);
  });

  it('continues with no confirmed signal when nothing was enabled', () => {
    const rows = buildInstrumentationRows({ unavailable: [pgGap] });

    expect(checkedLabels(rows)).toEqual([]);
    expect(rows).toStrictEqual([
      {
        stage: 'instrument',
        status: 'failed',
        message: `${OPENING}${CAPTURE_SIGNAL_LABELS.pg}: ${pgGap.reason}.${CONNECTIVE}${NOTHING_CONFIRMED}.`,
        detail: pgGap.hint,
      },
    ]);
  });

  it('leaves a shared label out of its own ✗ row while another signal keeps its ✓', () => {
    // `prisma` and `pg` share "Database tracing": one is still armed.
    const signals: readonly CaptureSignal[] = ['react', 'prisma', 'pg'];
    const rows = buildInstrumentationRows({ signals, unavailable: [pgGap] });

    expect(checkedLabels(rows)).toEqual(labelsInRowOrder(['react', 'prisma']));
    const [failed] = failedRowsOf(rows);
    expect(failed?.message.startsWith(`${OPENING}${CAPTURE_SIGNAL_LABELS.pg}: `)).toBe(true);
    expect(continuationOf(failed?.message ?? '')).toBe(CAPTURE_SIGNAL_LABELS.react);
  });

  it('words a readiness-only unavailable signal with the same sentence', () => {
    const signals: readonly CaptureSignal[] = ['react', 'fetch'];
    const readiness = buildReadiness({
      signals: [
        { signal: 'react', status: 'available' },
        {
          signal: 'fetch',
          status: 'unavailable',
          reason: 'no page agent reported for the bound tab',
          hint: 'Reload the sample page once',
        },
      ],
      now: () => 0,
    });

    const rows = buildInstrumentationRows({ signals, readiness });

    expect(checkedLabels(rows)).toEqual([CAPTURE_SIGNAL_LABELS.react]);
    expect(failedRowsOf(rows)).toStrictEqual([
      {
        stage: 'instrument',
        status: 'failed',
        message: `${OPENING}${CAPTURE_SIGNAL_LABELS.fetch}: no page agent reported for the bound tab.${CONNECTIVE}${CAPTURE_SIGNAL_LABELS.react}.`,
        detail: 'Reload the sample page once',
      },
    ]);
  });

  it('never builds a running row, for any single unavailable signal', () => {
    for (const signal of CAPTURE_SIGNALS) {
      const rows = buildInstrumentationRows({
        signals: CAPTURE_SIGNALS,
        unavailable: [{ ...pgGap, signal }],
      });
      const failed = failedRowsOf(rows);

      expect(
        rows.some((row) => row.status === 'running'),
        signal,
      ).toBe(false);
      expect(failed, signal).toHaveLength(1);
      expect(continuationOf(failed[0]?.message ?? '').split(', '), signal).not.toContain(
        CAPTURE_SIGNAL_LABELS[signal],
      );
    }
  });
});
