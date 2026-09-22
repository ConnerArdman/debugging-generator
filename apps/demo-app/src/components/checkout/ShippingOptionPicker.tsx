'use client';

/*
 * ShippingOptionPicker - how a buyer says what an order ships by.
 *
 * The shipping panel of the checkout page is this one control: the services the store can sell for
 * this order, each with what it costs and when it lands, and exactly one of them chosen. It takes
 * props and returns markup. `CheckoutForm` owns the draft - including `shippingOptionId` - and
 * this module holds no copy of it, because a chooser with its own idea of the selection is a
 * chooser that eventually disagrees with the order being placed.
 *
 * A NATIVE RADIO GROUP, NOT SOMETHING SIMULATING ONE
 * A `<fieldset>` with a real `<legend>` and one `<input type="radio">` per service, all sharing a
 * `name`. That is the whole widget, and it is deliberately not a listbox, a set of buttons or a
 * `<select>`: arrow-key navigation between the services, roving focus, the announced "2 of 4"
 * position and the announced checked state are all behaviour the browser already has for this
 * markup and that any re-implementation would have to earn back. Nothing here hides, shrinks or
 * replaces the control, no element juggles `tabIndex`, and the selected row is painted by the
 * stylesheet's `:has(:checked)` over that real input rather than by a class this component toggles.
 *
 * `@/components/ui/Select` lists the checkout shipping option among its uses, and this panel
 * deliberately diverges: four services with a price and a delivery promise each are a comparison,
 * and a collapsed dropdown hides three of the four while the buyer is making it. `Select` stays the
 * right primitive for the form's genuine dropdowns - country, region.
 *
 * TWO QUESTIONS, TWO HOOKS, AND WHY THE ARGUMENT IS A BARE STRING
 * `useShippingEta()` reads the dispatch promise the application's single clock publishes, which is
 * where the "ships today" half of each row's delivery line comes from. `useFreightQuote()` asks
 * what freight to the buyer's destination actually costs, and it keys that lookup on the postal
 * code itself: the code arrives here as a `string | null` and is handed on exactly as received, so
 * a re-render while the address field stands still asks nothing further. Both hooks are called
 * unconditionally at the top of the component, and this module adds no effect, no state and no
 * request of its own - `GET /api/shipping/quote` is reached through that hook and nowhere else.
 *
 * THE LOOKUP CAN BE HOISTED, AND IS NEVER PERFORMED TWICE
 * The rate this panel prints beside a service is also the rate the order being placed is charged,
 * so a surface that has to quote the same figure elsewhere - the checkout page's review column
 * reads it from the form - must be able to hold the lookup itself rather than watch this component
 * hold a second one. That is the `quote` prop: given one, this panel renders from it and asks for
 * nothing, and the caller's `useFreightQuote()` is the only lookup on the page. It is not a
 * conditional hook, which `react-hooks/rules-of-hooks` forbids and which would break the moment a
 * caller passed the prop on one render and omitted it on the next: the hook is still called on
 * every render, and what changes is its argument - `null`, which is that hook's documented
 * "ask nothing" state. So exactly one `GET /api/shipping/quote` is in flight per destination
 * however this component is placed, and a panel placed with no `quote` behaves exactly as before.
 *
 * WHAT A QUOTE CHANGES: IT BECOMES THE LIST
 * Until a quote arrives the rows are the `options` prop - the store's services at their list rates,
 * which is the most that can honestly be shown for a destination nobody has named yet. Once a quote
 * settles it *replaces* that list: the services it names, at its prices and transit times, in the
 * order it named them. That is not a refinement of the prop, it is the answer to the question the
 * prop was standing in for, and treating it as anything less is how a service the store cannot sell
 * to this destination stays on screen as though it could. Three consequences follow, and all three
 * are deliberate: a quote that names no service renders no rows and says so; a service the quote
 * omits disappears rather than reverting to its list rate; and a selection the caller is holding for
 * an omitted service shows as nothing checked, which is the caller's cue that a choice has to be
 * made again. A shipment the lookup refused as larger than one consignment has no list at all, and
 * the caption says which figure has to change.
 *
 * RENDER BEHAVIOUR
 * A plain function component: no `memo`, no ref, no timer, nothing read from `window`, `Date.now()`
 * or a source of randomness while rendering. Every id it writes is derived from a literal prefix
 * and an option id rather than from `useId`, and the one value that starts out unknown - the
 * dispatch clock's first reading - is absent from the markup on both sides until it arrives, so the
 * markup the server sends and the markup the browser first produces agree.
 */

