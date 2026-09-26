/**
 * Tests for `./document-fingerprint.ts`: the only form in which a page-supplied
 * `agent.ready.documentId` may appear in a service log line (CWE-532,
 * AAP §0.5.2).
 *
 * The properties under test are the ones a log reader and a privacy review
 * rely on: a fingerprint is deterministic within the process, fixed in length
 * and alphabet, different for different ids, never contains any of the page's
 * text, and a non-string yields a fixed marker; the canonical-shape predicate
 * accepts exactly the shape the page agent mints. The log sites that use these
 * helpers are driven through their public APIs in `./readiness.test.ts` and
 * `../main.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { newId } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';

import {
  DOCUMENT_FINGERPRINT_HEX_LENGTH,
  DOCUMENT_FINGERPRINT_NONE,
  DOCUMENT_FINGERPRINT_PREFIX,
  documentLogFields,
  fingerprintDocumentId,
  isCanonicalDocumentId,
} from './document-fingerprint.js';

/**
 * A fresh id of the shape the page agent mints. `packages/telemetry/src/browser/
 * ids.ts` builds its document ids exactly as `@debuggen/shared`'s `newId` builds
 * every opaque id — the kind prefix, `_`, sixteen of `[0-9a-z]` — and does not
 * export its generator to Node consumers, so the shared generator stands in.
 */
function newDocumentId(): string {
  return newId('doc');
}

/** A forged id carrying private page data: a path, a query and a credential-shaped value. */
const FORGED_DOCUMENT_ID = '/account/PRIVATE-SENTINEL?token=xyz';

/**
 * Fragments of {@link FORGED_DOCUMENT_ID} that must never survive into a
 * fingerprint. None appears in the fixed prefix and each holds a character
 * outside `[0-9a-f]`, so none can occur in a fingerprint by chance, whatever
 * this process's key.
 */
const FORGED_FRAGMENTS = ['PRIVATE', 'SENTINEL', 'token', 'xyz', '/account', '?'];

/** Every fingerprint of a string: the prefix, then exactly sixteen lowercase hex digits. */
const FINGERPRINT_SHAPE = new RegExp(
  `^${DOCUMENT_FINGERPRINT_PREFIX}[0-9a-f]{${String(DOCUMENT_FINGERPRINT_HEX_LENGTH)}}$`,
);

describe('fingerprintDocumentId', () => {
  it('is deterministic within the process', () => {
    const id = 'doc_0123456789abcdef';

    expect(fingerprintDocumentId(id)).toBe(fingerprintDocumentId(id));
    expect(fingerprintDocumentId(FORGED_DOCUMENT_ID)).toBe(
      fingerprintDocumentId(FORGED_DOCUMENT_ID),
    );
  });

  it('has a fixed prefix, alphabet and length whatever the input', () => {
    const inputs = [
      '',
      'd',
      'doc_0123456789abcdef',
      FORGED_DOCUMENT_ID,
      'x'.repeat(64),
      'y'.repeat(100_000),
      'ünïcødé \u{1F600} \n\t\u0000',
      '\uD800',
    ];

    for (const input of inputs) {
      const fingerprint = fingerprintDocumentId(input);

      expect(fingerprint).toMatch(FINGERPRINT_SHAPE);
      expect(fingerprint).toHaveLength(
        DOCUMENT_FINGERPRINT_PREFIX.length + DOCUMENT_FINGERPRINT_HEX_LENGTH,
      );
    }
  });

  it('gives different ids different fingerprints', () => {
    const ids = [
      'doc_0123456789abcdef',
      'doc_0123456789abcdeg',
      'doc_1123456789abcdef',
      FORGED_DOCUMENT_ID,
      `${FORGED_DOCUMENT_ID} `,
      '',
      ...Array.from({ length: 200 }, () => newDocumentId()),
    ];
    const fingerprints = new Set(ids.map((id) => fingerprintDocumentId(id)));

    expect(new Set(ids).size).toBe(ids.length);
    expect(fingerprints.size).toBe(ids.length);
  });

  it('never carries any of the page’s text', () => {
    const fingerprint = fingerprintDocumentId(FORGED_DOCUMENT_ID);

    for (const fragment of FORGED_FRAGMENTS) {
      expect(fingerprint).not.toContain(fragment);
    }

    const canonical = newDocumentId();
    expect(fingerprintDocumentId(canonical)).not.toContain(canonical.slice(4));
  });

  it('is not the plain SHA-256 of the id, so a guessed value cannot be confirmed from a log', () => {
    const fingerprint = fingerprintDocumentId(FORGED_DOCUMENT_ID);
    const unkeyed = sha256Hex(FORGED_DOCUMENT_ID).slice(0, DOCUMENT_FINGERPRINT_HEX_LENGTH);

    expect(fingerprint).not.toBe(`${DOCUMENT_FINGERPRINT_PREFIX}${unkeyed}`);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a boolean', true],
    ['an object', { documentId: FORGED_DOCUMENT_ID }],
    ['an array', [FORGED_DOCUMENT_ID]],
    ['a String object', new String(FORGED_DOCUMENT_ID)],
    ['a symbol', Symbol(FORGED_DOCUMENT_ID)],
    ['a bigint', 10n],
    ['a function', (): string => FORGED_DOCUMENT_ID],
  ])('returns the fixed marker for %s', (_label, value) => {
    expect(fingerprintDocumentId(value)).toBe(DOCUMENT_FINGERPRINT_NONE);
  });

  it('never confuses the marker with a digest', () => {
    expect(DOCUMENT_FINGERPRINT_NONE).not.toMatch(FINGERPRINT_SHAPE);
    expect(fingerprintDocumentId('none')).not.toBe(DOCUMENT_FINGERPRINT_NONE);
  });
});

