/**
 * A unified diff of one instrumented file, as the "Debug Generator" view shows
 * it under a `ModificationsList` item: the change Debug Generator made ("View
 * diff", AAP 0.7.3) or, for a conflict, the developer's edit on top of it
 * ("Open diff", AAP 0.5.5). `subject` names which one is on screen.
 *
 * This is the on-screen half of a product guarantee: every file the tool edits
 * is recorded, and the record - including the unified diff the patcher journaled
 * with it - is visible to the developer before, during and after the session
 * (AAP 0.5.1). Fidelity therefore outranks decoration everywhere below. What
 * the developer reads here is exactly the `diff` string the service recorded:
 *
 *   - nothing is trimmed, re-indented, collapsed, highlighted, numbered or
 *     silently truncated - each line's bytes reach the `Code` primitive
 *     untouched, and `Code` is byte-faithful by contract; a long diff is
 *     shown through a stated, movable window (see "Long diffs" below), never
 *     cut;
 *   - a line wider than the view scrolls horizontally, it never wraps and never
 *     ends in an ellipsis, because a clipped diff line is a misrepresented one;
 *   - the only transformation is presentational: a `+`, `-` or single-space
 *     prefix is shown in its own marker column, and the remainder of the line
 *     beside it. Joining the two gives back the recorded line exactly;
 *   - direction controls are shown, never obeyed. An invisible Unicode
 *     bidirectional control in source code (U+202E and its eleven siblings)
 *     makes a line display in an order the compiler does not read - the
 *     "Trojan Source" attack (CVE-2021-42574) - so `Code` prints each one as
 *     its visible escape (`\u202E`) and changes no other character, and the
 *     region's accessible name, which carries the file label, is revealed
 *     with the same `formatUntrustedText`. A reviewer therefore sees exactly
 *     the characters recorded, in the order recorded.
 *
 * ## Line classification
 *
 * {@link classifyDiffLine} is the pure, per-line rule, exported so its table
 * test can pin it without rendering: file and hunk headers first - so a
 * `--- a/x` or `+++ b/x` header is never coloured as removed or added content -
 * then `+`, then `-`, then context for everything else.
 *
 * A single line cannot always tell a header from content: a removed line whose
 * own text begins with `-- ` reads `--- ...`, exactly like a file header. The
 * renderer resolves that ambiguity the way `patch` does, from the hunk header's
 * line counts. After `@@ -a,b +c,d @@` the next `b` old-side and `d` new-side
 * lines are hunk body and are classified by their first character alone; any
 * line outside a hunk body - file headers, the patcher's `Index:` banner, a
 * truncation notice - goes through {@link classifyDiffLine}. The two agree on
 * every line of a well-formed diff that does not carry that ambiguity.
 *
 * ## Long diffs - a bounded window over every line
 *
 * A recorded diff may be up to 2 MiB, which can be tens of thousands of short
 * lines, and this view lives in a retained editor webview. Two bounds keep it
 * responsive without hiding anything:
 *
 *   - the diff is parsed into rows once per `diff` string (`useMemo`), and each
 *     row renders through a memoized component, so a re-render re-parses
 *     nothing and re-renders no row that is already on screen;
 *   - at most {@link DIFF_LINE_BATCH} rows are ever mounted. A longer diff is
 *     shown as a window of that many consecutive lines, and the header strip
 *     states exactly which ones - "Showing lines 1,001–2,000 of 2,503." -
 *     beside "Show previous ‹n› lines" and "Show next ‹n› lines" controls that
 *     move the window one batch at a time. Every line of the diff is reachable
 *     in place, and however far the reader pages, the mounted row count - and
 *     so the cost of any render - never exceeds one batch. Classification is
 *     computed over the whole diff before the window is cut, so a window that
 *     starts inside a hunk still colours its lines correctly. A different
 *     `diff` starts again at its first window.
 *
 * When the window reaches either end, the control that led there disappears
 * and focus moves to the lines themselves, so a keyboard user is never left on
 * the document body.
 *
 * ## States (AAP 0.5.5 - never a blank area)
 *
 * Fixed precedence, highest first: `error` > `pending` > empty > the diff.
 * `ErrorState`, `LoadingState` and `EmptyState` own their live-region roles
 * (`alert`, `status` with `aria-busy`, `status`), so none is added here. The
 * empty-state copy is owned by this component and is deliberately generic:
 * every string that describes a specific change comes from `props.diff` or
 * `props.fileLabel`, never from this file, and `props.subject` is the owner's
 * own generic vocabulary (AAP 0.5.4).
 *
 * ## Styling and accessibility
 *
 * Class names only, all declared in `../styles.css` in the `dgv-diff` block,
 * every value there a `--dg-*` token (AAP 0.6.4); no inline style. The marker
 * column is what keeps colour from being the only carrier of meaning: `+` and
 * `-` stay visible beside the success/danger text.
 *
 * The header strip names the file — wrapped, never clipped, in the narrowest
 * view — and, with `subject`, what the diff compares. The lines sit in a
 * `<pre>`, the element for preformatted text whose whitespace is significant,
 * exposed as a named `region` ("Diff of ‹file›", followed by the subject in
 * parentheses when there is one) and focusable so a keyboard user can scroll a
 * wide line into view with the arrow keys. Each row
 * is a `span` - phrasing content, as a `<pre>` requires - and a line break
 * text node separates consecutive rows, so the region's text is the diff's
 * lines exactly. The `<pre>` and the window controls are Tab stops by
 * default, or all `tabIndex={-1}` through `innerTabIndex` when the owner's
 * composite widget reaches them by its own keys; the focus ring is the design
 * system's own `:focus-visible` rule. The window controls precede the `<pre>`
 * in document order, so an owner that walks its controls with the arrow keys
 * reaches them before the horizontally scrolling region keeps those keys. The
 * line list carries no table roles, and no heading is emitted - the
 * surrounding outline belongs to `ModificationsList`, which lays each diff
 * out at its item's full width in the page's own flow: the one vertical
 * scroller is the webview's `PanelShell`, and only a wide line scrolls here.
 *
 * ## Privacy
 *
 * The diff arrives already redacted by the service. It can still contain source
 * code and project paths, so this module never logs it and never re-processes
 * it (AAP 0.5.2).
 *
 * @module apps/vscode-extension/src/webview/components/DiffView
 */

