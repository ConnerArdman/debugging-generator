'use client';

/*
 * CheckoutForm - where a Lumen Supply order is completed.
 *
 * `app/checkout/page.tsx` lays this form out beside the order summary, and it owns everything
 * between the buyer's first keystroke and the receipt: the contact details, the destination, the
 * chosen freight service, the delivery note, the inline validation of all of them, the single
 * request that turns the cart into an order, and the two outcomes that request has.
 *
 * Three decisions shape the whole file.
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
 *   3. THE SUBMIT PATH IS AS THIN AS A SUBMIT PATH CAN BE. `submitOrder` validates once,
 *      awaits one call to `submitCheckout`, and stores what came back. It holds no timer, no
 *      retry, no second request and no measurement of its own: the request's duration is the
 *      server's to explain, and a client-side stopwatch would only describe the wait it cannot
 *      shorten. A failure keeps every value the buyer typed, so placing the order again is one
 *      click rather than a re-typed form.
 *
 *   4. THE FORM SAYS WHAT IT KNOWS AND NOT WHAT IT WOULD PREFER. Two of the things a buyer
 *      reads here are statements about their money, and neither may be guessed. A failure is
 *      described as "nothing was charged" only where the store said which reason applied and
 *      that reason means nothing was captured; a reason the store did not author - a reply that
 *      never arrived, one this page could not read, a status this page read a meaning into -
 *      leaves the order unconfirmed, and what the buyer is offered then is to check the order
 *      rather than to place it again. That check is the same submission with the same attempt
 *      name, which the endpoint answers with the order it already holds instead of a second one,
 *      so the safe action and the retry are one control. And the cart: a cart that could not be
 *      read is not an empty cart, so its totals are withheld rather than printed as zero.
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
 *      unit. The published amount comes from that quote and never from the list rates this form
 *      was handed, so the review column either states the figure the order will be charged or
 *      states that the charge is not established yet. And there is still exactly one
 *      `GET /api/shipping/quote` per shipment, because the panel asks for nothing once the lookup
 *      is handed to it.
 *
 * Validation is a mirror of the server's bounds, not a second opinion about them: the lengths and
 * shapes below are the ones `checkoutBodySchema` enforces, so a value this form accepts is a value
 * that endpoint accepts, and the endpoint remains the authority on everything that depends on data
 * of the moment - whether the cart still holds anything, whether the stock is still there, whether
 * the chosen service is still offered.
 */

import clsx from 'clsx';

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';

import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useCart } from '@/hooks/useCart';
import { useFreightQuote } from '@/hooks/useShippingEta';
import { StorefrontApiError, submitCheckout } from '@/lib/api-client';
import { formatQuantityLabel } from '@/lib/format';
import type {
  CheckoutDraft,
  CheckoutResult,
  CustomerContact,
  ShippingAddress,
  ShippingOption,
} from '@/lib/types';
import { useToastCenter } from '@/providers/ToastProvider';

import { CheckoutButton } from './CheckoutButton';
import { usePublishSelectedFreight } from './CheckoutCharges';
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

/* ---------------------------------------------------------------------------
 * Bounds and shapes
 *
 * Each of these is the bound `checkoutBodySchema` applies to the same field. They are stated here
 * as well so the form can say what is wrong beside the field rather than after a round trip, and
 * they are stated as constants so the `maxLength` attribute on a control and the message under it
 * can never disagree about the same number.
 * ------------------------------------------------------------------------- */

const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_COMPANY_LENGTH = 120;
const MAX_ADDRESS_LINE_LENGTH = 120;
const MAX_CITY_LENGTH = 80;
const MAX_REGION_LENGTH = 80;
const MIN_POSTAL_CODE_LENGTH = 3;
const MAX_POSTAL_CODE_LENGTH = 12;
const MAX_NOTES_LENGTH = 500;

