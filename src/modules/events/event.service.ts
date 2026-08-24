import { PG_ERROR, pgErrorCode, pgErrorConstraint } from '../../db/pg-error.js';
import { withTransaction } from '../../db/pool.js';
import { BadRequestError } from '../../errors/app-error.js';
import { createShowSeatsForEvent } from '../seats/show-seat.repository.js';
import { listVenueSeatIds, venueExists } from '../venues/venue.repository.js';
import { insertEvent } from './event.repository.js';
import type { CreateEventInput, EventRecord } from './event.types.js';

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
