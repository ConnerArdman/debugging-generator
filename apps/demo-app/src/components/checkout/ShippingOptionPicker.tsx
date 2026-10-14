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
 * TWO QUESTIONS, TWO HOOKS, AND WHY THE ARGUMENTS ARE BARE STRINGS
 * `useShippingEta()` reads the dispatch promise the application's single clock publishes, which is
 * where the "ships today" half of each row's delivery line comes from. `useFreightQuote()` asks
 * what freight to the buyer's destination actually costs, and it keys that lookup on the
 * destination itself - the postal code and the country it is in, because the same code names a
 * different place in each country that writes codes that way, and the store quotes them
 * differently. Both arrive here as `string | null` and are handed on exactly as received, so a
 * re-render while the address fields stand still asks nothing further. Both hooks are called
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
 * every render, and what changes is its arguments - `null`, which is that hook's documented
 * "ask nothing" state. So exactly one `GET /api/shipping/quote` is in flight per destination
 * however this component is placed, and a panel placed with no `quote` behaves exactly as before.
 * The destination props are passed either way: a hoisted lookup takes the address from its holder,
 * and this panel still needs to know what the address is to caption an empty group.
 *
 * THE QUOTE IS THE LIST, AND THERE IS NO LIST WITHOUT ONE
 * The rows are the quote's services, at its prices and transit times, in the order it named them -
 * and there are no rows at all until a quote has settled. This component takes no list of services
 * to show in the meantime, and that is the point rather than an omission: freight is a property of
 * a destination, so a price beside a service name before the store has quoted a destination is a
 * figure nobody was quoted, and a *selectable, selected* one is an offer the order would never be
 * charged at. An empty group with a caption saying why is the honest rendering of "we have not
 * priced this yet"; three rows at list rates with the cheapest checked is not.
 *
 * Four consequences follow, and all four are deliberate: no destination, a lookup in flight, and a
 * lookup that failed all render no rows and a caption; a quote that names no service renders no
 * rows and says the store reaches that destination with nothing; a service the quote omits is not
 * on offer, however plainly the store sells it elsewhere; and a selection the caller is holding for
 * a service no current quote names shows as nothing checked, which is the caller's cue that a
 * choice has to be made again. A shipment the lookup refused as larger than one consignment has no
 * list either, and the caption says which figure has to change.
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
import { freightDestinationProblem, type FreightDestinationFault } from '@/lib/destination';
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

/**
 * Caption for a destination that could be quoted and has not been yet - the moment before the
 * lookup starts, and a caller that is holding the lookup back for a reason of its own.
 */
const AWAITING_QUOTE_CAPTION = 'Shipping services appear once this destination has been quoted.';

/**
 * What this group says about each way a destination can fail to be quotable.
 *
 * One line per fault, and every line is about *this group* - why there is nothing here to choose
 * from, and what will make services appear. That is deliberately not the sentence the destination
 * field shows. `@/lib/destination` words each fault for the control at fault, in full and with the
 * country's postal-code format; a group that printed that same sentence a hundred pixels below the
 * field would put one 137-character diagnosis on screen twice, and a buyer would read two problems
 * where there is one. So the field diagnoses the address and this group explains its own emptiness.
 *
 * The fault still decides which line it is, because the four are not interchangeable: an
 * unfinished code becomes quotable by carrying on typing, a code that country does not use never
 * will, and those are different things to tell somebody.
 */
const CAPTION_BY_DESTINATION_FAULT: Readonly<Record<FreightDestinationFault, string>> = {
  country: 'Shipping services appear once a country the warehouses ship to is chosen.',
  'postal-missing': AWAITING_DESTINATION_CAPTION,
  'postal-incomplete': 'Shipping services appear once the destination postal code is complete.',
  'postal-invalid': 'No shipping service can be quoted for this postal code.',
};

/** Caption when a destination was quoted and carried nothing the store can sell. */
const NO_SERVICE_CAPTION = 'No shipping service is available for this destination.';

/**
 * The empty offer, as one frozen array rather than a fresh `[]` per render - so a render that has
 * nothing to show gives a memoised child the same identity it had last time.
 */
