#!/usr/bin/env node
/**
 * check-advisories — fail when a locked dependency version or an exact manifest pin is covered by a
 * published security advisory, independently of `pnpm audit`.
 *
 * `pnpm audit` reads the npm registry's advisory feed, which republishes reviewed GitHub Advisory
 * Database entries and therefore lags the advisories a vendor publishes in its own repository, and
 * it sees workspace importers only, never a standalone fixture manifest. This check covers both
 * gaps in three layers:
 *
 * - Inventory: every `name@version` key in the `packages:` section of every YAML document of every
 *   tracked `pnpm-lock.yaml`, plus every exact semver pin in `dependencies`, `devDependencies` and
 *   `optionalDependencies` of every tracked `package.json`. Each entry keeps the paths it came from.
 * - Offline layer, always run: the committed ledger (`scripts/check-advisories.ledger.json`),
 *   validated strictly, whose normalized ranges are matched against the inventory.
 * - Online layer, `--online`: the published GitHub repository security advisories of every vendor
 *   feed the ledger names; an OSV `querybatch` over the whole inventory; and a feed-lag warning for
 *   every ledger or matched vendor advisory OSV does not carry, a sign that the reviewed feed
 *   `pnpm audit` reads lacks it too.
 *
 * It fails closed: an unparseable range, a malformed ledger, lockfile or manifest, a network
 * failure, a timeout, a rate limit and any unexpected response all exit 2.
 *
 * Usage: `node scripts/check-advisories.mjs [--online]`, or `--help`.
 * Exit codes: 0 clean, 1 findings, 2 usage, configuration or network error.
 *
 * @module scripts/check-advisories
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Repository root, derived from this module's location so the result does not depend on the
 * directory the script is invoked from.
 *
 * @type {string}
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Repository-relative path of the committed advisory ledger. */
export const LEDGER_REL = 'scripts/check-advisories.ledger.json';

/** Origin of the GitHub REST API; the only origin that ever receives `GITHUB_TOKEN`. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/** Origin of the OSV API. */
export const OSV_API_ORIGIN = 'https://api.osv.dev';

/** Largest number of queries OSV accepts in one `querybatch` request. */
export const OSV_BATCH_LIMIT = 1000;

/** Per-request deadline, covering connection, headers and body. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** GitHub's maximum page size for repository security advisories. */
const GITHUB_PAGE_SIZE = 100;

/** Upper bound on followed `Link: rel="next"` pages per vendor feed, so a looping cursor fails. */
const GITHUB_MAX_PAGES = 50;

/** Upper bound on OSV `next_page_token` rounds, so a looping token fails instead of spinning. */
const OSV_MAX_PAGE_ROUNDS = 50;

/** GitHub REST API version the vendor-feed requests are written against. */
const GITHUB_API_VERSION = '2022-11-28';

/** `User-Agent` for every request; GitHub rejects requests without one. */
const USER_AGENT = 'debuggen-check-advisories';

/** Clean: no advisory covers any inventoried version. */
const EXIT_OK = 0;

/** At least one inventoried version is covered by an advisory. */
const EXIT_FINDINGS = 1;

/** Bad usage, malformed input, or a network, timeout, rate-limit or response failure. */
const EXIT_ERROR = 2;

/** Manifest fields whose exact pins join the inventory. */
const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]);

/** Severities a ledger entry may carry: GitHub's and OSV's vocabularies combined. */
const LEDGER_SEVERITIES = Object.freeze(['low', 'medium', 'moderate', 'high', 'critical']);

/**
 * Failure carrying the exit code the CLI uses. Every expected failure of this check is one of
 * these, so `main` can tell a reported condition from a defect.
 */
export class AdvisoryCheckError extends Error {
  /**
   * @param {string} message single-line description of what went wrong
   * @param {{ showUsage?: boolean, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AdvisoryCheckError';
    /** @type {number} process exit code for this failure */
    this.exitCode = EXIT_ERROR;
    /** @type {boolean} whether the CLI prints the usage text as well */
    this.showUsage = options.showUsage === true;
  }
}

/** A version range the comparator cannot interpret. Always exit 2: an unread range is unchecked. */
export class RangeSyntaxError extends AdvisoryCheckError {
  /**
   * @param {string} range the range text as given
   * @param {string} reason what is wrong with it
   */
  constructor(range, reason) {
    super(`cannot parse version range ${JSON.stringify(range)}: ${reason}`);
    this.name = 'RangeSyntaxError';
    /** @type {string} */
    this.range = range;
  }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Version
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {ReadonlyArray<string | number>} prerelease identifiers, numeric ones as numbers
 * @property {string} text the version without a leading `v` or `=`
 */

/** A complete version: `x.y.z`, optional prerelease, optional build metadata. */
const FULL_VERSION_PATTERN =
  /^[vV=]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A possibly partial or wildcard version: `16`, `13.4`, `10.x`, `*`, or a complete version. */
const PARTIAL_VERSION_PATTERN =
  /^[vV]?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Split a prerelease string into identifiers, numeric identifiers as numbers.
 *
 * @param {string | undefined} prerelease
 * @returns {Array<string | number>}
 */
function prereleaseIdentifiers(prerelease) {
  if (prerelease === undefined) return [];
  return prerelease.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
}

/**
 * Parse a complete version, or return `null` when `text` is not one. A leading `v` or `=` is
 * accepted, build metadata is kept in `text` and ignored for precedence.
 *
 * @param {unknown} text
 * @returns {Version | null}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const match = FULL_VERSION_PATTERN.exec(trimmed);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prereleaseIdentifiers(match[4]),
    text: trimmed.replace(/^[vV=]/, ''),
  };
}

/**
 * Compare two prerelease identifiers under semver precedence: numeric identifiers compare
 * numerically and rank below alphanumeric ones, which compare in ASCII order.
 *
 * @param {string | number} a
 * @param {string | number} b
 * @returns {number}
 */
function compareIdentifiers(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Semver precedence: negative when `a` sorts first, zero when equal, positive otherwise. A version
 * with a prerelease ranks below the same version without one (`16.3.6-canary.1 < 16.3.6`).
 *
 * @param {Version} a
 * @param {Version} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifiers(
      /** @type {string | number} */ (a.prerelease[index]),
      /** @type {string | number} */ (b.prerelease[index]),
    );
    if (order !== 0) return order;
  }
  return a.prerelease.length - b.prerelease.length;
}

/**
 * Build a version from numeric parts, used for padded and bumped bounds.
 *
 * @param {number} major
 * @param {number} minor
 * @param {number} patch
 * @param {ReadonlyArray<string | number>} [prerelease]
 * @returns {Version}
 */
