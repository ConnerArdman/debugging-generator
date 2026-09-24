/**
 * The unified diff of one instrumentation modification, as the "Debug
 * Generator" view shows it under `ModificationsList`'s "View diff" control
 * (AAP 0.7.3).
 *
 * This is the on-screen half of a product guarantee: every file the tool edits
 * is recorded, and the record - including the unified diff the patcher journaled
 * with it - is visible to the developer before, during and after the session
 * (AAP 0.5.1). Fidelity therefore outranks decoration everywhere below. What
 * the developer reads here is exactly the `diff` string the service recorded:
 *
 *   - nothing is trimmed, re-indented, collapsed, highlighted, numbered or
 *     truncated - each line's bytes reach the `Code` primitive untouched, and
 *     `Code` is byte-faithful by contract;
 *   - a line wider than the view scrolls horizontally, it never wraps and never
 *     ends in an ellipsis, because a clipped diff line is a misrepresented one;
 *   - the only transformation is presentational: a `+`, `-` or single-space
 *     prefix is shown in its own marker column, and the remainder of the line
 *     beside it. Joining the two gives back the recorded line exactly.
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
 * ## States (AAP 0.5.5 - never a blank area)
 *
 * Fixed precedence, highest first: `error` > `pending` > empty > the diff.
 * `ErrorState`, `LoadingState` and `EmptyState` own their live-region roles
 * (`alert`, `status` with `aria-busy`, `status`), so none is added here. The
 * empty-state copy is owned by this component and is deliberately generic:
 * every string that describes a specific change comes from `props.diff` or
 * `props.fileLabel`, never from this file (AAP 0.5.4).
 *
 * ## Styling and accessibility
 *
 * Class names only, all declared in `../styles.css` in the `dgv-diff` block,
 * every value there a `--dg-*` token (AAP 0.6.4); no inline style. The marker
 * column is what keeps colour from being the only carrier of meaning: `+` and
 * `-` stay visible beside the success/danger text. The scroll container is a
 * named, focusable group so a keyboard user can scroll a wide line into view;
 * the focus ring is the design system's own `:focus-visible` rule. The line
 * list is prose-like content, not a grid, so it carries no table roles, and no
 * heading is emitted - the surrounding outline belongs to `ModificationsList`.
 *
 * ## Privacy
 *
 * The diff arrives already redacted by the service. It can still contain source
 * code and project paths, so this module never logs it and never re-processes
 * it (AAP 0.5.2).
 *
 * @module apps/vscode-extension/src/webview/components/DiffView
 */

import { Code, EmptyState, ErrorState, LoadingState, Text } from '@debuggen/panel-renderer';
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
   * `true` while the owner is still resolving the diff. Outranked only by
   * `error`.
   */
  pending?: boolean | undefined;

  /**
   * Why the diff cannot be shown. A non-blank value outranks every other
   * state, so a failure is never presented as a result.
   */
  error?: string | undefined;

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

/** The scroll region holding one row per diff line. */
function DiffLines(props: { readonly diff: string; readonly name: string }): ReactElement {
  const rows = toRows(props.diff);

  return (
    <div className="dgv-diff__scroll" role="group" aria-label={props.name} tabIndex={0}>
      {rows.map((row, index) => (
        // Lines repeat and never reorder within one diff, so the position is
        // the stable identity; a different diff remounts the whole list.
        <div key={index} className={LINE_CLASS[row.kind]}>
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
        </div>
      ))}
    </div>
  );
}

/**
 * Renders the unified diff of one modification, or the state that stands in
 * for it.
 *
 * Stateless and side-effect free: props in, markup out. The owner decides which
 * record is expanded and supplies its diff; nothing here fetches, subscribes or
 * remembers.
 *
 * @param props See {@link DiffViewProps}.
 * @returns One root element carrying `dgv-diff` and `props.className`, holding
 *   the error, loading or empty state, or the optional file label and the
 *   diff's lines.
 */
export function DiffView(props: DiffViewProps): ReactElement {
  const { diff, fileLabel, pending = false, error, className } = props;
  const label = hasText(fileLabel) ? fileLabel : undefined;
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

  let body: ReactElement;
  if (pending) {
    body = <LoadingState variant="rows" label={LOADING_LABEL} />;
  } else if (diff.trim() === '') {
    body = <EmptyState message={EMPTY_MESSAGE} />;
  } else {
    body = <DiffLines diff={diff} name={label === undefined ? REGION_NAME : `Diff of ${label}`} />;
  }

  return (
    <div className={rootClass}>
      {label === undefined ? null : (
        <Text as="div" size="sm" tone="secondary" className="dgv-diff__file">
          <Code size="sm">{label}</Code>
        </Text>
      )}
      {body}
    </div>
  );
}