import clsx from 'clsx';

import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Price } from '@/components/ui/Price';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import {
  useFreightQuote,
  useShippingEta,
  type DispatchEta,
  type FreightQuoteState,
  type FreightShipmentLimit,
} from '@/hooks/useShippingEta';
import { formatQuantityLabel, formatShippingEtaLabel } from '@/lib/format';
import type { ShippingOption } from '@/lib/types';

import styles from './ShippingOptionPicker.module.css';

/**
 * The `name` every radio in the group shares, which is what makes them one group to the browser and
 * to the keyboard. It is the field name `CheckoutDraft` sends back, so a native submission of the
 * enclosing form posts the chosen service under the name the order is assembled from.
 */
const GROUP_FIELD_NAME = 'shippingOptionId';

/** Literal prefix of each row's input `id`; the option's own id completes it. */
const OPTION_ID_PREFIX = 'shipping-option';

/** The group's one caption element, referenced by the fieldset's `aria-describedby`. */
const CAPTION_ID = 'shipping-option-caption';

/** Heading of the group, and its accessible name, unless the caller words it differently. */
const DEFAULT_LEGEND = 'Shipping method';

/** Joins the clauses of a row's delivery line. */
const DETAIL_SEPARATOR = ' · ';

/** Names the delivery line for a reader who hears it without seeing the row it sits in. */
const DELIVERY_PREFIX = 'Estimated delivery: ';

/** The dispatch clause, once the shared clock has been read: today's collection is still open. */
const DISPATCH_TODAY = 'Ships today';

/** The dispatch clause when today's collection has closed. */
const DISPATCH_NEXT_DAY = 'Ships next business day';

/** The marker beside the caption while a lookup is in flight. */
const QUOTING_BADGE_LABEL = 'Updating';

/** Caption while freight to the destination is being quoted. */
const QUOTING_CAPTION = 'Shipping services are being quoted for this destination.';

/** Caption when there is no destination to quote for yet. */
const AWAITING_DESTINATION_CAPTION =
  'Shipping services appear once a destination postal code is entered.';

/** Caption when a destination was quoted and carried nothing the store can sell. */
const NO_SERVICE_CAPTION = 'No shipping service is available for this destination.';

/**
 * The services this group may offer, which is a question about what the store has said rather than
 * about what the caller passed.
 *
 * Three states, in the order they settle. A shipment larger than one consignment was never quoted
 * and cannot be: nothing is on offer for it, so the list is empty and the caption explains the
 * size. A settled quote is the store's answer for the destination and shipment asked about, so its
 * services *are* the services - including when it names none, which is a destination with nothing
 * on offer rather than a reason to show rates the store has not agreed to. Only before a quote has
 * settled - no destination yet, a lookup in flight, a lookup that failed - is the caller's list what
 * there is to show, and it is shown at its list rates because nothing better is known.
 *
 * The returned array is one of the inputs rather than a copy of it: the rows are keyed and priced
 * from whichever list this returns, and rebuilding it per render would give a memoised parent
 * nothing to hold on to for no gain.
 *
 * @param options The caller's list, offered until a quote settles.
 * @param quote The settled quote, or `null` when none has.
 * @param limit The shipment-size obstacle, or `null` when the shipment has none.
 * @returns The services to render, which may be empty.
 */
function offeredShippingOptions(
  options: readonly ShippingOption[],
  quote: FreightQuoteState['quote'],
  limit: FreightShipmentLimit | null,
): readonly ShippingOption[] {
  if (limit !== null) {
    return [];
  }

  return quote === null ? options : quote.options;
}

