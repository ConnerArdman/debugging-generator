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
 * WHERE FOCUS GOES WHEN THE NOTICE GOES
 * A press that succeeds replaces the notice with the data it stood in for, and this control goes
 * with it while it still holds focus - the reader pressed it. A focused element removed from the
 * document leaves focus on `<body>`, where the next Tab starts from the top of the page (WCAG
 * 2.4.3). {@link holdRetryFocus} is the ref callback that prevents it: its cleanup runs while the
 * control is still in the document, and if the control holds focus there it moves focus to the
 * page's `<main id="main">` - the one landmark `PageContainer` renders with `tabIndex={-1}`, which
 * sits outside every route's content and outside the error boundary, so it survives whatever the
 * retry re-renders, and which is exactly where the recovered content begins. A notice that is
 * mounted afresh in the same commit - a boundary that failed again and rendered a new instance of
 * itself - takes focus straight back onto its own control, so a failed retry leaves the reader
 * where they were. The error boundary in `app/error.tsx` shares the callback for that reason.
 *
 * THE CONTROL IS THE SHARED ONE
 * `ui/Button` in its `secondary` `sm` step, which is what every action inside a notice in this
 * application already uses - the checkout's two in-notice controls are the same two props - so a
 * reader meets one affordance across the store, and this file declares no geometry, colour or
 * spacing of its own. `busy` drives the refused press, `aria-disabled`, `aria-busy` and the
 * indicator from that single pending flag - keeping the control focusable, so the reader who
 * pressed it is still on it while the page is being asked for again - and what a reader sees and
 * what a screen reader can observe cannot drift apart meanwhile.
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
 * The id of the document's single main landmark, which `PageContainer` renders as
 * `<main id="main" tabIndex={-1}>` - the same element the header's "Skip to content" link targets.
 */
const MAIN_LANDMARK_ID = 'main';

/**
 * Whether a retry control that held focus has just been removed in the commit now running.
 *
 * One flag for the whole document, in module scope, because the control that sets it and the
 * control that reads it are different component instances - the boundary that failed again renders
 * a new one - and neither outlives the commit the other is in. It is raised by the removed
 * control's cleanup and lowered either by a control mounted in the same commit, which takes focus
 * back, or by a microtask queued as it is raised. React runs a commit's removals, insertions and
 * ref attachments synchronously, one after another, so that microtask runs only once the whole
 * commit is done: a control mounted by the same commit always sees the flag, and a later, unrelated
 * mount never does. The microtask is not a timer and reads no clock.
 */
const retryFocus = { handedOff: false };

/**
 * The ref callback every retry control is given: it keeps keyboard focus in the document when the
 * control leaves it while focused, and hands focus back to a retry control that replaces it.
 *
 * On attach, it takes focus when a retry control was removed holding focus in this same commit -
 * the boundary that failed again - so the reader stays on "Try again". Its cleanup runs before
 * React removes the element, and only matters when the control holds focus at that moment: focus
 * then moves to the main landmark, which survives every retry, and the hand-off above is raised.
 * A control removed without focus changes nothing.
 *
 * Module-level on purpose, so every render passes the same function: React calls a ref callback's
 * cleanup whenever the callback itself changes, and an inline arrow would change on every render -
 * including the render that marks the control busy while it holds focus, which would send focus to
 * the landmark in the middle of the press.
 *
 * @example The error boundary's own control, which is not this component but behaves as it does.
 * ```tsx
 * <Button ref={holdRetryFocus} onClick={retry}>Try again</Button>
 * ```
 */
export function holdRetryFocus(control: HTMLButtonElement | null): (() => void) | undefined {
  if (control === null) {
    return undefined;
  }

  if (retryFocus.handedOff) {
    retryFocus.handedOff = false;
    control.focus();
  }

  return () => {
    if (document.activeElement !== control) {
      return;
    }

    document.getElementById(MAIN_LANDMARK_ID)?.focus();
    retryFocus.handedOff = true;

    queueMicrotask(() => {
      retryFocus.handedOff = false;
    });
  };
}

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
      ref={holdRetryFocus}
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
