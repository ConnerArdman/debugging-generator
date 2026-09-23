/**
 * The `symbols` extractor: the declaration inventory of one source file.
 *
 * One of the per-file abstract-syntax-tree extractors `../indexer.ts` runs
 * through its `DEFAULT_EXTRACTORS` list, and the **sole owner of the `symbol`
 * node kind and the `declares` edge kind** (`file` → `symbol`, per the edge
 * table on `CODE_EDGE_KINDS`). It answers exactly one question, and answers it
 * precisely: *does this file really declare that symbol, and where?*
 *
 * ## Why precision here is load-bearing
 *
 * `../graph/query.ts`'s name lookups (`findByName`, `findSymbol`/`hasSymbol`)
 * are built on these nodes, and `packages/instrumentation`'s feasibility check
 * **rejects an instrumentation plan action whose `(file, symbol)` pair is absent
 * from the graph**. The two failure modes are therefore asymmetric but equally
 * bad: a *missed* declaration silently makes a legitimate plan action
 * unfeasible, and a *fabricated* one makes the function-timing patcher attempt
 * an edit that cannot apply. Everything below is written for that standard —
 * every node corresponds to a declaration actually present in the tree, and
 * every declaration form the supported stack produces has a branch.
 *
 * ## What this module does not own
 *
 * - **No `file` node.** `./imports.ts` owns it, because it alone computes
 *   `FileNodeData.externalImports`. This module only *derives the file node's
 *   id* — `makeNodeId({ kind: 'file', file, name: file, line: 1, column: 1 })`,
 *   the convention `CodeNodeBase.name` documents for a `file` node ("the
 *   project-relative path") — so that its `declares` edges start at a node some
 *   other extractor provides. That shared convention is the one coupling point:
 *   graph assembly drops an edge whose endpoint is missing and reports
 *   `dangling-edge`, so the id spelled here and the id spelled there must agree.
 * - **No `references` edges.** Reference resolution is deliberately lazy and
 *   belongs to `../indexer.ts`'s `createReferenceResolver`, which calls
 *   ts-morph's `findReferences` on demand; emitting them at index time would
 *   force full type resolution over the whole program.
 * - **No `component`, `handler`, `api-route`, `server-function`, `api-call` or
 *   `db-call` nodes.** Those kinds belong to the sibling extractors. A React
 *   component, a route handler and a service function are *also* declarations,
 *   so each appears here as a plain `symbol` — classified by the syntax that
 *   declares it, never by what it is used for — and the sibling extractor adds
 *   its richer node beside it. That overlap is intentional: `findSymbol` must
 *   succeed for `(route module, 'GET')` whether or not route extraction
 *   recognised the module.
 *
 * ## Contract
 *
 * - **Abstract-syntax-tree first, no type resolution.** Classification reads
 *   declaration syntax only. Nothing here calls the type checker, resolves a
 *   module specifier or consults a symbol table, so a target project whose
 *   dependencies are not installed — the normal state of the indexing corpus —
 *   still yields a complete symbol inventory.
 * - **Pure and synchronous.** No filesystem access, no network, no caching, no
 *   mutation of the tree, and no logging of source text. `extract` never
 *   throws: a construct it cannot read becomes an `IndexDiagnostic` while the
 *   rest of the file still yields nodes.
 * - **Deterministic.** Nodes are emitted in source order (position-sorted, with
 *   name and declaration kind as tie-breakers), so two runs over unchanged
 *   source serialise byte-identically — the reproducibility property
 *   `../indexer.ts` promises and the index cache depends on.
 * - **Scope.** Module-level declarations, class members, and **named
 *   function-valued declarations nested inside a function-like body** —
 *   `function submitOrder() {}` or `const handleRetry = () => {}` written
 *   inside a component, a hook, a method or a callback, to
 *   {@link MAX_DECLARATION_SCOPE_DEPTH} deep. A nested declaration *is*
 *   addressable: an instrumentation action names a `(file, symbol)` pair, and
 *   the function-timing patcher resolves that pair against a declaration at any
 *   depth in the file (refusing an ambiguous bare name with a "qualify it"
 *   hint), which is exactly the shape AAP §6's canonical plan names — a React
 *   submit handler declared inside its component. Each such node carries
 *   `SymbolNodeData.enclosing`, the chain of enclosing named declarations, so a
 *   consumer can tell it from a module-level declaration it could import and
 *   can qualify the spelling; it never carries {@link CodeNodeBase.symbol},
 *   which is reserved for a class member's owning class and is matched as a
 *   call target.
 *
 *   Nothing else nested is recorded, and that exclusion is as load-bearing as
 *   the inclusion: **no parameter** (including a destructured prop,
 *   `function Row({ onPick })`), **no binding-pattern element** (`const { open,
 *   onClose } = props`, `const [q, setQ] = useState()`), **no object-literal
 *   property or method**, and **no nested declarator whose initialiser is not a
 *   written function** (`const cb = useCallback(…)`). None of those is a
 *   declaration whose body this file holds, so a node asserting one is how the
 *   graph came to affirm an instrumentable symbol that does not exist.
 *
 * @module
 */

import { ModuleDeclarationKind, Node } from 'ts-morph';
import type {
  ArrayBindingPattern,
  ClassDeclaration,
  ClassMemberTypes,
  ConstructorDeclaration,
  EnumDeclaration,
  ExportAssignment,
  ExportDeclaration,
  Expression,
  FunctionDeclaration,
  InterfaceDeclaration,
  ModuleDeclaration,
  ObjectBindingPattern,
  SourceFile,
  Statement,
  TypeAliasDeclaration,
  VariableDeclaration,
  VariableStatement,
} from 'ts-morph';

import { isSafeRelativePath } from '@debuggen/shared';

import { makeEdgeId, makeNodeId } from '../graph/graph.js';
import type {
  CodeEdge,
  CodeNodeOf,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  IndexDiagnostic,
  SymbolDeclarationKind,
  SymbolNodeData,
} from '../graph/types.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * This extractor's {@link Extractor.id}.
 *
 * It travels on every {@link IndexDiagnostic.extractorId} this module emits, so
 * it is what makes a finding attributable to symbol extraction rather than to
 * indexing in general. Stable across versions by contract.
 */
const EXTRACTOR_ID = 'symbols';

/**
 * The name a truly anonymous default export is recorded under, and the alias
 * that promotes a local declaration to the default export in an
 * `export { x as default }` clause.
 *
 * A default export *with* a declared name keeps that name (and sets
 * `SymbolNodeData.isDefaultExport`), so this spelling is reached only when the
 * declaration has no identifier at all.
 */
const DEFAULT_EXPORT_NAME = 'default';

/**
 * The name a class constructor is recorded under.
 *
 * A constructor has no name node of its own, and it is a real callable member
 * with a body — the shape `new Thing()` resolves to — so it is recorded as a
 * `method` under the keyword that declares it.
 */
const CONSTRUCTOR_NAME = 'constructor';

/**
 * The line and column of a `file` node, fixed by convention.
 *
 * A file is not declared at a position, so its node is anchored at the start of
 * the file. Spelled as constants because the id derived from them has to match
 * the one `./imports.ts` produces for the same file, byte for byte, or the
 * `declares` edges below dangle.
 */
const FILE_NODE_LINE = 1;
const FILE_NODE_COLUMN = 1;

/**
 * How deep the two recursive reads of this module go: a destructuring pattern
 * walked for its bound names, and an initialiser unwrapped past the expressions
 * that do not change its shape.
 *
 * Generous enough that no hand-written declaration reaches it, and present so
 * that a pathologically nested construct — hand-written or machine-generated —
 * costs bounded work instead of a stack overflow on a developer's project.
 * Names below the limit are recorded; deeper ones are not, which is stated here
 * because a silent bound is worse than a documented one.
 */
