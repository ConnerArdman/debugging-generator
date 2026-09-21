/**
 * `db.statement` redaction and normalisation — the SQL handler of the
 * telemetry privacy boundary.
 *
 * A captured database span carries the statement text that produced it. That
 * text is at once the most useful evidence a query panel can show and the
 * most likely place for a customer's data to leave the machine, because a
 * statement assembled with interpolated values carries those values inline.
 * This module resolves the tension the way the privacy model requires:
 *
 * - **Structure survives, data does not.** Keywords, identifiers (quoted or
 *   not), operators, punctuation, whitespace and placeholders are emitted
 *   verbatim; every literal — string, escape string, dollar-quoted body,
 *   number, hex, bit — is replaced by {@link REDACTION_MASK}. A statement
 *   stays readable and diagnosable while carrying none of its values.
 * - **Parameterised text passes through unchanged.** `$1`-style positional
 *   placeholders are structure rather than data, so `WHERE id = $1` comes
 *   back exactly as it arrived. That is the shape the instrumented database
 *   tiers already produce, and the shape the outbound model guard accepts.
 * - **Row contents never reach this module at all.** It sees statements,
 *   never result sets: the event redactor drops any attribute that would
 *   carry row or body payloads, and the only quantity retained about a result
 *   is its row count (`db.rowCount`). Nothing here can reintroduce one.
 *
 * ## Two outputs, two jobs
 *
 * {@link redactSqlStatement} produces the text stored on the event and shown
 * in the panel. {@link normalizeSqlStatement} produces the *grouping key* the
 * capture aggregates group queries by: the same statement executed with
 * different parameters has to land in one group, so the key additionally
 * unifies placeholders, collapses whitespace, drops a trailing terminator and
 * folds masked value lists. Grouping is by exact normalised text — consumers
 * compare the returned strings and normalise nothing further.
 *
 * ## Why a scanner and not a pattern
 *
 * Statement text arrives from the instrumented process unbounded and, in the
 * worst case, adversarial. A regular expression that alternates over quotes,
 * comments and dollar-quoted tags is exactly the shape that backtracks
 * catastrophically, so the implementation is a single-pass character state
 * machine: every code unit of the scanned prefix is visited a constant number
 * of times, the output is assembled from slices of the input, and the work is
 * linear in the input length with memory bounded by {@link SQL_MAX_LENGTH}.
 *
 * ## Dialect scope
 *
 * PostgreSQL is the primary dialect — dollar-quoted bodies, `$n` positional
 * placeholders, `E'…'` escape strings, nested block comments and
 * case-sensitive `"quoted identifiers"` are all handled. MySQL-flavoured
 * input is tolerated rather than fully modelled: `` `backticked` ``
 * identifiers and `?` placeholders are understood, and a backslash escape
 * inside a plain single-quoted string is honoured so that a value can never
 * be smuggled past the closing quote. Two deliberate non-behaviours:
 *
 * - `#` does not start a comment. In PostgreSQL it is an operator, and
 *   treating it as a comment would silently delete statement structure.
 * - Case is never folded. PostgreSQL quoted identifiers are case-sensitive,
 *   so lower-casing the text would merge genuinely different statements into
 *   one aggregate group.
 *
 * One consequence of reading `"…"` as an identifier is worth stating plainly:
 * a dialect configured to treat double quotes as *string* delimiters would
 * have such a value preserved rather than masked. The instrumented database
 * tiers of this product speak PostgreSQL, where that reading is the correct
 * one, and the value scrubber still runs over whatever is preserved — but a
 * future adapter for a dialect that spells strings with double quotes owes
 * this module a delimiter option rather than a silent assumption.
 *
 * Every function here is pure: no I/O, no globals, no clock, no randomness,
 * no logging and no mutable module state.
 */

import {
  MAX_SCAN_LENGTH,
  REDACTION_MARKER,
  REDACTION_MASK,
  asScannableText,
  cutAtCredentialBoundary,
  scrub,
} from './rules.js';

