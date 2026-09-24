/**
 * Stage 1 of the local service's reasoning pipeline: **problem understanding**
 * (AAP §0.4.2, "AI stage boundaries", Problem-understanding row).
 *
 * The stage turns the developer's question, the element they selected, the
 * bound tab's current URL and the bounded project summary into a validated
 * {@link ProblemUnderstanding} — `{ category, signalsNeeded, entities,
 * searchHints }` — which every later stage consumes: Stage 2 seeds its code
 * queries from the entities and hints, and Stage 3 hands the artifact straight
 * to each adapter's `createPlan(context, understanding)`.
 *
 * ## One pass, fixed order
 *
 * 1. **Tokenize.** {@link tokenizeQuestion} projects the question onto sorted,
 *    de-duplicated lexical hints. It is purely lexical and wording-invariant by
 *    construction (see below).
 * 2. **Build.** `../context-builder.js` assembles the request — it caps every
 *    section, renders the versioned `prompts/understand/vNNN.md` with its five
 *    placeholders, places the hints (never the raw question) in the structured
 *    input, and runs the outbound privacy guard (AAP §0.5.2). A refusal stops
 *    the stage before any provider call.
 * 3. **Gate.** `generateStructuredWithRepair` validates the model's answer
 *    against the imported `problemUnderstandingSchema`, with at most
 *    `DEFAULT_MAX_REPAIRS` repairs (AAP §0.5.3). There is no normaliser, no
 *    second repair loop, no retry and **no fallback**: a rejected understanding
 *    is a stage failure, because a guessed category or signal list would
 *    silently degrade every capture planned from it.
 * 4. **Report.** The failing subsystem's own error travels back unchanged — for
 *    a transport failure that is the provider's `modelUnavailableMessage`
 *    sentence (AAP §0.5.5) — so this module composes no developer-facing prose
 *    for a failure another module owns.
 *
 * ## The one file allowed to look at the question's words
 *
 * AAP §0.5.4 forbids choosing behaviour from the wording of the question.
 * `scripts/check-no-hardcoding.mjs` enforces that with its `question-branch`
 * rule everywhere in the product except this exact path, and the exemption
 * exists for the tokenizer alone. Every comparison against question-derived
 * text in this file therefore lives in the tokenizer's helpers
 * ({@link splitCamelCase}, `questionWords`, `identifierCandidateOf`,
 * `isKeptToken`), and none of them maps a phrase to a category, a signal set,
 * a plan or a panel: they only cut text into words and filter words against
 * two vocabularies of ordinary English and generic debugging terms. The model
 * decides what the question means. The stage itself (`createUnderstandStage`)
 * never reads the question except to hand it to the tokenizer.
 *
 * ## Wording invariance
 *
 * The rules-based deterministic provider builds its answer from
 * `ModelRequest.input` alone, and the outbound guard inspects it field by field.
 * The raw question is rendered into the prompt only; the structured input
 * carries the tokenizer's output, which is lower-cased, stripped of
 * punctuation and stop words, de-duplicated and sorted. Two questions that
 * differ only in word order, filler words, capitalisation or punctuation
 * therefore produce the same structured input, and the product's behaviour
 * under the deterministic provider cannot depend on how a question was typed.
 *
 * ## Progress
 *
 * The stage emits its group header (`stageStarted`) and exactly one closing
 * row — `stageCompleted` on success, `stageFailed` on any failure after the
 * header — through `../../sessions/progress.js`, which owns every title and
 * label; this module passes no display text. It emits **no finding rows**: an
 * understanding names what the question points at, not what the run found, and
 * `progress.ts` renders a "Found …" row only from resolved evidence (an entity
 * merely named in the question produces no row there either). The
 * investigation stage reports those rows once the code graph has resolved
 * them. A progress row that cannot be emitted is logged at `warn` and never
 * fails the stage. Session status is not written here; `../../sessions/manager.ts`
 * is its only writer.
 *
 * ## Privacy and side effects
 *
 * Log records carry the stage, status, prompt version, counts, byte sizes and
 * error codes only — never the question, a token, the prompt, the model
 * output, a URL or a selector. Errors created here carry no payload value. The
 * module performs no filesystem access, spawns nothing, reads no environment
 * variable and reaches the network only through the injected provider.
 *
 * @module
 */

import { problemUnderstandingSchema } from '@debuggen/instrumentation';
import type { ProblemUnderstanding } from '@debuggen/instrumentation';
import { DEFAULT_MAX_REPAIRS, generateStructuredWithRepair } from '@debuggen/model-provider';
import type { ModelProvider, PromptStage } from '@debuggen/model-provider';
import type { ProgressStage } from '@debuggen/protocol';
import { DebuggenError, err, fromPromise, ok, tryCatch } from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';