function makeVersion(major, minor, patch, prerelease = []) {
  const suffix = prerelease.length === 0 ? '' : `-${prerelease.join('.')}`;
  return { major, minor, patch, prerelease, text: `${major}.${minor}.${patch}${suffix}` };
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/** @typedef {'<' | '<=' | '>' | '>=' | '='} Operator */

/**
 * @typedef {object} Comparator
 * @property {Operator} operator
 * @property {Version} version
 */

/**
 * A parsed range: it matches a version when every comparator of at least one alternative does. An
 * alternative with no comparators matches every version.
 *
 * @typedef {object} VersionRange
 * @property {string} source the range text as given
 * @property {ReadonlyArray<ReadonlyArray<Comparator>>} alternatives
 */

/**
 * @typedef {object} PartialVersion
 * @property {number[]} parts the numeric components before the first wildcard (0 to 3 of them)
 * @property {ReadonlyArray<string | number>} prerelease only ever set on a complete version
 */

/**
 * @typedef {{ kind: 'bound', operator: Operator, version: PartialVersion }
 *   | { kind: 'bare', version: PartialVersion }
 *   | { kind: 'hyphen', from: PartialVersion, to: PartialVersion }} RangeItem
 */

/**
 * Parse one version token of a range.
 *
 * @param {string} token
 * @param {string} range the whole range, for the error message
 * @returns {PartialVersion}
 */
function parsePartialVersion(token, range) {
  const match = PARTIAL_VERSION_PATTERN.exec(token);
  if (match === null)
    throw new RangeSyntaxError(range, `${JSON.stringify(token)} is not a version`);
  /** @type {number[]} */
  const parts = [];
  let wildcard = false;
  for (const component of [match[1], match[2], match[3]]) {
    if (component === undefined || /^[xX*]$/.test(component)) {
      wildcard = true;
      continue;
    }
    if (wildcard) {
      throw new RangeSyntaxError(range, `${JSON.stringify(token)} has a number after a wildcard`);
    }
    parts.push(Number(component));
  }
  if (match[4] !== undefined && parts.length < 3) {
    throw new RangeSyntaxError(
      range,
      `${JSON.stringify(token)} has a prerelease on a partial version`,
    );
  }
  return { parts, prerelease: prereleaseIdentifiers(match[4]) };
}

/**
 * The partial version padded with zeros: `13.4` → `13.4.0`.
 *
 * @param {PartialVersion} partial
 * @returns {Version}
 */
function padded(partial) {
  const [major = 0, minor = 0, patch = 0] = partial.parts;
  return makeVersion(major, minor, patch, partial.prerelease);
}

/**
 * The first version after the release line a partial version names, as the lowest prerelease so
 * that the line's successor is excluded along with its prereleases: `13.5` → `13.6.0-0`, `16` →
 * `17.0.0-0`. Only called for partial versions with one or two components.
 *
 * @param {PartialVersion} partial
 * @returns {Version}
 */
function lineSuccessor(partial) {
  const [major = 0, minor = 0] = partial.parts;
  return partial.parts.length === 1
    ? makeVersion(major + 1, 0, 0, [0])
    : makeVersion(major, minor + 1, 0, [0]);
}

/**
 * The lowest version a `>=` bound admits: the bound itself when it names a prerelease, otherwise
 * its lowest prerelease, so the prereleases leading up to a vulnerable release are covered with it
 * (`>= 16.0.0` admits `16.0.0-beta.0`).
 *
 * @param {Version} version
 * @returns {Version}
 */
function inclusiveLowerBound(version) {
  return version.prerelease.length === 0
    ? makeVersion(version.major, version.minor, version.patch, [0])
    : version;
}

/**
 * Translate one bound on a possibly partial version into comparators. No bound narrows a range: a
 * `>=` bound admits the prereleases of the version it names, a partial version is padded with
 * zeros, and `<=` and an exact match on a partial version cover the whole release line it names
 * (`<= 13.5` is `< 13.6.0-0`, `10.x` is `>= 10.0.0-0 < 11.0.0-0`).
 *
 * @param {Operator} operator
 * @param {PartialVersion} partial
 * @param {string} range the whole range, for the error message
 * @returns {Comparator[]}
 */
function boundComparators(operator, partial, range) {
  if (partial.parts.length === 0) {
    if (operator === '>=' || operator === '<=' || operator === '=') return [];
    throw new RangeSyntaxError(range, `"${operator}" cannot bound a bare wildcard`);
  }
  const complete = partial.parts.length === 3;
  switch (operator) {
    case '>=':
      return [{ operator, version: inclusiveLowerBound(padded(partial)) }];
    case '>':
    case '<':
      return [{ operator, version: padded(partial) }];
    case '<=':
      return complete
        ? [{ operator, version: padded(partial) }]
        : [{ operator: '<', version: lineSuccessor(partial) }];
    case '=':
      return complete
        ? [{ operator, version: padded(partial) }]
        : [
            { operator: '>=', version: inclusiveLowerBound(padded(partial)) },
            { operator: '<', version: lineSuccessor(partial) },
          ];
    default:
      throw new RangeSyntaxError(range, `unknown operator ${JSON.stringify(operator)}`);
  }
}

/**
 * Rewrite the operator spellings vendor advisories use into the canonical ones: `≥`/`≤` and the
 * transposed `=>`/`=<`.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeOperators(text) {
  return text.replace(/≥|=>/g, '>=').replace(/≤|=</g, '<=');
}

/** Operators and words of one range segment. */
const RANGE_TOKEN_PATTERN = /(<=|>=|<|>|=)|([^\s<>=]+)/g;

/**
 * Parse one comma-free segment of a range into its items. Whitespace and the word `and` both join
 * comparators; `A - B` is an inclusive hyphen range.
 *
 * @param {string} segment
 * @param {string} range the whole range, for the error message
 * @returns {RangeItem[]}
 */
function parseSegmentItems(segment, range) {
  /** @type {Array<{ operator?: Operator, word?: string }>} */
  const tokens = [];
  for (const match of segment.matchAll(RANGE_TOKEN_PATTERN)) {
    if (match[1] !== undefined) tokens.push({ operator: /** @type {Operator} */ (match[1]) });
    else tokens.push({ word: match[2] });
  }

  /** @type {RangeItem[]} */
  const items = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = /** @type {{ operator?: Operator, word?: string }} */ (tokens[index]);
    if (token.operator !== undefined) {
      const next = tokens[index + 1];
      if (next?.word === undefined || next.word === '-' || /^and$/i.test(next.word)) {
        throw new RangeSyntaxError(range, `"${token.operator}" is not followed by a version`);
      }
      items.push({
        kind: 'bound',
        operator: token.operator,
        version: parsePartialVersion(next.word, range),
      });
      index += 1;
      continue;
    }
    const word = /** @type {string} */ (token.word);
    if (/^and$/i.test(word)) {
      if (items.length === 0 || index === tokens.length - 1) {
        throw new RangeSyntaxError(range, '"and" must join two comparators');
      }
      continue;
    }
    if (word === '-') {
      const previous = items.at(-1);
      const next = tokens[index + 1];
      if (previous?.kind !== 'bare' || next?.word === undefined) {
        throw new RangeSyntaxError(range, 'a hyphen range needs a version on each side');
      }
      items[items.length - 1] = {
        kind: 'hyphen',
        from: previous.version,
        to: parsePartialVersion(next.word, range),
      };
      index += 1;
      continue;
    }
    items.push({ kind: 'bare', version: parsePartialVersion(word, range) });
  }
  if (items.length === 0) throw new RangeSyntaxError(range, 'an empty comparator set');
  return items;
}

/**
 * Whether an item is a pure lower (`>`, `>=`) or upper (`<`, `<=`) bound.
 *
 * @param {RangeItem} item
 * @param {'lower' | 'upper'} side
 * @returns {boolean}
 */
function isBound(item, side) {
  if (item.kind !== 'bound') return false;
  return side === 'lower'
    ? item.operator === '>' || item.operator === '>='
    : item.operator === '<' || item.operator === '<=';
}

/**
 * Translate the items of one alternative into comparators. A single bare version that opens an
 * alternative whose other items are all upper bounds is its lower bound (`10.0.0 <= 12.0.10` is
 * `>= 10.0.0 <= 12.0.10`), which is how vendor advisories write an inclusive interval.
 *
 * @param {RangeItem[]} items
 * @param {string} range the whole range, for the error message
 * @returns {Comparator[]}
 */
function itemsToComparators(items, range) {
  const opensInterval =
    items.length > 1 &&
    items[0]?.kind === 'bare' &&
    items.slice(1).every((item) => isBound(item, 'upper'));
  return items.flatMap((item, index) => {
    if (item.kind === 'bound') return boundComparators(item.operator, item.version, range);
    if (item.kind === 'hyphen') {
      return [
        ...boundComparators('>=', item.from, range),
        ...boundComparators('<=', item.to, range),
      ];
    }
    return boundComparators(opensInterval && index === 0 ? '>=' : '=', item.version, range);
  });
}

/**
 * Parse a GitHub or OSV style version range.
 *
 * Grammar: alternatives separated by `||`; within one, comparators `>=`, `>`, `<=`, `<` and `=`
 * (optional space after the operator; a bare version is `=`) joined by whitespace or `and`;
 * hyphen ranges `A - B`; partial and wildcard versions (`16`, `13.4`, `10.x`, `*`); semver
 * prerelease precedence. Commas carry two meanings in advisory data, resolved by shape: a comma
 * that joins a segment of lower bounds only to a following segment of upper bounds only is AND,
 * the GitHub Advisory Database form `>= 1.0.0, < 1.2.3`; every other comma separates alternatives,
 * as in the vendor form `>=13.0.0 <15.5.15, >= 16.0 < 16.2.3`. Caret, tilde and any other token
 * throw {@link RangeSyntaxError}.
 *
 * @param {string} text
 * @returns {VersionRange}
 */
export function parseRange(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new RangeSyntaxError(String(text), 'the range is empty');
  }
  const normalized = normalizeOperators(text);
  /** @type {Comparator[][]} */
  const alternatives = [];
  for (const group of normalized.split('||')) {
    const segments = group.split(',').map((segment) => parseSegmentItems(segment, text));
    for (let index = 0; index < segments.length; index += 1) {
      const current = /** @type {RangeItem[]} */ (segments[index]);
      const next = segments[index + 1];
      if (
        next !== undefined &&
        current.every((item) => isBound(item, 'lower')) &&
        next.every((item) => isBound(item, 'upper'))
      ) {
        alternatives.push(itemsToComparators([...current, ...next], text));
        index += 1;
      } else {
        alternatives.push(itemsToComparators(current, text));
      }
    }
  }
  return { source: text, alternatives };
}

/**
 * Whether a comparator accepts a version.
 *
 * @param {Version} version
 * @param {Comparator} comparator
 * @returns {boolean}
 */
function comparatorAccepts(version, comparator) {
  const order = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    default:
      return order === 0;
  }
}

/**
 * Whether a version satisfies a range.
 *
 * @param {Version | string} version a parsed version or its text
 * @param {VersionRange | string} range a parsed range or its text
 * @returns {boolean}
 */