import {
  Button,
  Code,
  EmptyState,
  ErrorState,
  LoadingState,
  Stack,
  Text,
  formatUntrustedText,
} from '@debuggen/panel-renderer';
import { Fragment, memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

/**
 * How one line of a unified diff is presented.
 *
 * `meta` covers every non-content line: `diff --git`, `index`, the `---`/`+++`
 * file headers, `@@` hunk headers, mode, rename and similarity lines, the
 * binary-file notice and `\ No newline at end of file`.
 */
export type DiffLineKind = 'added' | 'removed' | 'context' | 'meta';

/**
 * The inputs of one diff.
 *
 * The optional members accept an explicit `undefined` as well as omission
 * (`exactOptionalPropertyTypes` is on): the caller typically forwards optional
 * fields of a modification record straight through.
 */
export interface DiffViewProps {
  /**
   * The unified diff exactly as recorded with the modification. Rendered
   * verbatim; an empty or whitespace-only string renders the empty state.
   */
  diff: string;

  /**
   * The project-relative path of the modified file, shown above the diff and
   * used to name the scroll region for assistive technology.
   */
  fileLabel?: string | undefined;

  /**
   * What this diff compares — "Change made by Debug Generator", "Your edit
   * since instrumentation" — shown under the file label and appended to the
   * region's name, so an owner that can show more than one diff of a file
   * never leaves the reader guessing which one is open. Generic product copy
   * supplied by the owner; a blank value shows nothing.
   */
  subject?: string | undefined;

  /**
   * `true` while the owner is still resolving the diff. Outranked only by
   * `error`.
   */
  pending?: boolean | undefined;

  /**
   * Why the diff cannot be shown. A non-blank value outranks every other
   * state, so a failure is never presented as a result.
   */
  error?: string | undefined;

  /**
   * The `tabIndex` of every focusable element this component renders: the
   * diff's scroll region and, for a diff longer than {@link DIFF_LINE_BATCH}
   * lines, the controls that move its window. Defaults to `0`, a Tab
   * stop each - what `ModificationsList` uses, since it lays each diff out in
   * the page's own flow, so a keyboard user can Tab onto the lines and scroll a
   * wide one. An owner that renders the diff inside a composite widget which
   * manages focus itself (a grid whose arrow keys reach every control it
   * holds) passes `-1` instead.
   */
  innerTabIndex?: 0 | -1 | undefined;

  /** Extra class names for the root element, applied in every state. */
  className?: string | undefined;
}

/**
 * Prefixes that mark a line as metadata rather than file content, in the order
 * {@link classifyDiffLine} checks them. The trailing spaces on `index `, `--- `
 * and `+++ ` are significant: they are what separates a header from a content
 * line such as `---` (a removed `--`) or `+++` (an added `++`).
 */
const META_PREFIXES: readonly string[] = [
  'diff --git',
  'index ',
  '--- ',
  '+++ ',
  '@@',
  'old mode',
  'new mode',
  'similarity index',
  'rename from',
  'rename to',
  'new file mode',
  'deleted file mode',
  'Binary files',
  '\\ No newline at end of file',
];

/**
 * Classifies one line of a unified diff in isolation.
 *
 * Checked in this order: {@link META_PREFIXES} (so headers never read as added
 * or removed content), then a leading `+`, then a leading `-`; everything else
 * - a leading single space, an empty string, any unrecognised text - is
 * context.
 *
 * Pure: no state, no allocation beyond the prefix scan.
 *
 * @param line One line of the diff, without its line terminator.
 * @returns The line's presentation kind.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) {
    return 'meta';
  }

  if (line.startsWith('+')) {
    return 'added';
  }

  if (line.startsWith('-')) {
    return 'removed';
  }

  return 'context';
}

/** One rendered row: its kind plus the line split into marker and remainder. */
interface DiffRow {
  readonly kind: DiffLineKind;

  /**
   * The line's first character when it is a diff marker (`+`, `-` or a single
   * space), otherwise the empty string - the row then shows an empty marker
   * column and the whole line as its text.
   */
  readonly marker: string;

  /** The rest of the line. `marker + text` is always the original line. */
  readonly text: string;
}

/**
 * A hunk header's old-side and new-side line counts. A count omitted from the
 * header (`@@ -3 +3 @@`) means one line, per the unified diff format.
 */
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u;

/** Parses a hunk-header count, where `undefined` is the format's implicit 1. */
function hunkCount(group: string | undefined): number {
  return group === undefined ? 1 : Number.parseInt(group, 10);
}

/** The copy shown when there is no diff to render (see the module header). */
const EMPTY_MESSAGE = 'No diff is available for this modification.';

/** The error-state title; the caller's message beneath it says why. */
const ERROR_TITLE = 'Could not show this diff';

/** The accessible name of the error state's file block. */
const ERROR_FILE_LABEL = 'Modified file';

/** The announced label of the loading state (the primitive adds the ellipsis). */
const LOADING_LABEL = 'Loading diff';

/** The scroll region's accessible name when no file label is supplied. */
const REGION_NAME = 'Diff';

/** The text node between two rows of the `<pre>` (see {@link DiffLines}). */
const LINE_BREAK = '\n';

/**
 * The header strip above the lines (`.dgv-diff__file` in `../styles.css`): the
 * file label and, for a long diff, the window notice and its controls. The
 * strip is inset to the lines' own padding and ruled off from them.
 */
const HEADER_CLASS = 'dgv-diff__file';

/**
 * The most diff lines ever mounted at once: the size of the window a long diff
 * is shown through, and the step the window moves by (see the module header).
 *
 * A recorded diff may be up to 2 MiB, which can be tens of thousands of short
 * lines; mounting every one - three elements per line - would stall the
 * retained editor webview, and so would letting revealed lines accumulate. An
 * instrumentation patch is normally a handful of hunks, so a typical diff
 * still renders whole in one window, while the worst case stays bounded to
 * this many mounted rows however far the reader pages.
 */
export const DIFF_LINE_BATCH = 1000;

/** Formats line counts in the reader's own locale - the webview's, which is the editor's. */
const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/**
 * A count of lines as words, singular for exactly one.
 *
 * @param count A non-negative whole number of lines.
 * @returns The formatted count with `line` or `lines`.
 */
function formatLines(count: number): string {
  return `${COUNT_FORMAT.format(count)} ${count === 1 ? 'line' : 'lines'}`;
}

/**
 * The notice that states which lines of a long diff are on screen, e.g.
 * "Showing lines 1,001–2,000 of 2,503." - nothing is ever out of view without
 * saying so. Line numbers are 1-based positions in the recorded diff.
 *
 * @param first The 1-based position of the window's first line.
 * @param last The 1-based position of the window's last line.
 * @param total How many lines the diff has.
 * @returns The sentence.
 */
function windowNotice(first: number, last: number, total: number): string {
  return `Showing lines ${COUNT_FORMAT.format(first)}–${COUNT_FORMAT.format(last)} of ${COUNT_FORMAT.format(total)}.`;
}

/** The backward control's text, e.g. "Show previous 1,000 lines". */
function showPreviousLabel(count: number): string {
  return `Show previous ${formatLines(count)}`;
}

/** The forward control's text, e.g. "Show next 1,000 lines". */
function showNextLabel(count: number): string {
  return `Show next ${formatLines(count)}`;
}

/**
 * Where the reader's window starts, and for which diff. Keyed by the diff
 * itself, so a position chosen in one diff never applies to the next: when the
 * `diff` prop changes, the stored position no longer matches and the view is
 * back at the first window, with no effect or second render needed to reset
 * it.
 */
interface WindowState {
  /** The diff the position was chosen in. */
  readonly diff: string;
  /** The 0-based index of the window's first row, a multiple of the batch. */
  readonly start: number;
}

/** Row class per kind, total over the union so a new kind is a compile error. */
const LINE_CLASS: Readonly<Record<DiffLineKind, string>> = {
  added: 'dgv-diff__line dgv-diff__line--added',
  removed: 'dgv-diff__line dgv-diff__line--removed',
  context: 'dgv-diff__line dgv-diff__line--context',
  meta: 'dgv-diff__line dgv-diff__line--meta',
};

/** Whether an optional string carries anything besides whitespace. */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * The scroll region's accessible name: "Diff of ‹file›", or "Diff" without a
 * label, followed by the subject in parentheses when there is one.
 *
 * @param label The file label, already checked for content.
 * @param subject What the diff compares, already checked for content.
 * @returns The name.
 */
function regionName(label: string | undefined, subject: string | undefined): string {
  const base = label === undefined ? REGION_NAME : `Diff of ${label}`;
  return subject === undefined ? base : `${base} (${subject})`;
}

/**
 * The header strip above the lines, or above the state that stands in for
 * them: the file label, the subject beneath it, and - for a long diff - the
 * window notice with its controls. Nothing at all when there is none of the
 * three.
 *
 * The label renders through `Code wrap`, so a long path breaks across lines in
 * a narrow view instead of widening the strip or being clipped by it; the
 * strip's rule in `../styles.css` insets it to the lines' own padding.
 */
function DiffHeader(props: {
  readonly label: string | undefined;
  readonly subject: string | undefined;
  readonly notice?: ReactElement | null | undefined;
}): ReactElement | null {
  const { label, subject, notice = null } = props;
  if (label === undefined && subject === undefined && notice === null) {
    return null;
  }

  const labelElement =
    label === undefined ? null : (
      <Code size="sm" wrap>
        {label}
      </Code>
    );

  return (
    <Text as="div" size="sm" tone="secondary" className={HEADER_CLASS}>
      {subject === undefined && notice === null ? (
        labelElement
      ) : (
        <Stack gap={1} align="start">
          {labelElement}
          {subject === undefined ? null : (
            <Text size="xs" tone="secondary" className="dgv-diff__subject">
              {subject}
            </Text>
          )}
          {notice}
        </Stack>
      )}
    </Text>
  );
}

/**
 * Splits a line whose kind is known into its marker column and remainder.
 *
 * Only a genuine diff marker moves into the marker column: the `+` of an added
 * line, the `-` of a removed line, the single leading space of a context line.
 * A meta line, and a context line that does not start with a space (a banner,
 * a notice, an empty line), keeps every character in its text.
 */
function toRow(kind: DiffLineKind, line: string): DiffRow {
  const first = line.slice(0, 1);
  const isMarker =
    (kind === 'added' && first === '+') ||
    (kind === 'removed' && first === '-') ||
    (kind === 'context' && first === ' ');

  return isMarker ? { kind, marker: first, text: line.slice(1) } : { kind, marker: '', text: line };
}

/**
 * Turns the recorded diff into rows, one per line.
 *
 * Lines are split on `\n` and never trimmed. A diff that ends with a line
 * terminator - which every unified diff does - yields one empty final element
 * that is the terminator, not a line, and exactly that one element is dropped:
 * `"a\n"` is one row, while `"a\n\n"` is two rows, the second an empty line the
 * diff genuinely contains. A `\r` before a `\n` stays part of its line.
 *
 * Inside a hunk body (see the module header) lines are classified by their
 * first character; everywhere else by {@link classifyDiffLine}.
 */
function toRows(diff: string): DiffRow[] {
  const lines = diff.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') {
    lines.pop();
  }

  const rows: DiffRow[] = [];
  let oldRemaining = 0;
  let newRemaining = 0;

  for (const line of lines) {
    const inHunk = oldRemaining > 0 || newRemaining > 0;
    const first = line.slice(0, 1);

    if (inHunk && (first === ' ' || line === '') && oldRemaining > 0 && newRemaining > 0) {
      oldRemaining -= 1;
      newRemaining -= 1;
      rows.push(toRow('context', line));
      continue;
    }

    if (inHunk && first === '-' && oldRemaining > 0) {
      oldRemaining -= 1;
      rows.push(toRow('removed', line));
      continue;
    }

    if (inHunk && first === '+' && newRemaining > 0) {
      newRemaining -= 1;
      rows.push(toRow('added', line));
      continue;
    }

    if (inHunk && first === '\\') {
      // `\ No newline at end of file` annotates the previous line and does not
      // count against either side of the hunk.
      rows.push(toRow('meta', line));
      continue;
    }

    // Outside a hunk body, or a line the hunk's counts cannot account for (a
    // clipped diff's truncation notice): the hunk is over, and the line is
    // classified on its own.
    oldRemaining = 0;
    newRemaining = 0;

    const kind = classifyDiffLine(line);
    const header = kind === 'meta' ? HUNK_HEADER.exec(line) : null;
    if (header !== null) {
      oldRemaining = hunkCount(header[1]);
      newRemaining = hunkCount(header[2]);
    }

    rows.push(toRow(kind, line));
  }

  return rows;
}