const NO_SHIPPING_OPTIONS: readonly ShippingOption[] = [];

/**
 * The services this group may offer, which is a question about what the store has said rather than
 * about what the caller passed.
 *
 * There is one answer and it is short: the quote's services, and nothing when there is no quote. A
 * rate is a property of a destination rather than of a service, so until the store has quoted the
 * destination in the fields there is no honest price to put beside a service name - and a priced,
 * selectable row the store has not agreed to is worse than an empty group, because it is an offer
 * the order would never be charged at. That is also why a settled quote naming no service renders
 * no rows: it is the store saying it reaches that destination with nothing, which the caption
 * states in words.
 *
 * A shipment larger than one consignment was never quoted and cannot be, and is the same empty
 * list for a different reason the caption gives.
 *
 * The returned array is the quote's own rather than a copy of it: the rows are keyed and priced
 * from whichever list this returns, and rebuilding it per render would give a memoised parent
 * nothing to hold on to for no gain.
 *
 * @param quote The settled quote, or `null` when none has settled.
 * @param limit The shipment-size obstacle, or `null` when the shipment has none.
 * @returns The services to render, which may be empty.
 */
function offeredShippingOptions(
  quote: FreightQuoteState['quote'],
  limit: FreightShipmentLimit | null,
): readonly ShippingOption[] {
  if (limit !== null || quote === null) {
    return NO_SHIPPING_OPTIONS;
  }

  return quote.options;
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
 * The cases are ordered by what a reader has to do about them, and each one says what is actually
 * the matter rather than a guess dressed as advice - a group that tells a buyer to finish a postal
 * code they have already finished sends them to correct the one thing that was right.
 *
 * The shipment's size is said first and without qualification: no lookup was made for a shipment
 * larger than one consignment, so neither a waiting state nor a silent list is what a reader needs
 * to hear about - the count is, beside the count that would fit. A lookup in flight comes next,
 * because it explains both a list that is about to change and a list that is empty for the moment.
 * With services on screen and nothing in flight there is nothing to caption.
 *
 * Without services, the caption says which silence this is. A destination that cannot be quoted at
 * all reads from {@link CAPTION_BY_DESTINATION_FAULT}, keyed on the fault `@/lib/destination`
 * found, so the four ways an address can fail to be quotable read as the four different things
 * they are - while the address itself is diagnosed in full against the control at fault, by the
 * surface that owns that control. A quotable destination with no quote is a lookup that has not
 * run, which is a moment rather than a fault. And a settled quote with nothing in it is the store
 * saying it reaches that destination with nothing.
 *
 * @param quote The settled quote, or `null` when none has settled.
 * @param isQuoting Whether a freight lookup is in flight.
 * @param hasServices Whether there is at least one row to choose from.
 * @param destinationFault Which way the destination cannot be quoted, or `null` when it can.
 * @param limit The shipment-size obstacle, or `null` when the shipment has none.
 * @returns The caption wording, or `null`.
 */
function shippingCaption(
  quote: FreightQuoteState['quote'],
  isQuoting: boolean,
  hasServices: boolean,
  destinationFault: FreightDestinationFault | null,
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

  if (destinationFault !== null) {
    return CAPTION_BY_DESTINATION_FAULT[destinationFault];
  }

  return quote === null ? AWAITING_QUOTE_CAPTION : NO_SERVICE_CAPTION;
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
   * still to be filled in. Nothing is asked for a `null`, unfinished or malformed code.
   *
   * It is also what this group says about itself when there is nothing to choose from: paired with
   * `country` it is read through `@/lib/destination` for the caption, so the sentence under an
   * empty group names what is actually the matter with the address rather than asserting that it
   * is incomplete. A caller that hoists the lookup still passes it for that reason.
   *
   * @default null
   */
  postalCode?: string | null;

  /**
   * Which country that postal code is in, as its two-letter code, or `null` when nobody has said.
   *
   * The other half of the destination: it decides what a complete postal code looks like and it
   * changes the rate, so a group handed a code without a country can neither judge the address nor
   * be sure the rates beside it are the ones for it.
   *
   * @default null
   */
  country?: string | null;

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
   * Locks every row - an order being placed, a cart with nothing in it.
   *
   * The native attribute, on the `<fieldset>` and on every control inside it, so the keyboard
   * cannot reach a locked row, the stylesheet paints it from `:has(:disabled)`, and the group
   * announces the state: `aria-disabled` rides along on the group for a reader that queries the
   * container rather than the control it landed on. A locked group looks locked as well as being
   * locked - the rows dim - because a control that is inert and indistinguishable from an
   * interactive one is a control a buyer keeps clicking.
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
 * @example The ordinary case, where this panel performs the freight lookup itself. The rows are the
 * quote's services and there are none until it settles; a selection this panel's caller is holding
 * for a service the quote omits shows as nothing checked - so a caller reads the chosen service
 * back from the quote before it acts on it.
 * ```tsx
 * <ShippingOptionPicker
 *   selectedId={draft.shippingOptionId}
 *   onSelect={(optionId) => setDraft({ ...draft, shippingOptionId: optionId })}
 *   postalCode={draft.shippingAddress.postalCode}
 *   country={draft.shippingAddress.country}
 *   itemCount={cart.itemCount}
 *   disabled={submitting}
 * />
 * ```
 *
 * @example Inside the checkout form, which holds the lookup because it publishes the chosen rate to
 * the review column beside it. The shipment is described where the lookup is held, so this
 * placing passes no `itemCount`; the destination and the hoisted state describe one shipment.
 * ```tsx
 * const quote = useFreightQuote(destination, address.country, cart.itemCount);
 *
 * <ShippingOptionPicker
 *   selectedId={shippingOptionId}
 *   onSelect={setShippingOptionId}
 *   postalCode={destination}
 *   country={address.country}
 *   quote={quote}
 * />
 * ```
 */
export function ShippingOptionPicker({
  selectedId,
  onSelect,
  postalCode = null,
  country = null,
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
  const ownLookup = useFreightQuote(
    hoistedQuote === undefined ? postalCode : null,
    hoistedQuote === undefined ? country : null,
    itemCount,
  );
  const { quote, isQuoting, quoteError, shipmentLimit } = hoistedQuote ?? ownLookup;

  const dispatchNote = dispatchClause(eta);
  // Which way the address in the fields cannot be quoted, or `null` when it can - read from the
  // two destination props rather than from the lookup, so a group whose caller is holding the
  // lookup back still says the right thing about the address it was given. The judgement is
  // `@/lib/destination`'s, which is the module the lookup gates on and the one the checkout form
  // diagnoses the field with, so this group and that field cannot disagree about what is wrong;
  // only the fault is taken, because the wording here is about the group rather than the address.
  //
  // An empty field is read as `postal-missing` ahead of everything else. The module reports the
  // country first, which is right for a form - the country decides what a complete code is - but a
  // group with nothing written in the field at all has to say that no destination has been given,
  // not that no country has been chosen.
  const writtenDestination = postalCode === null ? '' : postalCode.trim();
  const destinationFault: FreightDestinationFault | null =
    writtenDestination.length === 0
      ? 'postal-missing'
      : (freightDestinationProblem(country ?? '', writtenDestination)?.fault ?? null);
  // What is on offer, and therefore what may be chosen: the store's answer, and nothing until it
  // has given one. See `offeredShippingOptions` and the header.
  const services = offeredShippingOptions(quote, shipmentLimit);
  const caption = shippingCaption(
    quote,
    isQuoting,
    services.length > 0,
    destinationFault,
    shipmentLimit,
  );

  return (
    <fieldset
      className={clsx(styles.root, className)}
      role="radiogroup"
      disabled={disabled}
      aria-disabled={disabled || undefined}
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
                    /*
                      Redundant beside the native attribute above and stated anyway. `disabled`
                      is what makes the control inert and is what a reader announces when it
                      lands on this radio; `aria-disabled` is what answers the same question of
                      the radio itself for anything inspecting the control rather than
                      traversing to it - the group carries it too, and neither is a substitute
                      for the other. `undefined` rather than `"false"` while interactive, so an
                      enabled control says nothing about a state it is not in.
                    */
                    aria-disabled={disabled || undefined}
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
