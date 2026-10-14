import { logFiringCycle, type FiringCycleDraft } from '@/server/firing-log';

/**
 * Opens a log entry for a firing the potter has just started.
 *
 * The submitted body is handed to the log as one whole draft, so nothing here
 * reads an individual setting off it: what a firing is set up to do is the
 * log's own shape, and a new setting on it needs no edit in this module. The
 * reply carries the entry that was opened, with the kiln's recent entries
 * beside it, which is what the log screen shows next.
 *
 * @param request The submitted firing draft, as JSON.
 * @returns The opened entry with the kiln's recent entries, or `400` when the
 * submitted body is not an object at all.
 */
export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json();

  if (body === null || typeof body !== 'object') {
    return new Response(JSON.stringify({ error: 'A firing draft object is required.' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const opened = await logFiringCycle(body as FiringCycleDraft);

  return new Response(JSON.stringify(opened), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}
