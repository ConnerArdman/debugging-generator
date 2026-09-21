/**
 * Root layout of the generic Next.js App Router fixture application.
 *
 * WHAT THIS APPLICATION IS FOR
 *
 * This directory is the target the debugging tool is pointed at when a suite has to prove the tool
 * works on an application it knows nothing about (AAP 0.8.4, acceptance test 4). The repository's
 * own demonstration storefront is where the product is shown off; this application is where it is
 * proved, because nothing here shares a name, a route, a dependency or a stylesheet with anything
 * the repository builds. The end-to-end generalization spec runs a whole session against it, and
 * the browser suite drives it for every extension-side assertion.
 *
 * WHY THIS FILE IS ALMOST EMPTY
 *
 * A layout is the one file every route in an App Router application renders through, so it is the
 * easiest place in a fixture to hand a test something to lean on by accident. Any element,
 * attribute, provider or side effect added here becomes a property of the target that a passing
 * test might quietly depend on - and a test that depends on a property of this fixture is no
 * longer proving that the tool generalizes. The file therefore renders the document shell and the
 * active route's content, and does nothing else.
 *
 * Deliberately absent, each for a stated reason:
 *
 *   - no stylesheet or CSS-module import, and no global stylesheet file in this folder: a captured
 *     session has to show the application's own work, not a cascade the fixture introduced;
 *   - no font helper from the framework and no remote font: fonts add network requests and layout
 *     work to every capture, which is noise in a telemetry assertion;
 *   - no client-component directive: this layout stays a server component, so it contributes no
 *     hydration work and no render of its own to the numbers a capture reports. The single
 *     interactive element of the fixture lives in the widget the page mounts, which is where the
 *     click, the request and the reply the suites exercise belong;
 *   - no route segment configuration export: the framework's stock rendering and caching behaviour
 *     is part of what this fixture represents;
 *   - no landmark, header, footer or navigation element, and no provider or context: a fixture
 *     carrying a component tree of its own would let a render-count assertion pass for the wrong
 *     reason;
 *   - no test locator attribute: the widget owns the locator contract the suites query, and a
 *     second source of locators here could only drift from it;
 *   - no hydration-warning suppression, viewport export or icon reference, and no clock read,
 *     random value, logging or data access of any kind: this file has to render identically on
 *     every request, so that a capture taken twice can be compared.
 *
 * NAMING IS LOAD-BEARING HERE
 *
 * The repository's anti-hardcoding gate regenerates its forbidden-token list from the
 * demonstration application's code index minus every name that occurs in this fixture, so a name
 * shared with that application would silently drop a token from the list the generalization test
 * depends on. This file introduces exactly two names: the default export below, which is unique to
 * this folder, and the framework's own single-token metadata export, which no policy can contain.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/layout
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Static document metadata for every route of this application.
 *
 * A title and nothing more: it is what the framework needs in order to render a complete document
 * head, it is static so no request can change it, and its wording comes from this folder's own
 * vocabulary so it cannot collide with a string the demonstration application uses.
 */
export const metadata: Metadata = { title: 'Sample Next App' };

/**
 * The single layout of the fixture application.
 *
 * Renders the document shell around the active route's content, which is the whole of its job: the
 * suites reach the page's widget through this element tree, so `children` is rendered unwrapped and
 * unmodified.
 *
 * The declaration is a named function rather than an anonymous or arrow default export on purpose.
 * One of the ways the product resolves a runtime item back to a source location is React's owner
 * chain, so a component whose name survives into the fiber tree is what makes that resolution
 * observable here; an anonymous default export would arrive without a name and weaken the proof.
 *
 * @param props Layout props supplied by the framework.
 * @param props.children The rendered output of the matched route.
 * @returns The document shell wrapping the active route's content.
 */
export default function FixtureLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
