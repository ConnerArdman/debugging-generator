/**
 * `utils/color` — the shared status, outcome and render-trigger decisions.
 *
 * Every view that prints an HTTP status, an operation's outcome or a render's
 * trigger asks `./color` rather than keeping a table of its own, so these
 * cases are the contract the request table, the waterfall, the timeline, the
 * render table and the component tree all draw against:
 *
 *   - **HTTP status classes** — half-open code ranges, and one tone and one
 *     token per class, so a 301 is informational, a 404 a warning and a 500 a
 *     failure in every view.
 *   - **Outcome reconciliation** — a span status and a response code that
 *     disagree resolve to one outcome, so a failed call never reads as green.
 *   - **Render triggers** — three distinct hues for the three inputs, an idle
 *     chip for an empty bucket, and the dashed hairline for `unknown` in both
 *     views.
 *   - **Legibility** — each trigger hue and each status token is text, so it is
 *     measured against the 4.5:1 WCAG AA text minimum on every surface of all
 *     three themes, with `var()` aliases resolved within the theme.
 */

import { describe, expect, it } from 'vitest';

import type { RenderTrigger, TelemetryStatus } from '@debuggen/telemetry';

import { cssVar, DESIGN_TOKENS, type TokenKey } from '../tokens/tokens';
import {
  HTTP_STATUS_CLASS_TOKEN_KEYS,
  HTTP_STATUS_CLASS_TONES,
  HTTP_STATUS_CLASSES,
  RENDER_TRIGGER_TOKEN_KEYS,
  STATUS_TONES,
  WCAG_AA_TEXT_CONTRAST,
  contrastRatio,
  httpStatusClass,
  httpStatusColorVar,
  httpStatusTokenKey,
  httpStatusTone,
  isFailureOutcome,
  isHttpFailureStatus,
  outcomeClass,
  outcomeColorVar,
  outcomeTone,
  renderTriggerAppearance,
  statusTone,
} from './color';

/** The three surfaces text is drawn on, darkest first in the dark theme. */
const TEXT_SURFACES: readonly TokenKey[] = ['surfaceBase', 'surfaceElevated', 'surfaceOverlay'];

/** Every render trigger, in the render table's display order. */
const TRIGGERS: readonly RenderTrigger[] = ['props', 'state', 'context', 'unchanged', 'unknown'];

/** Every span status. */
const STATUSES: readonly TelemetryStatus[] = ['unset', 'ok', 'error'];

/** A `var(--dg-*)` reference, the only alias form the token table uses. */
const VAR_REFERENCE = /^var\(--dg-([a-z0-9-]+)\)$/u;

/**
 * The concrete hex value `key` has in `theme`, following `var()` aliases
 * within the same theme.
 */
function resolveHex(theme: keyof typeof DESIGN_TOKENS, key: TokenKey): string {
  const values = DESIGN_TOKENS[theme];
  const byCssName = new Map<string, TokenKey>(
    (Object.keys(values) as TokenKey[]).map((name) => [cssVar(name), name]),
  );
  let current: TokenKey = key;
  for (let hops = 0; hops < 8; hops += 1) {
    const value = values[current];
    if (!VAR_REFERENCE.test(value)) {
      return value;
    }
    const next = byCssName.get(value);
    if (next === undefined) {
      throw new Error(`token ${current} in ${theme} aliases an unknown property: ${value}`);
    }
    current = next;
  }
  throw new Error(`token ${key} in ${theme} does not resolve to a value`);
}

