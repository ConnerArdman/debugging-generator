'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useRef, useState, type ReactElement } from 'react';

import { Button } from '@/components/ui/Button';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';

import styles from './SiteNav.module.css';

/*
 * SiteNav - the storefront's primary navigation row, rendered once by `app/layout.tsx` directly
 * beneath `SiteHeader` and above every page's content.
 *
 * It lists the five pages this application serves, marks the one the reader is on, and - at phone
 * and small-tablet widths, where five chips do not fit on a line - collapses into a disclosure the
 * reader opens with a single control. That is the whole of its job.
 *
 * WHAT IT SUBSCRIBES TO: THE ROUTE, AND NOTHING ELSE
 * The only ambient value this component reads is the current pathname. It consumes no cart, no
 * dispatch countdown and no notification context, holds no timer and never reads the clock, so it
 * re-renders when the reader navigates and on no other occasion. That restraint is deliberate and
 * worth stating, because the header above it is a heavy consumer of shared state: keeping the nav
 * out of those subscriptions is what makes this row's render behaviour uninteresting and the
 * header's own behaviour legible on its own.
 *
 * A CLIENT COMPONENT, FOR TWO REASONS AND NO MORE
 * `usePathname` is a client hook, and the disclosure holds one boolean of local state; either
 * alone would require the directive at the top of the file. Beyond those two the only browser-side
 * thing in here is the ref the key handler focuses, and that ref is touched inside the handler and
 * never while the markup is being produced - there is no effect, no timer, no browser global, no
 * `window` read, no randomness and no clock read - so the markup the server produces for a URL and
 * the markup the browser first produces for it agree, and hydration is silent. `useId` supplies
 * the one generated value in the file, which React keeps stable across that boundary; a random id
 * would not be.
 *
 * ACTIVE ROUTE
 * `isActiveRoute` below is a pure module-level function, so the rule it encodes is testable
 * without rendering anything and is evaluated afresh for each entry rather than cached. Exactly
 * one element in the document carries `aria-current="page"` at a time - the current route's link -
 * and the state is carried visually by the stylesheet's `.active` colour and accent indicator as
 * well, so it never rests on colour alone. A non-current link carries no `aria-current` attribute
 * at all: the string `"false"` is a valid value of that attribute and would announce the link as
 * "not the current page", which is noise on four links out of five.
 *
 * THE DISCLOSURE
 * The control is the application's own `Button` in its quiet variant, so its chrome, its focus
 * ring and its explicit `type="button"` come from that component rather than from this file. It
 * reports the state it controls with `aria-expanded` and names the element it controls with
 * `aria-controls`.
 *
 * The list it controls is never unmounted. Keeping it in the DOM at every width is what keeps
 * `aria-controls` pointing at an element that exists, and it lets `SiteNav.module.css` decide
 * visibility from the `data-open` attribute this component writes: hidden while closed below the
 * breakpoint, an always-visible row above it whatever `data-open` happens to hold. So a reader who
 * widens the window mid-session cannot end up with a collapsed menu and no control to open it.
 *
 * Escape closes the list, and the listener for it is on the `<nav>` element - not on `document`.
 * While the list is open the reader's focus is on the control or on one of the links inside this
 * landmark, so a React `onKeyDown` here sees the key press through the normal bubbling path; a
 * global listener would need an effect and a teardown, would fire for every key pressed anywhere
 * on the page, and would answer a key press aimed at something else entirely.
 *
 * Escape also returns focus to the control, and it does so before the state update that closes the
 * list. A reader who presses it is usually standing on one of the links inside the list, and
 * `SiteNav.module.css` stops a closed list from being drawn at all, so the element focus was on
 * would be taken out from under that reader and the document would be left with no keyboard
 * position to carry on tabbing from. Moving focus first hands them the control they opened the
 * list with - the element that reports the list's state - while the link is still there to move
 * away from, which is possible because React applies the state change only once this handler has
 * returned. Above the stylesheet's 720px breakpoint the control is not drawn and the list is a
 * permanent row: a control that is not drawn cannot take focus, so the call does nothing and focus
 * stays on the link, which is the right outcome there because nothing was hidden.
 *
 * Following a link closes it too, because a tap on a phone-width viewport otherwise leaves the
 * menu standing open over the page it just navigated to. That path moves no focus at all: the
 * reader is on their way to another page, and where focus belongs is that page's business.
 *
 * WHAT IT IS NOT
 * A disclosure, not a dialog: focus is not trapped, it is not moved into the list when the list
 * opens, and no overlay is drawn. Returning focus to the control on Escape is neither of those
 * things - it gives the reader back the position they came from rather than taking a position
 * over, and it happens only on the key that dismisses the list. The cart drawer is this
 * application's one dialog and owns the trapping behaviour. This component is also not a search
 * surface and not a breadcrumb - the trail is its own labelled landmark, which is precisely why
 * the `aria-label` on the `<nav>` below is required rather than decorative: two navigation
 * landmarks in a document have to be distinguishable.
 *
 * CLASS CONTRACT
 * `SiteNav.module.css` defines seven classes and this component uses all seven - `root`, `inner`,
 * `toggle`, `list`, `item`, `link` and `active` - composed with `clsx` and never with an inline
 * `style`. The one variant in the file travels as a `data-*` attribute rather than as a second
 * class, so the state is legible in the elements tree and the stylesheet selects on it directly.
 */

