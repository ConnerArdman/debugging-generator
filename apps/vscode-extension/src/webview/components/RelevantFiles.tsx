/**
 * `RelevantFiles` — the files and symbols the code-investigation stage selected,
 * each of which opens in the editor when activated (AAP 0.7.3: "file, symbol,
 * reason; click opens the file").
 *
 * It is the editor-side evidence that the pipeline understood the project: AAP
 * 0.8.4's first acceptance test requires the relevant frontend file and backend
 * route to be listed here before instrumentation is planned.
 *
 * ## Data in, one callback out
 *
 * The component renders `props.files` — `SessionRecord.relevantFiles`, the wire
 * shape `@debuggen/protocol` declares for the investigation artifact
 * (`CodeInvestigation.relevantFiles[{ file, symbol, reason, score }]`, AAP 0.4.2)
 * — and raises `onOpenFile(file)` when a row is activated. It opens no socket,
 * posts no host message and fetches nothing: `App.tsx` owns the host bridge and
 * turns the callback into the open request.
 *
 * The callback payload is the entry's `file` **exactly as received**: a
 * project-relative POSIX path. Nothing here prepends a workspace root, converts
 * separators or appends a line; path containment is enforced downstream, by the
 * service's source-open path and by the host's own resolution, which is where a
 * decision about the file system belongs.
 *
 * ## Faithful rendering
 *
 * - **Order is information.** The investigation stage ranks its candidates, so
 *   rows appear in the order given and are never re-sorted by score.
 * - **Every string is the pipeline's.** The path renders through `Code`, which
 *   is byte-faithful; a long path is shortened visually by the stylesheet's
 *   ellipsis, never by slicing the string, and the full value stays in the
 *   accessibility tree and in the path's tooltip. The reason renders verbatim.
 * - **The score is formatted, not ranked.** It is shown to two decimals — the
 *   protocol bounds it to 0..1 — and a non-finite value, which the protocol
 *   refuses at its boundary, renders no chip rather than the word "NaN".
 * - **No invented resolution metadata.** A relevant file carries no line,
 *   column or resolution route, so the design system's source-location chip —
 *   which requires all three — is deliberately not used: synthesising them would
 *   fabricate evidence (AAP 0.5.4).
 *
 * ## Structure and the design system (AAP 0.6.4)
 *
 * ```text
 * ol.dgv-files                          ordered list — the ranking is semantic
 *   li.dgv-files__item                  one per entry
 *     Button ghost, full width          .dgv-files__button — the activatable row
 *       span.dgv-files__row             column: path, meta, reason
 *         Code sm                       .dgv-files__path — the file
 *         span.dgv-files__meta          symbol (Text, accent) + score (Badge, soft)
 *         Text xs secondary             .dgv-files__reason — why it was selected
 * ```
 *
 * The row is a `Button` so it is focusable, keyboard-activatable and shows the
 * design system's focus ring by construction. Its accessible name is the file
 * (and the symbol, when present) through `aria-labelledby`, and the reason and
 * score are its description through `aria-describedby`, so a screen reader
 * announces "path, symbol, button" followed by why the file matters, rather
 * than one undifferentiated run of text.
 *
 * The list is spaced by the `.dgv-files` rules of `../styles.css` rather than by
 * `Stack`, and the row's inner column by `.dgv-files__row`, for a structural
 * reason: `Stack` renders `div` containers, and a `div` can neither sit between
 * an `<ol>` and its `<li>` children nor inside a `<button>`, whose content model
 * is phrasing content only. Every value behind those classes is a `--dg-*`
 * token. The table primitive is not used either: a narrow sidebar list of
 * activatable rows reads better as rows than as columns, and the table's
 * webview consumer is the modification list, which keeps the two visually
 * distinct.
 *
 * ## States (AAP 0.5.5)
 *
 * Precedence is error, then pending, then empty, then the list: a failed
 * investigation is never shown as an empty one, and a loading view never
 * flashes the empty message. Each state is the design system's primitive —
 * `ErrorState` (`role="alert"`, with a retry action only when `onRetry` is
 * supplied), `LoadingState` (`role="status"`, `aria-busy`) and `EmptyState`
 * (`role="status"`) — and receives `props.className`, so the caller's class
 * lands on the root element whichever state renders.
 *
 * ## Privacy and neutrality (AAP 0.5.2, 0.5.4)
 *
 * Paths and reasons are the developer's content: they are rendered and never
 * logged, and this module writes nothing to any console. The only copy it owns
 * is generic product vocabulary; every project-specific string comes from
 * `props.files`.
 *
 * @module apps/vscode-extension/src/webview/components/RelevantFiles
 */