import { sessionLogger, subsystemLogger } from '../../logging.js';
import type { SessionProgress } from '../../sessions/progress.js';
import type { SessionFailure } from '../../sessions/state-machine.js';
import { CONTEXT_LIMITS } from '../context-builder.js';
import type {
  ContextBuilder,
  PipelineStageContext,
  StageRequestBuild,
} from '../context-builder.js';

/* -------------------------------------------------------------------------------------------------
 * Stage identity
 * ---------------------------------------------------------------------------------------------- */

/**
 * This stage's name in both vocabularies it reports under: protocol's
 * `PROGRESS_STAGES` (progress rows, session failures) and the model boundary's
 * `PROMPT_STAGES` (prompt loading, request metadata). The `satisfies` clause
 * makes a rename in either tuple a compile error here rather than a row filed
 * under a stage no user interface groups.
 */
const UNDERSTAND_STAGE = 'understand' as const satisfies ProgressStage & PromptStage;

/** The logger subsystem binding of every pipeline module, per `../../logging.ts`. */
const PIPELINE_SUBSYSTEM = 'pipeline';

/** The artifact name repair feedback and rejection details use. */
const UNDERSTANDING_SCHEMA_NAME = 'problem understanding';

/* -------------------------------------------------------------------------------------------------
 * The generic tokenizer — vocabularies
 * ---------------------------------------------------------------------------------------------- */

/**
 * Ordinary English function words and conversational filler, dropped from the
 * question's tokens (AAP §0.5.4).
 *
 * Only words that carry no information about *what* is being asked belong
 * here: articles, pronouns, auxiliaries, prepositions, conjunctions,
 * interrogatives, hedges and politeness. Contractions appear in their
 * apostrophe-free form because the tokenizer joins `don't` into `dont` before
 * filtering. No member is a debugging term — the set is disjoint from
 * {@link GENERIC_SIGNAL_TERMS} — and none names anything in any application.
 * Frozen and sorted for review.
 */
export const QUESTION_STOP_WORDS: readonly string[] = Object.freeze([
  'about',
  'above',
  'actually',
  'after',
  'all',
  'almost',
  'also',
  'always',
  'am',
  'an',
  'and',
  'any',
  'anyone',
  'anything',
  'are',
  'arent',
  'around',
  'as',
  'at',
  'basically',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'cannot',
  'cant',
  'come',
  'could',
  'couldnt',
  'did',
  'didnt',
  'do',
  'does',
  'doesnt',
  'doing',
  'done',
  'dont',
  'down',
  'during',
  'each',
  'either',
  'else',
  'even',
  'ever',
  'every',
  'few',
  'for',
  'from',
  'further',
  'get',
  'gets',
  'getting',
  'go',
  'goes',
  'going',
  'got',
  'had',
  'hadnt',
  'has',
  'hasnt',
  'have',
  'havent',
  'having',
  'he',
  'her',
  'here',
  'heres',
  'hers',
  'hey',
  'hi',
  'him',
  'his',
  'how',
  'however',
  'hows',
  'if',
  'im',
  'in',
  'into',
  'is',
  'isnt',
  'it',
  'its',
  'ive',
  'just',
  'kind',
  'kinda',
  'let',
  'lets',
  'like',
  'literally',
  'lot',
  'lots',
  'may',
  'maybe',
  'me',
  'might',
  'mine',
  'more',
  'most',
  'much',
  'must',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'often',
  'oh',
  'ok',
  'okay',
  'on',
  'once',
  'one',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'out',
  'over',
  'own',
  'please',
  'pretty',
  'quite',
  'rather',
  'really',
  'same',
  'seem',
  'seemingly',
  'seems',
  'she',
  'should',
  'shouldnt',
  'so',
  'some',
  'somehow',
  'something',
  'sometimes',
  'somewhat',
  'sort',
  'still',
  'such',
  'than',
  'thanks',
  'that',
  'thats',
  'the',
  'their',
  'theirs',
  'them',
  'then',
  'there',
  'theres',
  'these',
  'they',
  'theyre',
  'thing',
  'things',
  'this',
  'those',
  'though',
  'through',
  'thus',
  'to',
  'too',
  'totally',
  'under',
  'until',
  'up',
  'us',
  'very',
  'via',
  'was',
  'wasnt',
  'we',
  'were',
  'werent',
  'weve',
  'what',
  'whats',
  'when',
  'whenever',
  'where',
  'whether',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'why',
  'whys',
  'will',
  'with',
  'within',
  'without',
  'wont',
  'would',
  'wouldnt',
  'yet',
  'you',
  'your',
  'youre',
  'yours',
  'yourself',
  'youve',
]);

