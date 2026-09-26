/**
 * Unit spec for Section G′ of `../src/shared/messages.ts` — what the
 * extension may believe, log and show about frames from the page agent.
 *
 * Every page-agent frame is built in the page's own realm, so a page script can
 * shape any field of it. This spec pins the three rules every surface relies on
 * (CWE-532, AAP §0.5.2):
 *
 * - **One identifier shape.** Document, producer, capture and session ids are
 *   the repository's opaque id (`/^[a-z]{3}_[0-9a-z]{16}$/` with the right
 *   kind prefix); anything else is refused.
 * - **Fingerprints, never raw ids, in logs.** `fingerprintPageId` is total,
 *   deterministic, fixed-length and contains none of its input.
 * - **A closed diagnostic vocabulary with fixed copy.** `pageAgentErrorKind`
 *   recognises exactly the codes and loss reasons the agent emits, and every
 *   recognised kind has a sentence that carries nothing from the frame.
 *
 * Pure module, no environment: the identifiers below are invented for this spec
 * (AAP §0.5.4), and the private sentinel strings stand for page-chosen content
 * that must never surface.
 */

import { describe, expect, it } from 'vitest';

import {
  PAGE_AGENT_ERROR_CODES,
  PAGE_AGENT_ERROR_PUBLIC_MESSAGES,
  PAGE_AGENT_LOSS_REASONS,
  PAGE_ID_FINGERPRINT_NONE,
  fingerprintPageId,
  isPageAgentErrorCode,
  isPageAgentLossReason,
  isPageCaptureId,
  isPageDocumentId,
  isPageProducerId,
  isPageSessionId,
  pageAgentErrorKind,
} from '../src/shared/messages';

const DOCUMENT_ID = 'doc_0123456789abcdef';
const PRODUCER_ID = 'prd_0123456789abcdef';
const CAPTURE_ID = 'cap_0123456789abcdef';
const SESSION_ID = 'ses_0123456789abcdef';

/** Page-chosen content that must never be logged or shown. */
const PRIVATE_SENTINEL = 'PRIVATE-SENTINEL-4f1c user@example.test Bearer abc.def.ghi';

describe('page identifier shapes', () => {
  it.each([
    ['document', isPageDocumentId, DOCUMENT_ID],
    ['producer', isPageProducerId, PRODUCER_ID],
    ['capture', isPageCaptureId, CAPTURE_ID],
    ['session', isPageSessionId, SESSION_ID],
  ] as const)('accepts a canonical %s id', (_kind, predicate, id) => {
    expect(predicate(id)).toBe(true);
  });

  it.each([
    ['another kind prefix', PRODUCER_ID.replace('prd', 'doc'), isPageProducerId],
    ['a short body', 'doc_0123456789abcde', isPageDocumentId],
    ['a long body', 'doc_0123456789abcdef0', isPageDocumentId],
    ['an uppercase letter', 'doc_0123456789ABCdef', isPageDocumentId],
    ['a newline suffix', `${DOCUMENT_ID}\n`, isPageDocumentId],
    ['an embedded log line', `${DOCUMENT_ID} level=info forged`, isPageDocumentId],
    ['free text', PRIVATE_SENTINEL, isPageDocumentId],
    ['an empty string', '', isPageCaptureId],
    ['a number', 42, isPageSessionId],
    ['undefined', undefined, isPageDocumentId],
  ] as const)('refuses %s', (_label, value, predicate) => {
    expect(predicate(value)).toBe(false);
  });

  it('keeps the kinds apart: each predicate accepts only its own prefix', () => {
    const ids = [DOCUMENT_ID, PRODUCER_ID, CAPTURE_ID, SESSION_ID];
    expect(ids.filter(isPageDocumentId)).toEqual([DOCUMENT_ID]);
    expect(ids.filter(isPageProducerId)).toEqual([PRODUCER_ID]);
    expect(ids.filter(isPageCaptureId)).toEqual([CAPTURE_ID]);
    expect(ids.filter(isPageSessionId)).toEqual([SESSION_ID]);
  });
});

describe('fingerprintPageId', () => {
  it('is deterministic, fixed-length and distinct for distinct ids', () => {
    const first = fingerprintPageId(DOCUMENT_ID);
    expect(first).toMatch(/^fp_[0-9a-f]{8}$/);
    expect(fingerprintPageId(DOCUMENT_ID)).toBe(first);
    expect(fingerprintPageId('doc_fedcba9876543210')).not.toBe(first);
  });

  it('matches the FNV-1a 32-bit reference values', () => {
    // Published FNV-1a 32 test vectors: '' → 811c9dc5, 'a' → e40c292c.
    expect(fingerprintPageId('')).toBe('fp_811c9dc5');
    expect(fingerprintPageId('a')).toBe('fp_e40c292c');
  });

  it('never contains its input, however large or hostile', () => {
    const hostile = `${PRIVATE_SENTINEL}\n`.repeat(4096);
    const fingerprint = fingerprintPageId(hostile);
    expect(fingerprint).toMatch(/^fp_[0-9a-f]{8}$/);
    expect(fingerprint).not.toContain('PRIVATE');
  });

  it.each([undefined, null, 7, {}, ['doc']])('answers the fixed marker for %j', (value) => {
    expect(fingerprintPageId(value)).toBe(PAGE_ID_FINGERPRINT_NONE);
  });
});

describe('the agent.error vocabulary', () => {
  it('recognises every code the agent emits by its code', () => {
    for (const code of PAGE_AGENT_ERROR_CODES) {
      expect(isPageAgentErrorCode(code)).toBe(true);
      expect(pageAgentErrorKind({ code, message: PRIVATE_SENTINEL })).toBe(code);
    }
  });

  it('recognises every code-less loss by its reason', () => {
    for (const reason of PAGE_AGENT_LOSS_REASONS) {
      expect(isPageAgentLossReason(reason)).toBe(true);
      expect(pageAgentErrorKind({ reason, frame: 'agent.ready', limitBytes: 1 })).toBe(reason);
    }
  });

  it.each([
    ['an unknown code', { code: PRIVATE_SENTINEL }],
    ['an unknown code beside a known reason', { code: 'x', reason: 'event-too-large' }],
    ['a known reason in the code field', { code: 'event-too-large' }],
    ['a known code in the reason field', { reason: 'producer-failure' }],
    ['a non-string code', { code: 3 }],
    ['an empty record', {}],
    ['a string', 'hooks-unavailable'],
    ['null', null],
  ] as const)('does not recognise %s', (_label, payload) => {
    expect(pageAgentErrorKind(payload)).toBeUndefined();
  });

  it('has one fixed, non-empty sentence per recognised kind and no other', () => {
    const kinds = [...PAGE_AGENT_ERROR_CODES, ...PAGE_AGENT_LOSS_REASONS];
    expect(Object.keys(PAGE_AGENT_ERROR_PUBLIC_MESSAGES).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      const sentence = PAGE_AGENT_ERROR_PUBLIC_MESSAGES[kind];
      expect(sentence.length).toBeGreaterThan(0);
      // The protocol's error message ceiling is far above this; a sentence is short.
      expect(sentence.length).toBeLessThanOrEqual(200);
    }
  });
});