import { useId } from 'react';
import type { ReactElement } from 'react';

import {
  Badge,
  Button,
  Code,
  EmptyState,
  ErrorState,
  LoadingState,
  Text,
} from '@debuggen/panel-renderer';
import type { RelevantFile } from '@debuggen/protocol';

/**
 * The props of {@link RelevantFiles}.
 *
 * Every optional member spells `| undefined` because `exactOptionalPropertyTypes`
 * is in force repository-wide, and `App.tsx` forwards values it may not have —
 * `error={state.investigationError}` — straight through.
 */
export interface RelevantFilesProps {
  /**
   * The investigation's selection, in its ranked order. Rendered one row per
   * entry, in exactly this order.
   */
  files: readonly RelevantFile[];

  /**
   * Raised when a row is activated, with that entry's `file` unchanged — the
   * project-relative POSIX path the host resolves and opens.
   */
  onOpenFile: (file: string) => void;

  /**
   * The investigation is still running: renders the loading silhouette in place
   * of the list. Outranked only by {@link RelevantFilesProps.error}.
   */
  pending?: boolean | undefined;

  /**
   * Why the list could not be produced, as the layer that observed the failure
   * worded it. A non-blank value renders the error state, which outranks every
   * other state.
   */
  error?: string | undefined;

  /**
   * Asks for the failed step to be tried again. The error state renders its
   * retry control only when this is supplied.
   */
  onRetry?: (() => void) | undefined;

  /**
   * Extra classes for the root element of whichever state renders — layout the
   * surrounding section owns. Composed after this component's own class.
   */
  className?: string | undefined;
}

/**
 * The empty-state sentence. Generic by design: `EmptyState` ships no default
 * copy precisely so that no project vocabulary can leak into it.
 */
const EMPTY_MESSAGE = 'No files have been identified yet.';

/** Announced, never painted, while the investigation is resolving. */
const LOADING_LABEL = 'Loading relevant files…';

/**
 * The words that give the bare score its meaning — a visually hidden prefix
 * inside the chip for assistive technology, and the chip's tooltip on hover.
 */
const SCORE_LABEL = 'Relevance score';

/** How many skeleton rows the loading silhouette draws. */
const LOADING_ROWS = 3;

/** Decimal places the score is shown with; the protocol bounds it to 0..1. */
const SCORE_DECIMALS = 2;

/**
 * Joins class names, dropping absent and blank parts.
 *
 * `clsx` is not a dependency of this workspace, and two parts do not justify
 * one; blank parts are dropped so a caller's empty `className` never leaves a
 * stray space in the attribute.
 *
 * @param parts The class names, in cascade order.
 * @returns The space-separated class attribute value.
 */
function joinClassNames(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.trim() !== '').join(' ');
}

/**
 * Whether an optional string carries anything to render.
 *
 * @param value The value as received.
 * @returns `true` for a string with at least one non-whitespace character.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * Formats a relevance score for display: fixed to {@link SCORE_DECIMALS}
 * places, deterministic, and never re-scaled or clamped — a value is shown as
 * the pipeline produced it.
 *
 * @param score The entry's score.
 * @returns The display string, or `undefined` for a non-finite value, which
 *   renders no chip instead of "NaN" or "Infinity".
 */