/**
 * The dispatch clause each row's delivery line ends with, or `null` when there is nothing to say
 * yet.
 *
 * `msUntilCutoff` is `null` until the shared clock has been read once, which is also the state the
 * server rendered, so an absent clause is what keeps the first client markup identical to it. No
 * clock is read here: the published promise is the only source for the cut-off, so every surface of
 * the storefront quotes the same one.
 *
 * @param eta The dispatch promise as published.
 * @returns The clause, or `null` before the first reading.
 */
function dispatchClause(eta: DispatchEta): string | null {
  if (eta.msUntilCutoff === null) {
    return null;
  }

  return eta.beforeCutoff ? DISPATCH_TODAY : DISPATCH_NEXT_DAY;
}

/**
 * The group's single caption, or `null` when the rows speak for themselves.
 *
 * The shipment's size is said first and without qualification: no lookup was made for a shipment
 * larger than one consignment, so neither a waiting state nor a silent list is what a reader needs
 * to hear about - the count is, beside the count that would fit. A lookup in flight comes next,
 * because it explains both a list that is about to change and a list that is empty for the moment.
 * With services on screen and nothing in flight there is nothing to caption. Without services the
 * caption says which of the two silences this is: no destination has been given, or one was and
 * nothing came back for it - which, after a settled quote, is the store saying it reaches that
 * destination with nothing.
 *
 * @param isQuoting Whether a freight lookup is in flight.
 * @param hasServices Whether there is at least one row to choose from.
 * @param hasDestination Whether the caller has passed a destination at all.
 * @param limit The shipment-size obstacle, or `null` when the shipment has none.
 * @returns The caption wording, or `null`.
 */
function shippingCaption(
  isQuoting: boolean,
  hasServices: boolean,
  hasDestination: boolean,
  limit: FreightShipmentLimit | null,
): string | null {
  if (limit !== null) {
    return (
      `A shipment carries at most ${formatQuantityLabel(limit.maxUnits)} units, and this order has ` +
      `${formatQuantityLabel(limit.units)}, so there is nothing to quote for it.`
    );
  }

  if (isQuoting) {
    return QUOTING_CAPTION;
  }

  if (hasServices) {
    return null;
  }

  return hasDestination ? NO_SERVICE_CAPTION : AWAITING_DESTINATION_CAPTION;
}

/**
 * The picker's inputs.
 *
 * Local and deliberately unexported, like every other props shape in this component group: a
 * consumer that needs the type reads it back with `React.ComponentProps<typeof
 * ShippingOptionPicker>` and stays correct whatever is added here.
 */
interface Props {
  /**
   * The services to show until the store has quoted the destination, in the order they should be
   * read. Supplied by the form or the page, never fetched here, and `readonly` because this
   * component only reads them.
   *
   * They are a starting point rather than the offer: a settled quote replaces them entirely, since
   * the store's answer for a destination is what can be sold to it (see the header). An empty list
   * is a legitimate state - no destination yet, or none that can be served - and is captioned
   * rather than rendered as an empty box.
   */
  options: readonly ShippingOption[];

  /**
   * The chosen service's id, or `null` while nothing is chosen.
   *
   * Required and never defaulted: the selection belongs to the checkout draft, and a picker that
   * assumed one would show a service as chosen that the order is not being placed with.
   */
  selectedId: string | null;

  /**
   * Called with the id of the service the buyer chose. The only way the selection changes: this
   * component writes no state of its own, so what is checked on screen is whatever the caller
   * passes back as `selectedId`.
   */
  onSelect: (optionId: string) => void;

  /**
   * Where the order is going, passed straight to the freight lookup, or `null` when the address is
   * still to be filled in. Nothing is asked for a `null` or half-typed code.
   *
   * @default null
   */
  postalCode?: string | null;

  /**
   * How many units the shipment carries, passed straight to the freight lookup, or `null` when
   * there is nothing to describe yet.
   *
   * It belongs in the question because freight is charged per piece: a lookup that names only a
   * destination is answered for a single unit, and the rows would then price a shipment nobody is
   * sending. A caller that hoists the lookup (see `quote`) names the shipment there instead, and
   * this prop is then unused.
   *
   * @default null
   */
  itemCount?: number | null;

