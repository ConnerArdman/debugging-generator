'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

/**
 * Lumen Supply - the storefront's notification queue.
 *
 * Adding a line to the cart, placing an order, or an API call that came back
 * unhappy all need to tell the buyer something short without taking over the
 * page. This provider owns that queue and nothing else: it holds the notices,
 * publishes the three operations that change them, and retires each notice
 * once its own deadline passes.
 *
 * The queue is short on purpose: it never holds more than `TOAST_QUEUE_LIMIT`
 * notices at once. A busy moment - a cart whose lines are each turned down by
 * the stock check in turn - leaves the buyer with the newest few to read,
 * rather than a stack that covers the page they are on and a screen reader
 * working through a backlog of messages they can no longer act on.
 *
 * It contributes no markup of its own. The visible corner region belongs to
 * `@/components/ui/ToastViewport`, which reads this context and is mounted
 * once by the root layout, so a notice raised anywhere in the application
 * appears in the same place, styled the same way, and is announced once.
 *
 * Nothing here talks to the network or to the database: a notice is a local
 * statement about something that already happened elsewhere.
 */

/** How a notice is coloured, iconified and announced by the viewport. */
export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

/** A notice currently held in the queue. */
export interface StoreToast {
  /** Unique within the queue; the viewport uses it as its list key. */
  readonly id: string;
  readonly tone: ToastTone;
  /** The headline. Always present, and kept to a few words. */
  readonly title: string;
  /** Optional detail line. Absent - never an empty string - when unused. */
  readonly body?: string;
  /** Epoch milliseconds from which the notice retires itself. */
  readonly expiresAt: number;
}

/**
 * What a caller hands to `showToast`. `tone` falls back to `'info'` and
 * `autoDismissMs` to the lifetime the provider was mounted with, so the
 * shortest useful call is `showToast({ title: 'Added to cart' })`.
 *
 * A caller that wants a notice to stay until the buyer dismisses it is not
 * served by a very large `autoDismissMs`; it keeps the id `showToast` returned
 * and calls `dismissToast` when the work it describes is finished.
 */
export interface ToastInput {
  readonly tone?: ToastTone;
  readonly title: string;
  readonly body?: string;
  /** Lifetime for this notice alone, in milliseconds. Clamped at zero. */
  readonly autoDismissMs?: number;
}

/** The queue and its operations, as published on the context. */
export interface ToastCenter {
  /**
   * Oldest notice first, which is the order the viewport lists them in, and
   * never more than `TOAST_QUEUE_LIMIT` of them: past that, the newest
   * notices are the ones the buyer is left with.
   */
  readonly toasts: readonly StoreToast[];
  /** Queues a notice and returns the id it was given. */
  readonly showToast: (input: ToastInput) => string;
  /**
   * Retires one notice early. An id that is no longer queued is ignored,
   * whether it retired on its own deadline or newer notices took its place.
   */
  readonly dismissToast: (id: string) => void;
  /** Empties the queue, for a route change that makes every notice stale. */
  readonly clearToasts: () => void;
}

export interface ToastProviderProps {
  readonly children: ReactNode;
  /** Lifetime for notices that do not ask for one, in milliseconds. */
  readonly autoDismissMs?: number;
}

/** The lifetime a notice gets when neither the caller nor the mount says. */
export const TOAST_AUTO_DISMISS_MS: number = 5000;

/**
 * The most notices the queue holds at once. Four stack in the corner without
 * reaching across the page the buyer is reading, and once a fifth arrives the
 * newest four are the ones kept: the notice that has been on screen longest
 * makes room for the one describing what just happened. The value has to be
 * at least 1, or a notice would have nowhere to be shown at all.
 */
export const TOAST_QUEUE_LIMIT: number = 4;

/**
 * The published queue, or `null` outside a `<ToastProvider>` - which is the
 * case `useToastCenter` turns into an error.
 */
export const ToastCenterContext = createContext<ToastCenter | null>(null);