export function satisfies(version, range) {
  const parsedVersion = typeof version === 'string' ? parseVersion(version) : version;
  if (parsedVersion === null) {
    throw new AdvisoryCheckError(`${JSON.stringify(version)} is not a complete version`);
  }
  const parsedRange = typeof range === 'string' ? parseRange(range) : range;
  return parsedRange.alternatives.some((alternative) =>
    alternative.every((comparator) => comparatorAccepts(parsedVersion, comparator)),
  );
}

// ---------------------------------------------------------------------------
// Patched versions (vendor feeds)
// ---------------------------------------------------------------------------

/**
 * Read a vendor advisory's free-text `patched_versions` into the versions it names as first fixed
 * releases. Bare versions and `>=`/`=` bounds are kept (padded when partial); `<`, `<=` and `>`
 * bounds and unreadable words are dropped. Dropping only removes exclusions, so an unreadable
 * patched list can add findings but never hide one.
 *
 * @param {string | null | undefined} text
 * @returns {Version[]} sorted ascending, without duplicates
 */
export function parsePatchedVersions(text) {
  if (typeof text !== 'string') return [];
  /** @type {Version[]} */
  const versions = [];
  let pending = /** @type {Operator | undefined} */ (undefined);
  for (const match of normalizeOperators(text).replace(/,/g, ' ').matchAll(RANGE_TOKEN_PATTERN)) {
    if (match[1] !== undefined) {
      pending = /** @type {Operator} */ (match[1]);
      continue;
    }
    const operator = pending;
    pending = undefined;
    if (operator !== undefined && operator !== '>=' && operator !== '=') continue;
    const partial = PARTIAL_VERSION_PATTERN.exec(/** @type {string} */ (match[2]));
    if (partial === null || partial[1] === undefined || !/^\d+$/.test(partial[1])) continue;
    const parts = [partial[1], partial[2], partial[3]];
    if (parts.some((part) => part !== undefined && !/^\d+$/.test(part))) continue;
    versions.push(
      makeVersion(
        Number(parts[0]),
        Number(parts[1] ?? 0),
        Number(parts[2] ?? 0),
        parts[2] === undefined ? [] : prereleaseIdentifiers(partial[4]),
      ),
    );
  }
  versions.sort(compareVersions);
  return versions.filter((version, index) => {
    const previous = versions[index - 1];
    return previous === undefined || compareVersions(previous, version) !== 0;
  });
}

/**
 * Whether one vendor vulnerability entry's own patched list exempts a version that one of the
 * entry's range alternatives matched. The range is authoritative and the patched list only removes
 * versions it covers unambiguously:
 *
 * - a fix on the version's own `major.minor` line, at or below the version, that the alternative's
 *   lower bounds also admit — so a later regression window on that line stays affected;
 * - for an alternative with no upper bound, which relies on the patched list to close it, a
 *   version at or past the entry's newest fix.
 *
 * Fixes listed by other entries of the same advisory never apply: each entry describes its own
 * release line. Anything else stays affected, so a list that does not clearly close a range fails
 * closed (with fixes `15.1.12, 16.1.5` on `>= 10.0.0`, `15.1.13` and `16.3.6` are exempt, `15.2.0`
 * is not).
 *
 * @param {Version} version
 * @param {ReadonlyArray<Comparator>} alternative the range alternative the version satisfies
 * @param {ReadonlyArray<Version>} fixes the entry's own fixes, from {@link parsePatchedVersions}
 * @returns {boolean}
 */
export function isExempt(version, alternative, fixes) {
  const lowerBounds = alternative.filter(
    (comparator) => comparator.operator === '>' || comparator.operator === '>=',
  );
  const sameLineFix = fixes.some(
    (fix) =>
      fix.major === version.major &&
      fix.minor === version.minor &&
      compareVersions(fix, version) <= 0 &&
      lowerBounds.every((comparator) => comparatorAccepts(fix, comparator)),
  );
  if (sameLineFix) return true;
  const open = !alternative.some(
    (comparator) =>
      comparator.operator === '<' || comparator.operator === '<=' || comparator.operator === '=',
  );
  const newest = fixes.at(-1);
  return open && newest !== undefined && compareVersions(version, newest) >= 0;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LockedPackage
 * @property {string} name
 * @property {string} version the version exactly as the lockfile key carries it
 */

/**
 * Split a lockfile package key into name and version. The separator is the first `@` after the
 * first character, which keeps a scope's own `@` and any `@` inside a non-registry specifier on
 * the correct side.
 *
 * @param {string} key an unquoted `packages:` key such as `@next/env@16.3.6`
 * @returns {LockedPackage}
 */
export function splitPackageKey(key) {
  const at = key.indexOf('@', 1);
  const name = at === -1 ? '' : key.slice(0, at);
  const version = at === -1 ? '' : key.slice(at + 1);
  if (!/^(?:@[^\s/@]+\/)?[^\s/@]+$/.test(name) || version === '') {
    throw new AdvisoryCheckError(`lockfile package key ${JSON.stringify(key)} is not name@version`);
  }
  return { name, version };
}

/**
 * Unquote one YAML mapping key as pnpm writes it: plain, single-quoted (`''` escapes a quote) or
 * double-quoted.
 *
 * @param {string} raw
 * @param {string} label lockfile path, for the error message
 * @returns {string}
 */
function unquoteYamlKey(raw, label) {
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) {
      throw new AdvisoryCheckError(`${label}: unterminated quoted key ${raw}`);
    }
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw.startsWith('"')) {
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'string') return value;
    } catch (error) {
      throw new AdvisoryCheckError(`${label}: unreadable quoted key ${raw}`, { cause: error });
    }
    throw new AdvisoryCheckError(`${label}: unreadable quoted key ${raw}`);
  }
  return raw;
}

/**
 * Read every `name@version` key of the `packages:` section of every YAML document in a pnpm
 * lockfile (pnpm writes its own package-manager dependencies as a separate leading document). Only
 * `packages:` is read: `snapshots:` repeats the same packages with peer suffixes. Every document
 * must declare lockfile format 9, the only key shape this parser knows.
 *
 * @param {string} text lockfile contents
 * @param {string} [label] lockfile path, for error messages
 * @returns {LockedPackage[]} in file order, one per key
 */
export function parseLockfilePackages(text, label = 'pnpm-lock.yaml') {
  /** @type {LockedPackage[]} */
  const packages = [];
  let inPackages = false;
  let documentHasContent = false;
  let documentVersion = /** @type {string | null} */ (null);
  let lineNumber = 0;

  const closeDocument = () => {
    if (documentHasContent && documentVersion === null) {
      throw new AdvisoryCheckError(`${label}: a YAML document has no lockfileVersion`);
    }
    inPackages = false;
    documentHasContent = false;
    documentVersion = null;
  };

  for (const line of text.split(/\r?\n/)) {
    lineNumber += 1;
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^(?:---|\.\.\.)\s*$/.test(line)) {
      closeDocument();
      continue;
    }
    if (!/^\s/.test(line)) {
      documentHasContent = true;
      const version = /^lockfileVersion:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
      if (version !== null) {
        documentVersion = /** @type {string} */ (version[1]);
        if (!/^9(?:\.\d+)?$/.test(documentVersion)) {
          throw new AdvisoryCheckError(
            `${label}: lockfileVersion ${documentVersion} is not supported (expected 9.x)`,
          );
        }
      }
      inPackages = /^packages:\s*$/.test(line);
      continue;
    }
    if (!inPackages || !/^ {2}\S/.test(line)) continue;
    const key = /^ {2}(\S.*?):\s*$/.exec(line);
    if (key === null) {
      throw new AdvisoryCheckError(
        `${label}:${lineNumber}: unexpected packages entry ${line.trim()}`,
      );
    }
    packages.push(splitPackageKey(unquoteYamlKey(/** @type {string} */ (key[1]), label)));
  }
  closeDocument();
  return packages;
}

/**
 * @typedef {object} ManifestPin
 * @property {string} name the package installed (the target of an `npm:` alias)
 * @property {string} version
 * @property {string} field the manifest field that declares it
 */

/**
 * Whether a value is a plain JSON object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every exact semver pin (`x.y.z`, optional prerelease and build metadata, optional `v`/`=`) a
 * manifest declares. Ranges, tags, `workspace:`, `file:`, `link:`, git and URL specifiers carry no
 * single version and are skipped; `npm:name@x.y.z` aliases count under the aliased name.
 *
 * @param {unknown} manifest a parsed `package.json`
 * @param {string} [label] manifest path, for error messages
 * @returns {ManifestPin[]}
 */
export function extractManifestPins(manifest, label = 'package.json') {
  if (!isPlainObject(manifest)) throw new AdvisoryCheckError(`${label}: not a JSON object`);
  /** @type {ManifestPin[]} */
  const pins = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!isPlainObject(dependencies)) {
      throw new AdvisoryCheckError(`${label}: "${field}" is not an object`);
    }
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier !== 'string') {
        throw new AdvisoryCheckError(`${label}: "${field}.${name}" is not a string`);
      }
      let target = name;
      let spec = specifier.trim();
      if (spec.startsWith('npm:')) {
        const alias = spec.slice('npm:'.length);
        const at = alias.indexOf('@', 1);
        if (at === -1) continue;
        target = alias.slice(0, at);
        spec = alias.slice(at + 1);
      }
      const version = parseVersion(spec);
      if (version !== null) pins.push({ name: target, version: version.text, field });
    }
  }
  return pins;
}

