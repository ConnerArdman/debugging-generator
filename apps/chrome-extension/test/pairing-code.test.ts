/**
 * Unit spec for `../src/shared/pairing-code.ts` — the pre-flight check the
 * DevTools panel's `PairDialog` runs before a pairing code may leave the
 * document.
 *
 * What this suite protects:
 *
 *   - the mirrored contract: the length and the alphabet equal the values the
 *     local service generates codes from (`apps/local-service/src/server/auth.ts`,
 *     AAP §0.5.6), pinned as literals because this workspace may not import the
 *     service;
 *   - the service's normalisation: surrounding whitespace trimmed, letters
 *     upper-cased, nothing inside the value removed or rewritten;
 *   - the three refusals and their order (empty → characters → length), with
 *     the length sentence worded exactly as the service worker's own refusal;
 *   - privacy (AAP §0.5.2): no message quotes the value or any of its
 *     characters.
 *
 * Harness: collected by the root `vitest.config.ts` into the `chrome-extension`
 * project; the module is pure, so no DOM or `chrome.*` fake is involved. The
 * Vitest API is imported explicitly, as in every suite of this repository.
 * Every code here is synthetic.
 */
import { describe, expect, it } from 'vitest';

import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  checkPairingCode,
  normalizePairingCode,
} from '../src/shared/pairing-code';
import type { PairingCodeCheck, PairingCodeProblem } from '../src/shared/pairing-code';

/** A synthetic well-formed code, drawn from the alphabet. */
const WELL_FORMED = 'ABCD2345';

/** The look-alikes the alphabet leaves out. */
const EXCLUDED_LOOK_ALIKES = ['0', 'O', '1', 'I'] as const;

/** The refusal of `check`, failing the test when the value was accepted. */
function expectRefused(check: PairingCodeCheck, problem: PairingCodeProblem): string {
  if (check.valid) {
    throw new Error(`expected a "${problem}" refusal, got a valid code`);
  }
  expect(check.problem).toBe(problem);
  return check.message;
}

describe('pairing-code — the mirrored service contract', () => {
  it('has the length and the 32-symbol alphabet the service generates codes from', () => {
    expect(PAIRING_CODE_LENGTH).toBe(8);
    expect(PAIRING_CODE_ALPHABET).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(32);
  });

  it('leaves out the look-alikes 0, O, 1 and I that its message names', () => {
    for (const character of EXCLUDED_LOOK_ALIKES) {
      expect(PAIRING_CODE_ALPHABET.includes(character)).toBe(false);
    }
  });

  it('accepts every symbol of the alphabet, in upper and lower case', () => {
    for (let start = 0; start < PAIRING_CODE_ALPHABET.length; start += PAIRING_CODE_LENGTH) {
      const chunk = PAIRING_CODE_ALPHABET.slice(start, start + PAIRING_CODE_LENGTH);
      expect(checkPairingCode(chunk)).toEqual({ valid: true, code: chunk });
      expect(checkPairingCode(chunk.toLowerCase())).toEqual({ valid: true, code: chunk });
    }
  });
});

describe('pairing-code — normalisation', () => {
  it('trims surrounding whitespace and upper-cases letters', () => {
    expect(normalizePairingCode('  abcd2345\t\n')).toBe('ABCD2345');
  });

  it('never removes or rewrites an inner character', () => {
    expect(normalizePairingCode(' ab-cd 23 ')).toBe('AB-CD 23');
  });
});

describe('pairing-code — well-formed values', () => {
  it.each([
    ['upper case', 'ABCD2345'],
    ['lower case', 'abcd2345'],
    ['mixed case', 'aBcD2345'],
    ['whitespace padded', ' \tabcd2345  \n'],
  ])('accepts a %s code and returns it normalised', (_label, input) => {
    expect(checkPairingCode(input)).toEqual({ valid: true, code: WELL_FORMED });
  });
});

describe('pairing-code — refusals', () => {
  it.each([
    ['nothing', ''],
    ['only whitespace', ' \t\n '],
  ])('refuses %s as empty and names the VS Code command', (_label, input) => {
    const check = checkPairingCode(input);
    const message = expectRefused(check, 'empty');
    expect(message).toContain('Debug Generator: Pair Chrome DevTools Panel');
    expect(check).toMatchObject({ receivedLength: 0 });
  });

  it.each([
    [7, 'ABCD234'],
    [9, 'ABCD23456'],
    [1, 'A'],
    [16, 'ABCD2345ABCD2345'],
  ])('refuses %i allowed characters as the wrong length', (length, input) => {
    const check = checkPairingCode(input);
    const message = expectRefused(check, 'length');
    expect(message).toBe(
      `A pairing code has 8 characters; the code entered has ${String(length)}.`,
    );
    expect(check).toMatchObject({ receivedLength: length });
  });

  it('measures the length after trimming, as the service does', () => {
    const check = checkPairingCode('  ABCD234  ');
    expect(expectRefused(check, 'length')).toContain('the code entered has 7.');
  });

  it.each([
    ['the digit 0', 'ABCD2340'],
    ['the letter O', 'ABCD234O'],
    ['the digit 1', 'ABCD2341'],
    ['the letter I', 'ABCD234I'],
    ['a lower-case o', 'abcd234o'],
    ['a lower-case i', 'abcd234i'],
    ['a dash', 'ABCD-234'],
    ['an inner space', 'ABCD 234'],
    ['a symbol', 'ABCD234#'],
    ['a non-Latin letter', 'ABCD234Ж'],
    ['a character outside the BMP', 'ABCD234\u{1F600}'],
  ])('refuses %s as a disallowed character', (_label, input) => {
    const message = expectRefused(checkPairingCode(input), 'characters');
    expect(message).toContain('2–9');
    expect(message).toContain('I and O');
  });

  it('reports a disallowed character before a wrong length', () => {
    // A separator is what usually makes the length wrong, so it is what the
    // developer is told to fix first.
    expectRefused(checkPairingCode('ABCD-2345'), 'characters');
    expectRefused(checkPairingCode('AB-'), 'characters');
  });

  it('never quotes the value or any of its characters', () => {
    const inputs = ['QWXZ', 'QWXZ-9', 'qwxz0000', 'QWXZQWXZQWXZ'];
    for (const input of inputs) {
      const check = checkPairingCode(input);
      if (check.valid) {
        throw new Error('expected every probe to be refused');
      }
      expect(check.message).not.toContain(input);
      expect(check.message).not.toContain(normalizePairingCode(input));
      expect(check.message).not.toMatch(/[QWXZ]/);
    }
  });
});
