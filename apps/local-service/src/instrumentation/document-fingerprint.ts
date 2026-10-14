/**
 * What the service may write to a log about the page agent's per-document id.
 *
 * ## Why the raw id never reaches a log
 *
 * `agent.ready.documentId` is minted inside the inspected page: the MAIN-world
 * telemetry agent draws it as `doc_` followed by sixteen characters of
 * `[0-9a-z]` (`packages/telemetry/src/browser/ids.ts`), and the Chrome service
 * worker relays it to the service. The protocol validates it only as a
 * non-empty string of at most 64 characters
 * (`packages/protocol/src/messages/agent.ts`), and any script running in the
 * page can shape the frames the content bridge relays, so the value the service
 * receives is page-controlled text. Logged as is, a forged id such as
 * `/account?token=…` would carry private page data into the service log — at
 * `info` on the reload path, where it is written with debug logging off
 * (CWE-532, AAP §0.5.2).
 *
 * The raw id stays exactly where it is needed: in the readiness ledger's state,
 * in a verdict's `reload-page` remediation and in the `afterDocumentId`
 * comparison that tells a reloaded document from a replay of the old one. Only
 * log lines change. Every log site that concerns a document writes
 * {@link documentLogFields} in place of the id:
 *
 * - `document` — {@link fingerprintDocumentId}'s fixed-length digest, enough to
 *   tell two documents apart, and to follow one document, within one log;
 * - `documentIdCanonical` — whether the id had the agent's minted shape
 *   ({@link isCanonicalDocumentId}), so a malformed or forged id is diagnosable
 *   without any of its text being written.
 *
 * ## Construction, and the trade-off it makes
 *
 * The digest is HMAC-SHA256 under a 32-byte key drawn from the operating
 * system's CSPRNG the first time a fingerprint is needed and held only in this
 * process's memory; the log carries a fixed prefix and the first sixteen
 * hexadecimal digits (64 bits). A plain SHA-256 would let anyone holding the log
 * confirm a guess at a low-entropy forged value — a PIN, an e-mail address — by
 * hashing candidates; a keyed digest cannot be checked that way, because the
 * key is never written anywhere. The price is that fingerprints are stable only
 * for the life of one service process: the same document fingerprints
 * differently after a restart. That is the span over which a document id means
 * anything to the service — the agent-readiness ledger that holds the ids is
 * itself in memory — so nothing a developer can correlate is lost. The Chrome
 * surfaces fingerprint the same ids with their own construction
 * (`fingerprintPageId` in `apps/chrome-extension/src/shared/messages.ts`); the
 * two logs are separate processes and are not joined by fingerprint.
 *
 * Every function here is pure apart from that lazily drawn key, total (none
 * throws, whatever it is given) and synchronous, so any log site can call it
 * inline. Importing the module does no work: no key is drawn, no environment
 * variable is read and no global is touched until the first call.
 *
 * @example
 * ```ts
 * log.info('Asked the developer to reload the bound tab', {
 *   tabId: reload.tabId,
 *   ...documentLogFields(reload.documentId),
 * });
 * // → { tabId: 7, document: 'docfp_3f9c0a1b2d4e5f60', documentIdCanonical: true }
 * ```
 *
 * @module
 */

import { hmacSha256Hex } from '@debuggen/shared/node';

import { randomBytes } from 'node:crypto';

/** The fixed prefix of every document fingerprint, so a log reader can tell one on sight. */
export const DOCUMENT_FINGERPRINT_PREFIX = 'docfp_';

/**
 * How many hexadecimal digits of the digest a fingerprint keeps: 64 bits, which
 * makes an accidental collision between two documents in one log negligible
 * while keeping every fingerprint the same short length.
 */
export const DOCUMENT_FINGERPRINT_HEX_LENGTH = 16;

/**
 * What {@link fingerprintDocumentId} returns for a value that is not a string.
 * Never equal to a digest fingerprint: `none` is not hexadecimal.
 */
export const DOCUMENT_FINGERPRINT_NONE = `${DOCUMENT_FINGERPRINT_PREFIX}none`;

/**
 * The shape the page agent mints a document id in: the `doc` kind prefix, an
 * underscore and sixteen digits or lowercase letters — the repository's opaque
 * id shape (`packages/shared/src/ids.ts`) with the one prefix that has no entry
 * in `ID_PREFIXES`, because a document id never becomes a store key.
 */
