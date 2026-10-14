/**
 * The `GET /health` identity proof, asserted against the **real service**:
 * `startService` on an ephemeral port through the integration harness, its
 * own `auth.json`, its own access middleware in front of the route, and Node's
 * `fetch` on the wire.
 *
 * What this suite owns: that the composition root hands the route the
 * configuration it needs — the bound host and port (not the `0` it was asked
 * for) and the `auth.json` path — so a challenging client can authenticate the
 * running service with the editor credential it holds, before disclosing it;
 * that a rotation re-keys the proof; that a listener relaying the challenge
 * from another port cannot pass the check; and that the origin policy still
 * refuses a web page before any proof is computed. The proof's construction,
 * challenge grammar and every file-state refusal are pinned by
 * `src/server/routes/health.test.ts`.
 *
 * Every proof is recomputed here independently with `node:crypto` over the
 * contract message written out as literals. Challenges are minted at run
 * time; the editor credential is the one the service itself wrote.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HTTP_ROUTES, PROTOCOL_VERSION } from '@debuggen/protocol';

import { startHarness } from './harness.js';
import type { Harness, RawFetchResponse } from './harness.js';

/** The contract's request header, written out rather than imported. */
const CHALLENGE_HEADER = 'X-Debuggen-Identity-Challenge';

/** The contract's proof header. */
const PROOF_HEADER = 'X-Debuggen-Identity-Proof';

/** The contract's endpoint header. */
const ENDPOINT_HEADER = 'X-Debuggen-Identity-Endpoint';

/** The contract's label. */
const LABEL = 'debuggen-service-identity/v1';

/** A web origin, which the access boundary refuses on every route. */
const WEB_ORIGIN = 'https://example.invalid';

/** How long the relay waits for the service it forwards to. */
const RELAY_TIMEOUT_MS = 5_000;

/** A fresh 32-byte challenge, as the CLI draws it. */
function newChallenge(): string {
  return randomBytes(32).toString('base64url');
}

/** The endpoint string for a host and port, as the contract canonicalises it. */
function endpointOf(host: string, port: number): string {
  const normalized = host.trim().toLowerCase();
  const authority =
    normalized.includes(':') && !normalized.startsWith('[') ? `[${normalized}]` : normalized;
  return `${authority}:${String(port)}`;
}

/** The proof, computed independently of the service. */
function expectedProof(token: string, challenge: string, endpoint: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8'))
    .update(Buffer.from(`${LABEL}\n${challenge}\n${endpoint}`, 'utf8'))
    .digest('base64url');
}

let harness: Harness | undefined;

/** The running harness. @throws Error When `beforeAll` did not start one. */
function running(): Harness {
  if (harness === undefined) {
    throw new Error('The harness did not start.');
  }
  return harness;
}

/** Sends `GET /health` to the real service, challenged when a challenge is given. */
function probe(challenge?: string, origin?: string): Promise<RawFetchResponse> {
  return running().rawFetch('health', {
    ...(challenge === undefined ? {} : { headers: { [CHALLENGE_HEADER]: challenge } }),
    ...(origin === undefined ? {} : { origin }),
  });
}