function formatScore(score: number): string | undefined {
  return Number.isFinite(score) ? score.toFixed(SCORE_DECIMALS) : undefined;
}

/**
 * The element ids one row wires into its button's name and description.
 *
 * Derived from the list's single `useId` value plus the row's position, so a
 * row needs no hook of its own and ids stay unique across several lists.
 */
interface RowIds {
  /** The path element: the first part of the accessible name. */
  file: string;
  /** The symbol element: the second part of the name, when present. */
  symbol: string;
  /** The reason element: the first part of the description. */
  reason: string;
  /** The score chip: the second part of the description, when rendered. */
  score: string;
}

/**
 * Builds the ids of one row.
 *
 * @param baseId The list's `useId` value.
 * @param index The row's zero-based position.
 * @returns The four element ids.
 */
function rowIds(baseId: string, index: number): RowIds {
  const prefix = `${baseId}-file-${String(index)}`;
  return {
    file: `${prefix}-path`,
    symbol: `${prefix}-symbol`,
    reason: `${prefix}-reason`,
    score: `${prefix}-score`,
  };
}

/**
 * Renders the investigation's relevant files as an ordered list of activatable
 * rows, or the error, loading or empty state in their place.
 *
 * @param props See {@link RelevantFilesProps}.
 * @returns The list, or the state primitive that stands in for it.
 */
export function RelevantFiles(props: RelevantFilesProps): ReactElement {
  const { files, onOpenFile, pending = false, error, onRetry, className } = props;

  // Called before any early return, as a hook must be.
  const baseId = useId();

  if (hasText(error)) {
    return <ErrorState message={error} onRetry={onRetry} className={className} />;
  }

  if (pending) {
    return (
      <LoadingState
        variant="rows"
        rows={LOADING_ROWS}
        label={LOADING_LABEL}
        className={className}
      />
    );
  }

  if (files.length === 0) {
    return <EmptyState message={EMPTY_MESSAGE} className={className} />;
  }

  return (
    <ol className={joinClassNames('dgv-files', className)}>
      {files.map((entry, index) => {
        const ids = rowIds(baseId, index);
        const symbol = hasText(entry.symbol) ? entry.symbol : undefined;
        const score = formatScore(entry.score);

        const nameRefs = symbol === undefined ? ids.file : `${ids.file} ${ids.symbol}`;
        const descriptionRefs = score === undefined ? ids.reason : `${ids.reason} ${ids.score}`;

        return (
          // Position plus content: unique even when one file appears twice
          // with different symbols, and stable for as long as the list is.
          <li key={`${String(index)}:${entry.file}#${symbol ?? ''}`} className="dgv-files__item">
            <Button
              variant="ghost"
              fullWidth
              className="dgv-files__button"
              aria-labelledby={nameRefs}
              aria-describedby={descriptionRefs}
              onClick={() => {
                onOpenFile(entry.file);
              }}
            >
              <span className="dgv-files__row">
                <Code id={ids.file} size="sm" className="dgv-files__path" title={entry.file}>
                  {entry.file}
                </Code>
                {symbol !== undefined || score !== undefined ? (
                  <span className="dgv-files__meta">
                    {symbol === undefined ? null : (
                      <Text id={ids.symbol} size="sm" tone="accent" truncate title={symbol}>
                        {symbol}
                      </Text>
                    )}
                    {score === undefined ? null : (
                      <Badge
                        id={ids.score}
                        variant="soft"
                        className="dgv-files__score"
                        title={SCORE_LABEL}
                      >
                        <Text className="dg-visually-hidden">{SCORE_LABEL}</Text> {score}
                      </Badge>
                    )}
                  </span>
                ) : null}
                <Text id={ids.reason} size="xs" tone="secondary" className="dgv-files__reason">
                  {entry.reason}
                </Text>
              </span>
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
