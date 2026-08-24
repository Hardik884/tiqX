import type { PoolClient } from 'pg';

import { PG_ERROR, pgErrorCode, pgErrorConstraint } from '../../db/pg-error.js';
import { pool, withTransaction } from '../../db/pool.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/app-error.js';
import { logger } from '../../utils/logger.js';
import { createShowSeatsForEvent } from '../seats/show-seat.repository.js';
import { listVenueSeatIds, venueExists } from '../venues/venue.repository.js';
import {
  countAvailableSeats,
  countAvailableSeatsForEvents,
  countEventsForListing,
  deleteEventRow,
  findEventWithVenueName,
  hasEventHistory,
  insertEvent,
  listEventsPage,
  lockEventForOwnership,
  markEventPublished,
  updateEventFields,
  type EventWithVenueName,
  type LockedEvent,
} from './event.repository.js';
import type {
  CreateEventInput,
  DeleteEventInput,
  EventRecord,
  ListOrganiserEventsInput,
  ListOrganiserEventsResult,
  PrivateEventView,
  PublicEventView,
  PublishEventInput,
  RequestingUser,
  UpdateEventInput,
} from './event.types.js';

export interface CreateEventResult {
  event: EventRecord;
  seatInventoryCount: number;
}

/**
 * Creates an event together with its initial seat inventory.
 *
 *   validate venue -> insert event -> read venue_seats -> insert show_seats
 *
 * All four steps share one transaction, so an event is never persisted without
 * the seat inventory that belongs to it: any failure rolls the whole thing back.
 */
export async function createEvent(input: CreateEventInput): Promise<CreateEventResult> {
  try {
    return await withTransaction(async (client) => {
      if (!(await venueExists(client, input.venueId))) {
        throw new BadRequestError('venueId does not reference an existing venue');
      }

      const event = await insertEvent(client, input);

      const venueSeatIds = await listVenueSeatIds(client, input.venueId);
      if (venueSeatIds.length === 0) {
        // Without a seat map there is nothing to sell, and an event with empty
        // inventory would be indistinguishable from a sold-out one.
        throw new BadRequestError('Venue has no seats configured, so no seat inventory can be created');
      }

      const seatInventoryCount = await createShowSeatsForEvent(
        client,
        event.id,
        venueSeatIds,
        input.pricing,
      );

      return { event, seatInventoryCount };
    });
  } catch (error) {
    // The transaction has already rolled back by the time we get here.
    if (
      pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION &&
      pgErrorConstraint(error) === 'events_organiser_id_fkey'
    ) {
      throw new BadRequestError('organiserId does not reference an existing user');
    }

    throw error;
  }
}

/**
 * RESOURCE AUTHORIZATION, IN ONE PLACE.
 *
 * Every mutating event operation below - update, publish, delete - asks
 * exactly this question, under the same kind of row lock ticket issuance
 * already established the pattern for: is the caller the event's own
 * organiser, or an admin? Nothing else counts. Being *an* organiser is RBAC,
 * checked once at the route (`requireRole('organiser', 'admin')`); owning
 * *this* event is resource authorization, checked here, every time, from data
 * read under the lock just taken - never from a role claim alone.
 */
function isOwnerOrAdmin(locked: LockedEvent, requester: RequestingUser): boolean {
  return requester.userRole === 'admin' || locked.organiserId === requester.userId;
}

/**
 * An event that does not exist, or that this caller has no standing over.
 *
 * Same reasoning as `bookingNotFound`/`ticketNotFound` in the bookings and
 * tickets modules: answering 403 for "someone else's event" and 404 for "no
 * such event" would let any organiser walk event ids and learn which ones are
 * real. One answer for both; the distinction - not found vs not owned - stays
 * in the log, where an operator can see it and a caller cannot.
 */
function eventNotFound(): NotFoundError {
  return new NotFoundError('Event not found', { reason: 'EVENT_NOT_FOUND' });
}