const CANONICAL_DOCUMENT_ID = /^doc_[0-9a-z]{16}$/;

/** The size of the per-process fingerprint key, in bytes: 256 bits, SHA-256's own output size. */
const FINGERPRINT_KEY_BYTES = 32;

/**
 * The per-process HMAC key, drawn on first use. Never exported, logged or
 * persisted; see the module overview for why it is keyed and per-process.
 */
let fingerprintKey: Uint8Array | undefined;

/** Returns the per-process key, drawing it from the CSPRNG the first time. */
function processFingerprintKey(): Uint8Array {
  fingerprintKey ??= randomBytes(FINGERPRINT_KEY_BYTES);
  return fingerprintKey;
}

/**
 * A short, log-safe stand-in for a page-supplied document id.
 *
 * For a string: {@link DOCUMENT_FINGERPRINT_PREFIX} followed by the first
 * {@link DOCUMENT_FINGERPRINT_HEX_LENGTH} lowercase hexadecimal digits of its
 * HMAC-SHA256 under this process's key — the same value every time within one
 * process, a different value for a different id, and always the same length,
 * so a page can neither write into a log line through it nor grow one. For
 * anything else: {@link DOCUMENT_FINGERPRINT_NONE}.
 *
 * The id is hashed as its UTF-8 encoding, so two malformed ids that differ only
 * in unpaired surrogate code units share a fingerprint; both are reported
 * non-canonical by {@link isCanonicalDocumentId}, and a canonical id is plain
 * ASCII, so no id the agent mints is affected.
 *
 * @param value A page-supplied `documentId`, of any type.
 * @returns The fingerprint; never the value itself, and never throws.
 *
 * @example
 * ```ts
 * fingerprintDocumentId('doc_0123456789abcdef'); // → 'docfp_' + 16 hex digits
 * fingerprintDocumentId(undefined);              // → 'docfp_none'
 * ```
 */
export function fingerprintDocumentId(value: unknown): string {
  if (typeof value !== 'string') {
    return DOCUMENT_FINGERPRINT_NONE;
  }

  const digest = hmacSha256Hex(processFingerprintKey(), value);

  return `${DOCUMENT_FINGERPRINT_PREFIX}${digest.slice(0, DOCUMENT_FINGERPRINT_HEX_LENGTH)}`;
}

/**
 * Whether a value has the exact shape the page agent mints a document id in
 * (`doc_` and sixteen of `[0-9a-z]`).
 *
 * A shape check, not an authentication: a page script can forge a well-formed
 * id too, which is why even a canonical id is fingerprinted before it is
 * logged. What the check adds is a diagnosis — an id of any other shape was not
 * produced by the product's agent.
 *
 * @param value A page-supplied `documentId`, of any type.
 * @returns `true` only for a string of the canonical shape.
 */
export function isCanonicalDocumentId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_DOCUMENT_ID.test(value);
}

/** The fields a log line carries about one document, in place of its id. */
export interface DocumentLogFields {
  /** {@link fingerprintDocumentId} of the id. */
  readonly document: string;
  /** {@link isCanonicalDocumentId} of the id. */
  readonly documentIdCanonical: boolean;
}

/**
 * The log fields that describe a document without naming it, ready to spread
 * into a log call's fields.
 *
 * `undefined` — no document is known, as for a reload requested before any page
 * agent reported — yields no fields at all, so the line says nothing about a
 * document rather than fingerprinting an absence. Any other value yields both
 * {@link DocumentLogFields} members.
 *
 * @param documentId A page-supplied `documentId`, or `undefined` when none is known.
 * @returns Both fields, or none.
 *
 * @example
 * ```ts
 * log.debug('recorded a page-agent readiness report', {
 *   tabId: payload.tabId,
 *   ...documentLogFields(payload.documentId),
 * });
 * ```
 */
export function documentLogFields(documentId: unknown): Partial<DocumentLogFields> {
  if (documentId === undefined) {
    return {};
  }

  return {
    document: fingerprintDocumentId(documentId),
    documentIdCanonical: isCanonicalDocumentId(documentId),
  };
}