/**
 * The coarsest useful test for an email address: something, one `@`, something, a dot, something.
 *
 * Deliberately not the server's check. `customerContactSchema` validates with Zod's own `email`
 * format, and re-implementing that here would produce a second, subtly different opinion about
 * which addresses exist - the failure mode where a form rejects an address the endpoint would have
 * accepted. This catches the typo a buyer can see and fix (a missing `@`, a missing domain) and
 * leaves the judgement to the endpoint.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Alphanumeric groups joined by single spaces or hyphens, as a postal code is written in the
 * regions this store serves - and the shape `shippingAddressSchema` holds the same field to, so a
 * destination this form accepts is one the endpoint accepts and one the freight quote can rate.
 */
const POSTAL_CODE_SHAPE = /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/;

/** Two upper-case letters, the one canonical form the address DTO carries a country in. */
const COUNTRY_CODE_SHAPE = /^[A-Z]{2}$/;

/**
 * How many random bytes name one attempt to place an order.
 *
 * Sixteen, written as hexadecimal, is thirty-two characters - comfortably
 * inside the bound `checkoutBodySchema` holds the field to, and far beyond the
 * point at which two buyers could mint the same name.
 */
const ATTEMPT_BYTES = 16;

/**
 * The destinations this catalog's warehouses quote freight for.
 *
 * A closed list rather than a text field, because the country is the one address field the
 * storefront reads itself: it picks the warehouses that can serve the order and it is sent as a
 * two-letter code. The values mirror the codes the address schema accepts; the labels are what the
 * dropdown shows.
 */
const DESTINATION_COUNTRIES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'US', label: 'United States' },
  { code: 'CA', label: 'Canada' },
  { code: 'MX', label: 'Mexico' },
];

/** The country a form with no prefill starts on, matching the address schema's own default. */
const DEFAULT_COUNTRY = 'US';

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
  readonly title: string;
  readonly body: string;
  readonly action: string;
}

interface Props {
  /**
   * The freight services on offer, in the order they should be read. Supplied by the checkout
   * page, never fetched here, and `readonly` because this form only reads them: the picker refines
   * their price and transit time against the destination on its own.
   *
   * The first option is what the form starts on, so a buyer who accepts the default service never
   * has to touch the group. An empty list leaves nothing chosen, which the validation pass reports
   * as a missing service rather than sending an order no carrier was named for.
   */
  shippingOptions: readonly ShippingOption[];

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
    idempotencyKey: key,
  };
}

/**
 * Everything wrong with `draft`, by field, in one pass.
 *
 * One pass, and one message per field: the first thing wrong with a value is the thing to say
 * about it, because a field that reports a missing value and a too-long value at once is a field
 * nobody can act on. An empty object means the draft is worth sending, and it is the only thing
 * that lets the submit path continue.
 *
 * The bounds are the endpoint's own, restated as the constants above. Anything that depends on the
 * state of the store rather than on the shape of the request - whether the cart still holds what it
 * held, whether the stock is still there, whether the chosen service is still quoted - is
 * deliberately absent: those are decided by the checkout service against the data of the moment,
 * and a second opinion here would go stale the moment it was written.
 */