describe('httpStatusClass', () => {
  it('classifies codes on half-open class floors', () => {
    expect(httpStatusClass(100)).toBe('informational');
    expect(httpStatusClass(199)).toBe('informational');
    expect(httpStatusClass(200)).toBe('success');
    expect(httpStatusClass(299)).toBe('success');
    expect(httpStatusClass(300)).toBe('redirect');
    expect(httpStatusClass(301)).toBe('redirect');
    expect(httpStatusClass(399)).toBe('redirect');
    expect(httpStatusClass(400)).toBe('client-error');
    expect(httpStatusClass(404)).toBe('client-error');
    expect(httpStatusClass(499)).toBe('client-error');
    expect(httpStatusClass(500)).toBe('server-error');
    expect(httpStatusClass(599)).toBe('server-error');
  });

  it('calls anything that is not a code a server sent unknown', () => {
    for (const value of [undefined, 0, 99, 600, 999, -1, 200.5, Number.NaN, Infinity]) {
      expect(httpStatusClass(value), String(value)).toBe('unknown');
    }
  });

  it('lists every class it can return', () => {
    const returned = new Set(
      [undefined, 100, 200, 300, 400, 500].map((value) => httpStatusClass(value)),
    );
    expect([...returned].sort()).toEqual([...HTTP_STATUS_CLASSES].sort());
  });
});

describe('HTTP status tone and token', () => {
  it('draws one code the same way in every view', () => {
    expect(httpStatusTone(200)).toBe('success');
    expect(httpStatusTone(301)).toBe('info');
    expect(httpStatusTone(404)).toBe('warning');
    expect(httpStatusTone(500)).toBe('danger');
    expect(httpStatusTone(101)).toBe('neutral');
    expect(httpStatusTone(undefined)).toBe('neutral');

    expect(httpStatusTokenKey(200)).toBe('success');
    expect(httpStatusTokenKey(301)).toBe('info');
    expect(httpStatusTokenKey(404)).toBe('warning');
    expect(httpStatusTokenKey(503)).toBe('danger');
    expect(httpStatusTokenKey(undefined)).toBe('textMuted');
    expect(httpStatusColorVar(500)).toBe(cssVar('danger'));
  });

  it('pairs each class tone with the token of the same meaning', () => {
    for (const statusClass of HTTP_STATUS_CLASSES) {
      const tone = HTTP_STATUS_CLASS_TONES[statusClass];
      const token = HTTP_STATUS_CLASS_TOKEN_KEYS[statusClass];
      if (tone === 'neutral') {
        expect(token, statusClass).toBe('textMuted');
      } else {
        expect(token, statusClass).toBe(tone);
      }
    }
  });

  it('counts client and server errors, and nothing else, as failures', () => {
    expect(isHttpFailureStatus(404)).toBe(true);
    expect(isHttpFailureStatus(500)).toBe(true);
    expect(isHttpFailureStatus(200)).toBe(false);
    expect(isHttpFailureStatus(301)).toBe(false);
    expect(isHttpFailureStatus(undefined)).toBe(false);
  });
});

describe('statusTone', () => {
  it('maps every span status onto one tone', () => {
    expect(STATUSES.map((status) => statusTone(status))).toEqual(['neutral', 'success', 'danger']);
    expect(statusTone('ok')).toBe(STATUS_TONES.ok);
  });

  it('falls back to neutral for a status this build does not know', () => {
    expect(statusTone('retrying' as TelemetryStatus)).toBe('neutral');
  });
});

describe('outcomeClass', () => {
  it('lets a failing code win over a span that reported success', () => {
    expect(outcomeClass('ok', 500)).toBe('server-error');
    expect(outcomeClass('ok', 404)).toBe('client-error');
    expect(outcomeClass('error', 404)).toBe('client-error');
    expect(outcomeTone('ok', 500)).toBe('danger');
  });

  it('reads a failed call with no code, or a non-failing code, as a failure', () => {
    expect(outcomeClass('error', undefined)).toBe('server-error');
    expect(outcomeClass('error', 200)).toBe('server-error');
    expect(isFailureOutcome('error')).toBe(true);
    expect(outcomeColorVar('error')).toBe(cssVar('danger'));
  });

  it('keeps successes, redirects and no-claim spans as they are', () => {
    expect(outcomeClass('ok', 200)).toBe('success');
    expect(outcomeClass('ok', 301)).toBe('redirect');
    expect(outcomeClass('unset', 204)).toBe('success');
    expect(outcomeClass('ok')).toBe('success');
    expect(outcomeClass('unset')).toBe('unknown');
    expect(isFailureOutcome('ok', 301)).toBe(false);
    expect(outcomeTone('unset')).toBe('neutral');
  });
});