/**
 * Reads the notification queue.
 *
 * Throws when called outside `<ToastProvider>`. A silent no-op would leave the
 * caller believing the buyer had been told something, which is worse than a
 * loud failure the first time the component is mounted in the wrong place.
 */
export function useToastCenter(): ToastCenter {
  const center = useContext(ToastCenterContext);

  if (center === null) {
    throw new Error(
      'useToastCenter must be called from a component inside <ToastProvider>. ' +
        'The root layout mounts the provider around the whole application.',
    );
  }

  return center;
}

/**
 * Mounts the notification queue for the application. The root layout wraps the
 * site chrome in it once; no other component needs to. It subscribes to no
 * other context, so its position among the other providers is free.
 */
export function ToastProvider({
  children,
  autoDismissMs = TOAST_AUTO_DISMISS_MS,
}: ToastProviderProps): ReactElement {
  const [toasts, setToasts] = useState<readonly StoreToast[]>([]);

  // Ids are handed out by a counter rather than drawn from a clock or a random
  // source, so the same sequence of calls always produces the same ids. The
  // counter only ever moves inside `showToast`.
  const lastToastNumber = useRef<number>(0);

  const showToast = useCallback(
    (input: ToastInput): string => {
      lastToastNumber.current += 1;
      const id = `ls-toast-${lastToastNumber.current}`;
      const noticeLifetimeMs = Math.max(0, input.autoDismissMs ?? autoDismissMs);
      const queued: StoreToast = {
        id,
        tone: input.tone ?? 'info',
        title: input.title,
        // Spread rather than assign: `body` is absent when the caller omitted
        // it, so the viewport has no empty detail line to lay out.
        ...(input.body === undefined ? {} : { body: input.body }),
        expiresAt: Date.now() + noticeLifetimeMs,
      };

      setToasts((current) => {
        const queue = [...current, queued];

        // The queue is read oldest first, so the notices that make room are
        // taken off the front: what stays is the newest `TOAST_QUEUE_LIMIT`,
        // in the order they were raised. A notice dropped this way is gone
        // exactly as if its deadline had passed - its deadline no longer
        // matters, and `dismissToast` on its id finds nothing to retire.
        return queue.length <= TOAST_QUEUE_LIMIT
          ? queue
          : queue.slice(queue.length - TOAST_QUEUE_LIMIT);
      });

      return id;
    },
    [autoDismissMs],
  );

  const dismissToast = useCallback((id: string): void => {
    setToasts((current) => {
      const remaining = current.filter((toast) => toast.id !== id);

      // An id that already retired itself, or whose notice newer ones pushed
      // out of the queue, leaves the queue exactly as it was.
      return remaining.length === current.length ? current : remaining;
    });
  }, []);

  const clearToasts = useCallback((): void => {
    setToasts((current) => (current.length === 0 ? current : []));
  }, []);

  // One timer for the whole queue, armed for the notice that retires next. A
  // notice queued while it is running either retires later - the timer already
  // scheduled still fires first - or sooner, in which case the queue changed
  // and this runs again with the nearer deadline.
  useEffect(() => {
    const noticeDueAt = toasts.reduce<number | null>(
      (soonest, toast) =>
        soonest === null || toast.expiresAt < soonest ? toast.expiresAt : soonest,
      null,
    );

    if (noticeDueAt === null) {
      return undefined;
    }

    const handle: ReturnType<typeof setTimeout> = setTimeout(
      () => {
        // Retire by the deadline the timer was armed for, not by a fresh clock
        // reading: every notice due at `noticeDueAt` goes, including the one that
        // armed it, so the queue always gets shorter here.
        setToasts((current) => current.filter((toast) => toast.expiresAt > noticeDueAt));
      },
      Math.max(0, noticeDueAt - Date.now()),
    );

    return () => {
      clearTimeout(handle);
    };
  }, [toasts]);

  const value = useMemo<ToastCenter>(
    () => ({ toasts, showToast, dismissToast, clearToasts }),
    [toasts, showToast, dismissToast, clearToasts],
  );

  return <ToastCenterContext.Provider value={value}>{children}</ToastCenterContext.Provider>;
}