function collectFieldErrors(draft: CheckoutDraft): CheckoutFieldErrors {
  const problems: CheckoutFieldErrors = {};
  const { contact, shippingAddress: address, shippingOptionId, notes } = draft;

  if (contact.name.length === 0) {
    problems.name = 'A contact name is required.';
  } else if (contact.name.length > MAX_NAME_LENGTH) {
    problems.name = `Keep the contact name to ${MAX_NAME_LENGTH} characters.`;
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
  }

  if (address.line1.length === 0) {
    problems.line1 = 'A street address is required.';
  } else if (address.line1.length > MAX_ADDRESS_LINE_LENGTH) {
    problems.line1 = `Keep the street address to ${MAX_ADDRESS_LINE_LENGTH} characters.`;
  }

  if (address.line2 !== null && address.line2.length > MAX_ADDRESS_LINE_LENGTH) {
    problems.line2 = `Keep the second address line to ${MAX_ADDRESS_LINE_LENGTH} characters.`;
  }

  if (address.city.length === 0) {
    problems.city = 'A city is required.';
  } else if (address.city.length > MAX_CITY_LENGTH) {
    problems.city = `Keep the city to ${MAX_CITY_LENGTH} characters.`;
  }

  if (address.region.length === 0) {
    problems.region = 'A state or region is required.';
  } else if (address.region.length > MAX_REGION_LENGTH) {
    problems.region = `Keep the state or region to ${MAX_REGION_LENGTH} characters.`;
  }

  if (address.postalCode.length < MIN_POSTAL_CODE_LENGTH) {
    problems.postalCode = 'A postal code is required.';
  } else if (address.postalCode.length > MAX_POSTAL_CODE_LENGTH) {
    problems.postalCode = `Keep the postal code to ${MAX_POSTAL_CODE_LENGTH} characters.`;
  } else if (!POSTAL_CODE_SHAPE.test(address.postalCode)) {
    problems.postalCode =
      'A postal code holds letters and digits in groups separated by single spaces or hyphens.';
  }

  if (!COUNTRY_CODE_SHAPE.test(address.country)) {
    problems.country = 'Choose the country this order ships to.';
  }

  if (shippingOptionId.length === 0) {
    problems.shippingOptionId = 'Choose a shipping service.';
  }

  if (notes !== null && notes.length > MAX_NOTES_LENGTH) {
    problems.notes = `Keep delivery notes to ${MAX_NOTES_LENGTH} characters.`;
  }

  return problems;
}

/** The label of the notice's control where placing the order again is the thing to do. */
const RETRY_ORDER = 'Try again';

/** The label of the notice's control where resolving the attempt is the thing to do. */
const RESOLVE_ORDER = 'Check this order';

/**
 * Wording for an attempt whose outcome this page cannot establish.
 *
 * It is the one notice that does not say whether the buyer has been charged, because that is the
 * situation: the request left this page and what became of it is not known here. So it says so,
 * it does not invite a second order, and it explains why the control in front of the buyer is
 * safe to press - the endpoint recognises the attempt and answers with the order it already
 * holds, and places the order only if it never received it.
 */