describe('renderTriggerAppearance', () => {
  it('gives the three input triggers three distinct hues', () => {
    const hues = (['props', 'state', 'context'] as const).map(
      (trigger) => renderTriggerAppearance(trigger, 3).tokenKey,
    );
    expect(new Set(hues).size).toBe(3);
    expect(hues).toEqual([
      RENDER_TRIGGER_TOKEN_KEYS.props,
      RENDER_TRIGGER_TOKEN_KEYS.state,
      RENDER_TRIGGER_TOKEN_KEYS.context,
    ]);
    for (const hue of hues) {
      expect(hue).not.toBe(RENDER_TRIGGER_TOKEN_KEYS.unchanged);
      expect(hue).not.toBe(RENDER_TRIGGER_TOKEN_KEYS.unknown);
    }
  });

  it('draws a populated unchanged bucket in the warning colour and an empty one idle', () => {
    const populated = renderTriggerAppearance('unchanged', 12);
    expect(populated).toMatchObject({ tone: 'warning', tokenKey: 'warning', idle: false });

    const empty = renderTriggerAppearance('unchanged', 0);
    expect(empty).toMatchObject({ tone: 'neutral', tokenKey: 'textMuted', idle: true });
    expect(empty.colorVar).toBe(cssVar('textMuted'));
  });

  it('draws every empty bucket idle, whatever its trigger', () => {
    for (const trigger of TRIGGERS) {
      expect(renderTriggerAppearance(trigger, 0), trigger).toMatchObject({
        tone: 'neutral',
        tokenKey: 'textMuted',
        idle: true,
      });
    }
  });

  it('never draws a single render or a non-count as idle', () => {
    expect(renderTriggerAppearance('context').idle).toBe(false);
    expect(renderTriggerAppearance('context', Number.NaN).idle).toBe(false);
    expect(renderTriggerAppearance('props', 1).tokenKey).toBe(RENDER_TRIGGER_TOKEN_KEYS.props);
  });

  it('dashes unknown — and only unknown — at every count', () => {
    for (const trigger of TRIGGERS) {
      for (const count of [undefined, 0, 4]) {
        expect(renderTriggerAppearance(trigger, count).dashed, `${trigger} ${String(count)}`).toBe(
          trigger === 'unknown',
        );
      }
    }
  });

  it('treats a trigger this build does not know as an unclassified, dashed claim', () => {
    const appearance = renderTriggerAppearance('reordered' as RenderTrigger, 2);
    expect(appearance).toMatchObject({ tone: 'neutral', tokenKey: 'textMuted', dashed: true });
  });
});

describe('legibility of the text colours this module chooses', () => {
  const textTokens = new Set<TokenKey>([
    ...Object.values(RENDER_TRIGGER_TOKEN_KEYS),
    ...Object.values(HTTP_STATUS_CLASS_TOKEN_KEYS),
  ]);

  for (const theme of Object.keys(DESIGN_TOKENS) as (keyof typeof DESIGN_TOKENS)[]) {
    it(`clears ${String(WCAG_AA_TEXT_CONTRAST)}:1 on every surface in the ${theme} theme`, () => {
      for (const token of textTokens) {
        const ink = resolveHex(theme, token);
        for (const surface of TEXT_SURFACES) {
          const ratio = contrastRatio(ink, resolveHex(theme, surface));
          expect(
            ratio,
            `${token} (${ink}) on ${surface} in ${theme}: ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
        }
      }
    });
  }
});