/**
 * Upper bound, in UTF-16 code units, on how much of a statement is scanned —
 * and therefore on the length of what these functions return.
 *
 * It is `MAX_SCAN_LENGTH`, the same window the value scrubber reads, so the
 * two halves of the redaction layer agree on how much text they will ever
 * examine. A longer statement is never returned unscanned: the examined
 * prefix is emitted and the remainder is replaced by {@link REDACTION_MARKER}
 * (see {@link redactSqlStatement}).
 */
export const SQL_MAX_LENGTH = MAX_SCAN_LENGTH;

/**
 * Result of {@link redactSqlStatementWithFindings}: the safe statement plus
 * the two counts a findings report needs.
 *
 * **No part of any replaced value appears in this object.** The counts are
 * the whole report, which is what makes it safe to log next to a statement
 * that could not itself be logged.
 */
export interface SqlRedactionFindings {
  /** The redacted statement, identical to {@link redactSqlStatement}'s result. */
  readonly statement: string;
  /**
   * How many literal spans were masked: strings, escape strings,
   * dollar-quoted bodies, numeric, hex and bit literals, and any quoted
   * construct that the input left unterminated. Counted by the scan of the
   * statement itself, so it describes the input rather than the output.
   */
  readonly literalCount: number;
  /** Whether the statement exceeded {@link SQL_MAX_LENGTH} and was cut. */
  readonly truncated: boolean;
}

/**
 * States of the statement scanner.
 *
 * `single-quoted` and `escape-string` share their transition handling — both
 * end at an undoubled `'` and both honour a backslash escape — and are kept
 * apart so that the opening `E` of an escape string is consumed as part of
 * the literal it introduces and so that a reader can tell the two constructs
 * apart in a trace of the machine.
 */
type ScannerState =
  | 'normal'
  | 'single-quoted'
  | 'escape-string'
  | 'dollar-quoted'
  | 'line-comment'
  | 'block-comment'
  | 'double-quoted-identifier'
  | 'backtick-identifier';

/**
 * What a scan is for.
 *
 * `redact` preserves the statement's layout and its positional placeholders,
 * which is what the stored and displayed text needs. `normalize` collapses
 * whitespace runs to a single space and unifies `$n` placeholders into
 * {@link REDACTION_MASK}, which is what the grouping key needs. Doing both
 * inside the scanner rather than with a pass of string replacements is what
 * keeps a `$` or a run of spaces *inside a quoted identifier* from being
 * rewritten: the scanner knows which state it is in, a replacement would not.
 */
type ScanMode = 'redact' | 'normalize';

/**
 * Longest dollar-quote tag recognised, in code units, excluding the two `$`
 * delimiters.
 *
 * PostgreSQL's own limit is the identifier length (63 bytes by default), so
 * this accepts every legal tag. The bound matters because the closing
 * delimiter is recognised by comparing the opening tag at each `$` inside the
 * body, which keeps that comparison constant-cost and the scan linear.
 */
const MAX_DOLLAR_TAG_LENGTH = 64;

/** Matches one whitespace code unit, including Unicode spaces. Non-global. */
const WHITESPACE = /\s/;

/** Regular-expression metacharacters escaped when embedding a literal. */
const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/** {@link REDACTION_MASK} escaped for use inside a pattern source. */
const MASK_SOURCE = REDACTION_MASK.replace(REGEXP_METACHARACTERS, '\\$&');

/**
 * A parenthesised list of two or more masked values, such as the
 * `IN (?, ?, ?)` produced by redacting an inlined value list.
 *
 * Folding those to `(?)` keeps the length of a value list from fragmenting
 * aggregate groups. The repetition is bounded and its separator (`,`) cannot
 * be matched by the surrounding `\s*`, so each repetition is unambiguous and
 * the pattern cannot backtrack catastrophically. Global, and therefore used
 * only with `String.prototype.replace`, which resets `lastIndex` itself.
 */
const MASKED_VALUE_LIST = new RegExp(
  '\\(' + MASK_SOURCE + '(?:\\s*,\\s*' + MASK_SOURCE + '){1,4096}\\)',
  'g',
);

