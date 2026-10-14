'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useSelectedLayoutSegment } from 'next/navigation';
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
 * The only ambient value this component reads is the route segment the router has selected
 * directly beneath the root layout. It holds no timer and never reads the clock, so it re-renders
 * when the router's tree changes - a navigation or a refresh - and on no other occasion.
 *
 * A CLIENT COMPONENT, FOR TWO REASONS AND NO MORE
 * `useSelectedLayoutSegment` is a client hook, and the disclosure holds one boolean of local
 * state; either alone would require the directive at the top of the file. Beyond those two the
 * only browser-side thing in here is the ref the key handler focuses, and that ref is touched
 * inside the handler and never while the markup is being produced - there is no effect, no timer,
 * no browser global, no `window` read, no randomness and no clock read - and the one route value
 * the markup depends on comes from the router tree the server and the browser share (see ACTIVE
 * ROUTE), so the markup the server produces for a response and the markup the browser first
 * produces from it agree, and hydration is silent. `useId` supplies the one generated value in the
 * file, which React keeps stable across that boundary; a random id would not be.
 *
 * ACTIVE ROUTE
 * The current entry is decided from the selected segment - `useSelectedLayoutSegment()`, called
 * here from the root layout's tree, so it names the first level beneath the root - and not from
 * the address, because the two disagree on a response whose address was rewritten. `proxy.ts`
 * rewrites a product address no product owns to `/_missing`, so on the server `usePathname()`
 * reports `/_missing` for that response, while the browser - whose address bar still reads
 * `/products/<slug>` - hydrates with the address it asked for. An address-derived row would mark
 * nothing on the server and Catalog in the browser, and React would report the difference as a
 * hydration mismatch. The selected segment is read from the router tree the server serialises into
 * the page's RSC payload, which is the tree the browser hydrates from and the tree every
 * client-side navigation replaces, so both sides always read the same value: `null` for the
 * catalog grid at `/` with or without a query, `'products'` for a product page, `'cart'`,
 * `'checkout'`, `'orders'` and `'dashboard'` for the other four, and the router's own not-found
 * segment (`'/_not-found'`) for an address no route owns - the rewritten product address and a
 * plain unknown path alike - which matches no entry, so on a not-found page no link claims to be
 * the page the reader is on. A query string is never part of a segment, so `/orders?page=2` is
 * still the Orders page. The rule assumes the routes under `app/` sit in no route group: a
 * `(group)` folder would be selected as a segment of its own.
 *
 * `isActiveRoute` below is a pure module-level function, so the rule it encodes is testable
 * without rendering anything and is evaluated afresh for each entry rather than cached. At most
 * one element in the document carries `aria-current="page"` at a time - the current route's link,
 * and none on a not-found page - and the state is carried visually by the stylesheet's `.active`
 * colour and accent indicator as well, so it never rests on colour alone. A non-current link
 * carries no `aria-current` attribute at all: the string `"false"` is a valid value of that
 * attribute and would announce the link as "not the current page", which is noise on four links
 * out of five.
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
 *
 * `segment` is the value `useSelectedLayoutSegment()` returns while that route is showing: the
 * route's folder beneath `app/`, which is its `href` without the leading slash, and `null` for the
 * catalog, whose grid is the root's own page and selects no segment. It is written out beside the
 * `href` rather than derived from it, so the value each entry is matched on reads directly off the
 * table.
 */
const ROUTES: readonly {
  readonly label: string;
  readonly href: string;
  readonly segment: string | null;
}[] = [
  { label: 'Catalog', href: '/', segment: null },
  { label: 'Cart', href: '/cart', segment: 'cart' },
  { label: 'Checkout', href: '/checkout', segment: 'checkout' },
  { label: 'Orders', href: '/orders', segment: 'orders' },
  { label: 'Dashboard', href: '/dashboard', segment: 'dashboard' },
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
 * The catalog section's second segment: the grid is the root's own page at `/`, and a single item
 * of that grid is served beneath `products`, at `/products/<slug>`. The table above lists the
 * section once, under the `/` it links to, so this is where the rest of the section is named.
 */
const CATALOG_SECTION = 'products';

/**
 * Whether the entry owning `segment` is the route the router has `selected`.
 *
 * Total and pure: the same two values always give the same answer, no argument can make it
 * throw, and it reads nothing outside its parameters - which is why it lives here rather than
 * inside the component, and why it costs nothing to evaluate once per entry on every render.
 *
 * A selected segment names the first level beneath the root and nothing deeper, so every entry
 * matches its own path and any page served beneath it by construction: a page at `/orders/<id>`,
 * were the application to serve one, would still select `'orders'` and mark Orders as the current
 * page, while `/orders-archive` - an address that merely starts with the same letters - is not
 * beneath `orders` and can never select it.
 *
 * The catalog is the one entry standing for two values rather than one: `null`, the root's own
 * page, and {@link CATALOG_SECTION}, the section it also owns. A product page is a page of the
 * catalog, so Catalog stays marked current while the reader is reading one; no other entry owns
 * either value, so at most one link is current at a time.
 */
function isActiveRoute(selected: string | null, segment: string | null): boolean {
  if (segment === null) {
    return selected === null || selected === CATALOG_SECTION;
  }

  return selected === segment;
}

/**
 * Props of this component, kept local to it: nothing outside this file names this shape, and a
 * second, exported name for "an optional class" would buy nothing.
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

  // The segment selected beneath the root layout, typed `string | null` by Next 16: `null` is the
  // root's own page, the catalog grid, and is matched as such rather than defended against. It is
  // read from the router tree rather than the address, which is what keeps the server's render of
  // a rewritten not-found response and the browser's hydration of it in agreement (ACTIVE ROUTE,
  // above), and it never holds the query string: `/orders?page=2` is still the Orders page.
  const selected = useSelectedLayoutSegment();

  // The disclosure's one piece of state, and the stable id that ties the control to the list it
  // controls. `useId` rather than a counter or a random value: React produces the same id on the
  // server and during hydration, which is what keeps `aria-controls` valid in the first frame.
  const [open, setOpen] = useState(false);
  const listId = useId();

  // The disclosure control, so Escape can put focus back on it - named for what this file calls
  // the toggle throughout. The node it holds is read inside the key handler and nowhere else.
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
            // Whether this entry is the route the reader is on, decided once and read by both
            // the active class and `aria-current` below.
            const current = isActiveRoute(selected, route.segment);

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
