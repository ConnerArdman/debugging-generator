'use client';

/*
 * CheckoutForm - where a Lumen Supply order is completed.
 *
 * `app/checkout/page.tsx` lays this form out beside the order summary, and it owns everything
 * between the buyer's first keystroke and the receipt: the contact details, the destination, the
 * chosen freight service, the delivery note, the inline validation of all of them, the single
 * request that turns the cart into an order, and the two outcomes that request has.
 *
 * Six decisions shape the whole file.
 *
 *   1. THE FIELDS BELONG HERE, THE CONTROLS DO NOT. Every control is a primitive from
 *      `@/components/ui` inside a `FormField`, which owns the label, the hint, the message and the
 *      `aria-describedby` wiring; the two composite blocks - the freight picker and the
 *      place-order control - are siblings in this folder, and the receipt is a third. This module
 *      therefore holds state, assembles the request and arranges the groups, and it draws nothing
 *      itself beyond the layout `CheckoutForm.module.css` describes.
 *
 *   2. THE REQUEST SHAPE IS `CheckoutDraft`, MIRRORED AND NEVER IMPORTED FROM THE SERVER. The
 *      schema that parses `POST /api/checkout` belongs to the storefront's server-only validation
 *      layer, which a component running in a browser may not import. The draft below is built
 *      field for field against the `CheckoutDraft` DTO in `@/lib/types` instead - contact,
 *      destination, chosen service, note - and it carries no cart identifier, because the DTO
 *      declares none: the
 *      cart belongs to the browser's session and the server resolves it from the storefront's own
 *      cookie, which `credentials: 'same-origin'` in `@/lib/api-client` is what sends.
 *
 *   3. THE SUBMIT PATH IS AS THIN AS A SUBMIT PATH CAN BE, AND WHAT IT ADDS IS ALL ABOUT THE
 *      ORDER OUTLIVING THIS COMPONENT. `submitOrder` validates once - or, resolving an attempt,
 *      takes the draft that attempt recorded - awaits one call to `submitCheckout`, and stores what
 *      came back. It holds no timer, no retry, no second request and no measurement of its own:
 *      the request's duration is the server's to explain, and a client-side stopwatch would only
 *      describe the wait it cannot shorten. A failure keeps every value the buyer typed, so placing
 *      the order again is one click rather than a re-typed form. Three things ride alongside that
 *      single request, and each is there because this component cannot promise to be here when the
 *      reply arrives: the request carries an `AbortSignal` this form aborts when it unmounts, the
 *      attempt - its name and the exact draft sent - is written to session storage before it goes
 *      out, replaced with the order's reference alone when it lands and forgotten once that order's
 *      receipt is on screen, and a placed order is given an address of its own with
 *      `history.pushState`, which `app/checkout/page.tsx` answers with the same receipt on every
 *      later visit. `POST /api/checkout` stops for none of it - a buyer who navigates away is still
 *      charged - so an abandoned attempt is treated as an outcome nobody established rather than as
 *      a cancelled order.
 *
 *   4. THE FORM SAYS WHAT IT KNOWS AND NOT WHAT IT WOULD PREFER. Two of the things a buyer
 *      reads here are statements about their money, and neither may be guessed. A failure is
 *      described as "nothing was charged" only where the store said which reason applied and
 *      that reason means nothing was captured, or where nothing was sent at all: the form asks
 *      the browser for a connection before it sends, and a submission made with none is held
 *      back rather than sent to fail. Every reason the store did not author - a reply that could
 *      not be read, a status this page read a meaning into, a request that came back with no reply
 *      at all - leaves the order unconfirmed, because a rejected request cannot say whether it
 *      arrived, and what the buyer is offered then is to check the order rather than to place it
 *      again. That check is the very draft the attempt recorded, sent again under the same attempt
 *      name, which the endpoint answers with the order it already holds instead of a second one -
 *      so the safe action and the retry are one control, and it works after a reload exactly as it
 *      does before one. And the cart: a cart that could not be read is not an empty cart, so its
 *      totals are withheld rather than printed as zero.
 *
 *   5. THE CHOSEN FREIGHT CHARGE IS OWNED HERE AND PUBLISHED FROM HERE. The buyer chooses a
 *      service in the group below, and the review column beside this form has to quote what that
 *      service costs - the two are siblings on `/checkout`, so the figure has to travel. This form
 *      is where it can: it already owns `shippingOptionId`, so it holds the freight lookup as well
 *      (`useFreightQuote`, hoisted out of the picker, which is handed the result) and publishes the
 *      chosen service and its quoted rate on `./CheckoutCharges`. Three consequences are
 *      deliberate. The lookup names the shipment as well as the address - `cart.itemCount`, the
 *      same unit count `POST /api/checkout` rates the order's freight against - because freight is
 *      charged per piece and a lookup that named only the postal code would be answered for one
 *      unit - and it names the country as well as the code, because the same code is a different
 *      place in each country the store serves. The published amount comes from that quote and from
 *      nowhere else, so the review column either states the figure the order will be charged or
 *      states that the charge is not established yet; the transit time is published with it, so
 *      the delivery estimate printed there is the chosen service's rather than a store-wide one.
 *      And there is still exactly one `GET /api/shipping/quote` per destination, because the panel
 *      asks for nothing once the lookup is handed to it and the lookup waits for the fields to
 *      stand still before it asks.
 *
 *   6. THE LIVE QUOTE IS THE ONLY AUTHORITY ON WHAT MAY BE ORDERED, AND THE CART'S SIZE AND THE
 *      DESTINATION ARE CHECKED BEFORE IT IS ASKED FOR. A rate is a property of a destination, so
 *      this form starts with no services at all and offers none until the store has quoted the
 *      address in its fields: the service the order names is looked up in that quote, a service it
 *      omits is not something this order can be placed with, and the order is not sent until a
 *      quoted service is chosen. That is not this form second-guessing the
 *      endpoint - `POST /api/checkout` re-quotes and refuses an unoffered service outright - it is
 *      this form agreeing with it instead of showing a buyer a service that would be refused. Two
 *      things are settled before a request is made at all, for the same reason: freight is quoted
 *      per shipment and a shipment carries at most `MAX_SHIPMENT_UNITS` units, so a larger cart is
 *      named as the thing to change rather than sent to be refused twice; and a destination is a
 *      country and a complete postal code for it, judged by `@/lib/destination`, so a code
 *      somebody is still typing is never rated - a rate taken on `443` prices a different place
 *      from `44301`, and a buyer would be ordering at it.
 *
 *   7. VALIDATION IS DERIVED, SHOWN WHEN A FIELD IS FINISHED WITH, AND WHAT MAKES THE ORDER
 *      PLACEABLE. What is wrong with a value is a fact about that value, so it is computed from the
 *      fields on every render rather than stored when the order is submitted. Three things follow,
 *      and each of them was a defect while it did not. A message cannot outlive the value it was
 *      about, so a corrected field clears itself instead of standing accused until the next
 *      submission. The pass runs on every render, so the form can say what is missing before
 *      anything is pressed - the line above the place-order control names it. And whether the
 *      order is sent *is* that pass: a request that would be refused is not made, for a missing
 *      city exactly as for an unquoted shipment. The control itself stays available whenever there
 *      is a cart to order, so that pressing it - or pressing Enter in a field - is answered rather
 *      than ignored: the pass refuses the order, and the refusal is shown. When a message is shown
 *      is the one part that is about the buyer rather than the value: a field speaks once focus has
 *      left it, and a submission reveals all of them at once, lists them in an error summary at
 *      the top of the form and moves the reader to it, each entry a link to its field.
 *
 * Validation is a mirror of the server's bounds, not a second opinion about them: the lengths and
 * shapes below are the ones `checkoutBodySchema` enforces - the email check is literally the
 * regular expression its `z.email()` applies, and the character class, the postal-code shape and
 * the closed country list are the same rules stated again - so a value this form accepts is a value
 * that endpoint accepts. No bound is spelled as a `maxLength` attribute, because that enforces a
 * bound by silently discarding what was typed and leaves the message about it unreachable; each
 * control takes the whole value, the pass reports it, and the counter beside the field warns before
 * it happens. The endpoint remains the authority on everything that depends on data of the moment -
 * whether the cart still holds anything, whether the stock is still there, whether the chosen
 * service is still offered.
 */

import clsx from 'clsx';
import Link from 'next/link';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';

import { z } from 'zod';

import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useCart } from '@/hooks/useCart';
import { useFreightQuote, type FreightQuoteState } from '@/hooks/useShippingEta';
import { StorefrontApiError, submitCheckout } from '@/lib/api-client';
import {
  DEFAULT_FREIGHT_DESTINATION_CODE,
  FREIGHT_DESTINATIONS,
  freightDestination,
  freightDestinationProblem,
  freightPostalCodeHint,
} from '@/lib/destination';
import { formatPriceLabel, formatQuantityLabel } from '@/lib/format';
import { MAX_PAYMENT_CENTS, MAX_SHIPMENT_UNITS } from '@/lib/types';
import type {
  CheckoutDraft,
  CheckoutResult,
  CustomerContact,
  OrderDetail,
  ShippingAddress,
  ShippingOption,
} from '@/lib/types';
import { useToastCenter } from '@/providers/ToastProvider';

import { CheckoutButton } from './CheckoutButton';
import {
  usePublishOrderPending,
  usePublishOrderPlaced,
  usePublishSelectedFreight,
} from './CheckoutCharges';
import { OrderConfirmation } from './OrderConfirmation';
import { ShippingOptionPicker } from './ShippingOptionPicker';

import styles from './CheckoutForm.module.css';

/* ---------------------------------------------------------------------------
 * Element ids
 *
 * `FormField` takes the control's id from its caller and derives its message ids from it, which is
 * what keeps that wrapper free of `useId` and free of a client boundary. The ids are therefore
 * written here, literally and stably, so the label, the control and the two messages of one field
 * always agree - and so the rendered DOM of this form reads legibly while it is being debugged.
 * ------------------------------------------------------------------------- */

const CONTACT_NAME_ID = 'checkout-name';
const CONTACT_EMAIL_ID = 'checkout-email';
const CONTACT_COMPANY_ID = 'checkout-company';
const ADDRESS_LINE1_ID = 'checkout-address-line1';
const ADDRESS_LINE2_ID = 'checkout-address-line2';
const ADDRESS_CITY_ID = 'checkout-city';
const ADDRESS_REGION_ID = 'checkout-region';
const ADDRESS_POSTAL_CODE_ID = 'checkout-postal-code';
const ADDRESS_COUNTRY_ID = 'checkout-country';
const DELIVERY_NOTES_ID = 'checkout-notes';

/**
 * The shipping group's body - the service picker and its message - which is the one "field" of this
 * form that is not a single control. `./ShippingOptionPicker` mints its radios' ids from the
 * services the store quoted, so there is no control id this form could name for it; the wrapper it
 * renders into is given this id instead, and is focusable programmatically, so the error summary
 * has somewhere to send a reader even when there are no services to choose between yet.
 */
const SHIPPING_GROUP_ID = 'checkout-shipping';

/* ---------------------------------------------------------------------------
 * Bounds and shapes
 *
 * Each of these is the bound `checkoutBodySchema` applies to the same field. They are stated here
 * as well so the form can say what is wrong beside the field rather than after a round trip, and
 * they are stated as constants so the message under a field, the counter beside it and the bound
 * they both describe can never disagree about the same number.
 *
 * None of them is spelled as a `maxLength` attribute on a control, deliberately. That attribute
 * enforces a bound by discarding keystrokes: the value stops growing, nothing the application can
 * observe happens - `validity.tooLong` stays `false`, because a value that cannot overflow is
 * never too long - and the message written about the bound becomes unreachable. Worse, what is kept
 * is a value the buyer never typed: 254 characters of a 312-character address is a string with no
 * `@` in it. So each control takes the whole of what is typed, the pass below reports a value that
 * is too long, and `FormField`'s counter shows the reader where they are before it gets there.
 *
 * The postal code has no minimum here, although the endpoint holds it to three characters. A code
 * shorter than that is refused anyway - and refused by the destination rule below, which knows
 * which country the code is for and can therefore say what a complete one looks like, where a
 * bare minimum could only say the field was required about a value the buyer had plainly written.
 * ------------------------------------------------------------------------- */

const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_COMPANY_LENGTH = 120;
const MAX_ADDRESS_LINE_LENGTH = 120;
const MAX_CITY_LENGTH = 80;
const MAX_REGION_LENGTH = 80;
const MAX_POSTAL_CODE_LENGTH = 12;
const MAX_NOTES_LENGTH = 500;

/**
 * The heading of the cart notice when the cart itself published none.
 *
 * The cart publishes a heading beside its wording, naming the operation that failed, and that is
 * what the notice is headed with; this covers the one state the notice is shown in without any -
 * a first read that has not answered at all - and it says the same thing the cart's own read
 * heading says, so the two readings never differ.
 */
const CART_UNREAD_TITLE = 'Your cart could not be read';

/**
 * The test for an email address: Zod's own, which is the server's own.
 *
 * `customerContactSchema` validates this field with `z.email()`, and what that format check applies
 * is exactly this regular expression - `z.regexes.email` is where the library keeps it. Naming it
 * here is therefore not a second opinion about which addresses exist but the same one, which is the
 * only arrangement in which a value this form accepts is a value that endpoint accepts. A pattern
 * written by hand cannot make that claim however carefully it is written: a looser one admits
 * addresses the endpoint refuses - `üñíçø∂é@exämple.com` passes "something, one `@`, something, a
 * dot, something" and fails the format the store validates with - and a stricter one refuses
 * addresses it would have taken.
 *
 * It carries no flags, so `.test` keeps no state between calls and this constant is safe to share
 * across every validation pass.
 */
const EMAIL_SHAPE = z.regexes.email;

/**
 * What a complete destination looks like is not written here.
 *
 * It was, and as a single pattern of "alphanumeric groups joined by spaces or hyphens" - which
 * accepts `443` as readily as `44301`, and accepts a Canadian code under a United States address.
 * Neither is a destination: freight is rated to a place, a postal code names a place only within
 * a country, and a rate taken on three characters of one prices somewhere else entirely. So the
 * rule lives in `@/lib/destination`, where the browser, `GET /api/shipping/quote` and the shipping
 * service all read the same judgement and the same wording - the field below shows the sentence
 * that module returns, and the endpoint would answer with it too.
 */

/**
 * The last code point below the printable range: the top of the C0 control block, `U+001F`.
 *
 * This constant and the two below it are the character class `checkoutBodySchema` holds every
 * free-text field to, mirrored here for the same reason the lengths above are: a value this form
 * accepts has to be a value that endpoint accepts. A control character occupies one character, so
 * it fits inside every bound; it survives `trim()`, which removes whitespace and leaves `U+0000`
 * exactly where it was; and it reaches the store as a value an order cannot be written with. A
 * paste is how one arrives - a tab out of a spreadsheet, a line break out of a document - so the
 * field a buyer pasted into is where it should be reported.
 */
const CONTROL = 0x1f;

/** `DEL`, the one control character above the printable ASCII range. */
const DEL = 0x7f;

/** The line feed, `U+000A`: the one control character the delivery note carries. */
const FEED = 0x0a;

/** The wording every one-line free-text field uses when it holds a character it does not carry. */
const TYPED =
  'Use ordinary text characters here: tab, line break and other control characters are not accepted.';

/** The same for the delivery note, the one field of this form a line break is ordinary text in. */
const WRITTEN =
  'Use ordinary text characters here: line breaks are fine, but tab and other control characters are not accepted.';

/**
 * The postal field's hint once freight has actually been quoted for the destination.
 *
 * This sentence is a statement about the store's answer, not about the value in the field, so it
 * is shown only while a settled quote exists for that destination. A buyer correcting a code the
 * store has refused is therefore never told that it was priced.
 */
const QUOTED_DESTINATION_HINT = 'Freight is quoted for this destination.';

/** The postal field's hint when the chosen country is not one the warehouses quote freight to. */
const UNSERVED_DESTINATION_HINT = 'Choose a country the warehouses ship to.';

/**
 * How many random bytes name one attempt to place an order.
 *
 * Sixteen, written as hexadecimal, is thirty-two characters - comfortably
 * inside the bound `checkoutBodySchema` holds the field to, and far beyond the
 * point at which two buyers could mint the same name.
 */
