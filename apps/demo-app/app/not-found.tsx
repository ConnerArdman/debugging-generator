/**
 * Lumen Supply - the not-found route.
 *
 * Next.js renders this file for two different wrong turns, and the copy below has to cover both:
 * an address that matches no route at all, and a route that exists but was asked for something
 * that does not - a product address no product owns. `proxy.ts` rewrites such an address here
 * before the product page renders (and `next.config.ts` does the same for a dotted one that names
 * no public file), so the response carries a 404 status, and in the rarer case the
 * proxy could not settle it the product page's own `notFound()` lands the reader here instead. So
 * the wording names neither the URL nor the segment that failed: it says the page is not here,
 * offers the reason a buyer actually has (a saved link that has gone stale, an item that is no
 * longer listed) and points at the catalog. Echoing the requested address back would also print
 * whatever a stranger put in a link into the page, which is not a thing to do with text nobody in
 * this store wrote.
 *
 * A SERVER COMPONENT THAT READS NOTHING, SO RENDERING IT NEEDS NO DATABASE
 * There is no client directive and no data access of any kind: nothing from `@/server/**`, no
 * service call, no `fetch`, no cookie or header read and no environment variable. The root
 * layout's `dynamic = 'force-dynamic'` covers this route too, so `next build` does not prerender
 * it: it is rendered on demand, per request, inside the root layout. Because it reads nothing,
 * rendering it touches neither the database nor the network, whatever brought the reader here.
 * Nothing is read from the clock or from `Math.random()` either, so the markup the server renders
 * and the markup produced at hydration are the same markup.
 *
 * WHAT IT DOES NOT DECLARE
 * No route segment config. `dynamic`, `revalidate` and `runtime` are page-level exports that this
 * file is not consulted for; the root layout already declares `dynamic = 'force-dynamic'` for
 * every segment beneath it, and restating it here would only suggest this file had a say.
 *
 * WHAT IT DOES NOT RENDER
 * No document element, no body element and no second main landmark: the root layout owns the
 * document and `PageContainer` owns the application's only main region, the one carrying
 * `id="main"`, which this content renders inside, so the header, navigation row and footer frame
 * it exactly as they frame every other route. It defines no component of its own, adds no CSS
 * Module - route files under `app/` compose with the `.ls-*` utilities from `app/globals.css` and
 * nothing else - and introduces no colour, icon or wording of alarm. A shopper who mistyped an
 * address has not hit a failure, and the page should not tell them they have.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { BlankSlate } from '@/components/ui/BlankSlate';

/**
 * The page's one-line answer to "what happened", used twice and therefore declared once: as the
 * block's heading, and as the accessible name of the region that holds it.
 */
const HEADING = 'Page not found';

/** Why the page is missing, and where the reader can go instead. */
const BODY =
  'The page you asked for is not here. A saved link may be out of date, or the item may no ' +
  'longer be listed. The catalog has everything currently available to order.';

/**
 * What the illustration shows, for a reader who cannot see it. `BlankSlate` accepts `''` for
 * artwork that only decorates, and the `<h1>` beneath it already carries the page's meaning, but
 * this sentence describes the drawing rather than restating that heading - it is the page's only
 * picture and nothing else here says what it depicts - so it adds a description instead of
 * announcing the same words twice.
 */
const ART_ALT = 'A magnifier held over a stocking bay, with nothing on its shelves.';

/** The single way forward offered here, in the reader's words rather than the router's. */
const CATALOG_LABEL = 'Browse the catalog';

/**
 * The tab title. The root layout's `'%s · Lumen Supply'` template completes it, so the browser
 * reads "Page not found · Lumen Supply" rather than the store's default title alone.
 *
 * A static object, not `generateMetadata`: the title never depends on the request, and the async
 * form would make this route's metadata a function of one.
 */
export const metadata: Metadata = {
  title: HEADING,
};

/**
 * The not-found page: one blank-slate block, centred in the page measure, with one way out.
 *
 * `BlankSlate` is the same block the cart, the order list, the catalog's no-match notice and the
 * dashboard's low-stock list use, and it supplies no wording, colour or icon of its own - which
 * is exactly why it fits here. The illustration it draws for `art="no-results"` is shared with
 * two screens whose emptiness is ordinary, and `tone="neutral"` keeps this page's reading
 * ordinary too. Everything that makes the block mean "you took a wrong turn" is the copy above.
 *
 * The block renders its heading as an `h2` by default, and a caller states another level where the
 * page around it calls for one, because the block appears at several different depths in this
 * application. Here the block IS the page, so its visible title is the page's title and
 * `headingAs="h1"` makes it the route's one real heading: it is reachable by heading navigation,
 * and its role as the title is conveyed programmatically rather than only by its size. Nothing
 * moves - `BlankSlate.module.css` states the heading class's margin, colour, size, weight and line
 * height outright, and a CSS-module class outranks the element rules in `app/globals.css` - and
 * there is still exactly one heading on the route, because the title is rendered once, in one
 * place.
 *
 * The labelled `<section>` sits alongside that heading. The heading exposes the title; the section
 * gives this page's single block a named region a reader can jump to, and its name is the
 * heading's own words: entering the region announces those three words and the heading inside it
 * reads the same three, which is a repeated label rather than a second sentence of copy.
 * `aria-label` adds no text to the page, so the title is visible exactly once. Naming the region
 * from the heading's id instead would read identically and cost a second `BlankSlate` prop plus
 * an id this page has no other use for, which is not a trade worth making for one route.
 *
 * The way out is an anchor, not a button: it navigates, and `Button` in this workspace is a
 * `<button>` with no link mode by design. It carries no class of its own - the utility set in
 * `app/globals.css` is closed and holds none for a link - so the element baseline there styles it
 * as an in-content link: the block's primary ink against the muted sentence above it, an
 * underline that thickens under the pointer so it never reads as plain text, and the one focus
 * ring the application draws for keyboard use. `.ls-actions` is the row it sits in, which would
 * place any second destination beside it rather than under it. Everything else this page might
 * offer - the cart, orders, the dashboard - is already one click away in the navigation row the
 * layout renders above.
 */
export default function NotFoundPage() {
  return (
    <section className="ls-stack" aria-label={HEADING}>
      <BlankSlate
        art="no-results"
        alt={ART_ALT}
        heading={HEADING}
        headingAs="h1"
        tone="neutral"
        action={
          <div className="ls-actions">
            <Link href="/">{CATALOG_LABEL}</Link>
          </div>
        }
      >
        {BODY}
      </BlankSlate>
    </section>
  );
}