/**
 * @typedef {object} InventoryEntry
 * @property {string} name
 * @property {string} version
 * @property {Version} parsed
 * @property {string[]} origins sorted repository-relative paths, manifests with their field
 */

/**
 * @typedef {object} Inventory
 * @property {InventoryEntry[]} entries one per distinct `name@version`, sorted
 * @property {string[]} unevaluated `name@specifier (origin)` for non-registry lockfile entries
 * @property {number} lockfileCount
 * @property {number} lockedCount distinct `name@version` keys across lockfiles
 * @property {number} manifestCount
 * @property {number} pinCount exact pins across manifests
 */

/**
 * Merge lockfile packages and manifest pins into one inventory keyed by `name@version`.
 *
 * @param {{ lockfiles?: ReadonlyArray<{ path: string, text: string }>,
 *           manifests?: ReadonlyArray<{ path: string, json: unknown }> }} sources
 * @returns {Inventory}
 */
export function buildInventory({ lockfiles = [], manifests = [] }) {
  /** @type {Map<string, { name: string, version: string, parsed: Version, origins: Set<string> }>} */
  const byKey = new Map();
  /** @type {Set<string>} */
  const unevaluated = new Set();
  /** @type {Set<string>} */
  const lockedKeys = new Set();
  let pinCount = 0;

  /**
   * @param {string} name
   * @param {Version} parsed
   * @param {string} origin
   */
  const add = (name, parsed, origin) => {
    const key = `${name}@${parsed.text}`;
    const entry = byKey.get(key) ?? { name, version: parsed.text, parsed, origins: new Set() };
    entry.origins.add(origin);
    byKey.set(key, entry);
    return key;
  };

  for (const lockfile of lockfiles) {
    for (const pkg of parseLockfilePackages(lockfile.text, lockfile.path)) {
      const parsed = parseVersion(pkg.version);
      if (parsed === null) {
        unevaluated.add(`${pkg.name}@${pkg.version} (${lockfile.path})`);
        continue;
      }
      lockedKeys.add(add(pkg.name, parsed, lockfile.path));
    }
  }
  for (const manifest of manifests) {
    for (const pin of extractManifestPins(manifest.json, manifest.path)) {
      add(
        pin.name,
        /** @type {Version} */ (parseVersion(pin.version)),
        `${manifest.path} (${pin.field})`,
      );
      pinCount += 1;
    }
  }

  const entries = [...byKey.values()]
    .map((entry) => ({ ...entry, origins: [...entry.origins].sort() }))
    .sort((a, b) => compareText(a.name, b.name) || compareVersions(a.parsed, b.parsed));
  return {
    entries,
    unevaluated: [...unevaluated].sort(),
    lockfileCount: lockfiles.length,
    lockedCount: lockedKeys.size,
    manifestCount: manifests.length,
    pinCount,
  };
}

/**
 * List the repository's tracked files with `git ls-files -z`.
 *
 * @param {string} root
 * @returns {string[]} repository-relative POSIX paths
 */
export function listTrackedFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new AdvisoryCheckError(`git ls-files failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new AdvisoryCheckError(
      `git ls-files exited ${String(result.status)}: ${result.stderr.trim() || 'no output'}`,
    );
  }
  return result.stdout.split('\0').filter((file) => file !== '');
}

/**
 * Read a file as UTF-8, reporting failure as an exit-2 error that names the file.
 *
 * @param {string} file
 * @param {string} label
 * @returns {string}
 */
function readText(file, label) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AdvisoryCheckError(`cannot read ${label}: ${detail}`, { cause: error });
  }
}

/**
 * Build the inventory from the tracked lockfiles and manifests under `root`.
 *
 * @param {string} root
 * @param {ReadonlyArray<string>} trackedFiles repository-relative paths
 * @returns {Inventory}
 */
export function readInventory(root, trackedFiles) {
  const lockfiles = [];
  const manifests = [];
  for (const file of [...trackedFiles].sort()) {
    const base = path.posix.basename(file);
    if (base === 'pnpm-lock.yaml') {
      lockfiles.push({ path: file, text: readText(path.join(root, file), file) });
    } else if (base === 'package.json') {
      const text = readText(path.join(root, file), file);
      try {
        manifests.push({ path: file, json: JSON.parse(text) });
      } catch (error) {
        throw new AdvisoryCheckError(`${file}: not valid JSON`, { cause: error });
      }
    }
  }
  return buildInventory({ lockfiles, manifests });
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * @typedef {object} VendorFeed
 * @property {string} package the npm package the vendor publishes
 * @property {string} repository `owner/name` of the GitHub repository carrying its advisories
 */

/**
 * @typedef {object} LedgerAdvisory
 * @property {string} id GHSA identifier
 * @property {string[]} aliases CVE or GHSA aliases
 * @property {string} package npm package name
 * @property {string} severity
 * @property {string[]} vulnerableRanges normalized ranges, see {@link parseRange}
 * @property {VersionRange[]} ranges the parsed `vulnerableRanges`
 * @property {string | null} patched first fixed version, `null` while none exists
 * @property {string} published `YYYY-MM-DD`
 * @property {string} source advisory URL
 * @property {VendorEntry[]} vendorEntries vendor entries these ranges replace, verbatim
 */

/**
 * One vulnerability entry of a vendor advisory exactly as the vendor feed publishes it. A ledger
 * advisory lists the entries its normalized ranges replace; the online layer skips a vendor entry
 * only when package, range text and patched text all match one of these byte for byte, so a
 * revised entry is evaluated as published.
 *
 * @typedef {object} VendorEntry
 * @property {string} package npm package name
 * @property {string} range `vulnerable_version_range`, `''` when the vendor gives none
 * @property {string | null} patched `patched_versions`
 */

/**
 * @typedef {object} Ledger
 * @property {string} notes
 * @property {VendorFeed[]} vendorFeeds
 * @property {LedgerAdvisory[]} advisories
 */

const GHSA_ID_PATTERN = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const ALIAS_PATTERN = /^(?:CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * Reject any key outside the allowed set, so a misspelt field fails instead of being ignored.
 *
 * @param {Record<string, unknown>} value
 * @param {ReadonlyArray<string>} allowed
 * @param {string} where
 */
function assertKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new AdvisoryCheckError(`${where}: unknown key "${key}"`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new AdvisoryCheckError(`${where}: missing key "${key}"`);
  }
}

/**
 * Whether a string is a real calendar date written `YYYY-MM-DD`.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Validate a parsed ledger strictly: exact key sets, typed values, parseable ranges, unique ids and
 * feeds. Any deviation throws, so the offline layer never runs on a ledger it half understands.
 *
 * @param {unknown} value
 * @param {string} [label] ledger path, for error messages
 * @returns {Ledger}
 */
export function validateLedger(value, label = LEDGER_REL) {
  if (!isPlainObject(value)) throw new AdvisoryCheckError(`${label}: not a JSON object`);
  assertKeys(value, ['notes', 'vendorFeeds', 'advisories'], label);
  if (typeof value.notes !== 'string')
    throw new AdvisoryCheckError(`${label}: "notes" is not a string`);
  if (!Array.isArray(value.vendorFeeds)) {
    throw new AdvisoryCheckError(`${label}: "vendorFeeds" is not an array`);
  }
  if (!Array.isArray(value.advisories)) {
    throw new AdvisoryCheckError(`${label}: "advisories" is not an array`);
  }

  /** @type {VendorFeed[]} */
  const vendorFeeds = [];
  const feedKeys = new Set();
  value.vendorFeeds.forEach((feed, index) => {
    const where = `${label}: vendorFeeds[${index}]`;
    if (!isPlainObject(feed)) throw new AdvisoryCheckError(`${where}: not an object`);
    assertKeys(feed, ['package', 'repository'], where);
    if (typeof feed.package !== 'string' || !PACKAGE_NAME_PATTERN.test(feed.package)) {
      throw new AdvisoryCheckError(`${where}: "package" is not an npm package name`);
    }
    if (typeof feed.repository !== 'string' || !REPOSITORY_PATTERN.test(feed.repository)) {
      throw new AdvisoryCheckError(`${where}: "repository" is not owner/name`);
    }
    const key = `${feed.package} ${feed.repository.toLowerCase()}`;
    if (feedKeys.has(key)) throw new AdvisoryCheckError(`${where}: duplicate vendor feed`);
    feedKeys.add(key);
    vendorFeeds.push({ package: feed.package, repository: feed.repository });
  });

  /** @type {LedgerAdvisory[]} */
  const advisories = [];
  const ids = new Set();
  value.advisories.forEach((advisory, index) => {
    const where = `${label}: advisories[${index}]`;
    if (!isPlainObject(advisory)) throw new AdvisoryCheckError(`${where}: not an object`);
    assertKeys(
      advisory,
      [
        'id',
        'aliases',
        'package',
        'severity',
        'vulnerableRanges',
        'patched',
        'published',
        'source',
        'vendorEntries',
      ],
      where,
    );
    const { id, aliases, severity, vulnerableRanges, patched, published, source, vendorEntries } =
      advisory;
    if (typeof id !== 'string' || !GHSA_ID_PATTERN.test(id)) {
      throw new AdvisoryCheckError(`${where}: "id" is not a GHSA identifier`);
    }
    if (ids.has(id)) throw new AdvisoryCheckError(`${where}: duplicate id ${id}`);
    ids.add(id);
    if (
      !Array.isArray(aliases) ||
      !aliases.every((alias) => typeof alias === 'string' && ALIAS_PATTERN.test(alias))
    ) {
      throw new AdvisoryCheckError(`${where}: "aliases" must list CVE or GHSA identifiers`);
    }
    if (typeof advisory.package !== 'string' || !PACKAGE_NAME_PATTERN.test(advisory.package)) {
      throw new AdvisoryCheckError(`${where}: "package" is not an npm package name`);
    }
    if (typeof severity !== 'string' || !LEDGER_SEVERITIES.includes(severity)) {
      throw new AdvisoryCheckError(
        `${where}: "severity" must be one of ${LEDGER_SEVERITIES.join(', ')}`,
      );
    }
    if (
      !Array.isArray(vulnerableRanges) ||
      vulnerableRanges.length === 0 ||
      !vulnerableRanges.every((range) => typeof range === 'string')
    ) {
      throw new AdvisoryCheckError(`${where}: "vulnerableRanges" must be a non-empty string array`);
    }
    /** @type {VersionRange[]} */
    let ranges;
    try {
      ranges = vulnerableRanges.map((range) => parseRange(range));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AdvisoryCheckError(`${where}: ${detail}`, { cause: error });
    }
    if (patched !== null && parseVersion(patched) === null) {
      throw new AdvisoryCheckError(`${where}: "patched" must be a complete version or null`);
    }
    if (typeof published !== 'string' || !isCalendarDate(published)) {
      throw new AdvisoryCheckError(`${where}: "published" must be a YYYY-MM-DD date`);
    }
    if (typeof source !== 'string' || !source.startsWith('https://')) {
      throw new AdvisoryCheckError(`${where}: "source" must be an https URL`);
    }
    if (!Array.isArray(vendorEntries)) {
      throw new AdvisoryCheckError(`${where}: "vendorEntries" is not an array`);
    }
    /** @type {VendorEntry[]} */
    const replaced = vendorEntries.map((entry, entryIndex) => {
      const at = `${where}: vendorEntries[${entryIndex}]`;
      if (!isPlainObject(entry)) throw new AdvisoryCheckError(`${at}: not an object`);
      assertKeys(entry, ['package', 'range', 'patched'], at);
      if (typeof entry.package !== 'string' || !PACKAGE_NAME_PATTERN.test(entry.package)) {
        throw new AdvisoryCheckError(`${at}: "package" is not an npm package name`);
      }
      if (typeof entry.range !== 'string') {
        throw new AdvisoryCheckError(`${at}: "range" must be the vendor's range text`);
      }
      if (entry.patched !== null && typeof entry.patched !== 'string') {
        throw new AdvisoryCheckError(`${at}: "patched" must be the vendor's patched text or null`);
      }
      return { package: entry.package, range: entry.range, patched: entry.patched };
    });
    advisories.push({
      id,
      aliases: [...aliases],
      package: advisory.package,
      severity,
      vulnerableRanges: [...vulnerableRanges],
      ranges,
      patched: /** @type {string | null} */ (patched),
      published,
      source,
      vendorEntries: replaced,
    });
  });

  return { notes: value.notes, vendorFeeds, advisories };
}

