/**
 * Which React component started a request: the component whose work React was
 * running when the page called `fetch` or `XMLHttpRequest.send`, and the
 * composite components above it.
 *
 * ## Why a stack is not enough
 *
 * `./fetch.ts` captures the call-site stack of every request, and the service
 * maps it back to project source. That names the *code* that made the request —
 * but a component mounted twice runs the same code twice, and its two requests
 * carry the same application frames; only React's own traversal frames between
 * them differ, and those are discarded as framework code. A request table that
 * must say "this request was made twice, by two initiators" (AAP 0.8.2 defect
 * 3) cannot tell the mounts apart from the stack alone.
 *
 * React can. Its development renderer keeps track of the fiber whose work is
 * running — the component whose passive effect is being committed, whose event
 * listener is being dispatched, or which is rendering — and reports it to
 * developer tools through `getCurrentFiber()` on the renderer internals it
 * injects into `__REACT_DEVTOOLS_GLOBAL_HOOK__`. Read at the moment a request
 * starts, that fiber and the components that created it identify the mount:
 * the same component written by two different components yields two different
 * owner chains. The creators come from the development build's own record of
 * who wrote each element (`_debugOwner`, continued through Server Component
 * info objects), and from the composite `return` ancestors when a build keeps
 * no such record.
 *
 * ## When there is no answer
 *
 * A production renderer does not report a current fiber; a request started
 * after an `await`, a timer or any other callback React did not invoke has no
 * running fiber; a page without React has no hook. In each case
 * {@link captureInitiatorOwner} returns `undefined` and the request carries no
 * owner at all — never a guess, and never an error.
 *
 * ## What travels
 *
 * Display names only, each bounded, and at most {@link MAX_INITIATOR_OWNERS}
 * ancestors: never a prop, a piece of state, a key or anything else read off a
 * fiber. The names are resolved the way `./react.ts` names a rendered
 * component — the element type's display name first, so a `memo` or
 * `forwardRef` wrapper's `displayName` wins over its inner function's name,
 * then the fiber's type — so a request's initiating component and the same
 * component's render events are spelled alike.
 *
 * ## Why `bippy` is a type-only import here
 *
 * `bippy`'s entry installs the developer-tools hook as a side effect of being
 * imported, while `./fetch.ts` — this module's only caller — promises that
 * importing it touches no global. So the hook is read, never installed, and
 * the handful of fiber reads this needs are made here directly against React's
 * stable fiber shape; `bippy` contributes its type declarations only. The one
 * runtime import is `./transport.ts`'s failure reporter, which `./fetch.ts`
 * already loads.
 *
 * @module
 */

import type { Fiber, ReactRenderer } from 'bippy';

import { reportProducerFailure } from './transport.js';

/**
 * The most composite ancestors an initiator's owner chain may carry: 8 — the
 * same bound a render event's `ownerChain` has (`MAX_OWNER_CHAIN` in
 * `./react.ts`), so the two chains describe a component's place in the tree at
 * the same depth.
 */
export const MAX_INITIATOR_OWNERS = 8;

/**
 * The longest component name that may travel, in UTF-16 code units — the bound
 * `./react.ts` puts on a rendered component's name, for the same reason: a
 * generated or higher-order display name can run to hundreds of characters.
 */
export const MAX_INITIATOR_NAME_LENGTH = 200;

/** What a component with no usable display name is called, as `./react.ts` calls it. */
const ANONYMOUS_COMPONENT = 'Anonymous';

/**
 * React's work tags for composite fibers — function, class, `forwardRef`,
 * `memo` and simple `memo` components — which have kept these numbers since
 * React 16.6. Every other fiber (a host element, text, a fragment, a context
 * provider, a suspense boundary) is not a level of the component tree.
 */
const COMPOSITE_WORK_TAGS: ReadonlySet<number> = new Set([0, 1, 11, 14, 15]);

