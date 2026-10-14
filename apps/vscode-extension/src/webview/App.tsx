/**
 * `App` — the composition root of the "Debug Generator" VS Code view (AAP 0.7.3).
 *
 * The extension host owns every connection and pushes whole `WebviewState` snapshots; this module
 * replaces its one copy on each push, so state flows one way: host → `App` → props. Every user
 * action leaves as exactly one `WebviewToHostMessage` through `postToHost`. No component below
 * `App` owns server state, posts to the host or touches `./vscode-api` — they receive plain data
 * and report intent through callbacks. `main.tsx` owns `createRoot` and the `ready` handshake.
 *
 * ## Pending actions
 *
 * A control stays disabled from the moment its request is handed to the host until the host has
 * answered THAT request — never merely until the host next speaks. Every request leaves with a
 * `requestId` minted here, in the event path ({@link createRequestId}), and the host answers it with
 * exactly one `actionResult` echoing that id; `./pending-actions` settles a pending request on that
 * frame alone, when both its `action` and its `requestId` match. Snapshots, notices and pairing
 * frames are presentational: they update what the view shows and settle nothing, so the
 * session-less snapshot `debuggen.startSession` pushes before `POST /sessions` resolves, a session
 * reopened from the Sessions tree, End session's `ended` snapshot, the "pick the element" notice or
 * an unrelated error can no longer re-enable a control mid-request or discard a draft. `openFile`
 * waits on nothing: it carries no id and never touches the pending state. A request the host never
 * answers is failed by the reducer's 150 s safety timeout, which outlasts every host-side bound.
 * `QuestionForm` and `FollowUp` keep the typed text until their submission's own result arrives,
 * clearing it only when the host accepted it and keeping it, with a retry hint, when it failed.
 *
 * ## Copy that follows the session
 *
 * Every section says what is true of the session now, read from one {@link SessionPhase} and the
 * service connection rather than from ad hoc status comparisons. The Question section shows the
 * active session's question verbatim above the form. The Target section offers "Pick element" only
 * while a running session can take a pick over a reachable service; otherwise `TargetBadge` says
 * why, from the {@link targetPickAvailability} this module derives. With no session, the empty
 * state says either what asking a question does or, when the local service is not reachable, that
 * no session can start yet. File modifications say "nothing modified yet" until the plan exists
 * (`SessionPhase.awaitingPlan`) instead of the final "no files were modified". The Follow-up
 * section lists every follow-up asked in the session with its outcome, and while it takes none it
 * says why ({@link followUpUnavailableReason}): no result yet, the latest question still being
 * answered, the session ended or failed, or the service not reachable. Each component owns its own
 * generic wording; this module decides only which case applies (AAP 0.5.4).
 */

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactElement, Ref, RefObject } from 'react';