/**
 * Read and validate the ledger file.
 *
 * @param {string} file absolute path
 * @param {string} [label] path shown in messages
 * @returns {Ledger}
 */
export function loadLedger(file, label = LEDGER_REL) {
  const text = readText(file, label);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new AdvisoryCheckError(`${label}: not valid JSON`, { cause: error });
  }
  return validateLedger(value, label);
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * Locale-independent string order, so output is identical on every machine.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @typedef {object} Finding
 * @property {string} id advisory identifier
 * @property {string[]} aliases
 * @property {string} severity
 * @property {string} name
 * @property {string} version
 * @property {string[]} origins
 * @property {string} affected the range that matched, or `-` when the source gives none
 * @property {string} patched first fixed version(s), or `none published`
 * @property {string} source advisory URL
 * @property {string[]} foundBy the layers that reported it
 */

/**
 * Findings deduplicated by advisory and `name@version`, where an alias resolves to the identifier
 * it was first recorded under, so one advisory reported by several layers prints once with every
 * layer named.
 */
export class FindingSet {
  constructor() {
    /** @type {Map<string, Finding>} */
    this.byKey = new Map();
    /** @type {Map<string, string>} alias or id → canonical id */
    this.canonical = new Map();
  }

  /**
   * Record that `aliases` name the same advisory as `id`.
   *
   * @param {string} id
   * @param {ReadonlyArray<string>} aliases
   */
  alias(id, aliases) {
    const canonical = this.canonical.get(id) ?? id;
    this.canonical.set(id, canonical);
    for (const alias of aliases) {
      if (!this.canonical.has(alias)) this.canonical.set(alias, canonical);
    }
  }

  /**
   * Whether an advisory (by id or alias) already has a finding for `name@version`.
   *
   * @param {string} id
   * @param {string} name
   * @param {string} version
   * @returns {boolean}
   */
  has(id, name, version) {
    return this.byKey.has(`${this.canonical.get(id) ?? id}\0${name}@${version}`);
  }

  /**
   * Record a finding, or add its reporting layers to the finding already recorded for the same
   * advisory and `name@version`.
   *
   * @param {Finding} finding
   */
  add(finding) {
    this.alias(finding.id, finding.aliases);
    const id = /** @type {string} */ (this.canonical.get(finding.id));
    const key = `${id}\0${finding.name}@${finding.version}`;
    const existing = this.byKey.get(key);
    if (existing === undefined) {
      this.byKey.set(key, { ...finding, id, foundBy: [...finding.foundBy] });
      return;
    }
    for (const layer of finding.foundBy) this.addLayer(id, finding.name, finding.version, layer);
  }

  /**
   * Name one more layer as reporting an existing finding.
   *
   * @param {string} id advisory id or alias
   * @param {string} name
   * @param {string} version
   * @param {string} layer
   */
  addLayer(id, name, version, layer) {
    const existing = this.byKey.get(`${this.canonical.get(id) ?? id}\0${name}@${version}`);
    if (existing !== undefined && !existing.foundBy.includes(layer)) existing.foundBy.push(layer);
  }

  /** @returns {Finding[]} ordered by package, version and advisory */
  list() {
    return [...this.byKey.values()].sort(
      (a, b) =>
        compareText(a.name, b.name) ||
        compareVersions(
          /** @type {Version} */ (parseVersion(a.version)),
          /** @type {Version} */ (parseVersion(b.version)),
        ) ||
        compareText(a.id, b.id),
    );
  }

  /** @returns {number} */
  get size() {
    return this.byKey.size;
  }
}

/**
 * The offline layer: record a finding for every inventory entry inside a ledger range.
 *
 * @param {Inventory} inventory
 * @param {Ledger} ledger
 * @param {FindingSet} findings
 */
