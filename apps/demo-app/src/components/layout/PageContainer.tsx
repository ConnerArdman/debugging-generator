/**
 * PageContainer - the page shell every route of the Lumen Supply storefront renders inside.
 *
 * `app/layout.tsx` mounts this component exactly once, around `{children}` and inside the
 * application's providers, so a route never mounts it itself. Two consequences follow, and both
 * are load-bearing:
 *
 *   1. It owns the document's single `<main id="main">` landmark. The site header's "Skip to
 *      content" link points at `#main`, and `tabIndex={-1}` is what lets that link move focus
 *      into the region in every browser - without it, browsers move the scroll position but
 *      leave focus where it was, so the next Tab continues from the header. The programmatic
 *      focus ring is suppressed by the stylesheet for the `:focus:not(:focus-visible)` case
 *      only, which leaves a genuine keyboard focus ring intact. No other element in the
 *      application may carry `id="main"`, and no other element may be a `<main>`; the header,
 *      navigation and footer landmarks belong to the components that render them.
 *   2. It has to stay generic. It reads no data, detects no route and holds no copy of its own:
 *      a page passes the width it wants, the heading it wants and its content, and nothing here
 *      changes with the URL.
 *
 * It is a server component with no client boundary at all - no client directive, no hooks, no
 * clock read - so it adds nothing to the client bundle and cannot produce a hydration
 * mismatch. The heading block is composed from slots rather than from imports for the same
 * reason: `breadcrumb` and `actions` arrive as already-rendered `ReactNode`s, so a page is free
 * to pass an interactive trail or a set of buttons without this file gaining a dependency on
 * either.
 *
 * Presentation lives entirely in `PageContainer.module.css`, whose eight classes - `root`,
 * `inner`, `head`, `breadcrumb`, `title`, `description`, `actions`, `body` - are a closed
 * contract with this file. The page measure is selected through the `data-width` attribute that
 * the stylesheet reads, which is why no class-name lookup table appears below.
 *
 * The four optional props that are not `ReactNode` are declared as `T | undefined` rather than
 * with a bare `?`. The workspace compiles with `exactOptionalPropertyTypes`, under which an
 * optional property does not accept an explicit `undefined`; spelling the union out lets a page
 * forward a value it has not resolved yet - `title={product?.name}` - and matches how the React
 * typings declare their own optional props. `ReactNode` already includes `undefined`, so the
 * slots need nothing added.
 */

import clsx from 'clsx';
import type { ReactElement, ReactNode } from 'react';

import styles from './PageContainer.module.css';

interface Props {
  /** The route's content. Rendered inside the measure, below the heading block. */
  children: ReactNode;
  /**
   * The page's heading. Rendered as the page's only `<h1>`, so a page that supplies a title must
   * not render an `<h1>` of its own.
   */
  title?: string | undefined;
  /** One sentence under the title, held to a reading measure by the stylesheet. */
  description?: string | undefined;
  /**
   * The trail above the title, as an already-rendered node. Pages build their own trail and pass
   * it in, which keeps this shell independent of any particular trail implementation.
   */
  breadcrumb?: ReactNode;
  /** Controls that belong to the page as a whole, placed beside the title. */
  actions?: ReactNode;
  /**
   * The page measure: `narrow` for forms and single-column reading, `wide` for tables and
   * dashboards, `default` for everything else.
   */
  width?: 'narrow' | 'default' | 'wide' | undefined;
  /** Appended to the landmark's class list, for the rare page that needs its own page-level rule. */
  className?: string | undefined;
}

/**
 * Renders the page shell: the `<main>` landmark, the centred measure, the optional heading block
 * and the route's content.
 *
 * The heading block is omitted entirely - element and hairline alike - when the page supplies
 * none of `breadcrumb`, `title`, `description` or `actions`, so a page that opens straight into
 * its content shows no empty rule above it.
 */
export function PageContainer(props: Props): ReactElement {
  const { actions, breadcrumb, children, className, description, title, width = 'default' } = props;

  const hasHeadingContent =
    Boolean(breadcrumb) || Boolean(title) || Boolean(description) || Boolean(actions);

  return (
    <main className={clsx(styles.root, className)} data-width={width} id="main" tabIndex={-1}>
      <div className={styles.inner}>
        {hasHeadingContent ? (
          <div className={styles.head}>
            {breadcrumb ? <div className={styles.breadcrumb}>{breadcrumb}</div> : null}
            {title ? <h1 className={styles.title}>{title}</h1> : null}
            {description ? <p className={styles.description}>{description}</p> : null}
            {actions ? <div className={styles.actions}>{actions}</div> : null}
          </div>
        ) : null}
        <div className={styles.body}>{children}</div>
      </div>
    </main>
  );
}
