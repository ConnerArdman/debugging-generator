/**
 * Tests for the one dev-server URL contract two request bodies share: the
 * address an editor sends with `session.create` (`../messages/session.ts`) and
 * with `devServer.launch` (`../http.ts`).
 *
 * The service probes that address itself before it uses it, so the transport
 * checks only what a transport can: an absolute `http:`/`https:` URL, bounded
 * in length, with no embedded user name or password — and it must check
 * exactly the same thing in both bodies, which is why both use one schema
 * object. The launch body also names the session a launched dev server is tied
 * to.
 */

import { describe, expect, it } from 'vitest';

import { devServerLaunchRequestSchema } from '../http.js';
import { devServerUrlSchema, sessionCreateRequestSchema } from '../messages/session.js';

/** The longest URL accepted, as `../messages/session.ts` bounds it. */
const MAX_LENGTH = 2048;

/** A URL with embedded credentials, assembled so none is written out in the tree. */
const WITH_USER_INFO = ['http://dev', 'pw@127.0.0.1:3000/'].join(':');

describe('devServerUrlSchema', () => {
  it.each(['http://127.0.0.1:3000/', 'http://localhost:3000', 'https://127.0.0.1:8443/app'])(
    'accepts %s',
    (url) => {
      expect(devServerUrlSchema.safeParse(url).success).toBe(true);
    },
  );

  it.each([
    { label: 'another scheme', url: 'ftp://127.0.0.1:3000/' },
    { label: 'a relative path', url: '/checkout' },
    { label: 'embedded credentials', url: WITH_USER_INFO },
    { label: 'an over-long URL', url: `http://127.0.0.1:3000/${'a'.repeat(MAX_LENGTH)}` },
  ])('refuses $label', ({ url }) => {
    expect(devServerUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe('devServer.launch request', () => {
  const projectRoot = '/work/storefront';

  it('carries the configured address and the session, both optional', () => {
    expect(devServerLaunchRequestSchema.safeParse({ projectRoot }).success).toBe(true);
    const parsed = devServerLaunchRequestSchema.safeParse({
      projectRoot,
      sessionId: 'ses_launch01',
      devServerUrl: 'http://127.0.0.1:3000/',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ devServerUrl: 'http://127.0.0.1:3000/' });
  });

  it('refuses an address the session body would refuse too', () => {
    for (const devServerUrl of [WITH_USER_INFO, 'ftp://127.0.0.1:3000/']) {
      expect(devServerLaunchRequestSchema.safeParse({ projectRoot, devServerUrl }).success).toBe(
        false,
      );
      expect(
        sessionCreateRequestSchema.safeParse({
          projectRoot,
          question: 'Why is the page slow?',
          devServerUrl,
        }).success,
      ).toBe(false);
    }
  });
});
