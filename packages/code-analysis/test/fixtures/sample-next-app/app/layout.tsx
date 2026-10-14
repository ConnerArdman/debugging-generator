/**
 * Root App Router layout of the `sample-next-app` indexing fixture.
 *
 * Read-only input for the @debuggen/code-analysis test suite: ts-morph opens this tree
 * through the fixture's own tsconfig.json and the extractors index whatever they find.
 * Nothing here is installed, built or executed, so the file imports nothing at all — no
 * framework, no runtime, no stylesheet — and the JSX below is consequently untyped. That
 * is the intended shape of the corpus rather than an oversight.
 *
 * Its job is structural: sitting at `app/layout.tsx` marks the tree as an App Router
 * project, so route mapping resolves `app/page.tsx` to `/`. The corpus is deliberately
 * hybrid — a sibling `pages/` tree coexists with this one — so router detection reports
 * an App Router primary with a Pages Router remnant, never one exclusive flavour.
 */

/** Layout props. `children` is `unknown` because no React types resolve in this fixture. */
type ObservatoryLayoutProps = {
  children?: unknown;
};

/** Exported non-function literal, so symbol extraction sees a constant in a `.tsx` file. */
export const metadata = {
  title: 'Basin Observatory',
  description: 'Gauge readings and drift summaries for the monitored basin stations.',
};

/** The only `<html>`/`<body>` document shell in the corpus; every page renders a fragment. */
export default function ObservatoryLayout({ children }: ObservatoryLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