const ATTEMPT_BYTES = 16;

/*
 * The destinations this catalog's warehouses quote freight for, and the one a form with no
 * prefill starts on, are `FREIGHT_DESTINATIONS` and `DEFAULT_FREIGHT_DESTINATION_CODE` in
 * `@/lib/destination`. The country control below is built from that list, because the country is
 * not merely one more field of the address: it decides what a complete postal code is and it
 * changes the rate, so the list of countries and the rule for their codes have to be one thing.
 */

/**
 * How many lines of the delivery note are visible before it scrolls.
 *
 * Four: enough that the two or three instructions the hint asks for are all on screen at once,
 * and short enough that the note does not push the place-order control off the page on a phone.
 * The field can be dragged taller, and what is typed is never limited by what is visible.
 */
const NOTES_ROWS = 4;

/* ---------------------------------------------------------------------------
 * Local shapes
 * ------------------------------------------------------------------------- */

/**
 * The contact group as the controls hold it.
 *
 * Every field is a `string`, including the optional company: a text control's value is a string,
 * and `''` is what an untouched or emptied one holds. The DTO's `null` is produced once, where the
 * draft is assembled, so no control has to know that the wire format spells "nothing" differently
 * from the way a form field does.
 */
interface ContactFields {
  name: string;
  email: string;
  company: string;
}

/** The destination as the controls hold it; `string` throughout, for the reason above. */
interface AddressFields {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

/** Which field a validation message belongs to. One key per control this form renders. */
type CheckoutFieldKey =
  | 'name'
  | 'email'
  | 'company'
  | 'line1'
  | 'line2'
  | 'city'
  | 'region'
  | 'postalCode'
  | 'country'
  | 'shippingOptionId'
  | 'notes';

/**
 * The messages a validation pass produced, by field.
 *
 * `Partial` rather than a full record: a field with nothing wrong has no key, which is what lets
 * `FormField`'s `error` prop be read straight off this object - an absent key is `undefined`, and
 * `undefined` is how that wrapper is told there is no message.
 */
type CheckoutFieldErrors = Partial<Record<CheckoutFieldKey, string>>;

/**
 * Every field of this form once, in the order it is read on screen: which key a message about it
 * lands under, which control holds it, and what its label calls it.
 *
 * Three things need exactly this and would otherwise each invent their own version of it. The line
 * beside the place-order control names what is still outstanding, and it has to name fields the way
 * the labels above them do - "State or region", not `region`. A submission that cannot proceed
 * shows an error summary listing every problem in on-screen order, each entry a link to the
 * element named by `id`, and "order" means order on screen rather than an object's key order. And
 * all of them have to cover every field: a key this table omits would be a problem nobody is told
 * about and a field nobody is sent to.
 *
 * Every entry has an `id`. For ten of them it is the control's own; the shipping service is a group
 * of radios drawn by `./ShippingOptionPicker`, which mints their ids from the services the store
 * quoted, so its entry names the wrapper the group renders into ({@link SHIPPING_GROUP_ID}) and
 * {@link focusCheckoutControl} finds the radio to land on inside it.
 */
const FIELDS: readonly {
  readonly key: CheckoutFieldKey;
  readonly id: string;
  readonly label: string;
}[] = [
  { key: 'name', id: CONTACT_NAME_ID, label: 'Contact name' },
  { key: 'company', id: CONTACT_COMPANY_ID, label: 'Company' },
  { key: 'email', id: CONTACT_EMAIL_ID, label: 'Email' },
  { key: 'line1', id: ADDRESS_LINE1_ID, label: 'Street address' },
  { key: 'line2', id: ADDRESS_LINE2_ID, label: 'Suite, unit or floor' },
  { key: 'city', id: ADDRESS_CITY_ID, label: 'City' },
  { key: 'region', id: ADDRESS_REGION_ID, label: 'State or region' },
  { key: 'postalCode', id: ADDRESS_POSTAL_CODE_ID, label: 'Postal code' },
  { key: 'country', id: ADDRESS_COUNTRY_ID, label: 'Country' },
  { key: 'shippingOptionId', id: SHIPPING_GROUP_ID, label: 'Shipping method' },
  { key: 'notes', id: DELIVERY_NOTES_ID, label: 'Notes for the warehouse' },
];

/**
 * Wording for a submission that failed, as the notice above the submit row prints it.
 *
 * Three fields, all written for a buyer: a headline they can scan, a sentence they can act on,
 * and the label of the control the notice offers. Nothing from the failure itself reaches any of
 * them - not its message, not its status line, not a stack - because a customer cannot do
 * anything with an internal string, and a checkout is the last place to start showing them one.
 *
 * The label is part of the copy rather than fixed in the markup because the control means
 * different things in the two cases the notice covers. Where the store said the order was not
 * placed, pressing it places the order. Where the outcome is unconfirmed, pressing it resolves
 * the attempt - the same submission under the same name, which the endpoint answers with the
 * order it already holds if there is one - and calling that "try again" would invite a buyer to
 * order twice.
 */
interface OrderFailureCopy {
  /**
   * What this notice says about the order, as the rest of the form has to act on it rather than
   * read it.
   *
   * The three values are the three things that can be true of a submission, and they are here
   * because two decisions turn on them and neither can be made from the wording:
   *
   *   `connectivity`  Nothing was sent. The browser had no connection when the order was placed,
   *                   so this form sent nothing, there is no order and no charge from that press,
   *                   and the notice describes the connection rather than the order. It is the one
   *                   notice a recovered connection makes obsolete, which is what lets the effect
   *                   below clear it - and only it - without hiding anything a buyer needs to know.
   *   `unresolved`    A request went out and no answer from the store came back, so an order may
   *                   exist and a payment may have been taken. Nothing clears this but the store's
   *                   own answer to resolving the attempt, and pressing the notice's control
   *                   resends that same attempt rather than a new order.
   *   `settled`       The store answered, and its answer was that no order was placed. Placing the
   *                   order again is the thing to do, and the next submission supersedes the
   *                   notice.
   */
  readonly kind: 'connectivity' | 'unresolved' | 'settled';
  readonly title: string;
  readonly body: string;
  readonly action: string;
}

interface Props {
  /** Destination values to start the form on. Every field is optional and each one is prefilled independently. */
  initialAddress?: Partial<ShippingAddress>;

  /** Contact values to start the form on, on the same terms as {@link Props.initialAddress}. */
  initialContact?: Partial<CustomerContact>;

  /**
   * Called once with the placed order, after the receipt is on screen.
   *
   * A hook for the surrounding page - recording the conversion, moving the buyer on - and nothing
   * this form depends on: it swaps the receipt in whether a handler was supplied or not, and it
   * never routes, retries or re-requests anything of its own. It runs outside the form's own
   * classification of the request, so a handler that throws is logged rather than turned into a
   * failed checkout; the order was placed either way.
   *
   * `result.outcome` is worth reading before a page records a conversion: an `already_placed`
   * result is the order an earlier submission placed, handed back because this one named the same
   * attempt, and counting it twice would count one sale twice.
   */
  onOrderPlaced?: (result: CheckoutResult) => void;

  /**
   * An order that has already been placed, to show as this form's receipt instead of its fields.
   *
   * `app/checkout/page.tsx` passes it when the page's address names an order and the store holds
   * it - the address this form gives an order with `history.pushState`, reloaded, bookmarked or
   * returned to - so a buyer arriving there reads the same receipt a submission shows, and the
   * review column beside it is told the order is placed exactly as it is after a submission. The
   * receipt arriving with the page is not something the buyer just did, so focus is left where the
   * browser put it; it moves to the receipt only when the order arrives on a form already on
   * screen, which is the one case where the control the buyer used has just left the document.
   * An attempt record naming this order is forgotten once its receipt is on screen.
   *
   * A submission's own result takes precedence over it, since only that result carries the payment
   * that settled the order. Spelled with `| undefined` because the workspace compiles with
   * `exactOptionalPropertyTypes` and the page passes the value it holds, which may be absent.
   */
  placedOrder?: OrderDetail | undefined;

  /** An extra class from the surrounding layout, composed after the module's own root class. */
  className?: string;
}

/* ---------------------------------------------------------------------------
 * Pure helpers
 *
 * All of them are module-level and take everything they need as arguments, so the component body
 * holds no logic worth reading twice and each of them can be reasoned about - or exercised - on its
 * own. None of them touches the network, the clock or the DOM. One reads the platform's random
 * source, and {@link attemptKey} says where that is called from and why it is not called while
 * anything is rendering.
 * ------------------------------------------------------------------------- */

/**
 * `value` trimmed, or `null` when nothing but whitespace was typed.
 *
 * The three optional fields of a draft - the second address line, the company, the delivery note -
 * are each declared `string | null` by the DTO and defaulted to `null` by the endpoint's schema, so
 * this is where a form's `''` becomes the wire format's "nothing", once, for all three.
 */
function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether `value` is text a one-line field carries: no C0 control character and no `DEL`.
 *
 * The same rule `checkoutBodySchema` refines every one-line free-text field with, so this form
 * reports a pasted tab beside the field it was pasted into rather than letting the round trip
 * report it about the whole request. Only the control characters are refused: an accented letter,
 * an ideograph and an emoji are all text a customer may legitimately type, and an allowlist of the
 * letters a store expects would refuse customers rather than protect anything.
 *
 * Written as a code-point test rather than a pattern because a pattern for this class has to
 * contain the very characters it excludes, which is neither readable nor something this
 * repository's lint settings accept. The loop reads UTF-16 units, which is what makes it exact: a
 * control character is always one unit, and a surrogate - half of an emoji - is numerically far
 * above both bounds and therefore untouched.
 *
 * @param value The trimmed value a field holds.
 */
function plain(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);

    if (code <= CONTROL || code === DEL) {
      return false;
    }
  }

  return true;
}

/**
 * Whether `value` is text the delivery note carries: {@link plain}'s rule with the line feed
 * allowed.
 *
 * The note is the one field of this form a buyer writes a paragraph into - dock hours on one line,
 * a purchase-order reference on the next - so the break they typed is text here and everything
 * else the class refuses is still refused. `checkoutBodySchema` parses the same field on the same
 * terms, which is what makes a note this form accepts a note that endpoint accepts.
 *
 * @param value The trimmed value the note holds.
 */
function prose(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);

    if (code !== FEED && (code <= CONTROL || code === DEL)) {
      return false;
    }
  }

  return true;
}

/**
 * `items` as a sentence fragment: `'Email'`, `'Email and Postal code'`, `'Email, City and Postal
 * code'`.
 *
 * It exists for the one line that names what is still outstanding beside the place-order control,
 * and it is written out rather than left as a `join(', ')` because that line is read by a buyer
 * working out what to do next: a list that ends "City, Postal code" reads like a truncated string,
 * and one that ends "City and Postal code" reads like a sentence.
 *
 * `at(-1)` rather than an index, so the empty case is a value this function can answer for instead
 * of an access `noUncheckedIndexedAccess` makes it guess about.
 */
function listed(items: readonly string[]): string {
  const last = items.at(-1);

  if (last === undefined) {
    return '';
  }

  const rest = items.slice(0, -1);

  return rest.length === 0 ? last : `${rest.join(', ')} and ${last}`;
}

/**
 * A name for one attempt to place an order: {@link ATTEMPT_BYTES} random bytes in hexadecimal.
 *
 * It exists so that a submission and every retry of that submission arrive under one name, which
 * is what lets the endpoint answer a retry with the order it already placed rather than placing a
 * second one. The name says nothing about the order, the cart or the buyer - it is an identifier
 * for the attempt and nothing else - so random bytes are the whole of it.
 *
 * Two deliberate choices about how they are drawn. `crypto.getRandomValues` rather than
 * `Math.random`, because two buyers must not mint one name; and called from the submit handler
 * rather than from the component body, because a value drawn while rendering would differ between
 * the markup the server sent and the markup this page hydrates.
 */