const MAX_NESTING_DEPTH = 16;

/**
 * How many function-like bodies deep a nested declaration is still recorded.
 *
 * Depth `1` is a declaration written directly in a module-level function's body
 * — the shape this exists for, a handler inside its component — and each further
 * function, arrow, method or accessor body counts one more. Eight covers every
 * real nesting the supported stack produces (component → callback → callback is
 * three) with room to spare, and bounds the walk on generated or minified source
 * where declarations can nest arbitrarily.
 *
 * A declaration below the limit is recorded; one deeper is not, and that is
 * stated here because a silent bound is worse than a documented one. It is
 * separate from {@link MAX_NESTING_DEPTH}, which bounds two *syntactic* reads
 * (a destructuring pattern, an initialiser's wrappers) rather than lexical
 * scope, and the two must stay independent: raising one for a pathological
 * expression must not widen what counts as an addressable declaration.
 */
const MAX_DECLARATION_SCOPE_DEPTH = 8;

/**
 * The enclosing chain of a declaration at module scope: no enclosing
 * declaration at all.
 *
 * A single frozen empty array, shared by every walk that has not entered a
 * function-like body yet, so the common case allocates nothing and no collector
 * can extend a chain in place.
 *
 * A module-scope draft never carries it — it carries `undefined`, which is what
 * `SymbolNodeData.enclosing` documents as "not nested". This value does reach
 * that field in one case, and it is the case the field documents as `[]`: a
 * declaration nested inside scopes none of which has a name, such as a function
 * declared in a callback passed to a module-level call.
 */
const MODULE_SCOPE_CHAIN: readonly string[] = Object.freeze([]);

/* -------------------------------------------------------------------------------------------------
 * Internal shapes
 * ---------------------------------------------------------------------------------------------- */

/** A 1-based position in the file being visited, on the `CodeNodeBase` convention. */
interface Position {
  /** The **1-based** line. */
  readonly line: number;
  /** The **1-based** column. */
  readonly column: number;
}

/**
 * One declaration found in the file, before it becomes a node.
 *
 * Mutable on purpose, and the reason collection happens in two passes: an
 * `export { x }` or `export default x` clause can appear anywhere in the module
 * — before the declaration it exports, thanks to hoisting — so export status is
 * applied after the whole file has been walked rather than guessed at the
 * declaration site.
 */
interface SymbolDraft {
  /** The declared identifier, or {@link DEFAULT_EXPORT_NAME} for an anonymous default export. */
  name: string;
  /** The classification, from `SYMBOL_DECLARATION_KINDS`. */
  declaration: SymbolDeclarationKind;
  /** The **1-based** line of the declaration's identifier. */
  line: number;
  /** The **1-based** column of the declaration's identifier. */
  column: number;
  /** The last line of the whole declaration, never before {@link SymbolDraft.line}. */
  endLine: number;
  /** Whether the declaration leaves its module. */
  exported: boolean;
  /** Whether the declaration is the module's default export. */
  isDefaultExport: boolean;
  /** The owning class of a member, or `undefined` for a module-level declaration. */
  container: string | undefined;
  /**
   * Whether an export clause in this module can name this declaration.
   *
   * `true` for a module-level declaration, `false` for a class member and for
   * every nested declaration: neither is reachable through `export { … }` — a
   * member is reached through its class, a nested declaration not at all — so
   * the export passes must not match either by bare name.
   */
  isModuleLevel: boolean;

  /**
   * The enclosing named declarations, outermost first, for a nested
   * declaration; `undefined` for module scope and for a class member.
   *
   * Carried to `SymbolNodeData.enclosing` unchanged, including the empty array,
   * which means "nested, but nothing enclosing it has a name". See that field
   * for the semantics consumers rely on.
   */
  enclosing: readonly string[] | undefined;
}

/**
 * A pending `export default <expression>` seen while walking the file.
 *
 * Resolved after the walk: when the expression is a bare identifier naming a
 * declaration of this module, that declaration becomes the default export;
 * otherwise a node named {@link DEFAULT_EXPORT_NAME} is minted so the module's
 * default export is still findable.
 */
interface DefaultExportIntent {
  /** The identifier the expression names, or `undefined` for any other expression. */
  readonly name: string | undefined;
  /** How the expression itself classifies, used only when no local declaration matches. */
  readonly declaration: SymbolDeclarationKind;
  /** The **1-based** line of the exported expression. */
  readonly line: number;
  /** The **1-based** column of the exported expression. */
  readonly column: number;
  /** The last line of the export statement. */
  readonly endLine: number;
}

/**
 * A pending local export clause entry — `export { x }`, `export { x as default }`,
 * `export type { T }` — seen while walking the file.
 *
 * Only clauses **without** a module specifier land here; a re-export
 * (`export { x } from './y'`) belongs to `./imports.ts`.
 */
interface LocalExportIntent {
  /** The local binding the clause exports. */
  readonly localName: string;
  /** Whether the clause exports it as the module's default. */
  readonly isDefault: boolean;
}

/**
 * One file's walk: what is being read, and what has been found so far.
 *
 * Passed to every collector instead of a growing parameter list. The arrays are
 * appended to and never re-ordered during the walk — ordering is decided once,
 * at materialisation — and the container itself is `readonly` so a collector
 * cannot swap one out from under the walk.
 */
interface Walk {
  /** The file being visited. */
  readonly sourceFile: SourceFile;
  /** Its project-relative POSIX path, taken from `ExtractorContext.file`. */
  readonly file: string;
  /** Every declaration found, in the order the walk met it. */
  readonly drafts: SymbolDraft[];
  /** Pending `export default <expression>` statements, resolved after the walk. */
  readonly defaultExports: DefaultExportIntent[];
  /** Pending local export clauses, resolved after the walk. */
  readonly localExports: LocalExportIntent[];
  /** Findings worth surfacing. */
  readonly diagnostics: IndexDiagnostic[];
}

/* -------------------------------------------------------------------------------------------------
 * Position, naming and classification helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * The 1-based position of a node's start, excluding leading trivia.
 *
 * `SourceFile.getLineAndColumnAtPos` is 1-based on both axes, which is the
 * convention `CodeNodeBase.line`/`column` and `SourceLocation` share, so no
 * adjustment happens here or anywhere between here and the editor.
 *
 * @param sourceFile The file the node belongs to.
 * @param node The node to locate — an identifier for a declaration, so that the
 * recorded position is the one a developer expects an editor to jump to.
 * @returns The node's 1-based line and column.
 */
function positionOf(sourceFile: SourceFile, node: Node): Position {
  const { line, column } = sourceFile.getLineAndColumnAtPos(node.getStart());

  return { line, column };
}

/**
 * The name a declaration's name node spells, or `undefined` when it has none.
 *
 * Total over every form a name node can take, and deliberately strict about
 * two of them:
 *
 * - An `Identifier` whose text is **empty** is what the parser produces for
 *   broken source (`export function {`). It is not a name, and treating it as
 *   one would put an unfindable node with an empty name in the graph.
 * - A `ComputedPropertyName` (`['key']() {}`) yields `undefined`: the member's
 *   name is not statically known, so no `findSymbol` query could ever match it.
 *
 * A string-literal member name is unquoted (`'my-method'() {}` → `my-method`)
 * so that the recorded name is the one a runtime or a plan would use, and a
 * numeric or private name is kept as written.
 *
 * @param node The name node of a declaration, or `undefined` when the
 * declaration has no name node at all.
 * @returns The declared name, or `undefined` when there is none to record.
 */
