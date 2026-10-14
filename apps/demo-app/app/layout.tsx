import './globals.css';

import type { Metadata } from 'next';
import type { ReactElement, ReactNode } from 'react';

import { CartProvider } from '@/providers/CartProvider';
import { ShippingEtaProvider } from '@/providers/ShippingEtaProvider';
import { ToastProvider } from '@/providers/ToastProvider';

import { PageContainer } from '@/components/layout/PageContainer';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteNav } from '@/components/layout/SiteNav';
import { ToastViewport } from '@/components/ui/ToastViewport';

/*
 * Lumen Supply - the root layout, and the only file in this workspace that owns the document.
 *
 * Every route of the storefront - the catalog, a product, the cart, checkout, the order list, the
 * inventory dashboard, and the `not-found` and `error` routes as well - renders inside the tree
 * below. It declares the document element and the body, states the store's metadata, imports the
 * one global stylesheet, mounts the three application-wide providers, and places the four pieces
 * of site chrome around `{children}`. It does nothing else.
 *
 * A SERVER COMPONENT THAT READS NOTHING
 * There is no `'use client'` directive here, and there is no data access of any kind: nothing is
 * imported from `@/server/**`, no service is called, no cookie or header is read and no
 * environment variable is consulted. That restraint is what lets the routes Next.js renders
 * without a request - `app/not-found.tsx` and `app/error.tsx` - and `next build` itself succeed
 * with no database reachable and a credential-free `DATABASE_URL`. The providers and the header
 * are client components, so the interactive parts of the chrome still hydrate in the browser;
 * the shell they arrive in is produced on the server and costs the client bundle nothing.
 *
 * THE STYLESHEET
 * `./globals.css` is imported here and nowhere else - it declares the `--ls-*` design tokens, the
 * element baseline and the `.ls-*` page-composition utilities exactly once for the whole
 * application. It also gives `<body>` its column layout, which is what keeps `SiteFooter` at the
 * bottom of a route whose content is shorter than the viewport, so no wrapper element is needed
 * here to achieve that. Component chrome belongs to each component's own CSS Module; this file
 * adds no class of its own, no inline `<style>` and no `<script>`.
 *
 * THE DOCUMENT
 * `<html>` carries two attributes: the document language, and `data-scroll-behavior="smooth"`,
 * which declares to the router that the smooth scrolling `globals.css` gives this element - to a
 * reader who has not asked for less motion - is deliberate. Next.js reads that attribute before
 * it scrolls a route transition: with it, the router neutralises the style for the length of its
 * own scroll and restores it afterwards, so a navigation lands at the top of the new page at once
 * while an in-page anchor still glides; without it, the transition scroll animates and Next.js
 * reports the omission in development.
 *
 * There is no theme script to run before paint, so there is no `suppressHydrationWarning` either,
 * and any mismatch React reports from this tree is a real one worth reading. No `<head>` element
 * appears below - title, description and icons are declared through the `metadata` export, which
 * Next.js renders into the head itself.
 */

/**
 * Rendering mode for every segment beneath this layout.
 *
 * The storefront reads live stock levels, cart contents and order history, so a page's markup is
 * only meaningful for the request that asked for it. Declaring it here rather than page by page
 * also fixes the build-time contract: `next build` renders no route against the database, so a
 * clean clone builds with a placeholder connection string and no PostgreSQL running at all.
 */
export const dynamic = 'force-dynamic';

/**
 * Store-wide metadata. A page exports a short `title` of its own - `'Cart'`, `'Checkout'` - and
 * inherits the suffix through the template below, so every tab reads `<page> · Lumen Supply`.
 *
 * `icons.icon` names `public/favicon.svg` by its literal served path. That declaration is what
 * claims the icon slot, and it is the reason the `app/` folder holds no `favicon.ico` and no
 * `icon.*` file: a file-convention icon would take precedence over this entry and the two would
 * disagree. There is deliberately no `openGraph` or `twitter` image entry - a relative image URL
 * in either one requires a `metadataBase`, which a locally served application has no honest value
 * for - and no viewport or theme-colour field, which belong to a separate export.
 */
export const metadata: Metadata = {
  applicationName: 'Lumen Supply',
  title: {
    default: 'Lumen Supply',
    template: '%s · Lumen Supply',
  },
  description:
    'Lumen Supply is a business-to-business industrial supply storefront for ordering ' +
    'maintenance parts, tooling and consumables from regional distribution warehouses.',
  icons: { icon: '/favicon.svg' },
};

interface Props {
  /**
   * The active route's content. It is handed to `PageContainer` unchanged, which places it inside
   * the document's single main landmark.
   */
  children: ReactNode;
}

/**
 * The application shell: the document, the providers and the site chrome.
 *
 * The nesting below is a data-flow requirement, not a matter of taste, and each level is here for
 * one stated reason:
 *
 *   - `ToastProvider` is outermost. It holds the notification queue and subscribes to no other
 *     context, so nothing constrains where it sits; mounting it around everything else means a
 *     notice raised anywhere in the application - by the cart, by checkout, by a page - is held
 *     by the same queue and survives the rest of the tree changing beneath it.
 *   - `ShippingEtaProvider` wraps `CartProvider` because the cart reads the dispatch-countdown
 *     context that this provider publishes. Inverted, the cart would read a `null` countdown and
 *     quote no delivery estimate on any surface that prints a subtotal.
 *   - `CartProvider` wraps the chrome, because `SiteHeader` reads the cart to show its line count
 *     and to fill the drawer it opens.
 *   - `ToastViewport` is mounted inside `ToastProvider` but outside `CartProvider`: it needs the
 *     notification queue and nothing else, and `ToastProvider` contributes no markup of its own,
 *     so this is the one element that makes a queued notice visible. Exactly one of it exists in
 *     the document, which is what keeps a notice announced once rather than once per region.
 *
 * The chrome is placed in reading order - header, navigation row, page content, footer - and each
 * piece is mounted exactly once, because each renders a document landmark: the header band, the
 * navigation row, the main region that `PageContainer` owns and marks with `id="main"`, and the
 * footer. `SiteHeader`'s "Skip to content" link points at that id, so a second main region
 * anywhere in the application would break the link and give assistive technology two of them to
 * choose between.
 *
 * `PageContainer` is given `{children}` and no heading props. A page cannot pass props into the
 * layout's instance, so each route renders its own breadcrumb trail and its own `<h1>` inside its
 * content. `SiteFooter` is given no `copyrightYear`: the value would have to come from the clock,
 * which is read once on the server and again during hydration, and its closing line reads
 * correctly without one.
 */
export default function RootLayout({ children }: Props): ReactElement {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <ToastProvider>
          <ShippingEtaProvider>
            <CartProvider>
              <SiteHeader />
              <SiteNav />
              <PageContainer>{children}</PageContainer>
              <SiteFooter />
            </CartProvider>
          </ShippingEtaProvider>
          <ToastViewport />
        </ToastProvider>
      </body>
    </html>
  );
}