function attemptKey(): string {
  const bytes = new Uint8Array(ATTEMPT_BYTES);

  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The request body for what the controls currently hold.
 *
 * Trimming happens here rather than in the controls, so what a buyer sees in a field is exactly
 * what they typed while what is sent is canonical: surrounding whitespace gone, the country
 * upper-cased into the single form the address DTO carries, and each optional field either a
 * meaningful string or `null`.
 *
 * `shippingOptionId` falls back to `''` for a form with nothing chosen. That is not a value worth
 * sending, and it is not sent: an empty identifier is what {@link collectFieldErrors} reports as a
 * missing service, which is checked before the draft goes anywhere.
 *
 * `key` names the attempt this draft belongs to - see {@link attemptKey} - and is passed in rather
 * than drawn here, because two drafts assembled from the same unresolved attempt must carry the
 * same name.
 */
function checkoutDraftFrom(
  contact: ContactFields,
  address: AddressFields,
  shippingOptionId: string | null,
  notes: string,
  key: string,
): CheckoutDraft {
  return { ...entered(contact, address, shippingOptionId, notes), idempotencyKey: key };
}

/**
 * The order the controls currently hold, as the draft carries it but without the attempt's name.
 *
 * It is the whole of {@link checkoutDraftFrom} except the one field that is not a value the buyer
 * typed, and it is a function of its own because the two callers want different halves. The submit
 * path wants a draft to send, which is this plus the name of the attempt it belongs to. Every
 * render wants what the fields currently say, so it can be validated, counted and reported beside
 * the controls - and it wants it without minting or reading an attempt name, because validating
 * what is on screen is not an attempt to place an order.
 */
function entered(
  contact: ContactFields,
  address: AddressFields,
  shippingOptionId: string | null,
  notes: string,
): Omit<CheckoutDraft, 'idempotencyKey'> {
  return {
    contact: {
      name: contact.name.trim(),
      email: contact.email.trim(),
      company: trimmedOrNull(contact.company),
    },
    shippingAddress: {
      line1: address.line1.trim(),
      line2: trimmedOrNull(address.line2),
      city: address.city.trim(),
      region: address.region.trim(),
      postalCode: address.postalCode.trim(),
      country: address.country.trim().toUpperCase(),
    },
    shippingOptionId: shippingOptionId ?? '',
    notes: trimmedOrNull(notes),
  };
}

/**
 * Everything wrong with `draft`, by field, in one pass.
 *
 * One pass, and one message per field: the first thing wrong with a value is the thing to say
 * about it, because a field that reports a missing value and a too-long value at once is a field
 * nobody can act on. An empty object means the draft is worth sending, and it is the only thing
 * that lets the submit path continue - and, since the pass runs on every render, the only thing
 * that makes the place-order control available.
 *
 * The bounds are the endpoint's own, restated as the constants above, and each field is judged in
 * the order the endpoint judges it, so the message this form shows for a value is the message that
 * value would have come back with. Anything that depends on the state of the store rather than on
 * the shape of the request - whether the cart still holds what it held, whether the stock is still
 * there, whether the chosen service is still quoted - is deliberately absent: those are decided by
 * the checkout service against the data of the moment, and a second opinion here would go stale the
 * moment it was written.
 *
 * It takes the order without the attempt's name, which is every field a buyer can be wrong about:
 * the name is minted by the submit path, is never shown and is never invalid.
 */
function collectFieldErrors(draft: Omit<CheckoutDraft, 'idempotencyKey'>): CheckoutFieldErrors {
  const problems: CheckoutFieldErrors = {};
  const { contact, shippingAddress: address, shippingOptionId, notes } = draft;

  if (contact.name.length === 0) {
    problems.name = 'A contact name is required.';
  } else if (contact.name.length > MAX_NAME_LENGTH) {
    problems.name = `Keep the contact name to ${MAX_NAME_LENGTH} characters.`;
  } else if (!plain(contact.name)) {
    problems.name = TYPED;
  }

  if (contact.email.length === 0) {
    problems.email = 'An email address is required.';
  } else if (!EMAIL_SHAPE.test(contact.email)) {
    problems.email = 'Enter an email address the order confirmation can reach.';
  } else if (contact.email.length > MAX_EMAIL_LENGTH) {
    problems.email = `Keep the email address to ${MAX_EMAIL_LENGTH} characters.`;
  }

  if (contact.company !== null && contact.company.length > MAX_COMPANY_LENGTH) {
    problems.company = `Keep the company name to ${MAX_COMPANY_LENGTH} characters.`;
  } else if (contact.company !== null && !plain(contact.company)) {
    problems.company = TYPED;
  }

  if (address.line1.length === 0) {
    problems.line1 = 'A street address is required.';
  } else if (address.line1.length > MAX_ADDRESS_LINE_LENGTH) {
    problems.line1 = `Keep the street address to ${MAX_ADDRESS_LINE_LENGTH} characters.`;
  } else if (!plain(address.line1)) {
    problems.line1 = TYPED;
  }

  if (address.line2 !== null && address.line2.length > MAX_ADDRESS_LINE_LENGTH) {
    problems.line2 = `Keep the second address line to ${MAX_ADDRESS_LINE_LENGTH} characters.`;
  } else if (address.line2 !== null && !plain(address.line2)) {
    problems.line2 = TYPED;
  }

  if (address.city.length === 0) {
    problems.city = 'A city is required.';
  } else if (address.city.length > MAX_CITY_LENGTH) {
    problems.city = `Keep the city to ${MAX_CITY_LENGTH} characters.`;
  } else if (!plain(address.city)) {
    problems.city = TYPED;
  }

  if (address.region.length === 0) {
    problems.region = 'A state or region is required.';
  } else if (address.region.length > MAX_REGION_LENGTH) {
    problems.region = `Keep the state or region to ${MAX_REGION_LENGTH} characters.`;
  } else if (!plain(address.region)) {
    problems.region = TYPED;
  }

  // The destination, judged as the one thing it is. The length bounds come first because they are
  // this form's own - the field is bounded before it is read - and the shape is
  // `@/lib/destination`'s, which is the judgement the freight lookup gates on and the endpoint
  // applies, reported against whichever of the two controls is at fault. So a draft this pass
  // accepts is a draft the store can quote, and a buyer is never told to correct the field that
  // was right.
  if (address.postalCode.length === 0) {
    problems.postalCode = 'A postal code is required.';
  } else if (address.postalCode.length > MAX_POSTAL_CODE_LENGTH) {
    problems.postalCode = `Keep the postal code to ${MAX_POSTAL_CODE_LENGTH} characters.`;
  } else if (!plain(address.postalCode)) {
    problems.postalCode = TYPED;
  }

  // The country is judged against the closed list the control offers, and the same closed list
  // `shippingAddressSchema` holds the field to - not a two-letter shape, which would accept all 676
  // of them on both sides. A value this form cannot offer therefore cannot be submitted, which is
  // what matters when the visible control and the value behind it can be made to disagree: the
  // buyer's screen saying one country while the order names another is a state this check refuses
  // to let through. `@/lib/destination` is where that list lives, so the judgement is the one the
  // freight lookup gates on and the endpoint applies.
  const destinationProblem = freightDestinationProblem(address.country, address.postalCode);

  if (destinationProblem !== null && problems[destinationProblem.field] === undefined) {
    problems[destinationProblem.field] = destinationProblem.message;
  }

  if (shippingOptionId.length === 0) {
    problems.shippingOptionId = 'Choose a shipping service.';
  }

  if (notes !== null && notes.length > MAX_NOTES_LENGTH) {
    problems.notes = `Keep delivery notes to ${MAX_NOTES_LENGTH} characters.`;
  } else if (notes !== null && !prose(notes)) {
    problems.notes = WRITTEN;
  }

  return problems;
}

/**
 * What is wrong with the freight service this order would be placed with, or `undefined` when a
 * service the store currently quotes has been chosen.
 *
 * {@link collectFieldErrors} judges the draft's shape and deliberately nothing that depends on the
 * state of the store; this judges the one thing about the order that is settled outside the fields
 * - which services the store will sell for this destination and shipment - and it is a separate
 * function for that reason. The two are merged into one validation pass, and this message wins for
 * the shipping field, because "choose a shipping service" is unhelpful wording for a group that is
 * still being quoted, that could not be quoted, or that has nothing in it to choose.
 *
 * The cases are ordered by what a buyer has to do about them. A shipment larger than one
 * consignment is first: no quote exists for it and none is coming, so nothing else that could be
 * said is actionable. A service drawn from the current quote is the end of the matter. Otherwise
 * there is no such service, and the message says which of the three reasons applies: the lookup is
 * still running, it has not run or did not come back, or it came back naming nothing the store can
 * sell to this destination.
 *
 * @param freight The freight lookup for the destination and shipment in the fields.
 * @param quotedChoice The service drawn from the settled quote, or `undefined` when it offers none.
 * @returns The message for the shipping field, or `undefined` when there is nothing wrong.
 */
function freightSelectionProblem(
  freight: FreightQuoteState,
  quotedChoice: ShippingOption | undefined,
): string | undefined {
  const { shipmentLimit } = freight;

  if (shipmentLimit !== null) {
    return (
      `Shipping cannot be quoted for an order of ${formatQuantityLabel(shipmentLimit.units)} units; ` +
      `a shipment carries at most ${formatQuantityLabel(shipmentLimit.maxUnits)}.`
    );
  }

  if (quotedChoice !== undefined) {
    return undefined;
  }

  if (freight.isQuoting) {
    return 'Shipping services are still being quoted for this destination.';
  }

  if (freight.quote === null) {
    return 'Shipping services have not been quoted for this destination yet.';
  }

  // A settled quote with a service in it always yields one to place the order with, so reaching
  // here means the store answered for this destination and named nothing it can carry there.
  return 'No shipping service is available for this destination.';
}

/** The label of the notice's control where placing the order again is the thing to do. */
const RETRY_ORDER = 'Try again';

/** The label of the notice's control where resolving the attempt is the thing to do. */
const RESOLVE_ORDER = 'Check this order';

/**
 * Wording for an attempt whose outcome this page cannot establish.
 *
 * It is the one notice that does not say whether the buyer has been charged, because that is the
 * situation: a request was sent, no answer from the store came back, and what became of it is not
 * known here. So it says so, it does not invite a second order, and it explains why the control in
 * front of the buyer is safe to press - it resends the draft the attempt recorded under the same
 * name, the endpoint recognises the attempt and answers with the order it already holds, and it
 * places the order only if it never received it.
 */
const UNCONFIRMED: OrderFailureCopy = {
  kind: 'unresolved',
  title: 'This order is not confirmed',
  body: 'Lumen Supply may already have this order, and a payment may already have been taken for it. Check the order rather than placing it again: checking cannot create a second order, and it completes this one if the store never received it.',
  action: RESOLVE_ORDER,
};

/**
 * Wording for a submission this form did not send, because the browser had no connection when the
 * order was placed.
 *
 * It is the opposite statement to {@link UNCONFIRMED}, and it is made only where the fact is this
 * form's own: the connection is asked about before anything is sent, and a submission made
 * without one is held back rather than sent. It is never derived from a rejected request. A request
 * that went out and lost its connection on the way back is rejected exactly like one that never
 * left, and the browser's connection state afterwards is not its state when the bytes left - so
 * the honest answer there is that the outcome is unknown, and that is {@link UNCONFIRMED}.
 *
 * Because nothing was sent, the notice says so plainly - no order, no charge, every typed value
 * still in place - and offers to place the order, not to check one. It is also the one notice that
 * a recovered connection makes obsolete on its own, which is why it carries `connectivity` and why
 * the buyer is not left reading it after the store is reachable again.
 */
const OFFLINE: OrderFailureCopy = {
  kind: 'connectivity',
  title: 'Lumen Supply could not be reached',
  body: 'Check your connection and try again. This order was not sent and nothing was charged: every value you entered is still here, so placing it again is one click once you are back online.',
  action: RETRY_ORDER,
};

/**
 * Wording for an attempt this page started and never saw the end of.
 *
 * It is {@link UNCONFIRMED}'s situation arrived at by a different route: the buyer left while the
 * request was in flight, so the request was abandoned rather than answered - and because
 * `POST /api/checkout` does not stop work when a browser stops waiting for it, the order may have
 * been placed and paid for all the same. The attempt's name and the exact draft it sent survive in
 * session storage, so the control offered here resends that same attempt - with the contact, the
 * destination and the service it was placed with, whatever the fields and the cart hold now - and
 * the store answers with the order it already holds, if it holds one.
 *
 * The first sentence is what distinguishes it from a submission that failed on this page: the
 * buyer did not see this attempt fail, so the notice starts by saying which attempt it is about.
 */
const INTERRUPTED: OrderFailureCopy = {
  kind: 'unresolved',
  title: 'This order is not confirmed',
  body: 'An order was being placed when this page was left, and what became of it is not known here. Lumen Supply may already have it, and a payment may already have been taken for it. Check the order rather than placing it again: checking cannot create a second order, and it completes this one if the store never received it.',
  action: RESOLVE_ORDER,
};

/**
 * Wording for a submission that did not place an order.
 *
 * Every branch says what happened and what to do next, and each is written for the one thing a
 * buyer wants to know at this point: whether they have been charged and whether to press the
 * button again. The reason is read from the failure's own `code`, with `status` separating a store
 * that answered badly from one that could not answer at all, so the copy follows the failure rather
 * than the HTTP vocabulary it arrived in.
 *
 * Two of those branches are reached only through a reason the store itself named, and that is
 * checked before any of them: a failure carrying a reason this page derived - because the reply
 * could not be read, because only a status arrived, because the request came back with nothing at
 * all after leaving - is a failure about a submission that may well have been carried out, and
 * describing it as one that was not would be this page inventing the part it does not know.
 * `PAYMENT_STATUS_UNKNOWN` is the same situation named by the store, for the case where the store
 * knows it too.
 *
 * `NETWORK_FAILURE` is one of those unreported failures and gets the same cautious answer, with no
 * exception for a browser that says it is offline: a rejected request cannot say whether it
 * arrived, and the connection this browser reports once it has failed is not the connection it had
 * when the request left. A submission this form knew it could not send never reaches this
 * function - the submit path asks for a connection before it sends and shows {@link OFFLINE} then,
 * which is the one place "nothing was sent" is a fact.
 *
 * Anything that is not a {@link StorefrontApiError} - a mistake in this page, a value the browser
 * threw - lands on the generic sentence: nothing left for the store at all, so nothing was
 * charged.
 */
function checkoutFailureCopy(cause: unknown): OrderFailureCopy {
  if (!(cause instanceof StorefrontApiError)) {
    return {
      kind: 'settled',
      title: 'The order was not placed',
      body: 'Something went wrong before this order reached Lumen Supply. Nothing was charged. Place the order again.',
      action: RETRY_ORDER,
    };
  }

  if (!cause.reported) {
    return UNCONFIRMED;
  }

  switch (cause.code) {
    // Four things the buyer can act on reach this reason, and naming only the fields would send
    // somebody to correct an address that was never the problem. The endpoint validates the
    // contact and the destination, and it also rates the freight for the units it reserved - so a
    // cart that grew past `MAX_SHIPMENT_UNITS` between this page's last reading of it and the
    // submission is answered here too - and the payment service refuses, before anything is sent,
    // a total above `MAX_PAYMENT_CENTS`, the most one payment can be. Neither the units nor the
    // total can be ruled out in advance: the total is what the store prices when the order is
    // placed, promotions and freight included, so no figure on this page is guaranteed to be it.
    // The order is what the buyer checks first and the cart last, which is the order they are
    // named in, and the sentence ends by saying what to do about a cart that is too large, since
    // placing the same order again cannot change that answer.
    case 'VALIDATION_FAILED':
      return {
        kind: 'settled',
        title: 'Check these order details',
        body:
          'Lumen Supply could not accept these details. Review the contact and address fields, ' +
          `and check that the cart holds no more than ${formatQuantityLabel(MAX_SHIPMENT_UNITS)} ` +
          `units and comes to no more than ${formatPriceLabel(MAX_PAYMENT_CENTS)}, the most one ` +
          'payment can cover. Reduce the order if it is larger, then place it again.',
        action: RETRY_ORDER,
      };
    case 'NOT_FOUND':
      return {
        kind: 'settled',
        title: 'Something in this order is no longer available',
        body: 'A product or a shipping service in this order is no longer offered. Review the cart and the shipping method, then place the order again.',
        action: RETRY_ORDER,
      };
    case 'OUT_OF_STOCK':
      return {
        kind: 'settled',
        title: 'Stock changed while you were ordering',
        body: 'One or more items are no longer available in the quantity requested. Adjust the cart, then place the order again.',
        action: RETRY_ORDER,
      };
    case 'CART_CONFLICT':
      return {
        kind: 'settled',
        title: 'This cart changed',
        body: 'The cart changed while this order was being placed. Review it, then place the order again.',
        action: RETRY_ORDER,
      };
    case 'PAYMENT_DECLINED':
      return {
        kind: 'settled',
        title: 'Payment was declined',
        body: 'The payment was not authorized and nothing was charged. Use another payment method, then place the order again.',
        action: RETRY_ORDER,
      };
    case 'PAYMENT_STATUS_UNKNOWN':
      return UNCONFIRMED;
    // Neither of the next two is ever reported by the store - both describe the reply rather than
    // the order - so neither reaches this switch through the `reported` check above. They are
    // named here so that the reason for that is stated where a reader looks for it, and so that
    // every member of the union has an answer. For `NETWORK_FAILURE` that answer is an unknown
    // outcome whatever the browser says about its connection afterwards: the request may have
    // arrived and been carried out, and only the reply was lost.
    case 'NETWORK_FAILURE':
    case 'MALFORMED_RESPONSE':
      return UNCONFIRMED;
    case 'INTERNAL_ERROR':
      return cause.status >= 500
        ? {
            kind: 'settled',
            title: 'Lumen Supply could not complete the order',
            body: 'The store reported a problem on its side. Nothing was charged. Place the order again in a moment.',
            action: RETRY_ORDER,
          }
        : {
            kind: 'settled',
            title: 'The order was not placed',
            body: 'Lumen Supply could not complete this order. Nothing was charged. Place the order again.',
            action: RETRY_ORDER,
          };
  }
}

/**
 * What is about to be ordered, in one line beside the place-order control: `'12 items · $4,318.00
 * subtotal'`.
 *
 * Both numbers come from the cart the provider published - the count summed across its lines and
 * the money it already formatted - so this line and the order summary beside the form can never
 * quote different figures. The count is worded through `@/lib/format`, which pins the locale, and
 * the unit follows the count so a single-item order does not read "1 items".
 */
function orderSizeLabel(itemCount: number, subtotalLabel: string): string {
  const unit = itemCount === 1 ? 'item' : 'items';

  return `${formatQuantityLabel(itemCount)} ${unit} · ${subtotalLabel} subtotal`;
}

/**
 * The error summary's heading. It names the situation rather than any one field, because the list
 * under it does that, entry by entry, in the words each field's own message uses.
 */
const ERROR_SUMMARY_TITLE = 'There is a problem with this order';

/**
 * The sentence under the error summary's heading: how many problems stand between the buyer and
 * the order, and that fixing them is what places it.
 *
 * The count is worded through `@/lib/format`, like every other figure in the storefront, and the
 * singular is its own sentence so a single problem does not read "the 1 problems".
 */
function errorSummaryLead(problemCount: number): string {
  return problemCount === 1
    ? 'Fix the problem below to place the order.'
    : `Fix the ${formatQuantityLabel(problemCount)} problems below to place the order.`;
}

/* ---------------------------------------------------------------------------
 * What outlives this render
 *
 * Everything above is a function of what is on screen. The functions below serve the two places an
 * order has to survive longer than that - this tab's session storage and this page's address - and
 * they are the only code in this module that touches the browser rather than React, which is why
 * they live in their own section, away from the pure helpers, and why every one of them is called
 * from an effect or from the submit handler and never while anything is rendering.
 *
 * The problem they solve is one situation: `POST /api/checkout` is not stopped by a browser that
 * stops waiting for it. A buyer who leaves this page mid-request, or whose connection drops after
 * the request went out, may have an order and a charge that this component never saw - and until
 * this section existed, the only trace of it was a toast that dismissed itself. So an attempt
 * writes itself down before it is sent and is read back on the next mount, and a placed order is
 * given an address of its own that a buyer can return to, reload and bookmark.
 * ------------------------------------------------------------------------- */

/**
 * Where the attempt in flight is written down, in this tab's session storage.
 *
 * Session storage rather than local storage: the record is about what this tab was doing, it is
 * of no use to another tab shopping with its own form, and it should not outlive the browsing
 * session that produced it. The name is namespaced by the store so it cannot collide with anything
 * else the same origin keeps.
 */
const ATTEMPT_STORAGE_KEY = 'lumen-supply.checkout-attempt';

/** The path this form is placed at, which is also the path a placed order is addressed under. */
const CHECKOUT_PATH = '/checkout';

/**
 * The query parameter that names a placed order in this page's address.
 *
 * `app/checkout/page.tsx` reads the same name to read the order back and hand it to this form as
 * its receipt, and the two are stated separately on purpose: a route file's query vocabulary is its
 * contract with the browser, the same way `app/orders/page.tsx` declares its own, and a component
 * importing a route module would be the wrong direction of dependency. Change one and change the
 * other.
 */
const ORDER_PARAM = 'order';

/**
 * Where the storefront lists orders.
 *
 * Offered as somewhere to go rather than as a promise about what is there: `app/orders/page.tsx`
 * lists the one demonstration account its own default names, while an order placed from this form
 * is filed against the account the endpoint derives from the submitted contact email. So the
 * notices below hand a buyer the reference and point at the history, and neither of them claims
 * the order will be on its default page.
 */
const ORDERS_PATH = '/orders';

/**
 * One attempt to place an order, as it is written down while it is in flight.
 *
 * Four fields, each of which answers a question the next mount of this form will have. The name
 * of the attempt is what lets a buyer resolve it rather than order twice - the endpoint answers a
 * submission it has already seen with the order that attempt placed. The instant is when the
 * request went out, which is what a diagnostic line needs to be worth reading. The order number is
 * `null` for exactly as long as the outcome is unknown: it is filled in when the store answers, so
 * a record that still holds `null` is an attempt nobody ever got an answer to, and a record that
 * holds one is an order whose receipt this tab has not yet shown - the record is forgotten the
 * moment that receipt is on screen.
 *
 * And the draft is the exact body that was sent, written before it goes out, because resolving
 * the attempt means sending that body again. The endpoint checks a repeat as it checked the first
 * submission, and after a reload nothing else in this form still holds it: the fields may be
 * empty, the cart the attempt ordered may already be an order, and the freight quote that named
 * the service is gone with the page. It is `null` once the store has answered with an order - the
 * contact and the address it carries are the store's to keep then, not this tab's - and in a
 * record that could not keep one (see {@link readAttemptRecord}).
 */
interface CheckoutAttemptRecord {
  readonly idempotencyKey: string;
  readonly startedAt: number;
  readonly orderNumber: string | null;
  readonly draft: CheckoutDraft | null;
}

/**
 * Whether `value` is a {@link CheckoutAttemptRecord} this form may act on.
 *
 * Storage is a string that anything with this origin could have written, and what is read back
 * decides whether a buyer is told they may have been charged - so it is validated rather than
 * cast. Every field is checked for its own type, the attempt's name is required to be non-empty,
 * the instant is required to be a finite number, and the draft is required to be `null` or a
 * draft {@link intact} judges to be one this attempt sent. A record that fails the first three
 * says nothing intelligible about an order; one that fails only the last is still the record of
 * an attempt, which {@link readAttemptRecord} keeps without its draft.
 */
function isAttemptRecord(value: unknown): value is CheckoutAttemptRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const { idempotencyKey, startedAt, orderNumber, draft } = value as Partial<CheckoutAttemptRecord>;

  return (
    typeof idempotencyKey === 'string' &&
    idempotencyKey.length > 0 &&
    typeof startedAt === 'number' &&
    Number.isFinite(startedAt) &&
    (orderNumber === null || (typeof orderNumber === 'string' && orderNumber.length > 0)) &&
    (draft === null || intact(draft, idempotencyKey))
  );
}