/** Whether `char` is an ASCII decimal digit. */
function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

/** Whether `char` is a hexadecimal digit in either case. */
function isHexDigit(char: string): boolean {
  return isDigit(char) || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F');
}

/**
 * Whether `char` can start an unquoted identifier: an ASCII letter, an
 * underscore, or any non-ASCII code unit (PostgreSQL admits letters beyond
 * ASCII in identifiers, and emitting them verbatim is the correct handling
 * for a name).
 *
 * A read past the end of the text yields the empty string, which matches no
 * comparison here and is therefore reported — correctly — as not a name.
 */
function isIdentifierStart(char: string): boolean {
  if (char >= 'a' && char <= 'z') {
    return true;
  }
  if (char >= 'A' && char <= 'Z') {
    return true;
  }
  return char === '_' || char >= '\u0080';
}

/**
 * Whether `char` can continue an unquoted identifier.
 *
 * `$` is deliberately excluded even though PostgreSQL permits it inside an
 * identifier: a `$` is how a dollar-quoted literal opens, and an identifier
 * that swallowed it could hide the opening delimiter of a literal from the
 * scanner. Excluding it only ever splits a name into a name, a `$` and a
 * name — all three emitted verbatim — which costs nothing.
 */
function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || isDigit(char);
}

/** Whether `char` can appear in a dollar-quote tag. */
function isDollarTagPart(char: string): boolean {
  return isIdentifierPart(char);
}

/**
 * Index just past the unquoted identifier starting at `start`.
 *
 * Consuming a name whole is what keeps the numeric rule off the digits inside
 * it: after `col1` or `utf8_col` the scanner is positioned on a non-name
 * character, so a digit can only begin a literal where a name did not.
 */
function skipIdentifier(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length && isIdentifierPart(text.charAt(index))) {
    index += 1;
  }
  return index;
}

/**
 * Index just past the numeric literal starting at `start`, which is either a
 * digit or a `.` followed by a digit.
 *
 * Recognised forms: decimal integers with optional digit separators, `0x…`
 * hexadecimal, fractional (`1.5`, `1.`, `.5`) and exponent (`1e9`, `2.5E-3`)
 * notations. Any name-like tail immediately following the number — the `x` of
 * a malformed `12x`, say — is consumed into the literal as well, so a token
 * that begins where a value belongs is masked whole rather than partly
 * emitted. The caller replaces the whole span with one mask.
 */
function skipNumericLiteral(text: string, start: number): number {
  let index = start;
  const isHexPrefix =
    text.charAt(index) === '0' &&
    (text.charAt(index + 1) === 'x' || text.charAt(index + 1) === 'X');
  if (isHexPrefix) {
    index += 2;
    while (index < text.length && isHexDigit(text.charAt(index))) {
      index += 1;
    }
  } else {
    while (index < text.length && isDigit(text.charAt(index))) {
      index += 1;
    }
    if (text.charAt(index) === '.') {
      index += 1;
      while (index < text.length && isDigit(text.charAt(index))) {
        index += 1;
      }
    }
    const exponentMarker = text.charAt(index);
    if (exponentMarker === 'e' || exponentMarker === 'E') {
      let probe = index + 1;
      const sign = text.charAt(probe);
      if (sign === '+' || sign === '-') {
        probe += 1;
      }
      if (isDigit(text.charAt(probe))) {
        probe += 1;
        while (probe < text.length && isDigit(text.charAt(probe))) {
          probe += 1;
        }
        index = probe;
      }
    }
  }
  while (index < text.length && isIdentifierPart(text.charAt(index))) {
    index += 1;
  }
  return index;
}

/** A typed string literal's opening delimiter: its length and the state it opens. */
interface TypedLiteralOpener {
  /** Code units consumed by the delimiter, including the opening quote. */
  readonly length: number;
  /** State the scanner enters to consume the literal's body. */
  readonly state: ScannerState;
}

