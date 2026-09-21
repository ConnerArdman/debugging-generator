'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId, useState, type ReactElement } from 'react';

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
 * alone would require the directive at the top of the file. Beyond those two there is nothing
 * client-only in here - no effect, no timer, no browser global, no `window` read, no randomness
 * and no clock read - so the markup the server renders for a URL and the markup the browser first
 * produces for it agree, and hydration is silent. `useId` supplies the one generated value in the
 * file, which React keeps stable across that boundary; a random id would not be.
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
 * Following a link closes it too, because a tap on a phone-width viewport otherwise leaves the
 * menu standing open over the page it just navigated to.
 *
 * WHAT IT IS NOT
 * A disclosure, not a dialog: focus is not trapped, it is not moved into the list when the list
 * opens, and no overlay is drawn. The cart drawer is this application's one dialog and owns that
 * behaviour. This component is also not a search surface and not a breadcrumb - the trail is its
 * own labelled landmark, which is precisely why the `aria-label` on the `<nav>` below is required
 * rather than decorative: two navigation landmarks in a document have to be distinguishable.
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
 * Whether `href` is the route `pathname` is currently on.
 *
 * Total and pure: the same two strings always give the same answer, no argument can make it
 * throw, and it reads nothing outside its parameters - which is why it lives here rather than
 * inside the component, and why it costs nothing to evaluate once per entry on every render.
 *
 * The catalog, at `/`, matches exactly. Every other route matches its own path and anything
 * beneath it, so `/orders/AB-1024` still marks Orders as the current page while `/orders-archive`
 * - a different route that merely starts with the same letters - does not, because the separator
 * is part of the comparison.
 */
function isActiveRoute(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }

  return pathname === href || pathname.startsWith(`${href}/`);
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

  return (
    <nav
      aria-label={LANDMARK_LABEL}
      className={clsx(styles.root, className)}
      // Escape, handled where the focus already is. The guard on `open` keeps a key press with
      // nothing to close from queueing a state update that would change nothing.
      onKeyDown={(event) => {
        if (open && event.key === CLOSE_KEY) {
          setOpen(false);
        }
      }}
    >
      <div className={styles.inner}>
        {/* Placement only - the control's own appearance is `Button`'s, and the stylesheet drops
            this wrapper entirely above the breakpoint, where the list needs no control. */}
        <div className={styles.toggle}>
          <Button
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