/**
 * Whether `value` is a {@link CheckoutDraft} the attempt named `key` could have sent.
 *
 * A structural check, field by field, against the DTO: every string is a string, every optional
 * value is a string or `null`, and the draft's own attempt name is `key` - a draft recorded under
 * one attempt and read back under another would resolve the wrong one. It does not judge the
 * values, because the draft was judged before it was first sent and the endpoint judges it again
 * when it is sent again; what this rules out is a body this form did not write, which would be
 * refused as a malformed request instead of being answered about the attempt.
 *
 * @param value What the record holds under `draft`.
 * @param key The name of the attempt the record is about.
 */
function intact(value: unknown, key: string): value is CheckoutDraft {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const { contact, shippingAddress, shippingOptionId, notes, idempotencyKey } = value as Partial<
    Record<keyof CheckoutDraft, unknown>
  >;

  if (
    typeof contact !== 'object' ||
    contact === null ||
    typeof shippingAddress !== 'object' ||
    shippingAddress === null
  ) {
    return false;
  }

  const { name, email, company } = contact as Partial<Record<keyof CustomerContact, unknown>>;
  const { line1, line2, city, region, postalCode, country } = shippingAddress as Partial<
    Record<keyof ShippingAddress, unknown>
  >;

  return (
    typeof name === 'string' &&
    typeof email === 'string' &&
    (company === null || typeof company === 'string') &&
    typeof line1 === 'string' &&
    (line2 === null || typeof line2 === 'string') &&
    typeof city === 'string' &&
    typeof region === 'string' &&
    typeof postalCode === 'string' &&
    typeof country === 'string' &&
    typeof shippingOptionId === 'string' &&
    (notes === null || typeof notes === 'string') &&
    idempotencyKey === key
  );
}

/**
 * The attempt this tab last wrote down, or `null` when there is none to act on.
 *
 * Every storage call in this section is wrapped, and this one parses as well, because a checkout
 * that breaks over storage would be a worse defect than the one this record exists to report:
 * `sessionStorage` throws outright where storage is denied or partitioned, and the value it holds
 * may be anything. A failure of either kind is logged for whoever is debugging it and answered as
 * "no record", which leaves the form exactly as it behaves for a first-time buyer.
 *
 * A record whose name and instant are intact is kept even when its draft is not - one written
 * before records carried a draft, or one whose draft is not a draft this attempt sent. It is kept
 * with `draft: null` rather than dropped: it is still the evidence that an attempt went out and may
 * have been charged, and dropping it would let the next submission mint a new name for what may be
 * the same order. Only the draft is lost, and the form falls back to the fields for it.
 */
function readAttemptRecord(): CheckoutAttemptRecord | null {
  let stored: string | null;

  try {
    stored = sessionStorage.getItem(ATTEMPT_STORAGE_KEY);
  } catch (cause) {
    console.warn(
      'Lumen Supply: this browser would not let the checkout read its own session storage:',
      cause instanceof Error ? cause.name : typeof cause,
    );

    return null;
  }

  if (stored === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(stored);
  } catch {
    parsed = undefined;
  }

  if (isAttemptRecord(parsed)) {
    return parsed;
  }

  // The same record without its draft: what is left when only the draft was unreadable, or when
  // the record predates drafts altogether.
  const kept: unknown =
    typeof parsed === 'object' && parsed !== null ? { ...parsed, draft: null } : undefined;

  if (!isAttemptRecord(kept)) {
    console.warn('Lumen Supply: the stored checkout attempt could not be read and was dropped.');
    forgetAttempt();

    return null;
  }

  // Worth a line only where the draft would have been used: an attempt nobody has an answer to. A
  // record that already names its order has no use for one.
  if (kept.orderNumber === null) {
    console.warn(
      'Lumen Supply: the stored checkout attempt holds no readable draft and is kept without one.',
    );
  }

  return kept;
}

/**
 * Writes down the attempt in hand, replacing whatever was there.
 *
 * Called twice per submission: once before the request goes out, with no order number and the
 * exact draft being sent, and once when the store has answered with an order, with the order's
 * own reference and no draft. The second call is what turns "an order may exist" into "this order
 * exists", and it is the reference a buyer is shown if they come back to a form whose receipt they
 * never saw. It is written before the receipt is stored, not after, so a form that goes away in
 * between still leaves that evidence behind; {@link forgetShownAttempt} takes it away once the
 * receipt has actually rendered.
 *
 * A storage that refuses the write is logged and otherwise ignored. The submission continues: an
 * order the buyer can place is worth more than the note this page would have kept about it.
 */
function rememberAttempt(record: CheckoutAttemptRecord): void {
  try {
    sessionStorage.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify(record));
  } catch (cause) {
    console.warn(
      'Lumen Supply: this browser would not let the checkout record its attempt:',
      cause instanceof Error ? cause.name : typeof cause,
    );
  }
}

/**
 * Drops the record, once it has nothing left to report.
 *
 * Only an established outcome may do this, and there are two. One is an attempt that provably
 * placed no order: the store's own answer that no order was placed - a failure it named, carrying
 * a reason that means nothing was captured - or a failure of this page raised before a fresh
 * submission's request left it. The other is an order whose receipt is on screen, which
 * {@link forgetShownAttempt} establishes: the buyer is reading the order the record exists to tell
 * them about. A record removed on an unknown outcome is the evidence of a possible charge thrown
 * away, which is the whole thing this section exists to prevent, so nothing else does it - no
 * rejected request, whatever the browser says about its connection. A record that cannot be read
 * at all is the one other case, and {@link readAttemptRecord} says why.
 */
function forgetAttempt(): void {
  try {
    sessionStorage.removeItem(ATTEMPT_STORAGE_KEY);
  } catch (cause) {
    console.warn(
      'Lumen Supply: this browser would not let the checkout clear its attempt record:',
      cause instanceof Error ? cause.name : typeof cause,
    );
  }
}

/**
 * Drops the record when it names `orderNumber`, whose receipt is now on screen.
 *
 * A record carrying an order number says "this tab placed an order it has not shown a receipt
 * for", and the mount after next reads it that way and names the order in a notice. Once the
 * receipt for that order has rendered - after the submission that placed it, or when the page at
 * the order's own address hands it back - that sentence is no longer true, and a record left in
 * place would be a false notice on the buyer's next visit to this page. So the record goes.
 *
 * Only a record naming this very order is dropped. One that names another order is still the
 * evidence of a receipt that order never had, and one with no order number is an attempt whose
 * outcome nobody established - neither is settled by a receipt for something else.
 *
 * Called from an effect, never while rendering, because an effect runs after the receipt has been
 * committed to the screen.
 *
 * @param orderNumber The reference of the order whose receipt has just rendered.
 */
function forgetShownAttempt(orderNumber: string): void {
  if (readAttemptRecord()?.orderNumber === orderNumber) {
    forgetAttempt();
  }
}

/** The address a placed order is readable at: this page, naming the order. */
function orderAddress(orderNumber: string): string {
  return `${CHECKOUT_PATH}?${ORDER_PARAM}=${encodeURIComponent(orderNumber)}`;
}

/**
 * Gives the order that was just placed an address of its own, without disturbing what is on
 * screen.
 *
 * `window.history.pushState` rather than the router: the App Router keeps its own state in step
 * with the native call, and because no navigation happens, this component is not remounted - which
 * matters, because the receipt a buyer is reading is this component's state and a remount would
 * destroy it. `router.push` would do exactly that.
 *
 * What it buys is everything a placed order was missing. Back returns to the checkout page instead
 * of leaving the storefront, Forward and reload arrive at an address that still names the order,
 * and the address bar holds something a buyer can copy or bookmark. The page at that address
 * reads the order back and hands it to this form, which renders the same receipt again.
 *
 * @param orderNumber The reference the store printed on the order.
 */
function pushOrderAddress(orderNumber: string): void {
  window.history.pushState(null, '', orderAddress(orderNumber));
}

/**
 * Whether this page's current address already names `orderNumber`.
 *
 * Asked before the form raises a notice about an order it found in storage: when the address names
 * it, `app/checkout/page.tsx` has already answered for that order - with its receipt, which this
 * form renders in place of the fields and which forgets the record, or with its own notice when
 * the order could not be shown - and a second notice would be this component and that page both
 * answering for one order.
 *
 * @param orderNumber The reference read back from the attempt record.
 */
function addressNamesOrder(orderNumber: string): boolean {
  return new URLSearchParams(window.location.search).get(ORDER_PARAM) === orderNumber;
}

/* ---------------------------------------------------------------------------
 * Where focus goes
 *
 * A keyboard or screen-reader buyer is always somewhere, and every step of this form either leaves
 * them where they pressed or moves them to the thing that answers the press (WCAG 2.4.3): a
 * validation pass that refuses the order lands them on the error summary, each of its links lands
 * them on the field it names, a submission keeps them on the control that sent it while it is in
 * flight, and its outcome lands them on the receipt or on the failure notice. The component owns
 * the timing - the regions it focuses exist only after the render that shows them - and this
 * section owns the one DOM walk that is not simply "focus this element". Like the section above,
 * it is only ever called from a handler, never while rendering.
 * ------------------------------------------------------------------------- */

/**
 * Move focus to the control an error-summary entry names, bringing it into view.
 *
 * `id` is one of {@link FIELDS}' ids. Ten of them are a control's own id and are focused directly.
 * The eleventh is the shipping group's wrapper, whose radios are minted by `./ShippingOptionPicker`
 * from the services the store quoted: the chosen service's radio is the one to land on, then the
 * first service that can be chosen, and when no service has been quoted at all - the lookup is in
 * flight, failed, or has no destination yet - the wrapper itself takes focus, so the reader lands
 * on the group's own explanation of why there is nothing to choose. An id that is not in the
 * document - a field the render in hand does not show - moves nothing.
 *
 * The browser's own focus scrolling brings the target into view, which is why nothing here scrolls.
 */
function focusCheckoutControl(id: string): void {
  const target = document.getElementById(id);

  if (target === null) {
    return;
  }

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    target.focus();

    return;
  }

  const choice =
    target.querySelector<HTMLElement>('input[type="radio"]:checked:not(:disabled)') ??
    target.querySelector<HTMLElement>('input[type="radio"]:not(:disabled)');

  (choice ?? target).focus();
}

/* ---------------------------------------------------------------------------
 * The form
 * ------------------------------------------------------------------------- */

/**
 * Render the checkout form, or the receipt for the order it placed.
 *
 * State is ten plain `useState` values and nothing else - the contact group, the destination
 * group, the delivery note, the chosen service, whether a submission is in flight, the validation
 * messages, how many validation passes have refused the order in a row, the failure notice, the
 * placed order and the reference of an order an earlier attempt from this tab turned out to have
 * placed. There is no reducer, no transition and no derived copy of the cart: the cart is read from
 * the provider that owns it, and the two composite blocks below own their own presentation. Ten
 * refs sit beside them, each holding something that must survive a render without causing one: the
 * attempt's name, the exact draft that attempt was sent with, the controller of the submission in
 * flight, the four elements focus is moved to - the error summary, the failure notice, the receipt
 * and the submit row - the cart notice's re-read control with the mark saying a press of it moved
 * focus (see "Where focus goes" above), and the order the page handed over when the form first
 * rendered.
 *
 * Two things are read from elsewhere and neither is state of this form's. The freight lookup for
 * the destination in the fields comes from `@/hooks/useShippingEta`, which owns the request and its
 * outcomes - a quote, a lookup in flight, a failed lookup, and a shipment too large to quote at
 * all; the charge channel comes from `./CheckoutCharges`, and all this form does with it is publish
 * what the buyer chose. The chosen service itself is derived from that lookup's quote on every
 * render rather than stored, so it cannot go stale against what the store is currently offering.
 *
 * Two handlers matter. `submitOrder` is the form's `onSubmit`, and it is described where it is
 * written. The other is the `void`-returning arrow the form attaches it with: a promise handed
 * straight to a DOM event attribute is a promise nothing awaits, so the arrow starts the
 * submission and returns nothing, which is what React's handler signature asks for.
 *
 * Once an order exists the fields are gone and the receipt takes their place, because there is
 * nothing left to edit: the order has an order number, the payment has resolved, and both are
 * printed by `./OrderConfirmation` from the result this form stored. Three things happen with it,
 * none of them the receipt's own doing: focus moves to the region it is rendered in, since the
 * control that was pressed has left the document; the page's address is rewritten to name the
 * order, so the receipt has somewhere to be returned to after it is gone; and, once the receipt is
 * on screen, the attempt record naming it is forgotten, because it has nothing left to report.
 *
 * The same receipt is shown for an order the page hands over as `placedOrder` - the order the
 * page's own address names, read back when a buyer reloads or returns to it. Everything but the
 * focus is the same: the review column is told the order is placed, and the record naming it is
 * forgotten. Focus is left alone when the order arrives with the page, since nothing the buyer
 * pressed has gone, and moves to the receipt only when the order arrives on a form that was
 * already on screen - a link followed from this form's own notice, whose control leaves the
 * document with the fields.
 */