/**
 * The typed string-literal delimiter at `start`, or `null` when the character
 * there begins an ordinary identifier.
 *
 * Recognised: `E'…'` (escape string), `X'…'` and `B'…'` (hex and bit
 * literals), `N'…'` (national character string) and `U&'…'` (Unicode string),
 * in either case. The caller only asks at the start of a token — names are
 * consumed whole — so a column called `e` or `x` cannot be mistaken for a
 * delimiter unless a quote immediately follows it, which is not a name.
 */
function matchTypedLiteralOpener(text: string, start: number): TypedLiteralOpener | null {
  const char = text.charAt(start);
  const next = text.charAt(start + 1);
  if (next === "'") {
    if (char === 'e' || char === 'E') {
      return { length: 2, state: 'escape-string' };
    }
    if (
      char === 'x' ||
      char === 'X' ||
      char === 'b' ||
      char === 'B' ||
      char === 'n' ||
      char === 'N'
    ) {
      return { length: 2, state: 'single-quoted' };
    }
    return null;
  }
  if ((char === 'u' || char === 'U') && next === '&' && text.charAt(start + 2) === "'") {
    return { length: 3, state: 'single-quoted' };
  }
  return null;
}

/**
 * The dollar-quote opening delimiter at `start` (`$$` or `$tag$`), or `null`
 * when the `$` there is not one.
 *
 * A `$` followed by digits is a positional placeholder and is handled by the
 * caller before this function is asked, which is the distinction the privacy
 * contract turns on: `$1` is structure and must survive, while `$tag$` opens
 * a literal body that must not. A `$` that opens neither — a stray operator,
 * or a tag that never closes its opening delimiter — yields `null` and is
 * emitted verbatim.
 */
function matchDollarQuoteOpener(text: string, start: number): string | null {
  let index = start + 1;
  const limit = Math.min(text.length, start + 1 + MAX_DOLLAR_TAG_LENGTH);
  while (index < limit && isDollarTagPart(text.charAt(index))) {
    index += 1;
  }
  if (text.charAt(index) !== '$') {
    return null;
  }
  return text.slice(start, index + 1);
}

/**
 * Drops the statement terminator from the end of `text`: a trailing `;`, or a
 * run of them with whitespace between, along with any whitespace left behind.
 *
 * A terminated statement has to group with its unterminated twin, which is
 * the whole reason to drop the character. The *run* is dropped rather than a
 * single character because the grouping key must be a fixed point: dropping
 * one `;` from a statement that ends in two would leave a key that normalises
 * again to something shorter, and two spellings of one statement would then
 * land in two groups depending on how many times a caller normalised. Only
 * the trailing run is affected — a `;` between two statements in a batch is
 * structure and stays.
 */
function stripStatementTerminator(text: string): string {
  let end = text.length;
  while (end > 0) {
    const char = text.charAt(end - 1);
    if (char === ';' || WHITESPACE.test(char)) {
      end -= 1;
      continue;
    }
    break;
  }
  return end === text.length ? text : text.slice(0, end);
}

/** What one scan produced: the emitted text and how many masks it contains. */
interface ScanOutcome {
  /** Emitted text: never longer than the scanned input. */
  readonly text: string;
  /** Masks emitted, one per literal or unterminated quoted construct. */
  readonly maskCount: number;
}

/**
 * Scans `text` once, emitting structure verbatim and a mask per literal.
 *
 * The machine visits every code unit a constant number of times and appends
 * either a slice of the input or a one-character replacement, so the work is
 * linear in `text.length` and the emitted text is never longer than the
 * input. It is total: any string is accepted, nothing throws, and a construct
 * the input leaves open at the end of the text is closed here rather than
 * spilled — an unterminated quoted construct emits one mask, an unterminated
 * comment emits one separator, and in neither case is the partially scanned
 * text emitted.
 *
 * @param text - Statement text, already cut to {@link SQL_MAX_LENGTH}.
 * @param mode - `redact` to preserve layout and `$n` placeholders,
 * `normalize` to collapse whitespace and unify placeholders.
 */