/**
 * The most `return` links followed from the running fiber: far deeper than
 * any real component tree, and only there so a malformed or cyclic chain ends
 * the walk instead of the page.
 */
const MAX_ANCESTOR_HOPS = 1_024;

/**
 * How many `type` / `render` layers are unwrapped looking for a name — a
 * `memo(forwardRef(Component))` is two.
 */
const MAX_TYPE_UNWRAPS = 4;

/** The global the developer-tools hook lives on. */
const HOOK_GLOBAL = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

/** The component that started a request, and the composite components above it. */
export interface InitiatorOwner {
  /** The nearest composite component's display name. */
  readonly component: string;
  /**
   * The components that created it — or, without a creator record, its
   * composite ancestors — nearest first, at most {@link MAX_INITIATOR_OWNERS}.
   */
  readonly owners: readonly string[];
}

/** A value shaped like a fiber: enough to read its tag, types and parent. */
function isFiber(value: unknown): value is Fiber {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { tag?: unknown }).tag === 'number' &&
    'return' in value
  );
}

/** The renderers injected into the developer-tools hook, without installing one. */
function injectedRenderers(): readonly ReactRenderer[] {
  const hook: unknown = Reflect.get(globalThis, HOOK_GLOBAL);
  if (typeof hook !== 'object' || hook === null) {
    return [];
  }
  const renderers: unknown = Reflect.get(hook, 'renderers');
  return renderers instanceof Map ? [...(renderers as Map<number, ReactRenderer>).values()] : [];
}

/** The fiber some injected renderer reports as running, when one does. */
function runningFiber(): Fiber | undefined {
  for (const renderer of injectedRenderers()) {
    const read: unknown = renderer.getCurrentFiber;
    if (typeof read !== 'function') {
      continue;
    }
    const fiber: unknown = read.call(renderer);
    if (isFiber(fiber)) {
      return fiber;
    }
  }
  return undefined;
}

