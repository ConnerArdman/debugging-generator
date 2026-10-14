'use client';

import { useId } from 'react';
import { planBisqueRamp } from './bisque-schedule';

/**
 * The plaque card the wall-mounted tablet shows for one shelf of greenware.
 *
 * Every shelf in the studio carries a clipped-on plaque with the load written on it in grease
 * pencil. The tablet shows that same plaque beside the shelf map, so a potter standing at the rack
 * can draft the climb for the chamber without walking back to the keypad.
 *
 * The kiln the shelf sits in travels on the button itself rather than being closed over, which is
 * what lets the draft below stay an ordinary studio helper that any plaque on the wall can reach.
 *
 * @param props The kiln the shelf sits in and the label written on its plaque.
 * @returns The plaque card for that shelf.
 */
export function ShelfPlaqueCard({ kilnId, plaqueLabel }) {
  const plaqueTitleId = useId();

  return (
    <article className="shelf-plaque">
      <h3 id={plaqueTitleId} className="shelf-plaque-title">
        {plaqueLabel}
      </h3>

      <button
        type="button"
        className="shelf-plaque-draft"
        data-kiln-id={kilnId}
        aria-labelledby={plaqueTitleId}
        onClick={handlePlaqueSelect}
      >
        Draft the bisque climb
      </button>
    </article>
  );
}

/**
 * Drafts the bisque climb for the kiln whose plaque was tapped.
 *
 * The kiln is read back off the tapped button, so the studio's own bisque schedule is handed the
 * chamber the plaque was written for and not whichever shelf happened to be shown first. The
 * drafted ramp is handed straight back to whoever asked, unchanged, because the keypad screen and
 * the firing log both read it and neither wants the tablet's reading of it.
 *
 * A plaque written before its kiln was keyed in leaves the kiln blank, which the schedule carries
 * through onto the sheet as drafted rather than guessing at a chamber.
 *
 * @param event The tap on a plaque card button.
 * @returns The drafted ramp for the kiln named on the plaque.
 */
export function handlePlaqueSelect(event) {
  const { kilnId } = event.currentTarget.dataset;

  return planBisqueRamp({ kilnId });
}