function scanStatement(text: string, mode: ScanMode): ScanOutcome {
  const parts: string[] = [];
  let state: ScannerState = 'normal';
  let index = 0;
  let maskCount = 0;
  let quotedStart = 0;
  let dollarTag = '';
  let commentDepth = 0;

  /** Replaces the construct just scanned with one mask. */
  const emitMask = (): void => {
    parts.push(REDACTION_MASK);
    maskCount += 1;
  };

  /**
   * Emits the separator that stands in for a dropped comment and, in
   * `normalize` mode, for a whitespace run.
   *
   * A comment always becomes exactly one space: its text can hold values
   * copied in from production and it fragments grouping, while the space
   * keeps the tokens on either side of it from merging into one. In
   * `normalize` mode a leading separator is dropped and consecutive
   * separators collapse, so a comment surrounded by whitespace still costs a
   * single space in the grouping key.
   */
  const emitSeparator = (): void => {
    if (mode === 'normalize' && (parts.length === 0 || parts[parts.length - 1] === ' ')) {
      return;
    }
    parts.push(' ');
  };

  while (index < text.length) {
    const char = text.charAt(index);
    switch (state) {
      case 'normal': {
        if (WHITESPACE.test(char)) {
          if (mode === 'normalize') {
            emitSeparator();
            index += 1;
            while (index < text.length && WHITESPACE.test(text.charAt(index))) {
              index += 1;
            }
          } else {
            parts.push(char);
            index += 1;
          }
          break;
        }
        if (char === "'") {
          state = 'single-quoted';
          index += 1;
          break;
        }
        if (char === '"') {
          state = 'double-quoted-identifier';
          quotedStart = index;
          index += 1;
          break;
        }
        if (char === '`') {
          state = 'backtick-identifier';
          quotedStart = index;
          index += 1;
          break;
        }
        if (char === '-' && text.charAt(index + 1) === '-') {
          state = 'line-comment';
          index += 2;
          break;
        }
        if (char === '/' && text.charAt(index + 1) === '*') {
          state = 'block-comment';
          commentDepth = 1;
          index += 2;
          break;
        }
        if (char === '$') {
          if (isDigit(text.charAt(index + 1))) {
            // A positional placeholder: structure, not data. It survives
            // redaction untouched and becomes a mask only in the grouping
            // key, where one group must hold every parameter set.
            let end = index + 1;
            while (end < text.length && isDigit(text.charAt(end))) {
              end += 1;
            }
            parts.push(mode === 'normalize' ? REDACTION_MASK : text.slice(index, end));
            index = end;
            break;
          }
          const opener = matchDollarQuoteOpener(text, index);
          if (opener !== null) {
            dollarTag = opener;
            state = 'dollar-quoted';
            index += opener.length;
            break;
          }
          parts.push(char);
          index += 1;
          break;
        }
        if (isDigit(char) || (char === '.' && isDigit(text.charAt(index + 1)))) {
          // A sign in front of a number is an operator and stays: masking it
          // would make a subtraction indistinguishable from a negative value
          // and destroy structure for no privacy gain.
          index = skipNumericLiteral(text, index);
          emitMask();
          break;
        }
        if (isIdentifierStart(char)) {
          const typed = matchTypedLiteralOpener(text, index);
          if (typed !== null) {
            state = typed.state;
            index += typed.length;
            break;
          }
          const end = skipIdentifier(text, index);
          parts.push(text.slice(index, end));
          index = end;
          break;
        }
        parts.push(char);
        index += 1;
        break;
      }
      case 'single-quoted':
      case 'escape-string': {
        if (char === '\\') {
          // Honoured in both states. PostgreSQL treats a backslash as an
          // ordinary character inside a standard-conforming string, but a
          // dialect that escapes with it could otherwise end the literal
          // early and leave the rest of the value in identifier position.
          // Consuming the escaped character is the safe reading: at worst a
          // literal that genuinely ends in a backslash masks more of the
          // statement's structure, which loses shape but never data.
          index += 2;
          break;
        }
        if (char === "'") {
          if (text.charAt(index + 1) === "'") {
            index += 2;
            break;
          }
          index += 1;
          state = 'normal';
          emitMask();
          break;
        }
        index += 1;
        break;
      }
      case 'dollar-quoted': {
        if (char === '$' && text.startsWith(dollarTag, index)) {
          index += dollarTag.length;
          state = 'normal';
          emitMask();
          break;
        }
        // Everything up to the identical closing tag belongs to the body,
        // including a `$1` that would be a placeholder anywhere else and a
        // prefix of the tag itself.
        index += 1;
        break;
      }
      case 'line-comment': {
        if (char === '\n' || char === '\r') {
          state = 'normal';
          emitSeparator();
          // The line terminator itself is left to the normal state, which
          // keeps the statement's line structure in `redact` mode.
          break;
        }
        index += 1;
        break;
      }
      case 'block-comment': {
        if (char === '/' && text.charAt(index + 1) === '*') {
          // PostgreSQL nests block comments, so a depth counter is the only
          // correct reading: the first `*/` of a nested pair does not end
          // the outer comment.
          commentDepth += 1;
          index += 2;
          break;
        }
        if (char === '*' && text.charAt(index + 1) === '/') {
          index += 2;
          commentDepth -= 1;
          if (commentDepth === 0) {
            state = 'normal';
            emitSeparator();
          }
          break;
        }
        index += 1;
        break;
      }
      case 'double-quoted-identifier': {
        if (char === '"') {
          if (text.charAt(index + 1) === '"') {
            index += 2;
            break;
          }
          index += 1;
          // A quoted identifier is a schema name, not data, so it is emitted
          // with its quotes and its case intact — and only once it is known
          // to be closed.
          parts.push(text.slice(quotedStart, index));
          state = 'normal';
          break;
        }
        index += 1;
        break;
      }
      case 'backtick-identifier': {
        if (char === '`') {
          if (text.charAt(index + 1) === '`') {
            index += 2;
            break;
          }
          index += 1;
          parts.push(text.slice(quotedStart, index));
          state = 'normal';
          break;
        }
        index += 1;
        break;
      }
    }
  }

  switch (state) {
    case 'normal':
      break;
    case 'line-comment':
    case 'block-comment':
      // An unterminated comment ends with the text; its content is dropped.
      emitSeparator();
      break;
    default:
      // Any unterminated quoted construct — string, escape string,
      // dollar-quoted body, quoted identifier — is masked whole. The
      // partially scanned text is never emitted, because whatever opened the
      // quote is the reason to distrust what follows it.
      emitMask();
      break;
  }

  return { text: parts.join(''), maskCount };
}