/**
 * Generic debugging vocabulary: the words that describe *kinds* of runtime
 * behaviour — latency, rendering, requests, queries, failures, repetition,
 * resources — in any project (AAP §0.5.4).
 *
 * The tokenizer reports which of these words the question used, as
 * {@link QuestionTokens.signalTerms}. That is a filter, not a mapping: the
 * terms are handed on verbatim and no term selects a category, a capture
 * signal, a plan or a panel — the model decides what the question is about.
 * Every entry is a single lower-case ASCII word with no separator, no path
 * character and no case boundary, and none is specific to any application.
 * Inflections are listed individually because the tokenizer does no stemming.
 * Frozen and sorted for review; disjoint from {@link QUESTION_STOP_WORDS}.
 */
export const GENERIC_SIGNAL_TERMS: readonly string[] = Object.freeze([
  'again',
  'api',
  'blocked',
  'blocking',
  'broken',
  'cache',
  'cached',
  'call',
  'calls',
  'click',
  'clicks',
  'client',
  'context',
  'count',
  'cpu',
  'crash',
  'crashes',
  'database',
  'db',
  'delay',
  'delayed',
  'duplicate',
  'duplicated',
  'duplicates',
  'duration',
  'effect',
  'effects',
  'endpoint',
  'error',
  'errors',
  'exception',
  'exceptions',
  'fail',
  'failed',
  'failing',
  'fails',
  'failure',
  'fast',
  'fetch',
  'fetches',
  'fetching',
  'flicker',
  'flickering',
  'flickers',
  'freeze',
  'freezes',
  'frozen',
  'hang',
  'hangs',
  'hook',
  'hooks',
  'incorrect',
  'infinite',
  'input',
  'interaction',
  'jank',
  'lag',
  'lagging',
  'laggy',
  'lags',
  'latency',
  'leak',
  'leaks',
  'load',
  'loaded',
  'loading',
  'loads',
  'long',
  'loop',
  'many',
  'memo',
  'memory',
  'missing',
  'mount',
  'mounts',
  'multiple',
  'navigation',
  'network',
  'perf',
  'performance',
  'props',
  'queries',
  'query',
  'remount',
  'remounts',
  'render',
  'rendered',
  'rendering',
  'renders',
  'repeat',
  'repeated',
  'repeatedly',
  'repeats',
  'request',
  'requests',
  'rerender',
  'rerendered',
  'rerendering',
  'rerenders',
  'response',
  'responses',
  'retries',
  'retry',
  'route',
  'scroll',
  'server',
  'slow',
  'slower',
  'slowly',
  'slowness',
  'speed',
  'sql',
  'stale',
  'state',
  'stuck',
  'time',
  'timeout',
  'timeouts',
  'times',
  'transaction',
  'twice',
  'typing',
  'unmount',
  'update',
  'updates',
  'updating',
  'wrong',
]);

/** Membership view of {@link QUESTION_STOP_WORDS}; private so the exported list stays the definition. */
const STOP_WORD_SET: ReadonlySet<string> = new Set(QUESTION_STOP_WORDS);

/** Membership view of {@link GENERIC_SIGNAL_TERMS}; private for the same reason. */
const SIGNAL_TERM_SET: ReadonlySet<string> = new Set(GENERIC_SIGNAL_TERMS);

/* -------------------------------------------------------------------------------------------------
 * The generic tokenizer — bounds and patterns
 * ---------------------------------------------------------------------------------------------- */

/**
 * The most characters of a question the tokenizer reads: the same cap the
 * context builder applies before rendering the question into the prompt, so
 * the hints never describe text the model was not shown. A word the cut
 * lands inside is dropped rather than kept as a fragment (see `questionWords`).
 */
const MAX_TOKENIZER_INPUT_CHARS = CONTEXT_LIMITS.maxQuestionChars;

/**
 * The most tokens reported. Above what any honest question yields once stop
 * words are gone, and small enough that the hints stay hints rather than a
 * second copy of the question.
 */
const MAX_QUESTION_TOKENS = 32;

/** The most identifier candidates reported: a question names a handful of symbols at most. */
const MAX_IDENTIFIER_CANDIDATES = 16;

/** The most signal terms reported. */
const MAX_SIGNAL_TERMS = 16;

/** Tokens shorter than this are dropped: a single letter or digit is not a searchable word. */
const MIN_TOKEN_LENGTH = 2;

/**
 * Tokens and candidates longer than this are dropped rather than cut: a run of
 * sixty-four characters without a separator is pasted data, not a word, and a
 * truncated fragment would be a term nobody wrote.
 */
const MAX_TOKEN_LENGTH = 64;

/**
 * The shortest identifier candidate. A shorter mixed-case word (`iOS`) is too
 * ambiguous to be worth a code search of its own; its parts still reach
 * {@link QuestionTokens.tokens}.
 */
