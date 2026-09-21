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
const MAX_POSTAL_CODE_LENGTH = 16;
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

/** Letters, digits, spaces and hyphens, as a postal code is written in the regions this store serves. */
const POSTAL_CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;

/** Two upper-case letters, the one canonical form the address DTO carries a country in. */
const COUNTRY_CODE_SHAPE = /^[A-Z]{2}$/;

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
 * Two fields, both written for a buyer: a headline they can scan and a sentence they can act on.
 * Nothing from the failure itself reaches either - not its message, not its status line, not a
 * stack - because a customer cannot do anything with an internal string, and a checkout is the
 * last place to start showing them one.
 */
interface OrderFailureCopy {
  readonly title: string;
  readonly body: string;
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
   * never routes, retries or re-requests anything of its own.
   */
  onOrderPlaced?: (result: CheckoutResult) => void;

  /** An extra class from the surrounding layout, composed after the module's own root class. */
  className?: string;
}

/* ---------------------------------------------------------------------------
 * Pure helpers
 *
 * All four are module-level and take everything they need as arguments, so the component body
 * holds no logic worth reading twice and each of them can be reasoned about - or exercised - on its
 * own. None of them touches the network, the clock or the DOM.
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
 */
function checkoutDraftFrom(
  contact: ContactFields,
  address: AddressFields,
  shippingOptionId: string | null,
  notes: string,
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
    problems.postalCode = 'A postal code holds letters, digits, spaces and hyphens.';
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

/**
 * Wording for a submission that did not place an order.
 *
 * Every branch says what happened and what to do next, and each is written for the one thing a
 * buyer wants to know at this point: whether they have been charged and whether to press the
 * button again. The reason is read from the failure's own `code`, with `status` separating a store
 * that answered badly from one that could not answer at all, so the copy follows the failure rather
 * than the HTTP vocabulary it arrived in.
 *
 * Anything that is not a {@link StorefrontApiError} - a mistake in this page, a value the browser
 * threw - lands on the same generic sentence: it is equally true, and it says nothing a customer
 * cannot act on.
 */
function checkoutFailureCopy(cause: unknown): OrderFailureCopy {
  if (!(cause instanceof StorefrontApiError)) {
    return {
      title: 'The order was not placed',
      body: 'Something went wrong before this order reached Lumen Supply. Nothing was charged. Place the order again.',
    };
  }

  switch (cause.code) {
    case 'VALIDATION_FAILED':
      return {
        title: 'Check these order details',
        body: 'Lumen Supply could not accept these details. Review the contact and address fields, then place the order again.',
      };
    case 'NOT_FOUND':
      return {
        title: 'Something in this order is no longer available',
        body: 'A product or a shipping service in this order is no longer offered. Review the cart and the shipping method, then place the order again.',
      };
    case 'OUT_OF_STOCK':
      return {
        title: 'Stock changed while you were ordering',
        body: 'One or more items are no longer available in the quantity requested. Adjust the cart, then place the order again.',
      };
    case 'CART_CONFLICT':
      return {
        title: 'This cart changed',
        body: 'The cart changed while this order was being placed. Review it, then place the order again.',
      };
    case 'PAYMENT_DECLINED':
      return {
        title: 'Payment was declined',
        body: 'The payment was not authorized and nothing was charged. Use another payment method, then place the order again.',
      };
    case 'NETWORK_FAILURE':
      return {
        title: 'Lumen Supply could not be reached',
        body: 'The order was not placed and nothing was charged. Check your connection, then place the order again.',
      };
    case 'MALFORMED_RESPONSE':
      return {
        title: 'The order status is unclear',
        body: 'Lumen Supply replied in a form this page could not read. Check your orders before placing this one again.',
      };
    case 'INTERNAL_ERROR':
      return cause.status >= 500
        ? {
            title: 'Lumen Supply could not complete the order',
            body: 'The store reported a problem on its side. Nothing was charged. Place the order again in a moment.',
          }
        : {
            title: 'The order was not placed',
            body: 'Lumen Supply could not complete this order. Nothing was charged. Place the order again.',
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

  const failureRegion = useRef<HTMLDivElement | null>(null);

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

  /**
   * Place the order.
   *
   * The whole path, in order: stop the browser navigating; refuse a second submission while one is
   * running; assemble the draft; validate it once; publish the messages that pass produced and drop
   * any notice from an earlier attempt; stop there if anything is wrong; then one request, whose
   * two outcomes are a stored order and a receipt, or a notice above the submit row with every
   * typed value still in place.
   *
   * Nothing else belongs here. It starts no timer, measures nothing, retries nothing, batches
   * nothing and empties no cart: the cart is converted by the endpoint, and a second request from
   * this handler would only add work to the interaction a buyer is waiting on.
   */
  async function submitOrder(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (pending) {
      return;
    }

    const draft = checkoutDraftFrom(contact, address, shippingOptionId, notes);
    const problems = collectFieldErrors(draft);

    setFieldErrors(problems);
    setFailure(null);

    if (Object.keys(problems).length > 0) {
      return;
    }

    setPending(true);

    try {
      const result = await submitCheckout(draft);

      setPlaced(result);
      showToast({
        tone: 'success',
        title: 'Order placed',
        body: `Order ${result.order.orderNumber} is confirmed.`,
      });
      onOrderPlaced?.(result);
    } catch (cause) {
      const copy = checkoutFailureCopy(cause);

      setFailure(copy);
      showToast({ tone: 'danger', title: copy.title });
    } finally {
      setPending(false);
    }
  }

  if (placed !== null) {
    return (
      <div className={clsx(styles.root, className)}>
        <div className={styles.confirmation}>
          <OrderConfirmation order={placed} headline="Thank you for your order" />
        </div>
      </div>
    );
  }

  // An order needs something to ship and a service to ship it by. Both are the buyer's to fix -
  // the cart page for the first, the group below for the second - so the control is unavailable
  // rather than hidden, and the validation pass says the same thing in words if the form is
  // submitted with the keyboard.
  const readyToPlaceOrder = cart.itemCount > 0 && shippingOptionId !== null;

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
            postalCode={address.postalCode.trim().length > 0 ? address.postalCode.trim() : null}
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
                Try again
              </Button>
            }
          >
            {failure.body}
          </Alert>
        </div>
      )}

      <div className={styles.submitRow}>
        <CheckoutButton pending={pending} disabled={!readyToPlaceOrder} />

        {cart.syncStatus === 'loading' ? null : (
          <p>{orderSizeLabel(cart.itemCount, cart.subtotalLabel)}</p>
        )}
      </div>
    </form>
  );
}