function declaredNameOf(node: Node | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }

  if (Node.isIdentifier(node) || Node.isPrivateIdentifier(node)) {
    const text = node.getText();

    return text.length === 0 ? undefined : text;
  }

  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    const value = node.getLiteralValue();

    return value.length === 0 ? undefined : value;
  }

  if (Node.isNumericLiteral(node)) {
    return node.getText();
  }

  return undefined;
}

/**
 * The expression a value declaration really initialises to, with the wrappers
 * that do not change its shape removed.
 *
 * `const f = (() => {}) satisfies Fn`, `const f = (() => {}) as Fn` and
 * `const f = (() => {})` all declare a function, and the distinction between a
 * function-valued and a plain declaration is acted on downstream (it decides
 * whether a declaration is a function-timing candidate), so the wrappers are
 * peeled rather than allowed to hide the initialiser.
 *
 * @param expression The initialiser as written.
 * @returns The innermost expression, after parentheses, `as`, `satisfies`,
 * non-null and angle-bracket type assertions — or the last expression reached
 * within {@link MAX_NESTING_DEPTH} wrappers, which no real declaration exceeds.
 */
function unwrapExpression(expression: Expression): Expression {
  let current: Expression = expression;

  for (let depth = 0; depth < MAX_NESTING_DEPTH; depth += 1) {
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isTypeAssertion(current)
    ) {
      current = current.getExpression();
      continue;
    }

    return current;
  }

  return current;
}

/**
 * Whether an initialiser declares a function.
 *
 * Syntactic by design: an arrow function or a function expression is a function
 * this product could wrap, whereas a call that *returns* one — a memo or a
 * higher-order wrapper — is a value whose body is not written here. Classifying
 * the second as a function would offer the patcher a declaration with no body
 * to instrument.
 *
 * @param expression The initialiser, or `undefined` for a declaration without
 * one (`declare const x: Fn`).
 * @returns `true` only for a directly written function or arrow function.
 */
function isFunctionValued(expression: Expression | undefined): boolean {
  if (expression === undefined) {
    return false;
  }

  const inner = unwrapExpression(expression);

  return Node.isArrowFunction(inner) || Node.isFunctionExpression(inner);
}

/**
 * How an `export default <expression>` classifies when no local declaration
 * matches it.
 *
 * Three cases, in the order they are tested: a directly written function is a
 * `function`, a class expression is a `class`, and a bare identifier this
 * module does not declare is `unknown` — it names an imported binding, and
 * saying more about it would require resolution this extractor does not do.
 * Every other expression is a value, so `variable`.
 *
 * @param expression The exported expression, already unwrapped.
 * @returns The `SYMBOL_DECLARATION_KINDS` member to record.
 */
function classifyDefaultExportExpression(expression: Expression): SymbolDeclarationKind {
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    return 'function';
  }

  if (Node.isClassExpression(expression)) {
    return 'class';
  }

  if (Node.isIdentifier(expression)) {
    return 'unknown';
  }

  return 'variable';
}

/* -------------------------------------------------------------------------------------------------
 * Diagnostics
 * ---------------------------------------------------------------------------------------------- */

/**
 * A finding for a declaration this extractor could not name, and therefore
 * skipped.
 *
 * `warning` severity and the `extractor-failed` code with this module's
 * {@link EXTRACTOR_ID}: the index stays usable and the rest of the file is
 * indexed, but it is incomplete in a way that can change a result — a
 * `findSymbol` for the skipped declaration will answer "absent", which is
 * exactly what a feasibility check acts on.
 *
 * The message is built from a syntax-kind name and a position only. **No source
 * text**, per the privacy constraint on `INDEX_DIAGNOSTIC_CODES`: a diagnostic
 * reaches logs, a persisted session and potentially model prompt context.
 *
 * @param kindName The syntax kind of the construct, from `Node.getKindName()`.
 * @param position The construct's 1-based position.
 * @param file The file being visited, project-relative POSIX.
 * @returns The diagnostic to report.
 */
function droppedDeclaration(kindName: string, position: Position, file: string): IndexDiagnostic {
  return {
    severity: 'warning',
    code: 'extractor-failed',
    message: `Could not determine a declared name for a ${kindName} at line ${position.line}, column ${position.column}; that declaration was skipped and the rest of the file was indexed.`,
    file,
    extractorId: EXTRACTOR_ID,
  };
}

/**
 * A finding for a statement whose extraction threw.
 *
 * `error` severity, because a whole statement's contribution is missing rather
 * than one declaration within it. The detail carries the error's *name* only —
 * a thrown message can quote the very source text a diagnostic must not
 * contain, so it is never interpolated.
 *
 * @param kindName The syntax kind of the statement, from `Node.getKindName()`.
 * @param position The statement's 1-based position.
 * @param file The file being visited, project-relative POSIX.
 * @param error Whatever was thrown.
 * @returns The diagnostic to report.
 */