/**
 * Redacts a SQL statement: structure verbatim, every inline literal masked.
 *
 * Guarantees, each covered by the colocated tests:
 *
 * - **Parameterised statements are unchanged.** `SELECT id FROM t WHERE id =
 *   $1` comes back byte-identical, placeholders, keywords, identifiers and
 *   layout included.
 * - **Every literal is masked.** Single-quoted strings (with `''` doubling),
 *   `E'…'` escape strings, dollar-quoted bodies including their tags, hex and
 *   bit literals, `0x…` and every numeric form become one
 *   {@link REDACTION_MASK} each.
 * - **Comments are dropped.** Every line comment and every block comment,
 *   nested comments included, becomes a single space, because comment text
 *   carries values copied in from production.
 * - **Nothing half-scanned escapes.** An unterminated string, comment or
 *   quoted identifier is closed by the scanner; its text is never emitted.
 * - **Bounded.** The result is never longer than {@link SQL_MAX_LENGTH}. A
 *   longer statement is scanned up to the bound and its remainder replaced by
 *   {@link REDACTION_MARKER}, so unscanned text is never returned.
 * - **No credential head in front of the marker.** The cut that applies the
 *   bound goes through `cutAtCredentialBoundary`, which moves it back to the
 *   start of any credential crossing it, so a token straddling the bound is
 *   removed whole rather than leaving its prefix in the emitted text. What
 *   the rule keeps of a credential it replaces — a `bearer` scheme word, a
 *   URL scheme — is kept here too, so a truncated statement reads like a
 *   redacted one.
 * - **Belt and braces, on both sides of the scan.** The statement is passed
 *   through the value scrubber before the scanner and again after it. After,
 *   because a credential can sit in a position the scanner treats as
 *   structure — an identifier, an operator argument. Before, because the
 *   scanner removes structure of its own: a PEM private-key block opens with
 *   five dashes, the first two of which are a line comment to SQL, so
 *   scanning first would drop the delimiter that identifies the key and leave
 *   its body behind as ordinary text with nothing left to match it.
 * - **Idempotent.** `redactSqlStatement(redactSqlStatement(s))` equals
 *   `redactSqlStatement(s)`: a mask is a placeholder on the second pass, a
 *   dropped comment leaves nothing to drop, and the bounded result is short
 *   enough that the second call never truncates.
 * - **Total.** Any value of any type is accepted — an empty string, a scalar
 *   that is not a string, `null`, `undefined`, an object — and nothing throws.
 *   Non-string input is normalised by `asScannableText` and then redacted like
 *   any other statement, so evidence is masked rather than erased.
 *
 * @param sql - Statement text as captured from the database tier. Declared
 * `unknown` because a span attribute is untyped at runtime; see
 * {@link redactSqlStatementWithFindings} for how a non-string value is handled.
 * @returns The statement with every inline literal replaced.
 */
