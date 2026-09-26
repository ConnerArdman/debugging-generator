'use client';

/*
 * Lumen Supply - the storefront's error boundary.
 *
 * React hands this component any route beneath the root layout whose content could not be
 * rendered: the catalog, a product page, the cart, checkout, the order list, the inventory
 * dashboard. It is what a buyer sees when a page cannot be produced - a warehouse query that did
 * not answer, a service that threw, a payload that failed its own validation on the way back - and
 * its whole job is to say so plainly, offer the two ways out that actually exist, and leave the
 * rest of the store usable.
 *
 * A CLIENT COMPONENT, BECAUSE THE CONTRACT SAYS SO
 * `'use client'` is the first line because Next.js mounts this file as a real React error boundary
 * in the browser, and the `reset` function it passes is a client callback: a server component here
 * fails the build rather than degrading. The directive is the only thing that makes this a client
 * module. It holds no state, starts no effect, subscribes to nothing, reads no clock and draws no
 * random value, so the markup streamed for a failed route and the markup the browser produces
 * after hydration are the same, and there is nothing here that can re-render between them.
 *
 * WHAT IT DELIBERATELY DOES NOT RENDER
 * The document element and its body belong to the root layout. A boundary that replaced the
 * document shell as well would be `app/global-error.tsx`, which this application deliberately does
 * not have: a failure inside one page is no reason to take the header, navigation and footer away
 * from the reader, and keeping them is exactly what lets a buyer leave this page by any route in
 * the site chrome. `PageContainer` owns the one main landmark of the document, the element marked
 * `id="main"`, so this content renders inside that landmark and introduces no second one - the
 * header's "Skip to content" link points at one element and must keep finding one. No route
 * segment configuration is exported either: `dynamic` is declared once by the root layout, and the
 * key is not honoured in a client module in any case.
 *
 * NO DATA ACCESS, AT ALL
 * Nothing is imported from `@/server/**`, no service is called and no request is issued. Two
 * reasons, both hard. This file is bundled for the browser, so a server import would drag the
 * database client and its driver into the client bundle. And Next.js renders this route with no
 * request of its own during `next build`, which has to succeed on a clean clone with no PostgreSQL
 * running and a credential-free connection string. A boundary that needed data in order to explain
 * a data failure would also be the least dependable component in the application.
 *
 * WHAT THE READER IS TOLD, AND WHAT THEY ARE NOT
 * The copy below is this file's own. The thrown value's own message is never rendered as the
 * explanation, and its stack is never rendered at all. That value comes from whatever threw, which
 * on this application's server surfaces means it can be a database driver failure carrying a
 * statement, a column name, a row value or a connection string; none of that belongs in a
 * storefront page, in the HTML source a reader can open, or in a screenshot they might pass on.
 * `error.digest` is the single field shown, and only when Next.js produced one: it is an opaque
 * hash of the server-side error, so it lets a reader's report be matched against the server log
 * without describing the failure to anyone who should not see it.
 *
 * AND IT REPORTS NOTHING
 * There is no error-reporting call, no analytics beacon, no tracer and no logging endpoint in this
 * file. A failure is shown to the person in front of it and written to the server's own log by the
 * framework; this application forwards it nowhere. `console.error` is not called either: React may
 * invoke a render more than once, so a log written during render is a side effect in the wrong
 * place, and the effect hook that would make it happen exactly once is precisely the machinery
 * this component is better off without. Next.js already surfaces the underlying error in
 * development, which is where a developer reads it.
 *
 * THE TWO WAYS OUT
 * Retrying is the honest first answer to a transient failure, so it is wired straight to the
 * primary control - no retry counter, no backoff, no disabling after a press. The reader is better
 * placed than this component to judge whether pressing it again is worth their time.
 *
 * Retrying takes two calls, and one alone is not enough. `reset` clears this boundary's own state,
 * which is all that a failure thrown in the browser needs. A failure thrown while the server
 * rendered the segment is different: its payload has already been delivered, so clearing the
 * boundary re-renders that same delivered failure and lands the reader straight back here, with no
 * request made and nothing on screen having changed. `router.refresh()` is what asks the server for
 * the segment again. The two are issued together inside one `startTransition` so React waits for
 * the fresh payload before this boundary steps aside, instead of briefly re-showing the failure it
 * is about to replace. That is the whole retry: two calls in one handler, no state of its own -
 * `startTransition` rather than `useTransition` precisely because this component keeps none.
 *
 * A successful retry unmounts this control along with the rest of the notice, so keyboard focus
 * returns to the document body and the next Tab starts from the top of the page. Moving it onto
 * the recovered content instead would mean holding state this component deliberately does without,
 * and reaching into markup that belongs to the route rather than to this boundary; the route
 * announcer tells a reader the view changed, and the reading order is unchanged either way.
 *
 * The link beside the control leaves for the catalog, which is the answer when retrying keeps
 * failing. It is an anchor rather than a control wrapped in a link: a navigation is a link, and
 * nesting the two produces markup that neither a browser nor a screen reader treats the way it
 * looks.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startTransition } from 'react';

import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';

/**
 * The props Next.js passes to an `error.tsx` boundary.
 *
 * Declared here rather than imported: the framework publishes no type for this contract, and the
 * contract is two fields. Local and unexported, like every other props interface in this
 * workspace.
 */