/**
 * One diff line: the marker column and the text column inside a `span`, so the
 * row is phrasing content of the `<pre>` around it. Its text content is the
 * recorded line exactly - `marker + text`, with no terminator; the line break
 * between rows is a separate text node owned by {@link DiffLines}.
 *
 * Memoized on its row object. The rows of one diff are parsed once and keep
 * their identity, so any re-render of the owner re-renders none of the rows
 * already on screen; moving a long diff's window mounts only its new rows.
 */
const DiffLine = memo(function DiffLine(props: { readonly row: DiffRow }): ReactElement {
  const { row } = props;

  return (
    <span className={LINE_CLASS[row.kind]}>
      {row.marker === '' ? (
        <span className="dgv-diff__marker" aria-hidden="true" />
      ) : (
        <Code size="sm" className="dgv-diff__marker">
          {row.marker}
        </Code>
      )}
      <Code size="sm" className="dgv-diff__text">
        {row.text}
      </Code>
    </span>
  );
});

/**
 * The labelled, focusable `<pre>` region holding the diff's rows, below the
 * header strip: the file label and - for a diff longer than
 * {@link DIFF_LINE_BATCH} lines - the notice that says which lines are shown,
 * with the controls that move the window. The notice lives in that strip so it
 * is inset to the lines' padding by the strip's own rule in `../styles.css`.
 *
 * A `<pre>` because the content is preformatted text whose whitespace is
 * meaningful, and a named `region` so assistive technology announces it as the
 * diff of its file and a keyboard user can focus it to scroll a wide line into
 * view. A `'\n'` text node sits between consecutive rows, so the element's
 * text content is the rendered lines joined by line breaks - an unstyled
 * render, a copy or a reader's text view still shows one line per row. The
 * stylesheet lays the rows out as a single-column grid, and whitespace-only
 * text between grid items is not rendered, so the separators add no height.
 *
 * The diff is parsed once per `diff` string, and at most
 * {@link DIFF_LINE_BATCH} of its rows are mounted, as one window:
 *
 * - The first window mounts on open. "Show next ‹n› lines" and "Show previous
 *   ‹n› lines" move the window one batch forward or back, replacing its rows,
 *   so the mounted count never grows past one batch however far the reader
 *   pages. The notice names the window's first and last line and the total.
 * - The notice and its controls come BEFORE the `<pre>` in document order. The
 *   region scrolls horizontally, and a composite owner such as a grid leaves a
 *   horizontally scrolling element its ArrowLeft/ArrowRight/Home/End, so a
 *   control placed after it could not be reached by those keys. The
 *   region is described by the notice, so assistive technology announces
 *   which lines it holds, and the notice is a polite live region, so a move
 *   of the window is announced while focus stays on the control.
 * - A control that has led to the end it points at unmounts. Focus is then
 *   moved to the `<pre>` - the lines the reader just brought into view - so a
 *   keyboard user is not dropped onto the document body.
 * - A different `diff` starts again at its first window (see
 *   {@link WindowState}).
 */