export function evaluateLedger(inventory, ledger, findings) {
  for (const advisory of ledger.advisories) {
    findings.alias(advisory.id, advisory.aliases);
    for (const entry of inventory.entries) {
      if (entry.name !== advisory.package) continue;
      const matched = advisory.ranges.find((range) => satisfies(entry.parsed, range));
      if (matched === undefined) continue;
      findings.add({
        id: advisory.id,
        aliases: advisory.aliases,
        severity: advisory.severity,
        name: entry.name,
        version: entry.version,
        origins: entry.origins,
        affected: matched.source,
        patched: advisory.patched ?? 'none published',
        source: advisory.source,
        foundBy: ['committed ledger'],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Online layer
// ---------------------------------------------------------------------------

/**
 * @typedef {object} OnlineContext
 * @property {typeof fetch} fetch
 * @property {number} timeoutMs
 * @property {Record<string, string | undefined>} env
 */

/**
 * @typedef {object} JsonResponse
 * @property {number} status
 * @property {Headers} headers
 * @property {unknown} body `null` for an allowed 404
 */

/**
 * Explain a rejected request without echoing anything but the error's own message.
 *
 * @param {unknown} error
 * @param {number} timeoutMs
 * @returns {string}
 */
function describeRequestFailure(error, timeoutMs) {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `timed out after ${String(timeoutMs / 1000)} s`;
  }
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
  return `failed: ${message}${cause}`;
}

/**
 * Describe a rate-limit response, or return `''` when the response is not one. GitHub signals a
 * primary limit with 403 or 429 and `x-ratelimit-remaining: 0`, a secondary one with
 * `retry-after`.
 *
 * @param {Response} response
 * @returns {string}
 */
function rateLimitDetail(response) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const retryAfter = response.headers.get('retry-after');
  const limited =
    response.status === 429 ||
    (response.status === 403 && (remaining === '0' || retryAfter !== null));
  if (!limited) return '';
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const resetText =
    Number.isFinite(reset) && reset > 0
      ? `, resets at ${new Date(reset * 1000).toISOString()}`
      : '';
  const retryText = retryAfter === null ? '' : `, retry after ${retryAfter} s`;
  return ` (rate limit exceeded${resetText}${retryText})`;
}

/**
 * Perform one request and parse its JSON body, failing closed on a rejected request, a timeout, a
 * non-2xx status (a 404 only when `allowNotFound`) and a body that is not JSON.
 *
 * @param {OnlineContext} context
 * @param {string} url
 * @param {{ service: string, method?: string, headers?: Record<string, string>, body?: string,
 *           allowNotFound?: boolean, rateLimitHint?: string }} options
 * @returns {Promise<JsonResponse>}
 */
async function requestJson(context, url, options) {
  const method = options.method ?? 'GET';
  const where = `${options.service}: ${method} ${url}`;
  /** @type {Response} */
  let response;
  let text;
  try {
    /** @type {RequestInit} */
    const init = {
      method,
      headers: options.headers ?? {},
      redirect: 'error',
      signal: AbortSignal.timeout(context.timeoutMs),
    };
    if (options.body !== undefined) init.body = options.body;
    response = await context.fetch(url, init);
    if (options.allowNotFound === true && response.status === 404) {
      await response.text();
      return { status: 404, headers: response.headers, body: null };
    }
    if (!response.ok) {
      const limit = rateLimitDetail(response);
      throw new AdvisoryCheckError(
        `${where} returned HTTP ${String(response.status)}${limit}${limit === '' ? '' : (options.rateLimitHint ?? '')}`,
      );
    }
    text = await response.text();
  } catch (error) {
    if (error instanceof AdvisoryCheckError) throw error;
    throw new AdvisoryCheckError(`${where} ${describeRequestFailure(error, context.timeoutMs)}`, {
      cause: error,
    });
  }
  try {
    return { status: response.status, headers: response.headers, body: JSON.parse(text) };
  } catch (error) {
    throw new AdvisoryCheckError(`${where} returned a body that is not JSON`, { cause: error });
  }
}

/**
 * The URL of the `rel="next"` page in a `Link` header, or `null`.
 *
 * @param {string | null} header
 * @returns {string | null}
 */
export function parseNextLink(header) {
  if (header === null || header === '') return null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (
      match !== null &&
      /(?:^|;)\s*rel\s*=\s*"?next"?\s*(?:;|$)/.test(/** @type {string} */ (match[2]))
    ) {
      return /** @type {string} */ (match[1]);
    }
  }
  return null;
}

/**
 * @typedef {object} VendorVulnerability
 * @property {string | null} ecosystem
 * @property {string | null} name
 * @property {string | null} range `vulnerable_version_range`
 * @property {string | null} patched `patched_versions`
 */

/**
 * @typedef {object} VendorAdvisory
 * @property {string} id
 * @property {string[]} aliases
 * @property {string} severity
 * @property {string} source
 * @property {boolean} withdrawn
 * @property {VendorVulnerability[]} vulnerabilities
 */

/**
 * Validate one repository security advisory from the GitHub API.
 *
 * @param {unknown} raw
 * @param {string} repository
 * @returns {VendorAdvisory}
 */
function readVendorAdvisory(raw, repository) {
  const where = `vendor feed ${repository}`;
  if (!isPlainObject(raw) || typeof raw.ghsa_id !== 'string' || raw.ghsa_id === '') {
    throw new AdvisoryCheckError(`${where}: an advisory has no ghsa_id`);
  }
  const id = raw.ghsa_id;
  const vulnerabilities = raw.vulnerabilities ?? [];
  if (!Array.isArray(vulnerabilities)) {
    throw new AdvisoryCheckError(`${where}: ${id} has a non-array "vulnerabilities"`);
  }
  const text = (/** @type {unknown} */ value) => (typeof value === 'string' ? value : null);
  const aliases = new Set();
  if (typeof raw.cve_id === 'string' && raw.cve_id !== '') aliases.add(raw.cve_id);
  if (Array.isArray(raw.identifiers)) {
    for (const identifier of raw.identifiers) {
      if (
        isPlainObject(identifier) &&
        typeof identifier.value === 'string' &&
        identifier.value !== id
      ) {
        aliases.add(identifier.value);
      }
    }
  }
  const htmlUrl = text(raw.html_url);
  return {
    id,
    aliases: [...aliases],
    severity: text(raw.severity) ?? 'unknown',
    source:
      htmlUrl !== null && htmlUrl.startsWith('https://github.com/')
        ? htmlUrl
        : `https://github.com/${repository}/security/advisories/${id}`,
    withdrawn: raw.withdrawn_at !== null && raw.withdrawn_at !== undefined,
    vulnerabilities: vulnerabilities.map((vulnerability) => {
      if (!isPlainObject(vulnerability)) {
        throw new AdvisoryCheckError(`${where}: ${id} has a vulnerability that is not an object`);
      }
      const pkg = isPlainObject(vulnerability.package) ? vulnerability.package : {};
      return {
        ecosystem: text(pkg.ecosystem),
        name: text(pkg.name),
        range: text(vulnerability.vulnerable_version_range),
        patched: text(vulnerability.patched_versions),
      };
    }),
  };
}

/**
 * Fetch every published security advisory of a vendor repository, following `Link` pagination.
 * `GITHUB_TOKEN`, when set, is sent as a bearer token to the GitHub API origin only.
 *
 * @param {VendorFeed} feed
 * @param {OnlineContext} context
 * @returns {Promise<VendorAdvisory[]>}
 */
export async function fetchVendorAdvisories(feed, context) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': USER_AGENT,
  };
  const token = context.env.GITHUB_TOKEN?.trim();
  if (token !== undefined && token !== '') headers.Authorization = `Bearer ${token}`;
  const rateLimitHint =
    headers.Authorization === undefined ? '; set GITHUB_TOKEN to raise the limit' : '';

  /** @type {VendorAdvisory[]} */
  const advisories = [];
  /** @type {string | null} */
  let url = `${GITHUB_API_ORIGIN}/repos/${feed.repository}/security-advisories?state=published&per_page=${String(GITHUB_PAGE_SIZE)}`;
  for (let page = 1; url !== null; page += 1) {
    if (page > GITHUB_MAX_PAGES) {
      throw new AdvisoryCheckError(
        `vendor feed ${feed.repository}: more than ${String(GITHUB_MAX_PAGES)} pages of advisories`,
      );
    }
    const response = await requestJson(context, url, {
      service: `vendor feed ${feed.repository}`,
      headers,
      rateLimitHint,
    });
    if (!Array.isArray(response.body)) {
      throw new AdvisoryCheckError(`vendor feed ${feed.repository}: response is not an array`);
    }
    for (const raw of response.body) advisories.push(readVendorAdvisory(raw, feed.repository));
    const next = parseNextLink(response.headers.get('link'));
    if (next !== null && new URL(next).origin !== GITHUB_API_ORIGIN) {
      throw new AdvisoryCheckError(
        `vendor feed ${feed.repository}: next page points outside ${GITHUB_API_ORIGIN}`,
      );
    }
    url = next;
  }
  return advisories;
}

/**
 * The range text a vendor vulnerability entry is evaluated with. An empty range means every
 * version. A range that is one exact version while the entry's own patched list names a later one
 * is read as the interval from that version to its fix (`16.0.0` patched `16.1.5` is
 * `>= 16.0.0`, which {@link isExempt} then closes at the fix), which is what vendors mean by it.
 *
 * @param {VendorVulnerability} vulnerability
 * @returns {string}
 */
function vendorRangeText(vulnerability) {
  const range = vulnerability.range?.trim() ?? '';
  if (range === '') return '*';
  const exact = parseVersion(range);
  if (
    exact !== null &&
    parsePatchedVersions(vulnerability.patched).some((fix) => compareVersions(fix, exact) > 0)
  ) {
    return `>= ${exact.text}`;
  }
  return range;
}

/**
 * The ledger advisory that names the same advisory as a vendor record, by id or alias, if any.
 *
 * @param {Ledger} ledger
 * @param {VendorAdvisory} advisory
 * @returns {LedgerAdvisory | undefined}
 */
function ledgerAdvisoryFor(ledger, advisory) {
  const names = new Set([advisory.id, ...advisory.aliases]);
  return ledger.advisories.find(
    (entry) => names.has(entry.id) || entry.aliases.some((alias) => names.has(alias)),
  );
}

