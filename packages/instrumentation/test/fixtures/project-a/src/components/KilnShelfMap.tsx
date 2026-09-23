/*
 * Copyright (c) 2026 Northfield Clay Studio. All rights reserved.
 *
 * Released under the MIT licence. See the LICENSE file at the root of this
 * project for the full terms.
 */

import { Fragment } from 'react';
import type { ReactElement } from 'react';
import { FiringLogForm } from './FiringLogForm';

type ShelfRow = {
  rackCode: string;
  soakMinutes: number;
  glazeNote: string;
};

const STUDIO_KILN_ID = 'kiln-north-02';

const HOLD_MINUTES_PER_HOUR = 60;

const SHELF_ROWS: readonly ShelfRow[] = [
  { rackCode: 'A1', soakMinutes: 20, glazeNote: 'celadon over bisque' },
  { rackCode: 'B2', soakMinutes: 45, glazeNote: 'matte liner, brushed' },
  { rackCode: 'C3', soakMinutes: 90, glazeNote: 'tenmoku dip, deep rack' },
  { rackCode: 'D4', soakMinutes: 0, glazeNote: 'bisque only, no glaze' },
];

export function KilnShelfMap(): ReactElement {
  return (
    <Fragment>
      <h2>Shelf map for kiln {STUDIO_KILN_ID}</h2>

      <ul>
        {SHELF_ROWS.map((row) => (
          <li key={row.rackCode}>
            <strong>{row.rackCode}</strong>
            <em>{row.glazeNote}</em>
            <small>{formatSoakLabel(row.soakMinutes)}</small>
          </li>
        ))}
      </ul>

      <FiringLogForm kilnId={STUDIO_KILN_ID} defaultConeValue={6} />
    </Fragment>
  );
}

export function formatSoakLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 'no hold';
  }

  if (minutes < HOLD_MINUTES_PER_HOUR) {
    return `${minutes} min hold`;
  }

  const hours = Math.floor(minutes / HOLD_MINUTES_PER_HOUR);
  const remainder = minutes % HOLD_MINUTES_PER_HOUR;

  return remainder === 0 ? `${hours} h hold` : `${hours} h ${remainder} min hold`;
}