  /**
   * The freight lookup, hoisted to a caller that has to quote the same figures elsewhere; omitted,
   * this component performs the lookup itself.
   *
   * Pass the whole {@link FreightQuoteState} a caller's own `useFreightQuote()` returned - the
   * services, the in-flight flag, the failure wording and the shipment-size obstacle - and this
   * panel renders from it and asks `GET /api/shipping/quote` for nothing, so the caller's lookup is
   * the page's only one. The caller is then responsible for quoting the destination *and the
   * shipment* this panel was given: a state quoted for a different postal code would price these
   * rows for an address nobody is shipping to, and one quoted for a different unit count would
   * price a shipment nobody is sending.
   *
   * It spells `| undefined` out because absent and present-but-undefined have to mean the same
   * thing here - both are "no hoisted lookup, do it yourself" - and `exactOptionalPropertyTypes`
   * would otherwise reject the second from a caller that resolves the value conditionally.
   */
  quote?: FreightQuoteState | undefined;

  /**
   * The group's visible heading, which a `<legend>` also makes its accessible name.
   *
   * @default 'Shipping method'
   */
  legend?: string;

  /**
   * Locks every row - an order being placed, a cart with nothing in it. The native attribute, so
   * the keyboard cannot reach a locked row and the stylesheet can paint it from `:has(:disabled)`.
   *
   * @default false
   */
  disabled?: boolean;

  /**
   * An extra class from the surrounding layout, composed after the module's own root class.
   *
   * Compose it with `clsx` at the call site: a CSS Module lookup is typed `string | undefined` under
   * `noUncheckedIndexedAccess`, and this workspace compiles with `exactOptionalPropertyTypes`, which
   * rejects a present-but-undefined value here.
   */
  className?: string;
}

/**
 * Render the shipping-method group.
 *
 * The rows are `<li>` elements each wrapping a `<label>`, and the label holds exactly three
 * children - the control, the text block, the amount - because the stylesheet repeats the row's
 * three columns inside it with `grid-template-columns: subgrid`. A fourth child would start a
 * second row, which is why text meant only for assistive technology lives inside the text block
 * rather than beside the amount.
 *
 * The text block is a `<span>` rather than the `<div>` the stylesheet's markup sketch names: a
 * `<label>` takes phrasing content, and `display: flex` on a span gives the same column.
 *
 * Every class list goes through `clsx`, which drops an absent class where a template string would
 * write the word "undefined" into the attribute, and no non-null assertion appears anywhere here.
 * `Price` declares `className?: string | undefined`, so its class is passed as it is read.
 *
 * The group says at most one thing about itself, in the stylesheet's single caption: a shipment too
 * large to quote, the lookup while it runs, or which of the two silences an empty list is. One
 * element, one stable id, and the fieldset points `aria-describedby` at it only when it is in the
 * document - so the attribute never names an element that is not there, and a group whose rows
 * speak for themselves carries no description at all.
 *
 * A failed lookup is rendered through `@/components/ui/Alert` rather than as the stylesheet's
 * typographic line, because it arrives after the buyer has typed and has to be announced: the
 * `danger` tone is what gives it `role="alert"`. The module's `.notice` class rides along for the
 * placement the alert cannot know about; the two agree on type size, and the alert paints its own
 * text colour.
 *
 * @example The ordinary case, where this panel performs the freight lookup itself. `services` is
 * what the rows show until that lookup settles; after it, the quote's own services are the rows,
 * and a selection this panel's caller is holding for a service the quote omits shows as nothing
 * checked - so a caller reads the chosen service back from the quote before it acts on it.
 * ```tsx
 * <ShippingOptionPicker
 *   options={services}
 *   selectedId={draft.shippingOptionId}
 *   onSelect={(optionId) => setDraft({ ...draft, shippingOptionId: optionId })}
 *   postalCode={draft.shippingAddress.postalCode}
 *   itemCount={cart.itemCount}
 *   disabled={submitting}
 * />
 * ```
 *
 * @example Inside the checkout form, which holds the lookup because it publishes the chosen rate to
 * the review column beside it. The shipment is described where the lookup is held, so this
 * placing passes no `itemCount`; the destination and the hoisted state describe one shipment.
 * ```tsx
 * const quote = useFreightQuote(destination, cart.itemCount);
 *
 * <ShippingOptionPicker
 *   options={services}
 *   selectedId={shippingOptionId}
 *   onSelect={setShippingOptionId}
 *   postalCode={destination}
 *   quote={quote}
 * />
 * ```
 */
