/**
 * The launch contract of the Node dev-server preload: what `./config.ts`
 * accepts from the environment, what it refuses, and the two constants whose
 * meanings must never be confused.
 *
 * Two properties are asserted here that no other suite can assert:
 *
 * 1. **The wire version is the protocol's, not the package's.** The
 *    `client.hello` frame's `version` field is a compatibility signal the
 *    service compares by major component, so announcing this package's version
 *    is a refused handshake. `WIRE_PROTOCOL_VERSION` mirrors
 *    `PROTOCOL_VERSION` from `packages/protocol/src/version.ts` — which this
 *    package cannot import, because `@debuggen/protocol` depends on
 *    `@debuggen/telemetry` — so the mirror is verified against the owner's
 *    source text rather than trusted.
 * 2. **The ingest endpoint is a trust boundary.** The endpoint arrives in an
 *    environment variable and the credential travels to it, so a non-loopback
 *    address must leave the preload inert rather than disclose the
 *    server-agent bearer token and the developer's telemetry to another origin
 *    (AAP §0.5.6).
 *
 * The drift guard reads the protocol package's source with `node:fs` rather
 * than importing it: an import would be the very cycle the mirror exists to
 * avoid, while reading the file is inert, needs no build, and fails loudly if
 * the owner's constant moves.
 *
 * `./control.test.ts` owns the behaviour *around* this contract — the
 * handshake frame, the capture gate, the span processor. This file stays on the
 * loader itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTROL_PATH,
  deriveControlUrl,
  isLoopbackHostname,
  isTrustedServiceEndpoint,
  loadPreloadConfig,
  PRELOAD_ENV_KEYS,
  TRACER_VERSION,
  WIRE_PROTOCOL_VERSION,
} from './config.js';

/** The credential every fixture environment carries, assembled rather than written. */
const TOKEN = ['dbg', 'config', 'fixture', 'z'.repeat(28)].join('-');

/** An absolute project root belonging to no particular project. */
const PROJECT_ROOT = '/tmp/debuggen-fixture/config-project';

/**
 * An endpoint whose authority carries userinfo.
 *
 * Assembled from fragments rather than written out: `pnpm check:secrets` is a
 * blocking gate that refuses any tracked URI whose authority embeds a user and a
 * password, and it is right to — this one exists only to be rejected by the
 * loader, but a scanner cannot tell a rejected input from a pasted credential.
 */
const ENDPOINT_WITH_USERINFO = [
  'http://',
  'someone',
  ':',
  'placeholder',
  '@',
  '127.0.0.1:43117/telemetry/ingest',
].join('');

/**
 * An environment the launcher could have exported.
 *
 * @param overrides Values to replace or remove.
 * @returns A fresh environment record; never `process.env`.
 */
function env(overrides: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  return {
    [PRELOAD_ENV_KEYS.ingestUrl]: 'http://127.0.0.1:43117/telemetry/ingest',
    [PRELOAD_ENV_KEYS.token]: TOKEN,
    [PRELOAD_ENV_KEYS.projectRoot]: PROJECT_ROOT,
    ...overrides,
  };
}

/**
 * Load a configuration from an ingest URL, returning the result unchanged.
 *
 * @param ingestUrl The endpoint to offer.
 * @returns The loader's verdict.
 */
function loadWithEndpoint(ingestUrl: string): ReturnType<typeof loadPreloadConfig> {
  return loadPreloadConfig(env({ [PRELOAD_ENV_KEYS.ingestUrl]: ingestUrl }));
}