function unexpectedFailure(
  kindName: string,
  position: Position,
  file: string,
  error: unknown,
): IndexDiagnostic {
  return {
    severity: 'error',
    code: 'extractor-failed',
    message: `Failed to extract declarations from a ${kindName} at line ${position.line}, column ${position.column}; the rest of the file was indexed.`,
    file,
    extractorId: EXTRACTOR_ID,
    detail: error instanceof Error ? error.name : typeof error,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Per-form collectors
 * ---------------------------------------------------------------------------------------------- */

/**
 * Records a module-level function declaration.
 *
 * Matches `function f() {}`, `async function f() {}`,
 * `export async function f() {}`, `export default function f() {}`, the
 * anonymous `export default function () {}`, an ambient `declare function f()`
 * and each **overload signature** of an overloaded function — every one of them
 * maps to the `function` member of `SYMBOL_DECLARATION_KINDS`. Overload
 * signatures are recorded alongside the implementation rather than collapsed
 * into it: each is a real declaration site at its own position, and their node
 * ids differ because the recorded position is that of the name identifier.
 *
 * @param walk The file walk to append to.
 * @param declaration The function declaration to record.
 */
function collectFunctionDeclaration(walk: Walk, declaration: FunctionDeclaration): void {
  const nameNode = declaration.getNameNode();
  const name = declaredNameOf(nameNode);
  const isDefaultExport = declaration.hasDefaultKeyword();

  if (name === undefined || nameNode === undefined) {
    // `export default function () {}` — legal and nameless, so it is recorded
    // under the reserved default name. Anything else without a name is broken
    // source, which is reported rather than guessed at.
    if (!isDefaultExport) {
      walk.diagnostics.push(
        droppedDeclaration(
          declaration.getKindName(),
          positionOf(walk.sourceFile, declaration),
          walk.file,
        ),
      );

      return;
    }

    const anonymous = positionOf(walk.sourceFile, declaration);

    walk.drafts.push({
      name: DEFAULT_EXPORT_NAME,
      declaration: 'function',
      line: anonymous.line,
      column: anonymous.column,
      endLine: declaration.getEndLineNumber(),
      exported: true,
      isDefaultExport: true,
      container: undefined,
      isModuleLevel: true,
      enclosing: undefined,
    });

    return;
  }

  const position = positionOf(walk.sourceFile, nameNode);

  walk.drafts.push({
    name,
    declaration: 'function',
    line: position.line,
    column: position.column,
    endLine: declaration.getEndLineNumber(),
    exported: declaration.hasExportKeyword() || isDefaultExport,
    isDefaultExport,
    container: undefined,
    isModuleLevel: true,
    enclosing: undefined,
  });
}

/**
 * Records a module-level class declaration and every member it declares.
 *
 * The class itself maps to the `class` member of `SYMBOL_DECLARATION_KINDS`;
 * `export default class {}` is recorded under the reserved default name, which
 * then also serves as its members' container. A class the parser could not name
 * and that is not a default export is broken source: it is reported, and its
 * members are skipped with it, because a member with no owning class name is
 * not addressable by anything downstream.
 *
 * @param walk The file walk to append to.
 * @param declaration The class declaration to record.
 */
function collectClassDeclaration(walk: Walk, declaration: ClassDeclaration): void {
  const nameNode = declaration.getNameNode();
  const declaredName = declaredNameOf(nameNode);
  const isDefaultExport = declaration.hasDefaultKeyword();
  const exported = declaration.hasExportKeyword() || isDefaultExport;

  if (declaredName === undefined && !isDefaultExport) {
    walk.diagnostics.push(
      droppedDeclaration(
        declaration.getKindName(),
        positionOf(walk.sourceFile, declaration),
        walk.file,
      ),
    );

    return;
  }

  const name = declaredName ?? DEFAULT_EXPORT_NAME;
  const anchor = declaredName === undefined || nameNode === undefined ? declaration : nameNode;
  const position = positionOf(walk.sourceFile, anchor);

  walk.drafts.push({
    name,
    declaration: 'class',
    line: position.line,
    column: position.column,
    endLine: declaration.getEndLineNumber(),
    exported,
    isDefaultExport,
    container: undefined,
    isModuleLevel: true,
    enclosing: undefined,
  });

  for (const member of declaration.getMembers()) {
    collectClassMember(walk, member, name, exported);
  }
}

/**
 * Records one class member as a symbol of its own.
 *
 * Members are their own nodes because they are their own instrumentation
 * targets — the function-timing patch wraps a method body exactly as it wraps a
 * free function — and because call-site classification downstream matches
 * member names. The mapping to `SYMBOL_DECLARATION_KINDS`:
 *
 * - `method() {}`, a get or set accessor, and a constructor → `method`. All
 *   three are callable members with bodies; the constructor is recorded under
 *   {@link CONSTRUCTOR_NAME}, and a get/set pair yields two nodes at two
 *   positions rather than one.
 * - `prop = value` → `property`, and `prop = () => {}` → `method`, on the same
 *   rule that distinguishes a function-valued `const` from a plain one: what
 *   the declaration initialises to is what decides whether there is a body to
 *   instrument.
 * - A static initialisation block is skipped — it has no name, so nothing could
 *   address it — and so is a computed member name, which is not statically
 *   known (see {@link declaredNameOf}).
 *
 * `exported` mirrors the owning class: a member is reachable from outside its
 * module exactly when the class that declares it is. `isDefaultExport` is
 * always `false`, since the default export is the class and never one of its
 * members.
 *
 * @param walk The file walk to append to.
 * @param member The class member to record.
 * @param container The owning class's recorded name.
 * @param exported Whether the owning class leaves its module.
 */
function collectClassMember(
  walk: Walk,
  member: ClassMemberTypes,
  container: string,
  exported: boolean,
): void {
  if (Node.isClassStaticBlockDeclaration(member)) {
    return;
  }

  if (Node.isConstructorDeclaration(member)) {
    const position = positionOf(walk.sourceFile, member);

    walk.drafts.push({
      name: CONSTRUCTOR_NAME,
      declaration: 'method',
      line: position.line,
      column: position.column,
      endLine: member.getEndLineNumber(),
      exported,
      isDefaultExport: false,
      container,
      isModuleLevel: false,
      enclosing: undefined,
    });

    collectParameterProperties(walk, member, container, exported);

    return;
  }

  const nameNode = member.getNameNode();
  const name = declaredNameOf(nameNode);

  if (name === undefined) {
    return;
  }

  const declaration: SymbolDeclarationKind = Node.isPropertyDeclaration(member)
    ? isFunctionValued(member.getInitializer())
      ? 'method'
      : 'property'
    : 'method';
  const position = positionOf(walk.sourceFile, nameNode);

  walk.drafts.push({
    name,
    declaration,
    line: position.line,
    column: position.column,
    endLine: member.getEndLineNumber(),
    exported,
    isDefaultExport: false,
    container,
    isModuleLevel: false,
    enclosing: undefined,
  });
}

/**
 * Records the parameter properties a constructor declares.
 *
 * `constructor(readonly options: Options) {}` declares a class member in the
 * constructor signature, and a reader of the graph should find `options` on the
 * class whichever syntax declared it — so each parameter property maps to the
 * `property` member of `SYMBOL_DECLARATION_KINDS`, positioned at the parameter's
 * own identifier. An ordinary parameter declares nothing outside the
 * constructor body and is skipped.
 *
 * @param walk The file walk to append to.
 * @param constructorDeclaration The constructor to read parameters from.
 * @param container The owning class's recorded name.
 * @param exported Whether the owning class leaves its module.
 */
function collectParameterProperties(
  walk: Walk,
  constructorDeclaration: ConstructorDeclaration,
  container: string,
  exported: boolean,
): void {
  for (const parameter of constructorDeclaration.getParameters()) {
    if (!parameter.isParameterProperty()) {
      continue;
    }

    const nameNode = parameter.getNameNode();
    const name = declaredNameOf(nameNode);

    if (name === undefined) {
      continue;
    }

    const position = positionOf(walk.sourceFile, nameNode);

    walk.drafts.push({
      name,
      declaration: 'property',
      line: position.line,
      column: position.column,
      endLine: parameter.getEndLineNumber(),
      exported,
      isDefaultExport: false,
      container,
      isModuleLevel: false,
      enclosing: undefined,
    });
  }
}

/**
 * Records every declaration of a module-level variable statement.
 *
 * One statement can declare several names (`const a = 1, b = 2;`) and each is
 * its own symbol. Classification is by initialiser, which is the distinction
 * `SYMBOL_DECLARATION_KINDS` documents as decisive for the function-timing
 * patch:
 *
 * - `const f = () => {}` and `const f = function () {}` → `function`, a
 *   declaration with a body to wrap.
 * - an exported object literal, a constant initialised from a construction, a
 *   wrapper call such as `memo(() => {})`, a class expression, and an ambient
 *   `declare const x: T` → `variable`, a value whose body is either elsewhere or
 *   nowhere. A class expression's members are not recorded with it: the
 *   declaration anything downstream can name is the constant.
 *
 * A destructuring pattern binds several names at once and is walked for them.
 * A statement the parser left with no declarations at all is broken source and
 * is reported.
 *
 * @param walk The file walk to append to.
 * @param statement The variable statement to record.
 */
function collectVariableStatement(walk: Walk, statement: VariableStatement): void {
  const declarations = statement.getDeclarations();

  if (declarations.length === 0) {
    walk.diagnostics.push(
      droppedDeclaration(
        statement.getKindName(),
        positionOf(walk.sourceFile, statement),
        walk.file,
      ),
    );

    return;
  }

  const exported = statement.hasExportKeyword();

  for (const declaration of declarations) {
    const nameNode = declaration.getNameNode();

    if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
      collectBindingPattern(walk, nameNode, exported, 0);
      continue;
    }

    const name = declaredNameOf(nameNode);

    if (name === undefined) {
      walk.diagnostics.push(
        droppedDeclaration(
          declaration.getKindName(),
          positionOf(walk.sourceFile, declaration),
          walk.file,
        ),
      );

      continue;
    }

    const position = positionOf(walk.sourceFile, nameNode);

    walk.drafts.push({
      name,
      declaration: isFunctionValued(declaration.getInitializer()) ? 'function' : 'variable',
      line: position.line,
      column: position.column,
      endLine: declaration.getEndLineNumber(),
      exported,
      isDefaultExport: false,
      container: undefined,
      isModuleLevel: true,
      enclosing: undefined,
    });
  }
}

/**
 * Records every name a destructuring pattern binds.
 *
 * `export const { a, b: renamed, ...rest } = source` and
 * `const [first, , third] = source` each declare module-level names a consumer
 * can import, so every bound identifier becomes a `variable` symbol at its own
 * position — the local name, which is what other modules and this module's own
 * code refer to. A nested pattern is recursed into up to
 * {@link MAX_NESTING_DEPTH}; an omitted array element binds nothing and
 * is skipped.
 *
 * @param walk The file walk to append to.
 * @param pattern The binding pattern to read.
 * @param exported Whether the declaring statement leaves its module.
 * @param depth The current nesting depth, `0` at the statement's own pattern.
 */
function collectBindingPattern(
  walk: Walk,
  pattern: ObjectBindingPattern | ArrayBindingPattern,
  exported: boolean,
  depth: number,
): void {
  if (depth >= MAX_NESTING_DEPTH) {
    return;
  }

  for (const element of pattern.getElements()) {
    if (!Node.isBindingElement(element)) {
      continue;
    }

    const nameNode = element.getNameNode();

    if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
      collectBindingPattern(walk, nameNode, exported, depth + 1);
      continue;
    }

    const name = declaredNameOf(nameNode);

    if (name === undefined) {
      continue;
    }

    const position = positionOf(walk.sourceFile, nameNode);

    walk.drafts.push({
      name,
      declaration: 'variable',
      line: position.line,
      column: position.column,
      endLine: element.getEndLineNumber(),
      exported,
      isDefaultExport: false,
      container: undefined,
      isModuleLevel: true,
      enclosing: undefined,
    });
  }
}

