import type { AuthenticatedUser } from '../modules/auth/auth.types.js';
import { getEventById } from '../modules/events/event.service.js';
import { NotFoundError } from '../errors/app-error.js';

/**
 * Whether `caller` may subscribe to `eventId`'s seat updates.
 *
 * Reuses `getEventById` verbatim rather than re-deriving the rule: it is the
 * exact function `GET /api/v1/events/:eventId` and the REST seat-map endpoint
 * already gate on, so a published event is visible here precisely when it is
 * visible there, and a draft event is hidden here precisely when it is hidden
 * there - one definition of "who can see this event", used by both the pull
 * (REST) and push (WebSocket) side of the same data.
 *
 * `getEventById` answers "not found" and "found but private" identically, by
 * design (see its own doc comment) - so this does too, returning `false`
 * either way rather than distinguishing them for a caller who has no
 * legitimate reason to tell them apart.
 */
export async function canSubscribeToEvent(
  eventId: string,
  caller: AuthenticatedUser | undefined,
): Promise<boolean> {
  const requester = caller === undefined ? undefined : { userId: caller.id, userRole: caller.role };

  try {
    await getEventById(eventId, requester);
    return true;
  } catch (error) {
    if (error instanceof NotFoundError) {
      return false;
    }
    throw error;
  }
}