function DiffLines(props: {
  readonly diff: string;
  readonly label: string | undefined;
  readonly subject: string | undefined;
  readonly name: string;
  readonly tabIndex: 0 | -1;
}): ReactElement {
  const { diff, label, subject, name, tabIndex } = props;

  // Hooks before any branch, as they must be. Parsing is a pass over up to
  // 2 MiB of text, so it runs once per diff, not once per render.
  const rows = useMemo(() => toRows(diff), [diff]);
  const [view, setView] = useState<WindowState>(() => ({ diff, start: 0 }));
  const regionRef = useRef<HTMLPreElement>(null);
  const noticeId = useId();

  // Set by a window control whose activation reaches the end it points at, so
  // that control unmounts; read once by the effect below after that render has
  // committed.
  const focusRegionAfterMoveRef = useRef(false);

  const total = rows.length;
  // The stored position applies only to the diff it was chosen in, and only
  // while it still names a row of it.
  const requested = view.diff === diff ? view.start : 0;
  const start = requested < total ? requested : 0;
  const end = Math.min(total, start + DIFF_LINE_BATCH);
  const before = start;
  const after = total - end;
  const windowed = before > 0 || after > 0;

  useEffect(() => {
    if (focusRegionAfterMoveRef.current) {
      focusRegionAfterMoveRef.current = false;
      // The region sits directly under the controls, so its top is already on
      // screen; not scrolling keeps the reader where they were.
      regionRef.current?.focus({ preventScroll: true });
    }
  }, [start]);

  const moveTo = (nextStart: number): void => {
    const nextEnd = Math.min(total, nextStart + DIFF_LINE_BATCH);
    // The control just used disappears when the window reaches its end.
    focusRegionAfterMoveRef.current = nextStart === 0 || nextEnd === total;
    setView({ diff, start: nextStart });
  };

  const handleShowPrevious = (): void => {
    moveTo(Math.max(0, start - DIFF_LINE_BATCH));
  };

  const handleShowNext = (): void => {
    moveTo(end);
  };

  const shown = windowed ? rows.slice(start, end) : rows;

  const notice = windowed ? (
    <Stack direction="horizontal" gap={2} wrap align="center">
      <Text size="xs" tone="secondary" id={noticeId} aria-live="polite">
        {windowNotice(start + 1, end, total)}
      </Text>
      {before === 0 ? null : (
        <Button variant="ghost" size="sm" tabIndex={tabIndex} onClick={handleShowPrevious}>
          {showPreviousLabel(Math.min(DIFF_LINE_BATCH, before))}
        </Button>
      )}
      {after === 0 ? null : (
        <Button variant="ghost" size="sm" tabIndex={tabIndex} onClick={handleShowNext}>
          {showNextLabel(Math.min(DIFF_LINE_BATCH, after))}
        </Button>
      )}
    </Stack>
  ) : null;

  return (
    <>
      {/* The header strip above the lines: the file label and subject, and for
          a long diff the notice with its window controls beneath them, inset
          to the lines' own padding and ruled off from them by the strip's
          subtle border. */}
      <DiffHeader label={label} subject={subject} notice={notice} />
      {/* A raw element, so its accessible name — which carries the file label —
          is revealed here; the primitives reveal their own. */}
      <pre
        ref={regionRef}
        className="dgv-diff__scroll"
        role="region"
        aria-label={formatUntrustedText(name)}
        aria-describedby={windowed ? noticeId : undefined}
        tabIndex={tabIndex}
      >
        {shown.map((row, offset) => (
          // Lines repeat and never reorder within one diff, so the position in
          // the diff is the stable identity: a re-render keeps every mounted
          // row, and moving the window replaces rows rather than relabelling.
          <Fragment key={start + offset}>
            {offset === 0 ? null : LINE_BREAK}
            <DiffLine row={row} />
          </Fragment>
        ))}
      </pre>
    </>
  );
}