/**
 * Records an interface, a type alias or an enum declaration.
 *
 * The three type-level forms, each with its own `SYMBOL_DECLARATION_KINDS`
 * member — `interface`, `type` and `enum` — which is what marks them as
 * declarations that vanish at runtime: no instrumentation will ever produce a
 * span for one, and a feasibility check reads the kind to say so instead of
 * reporting the symbol as missing. Recorded whether or not they are exported,
 * because a local props type or payload interface is still a declaration of
 * this file that an investigation may need to find.
 *
 * Enum *members* are not recorded: a member is addressed through its enum, and
 * it is not an instrumentation target in its own right.
 *
 * @param walk The file walk to append to.
 * @param declaration The interface, type alias or enum declaration.
 * @param kind The `SYMBOL_DECLARATION_KINDS` member the form maps to.
 */
function collectTypeLevelDeclaration(
  walk: Walk,
  declaration: InterfaceDeclaration | TypeAliasDeclaration | EnumDeclaration,
  kind: 'interface' | 'type' | 'enum',
): void {
  const nameNode = declaration.getNameNode();
  const name = declaredNameOf(nameNode);

  if (name === undefined) {
    walk.diagnostics.push(
      droppedDeclaration(
        declaration.getKindName(),
        positionOf(walk.sourceFile, declaration),
        walk.file,
      ),
    );

    return;
  }

  const position = positionOf(walk.sourceFile, nameNode);

  walk.drafts.push({
    name,
    declaration: kind,
    line: position.line,
    column: position.column,
    endLine: declaration.getEndLineNumber(),
    exported: declaration.hasExportKeyword(),
    isDefaultExport: false,
    container: undefined,
    isModuleLevel: true,
    enclosing: undefined,
  });
}

/**
 * Records a namespace declaration, and only the namespace itself.
 *
 * `namespace Feature { … }` is a named module-level declaration with no member
 * of `SYMBOL_DECLARATION_KINDS` to describe it, which is the case the vocabulary
 * keeps `unknown` for: a name the graph can find with an imprecise kind beats a
 * hole in the graph. Its body is not walked, on the same scope rule that skips
 * function-local declarations — a namespace member is addressed by a qualified
 * name, which is not the `(file, symbol)` pair anything downstream names.
 *
 * Two forms declare nothing local and are skipped: `declare global { … }`,
 * which augments the global scope, and `declare module 'specifier' { … }`,
 * which augments another module and carries a string-literal name.
 *
 * @param walk The file walk to append to.
 * @param declaration The module or namespace declaration.
 */
function collectModuleDeclaration(walk: Walk, declaration: ModuleDeclaration): void {
  if (declaration.getDeclarationKind() === ModuleDeclarationKind.Global) {
    return;
  }

  const nameNode = declaration.getNameNode();

  if (!Node.isIdentifier(nameNode)) {
    return;
  }

  const name = declaredNameOf(nameNode);

  if (name === undefined) {
    return;
  }

  const position = positionOf(walk.sourceFile, nameNode);

  walk.drafts.push({
    name,
    declaration: 'unknown',
    line: position.line,
    column: position.column,
    endLine: declaration.getEndLineNumber(),
    exported: declaration.hasExportKeyword(),
    isDefaultExport: false,
    container: undefined,
    isModuleLevel: true,
    enclosing: undefined,
  });
}

/**
 * Records an `export default <expression>` or an `export = <expression>`
 * statement as a pending intent.
 *
 * Both forms are statements rather than declarations, so neither can be
 * classified in isolation: `export default cfg` names a declaration that may
 * appear anywhere in the module. The intent is therefore queued and resolved
 * after the walk (see {@link applyDefaultExports}).
 *
 * - `export default <expression>` → a default-export intent. A bare identifier
 *   carries the name to match; any other expression carries none, so the
 *   default export becomes a node named {@link DEFAULT_EXPORT_NAME}.
 * - `export = <expression>` → **not** an ECMAScript default export. It is the
 *   TypeScript form for a CommonJS module's single export, so a bare identifier
 *   only marks the named local declaration as exported and nothing else is
 *   recorded.
 *
 * @param walk The file walk to append to.
 * @param assignment The export assignment statement.
 */
function collectExportAssignment(walk: Walk, assignment: ExportAssignment): void {
  const expression = unwrapExpression(assignment.getExpression());

  if (assignment.isExportEquals()) {
    if (Node.isIdentifier(expression)) {
      walk.localExports.push({ localName: expression.getText(), isDefault: false });
    }

    return;
  }

  const position = positionOf(walk.sourceFile, expression);
  const name = Node.isIdentifier(expression) ? expression.getText() : undefined;

  walk.defaultExports.push({
    name,
    declaration: classifyDefaultExportExpression(expression),
    line: position.line,
    column: position.column,
    endLine: assignment.getEndLineNumber(),
  });
}

/**
 * Records a local export clause as pending intents.
 *
 * This is where *local* exports live, which is the division of labour with
 * `./imports.ts`: that module records re-exports — every clause carrying a
 * module specifier — and this one records the clauses that export declarations
 * of the file itself.
 *
 * - `export { x }` and `export type { T }` → mark the local declaration as
 *   exported. A type-only clause is no less an export: the declaration still
 *   leaves the module.
 * - `export { x as default }` → mark the local declaration as exported **and**
 *   as the default export, so both the name lookup and the default lookup
 *   resolve to the one node that actually has a position and a body.
 * - `export { x } from './y'` → ignored here; it declares nothing local.
 *
 * A specifier naming no declaration of this file re-exports an imported
 * binding, and is ignored rather than turned into a node: this file does not
 * declare it, and a `symbol` node asserts that it does.
 *
 * @param walk The file walk to append to.
 * @param declaration The export declaration to read.
 */
function collectExportDeclaration(walk: Walk, declaration: ExportDeclaration): void {
  if (declaration.getModuleSpecifier() !== undefined) {
    return;
  }

  for (const specifier of declaration.getNamedExports()) {
    const alias = specifier.getAliasNode()?.getText();

    walk.localExports.push({
      localName: specifier.getName(),
      isDefault: alias === DEFAULT_EXPORT_NAME,
    });
  }
}

