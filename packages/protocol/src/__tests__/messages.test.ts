/**
 * Tests for this package's message payload modules, in the directory
 * `packages/protocol/tsconfig.json` names for them (AAP 0.8.3).
 *
 * What is on trial here is the **wire contract**, not the schema library: every
 * assertion below is a statement about what one process may send and another
 * will accept, and each one exists because a producer and a consumer live in
 * different bundles and can only disagree at run time.
 *
 * ## The generic `error` frame, and why it is pinned this tightly
 *
 * AAP 0.4.2 specifies that payload exactly as `{ code, message, ref? }`, and
 * `../messages/error.ts` is the single definition of it (AAP 0.9.1). Two
 * properties make the shape easy to widen by accident, which is what these
 * tests stand against:
 *
 * - `DebuggenError.toPayload()` — the class every process reports failures
 *   through — returns `{ code, message, hint? }`. It is *nearly* this payload,
 *   and TypeScript's structural typing will pass an object carrying an extra
 *   property where `ErrorPayload` is expected, so the compiler does not catch a
 *   producer that forwards it verbatim. The strict parser does, at the receiving
 *   end, which is the worst place to find out. `toErrorPayload` is the
 *   sanctioned projection, and the cases below assert both halves: what it
 *   produces parses, and what it exists to replace does not.
 * - a rejection must name the offending **key** and never echo the offending
 *   **value** (AAP 0.5.2), because a rejected frame is unvalidated data from
 *   another process and this product does not put such data into an error
 *   message, a log line or a persisted session row.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError } from '@debuggen/shared';

import {
  ERROR_MESSAGE_PAYLOADS,
  errorPayloadSchema,
  parseErrorPayload,
  toErrorPayload,
} from '../messages/error.js';

/** A code from the `@debuggen/shared` vocabulary, used as a valid fixture. */
const CODE = 'MODEL_UNAVAILABLE';

describe('errorPayloadSchema — the generic error frame is exactly { code, message, ref? }', () => {
  it('accepts the two specified shapes', () => {
    expect(errorPayloadSchema.parse({ code: CODE, message: 'provider unavailable' })).toEqual({
      code: CODE,
      message: 'provider unavailable',
    });
    expect(
      errorPayloadSchema.parse({ code: CODE, message: 'provider unavailable', ref: 'msg_1' }),
    ).toEqual({ code: CODE, message: 'provider unavailable', ref: 'msg_1' });
  });

  it('refuses a fourth field, naming the key it refused', () => {
    const refused = errorPayloadSchema.safeParse({
      code: CODE,
      message: 'provider unavailable',
      hint: 'check ANTHROPIC_API_KEY',
    });

    expect(refused.success).toBe(false);
    if (refused.success) {
      return;
    }
    const issue = refused.error.issues[0];
    expect(issue?.code).toBe('unrecognized_keys');
    expect(issue).toMatchObject({ keys: ['hint'] });
  });

  it('refuses a code outside the shared vocabulary, an empty message and a blank ref', () => {
    expect(errorPayloadSchema.safeParse({ code: 'NOT_A_CODE', message: 'x' }).success).toBe(false);
    expect(errorPayloadSchema.safeParse({ code: CODE, message: '' }).success).toBe(false);
    expect(errorPayloadSchema.safeParse({ code: CODE, message: 'x', ref: '' }).success).toBe(false);
  });

  it('registers itself under the message type name AAP 0.4.2 uses', () => {
    expect(Object.keys(ERROR_MESSAGE_PAYLOADS)).toEqual(['error']);
    expect(ERROR_MESSAGE_PAYLOADS.error).toBe(errorPayloadSchema);
  });
});

describe('parseErrorPayload — a failure message never becomes a leak', () => {
  it('returns the validated payload', () => {
    const parsed = parseErrorPayload({ code: CODE, message: 'provider unavailable' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.code).toBe(CODE);
    }
  });

  it('rejects a hint-bearing frame by key name, without echoing the value', () => {
    // A distinctive sentinel rather than a credential-shaped literal: the
    // assertion needs a string that could not appear by chance, and
    // `scripts/check-secrets.mjs` refuses a tracked file that carries a
    // provider-key prefix even inside a test fixture.
    const sentinel = 'sentinel-value-9d41a0-must-not-be-echoed';
    const parsed = parseErrorPayload({ code: CODE, message: 'x', hint: sentinel });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(parsed.error.message).toContain('hint');
    expect(parsed.error.message).not.toContain(sentinel);
    expect(JSON.stringify(parsed.error.toPayload())).not.toContain(sentinel);
  });
});

describe('toErrorPayload — the one sanctioned producer path', () => {
  it('projects a DebuggenError into a payload the receiving end accepts', () => {
    const error = new DebuggenError(CODE, 'Model provider unavailable (401).', {
      hint: 'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.',
    });

    const payload = toErrorPayload(error);

    expect(Object.keys(payload)).toEqual(['code', 'message']);
    expect(errorPayloadSchema.safeParse(payload).success).toBe(true);
    // The hint is dropped from the frame, not from the process: it stays on the
    // local error for logging and for the messages that declare one.
    expect(error.hint).toBe('Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.');
  });

  it('is what a producer must use, because the class payload itself is refused', () => {
    const error = new DebuggenError(CODE, 'Model provider unavailable (401).', {
      hint: 'Check ANTHROPIC_API_KEY or switch DEBUGGEN_PROVIDER.',
    });

    // The idiom this projection replaces: structurally assignable at compile
    // time, refused at run time. Pinned so that documentation which tells a
    // producer to send `toPayload()` directly fails a test rather than a user.
    expect(errorPayloadSchema.safeParse(error.toPayload()).success).toBe(false);
    expect(errorPayloadSchema.safeParse(toErrorPayload(error)).success).toBe(true);
  });

  it('carries a supplied ref and omits the key entirely when there is none', () => {
    const error = new DebuggenError('STORE_ERROR', 'The session store could not be opened.');

    const withRef = toErrorPayload(error, 'msg_42');
    expect(withRef.ref).toBe('msg_42');
    expect(errorPayloadSchema.safeParse(withRef).success).toBe(true);

    const withoutRef = toErrorPayload(error);
    expect('ref' in withoutRef).toBe(false);
    // An absent optional stays absent across a JSON round trip, so the object a
    // consumer parses is the object the producer built.
    expect(JSON.parse(JSON.stringify(withoutRef))).toEqual(withoutRef);
  });

  it('treats an explicitly undefined ref as an absent key', () => {
    const error = new DebuggenError('STORE_ERROR', 'The session store could not be opened.');
    expect('ref' in toErrorPayload(error, undefined)).toBe(false);
  });
});