interface Props {
  /**
   * The value that was thrown, as React received it.
   *
   * `digest` is added by Next.js for an error that crossed the server boundary - a short opaque
   * hash of the original message and stack, which is all of a server error that is sent to the
   * browser. It is absent for an error thrown in the browser, which is why it is optional here and
   * why the render below tests for it instead of assuming it.
   *
   * Only `digest` is ever read. See the note on leakage above for why.
   */
  error: Error & { digest?: string };

  /**
   * Clears this boundary and re-renders the segment it replaced.
   *
   * Supplied by Next.js, and narrower than its name suggests: it resets the boundary's own state
   * and requests nothing. For a failure raised in the browser that is the whole retry. For a
   * failure raised while the server rendered the segment, the delivered payload still carries it,
   * so the render that follows fails again unless the segment is re-requested first - which is why
   * the handler below pairs this with a router refresh.
   */
  reset: () => void;
}

/**
 * Renders the failure notice.
 *
 * `.ls-notice` is the page-composition utility for exactly this - a page-level message that keeps
 * the page's vertical rhythm - and it is the only class this file needs: route files under `app/`
 * carry no CSS Module of their own, so every value here comes from `app/globals.css` and from the
 * two primitives below.
 *
 * `Alert` owns how the message is announced as well as how it looks. Its `danger` tone renders
 * `role="alert"` with `aria-live="assertive"`, which is the correct urgency for a page that failed
 * and is the reason this file passes neither attribute itself - stating them here would announce
 * the same notice twice. That tone also fixes the accent and title colour, so the failure is
 * carried by words as much as by colour.
 *
 * The title is the headline, and `titleAs="h1"` is what makes it the route's heading. A notice
 * dropped inside a page that has its own title renders that headline as a paragraph, which is the
 * prop's default and why every other `Alert` in this application leaves the document outline
 * alone. Here the notice IS the page: nothing else on the route declares a title, so rendering the
 * headline as an `h1` is what puts it in the outline, where a reader who arrives after the
 * announcement - or who navigates by heading, or who returns to this page later - can still find
 * what failed. No second heading is rendered anywhere in this file, so the headline is read once,
 * and the role and politeness come from `Alert`'s `danger` tone alone, so there is exactly one
 * assertive announcement.
 *
 * The two controls sit in `Alert`'s `actions` slot, which is a wrapping row: the primary control
 * retries, and the anchor leaves. The anchor carries no class because a link's appearance belongs
 * to the module that renders it and this route has none - it inherits the body text colour, and
 * the focus ring every interactive element in the application shares comes from the
 * `:focus-visible` rule in `app/globals.css`.
 *
 * The reference code is rendered only when Next.js supplied one, and `.ls-page-lede` is what makes
 * it read as the muted aside it is rather than as part of the message.
 */
export default function StorefrontErrorBoundary({ error, reset }: Props) {
  const router = useRouter();

  return (
    <div className="ls-notice">
      <Alert
        tone="danger"
        title="Something went wrong"
        titleAs="h1"
        actions={
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                startTransition(() => {
                  router.refresh();
                  reset();
                });
              }}
            >
              Try again
            </Button>
            <Link href="/">Return to the catalog</Link>
          </>
        }
      >
        We could not load this page. Your cart has not changed, so it is safe to try again.
      </Alert>

      {error.digest === undefined ? null : (
        <p className="ls-page-lede">Reference code {error.digest}</p>
      )}
    </div>
  );
}
