// @vitest-environment happy-dom
/**
 * `./react.js`'s notice of React's registration with the DevTools hook —
 * {@link watchReactRegistration} — against bippy's real hook.
 *
 * `./agent.js` announces `agent.ready` again through this notice the moment
 * React registers, which is what keeps the service from judging a React page
 * by the `reactDetected: false` its agent announced at `document_start`. So
 * the notice must fire on a registration, stop when released, never throw
 * into React's own `inject`, and — like {@link detectReact} — never install a
 * hook on a page that has none.
 *
 * The hook exists from the moment `./react.js` is imported: bippy's root entry
 * imports `bippy/install-hook-only` for its side effect, exactly as the
 * agent's bundle does. The first case therefore takes the global away for its
 * duration, to stand for a page without a hook, and puts the same hook back. A
 * stand-in renderer then registers through the hook's own `inject`, which is
 * the call `react-dom` makes as it evaluates.
 *
 * @module packages/telemetry/src/browser/react.test
 */
import { describe, expect, it } from 'vitest';

import { detectReact, watchReactRegistration } from './react.js';

/** The global the hook lives on. */
const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

/** The part of the installed hook these cases call. */
interface InjectableHook {
  readonly inject: (renderer: object) => number;
}

/** The installed hook, narrowed to its `inject`; throws when none is installed. */
function installedHook(): InjectableHook {
  const hook: unknown = (globalThis as Record<string, unknown>)[HOOK_KEY];
  if (
    typeof hook !== 'object' ||
    hook === null ||
    !('inject' in hook) ||
    typeof hook.inject !== 'function'
  ) {
    throw new Error('no DevTools hook with an inject function is installed');
  }
  const inject = hook.inject as (renderer: object) => number;
  return { inject: (renderer) => inject.call(hook, renderer) };
}

/** A renderer for the hook's registry: an object is all bippy's `inject` records. */
function standInRenderer(): object {
  return { rendererPackageName: 'stand-in', version: '0.0.0' };
}

describe('watchReactRegistration', () => {
  it('subscribes to nothing, and installs no hook, on a page without one', () => {
    const hook = Object.getOwnPropertyDescriptor(globalThis, HOOK_KEY);
    expect(hook, 'importing ./react.js installs the hook, as the agent bundle does').toBeDefined();
    expect(Reflect.deleteProperty(globalThis, HOOK_KEY)).toBe(true);

    try {
      const release = watchReactRegistration(() => {
        throw new Error('a page without a hook has nothing to register with');
      });

      expect(release).toBeUndefined();
      expect(Object.hasOwn(globalThis, HOOK_KEY)).toBe(false);
      expect(detectReact()).toBe(false);
    } finally {
      if (hook !== undefined) {
        Object.defineProperty(globalThis, HOOK_KEY, hook);
      }
    }
  });

  it('calls the listener when a renderer registers, and not before', () => {
    expect(Object.hasOwn(globalThis, HOOK_KEY)).toBe(true);
    expect(detectReact()).toBe(false);

    let calls = 0;
    let reactSeenByListener: boolean | undefined;
    const release = watchReactRegistration(() => {
      calls += 1;
      reactSeenByListener = detectReact();
    });

    expect(release).toBeTypeOf('function');
    expect(calls).toBe(0);

    installedHook().inject(standInRenderer());

    expect(calls).toBe(1);
    // The registry already holds the renderer when the notice fires, so a
    // listener that re-reads the hook sees React.
    expect(reactSeenByListener).toBe(true);
    release?.();
  });

  it('notifies nothing once released, and a second release is harmless', () => {
    let calls = 0;
    const release = watchReactRegistration(() => {
      calls += 1;
    });

    release?.();
    release?.();
    installedHook().inject(standInRenderer());

    expect(calls).toBe(0);
  });

  it('never throws into the hook’s inject, and a throwing listener does not silence another', () => {
    let calls = 0;
    const releaseThrowing = watchReactRegistration(() => {
      throw new Error('a listener that fails');
    });
    const releaseCounting = watchReactRegistration(() => {
      calls += 1;
    });

    expect(() => installedHook().inject(standInRenderer())).not.toThrow();
    expect(calls).toBe(1);

    releaseThrowing?.();
    releaseCounting?.();
  });
});