const UNCONFIRMED: OrderFailureCopy = {
  title: 'This order is not confirmed',
  body: 'Lumen Supply may already have this order, and a payment may already have been taken for it. Check the order rather than placing it again: checking cannot create a second order, and it completes this one if the store never received it.',
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
 * checked before any of them: a failure carrying a reason this page derived - because the request
 * never came back, because the reply could not be read, because only a status arrived - is a
 * failure about a submission that may well have been carried out, and describing it as one that
 * was not would be this page inventing the part it does not know. `PAYMENT_STATUS_UNKNOWN` is the
 * same situation named by the store, for the case where the store knows it too.
 *
 * Anything that is not a {@link StorefrontApiError} - a mistake in this page, a value the browser
 * threw - lands on the generic sentence: nothing left for the store at all, so nothing was
 * charged.
 */
function checkoutFailureCopy(cause: unknown): OrderFailureCopy {
  if (!(cause instanceof StorefrontApiError)) {
    return {
      title: 'The order was not placed',
      body: 'Something went wrong before this order reached Lumen Supply. Nothing was charged. Place the order again.',
      action: RETRY_ORDER,
    };
  }

  if (!cause.reported) {
    return UNCONFIRMED;
  }

  switch (cause.code) {
    case 'VALIDATION_FAILED':
      return {
        title: 'Check these order details',
        body: 'Lumen Supply could not accept these details. Review the contact and address fields, then place the order again.',
        action: RETRY_ORDER,
      };
    case 'NOT_FOUND':
      return {
        title: 'Something in this order is no longer available',
        body: 'A product or a shipping service in this order is no longer offered. Review the cart and the shipping method, then place the order again.',
        action: RETRY_ORDER,
      };
    case 'OUT_OF_STOCK':
      return {
        title: 'Stock changed while you were ordering',
        body: 'One or more items are no longer available in the quantity requested. Adjust the cart, then place the order again.',
        action: RETRY_ORDER,
      };
    case 'CART_CONFLICT':
      return {
        title: 'This cart changed',
        body: 'The cart changed while this order was being placed. Review it, then place the order again.',
        action: RETRY_ORDER,
      };
    case 'PAYMENT_DECLINED':
      return {
        title: 'Payment was declined',
        body: 'The payment was not authorized and nothing was charged. Use another payment method, then place the order again.',
        action: RETRY_ORDER,
      };
    case 'PAYMENT_STATUS_UNKNOWN':
      return UNCONFIRMED;
    // Neither of the next two is ever reported by the store - both describe the reply rather than
    // the order - so both are answered above. They are named here so that the reason for that is
    // stated where a reader looks for it, and so that every member of the union has an answer.
    case 'NETWORK_FAILURE':
    case 'MALFORMED_RESPONSE':
      return UNCONFIRMED;
    case 'INTERNAL_ERROR':
      return cause.status >= 500
        ? {
            title: 'Lumen Supply could not complete the order',
            body: 'The store reported a problem on its side. Nothing was charged. Place the order again in a moment.',
            action: RETRY_ORDER,
          }
        : {
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

/* ---------------------------------------------------------------------------
 * The form
 * ------------------------------------------------------------------------- */

/**
 * Render the checkout form, or the receipt for the order it placed.
 *
 * State is eight plain `useState` values and nothing else - the contact group, the destination
 * group, the delivery note, the chosen service, whether a submission is in flight, the validation
 * messages, the failure notice and the placed order. There is no reducer, no transition and no
 * derived copy of the cart: the cart is read from the provider that owns it, and the two composite
 * blocks below own their own presentation.
 *
 * Two things are read from elsewhere and neither is state of this form's. The freight lookup for
 * the destination in the fields comes from `@/hooks/useShippingEta`, which owns the request and its
 * three outcomes; the charge channel comes from `./CheckoutCharges`, and all this form does with it
 * is publish what the buyer chose. The chosen service itself is derived from the option list and
 * that lookup on every render rather than stored, so it cannot go stale against either.
 *
 * Two handlers matter. `submitOrder` is the form's `onSubmit`, and it is described where it is
 * written. The other is the `void`-returning arrow the form attaches it with: a promise handed
 * straight to a DOM event attribute is a promise nothing awaits, so the arrow starts the
 * submission and returns nothing, which is what React's handler signature asks for.
 *
 * Once an order exists the fields are gone and the receipt takes their place, because there is
 * nothing left to edit: the order has an order number, the payment has resolved, and both are
 * printed by `./OrderConfirmation` from the result this form stored.
 */
export function CheckoutForm({
  shippingOptions,
  initialAddress,
  initialContact,
  onOrderPlaced,
  className,
}: Props): ReactElement {
  const cart = useCart();
  const { showToast } = useToastCenter();
  const publishFreight = usePublishSelectedFreight();

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
    country: initialAddress?.country ?? DEFAULT_COUNTRY,
  }));
  const [notes, setNotes] = useState<string>('');
  const [shippingOptionId, setShippingOptionId] = useState<string | null>(
    () => shippingOptions.at(0)?.id ?? null,
  );
  const [pending, setPending] = useState<boolean>(false);
  const [fieldErrors, setFieldErrors] = useState<CheckoutFieldErrors>({});
  const [failure, setFailure] = useState<OrderFailureCopy | null>(null);
  const [placed, setPlaced] = useState<CheckoutResult | null>(null);

  /*
   * Where the order is going, as the freight lookup and the service group are both given it: the
   * postal-code field trimmed, or `null` while there is nothing to quote for. One `const` rather
   * than the same expression written at two call sites, because the lookup and the panel must
   * describe one address - a panel priced for a destination the lookup was not asked about would
   * put rates for the previous address beside the new one.
   */
  const typedPostalCode = address.postalCode.trim();
  const destination = typedPostalCode.length > 0 ? typedPostalCode : null;

  /*
   * The freight lookup, held here rather than inside the service group, because the rate the buyer
   * is looking at has to reach the review column beside this form - see decision 5 in the header.
   * The panel is handed this state, so it asks nothing itself and the page makes one request per
   * shipment.
   *
   * Both halves of the question are passed, and the second one is not optional in practice.
   * Freight is charged per piece as well as per destination, and `POST /api/checkout` rates the
   * order's freight against the units it reserved - so a lookup that named only the address would
   * be answered for a single unit and would show a buyer a fraction of what their order is about
   * to be charged. `cart.itemCount` is that same unit count, summed across the cart's lines by the
   * provider that owns them.
   */
  const freight = useFreightQuote(destination, cart.itemCount);

  /*
   * The chosen service, and the one amount this form is entitled to publish for it.
   *
   * The service itself is the option this form was given, matched on the chosen id - that is the
   * row the panel shows as checked and the service the order names. The amount is taken from the
   * quote and from nowhere else, and that restriction is the point: the list rates this form was
   * handed are what a service costs to carry one unit to an unspecified address, so publishing one
   * would quote the review column a figure the order will not be charged. Until a quote for this
   * shipment has arrived - before the first lookup, while one is in flight, after a failed one -
   * there is no freight amount to state, and `null` is what says so; the column then prints the
   * row as a charge still to be confirmed rather than as an amount. Once the quote is in, the
   * figure is the quote's entry for the chosen id, which is both what the panel prints beside the
   * checked row and what `POST /api/checkout` rates the same shipment at.
   *
   * Three primitives rather than an object, because they are what the publishing effect below
   * depends on: an object literal in a dependency array is a fresh identity on every render, and
   * this form re-renders several times a second (AAP 0.8.2 defect 2).
   */
  const chosenOption =
    shippingOptionId === null
      ? undefined
      : shippingOptions.find((option) => option.id === shippingOptionId);
  const quotedOption =
    chosenOption === undefined
      ? undefined
      : freight.quote?.options.find((candidate) => candidate.id === chosenOption.id);
  const chosenOptionId = chosenOption?.id ?? null;
  const chosenOptionLabel = chosenOption?.label ?? null;
  const chosenOptionAmountCents = quotedOption?.priceCents ?? null;

  const failureRegion = useRef<HTMLDivElement | null>(null);

  // The name every submission of the order in front of the buyer travels under, drawn on the
  // first one and kept until an order exists. A ref rather than state because nothing renders it
  // and changing it must not re-render anything - and because it has to survive the render that a
  // failure causes, which is the render after which it matters most: the next submission is the
  // one the endpoint has to recognise as the same attempt.
  const attempt = useRef<string | null>(null);

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

  // The chosen freight charge, published for the review column beside this form. The dependencies
  // are the three primitives the charge is made of and the publisher, which is stable for the life
  // of its provider, so this runs when the chosen service or its quoted rate changes and not when
  // the cart or the dispatch countdown does - and the value itself is built inside the effect,
  // where a fresh object costs nothing. Nothing chosen, or a service with no rate to quote yet,
  // publishes `null`, which the column renders as a charge still to be established rather than as
  // a zero; the cleanup publishes `null` too, so a form that goes away leaves no freight row
  // behind it. The publisher ignores a value equal to the one already published, which is what
  // keeps a form re-rendering four times a second from writing state four times a second.
  useEffect(() => {
    if (chosenOptionId === null || chosenOptionLabel === null || chosenOptionAmountCents === null) {
      publishFreight(null);
    } else {
      publishFreight({
        optionId: chosenOptionId,
        label: chosenOptionLabel,
        amountCents: chosenOptionAmountCents,
      });
    }

    return () => {
      publishFreight(null);
    };
  }, [chosenOptionId, chosenOptionLabel, chosenOptionAmountCents, publishFreight]);

  /**
   * Place the order.
   *
   * The whole path, in order: stop the browser navigating; refuse a second submission while one is
   * running; name the attempt, once, and keep that name for every submission of this order;
   * assemble the draft; validate it once; publish the messages that pass produced and drop any
   * notice from an earlier attempt; stop there if anything is wrong; then one request, whose two
   * outcomes are a stored order and a receipt, or a notice above the submit row with every typed
   * value still in place.
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

    // Drawn on the first submission and reused by every later one, so a buyer pressing the
    // control again after an unconfirmed outcome resolves that attempt instead of starting
    // another. An order that was placed ends the form, so a name is never reused for a second
    // order.
    attempt.current ??= attemptKey();

    const draft = checkoutDraftFrom(contact, address, shippingOptionId, notes, attempt.current);
    const problems = collectFieldErrors(draft);

    setFieldErrors(problems);
    setFailure(null);

    if (Object.keys(problems).length > 0) {
      return;
    }

    setPending(true);

    let result: CheckoutResult;

    try {
      result = await submitCheckout(draft);
    } catch (cause) {
      const copy = checkoutFailureCopy(cause);

      setFailure(copy);
      showToast({ tone: 'danger', title: copy.title });

      return;
    } finally {
      setPending(false);
    }

    const replayed = result.outcome === 'already_placed';

    setPlaced(result);
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

  if (placed !== null) {
    return (
      <div className={clsx(styles.root, className)}>
        <div className={styles.confirmation}>
          <OrderConfirmation
            order={placed}
            headline={
              placed.outcome === 'already_placed'
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

  // An order needs something to ship and a service to ship it by. Both are the buyer's to fix -
  // the cart page for the first, the group below for the second - so the control is unavailable
  // rather than hidden, and the validation pass says the same thing in words if the form is
  // submitted with the keyboard. A cart that could not be read disables it too, on the strength of
  // not knowing rather than of knowing the cart is empty.
  const readyToPlaceOrder = !cartUnknown && cart.itemCount > 0 && shippingOptionId !== null;

  return (
    <form
      className={clsx(styles.root, className)}
      aria-label="Checkout details"
      noValidate
      onSubmit={(event) => {
        void submitOrder(event);
      }}
    >
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Contact details</h2>

        <div className={styles.grid}>
          <FormField id={CONTACT_NAME_ID} label="Contact name" required error={fieldErrors.name}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                name="name"
                autoComplete="name"
                required
                maxLength={MAX_NAME_LENGTH}
                value={contact.name}
                invalid={fieldErrors.name !== undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setContact((current) => ({ ...current, name: event.target.value }));
                }}
              />
            )}
          </FormField>

          <FormField id={CONTACT_COMPANY_ID} label="Company" error={fieldErrors.company}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                name="company"
                autoComplete="organization"
                maxLength={MAX_COMPANY_LENGTH}
                value={contact.company}
                invalid={fieldErrors.company !== undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setContact((current) => ({ ...current, company: event.target.value }));
                }}
              />
            )}
          </FormField>

          <FormField
            id={CONTACT_EMAIL_ID}
            label="Email"
            hint="The order confirmation and dispatch notice are sent here."
            required
            error={fieldErrors.email}
            className={clsx(styles.fieldWide)}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="email"
                name="email"
                autoComplete="email"
                required
                maxLength={MAX_EMAIL_LENGTH}
                value={contact.email}
                invalid={fieldErrors.email !== undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setContact((current) => ({ ...current, email: event.target.value }));
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
            error={fieldErrors.line1}
            className={clsx(styles.fieldWide)}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                name="line1"
                autoComplete="address-line1"
                required
                maxLength={MAX_ADDRESS_LINE_LENGTH}
                value={address.line1}
                invalid={fieldErrors.line1 !== undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setAddress((current) => ({ ...current, line1: event.target.value }));
                }}
              />
            )}
          </FormField>

          <FormField
            id={ADDRESS_LINE2_ID}
            label="Suite, unit or floor"
            error={fieldErrors.line2}
            className={clsx(styles.fieldWide)}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                name="line2"
                autoComplete="address-line2"
                maxLength={MAX_ADDRESS_LINE_LENGTH}
                value={address.line2}
                invalid={fieldErrors.line2 !== undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setAddress((current) => ({ ...current, line2: event.target.value }));
                }}
              />
            )}
          </FormField>

          <FormField id={ADDRESS_CITY_ID} label="City" required error={fieldErrors.city}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                name="city"
                autoComplete="address-level2"
                required
                maxLength={MAX_CITY_LENGTH}
                value={address.city}
                invalid={fieldErrors.city !== undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setAddress((current) => ({ ...current, city: event.target.value }));
                }}
              />
            )}
          </FormField>

          <FormField
            id={ADDRESS_REGION_ID}
            label="State or region"
            required
            error={fieldErrors.region}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                name="region"
                autoComplete="address-level1"
                required
                maxLength={MAX_REGION_LENGTH}
                value={address.region}
                invalid={fieldErrors.region !== undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setAddress((current) => ({ ...current, region: event.target.value }));
                }}
              />
            )}
          </FormField>

          <FormField
            id={ADDRESS_POSTAL_CODE_ID}
            label="Postal code"
            hint="Freight is quoted for this destination."
            required
            error={fieldErrors.postalCode}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                name="postalCode"
                autoComplete="postal-code"
                required
                maxLength={MAX_POSTAL_CODE_LENGTH}
                value={address.postalCode}
                invalid={fieldErrors.postalCode !== undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setAddress((current) => ({ ...current, postalCode: event.target.value }));
                }}
              />
            )}
          </FormField>

          <FormField id={ADDRESS_COUNTRY_ID} label="Country" required error={fieldErrors.country}>
            {({ id, describedBy }) => (
              <Select
                id={id}
                name="country"
                autoComplete="country"
                required
                value={address.country}
                invalid={fieldErrors.country !== undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setAddress((current) => ({ ...current, country: event.target.value }));
                }}
              >
                {DESTINATION_COUNTRIES.map((destination) => (
                  <option key={destination.code} value={destination.code}>
                    {destination.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Delivery options</h2>

        <div className={styles.shipping}>
          <ShippingOptionPicker
            options={shippingOptions}
            selectedId={shippingOptionId}
            postalCode={destination}
            quote={freight}
            disabled={pending}
            onSelect={(optionId) => {
              setShippingOptionId(optionId);
            }}
          />

          {fieldErrors.shippingOptionId === undefined ? null : (
            <Alert tone="warning">{fieldErrors.shippingOptionId}</Alert>
          )}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Delivery notes</h2>

        <div className={styles.grid}>
          <FormField
            id={DELIVERY_NOTES_ID}
            label="Notes for the warehouse"
            hint="Dock hours, a purchase-order reference, anything the packers should know."
            error={fieldErrors.notes}
            className={clsx(styles.fieldWide)}
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                name="notes"
                maxLength={MAX_NOTES_LENGTH}
                value={notes}
                invalid={fieldErrors.notes !== undefined}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setNotes(event.target.value);
                }}
              />
            )}
          </FormField>
        </div>
      </section>

      {failure === null ? null : (
        <div className={styles.failure} ref={failureRegion} tabIndex={-1}>
          <Alert
            tone="danger"
            title={failure.title}
            actions={
              <Button type="submit" variant="secondary" size="sm">
                {failure.action}
              </Button>
            }
          >
            {failure.body}
          </Alert>
        </div>
      )}

      {cartUnknown ? (
        <div className={styles.cartNotice}>
          <Alert
            tone="danger"
            title="Your cart could not be read"
            actions={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
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

      <div className={styles.submitRow}>
        <CheckoutButton pending={pending} disabled={!readyToPlaceOrder} />

        {/* The line beside the control quotes what is about to be ordered, so it appears only
            where there is a cart to quote: neither a cart still being read nor one that could not
            be read has figures, and printing a zero for either would be this form asserting an
            empty cart it has no grounds to assert. */}
        {cart.syncStatus === 'loading' || cartUnknown ? null : (
          <p>{orderSizeLabel(cart.itemCount, cart.subtotalLabel)}</p>
        )}
      </div>
    </form>
  );
}