/**
 * Evaluate vendor advisories against the inventory, one vulnerability entry at a time. Only npm
 * entries (or ones with no ecosystem) of inventoried packages are read, and withdrawn advisories
 * are ignored. A version is affected by an entry when it satisfies one of the alternatives of the
 * entry's range ({@link vendorRangeText}) and the entry's own patched list does not exempt it
 * under that alternative ({@link isExempt}).
 *
 * Every entry is evaluated as published, including entries of advisories the ledger also records,
 * so a vendor revision that widens a range or adds a package is reported even while the ledger
 * still holds the earlier range. The one exception is an entry a ledger advisory lists verbatim in
 * `vendorEntries`: its normalized ranges replace that exact text, which is how a range the grammar
 * cannot read, or one that over-matches, is reviewed. An unreadable entry that is not listed that
 * way fails closed.
 *
 * @param {Inventory} inventory
 * @param {VendorFeed} feed
 * @param {ReadonlyArray<VendorAdvisory>} advisories
 * @param {Ledger} ledger
 * @param {FindingSet} findings
 * @returns {{ matched: Array<{ id: string, name: string }> }} the advisory and package of every
 *   match
 */
export function evaluateVendorAdvisories(inventory, feed, advisories, ledger, findings) {
  /** @type {Map<string, InventoryEntry[]>} */
  const byName = new Map();
  for (const entry of inventory.entries) {
    byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  }
  /** @type {Map<string, { id: string, name: string }>} */
  const matched = new Map();

  for (const advisory of advisories) {
    if (advisory.withdrawn) continue;
    const ledgerAdvisory = ledgerAdvisoryFor(ledger, advisory);
    const layer =
      ledgerAdvisory === undefined
        ? `vendor feed ${feed.repository} (not in the committed ledger)`
        : `vendor feed ${feed.repository}`;

    for (const vulnerability of advisory.vulnerabilities) {
      const ecosystem = vulnerability.ecosystem ?? '';
      if (ecosystem !== '' && ecosystem.toLowerCase() !== 'npm') continue;
      const name = vulnerability.name;
      const entries = name === null ? undefined : byName.get(name);
      if (name === null || entries === undefined) continue;

      const replaced = ledgerAdvisory?.vendorEntries.some(
        (entry) =>
          entry.package === name &&
          entry.range === (vulnerability.range ?? '') &&
          entry.patched === vulnerability.patched,
      );
      if (replaced === true) continue;

      /** @type {VersionRange} */
      let range;
      try {
        range = parseRange(vendorRangeText(vulnerability));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new AdvisoryCheckError(
          `vendor feed ${feed.repository}: ${advisory.id} (${name}): ${detail}; review the entry and record it verbatim under "vendorEntries" of a ${LEDGER_REL} advisory for ${advisory.id} with normalized "vulnerableRanges"`,
          { cause: error },
        );
      }
      const fixes = parsePatchedVersions(vulnerability.patched);

      for (const entry of entries) {
        const affected = range.alternatives.some(
          (alternative) =>
            alternative.every((comparator) => comparatorAccepts(entry.parsed, comparator)) &&
            !isExempt(entry.parsed, alternative, fixes),
        );
        if (!affected) continue;
        matched.set(`${advisory.id}\0${name}`, { id: advisory.id, name });
        findings.add({
          id: advisory.id,
          aliases: advisory.aliases,
          severity: advisory.severity,
          name,
          version: entry.version,
          origins: entry.origins,
          affected: range.source.trim(),
          patched: fixes.length === 0 ? 'none published' : fixes.map((fix) => fix.text).join(', '),
          source: advisory.source,
          foundBy: [layer],
        });
      }
    }
  }
  return { matched: [...matched.values()] };
}

/**
 * Query OSV for every inventoried version, in batches of at most {@link OSV_BATCH_LIMIT}, following
 * each query's `next_page_token`.
 *
 * @param {Inventory} inventory
 * @param {OnlineContext} context
 * @returns {Promise<Map<InventoryEntry, string[]>>} vulnerability ids per entry that has any
 */
export async function queryOsv(inventory, context) {
  /** @type {Map<InventoryEntry, Set<string>>} */
  const ids = new Map();
  /** @type {Array<{ entry: InventoryEntry, pageToken?: string }>} */
  let pending = inventory.entries.map((entry) => ({ entry }));

  for (let round = 1; pending.length > 0; round += 1) {
    if (round > OSV_MAX_PAGE_ROUNDS) {
      throw new AdvisoryCheckError(`OSV: more than ${String(OSV_MAX_PAGE_ROUNDS)} result pages`);
    }
    /** @type {Array<{ entry: InventoryEntry, pageToken?: string }>} */
    const nextRound = [];
    for (let start = 0; start < pending.length; start += OSV_BATCH_LIMIT) {
      const chunk = pending.slice(start, start + OSV_BATCH_LIMIT);
      const queries = chunk.map(({ entry, pageToken }) => ({
        package: { name: entry.name, ecosystem: 'npm' },
        version: entry.version,
        ...(pageToken === undefined ? {} : { page_token: pageToken }),
      }));
      const response = await requestJson(context, `${OSV_API_ORIGIN}/v1/querybatch`, {
        service: 'OSV',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify({ queries }),
      });
      const results = isPlainObject(response.body) ? response.body.results : undefined;
      if (!Array.isArray(results) || results.length !== chunk.length) {
        throw new AdvisoryCheckError(
          `OSV: querybatch returned ${Array.isArray(results) ? String(results.length) : 'no'} results for ${String(chunk.length)} queries`,
        );
      }
      results.forEach((result, index) => {
        const { entry } = /** @type {{ entry: InventoryEntry }} */ (chunk[index]);
        if (!isPlainObject(result))
          throw new AdvisoryCheckError('OSV: a querybatch result is not an object');
        const vulns = result.vulns ?? [];
        if (!Array.isArray(vulns))
          throw new AdvisoryCheckError('OSV: a querybatch result has non-array vulns');
        for (const vuln of vulns) {
          if (!isPlainObject(vuln) || typeof vuln.id !== 'string' || vuln.id === '') {
            throw new AdvisoryCheckError('OSV: a querybatch vulnerability has no id');
          }
          const set = ids.get(entry) ?? new Set();
          set.add(vuln.id);
          ids.set(entry, set);
        }
        if (typeof result.next_page_token === 'string' && result.next_page_token !== '') {
          nextRound.push({ entry, pageToken: result.next_page_token });
        }
      });
    }
    pending = nextRound;
  }
  return new Map([...ids].map(([entry, set]) => [entry, [...set].sort()]));
}

/**
 * Fetch one OSV record, or `null` when OSV does not carry the id.
 *
 * @param {string} id
 * @param {OnlineContext} context
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchOsvVulnerability(id, context) {
  const response = await requestJson(
    context,
    `${OSV_API_ORIGIN}/v1/vulns/${encodeURIComponent(id)}`,
    { service: 'OSV', headers: { 'User-Agent': USER_AGENT }, allowNotFound: true },
  );
  if (response.body === null) return null;
  if (!isPlainObject(response.body))
    throw new AdvisoryCheckError(`OSV: record ${id} is not an object`);
  return response.body;
}

/**
 * Summarize an OSV record for the finding report: severity, aliases, and the affected intervals
 * and fixed versions it lists for one npm package. OSV range events read in order: `introduced`
 * opens an interval (`0` meaning from the first release), `fixed` closes it exclusively and
 * `last_affected` inclusively.
 *
 * @param {Record<string, unknown> | null} record `null` when OSV does not carry the id
 * @param {string} name
 * @returns {{ severity: string, aliases: string[], affected: string, patched: string }}
 */
function describeOsvRecord(record, name) {
  if (record === null) {
    return { severity: 'unknown', aliases: [], affected: '-', patched: 'unknown' };
  }
  const specific = isPlainObject(record.database_specific) ? record.database_specific : {};
  const severity =
    typeof specific.severity === 'string' ? specific.severity.toLowerCase() : 'unknown';
  const aliases = Array.isArray(record.aliases)
    ? record.aliases.filter((alias) => typeof alias === 'string')
    : [];
  /** @type {string[]} */
  const intervals = [];
  /** @type {Set<string>} */
  const fixed = new Set();
  for (const affected of Array.isArray(record.affected) ? record.affected : []) {
    if (!isPlainObject(affected) || !isPlainObject(affected.package)) continue;
    if (affected.package.name !== name || affected.package.ecosystem !== 'npm') continue;
    for (const range of Array.isArray(affected.ranges) ? affected.ranges : []) {
      if (!isPlainObject(range) || !Array.isArray(range.events)) continue;
      /** @type {string | null} */
      let open = null;
      for (const event of range.events) {
        if (!isPlainObject(event)) continue;
        if (typeof event.introduced === 'string') {
          open = event.introduced === '0' ? '' : `>=${event.introduced}`;
        } else if (typeof event.fixed === 'string') {
          fixed.add(event.fixed);
          intervals.push(`${open ?? ''} <${event.fixed}`.trim());
          open = null;
        } else if (typeof event.last_affected === 'string') {
          intervals.push(`${open ?? ''} <=${event.last_affected}`.trim());
          open = null;
        }
      }
      if (open !== null) intervals.push(open === '' ? '*' : open);
    }
  }
  return {
    severity,
    aliases,
    affected: intervals.length === 0 ? '-' : intervals.join(' || '),
    patched: fixed.size === 0 ? 'none published' : [...fixed].join(', '),
  };
}