function toPublicView(record: EventWithVenueName, availableSeats: number): PublicEventView {
  return {
    id: record.event.id,
    title: record.event.title,
    description: record.event.description,
    eventType: record.event.eventType,
    status: record.event.status,
    startsAt: record.event.startsAt,
    endsAt: record.event.endsAt,
    venue: { id: record.event.venueId, name: record.venueName },
    availableSeats,
  };
}

function toPrivateView(record: EventWithVenueName, availableSeats: number): PrivateEventView {
  return {
    ...toPublicView(record, availableSeats),
    organiserId: record.event.organiserId,
    currency: record.event.currency,
    createdAt: record.event.createdAt,
    updatedAt: record.event.updatedAt,
  };
}

/**
 * Reads one event for the public/private GET.
 *
 * PUBLIC VS PRIVATE, THE SECURITY DECISION. A `draft` event is not yet
 * announced - that is the entire meaning of the status - so it must not be
 * distinguishable from a nonexistent one to anyone but its own organiser or
 * an admin. `requester` is optional because this is the one event endpoint an
 * anonymous customer legitimately calls (see `optionalAuth`); when present,
 * it decides both *whether* a draft is visible and *how much* of it is
 * returned once it is.
 *
 * No row lock: nothing here is about to change, and GET must never take one -
 * that would make browsing events contend with organisers editing them.
 */
export async function getEventById(
  eventId: string,
  requester: RequestingUser | undefined,
): Promise<PublicEventView | PrivateEventView> {
  const record = await findEventWithVenueName(pool, eventId);

  if (record === null) {
    throw eventNotFound();
  }

  const privileged =
    requester !== undefined &&
    (requester.userRole === 'admin' || record.event.organiserId === requester.userId);

  if (record.event.status === 'draft' && !privileged) {
    // Answered identically to "no such event" - see `eventNotFound`.
    throw eventNotFound();
  }

  const availableSeats = await countAvailableSeats(pool, eventId);

  return privileged ? toPrivateView(record, availableSeats) : toPublicView(record, availableSeats);
}

/**
 * Updates an event's editable fields.
 *
 * WHAT IS EDITABLE, AND WHY THE REST IS NOT. `venueId`, `eventType` and
 * `status` are not accepted at all - see `updateEventSchema`, which is the
 * real enforcement; this function never sees them. Of what remains:
 *
 *   title, description   editable in `draft` or `published`, always.
 *   startsAt, endsAt      editable in `draft` or `published`, but only while
 *                         the event has never had a booking - a booking is a
 *                         customer's commitment to a specific showtime, and
 *                         rescheduling out from under it is exactly the kind
 *                         of structural change section 12 asks to guard.
 *
 * `draft` is not treated as an automatic "anything goes" state for the
 * schedule fields: nothing in this codebase stops a hold or a booking being
 * made against a draft event today (there is no status gate on reservation
 * creation - a genuine, pre-existing gap, noted in the final report rather
 * than silently relied upon), so "has a booking" is checked directly instead
 * of inferred from status.
 *
 * `completed` and `cancelled` are terminal: no field may change.
 *
 * TRANSACTION AND LOCK ORDER. Locks `events` first and alone - no other table
 * is touched under this lock, and no other transaction anywhere in this
 * system takes a row lock on `events`, so this cannot join the existing
 * `bookings`/`show_seats`/`reservation_holds`/`tickets` lock order in a cycle;
 * it is a new, independent lock resource.
 *
 * The `endsAt > startsAt` invariant is not re-validated here: the database's
 * own `events_time_range_check` constraint already makes an inconsistent pair
 * impossible to store, whichever of the two fields changed, and a
 * `CHECK_VIOLATION` from it is translated to a plain 400 below - reusing the
 * constraint as the single source of truth rather than recomputing its answer
 * in JavaScript.
 */