describe('isCanonicalDocumentId', () => {
  it('accepts every id the page agent mints', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(isCanonicalDocumentId(newDocumentId())).toBe(true);
    }
    expect(isCanonicalDocumentId('doc_0123456789abcdef')).toBe(true);
    expect(isCanonicalDocumentId('doc_zzzzzzzzzzzzzzzz')).toBe(true);
  });

  it.each([
    ['a forged id carrying page data', FORGED_DOCUMENT_ID],
    ['the empty string', ''],
    ['another kind prefix', 'prd_0123456789abcdef'],
    ['an upper-case body', 'doc_0123456789ABCDEF'],
    ['an upper-case prefix', 'DOC_0123456789abcdef'],
    ['a body one short', 'doc_0123456789abcde'],
    ['a body one long', 'doc_0123456789abcdefg'],
    ['a hyphen delimiter', 'doc-0123456789abcdef'],
    ['a punctuated body', 'doc_0123456789abcd-f'],
    ['leading whitespace', ' doc_0123456789abcdef'],
    ['a trailing newline', 'doc_0123456789abcdef\n'],
    ['a canonical id with a suffix', 'doc_0123456789abcdef?token=xyz'],
  ])('refuses %s', (_label, value) => {
    expect(isCanonicalDocumentId(value)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 1],
    ['a String object', new String('doc_0123456789abcdef')],
    ['an array', ['doc_0123456789abcdef']],
  ])('refuses %s', (_label, value) => {
    expect(isCanonicalDocumentId(value)).toBe(false);
  });

  it('answers the same on repeated calls (no stateful pattern)', () => {
    const id = newDocumentId();

    expect([1, 2, 3].map(() => isCanonicalDocumentId(id))).toEqual([true, true, true]);
  });
});

describe('documentLogFields', () => {
  it('describes a canonical id by fingerprint and shape', () => {
    const id = newDocumentId();

    expect(documentLogFields(id)).toEqual({
      document: fingerprintDocumentId(id),
      documentIdCanonical: true,
    });
  });

  it('describes a forged id without any of its text', () => {
    const fields = documentLogFields(FORGED_DOCUMENT_ID);
    const serialized = JSON.stringify(fields);

    expect(fields).toEqual({
      document: fingerprintDocumentId(FORGED_DOCUMENT_ID),
      documentIdCanonical: false,
    });
    expect(Object.keys(fields)).not.toContain('documentId');
    for (const fragment of FORGED_FRAGMENTS) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it('yields no fields when no document is known', () => {
    expect(documentLogFields(undefined)).toEqual({});
    expect(Object.keys(documentLogFields(undefined))).toEqual([]);
  });

  it('describes a non-string value with the marker', () => {
    expect(documentLogFields(null)).toEqual({
      document: DOCUMENT_FINGERPRINT_NONE,
      documentIdCanonical: false,
    });
  });
});
