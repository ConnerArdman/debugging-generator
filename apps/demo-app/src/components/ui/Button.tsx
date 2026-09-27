/**
 * Button - the action primitive of the Lumen Supply storefront.
 *
 * Every deliberate press in this application is this one component: the primary action of a form,
 * the quantity steppers beside a line item, a destructive confirmation, and the dismiss control of
 * a transient notice. It is also the most consumed component in this folder, so its prop contract
 * is built to be complete rather than curated - it extends the native element instead of
 * re-declaring a hand-picked subset of it, and a caller therefore reaches for no escape hatch to
 * get `form`, `name`, `value`, `autoFocus`, an `aria-*` attribute, a `data-*` attribute or a `ref`.
 *
 * `type` DEFAULTS TO `'button'`, WHICH IS THE MOST IMPORTANT LINE IN THE FILE
 * An HTML `<button>` with no `type` is a submit button. A form on a checkout or cart surface holds
 * several controls that are not its submit button - a stepper, a "remove", a "use this address" -
 * and any one of them left at the implicit default would post the form when pressed. That is not a
 * styling nicety: it is a phantom request in the middle of an interaction, arriving from a control
 * nobody pressed to submit anything, and at the route handling it, it is indistinguishable from a
 * submission the shopper meant to make. So the attribute is always emitted, always explicitly, and
 * a submit button is the caller stating `type="submit"`.
 *
 * THE BUSY STATE IS TRUTHFUL, IT KEEPS FOCUS, AND IT IS NOT A LAYOUT EVENT
 * `busy` says that the request this control started has not finished. It refuses every activation
 * for the duration - a press, Enter, Space, and the implicit submission a form performs through
 * its submit button - so a second press cannot start a second request; it sets
 * `aria-disabled="true"` and `aria-busy="true"`, so the state a reader sees and the state a screen
 * reader can observe are the same fact; and it puts one `Spinner` before the label.
 *
 * What it deliberately does NOT do is write the native `disabled` attribute. The control going
 * busy is almost always the control the reader has just pressed, so it is the element holding
 * keyboard focus at that moment, and a `disabled` element cannot hold focus: the browser blurs it
 * and focus falls to `<body>`, outside any dialog the control sits in, so the next Tab starts from
 * the top of the document (WCAG 2.4.3). `aria-disabled` states the same unavailability to
 * assistive technology while the element stays focusable, and the refusal is made in the click
 * handler instead - `preventDefault()` and nothing else, so neither the caller's `onClick` nor a
 * form submission runs. Native `disabled` is written only when the caller passes `disabled`, which
 * means "not actionable at all" rather than "working", and is a state a reader does not arrive in
 * by pressing the control.
 *
 * The label stays mounted throughout - swapping it for the indicator would collapse the control to
 * the indicator's width mid-press, and the text the reader was about to re-read would vanish at
 * exactly the moment they are watching it.
 * Geometry is otherwise the stylesheet's, which declares padding and type size once per size and
 * never restates either in a state rule, so nothing here can change a control's height: a measured
 * toggle is 33px tall idle and busy alike. The indicator does add its own width - the ring plus the
 * flex gap, 21px at the default size - so a control whose width is constrained by its track keeps
 * every neighbour exactly where it was, while a free-standing one grows by that much rather than
 * shrinking. Growing is the safe direction: the label stays whole and legible either way.
 *
 * The indicator is decorative by contract (`Spinner` renders `aria-hidden`), which means the busy
 * state is carried to assistive technology by `aria-busy` - and the refusal by `aria-disabled` -
 * and by nothing else in here. A surface that wants the wait *announced* - naming what is in
 * flight - adds its own hidden status text beside the button, because only the caller knows what
 * the request is and how often it repeats. Colour is never the sole carrier of meaning: the dimming
 * always accompanies a real `disabled` attribute or a real `aria-disabled="true"`, which the
 * stylesheet paints alike, and a busy control always carries the indicator as well.
 *
 * APPEARANCE IS THREE DATA ATTRIBUTES, NOT A LOOKUP MAP
 * `Button.module.css` exports two classes - `.root` for the control, `.label` for the text that is
 * allowed to truncate - and selects everything else with `[data-variant]`, `[data-size]` and
 * `[data-busy]`. So the two variant props are forwarded straight into attributes: a class map would
 * have to be read through a computed key, which this repository's `noUncheckedIndexedAccess` types
 * as `string | undefined` and which hides a typo until the control renders unstyled in a browser.
 * An attribute is constrained by the unions below, is legible in the elements tree beside the class
 * it qualifies, and keeps every colour, space and type size in the stylesheet's `--ls-*` tokens
 * rather than in this file.
 *
 * DELIBERATELY NOT HERE
 * No `loading` alias for `busy`, no `as`/polymorphic prop, no icon prop and no link mode: an action
 * that navigates is a `<Link>` of the caller's, carrying the stylesheet's own class, and this module
 * exports no class for it either - the surface stays one component and one contract. No `style`
 * prop, no inline CSS, no DOM measurement and no effect, so there is nothing here to keep in step
 * with the stylesheet.
 *
 * No `'use client'` directive: the component holds no state and subscribes to nothing, so a server
 * component renders it as happily as a client one, and a caller that passes `onClick` already
 * carries its own client boundary. The busy refusal is the one handler this file attaches of its
 * own, and it is attached only while `busy` is true - a flag that describes a request in flight,
 * which only a client component can have - so an idle control rendered by a server component
 * carries no function prop at all. Nothing is read from `window`, `Date.now()` or `Math.random()`
 * while rendering, so the markup the server sends and the markup the browser first produces agree.
 */
import clsx from 'clsx';
import type { ComponentPropsWithRef, MouseEvent } from 'react';

import styles from './Button.module.css';
import { Spinner } from './Spinner';