/** Asserts that no header or body of `response` carries `token` or its SHA-256. */
function expectNoCredential(response: RawFetchResponse, token: string): void {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  const surfaces = [
    [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n'),
    response.text,
  ];
  for (const surface of surfaces) {
    for (const value of [token, digest.toString('hex'), digest.toString('base64url')]) {
      expect(surface.includes(value)).toBe(false);
    }
  }
}

beforeAll(async () => {
  harness = await startHarness({ fixtureProject: false });
});

afterAll(async () => {
  // `harness` stays unset when `startHarness` itself failed; there is nothing to stop then.
  if (harness === undefined) {
    return;
  }
  const report = await harness.stop();
  expect(report.problems).toEqual([]);
  await harness.assertNoLeaks();
});

describe('GET /health on the running service', () => {
  it('answers a plain probe with the protocol body and no identity header', async () => {
    const response = await probe();
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    expect(Object.keys(response.json as object).sort()).toEqual([
      'pairingAvailable',
      'protocolVersion',
      'version',
    ]);
    expect(response.headers.get(PROOF_HEADER)).toBeNull();
    expect(response.headers.get(ENDPOINT_HEADER)).toBeNull();
  });

  it('proves the editor credential in auth.json, bound to the port it actually bound', async () => {
    const h = running();
    const challenge = newChallenge();

    const response = await probe(challenge);

    const endpoint = endpointOf(h.config.host, h.port);
    // The harness asks for an ephemeral port; the proof names the bound one.
    expect(h.port).toBeGreaterThan(0);
    expect(h.config.port).toBe(h.port);
    expect(response.status).toBe(200);
    expect(response.headers.get(ENDPOINT_HEADER)).toBe(endpoint);
    expect(response.headers.get(PROOF_HEADER)).toBe(
      expectedProof(h.editorToken, challenge, endpoint),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    // The body is the plain probe's.
    expect(response.text).toBe((await probe()).text);
    expectNoCredential(response, h.editorToken);
  });

  it('re-keys the proof when the credentials are rotated', async () => {
    const h = running();
    const challenge = newChallenge();
    const endpoint = endpointOf(h.config.host, h.port);
    const before = h.editorToken;

    const earlier = await probe(challenge);
    expect(earlier.headers.get(PROOF_HEADER)).toBe(expectedProof(before, challenge, endpoint));

    h.rotateAll();
    const after = h.editorToken;
    expect(after).not.toBe(before);

    const later = await probe(challenge);
    expect(later.headers.get(PROOF_HEADER)).toBe(expectedProof(after, challenge, endpoint));
    expect(later.headers.get(PROOF_HEADER)).not.toBe(expectedProof(before, challenge, endpoint));
    expectNoCredential(later, after);
    expectNoCredential(later, before);
  });

  it('gives a listener that relays the challenge from another port nothing a client accepts', async () => {
    const h = running();
    const serviceUrl = new URL(HTTP_ROUTES.health.pattern, h.url);

    // A stand-in for another local process on another port: it forwards the
    // client's challenge to the real service and copies the identity headers back.
    const relay = createServer((request, response) => {
      const challenge = request.headers[CHALLENGE_HEADER.toLowerCase()];
      void fetch(serviceUrl, {
        headers: typeof challenge === 'string' ? { [CHALLENGE_HEADER]: challenge } : {},
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      }).then(
        async (upstream) => {
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          for (const name of [PROOF_HEADER, ENDPOINT_HEADER]) {
            const value = upstream.headers.get(name);
            if (value !== null) {
              headers[name] = value;
            }
          }
          response.writeHead(upstream.status, headers).end(await upstream.text());
        },
        () => {
          response.writeHead(502).end();
        },
      );
    });
    await new Promise<void>((resolve) => {
      relay.listen(0, h.config.host, resolve);
    });

    try {
      const relayPort = (relay.address() as AddressInfo).port;
      const dialled = endpointOf(h.config.host, relayPort);
      const challenge = newChallenge();

      const response = await fetch(`http://${dialled}${HTTP_ROUTES.health.pattern}`, {
        headers: { [CHALLENGE_HEADER]: challenge },
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      await response.text();

      const relayedProof = response.headers.get(PROOF_HEADER);
      expect(response.status).toBe(200);
      // The relay obtained a real proof — for the service's endpoint, not its own.
      expect(relayedProof).not.toBeNull();
      expect(response.headers.get(ENDPOINT_HEADER)).toBe(endpointOf(h.config.host, h.port));
      expect(response.headers.get(ENDPOINT_HEADER)).not.toBe(dialled);
      // A client verifying against the endpoint it dialled refuses it.
      expect(relayedProof).not.toBe(expectedProof(h.editorToken, challenge, dialled));
    } finally {
      await new Promise<void>((resolve, reject) => {
        relay.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
  });

  it('still refuses a web origin before any proof is computed', async () => {
    const response = await probe(newChallenge(), WEB_ORIGIN);
    expect(response.status).toBe(403);
    expect(response.headers.get(PROOF_HEADER)).toBeNull();
    expect(response.headers.get(ENDPOINT_HEADER)).toBeNull();
  });

  it('logs neither the credential nor the challenge while answering challenges', async () => {
    const h = running();
    const challenge = newChallenge();
    await probe(challenge);
    await probe('too-short');
    const logged = h.logger.text();
    expect(logged.includes(h.editorToken)).toBe(false);
    expect(logged.includes(challenge)).toBe(false);
  });
});