// ---------------------------------------------------------------------------
// Reporting and CLI
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Output
 * @property {(text: string) => unknown} write
 */

/**
 * Write one line to a stream.
 *
 * @param {Output} stream
 * @param {string} text
 */
function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

/**
 * Escape a GitHub Actions workflow-command message.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeAnnotation(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * Render one finding as a block of lines.
 *
 * @param {Finding} finding
 * @returns {string}
 */
export function formatFinding(finding) {
  const aliases = finding.aliases.length === 0 ? '' : ` (${finding.aliases.join(', ')})`;
  return [
    `check-advisories: ${finding.id}${aliases} [${finding.severity}] affects ${finding.name}@${finding.version}`,
    `  origins:  ${finding.origins.join('; ')}`,
    `  affected: ${finding.affected}`,
    `  patched:  ${finding.patched}`,
    `  source:   ${finding.source}`,
    `  found by: ${finding.foundBy.join('; ')}`,
  ].join('\n');
}

/**
 * The feed-lag warning for an advisory OSV does not carry.
 *
 * @param {{ id: string, name: string }} advisory
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function formatFeedLagWarning(advisory, env) {
  const message = `${advisory.id} (${advisory.name}) is not in OSV yet, so the aggregated advisory feeds pnpm audit relies on do not carry it; only this check reports it.`;
  return env.GITHUB_ACTIONS === 'true'
    ? `::warning title=Advisory feed lag::${escapeAnnotation(message)}`
    : `warning: ${message}`;
}

/**
 * The `--help` text.
 *
 * @returns {string}
 */
export function usage() {
  return `Usage: node scripts/check-advisories.mjs [--online]

Fails when a version in the tracked pnpm-lock.yaml files, or an exact pin in a tracked
package.json, is covered by a security advisory.

  (always)  match the inventory against ${LEDGER_REL}
  --online  also read the vendor feeds the ledger names from the GitHub API, query OSV for
            every inventoried version, and warn about advisories OSV does not carry yet;
            GITHUB_TOKEN, when set, authenticates the GitHub requests
  --help    print this text

Exit codes: 0 clean, 1 findings, 2 usage, configuration or network error.`;
}

/**
 * @typedef {object} CheckOptions
 * @property {boolean} online
 * @property {boolean} help
 */

/**
 * Parse command-line arguments.
 *
 * @param {ReadonlyArray<string>} argv
 * @returns {CheckOptions}
 */
export function parseArgs(argv) {
  const options = { online: false, help: false };
  for (const arg of argv) {
    if (arg === '--online') options.online = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else
      throw new AdvisoryCheckError(`unknown argument ${JSON.stringify(arg)}`, { showUsage: true });
  }
  return options;
}

/**
 * Print a failure and return its exit code; an error that is not an {@link AdvisoryCheckError} is
 * a defect and also exits 2.
 *
 * @param {unknown} error
 * @param {Output} stderr
 * @returns {number}
 */
function reportFailure(error, stderr) {
  if (error instanceof AdvisoryCheckError) {
    writeLine(stderr, `check-advisories: error: ${error.message}`);
    if (error.showUsage) writeLine(stderr, usage());
    return error.exitCode;
  }
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeLine(stderr, `check-advisories: unexpected error: ${detail}`);
  return EXIT_ERROR;
}

/**
 * @typedef {object} RunOptions
 * @property {string} [root] repository to check
 * @property {boolean} [online] run the online layer
 * @property {string} [ledgerPath] absolute ledger path, default `<root>/scripts/check-advisories.ledger.json`
 * @property {ReadonlyArray<string>} [trackedFiles] repository-relative paths, default `git ls-files`
 * @property {typeof fetch} [fetch]
 * @property {Record<string, string | undefined>} [env]
 * @property {number} [timeoutMs]
 * @property {Output} [stdout]
 * @property {Output} [stderr]
 */

/**
 * Run the check and return its exit code. Findings and the summary go to stdout, warnings and
 * errors to stderr (feed-lag annotations to stdout under GitHub Actions, where the runner reads
 * workflow commands).
 *
 * @param {RunOptions} [options]
 * @returns {Promise<number>}
 */
export async function runCheck(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const ledger = loadLedger(options.ledgerPath ?? path.join(root, LEDGER_REL));
    const inventory = readInventory(root, options.trackedFiles ?? listTrackedFiles(root));
    const findings = new FindingSet();
    evaluateLedger(inventory, ledger, findings);

    for (const item of inventory.unevaluated) {
      writeLine(stderr, `warning: not evaluated (not a registry version): ${item}`);
    }

    let onlineSummary = '';
    if (options.online === true) {
      /** @type {OnlineContext} */
      const context = {
        fetch: options.fetch ?? globalThis.fetch,
        timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        env,
      };
      /** @type {Array<{ id: string, name: string }>} */
      const lagCandidates = ledger.advisories.map((advisory) => ({
        id: advisory.id,
        name: advisory.package,
      }));
      let vendorCount = 0;
      for (const feed of ledger.vendorFeeds) {
        const advisories = await fetchVendorAdvisories(feed, context);
        vendorCount += advisories.length;
        const { matched } = evaluateVendorAdvisories(inventory, feed, advisories, ledger, findings);
        lagCandidates.push(...matched);
      }

      /** @type {Map<string, Record<string, unknown> | null>} */
      const records = new Map();
      const record = async (/** @type {string} */ id) => {
        if (!records.has(id)) records.set(id, await fetchOsvVulnerability(id, context));
        return /** @type {Record<string, unknown> | null} */ (records.get(id));
      };

      const osv = await queryOsv(inventory, context);
      for (const [entry, ids] of osv) {
        for (const id of ids) {
          if (findings.has(id, entry.name, entry.version)) {
            findings.addLayer(id, entry.name, entry.version, 'OSV');
            continue;
          }
          const described = describeOsvRecord(await record(id), entry.name);
          findings.add({
            id,
            aliases: described.aliases,
            severity: described.severity,
            name: entry.name,
            version: entry.version,
            origins: entry.origins,
            affected: described.affected,
            patched: described.patched,
            source: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
            foundBy: ['OSV'],
          });
        }
      }

      for (const candidate of lagCandidates) {
        if ((await record(candidate.id)) !== null) continue;
        const line = formatFeedLagWarning(candidate, env);
        writeLine(env.GITHUB_ACTIONS === 'true' ? stdout : stderr, line);
      }

      const feeds = ledger.vendorFeeds.map((feed) => feed.repository).join(', ') || 'none';
      onlineSummary = `; online: ${String(vendorCount)} vendor advisories (${feeds}) and OSV`;
    }

    for (const finding of findings.list()) writeLine(stdout, formatFinding(finding));

    const scope = `${String(inventory.entries.length)} package versions (${String(inventory.lockedCount)} locked in ${String(inventory.lockfileCount)} lockfile(s), ${String(inventory.pinCount)} exact pins in ${String(inventory.manifestCount)} manifest(s)) against ${String(ledger.advisories.length)} ledger ${ledger.advisories.length === 1 ? 'advisory' : 'advisories'}${onlineSummary}`;
    if (findings.size > 0) {
      writeLine(
        stdout,
        `check-advisories: FAIL - ${String(findings.size)} finding(s) across ${scope}`,
      );
      return EXIT_FINDINGS;
    }
    writeLine(stdout, `check-advisories: ok - no advisory affects ${scope}`);
    return EXIT_OK;
  } catch (error) {
    return reportFailure(error, stderr);
  }
}

/**
 * CLI entry point.
 *
 * @param {ReadonlyArray<string>} [argv]
 * @param {Omit<RunOptions, 'online'>} [dependencies] injectable for tests
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const stderr = dependencies.stderr ?? process.stderr;
  /** @type {CheckOptions} */
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return reportFailure(error, stderr);
  }
  if (options.help) {
    writeLine(dependencies.stdout ?? process.stdout, usage());
    return EXIT_OK;
  }
  return runCheck({ ...dependencies, online: options.online });
}

/**
 * Resolve the process entry path through symlinks so it compares with `import.meta.url`.
 *
 * @param {string} entry
 * @returns {string}
 */
function resolveEntryPath(entry) {
  try {
    return fs.realpathSync(entry);
  } catch {
    return path.resolve(entry);
  }
}

/**
 * Whether this module is the process entry point, so importing it never runs the CLI.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  return import.meta.url === pathToFileURL(resolveEntryPath(entry)).href;
}

if (isEntryPoint()) {
  // `process.exitCode` rather than `process.exit()` so buffered output is flushed first.
  process.exitCode = await main(process.argv.slice(2));
}