/* -------------------------------------------------------------------------------------------------
 * Nested declarations
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a node's body is a lexical scope this walk counts and descends into.
 *
 * The seven forms that own a body a declaration can be written inside: a
 * function declaration, a function expression, an arrow function, a method, a
 * constructor and the two accessors. A class body is *not* one of them — it
 * declares members rather than holding statements — and is handled separately
 * so that entering a class does not spend depth (see
 * {@link collectNestedDeclarations}).
 *
 * @param node The node to classify.
 * @returns `true` when the node opens a nested function-like scope.
 */
function isFunctionLikeScope(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

/**
 * The name the declaration *holding* a function expression or arrow gives it,
 * or `undefined` when nothing names it.
 *
 * `const handleRetry = () => {}` and `{ onPick: function () {} }` write a
 * function with no identifier of its own, and the name a developer would use to
 * address anything inside it is the one on the left of the `=` or the `:`. The
 * wrappers {@link unwrapExpression} peels are climbed here in the opposite
 * direction, and for the same reason: `const f = (() => {}) as Fn` names its
 * function `f`.
 *
 * Anything else — a call argument (`useEffect(() => {})`), a return statement,
 * an array element — names nothing, which is the case
 * `SymbolNodeData.enclosing` records as an anonymous link in the chain.
 *
 * @param fn The function expression or arrow function.
 * @returns The holder's declared name, or `undefined`.
 */
function holderNameOf(fn: Node): string | undefined {
  let current: Node | undefined = fn.getParent();

  for (let depth = 0; depth < MAX_NESTING_DEPTH && current !== undefined; depth += 1) {
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isTypeAssertion(current)
    ) {
      current = current.getParent();
      continue;
    }

    if (
      Node.isVariableDeclaration(current) ||
      Node.isPropertyAssignment(current) ||
      Node.isPropertyDeclaration(current)
    ) {
      return declaredNameOf(current.getNameNode());
    }

    return undefined;
  }

  return undefined;
}

/**
 * The name a nested scope contributes to an enclosing chain, or `undefined` for
 * an anonymous one.
 *
 * Read from the scope itself wherever it has an identifier — a function
 * declaration, a named function expression, a method or accessor name, the
 * `constructor` keyword — and from the declaration that holds it otherwise, so
 * the chain reads the way a developer would qualify the declaration inside it.
 *
 * @param scope A node {@link isFunctionLikeScope} accepted, or a class.
 * @returns The name to append to the chain, or `undefined` to leave it
 * unchanged.
 */
function scopeNameOf(scope: Node): string | undefined {
  if (Node.isConstructorDeclaration(scope)) {
    return CONSTRUCTOR_NAME;
  }

  if (
    Node.isMethodDeclaration(scope) ||
    Node.isGetAccessorDeclaration(scope) ||
    Node.isSetAccessorDeclaration(scope)
  ) {
    return declaredNameOf(scope.getNameNode());
  }

  if (
    Node.isFunctionDeclaration(scope) ||
    Node.isFunctionExpression(scope) ||
    Node.isClassDeclaration(scope) ||
    Node.isClassExpression(scope)
  ) {
    const own = declaredNameOf(scope.getNameNode());

    if (own !== undefined) {
      return own;
    }
  }

  return holderNameOf(scope);
}

/**
 * One enclosing chain extended by one scope, or returned unchanged for an
 * anonymous scope.
 *
 * A new array every time rather than a mutated one: a chain is handed to the
 * drafts of a whole subtree and stored on the node payload, so sharing a
 * mutable array between sibling scopes would make the recorded chain depend on
 * the walk order.
 *
 * @param chain The chain of the enclosing scope.
 * @param name The name this scope contributes, or `undefined`.
 * @returns The chain to use inside the scope.
 */
function extendChain(chain: readonly string[], name: string | undefined): readonly string[] {
  return name === undefined ? chain : [...chain, name];
}

/**
 * Records a named function declaration written inside a function-like body.
 *
 * The shape AAP §6's canonical plan names — `async function submitOrder() {}`
 * inside the component that submits — and the reason this whole section exists:
 * the declaration has a body at a position, so an instrumentation action can
 * name it, and a graph that omits it makes the one plan the product is built
 * around infeasible.
 *
 * `exported` is `false` unconditionally: a nested declaration cannot carry an
 * export keyword and, with `isModuleLevel: false`, cannot be reached by an
 * `export { … }` clause either. A declaration whose name is not a plain
 * identifier is not recorded — there is none in valid TypeScript, and the guard
 * keeps a parser-recovered construct from producing an unaddressable node.
 *
 * @param walk The file walk to append to.
 * @param declaration The nested function declaration.
 * @param enclosing The chain of enclosing named declarations, outermost first.
 */
function collectNestedFunctionDeclaration(
  walk: Walk,
  declaration: FunctionDeclaration,
  enclosing: readonly string[],
): void {
  const nameNode = declaration.getNameNode();

  if (nameNode === undefined || !Node.isIdentifier(nameNode)) {
    return;
  }

  const name = declaredNameOf(nameNode);

  if (name === undefined) {
    return;
  }

  const position = positionOf(walk.sourceFile, nameNode);

  walk.drafts.push({
    name,
    declaration: 'function',
    line: position.line,
    column: position.column,
    endLine: declaration.getEndLineNumber(),
    exported: false,
    isDefaultExport: false,
    container: undefined,
    isModuleLevel: false,
    enclosing,
  });
}

/**
 * Records a `const`/`let`/`var` declarator written inside a function-like body
 * whose initialiser is a function.
 *
 * Two guards, and both are the difference between an addressable declaration
 * and a claim the patcher cannot honour:
 *
 * - **A plain identifier name.** A binding pattern (`const { open, onClose } =
 *   props`, `const [q, setQ] = useState()`) binds a value that arrives from
 *   somewhere else; this file holds no body for it, so it is not recorded —
 *   unlike the module-level case, where the bound name is a real export of the
 *   module (see {@link collectBindingPattern}).
 * - **A function-valued initialiser**, by {@link isFunctionValued}: a written
 *   arrow or function expression has a body to wrap, while `const cb =
 *   useCallback(fn, [])` is a call whose result is a value — the body it returns
 *   is written elsewhere, or is the argument, which carries its own node when it
 *   is itself declared.
 *
 * Classified as `function`, exactly as the module-scope path classifies
 * `const f = () => {}`, so a consumer reading `data.declaration` needs no
 * special case for nesting.
 *
 * @param walk The file walk to append to.
 * @param declaration The nested variable declarator.
 * @param enclosing The chain of enclosing named declarations, outermost first.
 */
function collectNestedDeclarator(
  walk: Walk,
  declaration: VariableDeclaration,
  enclosing: readonly string[],
): void {
  const nameNode = declaration.getNameNode();

  if (!Node.isIdentifier(nameNode) || !isFunctionValued(declaration.getInitializer())) {
    return;
  }

  const name = declaredNameOf(nameNode);

  if (name === undefined) {
    return;
  }

  const position = positionOf(walk.sourceFile, nameNode);

  walk.drafts.push({
    name,
    declaration: 'function',
    line: position.line,
    column: position.column,
    endLine: declaration.getEndLineNumber(),
    exported: false,
    isDefaultExport: false,
    container: undefined,
    isModuleLevel: false,
    enclosing,
  });
}