import {
  Badge,
  Button,
  Code,
  EmptyState,
  ErrorState,
  Heading,
  LoadingState,
  MODIFICATION_STATUS_TONE,
  PanelShell,
  Section,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import type { BadgeTone } from '@debuggen/panel-renderer';
import type {
  CleanupStatus,
  ModificationConflict,
  ModificationRecord,
  SessionRecord,
  SessionStatus,
  SourceLocation,
  SourceResolvedBy,
} from '@debuggen/protocol';
import { DEFAULT_RESOLUTION_CONFIDENCE, assertNever } from '@debuggen/shared';

import { MAX_WEBVIEW_QUESTION_LENGTH, isSubmittableQuestion } from '../webview-messages';
import type {
  HostToWebviewMessage,
  HostToWebviewMessageOf,
  PairingState,
  SessionCleanupState,
  StageFailure,
  WebviewState,
} from '../webview-messages';

import { AnalysisSummary } from './components/AnalysisSummary';
import { CaptureControls } from './components/CaptureControls';
import { FollowUp } from './components/FollowUp';
import type { FollowUpUnavailableReason } from './components/FollowUp';
import {
  CopyPathButton,
  ModificationsList,
  copyBackupPathLabel,
  modificationStatusLabel,
  originalBackupPathOf,
} from './components/ModificationsList';
import { PairingCode } from './components/PairingCode';
import { ProgressSteps } from './components/ProgressSteps';
import { QuestionForm } from './components/QuestionForm';
import { RelevantFiles } from './components/RelevantFiles';
import { StatusBar } from './components/StatusBar';
import { TargetBadge } from './components/TargetBadge';
import type { TargetPickAvailability } from './components/TargetBadge';
import {
  INITIAL_PENDING_ACTIONS_STATE,
  isPending,
  isWebviewRequestDraft,
  nextDeadline,
  pendingActionsReducer,
  withRequestId,
} from './pending-actions';
import type { WebviewToHostDraft } from './pending-actions';
import { useWebviewTheme } from './theme';
import { isVsCodeApiAvailable, postToHost, subscribeToHost } from './vscode-api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A section the host can move focus to with the `focus` message. */
type FocusSection = HostToWebviewMessageOf<'focus'>['section'];

/** The severity vocabulary of the `notice` message. */
type NoticeLevel = HostToWebviewMessageOf<'notice'>['level'];

/**
 * A pending request to move focus. `seq` makes two requests for the same section distinct, so a
 * repeated command lands again; `preferField` says whether the section's text field, rather than
 * the section itself, should receive focus.
 */
interface FocusRequest {
  readonly section: FocusSection;
  readonly seq: number;
  readonly preferField: boolean;
}

/** A transient notice the host pushed. Held beside the snapshot, never inside it. */
interface HostNotice {
  readonly id: string;
  readonly level: NoticeLevel;
  readonly message: string;
  readonly hint?: string | undefined;
}

/**
 * The notices on display together with the sequence that numbers them. Held as one value so a
 * notice's id is computed by a pure state update, never by a ref read during rendering.
 */
interface NoticeLog {
  readonly nextSeq: number;
  readonly notices: readonly HostNotice[];
}

/** One row of the notice region: a host notice or guidance derived from the snapshot. */
interface NoticeItem {
  readonly key: string;
  readonly level: NoticeLevel;
  readonly message: string;
  readonly hint?: string | undefined;
  /** Present for host notices only; derived guidance disappears when its cause does. */
  readonly onDismiss?: (() => void) | undefined;
  /** A single follow-up action, expressed as one of the declared host messages. */
  readonly action?: { readonly label: string; readonly onActivate: () => void } | undefined;
}

/**
 * What the session's status allows and implies, derived once per render so every component
 * reads the same answer. See {@link describeSessionPhase}.
 */
interface SessionPhase {
  /** A pipeline stage is working and more progress rows are expected. */
  readonly pipelineRunning: boolean;
  /** Understanding and investigation have not yet produced the relevant files. */
  readonly resolvingFiles: boolean;
  /**
   * The question is still being understood, investigated or planned, so no instrumentation plan
   * has been applied and no file can have been modified yet.
   */
  readonly awaitingPlan: boolean;
  /** The plan is being applied; modification records may still arrive. */
  readonly instrumenting: boolean;
  /** Instrumentation is ready and the developer should reproduce the issue. */
  readonly armed: boolean;
  /** A capture window is open, as the session status reports it. */
  readonly capturing: boolean;
  /** The capture is being analysed and a panel generated. */
  readonly analyzing: boolean;
  /** A new question may be asked without interrupting a session mid-flow. */
  readonly acceptsQuestion: boolean;
  /** A follow-up question can refer to a generated result. */
  readonly acceptsFollowUp: boolean;
  /** The session is neither ended nor failed, so it needs a bound DevTools panel. */
  readonly live: boolean;
  /** The session has ended; its cleanup outcome stays on screen. */
  readonly ended: boolean;
  /** The session stopped at a failed stage; it takes no pick and no follow-up. */
  readonly failed: boolean;
}

/** How the view presents one cleanup status. */
interface CleanupPresentation {
  readonly tone: BadgeTone;
  readonly label: string;
  readonly message: string;
}

/** How the view presents one notice level. */
interface NoticePresentation {
  readonly modifierClass: string;
  readonly tone: BadgeTone;
  readonly label: string;
}

// ---------------------------------------------------------------------------
// Copy — generic product vocabulary only (AAP 0.5.4)
// ---------------------------------------------------------------------------

const VIEW_TITLE = 'Debug Generator';

const NO_CHANNEL_TITLE = 'This view cannot reach the editor';
const NO_CHANNEL_MESSAGE =
  'The Debug Generator view is not connected to the VS Code extension host, so it can neither show nor start a session.';
const NO_CHANNEL_HINT =
  'Close and reopen the Debug Generator view. If this persists, run “Developer: Reload Window” from the Command Palette.';

const LOADING_LABEL = 'Loading the Debug Generator session';
const LOADING_ROWS = 4;

const NO_SESSION_TITLE = 'No session yet';
const NO_SESSION_MESSAGE =
  'Ask a question about the behaviour you are debugging. Debug Generator investigates your code, instruments only what it needs, and reports each step here as it happens.';
/** The no-session sentence while the local service is not reachable, so asking cannot start one. */
const NO_SESSION_SERVICE_MESSAGE =
  'The local Debug Generator service is not reachable, so no session can start yet. Once it is running, ask a question above: Debug Generator investigates your code, instruments only what it needs, and reports each step here as it happens.';

const QUESTION_SECTION_TITLE = 'Question';
const TARGET_SECTION_TITLE = 'Target';
const PROGRESS_SECTION_TITLE = 'Progress';
const FILES_SECTION_TITLE = 'Relevant files';
const MODIFICATIONS_SECTION_TITLE = 'File modifications';
const CAPTURE_SECTION_TITLE = 'Capture';
const ANALYSIS_SECTION_TITLE = 'Analysis';
const FOLLOW_UP_SECTION_TITLE = 'Follow-up';
const SESSION_END_SECTION_TITLE = 'Session cleanup';
const PAIRING_SECTION_TITLE = 'Chrome pairing';

/** The analysis head's title when no panel title exists yet; distinct from the section title. */
const ANALYSIS_HEAD_TITLE = 'Latest analysis';

const LAUNCH_DEV_SERVER_LABEL = 'Launch dev server';
const PAIR_CHROME_LABEL = 'Pair Chrome DevTools';
const END_SESSION_LABEL = 'End session';
const SESSION_ENDED_LABEL = 'Session ended.';
const RETRY_STAGE_LABEL = 'Retry stage';
const DISMISS_LABEL = 'Dismiss';
const CLEANUP_LABEL = 'Cleanup';

const NOTICES_LABEL = 'Debug Generator notices';

const FAILED_BADGE_LABEL = 'Failed';
const FAILED_STAGE_LABEL = 'Stage';
const FAILED_CODE_LABEL = 'Error code';
const UNREPORTED_FAILURE_MESSAGE =
  'The session stopped, but the failing stage was not reported to the editor.';
const UNREPORTED_FAILURE_HINT =
  'End the session to remove its instrumentation, then ask the question again.';

const CONFLICTS_LABEL = 'Files left untouched';
const UNRESTORED_LABEL = 'Files not restored';
const BACKUP_LABEL = 'Original saved at';

/**
 * A partial cleanup's sentence when the complete journal shows that no file is outstanding: the
 * unfinished step was not a file restore (runtime hooks whose disarm could not be confirmed), so
 * the generic "some changes could not be restored" would misdirect the reader to their files.
 */
const PARTIAL_FILES_RESTORED_MESSAGE =
  'Every file the session changed was restored, but not every cleanup step could be confirmed. Nothing was overwritten.';
const PARTIAL_NO_FILES_MESSAGE =
  'No file was modified, but not every cleanup step could be confirmed. Nothing was overwritten.';

const SERVICE_UNREACHABLE_MESSAGE =
  'The local Debug Generator service did not answer its last health check.';
const SERVICE_UNREACHABLE_HINT =
  'Run “Debug Generator: Start Local Service” from the Command Palette if it does not recover.';

const UNBOUND_MESSAGE = 'No Chrome DevTools panel is bound to this session yet.';
const UNBOUND_HINT =
  'Open your app in Chrome, then open DevTools and select the Debug Generator panel. A panel that has never been paired asks for a pairing code first.';

const UNDELIVERED_MESSAGE = 'That action could not be passed to the editor.';
const UNDELIVERED_HINT =
  'Try again. If it keeps failing, close and reopen the Debug Generator view.';

const BLANK_QUESTION_MESSAGE = 'That question is empty, so it was not sent.';
const BLANK_QUESTION_HINT = 'Type a question, then ask again.';

/**
 * Formats a character count for the view's copy: the locale's digit grouping and no fraction, the
 * same format the question and follow-up counters use.
 */
const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many host notices are kept; the oldest is dropped first so the view never grows unbounded. */
const MAX_NOTICES = 5;

/**
 * Random bytes in one request id: 16 (128 bits), written as 32 lowercase hex characters — well
 * inside the contract's `MAX_WEBVIEW_REQUEST_ID_LENGTH` and `[A-Za-z0-9_-]` alphabet, and wide
 * enough that two requests of one view never share an id.
 */
const REQUEST_ID_BYTES = 16;

/** The class of every focus or reveal target wrapper; declared in `./styles.css`. */
const ANCHOR_CLASS = 'dgv-view__anchor';

/**
 * Line and column of a whole-file open. `SourceLocation` is 1-based on both axes, and a resolver
 * that knows a file but no position reports its start (see `@debuggen/shared`'s schema).
 */
const FILE_START_LINE = 1;
const FILE_START_COLUMN = 1;

/** The phase before any status applies: no session exists yet. */
const IDLE_PHASE: SessionPhase = Object.freeze({
  pipelineRunning: false,
  resolvingFiles: false,
  awaitingPlan: false,
  instrumenting: false,
  armed: false,
  capturing: false,
  analyzing: false,
  acceptsQuestion: true,
  acceptsFollowUp: false,
  live: false,
  ended: false,
  failed: false,
});

/** The steady state of a session mid-flow; each status below overrides what differs. */
const LIVE_PHASE: SessionPhase = Object.freeze({
  ...IDLE_PHASE,
  acceptsQuestion: false,
  live: true,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * What a session status allows. Closed by {@link assertNever}, so a status added to the
 * protocol's `SESSION_STATUSES` is a compile error here until the view says what it means.
 *
 * Capture can start only from `ready` and stop only while `capturing`, and follow-ups start
 * from `generated` — the service's own transition table.
 *
 * @param status The active session's status.
 * @returns The phase every component of the view reads.
 */
function describeSessionPhase(status: SessionStatus): SessionPhase {
  switch (status) {
    case 'created':
    case 'understanding':
    case 'investigating':
      return { ...LIVE_PHASE, pipelineRunning: true, resolvingFiles: true, awaitingPlan: true };
    case 'planning':
      return { ...LIVE_PHASE, pipelineRunning: true, awaitingPlan: true };
    case 'instrumenting':
      return { ...LIVE_PHASE, pipelineRunning: true, instrumenting: true };
    case 'ready':
      return { ...LIVE_PHASE, armed: true };
    case 'capturing':
      return { ...LIVE_PHASE, capturing: true };
    case 'analyzing':
      return { ...LIVE_PHASE, pipelineRunning: true, analyzing: true };
    case 'generated':
      return { ...LIVE_PHASE, acceptsQuestion: true, acceptsFollowUp: true };
    case 'ended':
      return { ...IDLE_PHASE, ended: true };
    case 'failed':
      return { ...IDLE_PHASE, failed: true };
    default:
      return assertNever(status, 'Unhandled session status');
  }
}

/**
 * Whether the view can ask for an element pick, and if not, why. A pick is asked of the DevTools
 * panel bound to a running session, so it needs a session that has neither ended nor failed and a
 * reachable service; the host answers any other pick with a notice, so the control is withheld and
 * `TargetBadge` states the reason instead.
 *
 * @param hasSession Whether the snapshot carries an active session.
 * @param phase The active session's phase ({@link IDLE_PHASE} without one).
 * @param serviceUnavailable Whether nothing that needs the service can be started.
 * @returns The availability `TargetBadge` renders.
 */
function targetPickAvailability(
  hasSession: boolean,
  phase: SessionPhase,
  serviceUnavailable: boolean,
): TargetPickAvailability {
  if (!hasSession) {
    return serviceUnavailable ? 'serviceUnavailable' : 'noSession';
  }
  if (phase.ended) {
    return 'ended';
  }
  if (phase.failed) {
    return 'failed';
  }
  return serviceUnavailable ? 'serviceUnavailable' : 'available';
}

/**
 * Why the follow-up entry is closed, for the sentence `FollowUp` shows while it is. An ended or
 * failed session takes no follow-up at all, whatever the connection; an unreachable service
 * closes it next; otherwise a session that already has an analysis is answering its latest
 * question (a follow-up being re-analysed or re-captured), and one without an analysis has not
 * produced its first result.
 *
 * @param phase The active session's phase.
 * @param serviceUnavailable Whether nothing that needs the service can be started.
 * @param hasAnalysis Whether the snapshot carries an analysis of the session.
 * @returns The reason `FollowUp` states; read only while the entry is closed.
 */
function followUpUnavailableReason(
  phase: SessionPhase,
  serviceUnavailable: boolean,
  hasAnalysis: boolean,
): FollowUpUnavailableReason {
  if (phase.ended) {
    return 'ended';
  }
  if (phase.failed) {
    return 'failed';
  }
  if (serviceUnavailable) {
    return 'serviceUnavailable';
  }
  return hasAnalysis ? 'working' : 'awaitingResult';
}

/**
 * The badge and sentence of each session cleanup status (AAP 0.5.1). A conflict and a partial
 * cleanup both say that nothing was overwritten, because that is the guarantee they report.
 *
 * @param status The session's cleanup status.
 * @returns Its presentation.
 */
function describeCleanup(status: CleanupStatus): CleanupPresentation {
  switch (status) {
    case 'pending':
      return {
        tone: 'neutral',
        label: 'Pending',
        message:
          'Instrumentation stays in place until the session ends. Ending it restores every file the session changed.',
      };
    case 'clean':
      return {
        tone: 'success',
        label: 'Clean',
        message: 'Every file the session changed was restored to its original content.',
      };
    case 'partial':
      return {
        tone: 'warning',
        label: 'Partial',
        message:
          'Some changes could not be restored automatically. Nothing was overwritten, and the originals are preserved.',
      };
    case 'conflict':
      return {
        tone: 'warning',
        label: 'Conflict',
        message:
          'Files edited while instrumented were left untouched, so your edits are kept. Debug Generator did not overwrite them, and their originals are preserved.',
      };
    default:
      return assertNever(status, 'Unhandled cleanup status');
  }
}

/**
 * The tone of each notice level. The badge label names the level in words, so colour is never
 * its only carrier.
 *
 * @param level The notice's level.
 * @returns The modifier class of `./styles.css`, the badge tone and the badge label.
 */
function describeNoticeLevel(level: NoticeLevel): NoticePresentation {
  switch (level) {
    case 'info':
      return { modifierClass: 'dgv-notice--info', tone: 'info', label: 'Info' };
    case 'warning':
      return { modifierClass: 'dgv-notice--warning', tone: 'warning', label: 'Warning' };
    case 'error':
      return { modifierClass: 'dgv-notice--danger', tone: 'danger', label: 'Error' };
    default:
      return assertNever(level, 'Unhandled notice level');
  }
}

/**
 * Whether a focus request should land in the section's text field rather than on the section.
 * Called when the `focus` message arrives — outside rendering — so a section this build does
 * not know fails loudly there instead of inside a React commit.
 *
 * @param section The section the host named.
 * @returns `true` for the two sections whose purpose is typing a question.
 */
function focusLandsOnField(section: FocusSection): boolean {
  switch (section) {
    case 'question':
    case 'followUp':
      return true;
    case 'modifications':
    case 'analysis':
      return false;
    default:
      return assertNever(section, 'Unhandled focus section');
  }
}

/**
 * Builds the `SourceLocation` of a whole-file open for a path the pipeline reported without a
 * position — a relevant file or an instrumented file. The route is the one that produced the
 * path, and its confidence is that route's documented default: nothing is invented beyond
 * "the start of this file". The host validates the path against the project root.
 *
 * @param file The project-relative POSIX path, exactly as received.
 * @param resolvedBy The mechanism that named the file.
 * @returns The location to send with `openFile`.
 */
function wholeFileLocation(file: string, resolvedBy: SourceResolvedBy): SourceLocation {
  return {
    file,
    line: FILE_START_LINE,
    column: FILE_START_COLUMN,
    resolvedBy,
    confidence: DEFAULT_RESOLUTION_CONFIDENCE[resolvedBy],
  };
}

/** The notice log before anything has been said. */
const EMPTY_NOTICE_LOG: NoticeLog = Object.freeze({ nextSeq: 1, notices: [] });

/**
 * Appends a notice with the log's next id, dropping the oldest beyond {@link MAX_NOTICES}. Pure,
 * so React may replay it as a state updater without numbering a notice twice.
 *
 * @param log The notices on display and their sequence.
 * @param level The notice's level.
 * @param message The notice text, verbatim.
 * @param hint The next step, when there is one.
 * @returns The new log.
 */
function addNotice(
  log: NoticeLog,
  level: NoticeLevel,
  message: string,
  hint: string | undefined,
): NoticeLog {
  const notice: HostNotice = { id: `notice-${String(log.nextSeq)}`, level, message, hint };
  const next = [...log.notices, notice];
  return {
    nextSeq: log.nextSeq + 1,
    notices: next.length > MAX_NOTICES ? next.slice(next.length - MAX_NOTICES) : next,
  };
}

/**
 * Removes one notice by id.
 *
 * @param log The notices on display and their sequence.
 * @param id The notice to remove.
 * @returns The new log; the sequence never moves backwards.
 */
function removeNotice(log: NoticeLog, id: string): NoticeLog {
  return { nextSeq: log.nextSeq, notices: log.notices.filter((notice) => notice.id !== id) };
}

/**
 * The notice for a question the view withheld because the host would refuse it (see
 * `isSubmittableQuestion`): one over the limit states the limit, a blank one says it is empty.
 * Decided by length alone — the question is data and its wording is never read (AAP 0.5.4).
 *
 * @param length The withheld question's length in UTF-16 code units.
 * @returns The notice's message and its next step.
 */
function withheldQuestionNotice(length: number): { message: string; hint: string } {
  if (length > MAX_WEBVIEW_QUESTION_LENGTH) {
    const limit = COUNT_FORMAT.format(MAX_WEBVIEW_QUESTION_LENGTH);
    return {
      message: `That question is longer than the ${limit}-character limit, so it was not sent.`,
      hint: `Shorten it to ${limit} characters or fewer, then ask again.`,
    };
  }
  return { message: BLANK_QUESTION_MESSAGE, hint: BLANK_QUESTION_HINT };
}

/**
 * Scrolls `element` into the viewport when the platform supports it. The single `PanelShell`
 * viewport is the scroll container, so the nearest edge is enough.
 *
 * @param element The element to reveal.
 */
function reveal(element: HTMLElement): void {
  if (typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * Mints the id of one request: {@link REQUEST_ID_BYTES} bytes from the platform's CSPRNG, as
 * lowercase hex. Called from the send path only — an event handler — and never from the reducer,
 * which must stay free of randomness for StrictMode's replay. The id is a correlation handle, not
 * a secret: it only lets the host's `actionResult` name the request it answers.
 *
 * @returns 32 characters from `[0-9a-f]`.
 *
 * @example
 * ```ts
 * createRequestId(); // e.g. '5f0c2a9e7b1d4c3a8e6f2b0d9a7c1e4f'
 * ```
 */
function createRequestId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(REQUEST_ID_BYTES));
  let id = '';
  for (const byte of bytes) {
    id += byte.toString(16).padStart(2, '0');
  }
  return id;
}

// ---------------------------------------------------------------------------
// View-local presentational pieces (props in, callbacks out)
// ---------------------------------------------------------------------------

/** Props of {@link NoticeRegion}. */
interface NoticeRegionProps {
  readonly items: readonly NoticeItem[];
  /**
   * The region element, so `App` can return focus to it after a dismissal removes the focused
   * button. The region is focusable by script only (`tabIndex={-1}`).
   */
  readonly ref?: Ref<HTMLDivElement> | undefined;
}

/**
 * The notice region: host notices and snapshot-derived guidance, newest last. A polite
 * `role="status"` region — never `role="alert"`, which belongs to `ErrorState` — rendered only
 * while it has something to say, so an empty region never takes a gap in the view's rhythm.
 */
function NoticeRegion(props: NoticeRegionProps): ReactElement | null {
  const { items, ref } = props;
  if (items.length === 0) {
    return null;
  }
  return (
    <div
      ref={ref}
      className="dgv-notices"
      role="status"
      aria-live="polite"
      aria-label={NOTICES_LABEL}
      tabIndex={-1}
    >
      {items.map((item) => {
        const presentation = describeNoticeLevel(item.level);
        return (
          <div key={item.key} className={`dgv-notice ${presentation.modifierClass}`}>
            <Badge tone={presentation.tone}>{presentation.label}</Badge>
            <Stack gap={1} className="dgv-notice__text">
              <Text as="p" size="sm">
                {item.message}
              </Text>
              {item.hint === undefined ? null : (
                <Text as="p" size="sm" tone="secondary">
                  {item.hint}
                </Text>
              )}
              {item.action === undefined ? null : (
                <Stack direction="horizontal" gap={2} wrap>
                  <Button variant="secondary" size="sm" onClick={item.action.onActivate}>
                    {item.action.label}
                  </Button>
                </Stack>
              )}
            </Stack>
            {item.onDismiss === undefined ? null : (
              <Button
                variant="ghost"
                size="sm"
                className="dgv-notice__dismiss"
                onClick={item.onDismiss}
                aria-label={`${DISMISS_LABEL}: ${item.message}`}
              >
                {DISMISS_LABEL}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Props of {@link StageFailureNotice}. */
interface StageFailureNoticeProps {
  /** The failed stage the host reported; absent when the session failed without one. */
  readonly failure: StageFailure | undefined;
  /** Retries the failed stage; offered only when a stage is named. */
  readonly onRetry: () => void;
  /** A retry was sent and the host has not answered yet. */
  readonly retrying: boolean;
}

/**
 * A failed pipeline stage, rendered as a failure and never as a result (AAP 0.5.5): the danger
 * card of `./styles.css` naming the stage, the service's message and hint, the error code and the
 * retry action. Announced as an alert because the pipeline has stopped.
 */
function StageFailureNotice(props: StageFailureNoticeProps): ReactElement {
  const { failure, onRetry, retrying } = props;
  return (
    <div className="dgv-stage-failure" role="alert">
      <Stack direction="horizontal" gap={2} align="center" wrap>
        <Badge tone="danger">{FAILED_BADGE_LABEL}</Badge>
        {failure === undefined ? null : (
          <>
            <Text size="sm" weight="medium">
              {FAILED_STAGE_LABEL}
            </Text>
            <Code size="sm" className="dgv-stage-failure__stage">
              {failure.stage}
            </Code>
          </>
        )}
      </Stack>
      <Text as="p" size="sm">
        {failure === undefined ? UNREPORTED_FAILURE_MESSAGE : failure.message}
      </Text>
      {failure === undefined ? (
        <Text as="p" size="sm" tone="secondary">
          {UNREPORTED_FAILURE_HINT}
        </Text>
      ) : (
        <>
          {failure.hint === undefined ? null : (
            <Text as="p" size="sm" tone="secondary">
              {failure.hint}
            </Text>
          )}
          <Stack direction="horizontal" gap={2} align="center" justify="between" wrap>
            <Stack direction="horizontal" gap={1} align="center">
              <Text size="xs" tone="muted">
                {FAILED_CODE_LABEL}
              </Text>
              <Code size="sm">{failure.code}</Code>
            </Stack>
            <Button variant="secondary" size="sm" onClick={onRetry} disabled={retrying}>
              {RETRY_STAGE_LABEL}
            </Button>
          </Stack>
        </>
      )}
    </div>
  );
}

/** Props of {@link SessionEnd}. */
interface SessionEndProps {
  readonly cleanup: SessionCleanupState;
  /**
   * The session's modification records (`WebviewState.modifications`): a partial cleanup names
   * every record it did not restore from these, since the cleanup result itself lists conflicts
   * only.
   */
  readonly modifications: readonly ModificationRecord[];
  /**
   * The journal's length as last counted (`WebviewState.modificationsTotal`); absent until the
   * journal has been read. Only a list known to be complete may say that no file is outstanding.
   */
  readonly modificationsTotal: number | undefined;
  readonly ended: boolean;
  readonly ending: boolean;
  readonly onEnd: () => void;
}

/**
 * Where a cleanup conflict's pristine original is saved — the path its "Original saved at" names.
 *
 * The conflict's `originalBackupPath` when the service reported one: the chain root's backup,
 * resolved over the whole journal, for a record layered on an earlier plan version's. A report
 * without it names its own `backupPath`, which for a chained record holds that earlier version's
 * instrumented output; so when the conflict's record is listed and chained, its chain is walked
 * through the listed records instead (`originalBackupPathOf`), which is also the path the
 * modifications list shows for it. Any other conflict keeps its own `backupPath`.
 *
 * @param conflict The service's conflict report.
 * @param records The session's listed modification records.
 * @returns The path to show and copy.
 */
function conflictOriginalBackupPath(
  conflict: ModificationConflict,
  records: readonly ModificationRecord[],
): string {
  if (conflict.originalBackupPath !== undefined) {
    return conflict.originalBackupPath;
  }
  const record = records.find((candidate) => candidate.id === conflict.recordId);
  return record?.previousRecordId === undefined
    ? conflict.backupPath
    : originalBackupPathOf(record, records);
}

/**
 * One file in a cleanup list: its path, then — unless the service reported the backup missing —
 * "Original saved at" with the backup path and its "Copy path" control. Both paths are shown in
 * full, wrapped across lines rather than ellipsized, so the reader can read, select and copy the
 * exact value they need to restore a file by hand.
 *
 * `backupPath` is the path of the file's pristine original, never an intermediate version: for a
 * record layered on an earlier plan version's, whose own backup still carries that version's
 * instrumentation, it is the chain root's backup. The caller resolves it.
 */
function CleanupFileEntry(props: {
  readonly file: string;
  readonly backupPath: string | undefined;
  readonly status?: ModificationRecord['status'] | undefined;
  readonly pathId: string;
}): ReactElement {
  const { file, backupPath, status, pathId } = props;
  const path = (
    <Code size="sm" wrap className="dgv-cleanup__conflict-file">
      {file}
    </Code>
  );
  return (
    <Stack gap={1}>
      {status === undefined ? (
        path
      ) : (
        <Stack direction="horizontal" gap={2} wrap align="center">
          {path}
          <Badge tone={MODIFICATION_STATUS_TONE[status]} variant="soft">
            {modificationStatusLabel(status)}
          </Badge>
        </Stack>
      )}
      {backupPath === undefined || backupPath.trim() === '' ? null : (
        <>
          <Text size="xs" tone="secondary">
            {BACKUP_LABEL}
          </Text>
          <Code size="sm" wrap id={pathId} className="dgv-cleanup__conflict-file">
            {backupPath}
          </Code>
          <CopyPathButton
            path={backupPath}
            accessibleLabel={copyBackupPathLabel(file)}
            targetId={pathId}
          />
        </>
      )}
    </Stack>
  );
}

/**
 * The "End session" control and the cleanup outcome it produces. The outcome stays on screen
 * after the session ends — reversibility is a product guarantee, not a toast (AAP 0.5.1, 0.5.5).
 *
 * A conflict or partial cleanup lists every file left untouched, from the result's conflicts,
 * with the backup its pristine original is preserved in ({@link conflictOriginalBackupPath}): the
 * conflict's `originalBackupPath` when it carries one (a record layered on an earlier plan
 * version's), its `backupPath` otherwise. A partial cleanup also names every other record that
 * is not `reverted` — the files it could not restore — with its status and the backup of its
 * pristine original, resolved through the record's chain by `originalBackupPathOf`. When the
 * complete journal shows that nothing is outstanding, the partial sentence says that every file
 * was restored instead of pointing at files, because the unfinished step was not a file restore.
 * Each list spans the cleanup column's full width, and every path wraps with a "Copy path"
 * control beside the backup.
 */
function SessionEnd(props: SessionEndProps): ReactElement {
  const { cleanup, modifications, modificationsTotal, ended, ending, onEnd } = props;
  const idPrefix = useId();
  const presentation = describeCleanup(cleanup.status);
  const listConflicts =
    (cleanup.status === 'conflict' || cleanup.status === 'partial') && cleanup.conflicts.length > 0;
  const conflicted = new Set(cleanup.conflicts.map((conflict) => conflict.recordId));
  const unrestored =
    cleanup.status === 'partial'
      ? modifications.filter((record) => record.status !== 'reverted' && !conflicted.has(record.id))
      : [];
  const journalComplete =
    modificationsTotal !== undefined && modificationsTotal <= modifications.length;
  const nothingOutstanding =
    cleanup.status === 'partial' &&
    journalComplete &&
    cleanup.conflicts.length === 0 &&
    unrestored.length === 0;
  const message = nothingOutstanding
    ? modifications.length === 0
      ? PARTIAL_NO_FILES_MESSAGE
      : PARTIAL_FILES_RESTORED_MESSAGE
    : presentation.message;
  return (
    <div className="dgv-session-end">
      <div className="dgv-cleanup">
        <Stack direction="horizontal" gap={1} align="center">
          <Text size="xs" tone="muted">
            {CLEANUP_LABEL}
          </Text>
          <Badge tone={presentation.tone} data-cleanup-status={cleanup.status}>
            {presentation.label}
          </Badge>
        </Stack>
        <Text as="p" size="sm" tone="secondary">
          {message}
        </Text>
        {listConflicts ? (
          <ul className="dgv-cleanup__conflict" aria-label={CONFLICTS_LABEL}>
            {cleanup.conflicts.map((conflict: ModificationConflict, index) => (
              <li key={`${conflict.recordId}-${String(index)}`}>
                <CleanupFileEntry
                  file={conflict.file}
                  backupPath={
                    conflict.reason === 'backup-missing'
                      ? undefined
                      : conflictOriginalBackupPath(conflict, modifications)
                  }
                  pathId={`${idPrefix}-conflict-${String(index)}`}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {unrestored.length > 0 ? (
          <ul className="dgv-cleanup__conflict" aria-label={UNRESTORED_LABEL}>
            {unrestored.map((record, index) => (
              <li key={record.id}>
                <CleanupFileEntry
                  file={record.file}
                  backupPath={originalBackupPathOf(record, modifications)}
                  status={record.status}
                  pathId={`${idPrefix}-unrestored-${String(index)}`}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {ended ? (
        <Text size="sm" tone="secondary">
          {SESSION_ENDED_LABEL}
        </Text>
      ) : (
        <Button variant="danger" onClick={onEnd} disabled={ending}>
          {END_SESSION_LABEL}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The composition root
// ---------------------------------------------------------------------------

/**
 * The "Debug Generator" view: the one holder of the host's snapshot and the one sender of
 * host messages. Takes no props — the theme is read live from the editor and everything else
 * arrives over the host channel.
 *
 * @returns The whole webview surface, in its no-channel, loading or loaded state.
 */
export function App(): ReactElement {
  const theme = useWebviewTheme();

  // The id of the view's visually hidden title, which every state below renders and hands to
  // `PanelShell` as `labelledBy`: the shell's scroll region is the first stop in the view's tab
  // order, and naming it after the view's own title is what stops it announcing as an anonymous
  // container. Declared before the early returns, as every hook here must be.
  const viewTitleId = useId();

  // Read once: the channel either exists for the life of the document or never does.
  const [hostAvailable] = useState<boolean>(isVsCodeApiAvailable);

  // The host's snapshot, replaced wholesale on every `state` push.
  const [state, setState] = useState<WebviewState | undefined>(undefined);

  // Transient, UI-only state beside it.
  const [pairing, setPairing] = useState<PairingState | undefined>(undefined);
  const [noticeLog, setNoticeLog] = useState<NoticeLog>(EMPTY_NOTICE_LOG);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | undefined>(undefined);
  // Every request handed to the host and not yet answered by its own `actionResult`, plus the
  // outcome of the last question and follow-up (see `./pending-actions`).
  const [pendingActions, dispatchPending] = useReducer(
    pendingActionsReducer,
    INITIAL_PENDING_ACTIONS_STATE,
  );
  // Counts dismissals, so focus can be returned after the dismissed notice's button unmounts.
  const [dismissals, setDismissals] = useState(0);
  // Counts pairing codes issued while the view is open, each of which is scrolled into view.
  const [pairingReveals, setPairingReveals] = useState(0);

  const handledFocusSeq = useRef(0);
  const handledDismissals = useRef(0);
  const handledPairingReveals = useRef(0);
  // Read and written by the host-message handler only (never during rendering): whether the first
  // snapshot has arrived, and the code last put on display.
  const firstSnapshotHandled = useRef(false);
  const displayedPairingCode = useRef<string | undefined>(undefined);

  const questionRef = useRef<HTMLDivElement>(null);
  const modificationsRef = useRef<HTMLDivElement>(null);
  const analysisRef = useRef<HTMLDivElement>(null);
  const followUpRef = useRef<HTMLDivElement>(null);
  const pairingRef = useRef<HTMLDivElement>(null);
  const noticesRef = useRef<HTMLDivElement>(null);

  // One subscription for the life of the view. `vscode-api` replays the buffered opening
  // snapshot to it and keeps exactly one `message` listener under StrictMode. Only `actionResult`
  // reaches the pending-request reducer: snapshots, notices and pairing frames name no request,
  // so they update what the view shows and settle nothing.
  useEffect(
    () =>
      subscribeToHost((message: HostToWebviewMessage) => {
        switch (message.type) {
          case 'state': {
            // A code already present in the first snapshot (a reloaded view) is not "new".
            const code = message.state.pairing?.code;
            if (
              firstSnapshotHandled.current &&
              code !== undefined &&
              code !== displayedPairingCode.current
            ) {
              setPairingReveals((count) => count + 1);
            }
            firstSnapshotHandled.current = true;
            displayedPairingCode.current = code;
            setState(message.state);
            setPairing(message.state.pairing);
            return;
          }
          case 'notice':
            setNoticeLog((log) => addNotice(log, message.level, message.message, message.hint));
            return;
          case 'pairing': {
            const code = message.pairing?.code;
            if (code !== undefined && code !== displayedPairingCode.current) {
              setPairingReveals((count) => count + 1);
            }
            displayedPairingCode.current = code;
            setPairing(message.pairing);
            return;
          }
          case 'focus': {
            const preferField = focusLandsOnField(message.section);
            setFocusRequest((previous) => ({
              section: message.section,
              seq: (previous?.seq ?? 0) + 1,
              preferField,
            }));
            return;
          }
          case 'actionResult':
            // The one frame that settles a request, and only the pending one of `action` whose id
            // it echoes: a superseded, timed-out or already answered request's result is ignored.
            dispatchPending({
              kind: 'result',
              requestId: message.requestId,
              action: message.action,
              status: message.status,
            });
            return;
          default:
            assertNever(message, 'Unhandled host message');
        }
      }),
    [],
  );

  /**
   * Posts one message. A request draft is given a fresh id ({@link createRequestId}) and, once
   * delivered, becomes pending until its own `actionResult` arrives; the clock and the randomness
   * are read here, in the event path, so the reducer stays pure. `openFile` waits on nothing and is
   * posted as composed. A message the host channel refused becomes a visible notice, and a refused
   * question or follow-up is reported to its form as failed so the typed text is kept.
   *
   * A question or follow-up the host's parser would refuse — blank, or longer than
   * `MAX_WEBVIEW_QUESTION_LENGTH` — is never posted: the host answers such a frame with a notice
   * and no `actionResult`, which would hold the form busy until the safety timeout. It is withheld
   * instead, with a notice that says why: no request begins, so the form never turns busy and
   * keeps the draft, and no failed outcome is published, because nothing was submitted and the
   * form's "try again" hint would contradict the notice's "shorten it".
   */
  const send = useCallback((draft: WebviewToHostDraft): void => {
    if (!isWebviewRequestDraft(draft)) {
      if (!postToHost(draft)) {
        setNoticeLog((log) => addNotice(log, 'error', UNDELIVERED_MESSAGE, UNDELIVERED_HINT));
      }
      return;
    }
    if (
      (draft.type === 'askQuestion' || draft.type === 'askFollowUp') &&
      !isSubmittableQuestion(draft.question)
    ) {
      const withheld = withheldQuestionNotice(draft.question.length);
      setNoticeLog((log) => addNotice(log, 'error', withheld.message, withheld.hint));
      return;
    }
    const requestId = createRequestId();
    const message = withRequestId(draft, requestId);
    if (postToHost(message)) {
      dispatchPending({ kind: 'begin', type: message.type, requestId, now: Date.now() });
      return;
    }
    dispatchPending({ kind: 'undelivered', type: message.type });
    setNoticeLog((log) => addNotice(log, 'error', UNDELIVERED_MESSAGE, UNDELIVERED_HINT));
  }, []);

  // One timer for the earliest pending deadline, re-armed whenever that deadline changes and
  // cleared on unmount. When it fires, the timer's own elapsed time is the authority: `now` is at
  // least the deadline it was armed for, so the entry it waited on is always settled.
  const pendingDeadline = nextDeadline(pendingActions);
  useEffect(() => {
    if (pendingDeadline === undefined) {
      return undefined;
    }
    const timer = setTimeout(
      () => {
        dispatchPending({ kind: 'expire', now: Math.max(Date.now(), pendingDeadline) });
      },
      Math.max(0, pendingDeadline - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [pendingDeadline]);

  const dismissNotice = useCallback((id: string): void => {
    setNoticeLog((log) => removeNotice(log, id));
    setDismissals((count) => count + 1);
  }, []);

  const askQuestion = useCallback(
    (question: string): void => {
      send({ type: 'askQuestion', question });
    },
    [send],
  );
  const askFollowUp = useCallback(
    (question: string): void => {
      send({ type: 'askFollowUp', question });
    },
    [send],
  );
  const startCapture = useCallback((): void => {
    send({ type: 'startCapture' });
  }, [send]);
  const stopCapture = useCallback((): void => {
    send({ type: 'stopCapture' });
  }, [send]);
  const endSession = useCallback((): void => {
    send({ type: 'endSession' });
  }, [send]);
  const requestTarget = useCallback((): void => {
    send({ type: 'requestTarget' });
  }, [send]);
  const pairChrome = useCallback((): void => {
    send({ type: 'pairChrome' });
  }, [send]);
  const dismissPairing = useCallback((): void => {
    send({ type: 'dismissPairing' });
  }, [send]);
  const launchDevServer = useCallback((): void => {
    send({ type: 'launchDevServer' });
  }, [send]);
  const loadModifications = useCallback((): void => {
    send({ type: 'loadModifications' });
  }, [send]);
  const openRelevantFile = useCallback(
    (file: string): void => {
      send({ type: 'openFile', location: wholeFileLocation(file, 'code-graph') });
    },
    [send],
  );
  const openModifiedFile = useCallback(
    (file: string): void => {
      send({ type: 'openFile', location: wholeFileLocation(file, 'patch') });
    },
    [send],
  );
  const openSource = useCallback(
    (location: SourceLocation): void => {
      send({ type: 'openFile', location });
    },
    [send],
  );
  const failedStage = state?.failure?.stage;
  const retryFailedStage = useCallback((): void => {
    if (failedStage !== undefined) {
      send({ type: 'retryStage', stage: failedStage });
    }
  }, [failedStage, send]);

  // Moves focus once per request, after the section it names has rendered. A section that is
  // not on screen (no session yet) falls back to the question, which always is.
  const loaded = state !== undefined;
  useEffect(() => {
    if (focusRequest === undefined || !loaded || handledFocusSeq.current === focusRequest.seq) {
      return;
    }
    handledFocusSeq.current = focusRequest.seq;
    const targets: Readonly<Record<FocusSection, RefObject<HTMLDivElement | null>>> = {
      question: questionRef,
      modifications: modificationsRef,
      analysis: analysisRef,
      followUp: followUpRef,
    };
    const element = targets[focusRequest.section].current ?? questionRef.current;
    if (element === null) {
      return;
    }
    reveal(element);
    const field = focusRequest.preferField
      ? element.querySelector<HTMLElement>('textarea:not([disabled])')
      : null;
    (field ?? element).focus({ preventScroll: true });
  }, [focusRequest, loaded]);

  // A code issued while the view is open is revealed, since it is only useful while it is read.
  // The decision is made where the message arrives; this effect only scrolls, once the card is on
  // screen, so a request made before the first snapshot waits for it.
  useEffect(() => {
    const element = pairingRef.current;
    if (pairingReveals === handledPairingReveals.current || !loaded || element === null) {
      return;
    }
    handledPairingReveals.current = pairingReveals;
    reveal(element);
  }, [pairingReveals, loaded]);

  // Dismissing a notice unmounts the focused button; focus returns to the notice region, or to
  // the question section once the region has emptied, instead of falling to the document body.
  useEffect(() => {
    if (dismissals === handledDismissals.current) {
      return;
    }
    handledDismissals.current = dismissals;
    const target = noticesRef.current ?? questionRef.current;
    target?.focus({ preventScroll: true });
  }, [dismissals]);

  const session: SessionRecord | undefined = state?.session;
  const phase = session === undefined ? IDLE_PHASE : describeSessionPhase(session.status);
  const connectionStatus = state?.connection.status;
  const serviceReachable = state?.connection.serviceReachable ?? true;
  // Nothing that needs the service can be started: the client gave up, or the service is known
  // unreachable and not connected. Actions that need it are withheld rather than left to fail.
  const serviceUnavailable =
    connectionStatus === 'closed' || (!serviceReachable && connectionStatus !== 'open');
  // What the Target and Follow-up sections can offer now, and why not when they cannot. Derived
  // here, beside the phase and before any memoised value reads it, so every section of one render
  // reads the same answer.
  const pickAvailability = targetPickAvailability(session !== undefined, phase, serviceUnavailable);
  const followUpClosedReason = followUpUnavailableReason(
    phase,
    serviceUnavailable,
    state?.analysis !== undefined,
  );

  // Guidance derived from the snapshot, for conditions no declared host message can fix: the
  // service is started by a contributed command, and binding happens in Chrome DevTools.
  const serviceWarning = loaded && !serviceReachable && connectionStatus !== 'closed';
  const unbound =
    session !== undefined &&
    phase.live &&
    session.boundTab === undefined &&
    connectionStatus === 'open';

  const noticeItems = useMemo<readonly NoticeItem[]>(() => {
    const items: NoticeItem[] = [];
    if (serviceWarning) {
      items.push({
        key: 'guidance-service',
        level: 'warning',
        message: SERVICE_UNREACHABLE_MESSAGE,
        hint: SERVICE_UNREACHABLE_HINT,
      });
    }
    if (unbound) {
      items.push({
        key: 'guidance-binding',
        level: 'info',
        message: UNBOUND_MESSAGE,
        hint: UNBOUND_HINT,
        action: { label: PAIR_CHROME_LABEL, onActivate: pairChrome },
      });
    }
    for (const notice of noticeLog.notices) {
      items.push({
        key: notice.id,
        level: notice.level,
        message: notice.message,
        hint: notice.hint,
        onDismiss: () => {
          dismissNotice(notice.id);
        },
      });
    }
    return items;
  }, [serviceWarning, unbound, noticeLog, pairChrome, dismissNotice]);

  const launchingDevServer = isPending(pendingActions, 'launchDevServer');
  const pairingChrome = isPending(pendingActions, 'pairChrome');
  const noSessionActions = useMemo(
    () => (
      <Stack direction="horizontal" gap={2} wrap>
        <Button
          variant="secondary"
          size="sm"
          onClick={launchDevServer}
          disabled={serviceUnavailable || launchingDevServer}
        >
          {LAUNCH_DEV_SERVER_LABEL}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={pairChrome}
          disabled={serviceUnavailable || pairingChrome}
        >
          {PAIR_CHROME_LABEL}
        </Button>
      </Stack>
    ),
    [launchDevServer, pairChrome, launchingDevServer, pairingChrome, serviceUnavailable],
  );

  if (!hostAvailable) {
    return (
      <PanelShell theme={theme} labelledBy={viewTitleId}>
        <div className="dgv-view">
          <Heading level={1} visuallyHidden id={viewTitleId}>
            {VIEW_TITLE}
          </Heading>
          <main className="dgv-view__body">
            <ErrorState
              title={NO_CHANNEL_TITLE}
              message={NO_CHANNEL_MESSAGE}
              hint={NO_CHANNEL_HINT}
            />
          </main>
        </div>
      </PanelShell>
    );
  }

  if (state === undefined) {
    return (
      <PanelShell theme={theme} labelledBy={viewTitleId}>
        <div className="dgv-view">
          <Heading level={1} visuallyHidden id={viewTitleId}>
            {VIEW_TITLE}
          </Heading>
          <main className="dgv-view__body">
            <LoadingState variant="rows" rows={LOADING_ROWS} label={LOADING_LABEL} />
          </main>
        </div>
      </PanelShell>
    );
  }

  const { connection, capture } = state;
  const capturing = capture.active || phase.capturing;
  const followUpPending =
    isPending(pendingActions, 'askFollowUp') ||
    (session !== undefined &&
      phase.pipelineRunning &&
      state.analysis !== undefined &&
      session.followUps.length > 0);
  // The armed capture belongs to a follow-up on the new-capture path (AAP 0.4.2), so the prompt
  // says "again". The follow-up stage stamps `needsNewCapture: true` once the delta is installed
  // and `false` on the existing-evidence path; `undefined` means it has not been stamped yet. Once
  // a follow-up exists the session re-arms only through that path (`generated → planning`).
  const latestFollowUp = session?.followUps.at(-1);
  const followUpCapture =
    phase.armed && latestFollowUp !== undefined && latestFollowUp.needsNewCapture !== false;

  return (
    <PanelShell theme={theme} labelledBy={viewTitleId}>
      <div className="dgv-view">
        <Heading level={1} visuallyHidden id={viewTitleId}>
          {VIEW_TITLE}
        </Heading>
        <header className="dgv-view__header">
          <StatusBar
            connection={connection.status}
            serviceUrl={connection.serviceUrl}
            provider={connection.provider}
            sessionStatus={session?.status}
          />
        </header>
        <main className="dgv-view__body">
          <Stack gap={4}>
            <NoticeRegion ref={noticesRef} items={noticeItems} />

            <div
              ref={questionRef}
              tabIndex={-1}
              role="group"
              aria-label={QUESTION_SECTION_TITLE}
              className={ANCHOR_CLASS}
            >
              <Section title={QUESTION_SECTION_TITLE} variant="card">
                <QuestionForm
                  onSubmit={askQuestion}
                  disabled={!phase.acceptsQuestion}
                  unavailable={serviceUnavailable}
                  pending={isPending(pendingActions, 'askQuestion')}
                  submission={pendingActions.outcomes.askQuestion}
                  currentQuestion={session?.question}
                />
              </Section>
            </div>

            <Section title={TARGET_SECTION_TITLE} variant="card">
              <TargetBadge
                target={state.target}
                onRequestTarget={requestTarget}
                pending={isPending(pendingActions, 'requestTarget')}
                pickAvailability={pickAvailability}
              />
            </Section>

            {session === undefined ? (
              <EmptyState
                title={NO_SESSION_TITLE}
                message={serviceUnavailable ? NO_SESSION_SERVICE_MESSAGE : NO_SESSION_MESSAGE}
                action={noSessionActions}
              />
            ) : (
              <>
                {state.failure !== undefined || session.status === 'failed' ? (
                  <StageFailureNotice
                    failure={state.failure}
                    onRetry={retryFailedStage}
                    retrying={isPending(pendingActions, 'retryStage')}
                  />
                ) : null}

                <Section title={PROGRESS_SECTION_TITLE} variant="card">
                  <ProgressSteps
                    entries={state.progress}
                    captureArmed={phase.armed && !capturing}
                    followUpCapture={followUpCapture}
                    pending={phase.pipelineRunning}
                  />
                </Section>

                <Section title={FILES_SECTION_TITLE} variant="card">
                  <RelevantFiles
                    files={state.relevantFiles}
                    onOpenFile={openRelevantFile}
                    pending={phase.resolvingFiles && state.relevantFiles.length === 0}
                  />
                </Section>

                <div
                  ref={modificationsRef}
                  tabIndex={-1}
                  role="group"
                  aria-label={MODIFICATIONS_SECTION_TITLE}
                  className={ANCHOR_CLASS}
                >
                  <Section title={MODIFICATIONS_SECTION_TITLE} variant="card">
                    <ModificationsList
                      modifications={state.modifications}
                      conflicts={state.cleanup.conflicts}
                      onOpenFile={openModifiedFile}
                      pending={phase.instrumenting && state.modifications.length === 0}
                      total={state.modificationsTotal}
                      onLoadMore={loadModifications}
                      loadingMore={isPending(pendingActions, 'loadModifications')}
                      awaitingPlan={phase.awaitingPlan}
                    />
                  </Section>
                </div>

                <Section title={CAPTURE_SECTION_TITLE} variant="card">
                  <CaptureControls
                    capturing={capturing}
                    canStart={phase.armed && !capturing}
                    canStop={capturing}
                    onStart={startCapture}
                    onStop={stopCapture}
                    armed={phase.armed}
                    followUpCapture={followUpCapture}
                    pending={
                      isPending(pendingActions, 'startCapture') ||
                      isPending(pendingActions, 'stopCapture')
                    }
                    sessionStatus={session.status}
                  />
                </Section>

                <div
                  ref={analysisRef}
                  tabIndex={-1}
                  role="group"
                  aria-label={ANALYSIS_SECTION_TITLE}
                  className={ANCHOR_CLASS}
                >
                  <Section title={ANALYSIS_SECTION_TITLE} variant="card">
                    <AnalysisSummary
                      analysis={state.analysis}
                      title={state.latestPanel?.title ?? ANALYSIS_HEAD_TITLE}
                      fallback={state.latestPanel?.fallback ?? false}
                      onOpenSource={openSource}
                      pending={phase.analyzing}
                    />
                  </Section>
                </div>

                <div
                  ref={followUpRef}
                  tabIndex={-1}
                  role="group"
                  aria-label={FOLLOW_UP_SECTION_TITLE}
                  className={ANCHOR_CLASS}
                >
                  <Section title={FOLLOW_UP_SECTION_TITLE} variant="card">
                    <FollowUp
                      onSubmit={askFollowUp}
                      submission={pendingActions.outcomes.askFollowUp}
                      enabled={phase.acceptsFollowUp && !serviceUnavailable}
                      unavailableReason={followUpClosedReason}
                      asked={session.followUps}
                      pending={followUpPending}
                    />
                  </Section>
                </div>

                <Section title={SESSION_END_SECTION_TITLE} variant="card">
                  <SessionEnd
                    cleanup={state.cleanup}
                    modifications={state.modifications}
                    modificationsTotal={state.modificationsTotal}
                    ended={phase.ended}
                    ending={isPending(pendingActions, 'endSession')}
                    onEnd={endSession}
                  />
                </Section>
              </>
            )}

            {pairing === undefined ? null : (
              <div ref={pairingRef} className={ANCHOR_CLASS}>
                <Section title={PAIRING_SECTION_TITLE} variant="card">
                  <PairingCode
                    code={pairing.code}
                    expiresAt={pairing.expiresAt}
                    onPair={pairChrome}
                    onDismiss={dismissPairing}
                    pending={pairingChrome}
                  />
                </Section>
              </div>
            )}
          </Stack>
        </main>
      </div>
    </PanelShell>
  );
}
