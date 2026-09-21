/**
 * Root page of the generic Next.js App Router fixture application, served at `/`.
 *
 * WHAT THIS PAGE IS FOR
 *
 * The suites that prove the debugging tool works on an application it knows nothing about
 * (AAP 0.8.4, acceptance test 4) need a page to open and something on it to press, and this is
 * it: the one route of this application, mounting the one interactive component the application
 * owns. A browser or end-to-end run navigates to `/`, presses the widget's button and observes the
 * request, the delay and the reply that follow. Everything those runs query is published by the
 * widget, so this file's whole job is to render it inside the document the layout provides.
 *
 * WHY THIS FILE IS ALMOST EMPTY
 *
 * A fixture is only worth running if it carries no property a test could come to lean on by
 * accident, and a page is where such properties usually arrive: a stylesheet, a locator, a second
 * component, a request issued during render. A test that depended on one of them would no longer
 * be proving that the tool generalizes - it would be proving that the tool handles this folder.
 * The page therefore renders a heading and the widget, in that order, and does nothing else.
 *
 * Deliberately absent, each for a stated reason:
 *
 *   - no client-component directive, no state, no effect and no event handler: this page stays a
 *     server component, so it contributes no hydration work and no re-render of its own to the
 *     numbers a capture reports. The click, the request and the reply all belong to the widget,
 *     which is what keeps one click one self-contained unit of work to observe;
 *   - no `fetch`, no route handler call and no data access of any kind - this application has no
 *     database at all (AAP 0.7.1 Group 6): the only request a captured session may contain is the
 *     one the click causes, and a page that fetched while rendering would add a request nobody
 *     pressed a button for;
 *   - no clock read, no random value and no logging: the page has to render identically on every
 *     request, so that a capture taken twice can be compared;
 *   - no document metadata export: the layout owns the document head, and a title declared in two
 *     files could only drift;
 *   - no route segment configuration export: the framework's stock rendering and caching behaviour
 *     is part of what this fixture represents;
 *   - no test locator attribute: the widget owns the locator contract the suites query, and a
 *     second source of locators here could only drift from it;
 *   - no stylesheet or CSS-module import, no class name and no inline style: a captured session has
 *     to show the application's own work, not a cascade the fixture introduced;
 *   - no font, image or navigation helper from the framework: each of them adds network requests
 *     and layout work to every capture, which is noise in a telemetry assertion;
 *   - no props passed to the widget, and no second component or declaration of any kind: the
 *     element tree a render-count assertion walks is exactly the heading and the widget.
 *
 * THE SINGLE IMPORT
 *
 * The widget is reached as a named export by relative path. This project configures no path alias
 * and the widget publishes no default export, so this is the only import form that resolves - here
 * in the checkout and equally in the temporary copy of this directory the service's integration
 * suites run, which is also why no path in this file reaches outside this directory.
 *
 * NAMING IS LOAD-BEARING HERE
 *
 * The repository's anti-hardcoding gate regenerates its forbidden-token list from the demonstration
 * application's code index minus every name that occurs in this fixture (AAP 0.5.4), so a name
 * shared with that application would silently drop a token from the list the generalization test
 * depends on. This file introduces exactly one name, the default export below, and it occurs
 * nowhere in that application; the heading's wording, like every other string in this folder, comes
 * from this fixture's own vocabulary for the same reason.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/page
 */
import { PingWidget } from '../src/components/PingWidget';

/**
 * The single route of the fixture application.
 *
 * Renders a short heading and the fixture's one interactive component, in that order and with no
 * props, which is the whole of its job.
 *
 * The declaration is a synchronous named function rather than an anonymous, arrow or `async`
 * default export, and both halves of that are deliberate. One of the ways the product resolves a
 * runtime item back to a source location is React's owner chain, so a component whose name survives
 * into the fiber tree is what makes that resolution observable here; an anonymous default export
 * would arrive without a name and weaken the proof. A page with nothing to await must equally not
 * be `async`: a promise the framework has to settle first would insert work between the request
 * and this render that the fixture does not otherwise have, which a suite timing the click would
 * see.
 *
 * @returns The heading and the fixture's interactive widget.
 */
export default function PingPage() {
  return (
    <main>
      <h1>Sample app check</h1>
      <PingWidget />
    </main>
  );
}
