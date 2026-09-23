'use client';

/*
 * Lumen Supply - Retry: the control a server-rendered notice offers when its data did not arrive.
 *
 * Several of this storefront's surfaces are read on the server and rendered from one payload: the
 * order history and the inventory dashboard each ask one of this application's endpoints for their
 * data, and each renders a notice in place of that data when the read does not answer. The notice
 * itself is `ui/Alert`, which a server component can render because it holds no state and takes
 * its controls as a slot. What a server component cannot do is act on a press - and asking for the
 * data again is exactly a press, so whatever goes in that slot has to be a client module. This is
 * that module, and it is one file rather than one per page so the two surfaces offer the reader the
 * same affordance instead of each growing a client boundary of its own.
 *
 * WHAT PRESSING IT DOES
 * `router.refresh()` asks the server for the route the reader is on and re-renders it with whatever
 * comes back, leaving everything the failure did not touch exactly as it was - the address bar, the
 * cart, the scroll position, the rest of the page. That is the whole recovery: the page's own read
 * is the thing that failed, so asking for the page again is the thing that can succeed, and a full
 * document reload would discard state that was never involved. The call is issued inside a
 * transition, which is what keeps the notice on screen while the request is in flight instead of
 * blanking the region, and what makes the pending flag below a fact about that request rather than
 * state this component has to keep.
 *
 * A press that fails again leaves the notice exactly where it was, which is the honest outcome: the
 * copy already says what happened and what has not changed. Nothing here counts attempts, backs
 * off, or takes the control away after a press - the reader is better placed than this component to
 * judge whether pressing it again is worth their time.
 *
 * THE CONTROL IS THE SHARED ONE
 * `ui/Button` in its `secondary` `sm` step, which is what every action inside a notice in this
 * application already uses - the checkout's two in-notice controls are the same two props - so a
 * reader meets one affordance across the store, and this file declares no geometry, colour or
 * spacing of its own. `busy` drives the native `disabled` attribute, `aria-busy` and the indicator
 * from that single pending flag, so what a reader sees and what a screen reader can observe cannot
 * drift apart while the page is being asked for again.
 *
 * The label belongs to this file rather than to a prop: the answer to a surface that could not read
 * its data is to ask for it again, and one spelling of that across the store is worth more than a
 * caller's freedom to word it differently. A notice whose recovery is something else - leaving for
 * the catalog, clearing a filter - is a link or a control of its own, not this one renamed.
 */

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { Button } from './Button';

/** What the control says. One spelling, so the affordance reads the same on every surface. */
const LABEL = 'Try again';

/**
 * Renders the retry control.
 *
 * It takes no props, and that is the contract rather than an omission: the label is fixed above,
 * the appearance is the shared control's, and the placement belongs to the `actions` slot of the
 * notice that renders it - `Alert` already lays that row out, so a `className` here would only
 * invite a caller to override spacing the notice owns. Nothing is configurable because nothing
 * about asking for the current route again differs between the surfaces that need it.
 *
 * @returns The control, busy for as long as the route is being requested again.
 */
export function Retry() {
  const router = useRouter();
  const [pending, startRefresh] = useTransition();

  return (
    <Button
      variant="secondary"
      size="sm"
      busy={pending}
      onClick={() => {
        startRefresh(() => {
          router.refresh();
        });
      }}
    >
      {LABEL}
    </Button>
  );
}