const MIN_IDENTIFIER_LENGTH = 4;

/** An identifier candidate must split into at least this many parts of {@link MIN_TOKEN_LENGTH}. */
const MIN_IDENTIFIER_PARTS = 2;

/**
 * One camel-case part: an upper-case run not followed by a lower-case letter
 * (`XML` in `XMLHttp`, `HTTP`), an optional capital followed by lower-case
 * letters (`Http`, `use`), or a digit run. Letters of caseless scripts count as
 * lower case, combining marks stay with their letter, and anything else is a
 * separator.
 */
const CAMEL_PART_PATTERN =
  /(?:[\p{Lu}\p{Lt}]\p{M}*)+(?![\p{Ll}\p{Lo}\p{Lm}])|(?:[\p{Lu}\p{Lt}]\p{M}*)?[\p{Ll}\p{Lo}\p{Lm}\p{M}]+|\p{N}+/gu;

/** A character that belongs to a word or an identifier. */
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}\p{M}_$]/u;

/**
 * One word: a maximal run of letters, digits, combining marks, `_` and `$`.
 * Whitespace, punctuation, symbols, quotes, brackets and slashes separate words.
 */
const WORD_PATTERN = /[\p{L}\p{N}\p{M}_$]+/gu;

/** A possessive `'s` (straight, curly or modifier apostrophe), which carries no meaning of its own. */
const POSSESSIVE_PATTERN = /(?<=[\p{L}\p{N}])['\u2019\u02BC]s(?![\p{L}\p{N}])/giu;

/** An apostrophe inside a word, removed so a contraction stays one word (`don't` → `dont`). */
const INNER_APOSTROPHE_PATTERN = /(?<=[\p{L}\p{N}])['\u2019\u02BC](?=[\p{L}\p{N}])/gu;

/** The shape of a source identifier: a letter, `_` or `$`, then word characters. */
const IDENTIFIER_SHAPE_PATTERN = /^[\p{L}_$][\p{L}\p{N}\p{M}_$]*$/u;

/** A camel-case boundary: a lower-case letter or digit followed by a capital. */
const CAMEL_BOUNDARY_PATTERN = /[\p{Ll}\p{N}][\p{Lu}\p{Lt}]/u;

/** A `_` or `$` joining two alphanumeric runs, as in `snake_case`. */
const INNER_JOINER_PATTERN = /[\p{L}\p{N}][_$]+[\p{L}\p{N}]/u;

/** The shared empty result of {@link splitCamelCase}. */
const NO_PARTS: readonly string[] = Object.freeze([]);

/* -------------------------------------------------------------------------------------------------
 * The generic tokenizer — the exempt region (AAP §0.5.4)
 *
 * Every comparison against question-derived text in this file is below this
 * line and above the stage contract. Nothing here decides anything: it cuts
 * text into words and filters them against the two vocabularies above.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The wording-invariant lexical projection of a question (AAP §0.5.4).
 *
 * The understand stage places each list at the top level of the structured
 * `ModelRequest.input`, which is what the deterministic provider reads and the
 * outbound guard inspects; the raw question never goes there. Every list is
 * de-duplicated, sorted by UTF-16 code unit and capped, so two questions that
 * differ only in word order, filler words, capitalisation or punctuation yield
 * deeply equal values. The object and its lists are frozen and survive a JSON
 * round trip unchanged. It carries lexical data only — no category, signal,
 * plan, panel or path.
 */
export interface QuestionTokens {
  /**
   * The question's content words: lower-cased, split at punctuation, whitespace
   * and camel-case boundaries, without stop words or one-character fragments.
   */
  readonly tokens: readonly string[];
  /**
   * Words written in identifier form — a camel-case boundary (`useThing`,
   * `ThingList`) or an inner `_`/`$` (`thing_id`) — as a code search would look
   * them up. A camel-case candidate keeps its case, because case is part of an
   * identifier's name; a candidate without a camel-case boundary is lower-cased,
   * because its case carries no identifier information.
   */
  readonly identifierCandidates: readonly string[];
  /** The members of {@link tokens} that are {@link GENERIC_SIGNAL_TERMS}, verbatim. */
  readonly signalTerms: readonly string[];
}

/**
 * Splits a word or phrase at camel-case, Pascal-case, acronym and digit
 * boundaries, dropping everything that is not a letter, a digit or a combining
 * mark.
 *
 * `fooBarBaz` → `foo`, `Bar`, `Baz`; `XMLHttpThing` → `XML`, `Http`, `Thing`;
 * `thing2Go` → `thing`, `2`, `Go`; `snake_case` and already-split input such as
 * `foo bar` split at their separators. Case is preserved; the caller lowers it
 * when it needs to. Total: a non-string or empty value yields an empty list,
 * and no input throws. The input is NFKC-normalised first so compatibility
 * forms (full-width letters, ligatures) split like their plain equivalents.
 *
 * @param value The text to split.
 * @returns The parts in input order, frozen.
 */
export function splitCamelCase(value: string): readonly string[] {
  if (typeof value !== 'string' || value.length === 0) {
    return NO_PARTS;
  }
  const parts = value.normalize('NFKC').match(CAMEL_PART_PATTERN);
  return parts === null ? NO_PARTS : Object.freeze([...parts]);
}

/** The first UTF-16 code unit of a surrogate pair. */
const HIGH_SURROGATE_MIN = 0xd800;

/** The last value a first surrogate code unit can take. */
const HIGH_SURROGATE_MAX = 0xdbff;

/**
 * Where the tokenizer stops reading: the whole question when it fits in
 * {@link MAX_TOKENIZER_INPUT_CHARS}, otherwise that bound moved back one unit
 * when it would split a surrogate pair.
 */
function readLimitOf(text: string): number {
  if (text.length <= MAX_TOKENIZER_INPUT_CHARS) {
    return text.length;
  }
  const last = text.charCodeAt(MAX_TOKENIZER_INPUT_CHARS - 1);
  return last >= HIGH_SURROGATE_MIN && last <= HIGH_SURROGATE_MAX
    ? MAX_TOKENIZER_INPUT_CHARS - 1
    : MAX_TOKENIZER_INPUT_CHARS;
}

/** Whether the code point starting at `index` of `text` is a word character. */
function isWordCharacterAt(text: string, index: number): boolean {
  const codePoint = text.codePointAt(index);
  return codePoint !== undefined && WORD_CHARACTER_PATTERN.test(String.fromCodePoint(codePoint));
}

/**
 * The question's raw words, case preserved: the bounded question,
 * NFKC-normalised, with possessive `'s` removed and inner apostrophes joined,
 * cut into maximal runs of word characters. When the bound lands inside a
 * word, that word is dropped, so no fragment the developer never wrote becomes
 * a token.
 */
function questionWords(question: string): readonly string[] {
  if (typeof question !== 'string' || question.length === 0) {
    return NO_PARTS;
  }
  const limit = readLimitOf(question);
  const normalizedQuestion = question
    .slice(0, limit)
    .normalize('NFKC')
    .replace(POSSESSIVE_PATTERN, '')
    .replace(INNER_APOSTROPHE_PATTERN, '');

  const words: string[] = [];
  let lastWordEnd = 0;
  for (const match of normalizedQuestion.matchAll(WORD_PATTERN)) {
    words.push(match[0]);
    lastWordEnd = match.index + match[0].length;
  }
  if (
    limit < question.length &&
    lastWordEnd === normalizedQuestion.length &&
    isWordCharacterAt(question, limit)
  ) {
    words.pop();
  }
  return words;
}

/** Whether a lower-cased part is kept as a token: long enough, short enough, not a stop word. */
function isKeptToken(token: string): boolean {
  return (
    token.length >= MIN_TOKEN_LENGTH &&
    token.length <= MAX_TOKEN_LENGTH &&
    !STOP_WORD_SET.has(token)
  );
}

/**
 * The identifier candidate a raw word stands for, or `undefined` when the word
 * is ordinary prose.
 *
 * A candidate has the shape of a source identifier, a length between
 * {@link MIN_IDENTIFIER_LENGTH} and {@link MAX_TOKEN_LENGTH}, a camel-case
 * boundary or an inner `_`/`$`, and at least {@link MIN_IDENTIFIER_PARTS} parts
 * of {@link MIN_TOKEN_LENGTH} characters. A capitalised or all-capitals word has
 * no camel-case boundary, so sentence case and shouting never turn prose into
 * a candidate.
 */
function identifierCandidateOf(word: string): string | undefined {
  if (
    word.length < MIN_IDENTIFIER_LENGTH ||
    word.length > MAX_TOKEN_LENGTH ||
    !IDENTIFIER_SHAPE_PATTERN.test(word)
  ) {
    return undefined;
  }
  const camel = CAMEL_BOUNDARY_PATTERN.test(word);
  if (!camel && !INNER_JOINER_PATTERN.test(word)) {
    return undefined;
  }
  const substantialParts = splitCamelCase(word).filter((part) => part.length >= MIN_TOKEN_LENGTH);
  if (substantialParts.length < MIN_IDENTIFIER_PARTS) {
    return undefined;
  }
  return camel ? word : word.toLowerCase();
}

/** Orders strings by UTF-16 code unit: locale-independent, so every host sorts alike. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** De-duplicated, code-unit-sorted copy of a collection of strings. */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

/** The first `max` entries of an already-ordered list, frozen. */
function frozenHead(values: readonly string[], max: number): readonly string[] {
  return Object.freeze(values.slice(0, max));
}

/**
 * Projects a question onto wording-invariant lexical hints — the one place in
 * the product permitted to examine the question's words (AAP §0.5.4, the
 * `question-branch` exemption of `scripts/check-no-hardcoding.mjs`).
 *
 * Purely lexical, in this order: bound the text, NFKC-normalise, drop
 * possessives and join contractions, split into words at whitespace and
 * punctuation, collect identifier candidates, split every word at camel-case
 * boundaries, lower-case the parts, drop stop words and fragments shorter than
 * two characters, de-duplicate, sort by code unit and cap. Signal terms are
 * selected from the full token set before the token list is capped, so a
 * generic debugging word is never lost to alphabetical order. Nothing is
 * mapped to a category, a signal, a plan or a panel; there is no stemming, no
 * synonym table and no application vocabulary.
 *
 * Pure and total: the same input always yields a deeply equal, frozen result;
 * the input is not modified; an empty, blank, punctuation-only or stop-word-only
 * question yields empty lists rather than an error.
 *
 * @param question The developer's question, verbatim.
 * @returns The question's tokens, identifier candidates and signal terms.
 *
 * @example
 * ```ts
 * tokenizeQuestion('Why is the <ComponentName> so SLOW?!').signalTerms; // ['slow']
 * ```
 */
export function tokenizeQuestion(question: string): QuestionTokens {
  const tokens = new Set<string>();
  const identifierCandidates = new Set<string>();

  for (const word of questionWords(question)) {
    const candidate = identifierCandidateOf(word);
    if (candidate !== undefined) {
      identifierCandidates.add(candidate);
    }
    for (const part of splitCamelCase(word)) {
      const token = part.toLowerCase();
      if (isKeptToken(token)) {
        tokens.add(token);
      }
    }
  }

  const orderedTokens = sortedUnique(tokens);
  return Object.freeze({
    tokens: frozenHead(orderedTokens, MAX_QUESTION_TOKENS),
    identifierCandidates: frozenHead(sortedUnique(identifierCandidates), MAX_IDENTIFIER_CANDIDATES),
    signalTerms: frozenHead(
      orderedTokens.filter((token) => SIGNAL_TERM_SET.has(token)),
      MAX_SIGNAL_TERMS,
    ),
  });
}

/* -------------------------------------------------------------------------------------------------
 * The stage contract
 *
 * Nothing below reads the question: `run` hands `context.question` to the
 * tokenizer and the context builder renders it into the prompt.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The collaborators of the understand stage, all injected (AAP §0.7.1 Group 2):
 * the stage reads no environment variable, constructs no provider and opens no
 * prompt loader — the context builder holds the loader.
 */
export interface UnderstandStageDeps {
  /** Builds, caps, renders and guard-checks the request. */
  readonly contextBuilder: ContextBuilder;
  /** The configured model provider; called only through `generateStructuredWithRepair`. */
  readonly provider: ModelProvider;
  /** Emits the stage's progress rows; owns every title and label. */
  readonly progress: SessionProgress;
  /**
   * A parent logger, bound to the session per run. Absent, the run uses the
   * context's session-bound logger.
   */
  readonly logger?: Logger | undefined;
  /**
   * The repair budget: an integer from `0` to `DEFAULT_MAX_REPAIRS` (AAP
   * §0.5.3, "at most two repairs"), defaulting to the maximum. A value outside
   * that range fails every run with `CONFIG_INVALID` before anything is sent.
   */
  readonly maxRepairs?: number | undefined;
}

/**
 * What a run needs beyond the {@link PipelineStageContext}, which already
 * carries the question, the selected target, the current URL and the project
 * summary.
 */
export interface UnderstandStageInput {
  /**
   * The prompt version to use, for a reopened session or a retry that must stay
   * on the version it started with. Absent, the version recorded on the
   * session is reused, and failing that the manifest's current version loads.
   */
  readonly promptVersion?: string | undefined;
}

/** The validated outcome of a run (AAP §0.4.2, Problem-understanding row). */
export interface UnderstandStageResult {
  /** The validated Stage 1 artifact, exactly as the authoring schema accepted it. */
  readonly understanding: ProblemUnderstanding;
  /** The prompt version actually loaded; the orchestrator records it on the session. */
  readonly promptVersion: string;
  /** How many repair attempts the accepted answer needed; `0` on a first-time success. */
  readonly repairs: number;
}

/**
 * Stage 1 of the pipeline. One method, so the orchestrator's stage overrides
 * can substitute a fake.
 */
export interface UnderstandStage {
  /**
   * Produces the validated problem understanding for one pipeline run.
   *
   * Never throws. Every failure is an `Err` carrying the failing subsystem's
   * own `DebuggenError`: the context builder's (a cancelled build, a prompt that
   * cannot load, a payload the outbound guard refused), the structured-output
   * gate's (`MODEL_OUTPUT_INVALID` after the permitted repairs, or an empty
   * answer), or the provider's (`MODEL_UNAVAILABLE` with the shared sentence of
   * AAP §0.5.5). The stage writes no session status and applies no fallback.
   *
   * @param context The run's stage context.
   * @param input The prompt version to reuse, when there is one.
   * @returns The understanding with the prompt version and repair count, or the failure.
   */
  run(
    context: PipelineStageContext,
    input: UnderstandStageInput,
  ): Promise<Result<UnderstandStageResult, DebuggenError>>;
}

/** Debug record at the start of a run. Fields: stage, token counts — never tokens. */
const STARTED_LOG = 'Understand stage started.';

/** Info record of a validated understanding. Fields: version, counts, sizes, timing. */
const COMPLETED_LOG = 'Understand stage produced a validated problem understanding.';

/** Warn record of a failed run. Fields: stage, error code, rejection reason. */
const FAILED_LOG = 'Understand stage failed; no problem understanding was produced.';

/** Debug record of a run whose signal was aborted before it began. */
const CANCELLED_LOG = 'Understand stage cancelled before it started.';

/** Warn record of a progress row that could not be emitted. Fields: stage, row, error code. */
const PROGRESS_FAILED_LOG =
  'A progress row of the understand stage could not be emitted; the stage continues.';

/** Which progress row a {@link PROGRESS_FAILED_LOG} record is about. */
type ProgressRowKind = 'started' | 'completed' | 'failed';

/** Whether a repair budget is one `generateStructuredWithRepair` accepts. */
function isValidRepairBudget(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= DEFAULT_MAX_REPAIRS;
}

/** The failure of a run configured with a repair budget outside the permitted range. */
function repairBudgetError(value: number): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    `The understand stage was configured with a repair budget outside 0 to ${String(DEFAULT_MAX_REPAIRS)}, so no request was sent.`,
    {
      hint: 'Construct the stage without maxRepairs to use the default budget, or pass an integer within the permitted range.',
      details: {
        stage: UNDERSTAND_STAGE,
        reason: 'repair-budget',
        maxRepairs: Number.isFinite(value) ? value : String(value),
      },
    },
  );
}