/**
 * Walks one module-level statement for the declarations nested inside it.
 *
 * Recursive, and deliberately narrow about what it records versus what it
 * traverses:
 *
 * - **A function-like scope** is entered at one greater depth, with the
 *   enclosing chain extended by whatever names it. A function *declaration*
 *   found at depth 1 or deeper is recorded before the descent; a method, an
 *   accessor and a constructor are not, because the module-level pass already
 *   recorded the members of a module-level class and a member of a *nested*
 *   class is reachable only through a class nothing outside the body can name.
 * - **A class** extends the chain without spending depth: its body holds
 *   members, not statements, so a function declared in a method is exactly as
 *   deep as one declared in a free function beside it.
 * - **A variable declarator** at depth 1 or deeper is offered to
 *   {@link collectNestedDeclarator}, which applies the two guards that decide
 *   whether it declares a function at all.
 * - **Everything else** is traversed without being recorded, which is how a
 *   handler inside a `useEffect` callback, a JSX attribute or an `if` block is
 *   reached while a parameter, a binding element and an object-literal member
 *   stay out of the graph: none of the three is a form recorded above.
 *
 * The traversal uses `forEachChild` rather than `forEachDescendant` so the
 * depth of every visited node is known exactly, which is what makes
 * {@link MAX_DECLARATION_SCOPE_DEPTH} a real bound: past it the walk stops
 * descending instead of recording deeper declarations it would have to filter
 * afterwards.
 *
 * @param walk The file walk to append to.
 * @param node The node to read — a module-level statement on the first call.
 * @param enclosing The chain of enclosing named declarations, outermost first;
 * {@link MODULE_SCOPE_CHAIN} on the first call.
 * @param depth How many function-like bodies `node` sits inside; `0` at module
 * scope.
 */
function collectNestedDeclarations(
  walk: Walk,
  node: Node,
  enclosing: readonly string[],
  depth: number,
): void {
  if (isFunctionLikeScope(node)) {
    if (depth >= 1 && Node.isFunctionDeclaration(node)) {
      collectNestedFunctionDeclaration(walk, node, enclosing);
    }

    const inner = depth + 1;

    if (inner > MAX_DECLARATION_SCOPE_DEPTH) {
      return;
    }

    const chain = extendChain(enclosing, scopeNameOf(node));

    node.forEachChild((child) => {
      collectNestedDeclarations(walk, child, chain, inner);
    });

    return;
  }

  if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) {
    const chain = extendChain(enclosing, scopeNameOf(node));

    node.forEachChild((child) => {
      collectNestedDeclarations(walk, child, chain, depth);
    });

    return;
  }

  if (depth >= 1 && Node.isVariableDeclaration(node)) {
    collectNestedDeclarator(walk, node, enclosing);
  }

  node.forEachChild((child) => {
    collectNestedDeclarations(walk, child, enclosing, depth);
  });
}

/* -------------------------------------------------------------------------------------------------
 * Walk, export resolution and materialisation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Dispatches one module-level statement to the collector for its form.
 *
 * The scope rule lives here: only the statements of the source file itself are
 * dispatched, so a declaration inside a function body is never reached. Import
 * declarations, `import x = require('y')` and every executable statement
 * declare no addressable symbol and fall through silently — they are ordinary
 * code, not a finding.
 *
 * @param walk The file walk to append to.
 * @param statement The module-level statement to read.
 */
function collectStatement(walk: Walk, statement: Statement): void {
  // `function f() {}`, `export default function f() {}` → `function`.
  if (Node.isFunctionDeclaration(statement)) {
    collectFunctionDeclaration(walk, statement);

    return;
  }

  // `class C {}` plus every member it declares → `class`, `method`, `property`.
  if (Node.isClassDeclaration(statement)) {
    collectClassDeclaration(walk, statement);

    return;
  }

  // `const f = () => {}` → `function`; `export const value = { … }` → `variable`.
  if (Node.isVariableStatement(statement)) {
    collectVariableStatement(walk, statement);

    return;
  }

  // `interface Shape {}` → `interface`.
  if (Node.isInterfaceDeclaration(statement)) {
    collectTypeLevelDeclaration(walk, statement, 'interface');

    return;
  }

  // `type Props = { … }` → `type`.
  if (Node.isTypeAliasDeclaration(statement)) {
    collectTypeLevelDeclaration(walk, statement, 'type');

    return;
  }

  // `enum Level { … }` → `enum`.
  if (Node.isEnumDeclaration(statement)) {
    collectTypeLevelDeclaration(walk, statement, 'enum');

    return;
  }

  // `namespace Feature { … }` → `unknown`, the vocabulary's escape for a named
  // declaration it has no member for.
  if (Node.isModuleDeclaration(statement)) {
    collectModuleDeclaration(walk, statement);

    return;
  }

  // `export default <expression>` and `export = <expression>`.
  if (Node.isExportAssignment(statement)) {
    collectExportAssignment(walk, statement);

    return;
  }

  // `export { x }`, `export { x as default }`, `export type { T }`.
  if (Node.isExportDeclaration(statement)) {
    collectExportDeclaration(walk, statement);
  }
}

/**
 * Applies every local export clause to the declarations it names.
 *
 * Runs after the whole file has been walked, because an export clause may
 * precede the declaration it exports. Only module-level drafts are matched: a
 * class member shares the name space of its class, not of the module, so
 * `export { query }` must never mark a method called `query`.
 *
 * Every draft of the named declaration is marked, which is what makes an
 * exported *overloaded* function come out exported on all of its signatures.
 *
 * @param walk The completed file walk.
 */
function applyLocalExports(walk: Walk): void {
  for (const intent of walk.localExports) {
    for (const draft of walk.drafts) {
      if (!draft.isModuleLevel || draft.name !== intent.localName) {
        continue;
      }

      draft.exported = true;

      if (intent.isDefault) {
        draft.isDefaultExport = true;
      }
    }
  }
}

/**
 * Resolves every pending `export default <expression>` statement.
 *
 * Two outcomes, and the first is the one that matters for a lookup:
 *
 * - The expression names a declaration of this module → that declaration is
 *   marked exported and default, so `findSymbol` by its declared name *and* a
 *   default-export lookup both reach the node that carries the real position
 *   and extent. No second node is minted, which is what keeps the file's
 *   declaration count honest.
 * - It names nothing local — an object literal, a call, or an identifier bound
 *   by an import → a node named {@link DEFAULT_EXPORT_NAME} is minted at the
 *   expression's position, so the module's default export is still findable.
 *
 * @param walk The completed file walk.
 */
function applyDefaultExports(walk: Walk): void {
  for (const intent of walk.defaultExports) {
    let matched = false;

    if (intent.name !== undefined) {
      for (const draft of walk.drafts) {
        if (!draft.isModuleLevel || draft.name !== intent.name) {
          continue;
        }

        draft.exported = true;
        draft.isDefaultExport = true;
        matched = true;
      }
    }

    if (matched) {
      continue;
    }

    walk.drafts.push({
      name: DEFAULT_EXPORT_NAME,
      declaration: intent.declaration,
      line: intent.line,
      column: intent.column,
      endLine: intent.endLine,
      exported: true,
      isDefaultExport: true,
      container: undefined,
      isModuleLevel: true,
      enclosing: undefined,
    });
  }
}

/**
 * Orders two drafts: by position, then by name, then by declaration kind.
 *
 * Position order is source order for everything a file declares — a class's
 * members start after its name — and the two remaining comparisons exist only
 * so that the order is *total* and therefore reproducible, never depending on
 * the sort's stability or on the order the walk happened to append in. String
 * comparison is byte-wise rather than locale-aware, so the serialised index is
 * identical on every machine.
 *
 * @param left The first draft.
 * @param right The second draft.
 * @returns A negative number, zero, or a positive number, as
 * `Array.prototype.sort` expects.
 */
function compareDrafts(left: SymbolDraft, right: SymbolDraft): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  if (left.column !== right.column) {
    return left.column - right.column;
  }

  if (left.name !== right.name) {
    return left.name < right.name ? -1 : 1;
  }

  if (left.declaration !== right.declaration) {
    return left.declaration < right.declaration ? -1 : 1;
  }

  return 0;
}

