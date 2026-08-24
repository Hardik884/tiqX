import { z } from 'zod';

import { SEAT_CATEGORIES } from '../events/event.types.js';

/**
 * `.strict()` throughout, matching every other schema in this codebase: a
 * client sending a field this endpoint does not accept is told so, rather
 * than having it silently dropped and assuming it took effect.
 */
export const createVenueSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    // Nullable in the database and deliberately not backfilled - see the
    // event-discovery migration. A venue with no city simply never matches a
    // city filter.
    city: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const updateVenueSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    // Empty string clears the column; the create schema has no such case
    // because there is nothing to clear yet.
    description: z.string().trim().max(2000).optional(),
    city: z.string().trim().max(100).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export const venueIdParamsSchema = z.object({
  venueId: z.uuid(),
});

export const venueSeatParamsSchema = z.object({
  venueId: z.uuid(),
  seatId: z.uuid(),
});

/**
 * Rows are capped so one request cannot ask for an unbounded insert: 26 rows
 * of 100 is larger than any venue this system is built for, and the ceiling
 * is what keeps a typo from turning into a million-row statement.
 */
const MAX_ROWS_PER_REQUEST = 26;
const MAX_SEATS_PER_ROW = 100;

const seatRowSchema = z
  .object({
    rowLabel: z.string().trim().min(1).max(8),
    fromSeat: z.coerce.number().int().min(1).max(1000),
    toSeat: z.coerce.number().int().min(1).max(1000),
    category: z.enum(SEAT_CATEGORIES),
  })
  .strict()
  .refine((value) => value.toSeat >= value.fromSeat, {
    message: 'toSeat must not be before fromSeat',
    path: ['toSeat'],
  })
  .refine((value) => value.toSeat - value.fromSeat + 1 <= MAX_SEATS_PER_ROW, {
    message: `A row may not contain more than ${MAX_SEATS_PER_ROW} seats`,
    path: ['toSeat'],
  });

export const addVenueSeatsSchema = z
  .object({
    rows: z.array(seatRowSchema).min(1).max(MAX_ROWS_PER_REQUEST),
  })
  .strict();

/** The only field of a physical seat that is editable: which category it sells as. */
export const updateVenueSeatSchema = z
  .object({
    category: z.enum(SEAT_CATEGORIES),
  })
  .strict();

export type CreateVenueBody = z.infer<typeof createVenueSchema>;
export type UpdateVenueBody = z.infer<typeof updateVenueSchema>;
export type AddVenueSeatsBody = z.infer<typeof addVenueSeatsSchema>;
export type UpdateVenueSeatBody = z.infer<typeof updateVenueSeatSchema>;
