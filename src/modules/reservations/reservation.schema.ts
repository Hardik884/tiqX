import { z } from 'zod';

/** A hold covers a seat selection, not a block booking. */
export const MAX_SEATS_PER_HOLD = 10;

/**
 * Bounds on how long a hold may live. The floor stops a hold expiring before
 * the customer can realistically pay; the ceiling stops inventory being parked
 * indefinitely by a client asking for a huge TTL.
 */
export const MIN_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 900;
export const DEFAULT_TTL_SECONDS = 600;

export const holdParamsSchema = z.object({
  eventId: z.uuid(),
});

/**
 * Note what is absent: `userId`.
 *
 * The hold's owner is the authenticated principal and nothing else. There is no
 * fallback to a body field, because a fallback *is* the vulnerability - any
 * client could then nominate whose hold it was creating.
 *
 * `.strict()` makes the removal enforceable rather than merely intended: a
 * client still sending `userId` gets a 400 naming the field, instead of having
 * it quietly ignored and believing it worked.
 */
export const createHoldSchema = z
  .object({
    showSeatIds: z
      .array(z.uuid())
      .min(1, 'At least one seat must be requested')
      .max(MAX_SEATS_PER_HOLD, `At most ${MAX_SEATS_PER_HOLD} seats may be held at once`)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'showSeatIds must not contain duplicate ids',
      }),
    ttlSeconds: z
      .number()
      .int()
      .min(MIN_TTL_SECONDS)
      .max(MAX_TTL_SECONDS)
      .default(DEFAULT_TTL_SECONDS),
  })
  .strict();

export type CreateHoldBody = z.infer<typeof createHoldSchema>;