/** A type's own `displayName`, else its `name`, when either is a non-empty string. */
function ownName(type: object): string | undefined {
  for (const key of ['displayName', 'name']) {
    const value: unknown = Reflect.get(type, key);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * The display name of a component type: its own name, else the name of the
 * component it wraps (`type` for `memo`, `render` for `forwardRef`).
 */
function displayNameOf(type: unknown): string | undefined {
  let current = type;
  for (let depth = 0; depth <= MAX_TYPE_UNWRAPS; depth += 1) {
    if ((typeof current !== 'function' && typeof current !== 'object') || current === null) {
      return undefined;
    }
    const name = ownName(current);
    if (name !== undefined) {
      return name;
    }
    current = Reflect.get(current, 'type') ?? Reflect.get(current, 'render');
  }
  return undefined;
}

/** The name a developer would recognise for a composite fiber, bounded. */
function componentNameOf(fiber: Fiber): string {
  const name =
    displayNameOf((fiber as { elementType?: unknown }).elementType) ?? displayNameOf(fiber.type);
  if (name === undefined) {
    return ANONYMOUS_COMPONENT;
  }
  return name.length > MAX_INITIATOR_NAME_LENGTH ? name.slice(0, MAX_INITIATOR_NAME_LENGTH) : name;
}

/** Whether a fiber is a composite component rather than a host or structural node. */
function isComposite(fiber: Fiber): boolean {
  return COMPOSITE_WORK_TAGS.has(fiber.tag);
}

/** The fiber's parent, when it has one that is a fiber. */
function parentOf(fiber: Fiber): Fiber | undefined {
  const parent: unknown = fiber.return;
  return isFiber(parent) ? parent : undefined;
}

/**
 * The creator a development build records for a fiber or a Server Component:
 * `_debugOwner` on a fiber, `owner` on the component-info object React keeps
 * for a component the server rendered. `undefined` in a production build,
 * which records neither.
 */
function creatorOf(node: unknown): unknown {
  if (isFiber(node)) {
    return Reflect.get(node, '_debugOwner') ?? undefined;
  }
  if (typeof node === 'object' && node !== null) {
    return Reflect.get(node, 'owner') ?? undefined;
  }
  return undefined;
}

/**
 * The display name of one creator: a composite fiber's component name, or the
 * `name` a Server Component's info object carries, bounded like every other
 * name. `undefined` for anything else, which ends the creator chain.
 */
function creatorName(node: unknown): string | undefined {
  if (isFiber(node)) {
    return isComposite(node) ? componentNameOf(node) : undefined;
  }
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }
  const name: unknown = Reflect.get(node, 'name');
  if (typeof name !== 'string' || name.length === 0) {
    return undefined;
  }
  return name.length > MAX_INITIATOR_NAME_LENGTH ? name.slice(0, MAX_INITIATOR_NAME_LENGTH) : name;
}

/**
 * The components that *created* `fiber`, nearest first: who wrote the element
 * that mounted it, then who wrote theirs.
 *
 * This is the chain that tells two mounts apart the way a developer means it —
 * "the rail the header renders" and "the rail the product page renders" — and
 * it is what the `.return` parents cannot give: a component placed through
 * `children` has the providers and framework boundaries it is nested in as
 * parents, while its creator is the component whose JSX names it, and a
 * component rendered by a Server Component has no client parent of that page at
 * all, only the framework's own segment wrappers. React development builds
 * record the creator on every fiber and continue the chain through the
 * component-info objects of Server Components, so the page appears by name.
 */
function creatorChain(fiber: Fiber): string[] {
  const owners: string[] = [];
  let creator = creatorOf(fiber);
  for (
    let hops = 0;
    creator !== undefined && owners.length < MAX_INITIATOR_OWNERS && hops < MAX_ANCESTOR_HOPS;
    hops += 1
  ) {
    const name = creatorName(creator);
    if (name === undefined) {
      break;
    }
    owners.push(name);
    creator = creatorOf(creator);
  }
  return owners;
}

/**
 * The component that started the request being made right now, and the
 * components above it — or `undefined` when React reports no running fiber
 * (see the module notes).
 *
 * Walks up from the running fiber to the nearest composite one — during an
 * event dispatch React reports the host element whose listener runs, whose
 * component is the first composite above it. The owners are then its creator
 * chain ({@link creatorChain}) when the build records one, and otherwise its
 * composite ancestors, at most {@link MAX_INITIATOR_OWNERS} either way.
 *
 * Synchronous and cheap (a handful of property reads per tree level), because
 * it runs inside the application's own `fetch` call. It never throws: a
 * renderer or a fiber that misbehaves costs the request its owner and nothing
 * else, and is reported once per capture as a failure of the React producer —
 * the reads it makes are the React integration's, not the request transport's,
 * so it never takes the `fetch` producer's report.
 */
export function captureInitiatorOwner(): InitiatorOwner | undefined {
  try {
    let node = runningFiber();
    let hops = 0;
    while (node !== undefined && !isComposite(node) && hops < MAX_ANCESTOR_HOPS) {
      node = parentOf(node);
      hops += 1;
    }
    if (node === undefined || !isComposite(node)) {
      return undefined;
    }

    const component = componentNameOf(node);
    const created = creatorChain(node);
    if (created.length > 0) {
      return { component, owners: created };
    }

    const owners: string[] = [];
    let ancestor = parentOf(node);
    while (
      ancestor !== undefined &&
      owners.length < MAX_INITIATOR_OWNERS &&
      hops < MAX_ANCESTOR_HOPS
    ) {
      if (isComposite(ancestor)) {
        owners.push(componentNameOf(ancestor));
      }
      ancestor = parentOf(ancestor);
      hops += 1;
    }
    return { component, owners };
  } catch (error) {
    reportProducerFailure('react', 'initiator-owner', error);
    return undefined;
  }
}