/**
 * The control's own props, on top of everything a native `<button>` accepts.
 *
 * Extending `ComponentPropsWithRef<'button'>` rather than listing props by hand is what keeps the
 * consuming groups free of workarounds: `onClick`, `disabled`, `form`, `formAction`, `name`,
 * `value`, `autoFocus`, `aria-*`, `data-*` and `ref` all arrive without a line of code here, and
 * `ref` in particular needs no `forwardRef` because React 19 passes it as an ordinary prop.
 *
 * Only `className` is dropped from the inherited set and redeclared, so the composition in the
 * component below is the single route by which it is applied: the caller's classes are merged after
 * the module's `.root`, which means a caller adds to the control's appearance instead of replacing
 * it, and the merge has exactly one meaning.
 *
 * Kept local and unexported on purpose: a consumer that needs the type writes
 * `React.ComponentProps<typeof Button>` and stays correct no matter what is added here.
 */
interface Props extends Omit<ComponentPropsWithRef<'button'>, 'className'> {
  /**
   * Which of the stylesheet's four appearances to paint, by the action's weight rather than by its
   * colour: `'primary'` for the single most important action on a view, `'secondary'` for an action
   * of equal weight to its neighbours, `'ghost'` for a quiet one - a dismiss control, a stepper -
   * and `'danger'` for a destructive one.
   *
   * @default 'primary'
   */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';

  /**
   * Control density, taken from the type scale so the label sits optically right in its
   * surroundings: `'sm'` for a table row or a toolbar, `'md'` for ordinary page copy, `'lg'` for a
   * page's committing action. Padding and font size come from the stylesheet's rule for the value;
   * no state rule restates them, so a control never changes size while it is being used.
   *
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';

  /**
   * The action this control started is still in flight.
   *
   * Drives four things from one prop, so they cannot drift apart: every activation refused for the
   * duration (the caller's `onClick` is not called and a submit button does not submit),
   * `aria-disabled="true"`, `aria-busy="true"`, and the indicator before the label. The control
   * stays focusable throughout - see the header for why it never becomes natively `disabled` - so
   * the reader who pressed it is still standing on it when the request settles. It is deliberately
   * separate from `disabled`: a busy control is temporarily working, an unavailable one is not
   * actionable at all and is the only one that leaves the tab order.
   *
   * @default false
   */
  busy?: boolean;

  /** Additional classes, merged after `.root`. */
  className?: string;
}

/**
 * Refuses an activation that reaches a busy control.
 *
 * Module-level, so every busy control shares one function and no closure is created per render.
 * `preventDefault()` on the click is what cancels a submit button's form submission - including the
 * implicit one a browser performs by clicking a form's default button when Enter is pressed in one
 * of its fields - and not calling the caller's `onClick` is what stops every other kind of action.
 * Propagation is left alone: an ancestor listening for clicks still sees a click happen, exactly as
 * it would for any other control the reader pressed.
 */
function refuseBusyActivation(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

/**
 * Renders the control.
 *
 * `variant` and `size` become data attributes; `busy` becomes `aria-disabled`, `aria-busy` and
 * `data-busy`, using `undefined` rather than `'false'` so an idle control leaves no attribute behind
 * at all and the rendered markup reads the same way as the stylesheet's `[aria-disabled='true']`
 * and `[data-busy='true']` selectors. While busy, the click handler is {@link refuseBusyActivation}
 * in place of the caller's; idle, it is the caller's own, untouched - including no handler at all.
 *
 * `styles.root` and `styles.label` are typed `string | undefined` under `noUncheckedIndexedAccess`,
 * which `clsx` drops where a template string would interpolate the word "undefined" into the
 * attribute - which is why this is `clsx` and not concatenation, and why no non-null assertion is
 * needed anywhere in the file.
 *
 * @example An ordinary action inside a form. It does not submit, because `type` defaults to
 * `'button'`, and the native attributes it needs are simply passed through.
 * ```tsx
 * <Button variant="ghost" size="sm" aria-label="Remove line" onClick={onRemove}>
 *   Remove
 * </Button>
 * ```
 *
 * @example A form's committing action, held while its request runs. The caller owns the flag and
 * announces the wait; the control shows it and refuses a second press.
 * ```tsx
 * <Button type="submit" size="lg" busy={submitting}>
 *   Submit
 * </Button>
 * <p role="status">{submitting ? <VisuallyHidden>Submitting</VisuallyHidden> : null}</p>
 * ```
 */
export function Button({
  variant = 'primary',
  size = 'md',
  busy = false,
  type = 'button',
  disabled,
  onClick,
  className,
  children,
  ...rest
}: Props) {
  // Ordering: `type`, `disabled`, `onClick`, `className` and `children` are destructured above, so
  // `{...rest}` cannot contain them and spreading it last cannot defeat the explicit `type`, the
  // busy refusal or the class composition. What it can still override is a derived `aria-*` or
  // `data-*` attribute, which is the intended escape hatch - a control that needs finer ARIA than a
  // boolean can state it and have it survive.
  //
  // `disabled` is the caller's alone: `busy` never writes it, because the busy control is the one
  // holding focus and a natively disabled element drops it to `<body>` (see the header).
  return (
    <button
      type={type}
      disabled={disabled === true}
      aria-disabled={busy ? 'true' : undefined}
      aria-busy={busy ? 'true' : undefined}
      data-variant={variant}
      data-size={size}
      data-busy={busy ? 'true' : undefined}
      className={clsx(styles.root, className)}
      onClick={busy ? refuseBusyActivation : onClick}
      {...rest}
    >
      {busy ? <Spinner size={size === 'lg' ? 'md' : 'sm'} /> : null}
      <span className={styles.label}>{children}</span>
    </button>
  );
}
