/**
 * Home page of this Next.js App Router application, served at `/`.
 *
 * The application's only page. It renders a heading and `PingWidget`, the one interactive
 * component, whose button calls `GET /api/ping` and shows the reply the route sends after a short,
 * fixed delay.
 *
 * The page stays a server component with no state, effect, event handler, `fetch` or data access -
 * the application has no database - so a click on the widget is the only thing on this page that
 * issues a request. It renders identically on every request, and sets no metadata (the layout owns
 * the document head), no route segment configuration and no styles.
 *
 * The widget is imported as a named export by relative path because the project configures no path
 * alias. No import in this file reaches outside this directory, so the application runs unchanged
 * when the directory is copied elsewhere.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/page
 */
import { PingWidget } from '../src/components/PingWidget';

/**
 * The single page of this application.
 *
 * Renders a short heading and the application's one interactive component, in that order and with
 * no props.
 *
 * The declaration is a synchronous named function rather than an anonymous, arrow or `async`
 * default export. The name lets React report the component by name in component stacks and
 * developer tools, and the page has nothing to await, so it is not `async`: a promise the framework
 * had to settle first would add work between the request and this render.
 *
 * @returns The heading and the application's interactive widget.
 */
export default function PingPage() {
  return (
    <main>
      <h1>Sample app check</h1>
      <PingWidget />
    </main>
  );
}
