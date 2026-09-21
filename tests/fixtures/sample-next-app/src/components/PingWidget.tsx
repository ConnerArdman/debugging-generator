'use client';

import { useState } from 'react';

/**
 * Shape of the `GET /api/ping` response this component reads.
 *
 * `reply` is typed as `unknown` rather than `string` on purpose: the body of a `Response` is
 * untyped at compile time, so the value is narrowed at runtime before it reaches state instead of
 * being trusted here. Any other field the route sends is ignored.
 */
type PingReply = { reply?: unknown };

/**
 * A button that calls `GET /api/ping` once per click and renders the reply.
 *
 * This is the only interactive component of this application, and the contract it publishes to the
 * rest of it is deliberately small:
 *
 *   - it calls the same-origin, relative endpoint `/api/ping` (`app/api/ping/route.ts`), which
 *     answers HTTP 200 with a JSON body carrying a string `reply` field after a short delay;
 *   - it is a named export imported by relative path - `import { PingWidget } from
 *     '../src/components/PingWidget'` - because this project configures no path alias;
 *   - it owns two stable locators: `data-testid="ping-button"`, the button labelled `Run check`,
 *     and `data-testid="ping-result"`, a `role="status"` region present in the document at all
 *     times so it can be queried before, during and after a request.
 *
 * Nothing is requested on mount and nothing is requested on a re-render: one click is exactly one
 * request, which is what makes a single click a self-contained unit of work to observe.
 */
export function PingWidget() {
  const [reply, setReply] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * Runs one request and publishes its outcome.
   *
   * The state updates are split across the `await` deliberately. The first pair runs synchronously
   * while the click is still being handled; the update that carries the reply runs in the tail of
   * the `await`, after the response has settled, so the re-render it causes is a consequence of the
   * response rather than of the click. Setting the reply before the request, or moving it into an
   * effect or a transition, would erase that distinction.
   *
   * `cache: 'no-store'` keeps every click on the network - a cached response would make the second
   * and later clicks produce no request at all - and the `finally` clause is what guarantees the
   * button comes back even when the request rejects.
   */
  async function handlePingClick() {
    setPending(true);
    setReply(null);
    try {
      const res = await fetch('/api/ping', { cache: 'no-store' });
      const payload: PingReply = await res.json();
      setReply(typeof payload.reply === 'string' ? payload.reply : 'Check failed');
    } catch {
      setReply('Check failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <button type="button" data-testid="ping-button" disabled={pending} onClick={handlePingClick}>
        Run check
      </button>
      <p data-testid="ping-result" role="status">
        {pending ? 'Waiting for reply' : (reply ?? '')}
      </p>
    </section>
  );
}
