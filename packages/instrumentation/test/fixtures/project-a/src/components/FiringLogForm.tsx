'use client';

import { useId } from 'react';
import type { FormEvent } from 'react';

export type FiringLogFormProps = { kilnId: string; defaultConeValue?: number };

export async function handleFiringSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
  event.preventDefault();

  const form = event.currentTarget;
  const fields = new FormData(form);

  const response = await fetch('/api/firings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kilnId: String(fields.get('kilnId') ?? ''),
      coneValue: Number(fields.get('coneValue')),
      soakMinutes: Number(fields.get('soakMinutes')),
    }),
  });

  if (response.ok) {
    form.reset();
  }
}

export function FiringLogForm({ kilnId, defaultConeValue = 6 }: FiringLogFormProps) {
  const fieldPrefix = useId();

  return (
    <form onSubmit={handleFiringSubmit}>
      <input type="hidden" name="kilnId" defaultValue={kilnId} />

      <label htmlFor={`${fieldPrefix}-cone`}>Cone number</label>
      <input
        id={`${fieldPrefix}-cone`}
        name="coneValue"
        type="number"
        step={1}
        defaultValue={defaultConeValue}
      />

      <label htmlFor={`${fieldPrefix}-soak`}>Soak minutes held at peak</label>
      <input
        id={`${fieldPrefix}-soak`}
        name="soakMinutes"
        type="number"
        min={0}
        defaultValue={20}
      />

      <button type="submit">Log this firing</button>
    </form>
  );
}