export function CheckoutForm({
  initialAddress,
  initialContact,
  onOrderPlaced,
  placedOrder,
  className,
}: Props): ReactElement {
  const cart = useCart();
  const { showToast } = useToastCenter();
  const publishFreight = usePublishSelectedFreight();
  const publishPlacement = usePublishOrderPlaced();
  const publishPending = usePublishOrderPending();

  const [contact, setContact] = useState<ContactFields>(() => ({
    name: initialContact?.name ?? '',
    email: initialContact?.email ?? '',
    company: initialContact?.company ?? '',
  }));
  const [address, setAddress] = useState<AddressFields>(() => ({
    line1: initialAddress?.line1 ?? '',
    line2: initialAddress?.line2 ?? '',
    city: initialAddress?.city ?? '',
    region: initialAddress?.region ?? '',
    postalCode: initialAddress?.postalCode ?? '',
    country: initialAddress?.country ?? DEFAULT_FREIGHT_DESTINATION_CODE,
  }));
  const [notes, setNotes] = useState<string>('');
  // Nothing is chosen until the store has quoted the destination, because until then there is
  // nothing to choose: a service without a rate for this address is not an offer. The buyer's
  // choice is remembered here once they make one, and is honoured by each later quote that still
  // names it - see `quotedChoice` below.
  const [shippingOptionId, setShippingOptionId] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean>(false);
  const [failure, setFailure] = useState<OrderFailureCopy | null>(null);
  const [placed, setPlaced] = useState<CheckoutResult | null>(null);

  /*
   * The receipt this form shows in place of its fields, or `null` while it shows the fields.
   *
   * A submission's own result comes first, because it is the one payload that carries the payment
   * that settled the order; an order the page handed over from its address comes next. Either way
   * the value is `./OrderConfirmation`'s own payload, so the one receipt renders both. The order
   * number of the page's order is held on its own as well, as the primitive the effect below
   * depends on - an object in a dependency array is a new identity on every render of the page.
   */
  const receipt: CheckoutResult | OrderDetail | null = placed ?? placedOrder ?? null;
  const suppliedOrderNumber = placedOrder?.orderNumber ?? null;

  /*
   * Which fields the buyer has finished with, and whether they have tried to place the order.
   *
   * These two are the whole of what this form stores about its validation, and storing this rather
   * than the messages themselves is the point. What is wrong with a value is a fact about the
   * value, so it is derived from the fields on every render and cannot survive the value being
   * corrected; when a buyer is shown it is a fact about what they have done, which is what these
   * two remember. A field enters `touched` when focus leaves it, because a message under a field
   * somebody is still typing into is a form arguing with a half-typed value; `submitted` reveals
   * every field at once, because somebody who has tried to place the order has finished with all of
   * them.
   */
  const [touched, setTouched] = useState<Partial<Record<CheckoutFieldKey, true>>>({});
  const [submitted, setSubmitted] = useState<boolean>(false);

  /*
   * How many submissions in a row the validation pass has refused, and `0` once one gets through.
   *
   * It is what the error summary is shown by and what focus follows to it, and it is a count
   * rather than a flag because every refusal has to move focus, including the second press of a
   * form that is still wrong: a flag already `true` would not change, and the effect that focuses
   * the summary would not run. It is reset by a pass that sends the order, and by the render in
   * which the summary's last entry is fixed, so a summary never reappears for a problem that arose
   * after it was finished with - the message beside that field speaks for it until the next press.
   */
  const [refusedPasses, setRefusedPasses] = useState<number>(0);

  /*
   * An order this tab placed and then lost sight of, by its reference - and `null` in every other
   * case, which is almost always.
   *
   * It is not this submission's order: that one is `placed`, and it is on screen as a receipt. This
   * is the order an earlier attempt from this tab turned out to have placed after the form went
   * away, read back from the attempt record by the mount effect below. Holding it in state is what
   * lets a buyer who left mid-request and came back find their order number instead of nothing,
   * which is the half of the problem that aborting the request cannot fix - the store completes the
   * order either way.
   */
  const [recoveredOrder, setRecoveredOrder] = useState<string | null>(null);

  /*
   * Where the order is going, as the freight lookup and the service group are both given it: the
   * postal-code field trimmed and the country beside it, or `null` while there is nothing to quote
   * for. One `const` each rather than the same expression written at two call sites, because the
   * lookup and the panel must describe one address - a panel priced for a destination the lookup
   * was not asked about would put rates for the previous address beside the new one.
   *
   * The country travels with the code because it is half of the destination: the same five digits
   * are a town in the United States and another in Mexico, quoted differently, and the store's
   * idea of a complete postal code is the chosen country's. A change of either therefore re-quotes.
   */
  const typedPostalCode = address.postalCode.trim();
  const destination = typedPostalCode.length > 0 ? typedPostalCode : null;
  const destinationCountry = address.country.trim().length > 0 ? address.country.trim() : null;

  /*
   * The freight lookup, held here rather than inside the service group, because the rate the buyer
   * is looking at has to reach the review column beside this form - see decision 5 in the header.
   * The panel is handed this state, so it asks nothing itself and the page makes one request per
   * shipment.
   *
   * Every part of the question is passed, and the unit count is not optional in practice.
   * Freight is charged per piece as well as per destination, and `POST /api/checkout` rates the
   * order's freight against the units it reserved - so a lookup that named only the address would
   * be answered for a single unit and would show a buyer a fraction of what their order is about
   * to be charged. `cart.itemCount` is that same unit count, summed across the cart's lines by the
   * provider that owns them.
   *
   * Which is why the destination is withheld until there is a shipment to quote for it. A cart
   * still being read - or one that could not be read - publishes no units, and a question asked
   * then is answered for a single unit: a rate for a shipment nobody is sending, shown as
   * authoritative for the moment between the reply and the cart landing, and then replaced. So the
   * lookup waits for the cart, which is also what makes this page's one quote per shipment one
   * rather than two, and the service group shows no services until the answer arrives.
   *
   * It is withheld while a receipt is on screen as well. There is no service group to quote for
   * then, and the page at an order's own address would otherwise rate whatever cart the session
   * holds now for a form nobody can see.
   */
  const freight = useFreightQuote(
    cart.itemCount > 0 && receipt === null ? destination : null,
    destinationCountry,
    cart.itemCount,
  );

  /*
   * The chosen service as the store currently offers it - the one service this order may be placed
   * with, and the one amount this form is entitled to publish for it.
   *
   * The quote is the store's answer for the destination and the shipment in the fields, and it is
   * the whole of the offer: the service is drawn from `freight.quote.options` and from nowhere
   * else, because a rate is a property of a destination and the store has priced no service for
   * one it has not been given. The
   * buyer's own choice is taken when that offer names it; when the offer does not - it names other
   * services - the first service it does name is taken instead, which is a deliberate reselection
   * from the current offer rather than an unavailable choice left standing, and it is visible as
   * both the checked row and the freight charge beside the order. A stored id therefore never
   * decides anything by itself: it is honoured while the store is offering it and superseded the
   * moment it is not. That is what keeps this form from placing an order on a service
   * `POST /api/checkout` would refuse, since that endpoint re-quotes and accepts only a service its
   * own quote lists. Before a quote has settled - no destination yet, a lookup in flight, a lookup
   * that failed - there is no offer to draw from and therefore nothing chosen: the group shows no
   * services and says why, and a press of the place-order control is refused by the validation pass
   * rather than committing the order to a figure nobody has been quoted. A quote that names no
   * service at all leaves nothing chosen for the same reason, and the group says so.
   *
   * Which is also why the amount comes from here: it is the quote's price for the chosen service,
   * which is both what the panel prints beside the checked row and what the order will be charged.
   * `null` - nothing chosen, or a shipment with no quote - is what tells the review column to print
   * the freight row as a charge still to be confirmed rather than as a zero.
   *
   * `chosenOptionId` is also what the group is told is selected, so the row shown as chosen is a
   * row the store is currently offering and nothing else; before a quote settles there are no rows,
   * so nothing is checked.
   *
   * The transit time is published with the rate for the same reason the rate is: the review column
   * beside this form states when the order arrives, and the answer is a property of the service the
   * buyer picked - a store-wide estimate printed there would contradict the very row it sits next
   * to whenever a buyer chose anything but the middle service.
   *
   * Four primitives rather than an object, because they are what the publishing effect below
   * depends on: an object literal in a dependency array is a fresh identity on every render, so
   * the effect would run on every render rather than when the charge changes.
   */
  const quotedOptions = freight.quote?.options ?? null;
  const quotedChoice =
    quotedOptions === null
      ? undefined
      : (quotedOptions.find((candidate) => candidate.id === shippingOptionId) ??
        quotedOptions.at(0));
  const chosenOptionId = quotedChoice?.id ?? null;
  const chosenOptionLabel = quotedChoice?.label ?? null;
  const chosenOptionAmountCents = quotedChoice?.priceCents ?? null;
  const chosenOptionEstimatedDays = quotedChoice?.estimatedDays ?? null;

  /*
   * What the service group is told is selected: the service drawn from the current quote, and
   * nothing when there is no quote - which is also when the group has no rows to check. Deriving it
   * rather than reading the state directly is what keeps the group from showing a row as chosen on
   * the strength of a selection the store has just said it cannot sell - and it is the same value
   * the draft is assembled from, so what a buyer sees checked and what the order would name are one
   * thing.
   */
  const effectiveOptionId = chosenOptionId;

  const failureRegion = useRef<HTMLDivElement | null>(null);

  // The error summary's container, which takes focus each time a validation pass refuses the order.
  const errorSummary = useRef<HTMLDivElement | null>(null);

  /*
   * The row holding the place-order control, and the cart notice's "Read the cart again" control
   * while that notice is on screen (React sets it back to `null` when the notice unmounts).
   *
   * Pressing that control asks the cart to read itself again, and the cart clears its failure as the
   * read starts, which unmounts the notice - and the control being pressed - before the answer
   * arrives. The submit row is where focus waits in the meantime: it is always rendered, it sits
   * directly below where the notice was, and it holds the control the buyer will want once the cart
   * has been read. `cartRereadFocusPending` marks that a press moved focus there, so the effect that
   * settles it runs for that press and for nothing else.
   */
  const submitRow = useRef<HTMLDivElement | null>(null);
  const cartRereadControl = useRef<HTMLButtonElement | null>(null);
  const cartRereadFocusPending = useRef(false);

  /*
   * The receipt's own container, which takes focus when the receipt replaces the fields.
   *
   * It is this component's business and not the receipt's: `./OrderConfirmation` renders on the
   * server and holds no hook, so the element that can be focused is the wrapper here - and the
   * wrapper is the right thing to focus in any case, because the receipt's heading is the first
   * thing inside it and a reader lands above the whole order rather than part-way into it.
   */
  const confirmationRegion = useRef<HTMLDivElement | null>(null);

  /*
   * The order the page handed over when this form first rendered, by its reference - `null` when
   * it handed over none.
   *
   * It is what tells the two arrivals of a page's order apart. An order that came with the page is
   * a receipt the buyer navigated to, and focus stays where the browser put it. An order that
   * reaches a form already on screen - the App Router keeps this component mounted across a change
   * of the query string alone, so following the link to an order's address from this form's own
   * notice is one - replaces the fields the buyer was using, and focus follows the receipt as it
   * does after a submission. The initial value is the only one ever held: nothing writes it.
   */
  const arrivedWith = useRef<string | null>(suppliedOrderNumber);

  // The name every submission of the order in front of the buyer travels under, drawn on the
  // first one and kept until an order exists. A ref rather than state because nothing renders it
  // and changing it must not re-render anything - and because it has to survive the render that a
  // failure causes, which is the render after which it matters most: the next submission is the
  // one the endpoint has to recognise as the same attempt.
  const attempt = useRef<string | null>(null);

  /*
   * The exact draft the attempt in `attempt` was last sent with, or `null` before it has been sent.
   *
   * Set as each request goes out, and restored from the attempt record on mount, so that resolving
   * an unconfirmed attempt resends precisely what that attempt sent - not what the fields hold now,
   * which the buyer may have changed and a reload will have emptied, and not a service drawn from a
   * quote the cart may no longer be able to get. A ref for the same reasons as `attempt`, and read,
   * like it, only in the submit handler and the effects.
   */
  const sent = useRef<CheckoutDraft | null>(null);

  /*
   * The controller of the submission in flight, or `null` while none is.
   *
   * One controller per submission, held here so the unmount effect below can abort it: a buyer who
   * navigates away is not waiting for this reply any more, and a connection held open for a
   * component that no longer exists is a connection worth releasing. A ref rather than state for
   * the same reason as `attempt` - nothing renders it, and replacing it must not re-render
   * anything.
   *
   * What the abort does NOT do is stop the order, and that asymmetry is the whole reason the
   * attempt record exists: `POST /api/checkout` reads no signal, so the stock reservation, the
   * carrier and the payment all run to completion server-side. So the abort is treated as an
   * unknown outcome rather than as a cancellation, both here and in `@/lib/api-client`, whose
   * `submitCheckout` documentation says the same thing to every other caller.
   */
  const submission = useRef<AbortController | null>(null);

  // The notice announces itself - `Alert`'s `danger` tone renders `role="alert"` - and focus
  // follows it, so a reader using the keyboard lands on the sentence explaining why the order did
  // not go through instead of on the button that appeared to do nothing. It runs from an effect
  // rather than from the handler because the region is rendered by the state this sets: the
  // element exists after that render, not before it.
  useEffect(() => {
    if (failure !== null) {
      failureRegion.current?.focus();
    }
  }, [failure]);

  // A refused validation pass moves the reader to the error summary, which names every problem and
  // links to each field - the pattern a keyboard or screen-reader user can act on without hunting
  // for red text. Like the two regions either side of it, the summary is rendered by the state
  // this follows, so focus is moved once it exists; the count changes on every refusal, which is
  // what moves focus again on a second press of a form that is still wrong.
  useEffect(() => {
    if (refusedPasses > 0) {
      errorSummary.current?.focus();
    }
  }, [refusedPasses]);

  /*
   * Settle where a press of "Read the cart again" left focus, once the read it started has
   * answered.
   *
   * It runs after the commit that publishes the outcome. A read that failed again has mounted a new
   * cart notice, and its control takes focus back from the submit row, so the next Enter reads the
   * cart again; a read that succeeded has made the order placeable, and focus goes on to the
   * place-order control in the row it was waiting in, when that control is available. Nothing moves
   * unless focus is still on the row where the handler put it, and the mark is cleared either way,
   * so a later failure published for an unrelated reason never pulls focus onto its notice.
   * `'loading'` is the read still in flight, so it is skipped.
   */
  useEffect(() => {
    if (!cartRereadFocusPending.current || cart.syncStatus === 'loading') {
      return;
    }

    cartRereadFocusPending.current = false;

    const row = submitRow.current;

    if (row === null || document.activeElement !== row) {
      return;
    }

    (
      cartRereadControl.current ??
      row.querySelector<HTMLButtonElement>('button[type="submit"]:not(:disabled)')
    )?.focus();
  }, [cart.syncStatus]);

  /*
   * Take down the connectivity notice once the connection is back, and nothing else with it.
   *
   * A notice about a submission this form held back for want of a connection stops describing
   * anything the moment the browser can reach the store again, and leaving it up is how a buyer
   * comes to believe a store is down while it is answering. Every other notice stays: `unresolved`
   * may be the only record a buyer has that a payment might have been taken, and `settled` is the
   * store's own answer
   * about this order - a recovered connection says nothing about either, so clearing them would be
   * hiding them. That is what `OrderFailureCopy.kind` is for, and the update is written as a
   * function of the current notice so a failure arriving in the same tick is judged on what it is
   * rather than on what was there when this ran.
   *
   * Two signals say the store is reachable, and both are already here. The browser's own `online`
   * event is the first, listened for while this form is mounted and unlistened in the cleanup, so
   * a form that goes away leaves no handler behind. A freight quote in hand is the second and the
   * stronger of the two: `FreightQuoteState.quote` is non-null only for a settled
   * `GET /api/shipping/quote` for the arguments in hand, which is a round trip to this store that
   * completed - a fact, where `navigator.onLine` is a claim about the network interface. The
   * effect therefore depends on that quote's presence rather than on the notice, which is what
   * keeps a notice raised while a quote is already in hand - the ordinary case for an offline
   * submit, since the quote settled before the connection went - from being cleared by the render
   * that raised it.
   */
  const quoteInHand = freight.quote !== null;

  useEffect(() => {
    const clearConnectivityNotice = (): void => {
      setFailure((current) => (current?.kind === 'connectivity' ? null : current));
    };

    if (quoteInHand) {
      clearConnectivityNotice();
    }

    window.addEventListener('online', clearConnectivityNotice);

    return () => {
      window.removeEventListener('online', clearConnectivityNotice);
    };
  }, [quoteInHand]);

  /*
   * Let go of a submission this form is no longer here to receive.
   *
   * The cleanup runs when the buyer navigates away - the primary navigation is a client-side
   * router, so leaving `/checkout` mid-request unmounts this component while the request is still
   * outstanding. Aborting releases the connection and, more importantly, stops this handler
   * deciding anything on the way out: nothing is stored, nothing is announced as a failure, and no
   * address is pushed for a page the buyer has left.
   *
   * It deliberately does not clear the attempt record. The order may well have been placed - the
   * endpoint does not stop for an abandoned browser - so the record is exactly what should survive
   * this, and the mount effect below is what reads it back.
   *
   * Empty dependencies: this is a lifetime, not a value. The controller is read off the ref at
   * cleanup time, so the submission aborted is whichever one was in flight at that moment.
   */
  useEffect(() => {
    return () => {
      submission.current?.abort();
    };
  }, []);

  /*
   * Pick up an attempt this tab started and never saw the end of.
   *
   * Read once, on mount, and from an effect rather than from the component body: this form is
   * hydrated, so a storage read while rendering would produce markup the server could not have
   * sent and React would report the mismatch. Nothing about the first paint depends on it, so the
   * notice it may raise arrives a frame later, which is the right trade.
   *
   * Two records are worth acting on and they mean different things. One with no order number is an
   * attempt whose outcome nobody established: the buyer is shown {@link INTERRUPTED}, the
   * attempt's own name is restored into `attempt` and the draft it recorded into `sent`, so that
   * pressing the notice's control resends that same attempt exactly as it went out - which the
   * endpoint answers with the order it already holds, rather than placing a second one, however
   * empty the fields and the cart are by now. One WITH an order number is an order that exists and
   * whose receipt this tab never showed - a record is forgotten once its receipt has rendered, so
   * one still carrying an order number is exactly that - and its reference is put in front of the
   * buyer, with a link to the order's own address, where the page renders that receipt and the
   * record is forgotten in turn. If the address already names it, the page has answered for it -
   * with that receipt, or with its own notice when the order could not be shown - and this stays
   * quiet.
   *
   * Both kinds of record are logged where they report something, because a silent failure is the
   * hardest kind to find in production: the line names the attempt and when it went out, which is
   * what makes it worth reading in a bug report. An order the address already names is the
   * exception and is logged by neither: the page is answering for that order, so nothing was lost
   * sight of, and a line saying a receipt was never shown would be untrue of the very page showing
   * it.
   *
   * This is the one effect in the file that publishes state from its own body, and there is no
   * alternative to it: what it publishes comes from session storage, storage cannot be read while
   * rendering - the server has none, so the markup would not be the markup the server sent - and
   * there is nothing to subscribe to, because the record only ever changes as a consequence of
   * this same component submitting or showing a receipt. That is why this effect sets state, the
   * pattern `react-hooks/set-state-in-effect` exists to question. The cost is one extra render per
   * mount, on a page that has finished settling, and only for a buyer who has an unresolved
   * attempt to be told about.
   */
  useEffect(() => {
    const record = readAttemptRecord();

    if (record === null) {
      return;
    }

    const startedAt = new Date(record.startedAt).toISOString();

    if (record.orderNumber === null) {
      attempt.current = record.idempotencyKey;
      sent.current = record.draft;
      // A hydration-safe read of session storage; see the note above this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailure(INTERRUPTED);
      // Whether a draft came back is logged and the draft is not: it holds the buyer's contact
      // and address, which have no place in a console.
      console.warn(
        'Lumen Supply: a checkout attempt was never answered and may have placed an order:',
        { attempt: record.idempotencyKey, startedAt, recorded: record.draft !== null },
      );

      return;
    }

    if (!addressNamesOrder(record.orderNumber)) {
      console.info('Lumen Supply: this tab placed an order it never showed a receipt for:', {
        orderNumber: record.orderNumber,
        startedAt,
      });

      // The same read, publishing the reference instead of the notice; see the note above.
      setRecoveredOrder(record.orderNumber);
    }
  }, []);

  // Focus follows the receipt, for the same reason it follows the failure notice: the control the
  // buyer pressed is gone from the document in the frame the order appears, and a form that
  // unmounts with focus on one of its fields leaves a keyboard or screen-reader user at the top of
  // the document with no cue that anything happened. The wrapper is focusable only
  // programmatically - `tabIndex={-1}` keeps it out of the tab order - so it is a landing point and
  // never a stop on the way through the page. Like the notice's, this runs from an effect because
  // the element exists only after the render this state causes.
  //
  // The same moment ends the attempt record. It was rewritten with this order's reference before
  // the receipt was stored, so a form that went away in between would still have left the
  // evidence; now the receipt is on screen, the record has nothing left to report, and keeping it
  // would raise a false "never showed a receipt" notice on the buyer's next visit to this page.
  //
  // Focus and scroll are separate steps on purpose. `focus()` alone lets the browser choose the
  // scroll, and for a receipt taller than the viewport it centres the box or leaves it where the
  // form was, so the heading the reader should land on ends up above the viewport or under the
  // sticky header. Focusing without scrolling and then aligning the receipt's start edge puts the
  // heading in view whatever the order's length; the alignment honours the document's scroll
  // padding under the header and this wrapper's own scroll margin, and it follows the document's
  // scroll behaviour, so a reader who asked for less motion gets an instant jump.
  useEffect(() => {
    if (placed === null) {
      return;
    }

    const region = confirmationRegion.current;

    if (region !== null) {
      region.focus({ preventScroll: true });
      region.scrollIntoView({ block: 'start', inline: 'nearest' });
    }

    forgetShownAttempt(placed.order.orderNumber);
  }, [placed]);

  /*
   * Whether a receipt is on screen, published for the review column beside this form.
   *
   * A submission publishes it the moment its order lands - see `submitOrder` - and this states the
   * same fact for every other way a receipt comes and goes. An order the page hands over from its
   * address is a receipt on screen from the first render, and the column has to stop reviewing a
   * cart this order was not placed from. And a receipt can go as well as come: the App Router keeps
   * this form and that column mounted across a change of the query string alone, so a buyer who
   * moves from an order's address to a plain `/checkout` is shown the fields again, and the column
   * has to show the review again beside them rather than go on announcing an order the form no
   * longer shows. Publishing the boolean itself, rather than `true` on arrival alone, is what
   * covers both. The publisher ignores a value equal to the one it holds, so a render that changes
   * neither writes no state.
   */
  const showingReceipt = receipt !== null;

  useEffect(() => {
    publishPlacement(showingReceipt);
  }, [showingReceipt, publishPlacement]);

  /*
   * An order the page handed over from its address: a submission's receipt arrived by another
   * route - a reload, a bookmark, Back and Forward, or the link in this form's notice about an
   * order it lost sight of.
   *
   * Once its receipt is on screen the attempt record is forgotten when it names this order, for
   * the reason given beside the effect that focuses a submission's receipt. Focus moves to the
   * receipt only when the order reached a form that was already on screen, whose fields - and the
   * link the buyer followed - have just left the document. An order that arrived with the page is
   * where the buyer asked to be, and moving focus on page load would take the reader's place on the
   * page from them for nothing they did.
   *
   * That focus does not scroll. The receipt takes the place of the fields, so its heading is where
   * the link the buyer followed was - on screen - and letting the browser scroll a card taller than
   * the viewport into view would align its top edge with the window's, under the sticky header.
   *
   * The one dependency is the order's reference, so this runs when the page's order changes and on
   * no other render.
   */
  useEffect(() => {
    if (suppliedOrderNumber === null) {
      return;
    }

    forgetShownAttempt(suppliedOrderNumber);

    if (arrivedWith.current !== suppliedOrderNumber) {
      confirmationRegion.current?.focus({ preventScroll: true });
    }
  }, [suppliedOrderNumber]);

  // The chosen freight charge, published for the review column beside this form. The dependencies
  // are the four primitives the charge is made of and the publisher, which is stable for the life
  // of its provider, so this runs when the chosen service or its quoted rate changes and on no
  // other render - and the value itself is built inside the effect, where a fresh object costs
  // nothing. Nothing the current quote offers - no destination yet, a lookup in flight or failed,
  // a cart too large to quote, a service the quote omits - publishes `null`, which the column
  // renders as a charge still to be established rather than as a zero; the cleanup publishes
  // `null` too, so a form that goes away leaves no freight row behind it. The publisher ignores a
  // value equal to the one already published, so an unchanged charge writes no state.
  useEffect(() => {
    if (
      chosenOptionId === null ||
      chosenOptionLabel === null ||
      chosenOptionAmountCents === null ||
      chosenOptionEstimatedDays === null
    ) {
      publishFreight(null);
    } else {
      publishFreight({
        optionId: chosenOptionId,
        label: chosenOptionLabel,
        amountCents: chosenOptionAmountCents,
        estimatedDays: chosenOptionEstimatedDays,
      });
    }

    return () => {
      publishFreight(null);
    };
  }, [
    chosenOptionId,
    chosenOptionLabel,
    chosenOptionAmountCents,
    chosenOptionEstimatedDays,
    publishFreight,
  ]);

  // Whether the order is being placed, published for the review column beside this form, which
  // holds its lines - their quantity and remove controls - for exactly as long as this form holds
  // its own fields. A layout effect, so the review is held in the same frame the control turns
  // busy rather than one frame after it, when a press on a line could still get through. The
  // cleanup publishes `false`, so a form that goes away mid-request does not leave the review
  // locked for a submission nobody is waiting on.
  useLayoutEffect(() => {
    publishPending(pending);

    return () => {
      publishPending(false);
    };
  }, [pending, publishPending]);

  /*
   * The order as the controls hold it, and everything wrong with it, recomputed on every render.
   *
   * This is where the form's validation lives, and it lives here rather than in the submit handler
   * for two reasons that were both defects while it did. A pass that runs only on submit cannot
   * report anything before the buyer presses, so the line above the place-order control could not
   * say what was still missing. And a pass that stores its result leaves that result standing
   * against values that have since been corrected: "A contact name is required." beside a name.
   * Derived, neither is possible: there is nothing to go stale, and the messages, the counters, the
   * outstanding line, the error summary and the decision to send the order are all read off the
   * same single pass over the same fields.
   *
   * The freight message is merged in here for the same reason it was merged in there: it is the one
   * thing wrong with the order that is settled outside the fields, and the shipping field takes the
   * more specific of the two - "still being quoted" rather than "choose a shipping service".
   */
  //
  // One submission can be two things, and the pass has to know which. Where the notice on screen
  // reports an unresolved outcome, the next press is not a second order but the same attempt sent
  // again, answered from the store's record of it rather than from a fresh quote - and a cart that
  // has already become an order has no quote left to satisfy. What is sent then is the draft the
  // attempt recorded, which this pass does not judge at all (see `submitOrder`); the fields are
  // sent only where no draft was recorded, and for that case the pass judges them with the
  // buyer's own choice of service - the quoted one if a quote is in hand, the one they picked
  // otherwise - and the freight check stands down. Every other message still applies.
  const resolving = failure?.kind === 'unresolved';
  const choice = resolving ? (quotedChoice?.id ?? shippingOptionId) : chosenOptionId;
  const fields = entered(contact, address, choice, notes);
  const problems = collectFieldErrors(fields);
  const freightProblem = resolving ? undefined : freightSelectionProblem(freight, quotedChoice);

  if (freightProblem !== undefined) {
    problems.shippingOptionId = freightProblem;
  }

  /*
   * The messages the buyer is shown: the problems above, less the fields they have not finished
   * with yet. `submitted` opens all of them at once; until then a field speaks when focus has left
   * it, and once it has spoken it keeps speaking - and stops the moment the value is valid,
   * because there is no longer a problem for it to report.
   */
  const revealed: CheckoutFieldErrors = {};

  for (const field of FIELDS) {
    const problem = problems[field.key];

    if (problem !== undefined && (submitted || touched[field.key] === true)) {
      revealed[field.key] = problem;
    }
  }

  /*
   * The postal field's hint.
   *
   * It is the field's one affirmative sentence, and it is earned rather than printed: only a
   * settled quote means freight *has* been quoted for this destination. Without one the hint is
   * the chosen country's own format, which is what a buyer needs in order to write a destination
   * the store can quote - and never a promise about a value the store has just refused.
   *
   * And it stands down entirely while the field is showing a fault, because the fault already
   * carries that format: `@/lib/destination` ends each postal-code message with the same sentence,
   * so a hint printed beside one would set the identical words four pixels apart and read as a
   * duplicated paragraph. One sentence, in the red text a buyer is being asked to act on. The
   * destination judgement itself reaches the two controls through the pass above - it is part of
   * `problems`, so it is revealed on the same terms as every other message - and the service group
   * below captions its empty list with the same judgement while the buyer is still typing.
   */
  const selectedDestination = freightDestination(address.country);
  const postalCodeHint =
    revealed.postalCode !== undefined
      ? undefined
      : freight.quote !== null
        ? QUOTED_DESTINATION_HINT
        : selectedDestination === undefined
          ? UNSERVED_DESTINATION_HINT
          : freightPostalCodeHint(selectedDestination);

  /*
   * Whether the country the draft carries is one this store offers.
   *
   * A `<select>` can only display a value one of its options carries, so a country outside the
   * offered list would leave the control showing the first destination while the draft carried the
   * other value - the screen saying one thing and the request another. The field below therefore
   * carries an option for whatever the state holds whenever that is not on the list, so what is on
   * screen is always what would be sent, and the pass above says beside it that the store does not
   * ship there. Only an in-page script can reach this, by adding an option and taking it away
   * again, which is why the option is a fallback rather than part of the list.
   */
  const offered = FREIGHT_DESTINATIONS.some((destination) => destination.code === address.country);

  /**
   * Remember that the buyer has finished with `field`, so its message may be shown.
   *
   * Returns the same object when the field is already touched, so blurring an already-blurred
   * field writes no new state.
   */
  function touch(field: CheckoutFieldKey): void {
    setTouched((current) => (current[field] === true ? current : { ...current, [field]: true }));
  }

  /**
   * Place the order - or resolve the attempt that may already have placed it.
   *
   * The whole path, in order: stop the browser navigating; refuse a second submission while one is
   * running; name the attempt, once, and keep that name for every submission of this order; take
   * the draft - the one the attempt recorded when this press resolves it, the fields otherwise -
   * and, for the fields, reveal every message the validation pass above has already produced and
   * stop there if anything is wrong, with the reader moved to the error summary that lists them;
   * hold the submission back if the browser has no connection; drop any notice a new order
   * supersedes; hand focus to the submitting control before the fields lock; then one request,
   * whose two outcomes are a stored order and a receipt, or a notice above the submit row with
   * every typed value still in place - and focus follows either one there.
   *
   * It validates nothing itself, and that is deliberate rather than an omission: the pass runs on
   * every render, so by the time this handler is reached its result is already the result for the
   * values on screen. Running it again here would be the same pass over the same fields, and
   * storing that result is what made a corrected field keep its old message.
   *
   * ONE SUBMISSION CAN BE TWO THINGS. Where the notice on screen reports an unresolved outcome,
   * pressing its control is not a second order: it is the same attempt sent again, which the
   * endpoint answers with the order it already holds - or completes, if the store never received
   * it. So what is sent is what the attempt sent: the draft this mount last sent under its name, or
   * the one its record kept across a reload, verbatim. None of this form's gates stands in front of
   * it - the fields may have been edited or emptied since, a cart that has already become an order
   * holds nothing and has no quote left to satisfy, and the endpoint checks the draft again
   * regardless - and none of them is needed to prevent a second order, because the name is the
   * attempt's and the endpoint answers it from its own record. Only a record with no draft - one
   * written before records kept one - falls back to the fields, judged by the pass above with the
   * buyer's own choice of service and without the freight check. And the notice stays up while
   * the check runs: it leaves the screen when the store establishes the outcome - a receipt, or the
   * store's own answer that no order was placed - and on nothing less, because erasing the only
   * record of a possible charge before then would be the worst thing this handler could do.
   *
   * CONNECTIVITY IS ASKED BEFORE ANYTHING IS SENT. A browser that reports no connection has the
   * submission held back: nothing is recorded and nothing is sent. A new order is answered with
   * {@link OFFLINE}, the one notice that may say nothing was sent, because here that is this form's
   * own fact; a check of an unresolved attempt leaves that attempt's notice exactly as it was and
   * says in a toast that checking needs a connection. The answer is never read off a rejected
   * request, which cannot say whether it arrived.
   *
   * WHAT SURVIVES IT. The attempt - its name, the instant it began and the exact draft sent - is
   * written to session storage before the request leaves and replaced with the order's own
   * reference alone when the store answers with one, because this component cannot be relied on
   * to still be here when it does - a buyer who navigates away mid-request has the abort in the
   * unmount effect above release the connection, while `POST /api/checkout` carries the order out
   * regardless. So an abort is reported to nobody as a failure (the buyer asked to leave; that is
   * not a failure) and stores nothing, and the record it leaves behind is what the next mount
   * reads. A failure that establishes no order exists - the store's own refusal, or a failure of
   * this page before a new order's request left it - drops the record instead; every other failure
   * keeps it.
   *
   * The request is classified on its own, and what follows a success is not. A consumer's
   * `onOrderPlaced` runs after the order has been stored and announced, outside anything that
   * treats a thrown value as a failed checkout - a handler that throws is a bug in the surrounding
   * page, and reporting an order that exists as an order that does not would be a worse one. It is
   * logged where a developer will see it and nowhere a buyer will.
   *
   * Nothing else belongs here. It starts no timer, measures nothing, retries nothing on its own,
   * batches nothing and empties no cart: the cart is converted by the endpoint, and a second
   * request from this handler would only add work to the interaction a buyer is waiting on.
   */
  async function submitOrder(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (pending) {
      return;
    }

    // The control that submitted the form: the place-order control or the failure notice's, and
    // also the one an Enter in a field submits through, since a browser performs that implicit
    // submission by clicking the form's default button. Read now, while the event is current, for
    // the focus hand-off just before the request goes out. `SubmitEvent` is checked for rather than
    // assumed, so an engine without it simply skips the hand-off.
    const native = event.nativeEvent;
    const submitter =
      typeof SubmitEvent !== 'undefined' && native instanceof SubmitEvent ? native.submitter : null;

    // Drawn on the first submission and reused by every later one, so a buyer pressing the
    // control again after an unconfirmed outcome resolves that attempt instead of starting
    // another. An order that was placed ends the form, so a name is never reused for a second
    // order.
    attempt.current ??= attemptKey();

    const key = attempt.current;

    // The record of the attempt being resolved, read once for the two things it may still hold:
    // the draft to send again, and the instant the attempt began. Its draft is taken only when it
    // was recorded under this very name, so a resolution can never travel under another attempt's.
    const earlier = resolving ? readAttemptRecord() : null;
    const recorded = resolving
      ? (sent.current ?? (earlier?.idempotencyKey === key ? earlier.draft : null))
      : null;

    let draft: CheckoutDraft;

    if (recorded !== null) {
      // The attempt's own body, exactly as it went out: see ONE SUBMISSION CAN BE TWO THINGS above.
      draft = recorded;
    } else {
      // The service the draft names is the chosen service *as the current quote offers it*, so an
      // order is never sent naming a service the store has not just quoted - an id the quote omits
      // reaches the draft as the empty string, exactly as no choice at all does. The freight
      // message then replaces the generic "choose a shipping service" wording with the reason that
      // actually applies, in the same single validation pass: a group still being quoted, one that
      // could not be quoted, a destination with no service, or a cart too large to quote.
      //
      // A resolution with no recorded draft is the exception to both, and for one reason: it is
      // answered from the store's record of the attempt rather than from a quote, so requiring a
      // current offer would leave the control dead in the one situation it exists for - a cart
      // that has already become an order is no longer quotable. The draft therefore names the
      // buyer's own choice, the quoted one where a quote is in hand and the one they picked
      // otherwise, which is `choice` above.
      draft = checkoutDraftFrom(contact, address, choice, notes, key);

      // Somebody who has pressed this has finished with every field, so every message the pass
      // above produced is now theirs to see. The notice from an earlier attempt is NOT cleared
      // here - see below: a submission the pass stops has sent nothing, and a notice about a
      // possible charge has to outlive it.
      setSubmitted(true);

      // Nothing is sent while anything is wrong, and the reader is put where the work is: the
      // error summary at the top of the form, which the refusal count below renders and the effect
      // above focuses. It names every problem, in on-screen order and in each field's own words,
      // and each entry is a link that moves focus to its field - so the reader hears the whole of
      // what is wrong once, and reaches any one of the fields from it in a single press. Without
      // this the press moves nothing - the messages appear above the fold, the caret stays on the
      // control that appeared to do nothing, and a reader using the keyboard is told nothing.
      if (FIELDS.some((field) => problems[field.key] !== undefined)) {
        setRefusedPasses((count) => count + 1);

        return;
      }

      // The pass let the order through, so there is nothing left for a summary to list.
      setRefusedPasses(0);
    }

    // Asked of the browser before anything is written down or sent, which is the only moment the
    // answer establishes something: a submission held back here provably reached nobody. See
    // CONNECTIVITY above. `navigator` is read defensively: where there is none, nothing is known
    // about the connection and the submission goes ahead.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (resolving) {
        showToast({
          tone: 'warning',
          title: 'Checking this order needs a connection',
          body: 'Nothing was sent. Reconnect, then check the order again.',
        });
      } else {
        setFailure(OFFLINE);
        showToast({ tone: 'danger', title: OFFLINE.title });
      }

      return;
    }

    // A new order supersedes the notice from the previous one now and not before: a submission
    // stopped above sent nothing, and a notice about a possible charge has to outlive a press that
    // never left this page. A check of an unresolved attempt clears nothing - its notice leaves
    // only when the store answers.
    if (!resolving) {
      setFailure(null);
    }

    // The fields lock for the length of the request (the `<fieldset disabled>` below), and a field
    // that is disabled while it holds focus drops that focus onto `<body>`. An order submitted by
    // Enter in a field is exactly that case, so focus is handed to the control the form submitted
    // through - which stays focusable while it is busy - before the lock is written. A press of the
    // control itself already has focus there, and is left alone.
    if (submitter !== null && document.activeElement !== submitter) {
      submitter.focus();
    }

    setPending(true);

    // The attempt, written down before it goes out, so a reply this component never receives still
    // leaves a trail: the name to resolve it under, the instant it started and the draft to resend.
    const controller = new AbortController();
    const requestStartedAt = Date.now();

    // When the attempt began, which is not the same instant as this request. A submission
    // resolving an earlier attempt carries that attempt's name, so it is the same attempt and the
    // same possible charge; the record's instant is the one thing that says how long ago that
    // charge could have been taken, and stamping it with a press made twenty minutes later would
    // throw that away. A fresh attempt began now, and a record that cannot be read back is treated
    // as one, which is the same answer `readAttemptRecord` gives a first-time buyer.
    const attemptStartedAt = earlier?.startedAt ?? requestStartedAt;

    submission.current = controller;
    sent.current = draft;
    rememberAttempt({
      idempotencyKey: draft.idempotencyKey,
      startedAt: attemptStartedAt,
      orderNumber: null,
      draft,
    });

    let result: CheckoutResult;

    try {
      result = await submitCheckout({ draft, signal: controller.signal });
    } catch (cause) {
      // The abort this form raised as it went away. The buyer asked to leave, so there is nothing
      // to report to them and no state of this component's left to report it in - but the order
      // may exist, so the record stays where the next mount will find it, and the abandonment is
      // logged rather than passed over in silence.
      if (controller.signal.aborted) {
        console.warn(
          'Lumen Supply: a checkout request was abandoned when the form went away; it may still have placed an order:',
          { attempt: draft.idempotencyKey, waitedMs: Date.now() - requestStartedAt },
        );

        return;
      }

      // While resolving, only the store's own answer can settle the attempt. A failure this page
      // raised says nothing about an attempt that went out earlier, so it leaves that attempt as
      // unconfirmed as it was rather than reading as "nothing was charged". The store's answer can
      // be trusted here even when it is about the cart - empty, held, taken by another checkout:
      // the endpoint asks its own record of this attempt's name again before it gives any such
      // refusal, so a refusal it does give means the name holds no order and no charge.
      const answered = cause instanceof StorefrontApiError && cause.reported;
      const copy = resolving && !answered ? UNCONFIRMED : checkoutFailureCopy(cause);

      // Only a failure that establishes no order exists - the store's own refusal, or a failure of
      // this page before a new order's request left it - takes the record with it, so the next
      // mount does not raise a notice about an attempt that is settled. Every unresolved outcome,
      // a rejected request included, keeps it.
      if (copy.kind === 'settled') {
        forgetAttempt();
      }

      setFailure(copy);
      showToast({ tone: 'danger', title: copy.title });

      return;
    } finally {
      if (submission.current === controller) {
        submission.current = null;
      }

      setPending(false);
    }

    const replayed = result.outcome === 'already_placed';
    // The form went away while this was in flight, so the receipt has nobody to render it for and
    // the address bar belongs to whatever page the buyer is on now. The order is real either way:
    // the record below is how they find it, and the toast is announced from the provider above this
    // component, which is still mounted.
    const abandoned = controller.signal.aborted;

    // The order's reference replaces the draft: the store holds the contact and the address now,
    // and this tab has no further use for its own copy of them. It is written before the receipt
    // is stored and forgotten only once the receipt has rendered - the effect that focuses the
    // receipt does that - so a form that goes away in between still leaves it for the next mount.
    rememberAttempt({
      idempotencyKey: draft.idempotencyKey,
      startedAt: attemptStartedAt,
      orderNumber: result.order.orderNumber,
      draft: null,
    });

    if (abandoned) {
      console.warn('Lumen Supply: an order was placed after its checkout form went away:', {
        orderNumber: result.order.orderNumber,
        waitedMs: Date.now() - requestStartedAt,
      });
    } else {
      // The order's own address, pushed before the receipt is stored so the two arrive together and
      // the history entry the buyer can go Back from is the page they were filling in. The receipt
      // is the store establishing the outcome, so an unresolved notice ends with it.
      pushOrderAddress(result.order.orderNumber);
      setFailure(null);
      setPlaced(result);

      // An order exists, which ends the review column beside this form: the cart it was reviewing
      // has become that order, its lines were priced when the order was written and the receipt is
      // where the figures that apply are printed, so a column still listing them would quote an
      // estimate the buyer was charged something else for and offer quantity controls over a cart
      // the store has closed. Told only while the form is still here, because the column is.
      publishPlacement(true);
    }

    // The cart is read again whether or not this form is still on screen, because every surface of
    // the storefront is still holding the one from before the order - the header badge, the drawer,
    // and this page's own submit gate, which stays armed for as long as it is holding lines it
    // believes in. The read is how that is settled: the store answers with the cart it holds now,
    // or that it holds none, and each of those surfaces shows what it answered instead of the
    // figures from before. It is fired and not awaited - the receipt does not wait on the cart -
    // and it publishes its own outcome, which is why there is nothing to catch here.
    void cart.refreshCart();

    showToast({
      tone: 'success',
      title: replayed ? 'This order was already placed' : 'Order placed',
      body: `Order ${result.order.orderNumber} is confirmed.`,
    });

    try {
      onOrderPlaced?.(result);
    } catch (cause) {
      console.error('Lumen Supply: a checkout consumer failed after the order was placed:', cause);
    }
  }

  // The receipt replaces the fields, whichever way it arrived. A submission's is headed for the
  // moment it answers; an order the page read back from its address takes the receipt's default
  // heading, which states that the order is placed without thanking the buyer for a submission
  // they did not just make.
  if (receipt !== null) {
    return (
      <div className={clsx(styles.root, className)}>
        <div className={styles.confirmation} ref={confirmationRegion} tabIndex={-1}>
          <OrderConfirmation
            order={receipt}
            headline={
              placed === null
                ? undefined
                : placed.outcome === 'already_placed'
                  ? 'This order was already placed'
                  : 'Thank you for your order'
            }
          />
        </div>
      </div>
    );
  }

  // What the cart is, as this form has to treat it. A cart the provider could not read publishes
  // no lines and a failure, which reads exactly like a cart somebody emptied - so the two are told
  // apart here: a failure with nothing published is a cart whose contents are unknown, and an
  // order cannot be priced against a cart nobody has read. A failure that arrived after the cart
  // had been read leaves the lines it read in place, and those are still the figures to show.
  const cartUnknown = cart.syncStatus === 'error' && cart.lineCount === 0;

  // An order needs something to ship, a cart this form has read, and a request the endpoint would
  // accept. The third is the whole of the validation pass rather than a chosen subset of it, which
  // is the difference between an order that can be placed and one whose freight has merely been
  // quoted: an address with no city is an order `POST /api/checkout` refuses, so it is not sent,
  // exactly as a shipment nobody has quoted is not. Both of the freight obstacles are part of that
  // pass - a shipment too large to quote and a service the settled quote does not offer are what
  // `freightSelectionProblem` reports - so neither is repeated here.
  //
  // The first two decide whether the place-order control is available at all, because nothing a
  // buyer can type fixes them: a cart that holds nothing, and a cart that could not be read -
  // unavailable on the strength of not knowing rather than of knowing the cart is empty. The third
  // does not, deliberately: the control stays available while the fields are incomplete, so that
  // pressing it - or pressing Enter in a field, which submits through it - runs the pass, which
  // refuses the order, reveals every message and moves the reader to the error summary. A control
  // made unavailable by the pass would refuse the press instead, and the reader would be told
  // nothing at the moment they asked.
  //
  // Never hidden and never silent: `outstanding` below names what is missing beside the control,
  // and every field with something wrong says so itself once the buyer has finished with it.
  const cartOrderable = !cartUnknown && cart.itemCount > 0;
  const readyToPlaceOrder = cartOrderable && Object.keys(problems).length === 0;

  // What the place-order control is waiting for, named the way the labels above the fields name it
  // and in the order they are read. A cart the storefront could not read is left out: its own
  // notice is the explanation, and this line would only repeat it in weaker words.
  const outstanding = FIELDS.filter((field) => problems[field.key] !== undefined).map(
    (field) => field.label,
  );

  let blocked: string | null = null;

  if (!readyToPlaceOrder && !cartUnknown) {
    blocked =
      cart.itemCount === 0
        ? 'Place order becomes available once the cart holds something to ship.'
        : `Complete these before the order can be placed: ${listed(outstanding)}.`;
  }

  // The error summary's entries: every problem the buyer is being shown, in on-screen order, each
  // with the id of the element its link moves focus to. Read off `revealed` rather than `problems`,
  // so the summary lists exactly the messages printed beside the fields and an entry leaves the list
  // the moment its field is corrected. The summary is shown only after a refused pass, and only
  // while there is something left to list.
  const summaryProblems = FIELDS.flatMap((field) => {
    const message = revealed[field.key];

    return message === undefined ? [] : [{ ...field, message }];
  });

  // A summary whose last entry has been fixed is finished with, so the refusal count goes back to
  // zero and the summary is retired. Without this, a field emptied later - to retype an address,
  // say - would bring the summary back while the buyer is typing, and `Alert`'s `danger` tone
  // would announce it assertively; a new problem is left to the message beside its field until the
  // next press. Adjusted while rendering, guarded by the state it writes, rather than from an
  // effect: React re-runs this render with the new count before anything reaches the screen.
  if (refusedPasses > 0 && summaryProblems.length === 0) {
    setRefusedPasses(0);
  }

  const showErrorSummary = refusedPasses > 0 && summaryProblems.length > 0;

  return (
    <form
      className={clsx(styles.root, className)}
      aria-label="Checkout details"
      noValidate
      onSubmit={(event) => {
        void submitOrder(event);
      }}
    >
      {/* An order this tab placed and never showed a receipt for, named at the top of the form
          because it is the first thing its buyer needs: the reference, and somewhere to go for the
          rest of it. `success` rather than `danger` - the order exists and nothing went wrong with
          it - which `Alert` announces politely, and the form below stays as it was, since the cart
          it would order is already an order. It appears only where the address does not name the
          order itself; there `app/checkout/page.tsx` has already answered for it.

          Two routes out, most specific first. The order's own address is where its receipt is:
          the page reads the order back and this form renders it in place of the fields, which is
          also what forgets the record behind this notice. Following that link takes the notice
          down in the same click, because the App Router may keep this form mounted across the
          change of query string, and a notice still up when the buyer comes back from the receipt
          would be announcing a receipt they have now seen. The order history is the second route,
          offered as somewhere to go rather than as a promise - see `ORDERS_PATH`. */}
      {recoveredOrder === null ? null : (
        <div className={styles.orderNotice}>
          <Alert
            tone="success"
            title={`Order ${recoveredOrder} is placed`}
            actions={
              <>
                <Link
                  className={styles.noticeLink}
                  href={orderAddress(recoveredOrder)}
                  onClick={() => {
                    setRecoveredOrder(null);
                  }}
                >
                  View this order
                </Link>
                <Link className={styles.noticeLink} href={ORDERS_PATH}>
                  View your orders
                </Link>
              </>
            }
          >
            {'This order was placed from this browser while the confirmation was not on screen, ' +
              'so it is named here instead. View it for the full receipt, and quote the order ' +
              'number to Lumen Supply about anything to do with this order.'}
          </Alert>
        </div>
      )}

      {/* The error summary: shown when a validation pass has refused the order, at the top of the
          fields so it is the first thing a reader moved here meets, and focused by the effect that
          follows `refusedPasses`. The wrapper is the focus target - programmatic only, so it is
          never a tab stop - and `Alert`'s `danger` tone is the failure notice's own treatment, so
          the storefront states one kind of problem one way. The heading is an `h2`, a sibling of
          the field groups' headings, so the summary is reachable by heading as well.

          Each entry is a real link to its field's id, so it reads and behaves as a link - and still
          lands on the field with no scripting running - while the handler moves focus to the
          control itself: a fragment navigation scrolls to an element without focusing it, and the
          shipping group's entry needs {@link focusCheckoutControl} to find the radio to land on.
          The link text is the field's label and its own message, the words printed beside it. */}
      {showErrorSummary ? (
        <div className={styles.errorSummary} ref={errorSummary} tabIndex={-1}>
          <Alert tone="danger" title={ERROR_SUMMARY_TITLE} titleAs="h2">
            <p className={styles.errorSummaryLead}>{errorSummaryLead(summaryProblems.length)}</p>
            <ul className={styles.errorSummaryList}>
              {summaryProblems.map((problem) => (
                <li key={problem.key}>
                  <a
                    className={styles.noticeLink}
                    href={`#${problem.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      focusCheckoutControl(problem.id);
                    }}
                  >
                    {`${problem.label}: ${problem.message}`}
                  </a>
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      {/* Every field of the order in one group that locks while the order is in flight.
          A submission carries the values the draft was assembled from, so an edit made after it
          went out cannot reach the order it would appear to change - the buyer would be typing into
          a request that has already left. `disabled` on the group is the whole of the lock: it is
          the one attribute that makes every control inside it inert and announced as unavailable,
          including the ones this form composes through `FormField`, and the primitives' own
          `:disabled` treatments give it its appearance without this module restating any of them.
          The freight group inside is also passed `pending` in its own right, so it reads as
          unavailable whether it is read through this group or on its own. A disabled field cannot
          keep focus, which is why `submitOrder` hands focus to the submitting control, outside this
          group, before it sets `pending`.

          `styles.fields` is a reset: it removes the border, padding and min-width a fieldset
          arrives with, and lays the four groups below out as `.root`'s column does - same
          direction, same gap - so the rhythm, the hairline between consecutive groups and the
          field grid's container query all resolve against the form. */}
      <fieldset className={styles.fields} disabled={pending}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Contact details</h2>

          <div className={styles.grid}>
            <FormField
              id={CONTACT_NAME_ID}
              label="Contact name"
              required
              error={revealed.name}
              count={{ length: fields.contact.name.length, max: MAX_NAME_LENGTH }}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  name="name"
                  autoComplete="name"
                  required
                  value={contact.name}
                  invalid={revealed.name !== undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setContact((current) => ({ ...current, name: event.target.value }));
                  }}
                  onBlur={() => {
                    touch('name');
                  }}
                />
              )}
            </FormField>

            <FormField
              id={CONTACT_COMPANY_ID}
              label="Company"
              error={revealed.company}
              count={{ length: fields.contact.company?.length ?? 0, max: MAX_COMPANY_LENGTH }}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  name="company"
                  autoComplete="organization"
                  value={contact.company}
                  invalid={revealed.company !== undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setContact((current) => ({ ...current, company: event.target.value }));
                  }}
                  onBlur={() => {
                    touch('company');
                  }}
                />
              )}
            </FormField>

            <FormField
              id={CONTACT_EMAIL_ID}
              label="Email"
              hint="The order confirmation and dispatch notice are sent here."
              required
              error={revealed.email}
              count={{ length: fields.contact.email.length, max: MAX_EMAIL_LENGTH }}
              className={clsx(styles.fieldWide)}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  value={contact.email}
                  invalid={revealed.email !== undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setContact((current) => ({ ...current, email: event.target.value }));
                  }}
                  onBlur={() => {
                    touch('email');
                  }}
                />
              )}
            </FormField>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Shipping address</h2>

          <div className={styles.grid}>
            <FormField
              id={ADDRESS_LINE1_ID}
              label="Street address"
              required
              error={revealed.line1}
              count={{ length: fields.shippingAddress.line1.length, max: MAX_ADDRESS_LINE_LENGTH }}
              className={clsx(styles.fieldWide)}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  name="line1"
                  autoComplete="address-line1"
                  required
                  value={address.line1}
                  invalid={revealed.line1 !== undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setAddress((current) => ({ ...current, line1: event.target.value }));
                  }}
                  onBlur={() => {
                    touch('line1');
                  }}
                />
              )}
            </FormField>

            <FormField
              id={ADDRESS_LINE2_ID}
              label="Suite, unit or floor"
              error={revealed.line2}
              count={{
                length: fields.shippingAddress.line2?.length ?? 0,
                max: MAX_ADDRESS_LINE_LENGTH,
              }}
              className={clsx(styles.fieldWide)}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  name="line2"
                  autoComplete="address-line2"
                  value={address.line2}
                  invalid={revealed.line2 !== undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setAddress((current) => ({ ...current, line2: event.target.value }));
                  }}
                  onBlur={() => {
                    touch('line2');
                  }}
                />
              )}
            </FormField>

            <FormField
              id={ADDRESS_CITY_ID}
              label="City"
              required
              error={revealed.city}
              count={{ length: fields.shippingAddress.city.length, max: MAX_CITY_LENGTH }}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  name="city"
                  autoComplete="address-level2"
                  required
                  value={address.city}
                  invalid={revealed.city !== undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setAddress((current) => ({ ...current, city: event.target.value }));
                  }}
                  onBlur={() => {
                    touch('city');
                  }}
                />
              )}
            </FormField>

            <FormField
              id={ADDRESS_REGION_ID}
              label="State or region"
              required
              error={revealed.region}
              count={{ length: fields.shippingAddress.region.length, max: MAX_REGION_LENGTH }}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  name="region"
                  autoComplete="address-level1"
                  required
                  value={address.region}
                  invalid={revealed.region !== undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setAddress((current) => ({ ...current, region: event.target.value }));
                  }}
                  onBlur={() => {
                    touch('region');
                  }}
                />
              )}
            </FormField>

            {/*
              The hint says what is true of the destination in the field rather than a single
              sentence for every state of it. A quote in hand is the only state in which freight
              *has* been quoted for this destination, so that is the only state that says so; a
              field that has not been asked about carries the country's own format instead, which is
              what a buyer needs in order to write one; and a field at fault carries no hint at all,
              because the fault below it ends with that same format sentence. The error is the live
              destination judgement, and it holds whatever the submit pass last wrote: a fault the
              buyer can see as they type is worth more than one they are shown after pressing a
              button, and the two agree because both read the same module.
            */}
            <FormField
              id={ADDRESS_POSTAL_CODE_ID}
              label="Postal code"
              hint={postalCodeHint}
              required
              error={revealed.postalCode}
              count={{
                length: fields.shippingAddress.postalCode.length,
                max: MAX_POSTAL_CODE_LENGTH,
              }}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  name="postalCode"
                  autoComplete="postal-code"
                  required
                  value={address.postalCode}
                  invalid={revealed.postalCode !== undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setAddress((current) => ({ ...current, postalCode: event.target.value }));
                  }}
                  onBlur={() => {
                    touch('postalCode');
                  }}
                />
              )}
            </FormField>

            <FormField id={ADDRESS_COUNTRY_ID} label="Country" required error={revealed.country}>
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  name="country"
                  autoComplete="country"
                  required
                  value={address.country}
                  invalid={revealed.country !== undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setAddress((current) => ({ ...current, country: event.target.value }));
                  }}
                  onBlur={() => {
                    touch('country');
                  }}
                >
                  {FREIGHT_DESTINATIONS.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label}
                    </option>
                  ))}
                  {offered ? null : <option value={address.country}>{address.country}</option>}
                </Select>
              )}
            </FormField>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Delivery options</h2>

          {/* The error summary's target for the shipping entry (see `SHIPPING_GROUP_ID`). It is
              focusable only programmatically, and takes focus itself only when no service has been
              quoted to land on - the reader then arrives at the group's own explanation. */}
          <div className={styles.shipping} id={SHIPPING_GROUP_ID} tabIndex={-1}>
            <ShippingOptionPicker
              selectedId={effectiveOptionId}
              postalCode={destination}
              country={destinationCountry}
              quote={freight}
              disabled={pending}
              onSelect={(optionId) => {
                setShippingOptionId(optionId);
                touch('shippingOptionId');
              }}
            />

            {revealed.shippingOptionId === undefined ? null : (
              <Alert tone="warning">{revealed.shippingOptionId}</Alert>
            )}
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Delivery notes</h2>

          <div className={styles.grid}>
            {/* The one field of this form that is a paragraph rather than a line, so the control is
                the one the hint invites: several hundred characters of dock hours and reference
                numbers belong on several lines, and a single-line box shows a buyer four words of
                what they wrote. `NOTES_ROWS` is what it opens at; the stylesheet lets it be dragged
                taller and never wider. */}
            <FormField
              id={DELIVERY_NOTES_ID}
              label="Notes for the warehouse"
              hint="Dock hours, a purchase-order reference, anything the packers should know."
              error={revealed.notes}
              count={{ length: fields.notes?.length ?? 0, max: MAX_NOTES_LENGTH }}
              className={clsx(styles.fieldWide)}
            >
              {({ id, describedBy }) => (
                <Textarea
                  rows={NOTES_ROWS}
                  id={id}
                  name="notes"
                  value={notes}
                  invalid={revealed.notes !== undefined}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setNotes(event.target.value);
                  }}
                  onBlur={() => {
                    touch('notes');
                  }}
                />
              )}
            </FormField>
          </div>
        </section>
      </fieldset>

      {failure === null ? null : (
        <div className={styles.failure} ref={failureRegion} tabIndex={-1}>
          <Alert
            tone="danger"
            title={failure.title}
            actions={
              // Held while a submission is in flight, because an unresolved notice stays on screen
              // while its attempt is being checked and pressing it again would only be refused by
              // the handler. Held with `busy` rather than `disabled`: this is the control the buyer
              // pressed to check the order, so it is holding focus, and a disabled control would
              // drop that focus onto `<body>` for the length of the check.
              <Button type="submit" variant="secondary" size="sm" busy={pending}>
                {failure.action}
              </Button>
            }
          >
            {failure.body}
          </Alert>
        </div>
      )}

      {/* A cart larger than one shipment is stated here rather than discovered by the buyer when
          the order is refused: freight is quoted per shipment, so this cart has no quote and no
          freight charge, and the validation pass refuses the order until it fits. This notice is
          the one that says what to do about it - the service group's own caption states the two
          figures beside the empty group, so neither surface repeats the other's sentence - and it
          appears as soon as the cart passes the ceiling, announced by `Alert`'s `danger` tone, and
          goes away as soon as it no longer does. */}
      {freight.shipmentLimit === null ? null : (
        <div className={styles.cartNotice}>
          <Alert tone="danger" title="This order is larger than one shipment">
            {'Lumen Supply quotes freight one shipment at a time. Reduce the cart to ' +
              `${formatQuantityLabel(freight.shipmentLimit.maxUnits)} units or fewer on the cart ` +
              'page, or order the rest separately, and shipping services will be quoted for it.'}
          </Alert>
        </div>
      )}

      {cartUnknown ? (
        <div className={styles.cartNotice}>
          {/* The heading comes from the cart rather than being fixed here, so it names the same
              operation as the sentence under it: the cart publishes both together, and a notice
              headed for one operation over wording about another tells a buyer to fix something
              that is not broken. The fallback covers the one case the cart publishes no wording
              for, which is a read that never answered at all. */}
          <Alert
            tone="danger"
            title={cart.cartErrorTitle ?? CART_UNREAD_TITLE}
            actions={
              // The read clears the cart's failure as it starts, which unmounts this notice and the
              // control being pressed, so focus is moved to the submit row first - only when it is
              // on this control - and settled by the effect that follows `cart.syncStatus`.
              <Button
                ref={cartRereadControl}
                variant="secondary"
                size="sm"
                onClick={() => {
                  const row = submitRow.current;

                  if (row !== null && document.activeElement === cartRereadControl.current) {
                    row.focus();
                    cartRereadFocusPending.current = true;
                  }

                  void cart.refreshCart();
                }}
              >
                Read the cart again
              </Button>
            }
          >
            {cart.cartError ??
              'Lumen Supply could not read what is in your cart, so this order cannot be priced yet.'}
          </Alert>
        </div>
      ) : null}

      {/* What still stands between the buyer and the order, in the words of the labels above the
          fields, directly above the control: why it is unavailable while the cart holds nothing,
          and what a press would be refused for while fields are incomplete - so the answer is on
          screen before the press as well as in the error summary after it. `role="status"` rather
          than an alert, because this is guidance and not a failure - and because its text changes
          only when a field's validity changes, never on a keystroke, so it announces once per
          thing settled. */}
      {blocked === null ? null : (
        <p className={styles.outstanding} role="status">
          {blocked}
        </p>
      )}

      {/* `tabIndex={-1}` makes the row a programmatic landing place and never a tab stop: focus
          waits here while the cart notice's "Read the cart again" is answered (see the refs). */}
      <div className={styles.submitRow} ref={submitRow} tabIndex={-1}>
        {/* Unavailable only for a cart there is nothing to order from; incomplete fields leave it
            available so a press runs the validation pass (see `cartOrderable`). */}
        <CheckoutButton pending={pending} disabled={!cartOrderable} />

        {/* The line beside the control quotes what is about to be ordered, so it appears only
            where there is a cart to quote: neither a cart still being read nor one that could not
            be read has figures, and printing a zero for either would be this form asserting an
            empty cart it has no grounds to assert. */}
        {cart.syncStatus === 'loading' || cartUnknown ? null : (
          <p className={styles.submitCaption}>
            {orderSizeLabel(cart.itemCount, cart.subtotalLabel)}
          </p>
        )}
      </div>
    </form>
  );
}