/**
 * The pages this application serves, in the order they are listed.
 *
 * Declared once at module scope, so the array and its objects are built once for the lifetime of
 * the process rather than on every render, and written out as a `readonly` type rather than
 * asserted, so the data is immutable to the compiler as well as by convention. Every `href` is an
 * in-app route of this storefront - `/` (the catalog), `/cart`, `/checkout`, `/orders` and
 * `/dashboard`; there is no external destination here, and no route this application does not
 * serve.
 */
const ROUTES: readonly { readonly label: string; readonly href: string }[] = [
  { label: 'Catalog', href: '/' },
  { label: 'Cart', href: '/cart' },
  { label: 'Checkout', href: '/checkout' },
  { label: 'Orders', href: '/orders' },
  { label: 'Dashboard', href: '/dashboard' },
];

/**
 * The landmark's accessible name. Short on purpose: a screen reader announces it as "Primary
 * navigation", so the word "navigation" in the label itself would be read twice.
 */
const LANDMARK_LABEL = 'Primary';

/** The word printed on the disclosure control at narrow widths. */
const TOGGLE_WORD = 'Menu';

/**
 * Screen-reader-only continuation of that word, so the control is announced as "Menu navigation"
 * rather than as the bare noun. The leading space is part of the string: the two runs of text are
 * separate elements, and the accessible name is their concatenation.
 */
const TOGGLE_SUFFIX = ' navigation';

/** The key that closes an open list, spelled as `KeyboardEvent.key` reports it. */
const CLOSE_KEY = 'Escape';

/**
 * The catalog section's second path: the grid is served at `/`, and a single item of that grid at
 * `/products/<slug>`. The table above lists the section once, under the `/` it links to, so this
 * is where the rest of the section is named.
 */
const CATALOG_SECTION = '/products';

/**
 * Whether `pathname` is `base` itself or a path beneath it.
 *
 * The separator is part of the comparison, and that is the whole point of writing the test here
 * rather than as a bare `startsWith` at each call: `/orders/AB-1024` is beneath `/orders`, while
 * `/orders-archive` - a different route that merely starts with the same letters - is not.
 *
 * A single-token name, like the locals further down: the guard described above `Props` harvests
 * every multi-token name this workspace declares.
 */
function within(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Whether `href` is the route `pathname` is currently on.
 *
 * Total and pure: the same two strings always give the same answer, no argument can make it
 * throw, and it reads nothing outside its parameters - which is why it lives here rather than
 * inside the component, and why it costs nothing to evaluate once per entry on every render.
 *
 * Every route matches its own path and anything beneath it, so `/orders/AB-1024` still marks
 * Orders as the current page.
 *
 * The catalog is the one entry standing for two paths rather than one. Its `href` is `/`, which
 * every path in the application is beneath, so it is compared exactly - and then `/products`, the
 * section it also owns, is compared as a section. A product page is a page of the catalog, so
 * Catalog stays marked current while the reader is reading one; nothing beneath any other entry
 * can match this branch, so exactly one link is still current at a time. `/products-archive`, a
 * route this application does not serve, would not match: the comparison is `within`'s, and the
 * separator is part of it.
 */
function isActiveRoute(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/' || within(pathname, CATALOG_SECTION);
  }

  return within(pathname, href);
}