/**
 * Turns one draft into a `symbol` node.
 *
 * The id comes from `makeNodeId` and from nothing else, so it is deterministic
 * and injective: two declarations that differ at all differ in name or in
 * position, which is what keeps an overload set, a method sharing a name with a
 * module-level function, and two same-named declarations in different scopes
 * from colliding on one id. `endLine` is clamped to at least `line` so the
 * extent invariant on `CodeNodeBase.endLine` holds even for a construct whose
 * name node the parser placed after its end.
 *
 * @param draft The collected declaration.
 * @param file The file being visited, project-relative POSIX.
 * @returns The node to emit.
 */
function toSymbolNode(draft: SymbolDraft, file: string): CodeNodeOf<'symbol'> {
  // `SymbolNodeData.enclosing` is omitted rather than set to `undefined` for a
  // module-level declaration or a class member: the field's *absence* is what
  // says "reachable from outside its own body", and the package compiles under
  // `exactOptionalPropertyTypes`, where absent and present-but-undefined are
  // not the same type. An empty array is passed through, because "nested inside
  // declarations none of which has a name" is a different answer from "not
  // nested".
  const data: SymbolNodeData =
    draft.enclosing === undefined
      ? { declaration: draft.declaration, isDefaultExport: draft.isDefaultExport }
      : {
          declaration: draft.declaration,
          isDefaultExport: draft.isDefaultExport,
          enclosing: draft.enclosing,
        };
  const node = {
    id: makeNodeId({
      kind: 'symbol',
      file,
      name: draft.name,
      line: draft.line,
      column: draft.column,
    }),
    kind: 'symbol',
    name: draft.name,
    file,
    line: draft.line,
    column: draft.column,
    endLine: Math.max(draft.endLine, draft.line),
    exported: draft.exported,
    data,
  } as const satisfies CodeNodeOf<'symbol'>;

  // `CodeNodeBase.symbol` is "the enclosing or declared symbol name, when it
  // differs from `name`" — for a class member, the class that declares it. It
  // is omitted rather than set to `undefined` for a module-level declaration,
  // whose name already *is* its symbol (and the package compiles under
  // `exactOptionalPropertyTypes`, where the two are not the same thing).
  //
  // A **nested** declaration has no container and therefore no `symbol`, which
  // is deliberate and not an omission: `../graph/query.ts`'s `nodeBearsSymbol`
  // matches that field, and a nested helper must not become a call target under
  // the name of the function it happens to sit inside. Its enclosing chain
  // travels in the payload instead.
  return draft.container === undefined ? node : { ...node, symbol: draft.container };
}

/**
 * Builds the `declares` edge for one symbol node.
 *
 * Direction is fixed by the edge table on `CODE_EDGE_KINDS`: `file` → `symbol`,
 * never the reverse, because "what is in this file" is answered by traversing
 * forwards from the file node. The edge is sited at the declaration, which is
 * both what a developer wants to be taken to and what keeps every edge id of a
 * file distinct — the node ids in the id already differ, and the site makes the
 * intent explicit.
 *
 * @param fileNodeId The id of the file node the declaration belongs to.
 * @param node The symbol node the edge points at.
 * @returns The edge to emit.
 */
function toDeclaresEdge(fileNodeId: string, node: CodeNodeOf<'symbol'>): CodeEdge {
  return {
    id: makeEdgeId({
      kind: 'declares',
      from: fileNodeId,
      to: node.id,
      line: node.line,
      column: node.column,
    }),
    kind: 'declares',
    from: fileNodeId,
    to: node.id,
    file: node.file,
    line: node.line,
    column: node.column,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Extractor
 * ---------------------------------------------------------------------------------------------- */

/**
 * Extracts every declaration of one file as a `symbol` node, plus the
 * `declares` edge that anchors it to its file.
 *
 * The sequence is four passes over cheap data rather than one clever pass, and
 * the order is the contract:
 *
 * 1. The file's path is checked with `isSafeRelativePath`. A path that fails is
 *    not a path this package may put in a node — node ids are derived from it
 *    and a `SourceLocation` is refined by the same predicate — so the file is
 *    skipped with a diagnostic instead.
 * 2. Every module-level statement is dispatched to the collector for its form
 *    and then walked for the declarations nested inside it, both inside one
 *    `try`/`catch`, so one unexpected construct costs one statement and not the
 *    file. The two reads are separate passes over the same statement rather
 *    than one: the module-level collectors classify by *form* and know nothing
 *    about scope, while the nested walk classifies by *scope* and records only
 *    the two nested forms that declare a function (see
 *    {@link collectNestedDeclarations}).
 * 3. Export clauses and default-export statements are applied, which can only
 *    happen once the whole file is known.
 * 4. Drafts are ordered and materialised into nodes and edges.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @returns The `symbol` nodes and `declares` edges found, with diagnostics only
 * when there were findings — absent, per `ExtractorResult`, for a clean file.
 */
function extractSymbols(ctx: ExtractorContext): ExtractorResult {
  if (!isSafeRelativePath(ctx.file)) {
    return {
      nodes: [],
      edges: [],
      diagnostics: [
        {
          severity: 'warning',
          code: 'file-skipped',
          message:
            'Skipped a file whose project-relative path failed the safe-path check; no symbols were recorded for it.',
          extractorId: EXTRACTOR_ID,
        },
      ],
    };
  }

  const walk: Walk = {
    sourceFile: ctx.sourceFile,
    file: ctx.file,
    drafts: [],
    defaultExports: [],
    localExports: [],
    diagnostics: [],
  };

  for (const statement of ctx.sourceFile.getStatements()) {
    try {
      collectStatement(walk, statement);
      collectNestedDeclarations(walk, statement, MODULE_SCOPE_CHAIN, 0);
    } catch (error) {
      walk.diagnostics.push(
        unexpectedFailure(
          statement.getKindName(),
          positionOf(ctx.sourceFile, statement),
          ctx.file,
          error,
        ),
      );
    }
  }

  applyLocalExports(walk);
  applyDefaultExports(walk);
  walk.drafts.sort(compareDrafts);

  const fileNodeId = makeNodeId({
    kind: 'file',
    file: ctx.file,
    name: ctx.file,
    line: FILE_NODE_LINE,
    column: FILE_NODE_COLUMN,
  });
  const nodes: CodeNodeOf<'symbol'>[] = [];
  const edges: CodeEdge[] = [];

  for (const draft of walk.drafts) {
    const node = toSymbolNode(draft, ctx.file);

    nodes.push(node);
    edges.push(toDeclaresEdge(fileNodeId, node));
  }

  return walk.diagnostics.length === 0
    ? { nodes, edges }
    : { nodes, edges, diagnostics: walk.diagnostics };
}

/**
 * The symbol extractor: `symbol` nodes and `declares` edges for one file.
 *
 * Registered in `../indexer.ts`'s `DEFAULT_EXTRACTORS` and invoked once per
 * source file. It reads nothing but the abstract syntax tree of the file in its
 * {@link ExtractorContext}, writes nothing, and never throws — a construct it
 * cannot read becomes an `IndexDiagnostic` on the result while the rest of the
 * file still yields nodes.
 *
 * Frozen, because every extractor is handed the same context and the indexer
 * holds this value for the life of a run: a mutated `id` would make a
 * diagnostic unattributable.
 *
 * @example
 * ```ts
 * const { nodes, edges } = symbolsExtractor.extract(ctx);
 * // `ExtractorResult.nodes` is typed as the whole `CodeNode` union, so narrow
 * // on the kind before reading a payload — every node this extractor emits is
 * // a `symbol`, and the narrowing is what tells the compiler so.
 * const exportedFunctions = nodes
 *   .filter((node): node is CodeNodeOf<'symbol'> => node.kind === 'symbol')
 *   .filter((node) => node.exported === true && node.data?.declaration === 'function');
 * ```
 */
export const symbolsExtractor: Extractor = Object.freeze({
  id: EXTRACTOR_ID,
  extract: extractSymbols,
});
