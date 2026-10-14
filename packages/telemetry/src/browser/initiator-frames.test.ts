/**
 * Tests for `applicationFrames` in `./fetch.ts`: the initiator stack a request
 * event carries names the application's frames only, as the stack would read
 * with no instrumentation installed.
 *
 * The frames below are shaped like the ones Chrome records on a Next.js dev
 * page: generated-chunk coordinates for the application and React, and the
 * extension's `agent.iife.js` for the agent. A function-timing patch moves the
 * original body into `__orig` and calls the agent's minified `span` method
 * through `__dbg.span(…)`, which V8 writes as `Object.kT [as span]`. Two
 * patched functions on one call path therefore add six frames, and without the
 * filter those frames spend the initiator budget that the React commit frames
 * need — the frames that tell two mounts of the same component apart.
 *
 * The filter drops the patch's callback and the patched function's own frame
 * only where the stack proves them to be the patch's. The helper-only, awaited,
 * truncated and other-source cases pin the other half of that contract: every
 * frame without such a proof is the application's, and stays.
 */

import { describe, expect, it } from 'vitest';

import { MAX_INITIATOR_FRAMES, applicationFrames } from './fetch.js';

const AGENT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/agent.iife.js';
const APP = 'http://localhost:3000/_next/static/chunks/app.js';
const REACT = 'http://localhost:3000/_next/static/chunks/react-dom.js';

/** A chunk other than the application's, for frames that name another source. */
const VENDOR = 'http://localhost:3000/_next/static/chunks/vendor.js';

/**
 * A module evaluated by webpack's `eval-source-map` development build, whose
 * source carries parentheses of its own.
 */
const WEBPACK_MODULE = 'webpack-internal:///(app-pages-browser)/./src/lib/orbit.ts';

/** A named V8 frame line. */
function frame(fn: string, source: string, line: number, column = 1): string {
  return `    at ${fn} (${source}:${String(line)}:${String(column)})`;
}

/** An anonymous V8 frame line, shaped like the patch template's arrow callback. */
function anonymous(source: string, line: number, column = 1): string {
  return `    at ${source}:${String(line)}:${String(column)}`;
}

/** The agent's fetch patch and capture helpers, innermost first. */
const LEADING_AGENT_FRAMES = [
  frame('Object.qR', AGENT, 7, 100),
  frame('Object.pS', AGENT, 7, 200),
  frame('window.fetch', AGENT, 7, 300),
];

/** The agent's minified span helper, as V8 writes it. */
const HELPER_FRAME = frame('Object.kT [as span]', AGENT, 7, 38352);

/** The React commit frames under a passive effect, innermost first. */
const REACT_FRAMES = [
  frame('Object.react_stack_bottom_frame', REACT, 14944),
  frame('runWithFiberInDEV', REACT, 761),
  frame('commitHookEffectListMount', REACT, 7082),
  frame('commitHookPassiveMountEffects', REACT, 7117),
  frame('commitPassiveMountOnFiber', REACT, 8519),
  frame('recursivelyTraversePassiveMountEffects', REACT, 8506),
  frame('commitPassiveMountOnFiber', REACT, 8580),
  frame('recursivelyTraversePassiveMountEffects', REACT, 8506),
];