export function redactSqlStatement(sql: unknown): string {
  return redactSqlStatementWithFindings(sql).statement;
}

/**
 * Redacts a statement and reports how much was removed.
 *
 * Identical to {@link redactSqlStatement} in what it returns as `statement`,
 * with the two counts a findings report needs alongside it. No part of any
 * replaced value is included — see {@link SqlRedactionFindings}.
 *
 * This is the module's single point of entry, so it is where the defensive
 * boundary sits. `db.statement` is a span attribute: it reaches this function
 * from a parsed JSON payload produced by an instrumented process, so it is
 * `unknown` at runtime however it is typed at the call site. Two failure modes
 * follow from trusting it, and `asScannableText` is what removes both:
 *
 * - **Throwing.** Reading `.length` off `null` or `undefined` raises inside
 *   the ingest path, which would fail the whole batch of events the statement
 *   arrived with rather than the one attribute that was malformed.
 * - **Erasing evidence.** A value that is not a string but has no `length` —
 *   a number, a boolean — used to fall through the emptiness check and return
 *   an empty statement, so a captured query was silently replaced by nothing.
 *   Normalising first means such a value is scanned like any other text: a
 *   bare number is a numeric literal and comes back as one
 *   {@link REDACTION_MASK}, and a value that cannot be examined at all comes
 *   back as {@link REDACTION_MARKER}, which records that something was there.
 *
 * The guarantees of {@link redactSqlStatement} hold for every such input,
 * including the bound and its credential-aware cut, because the normalised
 * text takes exactly the same path as text that arrived as a string.
 *
 * @param sql - Statement text as captured from the database tier, or any other
 * value an untrusted producer supplied in its place.
 */