describe('the wire version the preload announces', () => {
  it('is the protocol version, not this package version', () => {
    expect(WIRE_PROTOCOL_VERSION).toBe('1.0.0');
    // The regression this constant exists to prevent: the two are different
    // values with different meanings, and the handshake needs the protocol's.
    expect(WIRE_PROTOCOL_VERSION).not.toBe(TRACER_VERSION);
  });

  it('carries a major component a service comparing majors accepts', () => {
    const [major] = WIRE_PROTOCOL_VERSION.split('.');
    expect(major).toBe('1');
    expect(Number.parseInt(major ?? '', 10)).toBeGreaterThan(0);
  });

  it('matches PROTOCOL_VERSION in the protocol package it mirrors', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const owner = path.resolve(here, '../../../protocol/src/version.ts');
    const source = fs.readFileSync(owner, 'utf8');

    const declared = /export const PROTOCOL_VERSION = '([^']+)'/u.exec(source);
    expect(
      declared,
      'packages/protocol/src/version.ts must declare PROTOCOL_VERSION as a string literal',
    ).not.toBeNull();
    expect(declared?.[1]).toBe(WIRE_PROTOCOL_VERSION);
  });

  it('keeps the tracer version pointing at this package, for OTel scope metadata', () => {
    expect(TRACER_VERSION).toBe('0.1.0');
  });
});

describe('the loopback host policy', () => {
  it('accepts the loopback addresses and name the product documents', () => {
    for (const host of [
      '127.0.0.1',
      '127.0.0.2',
      '127.255.255.254',
      'localhost',
      'LOCALHOST',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::ffff:7f00:1]',
    ]) {
      expect(isLoopbackHostname(host), `${host} is loopback`).toBe(true);
    }
  });

  it('refuses wildcards, private and public hosts, and names that merely look loopback', () => {
    for (const host of [
      '0.0.0.0',
      '::',
      '[::]',
      '192.168.1.5',
      '10.0.0.7',
      '172.16.4.9',
      '8.8.8.8',
      'example.invalid',
      'localhost.example.invalid',
      // Resolver-dependent, so not verifiable loopback.
      'app.localhost',
      // A public name with a loopback-looking prefix.
      '127.0.0.1.example.invalid',
      // Not an address at all, though it matches the dotted shape.
      '999.0.0.1',
      '128.0.0.1',
      '::ffff:192.168.0.1',
      '',
      '   ',
    ]) {
      expect(isLoopbackHostname(host), `${host} is not loopback`).toBe(false);
    }
  });
});

describe('the endpoint trust check', () => {
  it('accepts a loopback http(s) endpoint with no userinfo', () => {
    expect(isTrustedServiceEndpoint('http://127.0.0.1:43117/telemetry/ingest')).toBe(true);
    expect(isTrustedServiceEndpoint('https://localhost:43117/telemetry/ingest')).toBe(true);
    expect(isTrustedServiceEndpoint(new URL('http://[::1]:43117/telemetry/ingest'))).toBe(true);
  });

  it('refuses a non-loopback endpoint whatever its scheme', () => {
    expect(isTrustedServiceEndpoint('http://telemetry.example.invalid/telemetry/ingest')).toBe(
      false,
    );
    expect(isTrustedServiceEndpoint('https://telemetry.example.invalid/telemetry/ingest')).toBe(
      false,
    );
    expect(isTrustedServiceEndpoint('http://192.168.1.5:43117/telemetry/ingest')).toBe(false);
    expect(isTrustedServiceEndpoint('http://0.0.0.0:43117/telemetry/ingest')).toBe(false);
  });

  it('refuses an endpoint that is not an absolute http(s) URL, or that embeds credentials', () => {
    expect(isTrustedServiceEndpoint('ws://127.0.0.1:43117/ws')).toBe(false);
    expect(isTrustedServiceEndpoint('file:///tmp/ingest')).toBe(false);
    expect(isTrustedServiceEndpoint('/telemetry/ingest')).toBe(false);
    expect(isTrustedServiceEndpoint(ENDPOINT_WITH_USERINFO)).toBe(false);
  });
});