export async function updateEventInTransaction(
  client: PoolClient,
  input: UpdateEventInput,
  requestId: string | undefined,
): Promise<EventRecord> {
  const locked = await lockEventForOwnership(client, input.eventId);

  if (locked === null) {
    logger.warn('Rejected event update', { requestId, eventId: input.eventId, reason: 'EVENT_NOT_FOUND' });
    throw eventNotFound();
  }

  if (!isOwnerOrAdmin(locked, input)) {
    logger.warn('Rejected event update', {
      requestId,
      eventId: input.eventId,
      userId: input.userId,
      reason: 'EVENT_NOT_OWNED',
    });
    throw eventNotFound();
  }

  if (locked.status === 'completed' || locked.status === 'cancelled') {
    logger.warn('Rejected event update', {
      requestId,
      eventId: input.eventId,
      reason: 'INVALID_EVENT_STATE',
    });
    throw new ConflictError(`A ${locked.status} event can no longer be edited`, {
      reason: 'INVALID_EVENT_STATE',
    });
  }

  if (input.startsAt !== undefined || input.endsAt !== undefined) {
    if (await hasEventHistory(client, input.eventId)) {
      logger.warn('Rejected event reschedule', {
        requestId,
        eventId: input.eventId,
        reason: 'EVENT_HAS_BOOKINGS',
      });
      throw new ConflictError('This event has bookings or holds and can no longer be rescheduled', {
        reason: 'EVENT_HAS_BOOKINGS',
      });
    }
  }

  let updated: EventRecord | null;
  try {
    updated = await updateEventFields(client, input.eventId, {
      title: input.title,
      description: input.description,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    });
  } catch (error) {
    if (
      pgErrorCode(error) === PG_ERROR.CHECK_VIOLATION &&
      pgErrorConstraint(error) === 'events_time_range_check'
    ) {
      throw new BadRequestError('endsAt must be after startsAt');
    }
    throw error;
  }

  if (updated === null) {
    // The lock guarantees the row still exists; this would mean it vanished
    // between the lock and here, which nothing in this system does.
    throw new Error('Event disappeared while updating it');
  }

  logger.info('Updated event', { requestId, eventId: updated.id, organiserId: locked.organiserId });

  return updated;
}

export async function updateEvent(
  input: UpdateEventInput,
  requestId: string | undefined,
): Promise<EventRecord> {
  return withTransaction((client) => updateEventInTransaction(client, input, requestId));
}

/**
 * Publishes a draft event: `draft` -> `published`, guarded and one-way.
 *
 * VALIDATION ORDER: ownership and state under the lock first, then the
 * business checks that need real data (seat inventory), then the guarded
 * transition itself.
 *
 * The zero-seat check is defensive rather than load-bearing: `createEvent`
 * already refuses to create an event with no seat inventory, so today nothing
 * can reach here with zero seats. It stays because the rule is explicitly
 * required, and because "refuse rather than assume" is what every other
 * should-be-unreachable check in this codebase already does.
 *
 * The timing check the task also asks for - `endsAt > startsAt` - is not
 * repeated here for the opposite reason: it is not merely unreachable today,
 * it is unreachable *by construction*, because `events_time_range_check`
 * makes the invalid state impossible to store in the first place. Re-checking
 * it in JavaScript would not add safety, only a second copy of a rule the
 * database already guarantees.
 *
 * GUARDED TRANSITION: `UPDATE events SET status = 'published' WHERE id = $1
 * AND status = 'draft'`. Fifty concurrent publish calls therefore produce
 * exactly one row change; PostgreSQL's row lock on the UPDATE target - the
 * same mechanism `markTicketUsed` relies on - is what makes that true, not
 * anything in this function deciding who goes first.
 */