export function redactSqlStatementWithFindings(sql: unknown): SqlRedactionFindings {
  // Coerced before anything reads a property of it: a non-string value is
  // rendered if it is a safe scalar and reported as removed if it is not, and
  // no getter on a caller-supplied object is ever invoked.
  const text = asScannableText(sql);
  if (text.length === 0) {
    return { statement: '', literalCount: 0, truncated: false };
  }
  const truncated = text.length > SQL_MAX_LENGTH;
  // The cut leaves room for the marker, so the emitted text plus the marker
  // fits the bound and a second pass takes the unbounded path unchanged. It
  // goes through the shared credential-aware primitive rather than a plain
  // slice because the scan runs *after* the cut: a credential straddling the
  // bound would otherwise have its run discarded and its head — a provider
  // credential's prefix, the first characters of the token that follows a
  // `bearer` scheme word — emitted as structure in front of the marker, with
  // nothing left in the text for the scrubber to match.
  const head = truncated
    ? cutAtCredentialBoundary(text, SQL_MAX_LENGTH - REDACTION_MARKER.length)
    : text;
  // The content rules run BEFORE the scanner as well as after it, because the
  // scanner does not only mask data — it also *removes structure*, and one of
  // the things it removes is the delimiter that identifies a credential. A PEM
  // private-key block opens with five dashes, of which the scanner reads the
  // first two as a line comment: the header line is dropped, the base64 body
  // that follows is emitted as ordinary structure, and by the time `scrub`
  // sees the text there is no `-----BEGIN … PRIVATE KEY-----` left for the
  // private-key rule to recognise it by. Scrubbing the raw statement first
  // means no credential can lose its own delimiter that way; scrubbing the
  // scanned text afterwards still catches one the scanner turned into
  // structure. Neither pass is redundant, and the order of the two is the
  // guarantee.
  const scanned = scanStatement(scrub(head), 'redact');
  // The marker is appended before scrubbing because the scrubber matches
  // nothing in it, and because appending afterwards could push the result
  // past the bound.
  const marked = truncated ? scanned.text + REDACTION_MARKER : scanned.text;
  const scrubbed = scrub(marked);
  // The scrubber can grow what it replaces and clamps its own result, and one
  // of its rules replaces an unterminated key block through to the end of the
  // text. Either can leave a construct the scanner had closed open again, so
  // the text is re-scanned whenever scrubbing changed it. That keeps the
  // returned statement a fixed point of the scanner, which is what makes this
  // function idempotent for every input rather than for most of them.
  const statement = scrubbed === marked ? marked : scanStatement(scrubbed, 'redact').text;
  return { statement, literalCount: scanned.maskCount, truncated };
}

/**
 * Normalises a statement into the key that capture aggregates group queries
 * by.
 *
 * Applied to {@link redactSqlStatement}'s output, in order:
 *
 * 1. `$n` positional placeholders become {@link REDACTION_MASK}, so the same
 *    statement run with different parameters groups together — which is the
 *    whole point of grouping by normalised statement.
 * 2. Every whitespace run collapses to one space and the result is trimmed,
 *    so a statement reformatted across lines groups with its one-line form.
 *    Whitespace inside a quoted identifier is left alone: that text is part
 *    of a name.
 * 3. The trailing statement terminator is dropped — a `;`, or a run of them —
 *    so a terminated statement groups with an unterminated one. A `;` between
 *    two statements of a batch is structure and stays
 *    ({@link stripStatementTerminator} explains why the run rather than one
 *    character goes).
 * 4. A parenthesised list of two or more masked values folds to `(?)`, so the
 *    length of an inlined value list does not fragment a group.
 *
 * Case is deliberately **not** folded: PostgreSQL quoted identifiers are
 * case-sensitive, so `"Col"` and `"col"` are different columns and must stay
 * in different groups. The cost is that two statements differing only in
 * keyword case are two groups; the alternative merges statements that address
 * different schema, which would be a wrong answer rather than a noisy one.
 *
 * Grouping is by **exact normalised text**: consumers use the returned string
 * as a map key and normalise nothing further. Like {@link redactSqlStatement}
 * this is idempotent — placeholders are already unified, spacing is already
 * collapsed and a folded list is already folded — and bounded by
 * {@link SQL_MAX_LENGTH}.
 *
 * It is total for the same reason and by the same means: the first thing it
 * does is delegate to {@link redactSqlStatement}, so a value of any type is
 * normalised into text there and a malformed `db.statement` yields a key
 * rather than an exception in the aggregate that is grouping by it.
 *
 * @param sql - Statement text as captured from the database tier, or any other
 * value an untrusted producer supplied in its place.
 * @returns The grouping key: redacted, placeholder-unified, whitespace-
 * collapsed statement text.
 */
export function normalizeSqlStatement(sql: unknown): string {
  const redacted = redactSqlStatement(sql);
  if (redacted.length === 0) {
    return redacted;
  }
  const unified = scanStatement(redacted, 'normalize').text.trim();
  const withoutTerminator = stripStatementTerminator(unified);
  return withoutTerminator.replace(MASKED_VALUE_LIST, '(' + REDACTION_MASK + ')');
}