export function ShippingOptionPicker({
  options,
  selectedId,
  onSelect,
  postalCode = null,
  itemCount = null,
  quote: hoistedQuote,
  legend = DEFAULT_LEGEND,
  disabled = false,
  className,
}: Props) {
  const eta = useShippingEta();
  // Unconditional, as the rules of hooks require, and asked nothing at all when a caller hoisted
  // the lookup: `null` is this hook's documented no-request state, so the page never holds two
  // lookups for one shipment. The unit count travels with the destination, because freight is
  // charged per piece and a lookup named for an address alone is answered for one unit. See the
  // header.
  const ownLookup = useFreightQuote(hoistedQuote === undefined ? postalCode : null, itemCount);
  const { quote, isQuoting, quoteError, shipmentLimit } = hoistedQuote ?? ownLookup;

  const dispatchNote = dispatchClause(eta);
  // Whether the buyer has written a destination at all, which is a question about the field rather
  // than about the address: what makes a postal code servable is the quote endpoint's to judge, and
  // a second opinion here would go stale the first time the store shipped somewhere new.
  const hasDestination = postalCode !== null && postalCode.trim().length > 0;
  // What is on offer, and therefore what may be chosen - the store's answer once it has given one,
  // and the caller's list only until then. See `offeredShippingOptions` and the header. A caller
  // that resolved the same question for itself passes the list this returns, so the derivation is
  // idempotent and the two surfaces cannot disagree about which services exist.
  const services = offeredShippingOptions(options, quote, shipmentLimit);
  const caption = shippingCaption(isQuoting, services.length > 0, hasDestination, shipmentLimit);

  return (
    <fieldset
      className={clsx(styles.root, className)}
      role="radiogroup"
      aria-describedby={caption === null ? undefined : CAPTION_ID}
    >
      <legend className={styles.legend}>{legend}</legend>

      {services.length === 0 ? null : (
        <ul className={styles.list}>
          {services.map((option) => {
            const delivery = [formatShippingEtaLabel(option.estimatedDays), dispatchNote]
              .filter((clause): clause is string => clause !== null)
              .join(DETAIL_SEPARATOR);
            const optionInputId = `${OPTION_ID_PREFIX}-${option.id}`;

            return (
              <li key={option.id} className={styles.option}>
                <label htmlFor={optionInputId}>
                  <input
                    className={clsx(styles.control)}
                    type="radio"
                    id={optionInputId}
                    name={GROUP_FIELD_NAME}
                    value={option.id}
                    checked={selectedId === option.id}
                    disabled={disabled}
                    onChange={() => {
                      onSelect(option.id);
                    }}
                  />

                  <span className={clsx(styles.body)}>
                    <span className={clsx(styles.name)}>{option.label}</span>
                    <span className={clsx(styles.detail)}>
                      <VisuallyHidden>{DELIVERY_PREFIX}</VisuallyHidden>
                      {delivery}
                    </span>
                  </span>

                  <Price cents={option.priceCents} className={styles.price} />
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {caption === null ? null : (
        <p className={clsx(styles.quoting)} id={CAPTION_ID}>
          {isQuoting ? (
            <Badge tone="info" size="sm">
              {QUOTING_BADGE_LABEL}
            </Badge>
          ) : null}
          {caption}
        </p>
      )}

      {quoteError === null ? null : (
        <Alert tone="danger" className={clsx(styles.notice)}>
          {quoteError}
        </Alert>
      )}
    </fieldset>
  );
}