/**
 * The failure of a run whose signal was already aborted. Shaped like the
 * context builder's own cancellation (`INTERNAL`, `details.reason: "aborted"`),
 * so the orchestrator recognises a cancellation the same way whichever layer
 * observed it.
 */
function cancelledError(): DebuggenError {
  return new DebuggenError('INTERNAL', 'The understand stage was cancelled before it started.', {
    details: { stage: UNDERSTAND_STAGE, reason: 'aborted' },
  });
}

/** The closed-vocabulary rejection reason of an error, when it carries one. */
function reasonOf(error: DebuggenError): string | undefined {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * The {@link SessionFailure} the `failed` progress row is built from: this
 * stage, and the failing subsystem's own code, message and hint.
 */
function sessionFailureOf(error: DebuggenError): SessionFailure {
  return error.hint === undefined
    ? { stage: UNDERSTAND_STAGE, code: error.code, message: error.message }
    : { stage: UNDERSTAND_STAGE, code: error.code, message: error.message, hint: error.hint };
}

/** The error a progress emission reported or threw, or `undefined` when it succeeded. */
function progressFailureOf(
  sent: Result<Result<unknown, DebuggenError>, DebuggenError>,
): DebuggenError | undefined {
  if (!sent.ok) {
    return sent.error;
  }
  return sent.value.ok ? undefined : sent.value.error;
}

/**
 * Creates Stage 1, problem understanding (AAP §0.4.2).
 *
 * The factory holds no state beyond its collaborators; each `run` is
 * independent, so one instance serves every session of the process.
 *
 * @param deps The context builder, provider, progress emitter and options.
 * @returns The stage.
 *
 * @example
 * ```ts
 * const understand = createUnderstandStage({ contextBuilder, provider, progress, logger });
 * const outcome = await understand.run(context, { promptVersion: recorded });
 * if (outcome.ok) {
 *   sessions.patch(sessionId, { understanding: outcome.value.understanding });
 * }
 * ```
 */
export function createUnderstandStage(deps: UnderstandStageDeps): UnderstandStage {
  const { contextBuilder, provider, progress } = deps;
  const maxRepairs = deps.maxRepairs ?? DEFAULT_MAX_REPAIRS;

  /** The run's logger: session-bound, then bound to the pipeline subsystem and this stage. */
  const loggerFor = (context: PipelineStageContext): Logger => {
    const base =
      deps.logger === undefined
        ? context.logger
        : sessionLogger(deps.logger, context.sessionId, context.captureId);
    return subsystemLogger(base, PIPELINE_SUBSYSTEM).child({ stage: UNDERSTAND_STAGE });
  };

  /** Emits one progress row; a failure is logged at `warn` and never fails the stage. */
  const emitProgress = (
    row: ProgressRowKind,
    log: Logger,
    send: () => Result<unknown, DebuggenError>,
  ): void => {
    const failure = progressFailureOf(tryCatch(send, 'INTERNAL'));
    if (failure !== undefined) {
      log.warn(PROGRESS_FAILED_LOG, { stage: UNDERSTAND_STAGE, row, code: failure.code });
    }
  };

  /** Closes the stage's progress group with its `failed` row and returns the failure unchanged. */
  const fail = (
    context: PipelineStageContext,
    log: Logger,
    error: DebuggenError,
  ): Result<UnderstandStageResult, DebuggenError> => {
    const reason = reasonOf(error);
    log.warn(FAILED_LOG, {
      stage: UNDERSTAND_STAGE,
      code: error.code,
      ...(reason !== undefined ? { reason } : {}),
    });
    emitProgress('failed', log, () =>
      progress.stageFailed(context.sessionId, sessionFailureOf(error)),
    );
    return err(error);
  };

  /** Builds the request through the context builder; an unexpected throw becomes an `Err`. */
  const buildRequest = (
    context: PipelineStageContext,
    input: UnderstandStageInput,
    hints: QuestionTokens,
  ): Result<StageRequestBuild, DebuggenError> => {
    const built = tryCatch(
      () =>
        contextBuilder.buildUnderstandRequest({
          context,
          promptVersion: input.promptVersion,
          questionHints: hints,
        }),
      'INTERNAL',
    );
    return built.ok ? built.value : built;
  };

  const run = async (
    context: PipelineStageContext,
    input: UnderstandStageInput,
  ): Promise<Result<UnderstandStageResult, DebuggenError>> => {
    const log = loggerFor(context);

    if (!isValidRepairBudget(maxRepairs)) {
      // A programmer error, reported before any progress row or provider call.
      const error = repairBudgetError(maxRepairs);
      log.error(FAILED_LOG, { stage: UNDERSTAND_STAGE, code: error.code, reason: 'repair-budget' });
      return err(error);
    }
    if (context.signal?.aborted === true) {
      log.debug(CANCELLED_LOG, { stage: UNDERSTAND_STAGE });
      return err(cancelledError());
    }

    const started = context.now();
    const hints = tokenizeQuestion(context.question);
    log.debug(STARTED_LOG, {
      stage: UNDERSTAND_STAGE,
      tokenCount: hints.tokens.length,
      identifierCandidateCount: hints.identifierCandidates.length,
      signalTermCount: hints.signalTerms.length,
    });
    emitProgress('started', log, () => progress.stageStarted(context.sessionId, UNDERSTAND_STAGE));

    // The builder has already run the outbound guard: an `Err` here means the
    // payload must not leave the machine, so the provider is never called.
    const built = buildRequest(context, input, hints);
    if (!built.ok) {
      return fail(context, log, built.error);
    }
    const { request, promptVersion } = built.value;

    // The one validation gate (AAP §0.5.3): the repair budget, the abort check
    // before every call and the typed rejections all live upstream. No retry,
    // no second loop and no fallback wrap it here.
    const answered = await fromPromise(
      generateStructuredWithRepair(provider, problemUnderstandingSchema, request, {
        maxRepairs,
        schemaName: UNDERSTANDING_SCHEMA_NAME,
        logger: log,
      }),
      'INTERNAL',
    );
    const answer = answered.ok ? answered.value : answered;
    if (!answer.ok) {
      return fail(context, log, answer.error);
    }

    const { value: understanding, attempts, repairs } = answer.value;
    log.info(COMPLETED_LOG, {
      stage: UNDERSTAND_STAGE,
      promptVersion,
      attempts,
      repairs,
      bytes: built.value.bytes,
      truncatedSections: built.value.truncated.length,
      signalCount: understanding.signalsNeeded.length,
      entityCount: understanding.entities.length,
      searchHintCount: understanding.searchHints.length,
      durationMs: Math.max(0, context.now() - started),
    });
    emitProgress('completed', log, () =>
      progress.stageCompleted(context.sessionId, UNDERSTAND_STAGE),
    );

    return ok(Object.freeze({ understanding, promptVersion, repairs }));
  };

  return Object.freeze({ run });
}
