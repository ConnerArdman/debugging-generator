/**
 * The shape of a Chrome pairing code, and the pure check that tells a typed
 * value apart from one the local service can accept.
 *
 * ## Why the shape is known here
 *
 * The VS Code command "Debug Generator: Pair Chrome DevTools Panel"
 * (`debuggen.pairChrome`) asks the local service for a one-time code, and the
 * developer retypes it into the DevTools panel's `PairDialog`. The service
 * issues exactly {@link PAIRING_CODE_LENGTH} characters of
 * {@link PAIRING_CODE_ALPHABET} (AAP §0.5.6), and before judging a presented
 * code it trims it and upper-cases it. A code that cannot have that shape can
 * never be redeemed, and sending one anyway costs one of the five attempts the
 * service's rate limit allows before it locks the extension out for a minute.
 * So the panel refuses such a code before it leaves the document and tells the
 * developer what is wrong with it.
 *
 * The two constants mirror `PAIRING_CODE_LENGTH` and `PAIRING_CODE_ALPHABET` of
 * `apps/local-service/src/server/auth.ts`, which generates the codes. They are
 * restated rather than imported because this workspace may import only the
 * browser-safe `@debuggen/*` packages (AAP §0.2.2) and never service internals;
 * `test/pairing-code.test.ts` pins the values, so a change to the generator
 * that is not mirrored here fails a suite instead of silently refusing valid
 * codes.
 *
 * ## What this check is not
 *
 * It is a pre-flight filter, never the authority. Whether a well-formed code is
 * genuine, unexpired, unused and presented from an origin that is not locked
 * out is decided by the service alone; a code that passes here is still
 * redeemed through the service worker (`background/auth.ts`, which keeps its
 * own length check at the port boundary) and `POST /pair/complete`, and any
 * refusal they return is shown as it is.
 *
 * ## Privacy
 *
 * The code is a capability. No message produced here quotes the code or any
 * character of it — only its length — so a validation message can be rendered,
 * announced or logged without disclosing the value (AAP §0.5.2).
 *
 * ## Environment
 *
 * Pure: no `chrome.*` API, no DOM, no timer and no state, so the panel, the
 * service worker and the unit suites can all import it.
 *
 * @example
 * ```ts
 * const check = checkPairingCode('  abcd2345 ');
 * if (check.valid) {
 *   await submitCode(check.code); // 'ABCD2345'
 * } else {
 *   showFieldError(check.message); // never contains the code
 * }
 * ```
 *
 * @module apps/chrome-extension/src/shared/pairing-code
 */

/** How many characters a pairing code has once normalised (AAP §0.5.6). */
export const PAIRING_CODE_LENGTH = 8;

/**
 * The characters a normalised pairing code is drawn from: upper-case Latin
 * letters and digits without the look-alikes `0`/`O` and `1`/`I`. Lower-case
 * input is accepted because normalisation upper-cases it, exactly as the
 * service does.
 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Why a typed value is not a pairing code, in the order the check tests them:
 *
 * - `empty` — nothing but whitespace was typed;
 * - `characters` — a character outside {@link PAIRING_CODE_ALPHABET} remains
 *   after normalisation (a separator, an inner space, `0`, `O`, `1`, `I`, a
 *   symbol). Tested before the length, because a stray separator is what
 *   usually makes the length wrong, and "remove the dash" is the correction the
 *   developer can act on;
 * - `length` — only allowed characters, but not {@link PAIRING_CODE_LENGTH}
 *   of them.
 */
export type PairingCodeProblem = 'empty' | 'characters' | 'length';

/** A value that is a well-formed pairing code. */
export interface ValidPairingCode {
  readonly valid: true;
  /** The normalised code — trimmed and upper-cased — which is what is submitted. */
  readonly code: string;
}

/** A value that cannot be a pairing code, and what to tell the developer. */
export interface InvalidPairingCode {
  readonly valid: false;
  /** Which rule the value breaks; see {@link PairingCodeProblem}. */
  readonly problem: PairingCodeProblem;
  /** One developer-facing sentence naming the rule. It never quotes the value. */
  readonly message: string;
  /**
   * How many UTF-16 code units the normalised value has — the measure the
   * service's own length rule applies — so a caller can tell a value that is
   * still being typed (`receivedLength < PAIRING_CODE_LENGTH`) from one that is
   * already too long.
   */
  readonly receivedLength: number;
}

/** The outcome of {@link checkPairingCode}, discriminated on `valid`. */
export type PairingCodeCheck = ValidPairingCode | InvalidPairingCode;

/**
 * The message for an empty value: where a code comes from, with the palette
 * title of the command that issues one.
 */
const EMPTY_MESSAGE =
  'Enter the pairing code shown in VS Code. Run "Debug Generator: Pair Chrome DevTools Panel" there to get one.';

/**
 * The message for a disallowed character: the alphabet described in words. It
 * must be updated with {@link PAIRING_CODE_ALPHABET}; the unit suite checks
 * that every excluded look-alike it names is indeed outside the alphabet.
 */
const CHARACTERS_MESSAGE =
  'A pairing code contains only the digits 2–9 and letters other than I and O, with no spaces or symbols.';

/**
 * The message for a wrong length, worded exactly as the service worker's own
 * refusal (`background/auth.ts`), so the developer reads one sentence for one
 * mistake wherever it is caught.
 *
 * @param receivedLength The normalised value's length.
 * @returns The sentence.
 */
function lengthMessage(receivedLength: number): string {
  return `A pairing code has ${String(PAIRING_CODE_LENGTH)} characters; the code entered has ${String(receivedLength)}.`;
}

/**
 * Normalise a typed value the way the service does before it judges a code:
 * surrounding whitespace removed, letters upper-cased. Inner characters are
 * never removed or rewritten — the service does not do that either, so a
 * value it would refuse is never made to look acceptable here.
 *
 * @param input The value as typed.
 * @returns The trimmed, upper-cased value.
 */
export function normalizePairingCode(input: string): string {
  return input.trim().toUpperCase();
}

/**
 * Whether every character of a normalised value is in
 * {@link PAIRING_CODE_ALPHABET}. Iterates by code point, so a character
 * outside the Basic Multilingual Plane is one disallowed character rather than
 * two halves.
 */
function usesOnlyAlphabet(normalized: string): boolean {
  for (const character of normalized) {
    if (!PAIRING_CODE_ALPHABET.includes(character)) {
      return false;
    }
  }
  return true;
}

/**
 * Check a typed value against the pairing-code shape.
 *
 * The value is normalised with {@link normalizePairingCode} first, then tested
 * for emptiness, for disallowed characters and for its length, in that order;
 * the first rule it breaks is the one reported.
 *
 * @param input The value as typed.
 * @returns The normalised code when well-formed, otherwise the broken rule and
 * its message.
 */
export function checkPairingCode(input: string): PairingCodeCheck {
  const normalized = normalizePairingCode(input);
  const receivedLength = normalized.length;

  if (receivedLength === 0) {
    return { valid: false, problem: 'empty', message: EMPTY_MESSAGE, receivedLength };
  }
  if (!usesOnlyAlphabet(normalized)) {
    return { valid: false, problem: 'characters', message: CHARACTERS_MESSAGE, receivedLength };
  }
  if (receivedLength !== PAIRING_CODE_LENGTH) {
    return {
      valid: false,
      problem: 'length',
      message: lengthMessage(receivedLength),
      receivedLength,
    };
  }
  return { valid: true, code: normalized };
}
