/**
 * Root layout of this Next.js App Router application.
 *
 * Every route of the application renders through this file, which wraps the active route's content
 * in the `<html>` and `<body>` document shell and does nothing else: no stylesheet, font,
 * provider, navigation element, route segment configuration or data access. It carries no
 * client-component directive, so it stays a server component that renders identically on every
 * request. The application's one interactive element is the widget the page mounts.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/layout
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Static document metadata for every route of this application.
 *
 * A title and nothing more: it is what the framework needs to render a complete document head, and
 * it is static, so no request can change it.
 */
export const metadata: Metadata = { title: 'Sample Next App' };

/**
 * The single layout of this application.
 *
 * Renders the document shell around the active route's content, which it passes through unwrapped
 * and unmodified.
 *
 * The declaration is a named function rather than an anonymous or arrow default export, so React
 * reports the component by name in component stacks and developer tools.
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