describe('applicationFrames', () => {
  it('drops the leading agent frames and keeps every application frame', () => {
    const application = [
      frame('observatoryRequest', APP, 6287),
      frame('loadStarCharts', APP, 6379),
      frame('useStarCharts.useEffect', APP, 6049),
      ...REACT_FRAMES,
    ];

    expect(applicationFrames([...LEADING_AGENT_FRAMES, ...application], AGENT)).toEqual(
      application,
    );
  });

  it('reads a patched call path like the unpatched one, each __orig frame in its function’s place', () => {
    const patched = [
      ...LEADING_AGENT_FRAMES,
      frame('__orig', APP, 6288),
      anonymous(APP, 6342),
      frame('Object.kT [as span]', AGENT, 7, 38352),
      frame('observatoryRequest', APP, 6337),
      frame('__orig', APP, 6392),
      anonymous(APP, 6408),
      frame('Object.kT [as span]', AGENT, 7, 38352),
      frame('loadStarCharts', APP, 6403),
      frame('useStarCharts.useEffect', APP, 6049),
      ...REACT_FRAMES,
    ];

    const kept = applicationFrames(patched, AGENT);

    expect(kept).toEqual([
      frame('__orig', APP, 6288),
      frame('__orig', APP, 6392),
      frame('useStarCharts.useEffect', APP, 6049),
      ...REACT_FRAMES,
    ]);
    expect(kept.some((line) => line.includes(AGENT))).toBe(false);

    // The budget reaches as deep into React's commit as it does unpatched.
    const budgeted = kept.slice(0, MAX_INITIATOR_FRAMES);
    expect(budgeted).toHaveLength(MAX_INITIATOR_FRAMES);
    expect(budgeted.at(-1)).toBe(REACT_FRAMES[MAX_INITIATOR_FRAMES - 4]);
  });

  it('recognises the helper under an unminified name and in a non-V8 stack', () => {
    const v8 = [
      ...LEADING_AGENT_FRAMES,
      frame('__orig', APP, 10),
      anonymous(APP, 11),
      frame('Object.span', AGENT, 7, 5),
      frame('handleSlewClick', APP, 12),
      frame('onClick', APP, 20),
    ];
    expect(applicationFrames(v8, AGENT)).toEqual([
      frame('__orig', APP, 10),
      frame('onClick', APP, 20),
    ]);

    const spiderMonkey = [
      `qR@${AGENT}:7:100`,
      `__orig@${APP}:10:1`,
      `@${APP}:11:1`,
      `span@${AGENT}:7:5`,
      `handleSlewClick@${APP}:12:1`,
      `onClick@${APP}:20:1`,
    ];
    expect(applicationFrames(spiderMonkey, AGENT)).toEqual([
      `__orig@${APP}:10:1`,
      `onClick@${APP}:20:1`,
    ]);
  });

  it('drops any other agent frame on its own and never a neighbour', () => {
    const frames = [
      ...LEADING_AGENT_FRAMES,
      frame('loadThing', APP, 30),
      frame('Object.zZ', AGENT, 7, 900),
      frame('onEvent', APP, 40),
    ];

    expect(applicationFrames(frames, AGENT)).toEqual([
      frame('loadThing', APP, 30),
      frame('onEvent', APP, 40),
    ]);
  });

  it('keeps both neighbours of a helper the application called itself', () => {
    const application = [
      frame('measureParallax', APP, 50),
      frame('plotOrbit', APP, 60),
      frame('onClick', APP, 70),
    ];
    const [inside, outside, caller] = application;

    expect(
      applicationFrames(
        [...LEADING_AGENT_FRAMES, inside ?? '', HELPER_FRAME, outside ?? '', caller ?? ''],
        AGENT,
      ),
    ).toEqual(application);
  });

  it('drops only the helper frame of an awaited stack, which lists no callback', () => {
    const application = [
      frame('__orig', APP, 80),
      frame('async plotOrbit', APP, 90),
      frame('async onClick', APP, 95),
    ];
    const [inner, ...outer] = application;

    expect(
      applicationFrames(
        [
          ...LEADING_AGENT_FRAMES,
          inner ?? '',
          frame('async Object.kT [as span]', AGENT, 7, 38352),
          ...outer,
        ],
        AGENT,
      ),
    ).toEqual(application);
  });

  it('reads a stack truncated at or before the helper without losing an application frame', () => {
    const endsAtHelper = [
      ...LEADING_AGENT_FRAMES,
      frame('__orig', APP, 100),
      anonymous(APP, 101),
      HELPER_FRAME,
    ];
    expect(applicationFrames(endsAtHelper, AGENT)).toEqual([frame('__orig', APP, 100)]);

    const endsBeforeHelper = [
      ...LEADING_AGENT_FRAMES,
      frame('__orig', APP, 100),
      anonymous(APP, 101),
    ];
    expect(applicationFrames(endsBeforeHelper, AGENT)).toEqual([
      frame('__orig', APP, 100),
      anonymous(APP, 101),
    ]);
  });

  it('keeps an anonymous callback the application wrote, and the frame outside the helper', () => {
    const unproven = [
      // No inner function at all.
      [frame('measureParallax', APP, 110), anonymous(APP, 111), frame('plotOrbit', APP, 112)],
      // Names that merely resemble the patch's inner function.
      [frame('__origin', APP, 120), anonymous(APP, 121), frame('plotOrbit', APP, 122)],
      [frame('my__orig', APP, 130), anonymous(APP, 131), frame('plotOrbit', APP, 132)],
      [frame('__orig_x', APP, 140), anonymous(APP, 141), frame('plotOrbit', APP, 142)],
      // An inner function in another source than the callback.
      [frame('__orig', VENDOR, 150), anonymous(APP, 151), frame('plotOrbit', APP, 152)],
      // A named callback is never the template's anonymous arrow.
      [frame('__orig', APP, 160), frame('onTick', APP, 161), frame('plotOrbit', APP, 162)],
    ];

    for (const [inner, callback, outer] of unproven) {
      const application = [inner ?? '', callback ?? '', outer ?? '', frame('onClick', APP, 170)];
      const [first, second, ...rest] = application;

      expect(
        applicationFrames(
          [...LEADING_AGENT_FRAMES, first ?? '', second ?? '', HELPER_FRAME, ...rest],
          AGENT,
        ),
      ).toEqual(application);
    }
  });

  it('keeps the frame outside a proven callback when it names another source', () => {
    const frames = [
      ...LEADING_AGENT_FRAMES,
      frame('__orig', APP, 180),
      anonymous(APP, 181),
      HELPER_FRAME,
      frame('alignMount', VENDOR, 5),
      frame('onClick', APP, 190),
    ];

    expect(applicationFrames(frames, AGENT)).toEqual([
      frame('__orig', APP, 180),
      frame('alignMount', VENDOR, 5),
      frame('onClick', APP, 190),
    ]);
  });

  it('tells two webpack modules apart when only their layer segment differs', () => {
    // The same file compiled into two webpack layers is two modules, and the
    // frame outside the helper belongs to the other one.
    const otherLayer = 'webpack-internal:///(pages-dir-browser)/./src/lib/orbit.ts';
    const frames = [
      ...LEADING_AGENT_FRAMES,
      frame('__orig', WEBPACK_MODULE, 10),
      anonymous(WEBPACK_MODULE, 11),
      HELPER_FRAME,
      frame('plotOrbit', otherLayer, 12),
      frame('onClick', APP, 20),
    ];

    expect(applicationFrames(frames, AGENT)).toEqual([
      frame('__orig', WEBPACK_MODULE, 10),
      frame('plotOrbit', otherLayer, 12),
      frame('onClick', APP, 20),
    ]);

    // The positive control: the same stack with the outer frame in the
    // callback's own module is a proven patch, and that frame is dropped.
    expect(
      applicationFrames(
        [
          ...LEADING_AGENT_FRAMES,
          frame('__orig', WEBPACK_MODULE, 10),
          anonymous(WEBPACK_MODULE, 11),
          HELPER_FRAME,
          frame('plotOrbit', WEBPACK_MODULE, 12),
          frame('onClick', APP, 20),
        ],
        AGENT,
      ),
    ).toEqual([frame('__orig', WEBPACK_MODULE, 10), frame('onClick', APP, 20)]);
  });

  it('keeps every frame when an application function named __orig calls the helper itself', () => {
    // `__orig` is outside the run here — it is the helper's caller — so the
    // anonymous callback it passed, which issued the request, is not the
    // template's, and neither neighbour is dropped.
    const application = [
      frame('measureParallax', APP, 300),
      anonymous(APP, 301),
      frame('__orig', APP, 302),
      frame('plotOrbit', APP, 303),
      frame('onClick', APP, 304),
    ];
    const [request, callback, ...outside] = application;

    expect(
      applicationFrames(
        [...LEADING_AGENT_FRAMES, request ?? '', callback ?? '', HELPER_FRAME, ...outside],
        AGENT,
      ),
    ).toEqual(application);

    // The same with the callback issuing the request directly: the frame
    // inside it is the agent's fetch patch, never a kept `__orig`.
    const direct = [anonymous(APP, 311), frame('__orig', APP, 312), frame('plotOrbit', APP, 313)];
    const [directCallback, ...directOutside] = direct;
    expect(
      applicationFrames(
        [...LEADING_AGENT_FRAMES, directCallback ?? '', HELPER_FRAME, ...directOutside],
        AGENT,
      ),
    ).toEqual(direct);
  });

  it('recognises a disambiguated, receiver-qualified or eval-wrapped inner function', () => {
    const frames = [
      ...LEADING_AGENT_FRAMES,
      frame('__orig_1', APP, 200),
      anonymous(APP, 201),
      HELPER_FRAME,
      frame('plotOrbit', APP, 202),
      frame('Telescope.__orig', APP, 210),
      anonymous(APP, 211),
      HELPER_FRAME,
      frame('Telescope.alignMount', APP, 212),
      frame('__orig_12', WEBPACK_MODULE, 3),
      anonymous(WEBPACK_MODULE, 4),
      HELPER_FRAME,
      frame('measureParallax', WEBPACK_MODULE, 5),
      frame('onClick', APP, 220),
    ];

    expect(applicationFrames(frames, AGENT)).toEqual([
      frame('__orig_1', APP, 200),
      frame('Telescope.__orig', APP, 210),
      frame('__orig_12', WEBPACK_MODULE, 3),
      frame('onClick', APP, 220),
    ]);
  });

  it('recognises a SpiderMonkey callback named after its enclosing function', () => {
    const spiderMonkey = [
      `qR@${AGENT}:7:100`,
      `__orig@${APP}:230:1`,
      `plotOrbit/<@${APP}:231:1`,
      `span@${AGENT}:7:5`,
      `plotOrbit@${APP}:232:1`,
      `alignMount/__orig_2@${APP}:240:1`,
      `alignMount/<@${APP}:241:1`,
      `span@${AGENT}:7:5`,
      `alignMount@${APP}:242:1`,
      `Telescope.__orig@${APP}:250:1`,
      `Telescope.measureParallax/<@${APP}:251:1`,
      `span@${AGENT}:7:5`,
      `Telescope.measureParallax@${APP}:252:1`,
      `onClick@${APP}:260:1`,
    ];
    expect(applicationFrames(spiderMonkey, AGENT)).toEqual([
      `__orig@${APP}:230:1`,
      `alignMount/__orig_2@${APP}:240:1`,
      `Telescope.__orig@${APP}:250:1`,
      `onClick@${APP}:260:1`,
    ]);

    // The same callback shape with no inner function before it is the application's.
    const unproven = [
      `qR@${AGENT}:7:100`,
      `measureParallax@${APP}:270:1`,
      `plotOrbit/<@${APP}:271:1`,
      `span@${AGENT}:7:5`,
      `plotOrbit@${APP}:272:1`,
    ];
    expect(applicationFrames(unproven, AGENT)).toEqual([
      `measureParallax@${APP}:270:1`,
      `plotOrbit/<@${APP}:271:1`,
      `plotOrbit@${APP}:272:1`,
    ]);
  });

  it('falls back to a fixed leading count when the agent source is unknown or names no leading frame', () => {
    const application = [frame('loadThing', APP, 30), frame('onEvent', APP, 40)];

    expect(applicationFrames([...LEADING_AGENT_FRAMES, ...application], undefined)).toEqual(
      application,
    );
    expect(applicationFrames([frame('a', APP, 1), frame('b', APP, 2)], AGENT)).toEqual([]);
    expect(applicationFrames([], AGENT)).toEqual([]);
  });
});