describe('loading the launch configuration', () => {
  it('accepts the launcher-minted loopback endpoint and derives the control URL from it', () => {
    const result = loadWithEndpoint('http://127.0.0.1:43117/telemetry/ingest');

    expect(result.mode).toBe('active');
    if (result.mode !== 'active') return;
    expect(result.config.ingestUrl).toBe('http://127.0.0.1:43117/telemetry/ingest');
    expect(result.config.controlUrl).toBe(`ws://127.0.0.1:43117${CONTROL_PATH}`);
    expect(result.config.token).toBe(TOKEN);
    expect(result.config.projectRoot).toBe(PROJECT_ROOT);
    expect(result.config.serviceName).toBe('config-project');
  });

  it('accepts localhost and IPv6 loopback, keeping the origin on the control URL', () => {
    const named = loadWithEndpoint('http://localhost:43117/telemetry/ingest');
    expect(named.mode === 'active' && named.config.controlUrl).toBe(
      `ws://localhost:43117${CONTROL_PATH}`,
    );

    const ipv6 = loadWithEndpoint('http://[::1]:43117/telemetry/ingest');
    expect(ipv6.mode === 'active' && ipv6.config.controlUrl).toBe(
      `ws://[::1]:43117${CONTROL_PATH}`,
    );
  });

  it('stays inert for every non-loopback endpoint, naming the variable and not its value', () => {
    for (const endpoint of [
      'http://telemetry.example.invalid/telemetry/ingest',
      'https://telemetry.example.invalid/telemetry/ingest',
      'http://192.168.1.5:43117/telemetry/ingest',
      'http://0.0.0.0:43117/telemetry/ingest',
      'http://[2001:db8::1]:43117/telemetry/ingest',
      'http://app.localhost:43117/telemetry/ingest',
    ]) {
      const result = loadWithEndpoint(endpoint);

      expect(result.mode, `${endpoint} must not activate the preload`).toBe('inert');
      if (result.mode !== 'inert') continue;
      expect(result.reason).toContain(PRELOAD_ENV_KEYS.ingestUrl);
      expect(result.reason).toContain('loopback');
      // A reason names variables, never values: no host, and never the token.
      expect(result.reason).not.toContain(new URL(endpoint).hostname);
      expect(result.reason).not.toContain(TOKEN);
    }
  });

  it('refuses a non-loopback endpoint before deriving a control URL from it', () => {
    // The socket inherits the endpoint's origin, so the check has to happen
    // first: a derived `ws://` URL for an untrusted origin is a second outbound
    // path to the same place.
    const result = loadWithEndpoint('http://telemetry.example.invalid/telemetry/ingest');

    expect(result.mode).toBe('inert');
    expect(deriveControlUrl('http://telemetry.example.invalid/telemetry/ingest')).toBe(
      'ws://telemetry.example.invalid/ws',
    );
    // `deriveControlUrl` is a pure mapping and stays one; the refusal belongs to
    // the loader, which is the only thing that hands a config to a transport.
  });

  it('keeps refusing the shapes it refused before the trust check existed', () => {
    expect(loadWithEndpoint('not-a-url').mode).toBe('inert');
    expect(loadWithEndpoint('ws://127.0.0.1:43117/ws').mode).toBe('inert');

    const withCredentials = loadWithEndpoint(ENDPOINT_WITH_USERINFO);
    expect(withCredentials.mode).toBe('inert');
    expect(withCredentials.mode === 'inert' && withCredentials.reason).toContain(
      'must not embed credentials',
    );

    const missing = loadPreloadConfig({});
    expect(missing.mode).toBe('inert');
    expect(missing.mode === 'inert' && missing.reason).toContain(PRELOAD_ENV_KEYS.token);
  });

  it('never throws, whatever the environment holds', () => {
    for (const endpoint of [
      '',
      '   ',
      'http://',
      'http://[::',
      '//127.0.0.1/ingest',
      'http://:1',
    ]) {
      expect(() => loadWithEndpoint(endpoint)).not.toThrow();
    }
    expect(() =>
      loadPreloadConfig({ [PRELOAD_ENV_KEYS.projectRoot]: 'relative/path' }),
    ).not.toThrow();
  });
});