/**
 * Props of this component, kept local to it: nothing outside needs to name this shape, and the
 * repository's hardcoding guard harvests this workspace's exported names into a policy the
 * debugging product may not then use - so a second, exported name for "an optional class" would
 * spend that vocabulary for nothing.
 */
interface Props {
  /** Extra class for the `<nav>` element, composed after the module's own `root` class. */
  className?: string;
}

/**
 * The storefront's primary navigation: a row of route links at wide widths, a disclosure at narrow
 * ones, with the current route marked.
 *
 * @example
 * ```tsx
 * <SiteHeader />
 * <SiteNav />
 * <main>{children}</main>
 * ```
 */
export function SiteNav(props: Props): ReactElement {
  const { className } = props;

  // Next 16 types `usePathname()` as `string`, so there is no absent case to defend against here
  // and no fallback to write. It is the route without its query string, which is exactly what the
  // comparison below wants: `/orders?page=2` is still the Orders page.
  const pathname = usePathname();

  // The disclosure's one piece of state, and the stable id that ties the control to the list it
  // controls. `useId` rather than a counter or a random value: React produces the same id on the
  // server and during hydration, which is what keeps `aria-controls` valid in the first frame.
  const [open, setOpen] = useState(false);
  const listId = useId();

  // The disclosure control, so Escape can put focus back on it. A single-token name: the guard
  // described above `Props` harvests every multi-token name this workspace declares, and "the
  // control" is what this file calls the toggle throughout. The node it holds is read inside the
  // key handler and nowhere else.
  const control = useRef<HTMLButtonElement | null>(null);

  return (
    <nav
      aria-label={LANDMARK_LABEL}
      className={clsx(styles.root, className)}
      // Escape, handled where the focus already is. The guard on `open` keeps a key press with
      // nothing to close from queueing a state update that would change nothing.
      onKeyDown={(event) => {
        if (!open || event.key !== CLOSE_KEY) {
          return;
        }

        // Focus first, close second. The key press usually comes from a link the stylesheet stops
        // drawing the moment `data-open` turns to `'false'`, and React holds the state update
        // until this handler returns, so the move lands while that link is still in the document;
        // pressed on the control itself it simply keeps focus there. Optional chaining rather than
        // an assertion: the ref holds a node only once the control has mounted, and a control the
        // stylesheet is not drawing cannot take focus anyway.
        control.current?.focus();
        setOpen(false);
      }}
    >
      <div className={styles.inner}>
        {/* Placement only - the control's own appearance is `Button`'s, and the stylesheet drops
            this wrapper entirely above the breakpoint, where the list needs no control. */}
        <div className={styles.toggle}>
          <Button
            // `Button` extends `ComponentPropsWithRef<'button'>` and spreads the rest of its props
            // onto its `<button>`, so React 19 delivers this straight to the element and no
            // `forwardRef` is involved.
            ref={control}
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            {TOGGLE_WORD}
            <VisuallyHidden>{TOGGLE_SUFFIX}</VisuallyHidden>
          </Button>
        </div>

        {/* Always mounted; `data-open` is what the stylesheet reads, and `'false'` is written out
            rather than left off so the closed state is as explicit in the markup as the open one. */}
        <ul id={listId} className={styles.list} data-open={open ? 'true' : 'false'}>
          {ROUTES.map((route) => {
            // A single-token local: the guard mentioned above harvests every multi-token name this
            // workspace declares, and "the route we are on" is a phrase any navigation code would
            // want, so the short form keeps that vocabulary free.
            const current = isActiveRoute(pathname, route.href);

            return (
              // `href` is the key: it is unique across the table above and stable across renders,
              // and `.map` keeps every element access checked, which an index walk would not under
              // `noUncheckedIndexedAccess`.
              <li key={route.href} className={styles.item}>
                <Link
                  href={route.href}
                  className={clsx(styles.link, current && styles.active)}
                  aria-current={current ? 'page' : undefined}
                  // Following a link collapses the menu, so the page the reader lands on is not
                  // covered by the list they left open.
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  {route.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
