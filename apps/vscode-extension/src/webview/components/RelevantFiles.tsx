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
 * ## One row per file
 *
 * The investigation can select one file more than once — as a route handler
 * and again for a symbol it declares — each time with its own symbol, reason
 * and score. Listed entry by entry, every such file appeared twice, the second
 * time lower down and with a lower score, which read as two different files.
 * Entries are therefore grouped by their exact `file` string, and each file is
 * one row holding:
 *
 * - **every symbol** its entries name, distinct, in ranking order, joined into
 *   the row's second name part;
 * - **every reason** its entries give, distinct and verbatim, one line each —
 *   none is dropped or reworded, whatever the investigation wrote;
 * - **its best score**, the highest finite score among its entries.
 *
 * Grouping compares strings only: it never normalises a path, so two spellings
 * of one file stay two rows, and the row's `file` is the entries' own string.
 *
 * ## Faithful rendering
 *
 * - **Order is information.** The investigation stage ranks its candidates, so
 *   rows appear in the order each file first appears and are never re-sorted
 *   by score.
 * - **Every string is the pipeline's.** The path renders through `Code`, which
 *   is byte-faithful; a long path is shortened visually by the stylesheet's
 *   ellipsis, never by slicing the string, and the full value stays in the
 *   accessibility tree and in the path's tooltip. Symbols and reasons render
 *   verbatim.
 * - **What is on screen is the logical text.** A path, symbol or reason is
 *   untrusted — it comes from the project and from the model — and an
 *   invisible Unicode direction control in it (U+202E and its eleven
 *   siblings) would draw the characters after it in an order that was never
 *   sent. Every one is shown as its visible escape (`\u202E`) with the
 *   design system's `formatUntrustedText`: the primitives do it for their own
 *   text, tooltips and names, and the path chip's parts, which are elements of
 *   this component, are revealed where they render. Nothing else changes, and
 *   the value raised through `onOpenFile`, the grouping and the React keys
 *   stay the raw strings.
 * - **Rows stay apart when the path is shortened.** The investigation often
 *   selects files of one name — a route handler and its nested route, two
 *   components in sibling directories. `../path-display`'s `describePaths`
 *   splits every path of the list, once, into a lead and the shortest tail no
 *   other file of the list ends in, and the chip renders them on the shared
 *   `.dgv-path` contract: the lead ellipsizes first, then the tail's
 *   directories, and the file name last. Each row therefore keeps what tells
 *   it apart and its file name, however narrow the view.
 * - **The score is formatted, not ranked.** It is shown to two decimals — the
 *   protocol bounds it to 0..1 — after a visible "Relevance" label that says
 *   what the number is, and a file with no finite score, which the protocol
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
 *   li.dgv-files__item                  one per file
 *     Button ghost, full width          .dgv-files__button — the activatable row
 *       span.dgv-files__row             column: path, meta, reasons
 *         Text (visually hidden)        the file, whole — the name's first part
 *         Code sm, aria-hidden          .dgv-path — the file, middle-truncated:
 *           span, span > span, span     __lead + __tail (__context + __name)
 *         span.dgv-files__meta          symbols (Text, accent) + "Relevance" score (Badge, soft)
 *         Text xs secondary             .dgv-files__reason — why it was selected, one per reason
 * ```
 *
 * The row is a `Button` so it is focusable, keyboard-activatable and shows the
 * design system's focus ring by construction. Its accessible name is the file
 * (and its symbols, when present) through `aria-labelledby`, and the reasons
 * and score are its description through `aria-describedby`, so a screen reader
 * announces "path, symbols, button" followed by why the file matters, rather
 * than one undifferentiated run of text. The name's path is a visually hidden
 * copy of the whole file rather than the chip: a browser inserts spaces
 * between the chip's flex parts when it computes a name from them, so the chip
 * is `aria-hidden` and its tooltip carries the whole path for the pointer.
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

import { useId, useMemo } from 'react';
import type { ReactElement } from 'react';

import {
  Badge,
  Button,
  Code,
  EmptyState,
  ErrorState,
  LoadingState,
  Text,
  formatUntrustedText,
} from '@debuggen/panel-renderer';
import type { RelevantFile } from '@debuggen/protocol';

import { describePath, describePaths } from '../path-display';
import type { PathDisplay } from '../path-display';

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
   * distinct `file`, in the order each file first appears.
   */
  files: readonly RelevantFile[];

  /**
   * Raised when a row is activated, with that row's `file` unchanged — the
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
 * The visible label inside the score chip, ahead of the number, which gives
 * the bare score its meaning on screen and in the row's description alike.
 */
const SCORE_LABEL = 'Relevance';

/** Separates a file's symbols in the row's second name part. */
const SYMBOL_SEPARATOR = ', ';

/** How many skeleton rows the loading silhouette draws. */
const LOADING_ROWS = 3;

/** Decimal places the score is shown with; the protocol bounds it to 0..1. */
const SCORE_DECIMALS = 2;

/** One row of the list: a file and everything its entries say about it. */
interface FileRow {
  /** The file, exactly as its entries carry it. */
  readonly file: string;
  /** Every distinct non-blank symbol of the file's entries, in ranking order. */
  readonly symbols: readonly string[];
  /** Every distinct non-blank reason of the file's entries, in ranking order. */
  readonly reasons: readonly string[];
  /** The highest finite score of the file's entries; absent when none is finite. */
  readonly score: number | undefined;
}

/** A {@link FileRow} while its entries are still being collected. */
interface FileRowDraft {
  readonly file: string;
  readonly symbols: string[];
  readonly reasons: string[];
  score: number | undefined;
}

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
 * Groups the investigation's entries into one row per file.
 *
 * Rows keep the order in which their file first appears, which is the ranking
 * the investigation produced. A row collects each symbol and each reason once,
 * in the order its entries give them, and keeps the highest finite score. Files
 * are compared as exact strings, so no path is normalised or merged with
 * another spelling of itself.
 *
 * @param files The investigation's entries, in ranked order.
 * @returns One row per distinct `file`, in first-appearance order.
 */
function groupByFile(files: readonly RelevantFile[]): FileRow[] {
  const rows = new Map<string, FileRowDraft>();

  for (const entry of files) {
    let row = rows.get(entry.file);
    if (row === undefined) {
      row = { file: entry.file, symbols: [], reasons: [], score: undefined };
      rows.set(entry.file, row);
    }
    if (hasText(entry.symbol) && !row.symbols.includes(entry.symbol)) {
      row.symbols.push(entry.symbol);
    }
    if (hasText(entry.reason) && !row.reasons.includes(entry.reason)) {
      row.reasons.push(entry.reason);
    }
    if (Number.isFinite(entry.score) && (row.score === undefined || entry.score > row.score)) {
      row.score = entry.score;
    }
  }

  return [...rows.values()];
}

/**
 * The element ids one row wires into its button's name and description.
 *
 * Derived from the list's single `useId` value plus the row's position, so a
 * row needs no hook of its own and ids stay unique across several lists.
 */
interface RowIds {
  /** The visually hidden copy of the path: the first part of the accessible name. */
  file: string;
  /** The symbols element: the second part of the name, when present. */
  symbol: string;
  /**
   * The id of the reason element at `position`: the reasons, in order, are the
   * first parts of the description.
   */
  reason: (position: number) => string;
  /** The score chip: the last part of the description, when rendered. */
  score: string;
}

/**
 * Builds the ids of one row.
 *
 * @param baseId The list's `useId` value.
 * @param index The row's zero-based position.
 * @returns The row's element ids.
 */
function rowIds(baseId: string, index: number): RowIds {
  const prefix = `${baseId}-file-${String(index)}`;
  return {
    file: `${prefix}-path`,
    symbol: `${prefix}-symbol`,
    reason: (position) => `${prefix}-reason-${String(position)}`,
    score: `${prefix}-score`,
  };
}

/** The props of {@link FilePath}. */
interface FilePathProps {
  /** The entry's file, exactly as received. */
  readonly file: string;
  /** The file's display split within this list. */
  readonly display: PathDisplay;
  /** The id of the whole-path copy the row's `aria-labelledby` references. */
  readonly id: string;
}

/**
 * One row's path, in two forms: a visually hidden copy of the whole file,
 * which names the row, and the `aria-hidden` `.dgv-path` chip that shows it
 * middle-truncated — lead, then the tail's context and file name — with the
 * whole file as its tooltip. The chip's text is the file character for
 * character, with each direction control shown as its visible escape; only
 * the stylesheet shortens it.
 *
 * `Code` reveals its own string children and tooltip, but the chip's parts are
 * `span` elements of this component, which `Code` leaves to their author, so
 * each part is revealed here. The split itself is computed on the raw file:
 * a control is one code unit and never a separator, so revealing the three
 * parts one by one shows exactly the revealed whole.
 *
 * @param props See {@link FilePathProps}.
 * @returns The hidden copy followed by the chip.
 */
function FilePath(props: FilePathProps): ReactElement {
  const { file, display, id } = props;

  return (
    <>
      <Text id={id} className="dg-visually-hidden">
        {file}
      </Text>
      <Code size="sm" className="dgv-path" title={file} aria-hidden="true">
        {display.lead === '' ? null : (
          <span className="dgv-path__lead">{formatUntrustedText(display.lead)}</span>
        )}
        <span className="dgv-path__tail">
          {display.context === '' ? null : (
            <span className="dgv-path__context">{formatUntrustedText(display.context)}</span>
          )}
          <span className="dgv-path__name">{formatUntrustedText(display.name)}</span>
        </span>
      </Code>
    </>
  );
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

  // Computed once per list, not per row: whether a path's tail is unique is a
  // property of the whole list. Repeats of one file share one entry.
  const displays = useMemo(() => describePaths(files.map((entry) => entry.file)), [files]);

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
      {groupByFile(files).map((row, index) => {
        const ids = rowIds(baseId, index);
        const symbols = row.symbols.length === 0 ? undefined : row.symbols.join(SYMBOL_SEPARATOR);
        const score = row.score === undefined ? undefined : formatScore(row.score);

        const nameRefs = symbols === undefined ? ids.file : `${ids.file} ${ids.symbol}`;
        const descriptionRefs = [
          ...row.reasons.map((_, position) => ids.reason(position)),
          ...(score === undefined ? [] : [ids.score]),
        ].join(' ');

        return (
          // The file is unique among the rows, and stable for as long as the
          // list is.
          <li key={row.file} className="dgv-files__item">
            <Button
              variant="ghost"
              fullWidth
              className="dgv-files__button"
              aria-labelledby={nameRefs}
              aria-describedby={descriptionRefs === '' ? undefined : descriptionRefs}
              onClick={() => {
                onOpenFile(row.file);
              }}
            >
              <span className="dgv-files__row">
                <FilePath
                  id={ids.file}
                  file={row.file}
                  display={displays.get(row.file) ?? describePath(row.file)}
                />
                {symbols !== undefined || score !== undefined ? (
                  <span className="dgv-files__meta">
                    {symbols === undefined ? null : (
                      <Text id={ids.symbol} size="sm" tone="accent" truncate title={symbols}>
                        {symbols}
                      </Text>
                    )}
                    {score === undefined ? null : (
                      <Badge id={ids.score} variant="soft" className="dgv-files__score">
                        {`${SCORE_LABEL} ${score}`}
                      </Badge>
                    )}
                  </span>
                ) : null}
                {row.reasons.map((reason, position) => (
                  <Text
                    key={reason}
                    id={ids.reason(position)}
                    size="xs"
                    tone="secondary"
                    className="dgv-files__reason"
                  >
                    {reason}
                  </Text>
                ))}
              </span>
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