export async function publishEventInTransaction(
  client: PoolClient,
  input: PublishEventInput,
  requestId: string | undefined,
): Promise<EventRecord> {
  const locked = await lockEventForOwnership(client, input.eventId);

  if (locked === null) {
    logger.warn('Rejected event publish', { requestId, eventId: input.eventId, reason: 'EVENT_NOT_FOUND' });
    throw eventNotFound();
  }

  if (!isOwnerOrAdmin(locked, input)) {
    logger.warn('Rejected event publish', {
      requestId,
      eventId: input.eventId,
      userId: input.userId,
      reason: 'EVENT_NOT_OWNED',
    });
    throw eventNotFound();
  }

  if (locked.status !== 'draft') {
    logger.warn('Rejected event publish', {
      requestId,
      eventId: input.eventId,
      reason: 'INVALID_EVENT_STATE',
      currentStatus: locked.status,
    });
    throw new ConflictError(
      locked.status === 'published' ? 'This event has already been published' : `A ${locked.status} event cannot be published`,
      { reason: locked.status === 'published' ? 'EVENT_ALREADY_PUBLISHED' : 'INVALID_EVENT_STATE' },
    );
  }

  const seatCount = await countAvailableSeats(client, input.eventId);
  if (seatCount === 0) {
    // See the doc comment above: kept as a refusal, not an assumption.
    logger.error('Refusing to publish an event with no seat inventory', {
      requestId,
      eventId: input.eventId,
    });
    throw new ConflictError('This event has no seat inventory and cannot be published', {
      reason: 'EVENT_HAS_NO_SEATS',
    });
  }

  const published = await markEventPublished(client, input.eventId);
  if (published === null) {
    // Guarded on `status = 'draft'`, which the check above already confirmed
    // under the same lock - unreachable unless the lock itself failed to hold.
    throw new Error('Event was no longer draft when publishing');
  }

  logger.info('Published event', { requestId, eventId: published.id, organiserId: locked.organiserId });

  return published;
}

export async function publishEvent(
  input: PublishEventInput,
  requestId: string | undefined,
): Promise<EventRecord> {
  return withTransaction((client) => publishEventInTransaction(client, input, requestId));
}

/**
 * Deletes an event outright - only a draft, and only one with no history to
 * lose.
 *
 * WHY DRAFT-ONLY, NOT MERELY "NO BOOKINGS". A published event with zero
 * bookings would also pass a bare history check, but publishing is what makes
 * an event publicly discoverable - see `getEventById` - and physically
 * removing something that may already have been shown to customers is a
 * different, riskier operation than deleting a draft nobody has ever seen.
 * This task introduces no "unpublish" or archive lifecycle for a live event,
 * so a published event simply cannot be deleted through this endpoint at all,
 * regardless of bookings.
 *
 * PHYSICAL DELETE VS CANCELLATION, for the draft case. An event with any
 * booking or hold is a record other people's activity depends on, and
 * `bookings.event_id` is itself `ON DELETE RESTRICT` for exactly that reason.
 * Rather than let that surface as a raw constraint violation, `hasEventHistory`
 * checks the same fact first and answers with a deliberate `EVENT_HAS_BOOKINGS`
 * conflict - the FK remains as a backstop, caught below, for the narrow race
 * where a hold is created concurrently between that check and the DELETE (see
 * the note on that race in the final report; closing it completely would mean
 * reservation creation also locking `events`, a change to a different,
 * heavily-tested module this task does not make).
 *
 * A pristine draft - no holds, no bookings, ever - is deleted for real:
 * `ON DELETE CASCADE` from `show_seats.event_id` takes its inventory with it,
 * and nothing else can be referencing that inventory if history is empty.
 *
 * No business-level "cancel" state is introduced as an alternative: the task
 * does not ask for one, `events.status` already has `cancelled` sitting
 * unused in its CHECK constraint for a future feature to claim, and inventing
 * a transition nothing currently reads would be exactly the kind of
 * speculative machinery this codebase's own migrations repeatedly avoid.
 */
