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
 */

import { describe, expect, it } from 'vitest';

import { MAX_INITIATOR_FRAMES, applicationFrames } from './fetch.js';

const AGENT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/agent.iife.js';
const APP = 'http://localhost:3000/_next/static/chunks/app.js';
const REACT = 'http://localhost:3000/_next/static/chunks/react-dom.js';

/** A named V8 frame line. */
function frame(fn: string, source: string, line: number, column = 1): string {
  return `    at ${fn} (${source}:${String(line)}:${String(column)})`;
}

/** An anonymous V8 frame line: the patch template's arrow callback. */
function anonymous(source: string, line: number, column = 1): string {
  return `    at ${source}:${String(line)}:${String(column)}`;
}

/** The agent's fetch patch and capture helpers, innermost first. */
const LEADING_AGENT_FRAMES = [
  frame('Object.qR', AGENT, 7, 100),
  frame('Object.pS', AGENT, 7, 200),
  frame('window.fetch', AGENT, 7, 300),
];

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
      frame('storefrontRequest', APP, 6287),
      frame('loadRecommendations', APP, 6379),
      frame('useRecommendations.useEffect', APP, 6049),
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
      frame('storefrontRequest', APP, 6337),
      frame('__orig', APP, 6392),
      anonymous(APP, 6408),
      frame('Object.kT [as span]', AGENT, 7, 38352),
      frame('loadRecommendations', APP, 6403),
      frame('useRecommendations.useEffect', APP, 6049),
      ...REACT_FRAMES,
    ];

    const kept = applicationFrames(patched, AGENT);

    expect(kept).toEqual([
      frame('__orig', APP, 6288),
      frame('__orig', APP, 6392),
      frame('useRecommendations.useEffect', APP, 6049),
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
      frame('handleCheckout', APP, 12),
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
      `handleCheckout@${APP}:12:1`,
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

  it('falls back to a fixed leading count when the agent source is unknown or names no leading frame', () => {
    const application = [frame('loadThing', APP, 30), frame('onEvent', APP, 40)];

    expect(applicationFrames([...LEADING_AGENT_FRAMES, ...application], undefined)).toEqual(
      application,
    );
    expect(applicationFrames([frame('a', APP, 1), frame('b', APP, 2)], AGENT)).toEqual([]);
    expect(applicationFrames([], AGENT)).toEqual([]);
  });
});