/**
 * Renders the unified diff of one modification, or the state that stands in
 * for it.
 *
 * Presentational: the owner decides which record is expanded and supplies its
 * diff; nothing here fetches, subscribes or logs. The only local state is
 * presentation of the diff state - which window of a long diff the reader is
 * looking through - and the only effect moves focus onto the lines once a
 * window control has led to the end it points at (see {@link DiffLines}).
 *
 * @param props See {@link DiffViewProps}.
 * @returns One root element carrying `dgv-diff` and `props.className`, holding
 *   the error, loading or empty state, or the optional file label, the
 *   long-diff notice when there is one, and the diff's lines.
 */
export function DiffView(props: DiffViewProps): ReactElement {
  const {
    diff,
    fileLabel,
    subject: subjectProp,
    pending = false,
    error,
    innerTabIndex = 0,
    className,
  } = props;
  const label = hasText(fileLabel) ? fileLabel : undefined;
  const subject = hasText(subjectProp) ? subjectProp : undefined;
  const failed = hasText(error);

  const rootClass = ['dgv-diff', failed ? 'dgv-diff--error' : '', className ?? '']
    .filter((name) => name !== '')
    .join(' ');

  if (failed) {
    // `ErrorState` draws its own framed surface, so the root drops the diff
    // frame (`dgv-diff--error`) and the file label moves into the error block.
    return (
      <div className={rootClass}>
        <ErrorState
          message={error}
          title={ERROR_TITLE}
          query={label}
          queryLabel={ERROR_FILE_LABEL}
        />
      </div>
    );
  }

  if (!pending && diff.trim() !== '') {
    // The data state: `DiffLines` draws the header strip itself, because for a
    // long diff that strip also carries the window notice it owns.
    return (
      <div className={rootClass}>
        <DiffLines
          diff={diff}
          label={label}
          subject={subject}
          name={regionName(label, subject)}
          tabIndex={innerTabIndex}
        />
      </div>
    );
  }

  return (
    <div className={rootClass}>
      <DiffHeader label={label} subject={subject} />
      {pending ? (
        <LoadingState variant="rows" label={LOADING_LABEL} />
      ) : (
        <EmptyState message={EMPTY_MESSAGE} />
      )}
    </div>
  );
}