export async function deleteEventInTransaction(
  client: PoolClient,
  input: DeleteEventInput,
  requestId: string | undefined,
): Promise<void> {
  const locked = await lockEventForOwnership(client, input.eventId);

  if (locked === null) {
    logger.warn('Rejected event deletion', { requestId, eventId: input.eventId, reason: 'EVENT_NOT_FOUND' });
    throw eventNotFound();
  }

  if (!isOwnerOrAdmin(locked, input)) {
    logger.warn('Rejected event deletion', {
      requestId,
      eventId: input.eventId,
      userId: input.userId,
      reason: 'EVENT_NOT_OWNED',
    });
    throw eventNotFound();
  }

  if (locked.status !== 'draft') {
    // "Retained for drafts with no inventory/bookings" - deliberately
    // narrower than "no history": a *published* event with zero bookings
    // could satisfy `hasEventHistory` too, but it is publicly discoverable,
    // and physically removing something customers may already have seen
    // listed is a different, riskier operation than deleting a draft nobody
    // has ever been shown. There is no lifecycle for un-publishing a live
    // event in this task; see the final report.
    logger.warn('Rejected event deletion', {
      requestId,
      eventId: input.eventId,
      reason: 'INVALID_EVENT_STATE',
      currentStatus: locked.status,
    });
    throw new ConflictError(`A ${locked.status} event cannot be deleted`, {
      reason: 'INVALID_EVENT_STATE',
    });
  }

  if (await hasEventHistory(client, input.eventId)) {
    logger.warn('Rejected event deletion', {
      requestId,
      eventId: input.eventId,
      reason: 'EVENT_HAS_BOOKINGS',
    });
    throw new ConflictError('This event has bookings or holds and cannot be deleted', {
      reason: 'EVENT_HAS_BOOKINGS',
    });
  }

  try {
    if (!(await deleteEventRow(client, input.eventId))) {
      throw new Error('Event was no longer present when deleting it');
    }
  } catch (error) {
    if (
      pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION &&
      pgErrorConstraint(error) === 'bookings_event_id_fkey'
    ) {
      // The backstop described above: a booking arrived concurrently.
      throw new ConflictError('This event has bookings or holds and cannot be deleted', {
        reason: 'EVENT_HAS_BOOKINGS',
      });
    }
    throw error;
  }

  logger.info('Deleted event', { requestId, eventId: input.eventId, organiserId: locked.organiserId });
}

export async function deleteEvent(input: DeleteEventInput, requestId: string | undefined): Promise<void> {
  return withTransaction((client) => deleteEventInTransaction(client, input, requestId));
}

/**
 * Lists events for the organiser management view.
 *
 * `organiser` sees only their own events - `WHERE organiser_id = $1`, done by
 * PostgreSQL, never "fetch everything and filter in JavaScript". `admin`
 * defaults to the same scoping (their own events, of which there are
 * typically none) and must explicitly ask for `all: true` to see every
 * organiser's events - see `organiserEventListQuerySchema` for why an
 * organiser's own `all=true` is silently ignored rather than rejected.
 *
 * Offset pagination (`page`/`limit`), not a cursor: nothing in this API uses
 * cursors yet, and an organiser's own event list is not the kind of
 * fast-growing, high-concurrency feed where offset pagination's known
 * weakness - a page shifting under concurrent inserts - is worth the extra
 * complexity of introducing this project's first cursor-based endpoint.
 *
 * Two queries, not N+1: one for the page of events (with venue name joined
 * in), one batched query for every one of those events' available-seat
 * counts. Never one `countAvailableSeats` call per row.
 */
export async function listOrganiserEvents(input: ListOrganiserEventsInput): Promise<ListOrganiserEventsResult> {
  const scopeToAdmin = input.all && input.userRole === 'admin';
  const organiserId = scopeToAdmin ? null : input.userId;

  const total = await countEventsForListing(pool, organiserId);
  const page = await listEventsPage(pool, { organiserId, page: input.page, limit: input.limit });

  const availableSeatsByEvent = await countAvailableSeatsForEvents(
    pool,
    page.map((record) => record.event.id),
  );

  return {
    events: page.map((record) => toPrivateView(record, availableSeatsByEvent.get(record.event.id) ?? 0)),
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}
