import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import { requireUser } from '../../middleware/authenticate.js';
import { hashConfirmRequest } from '../idempotency/idempotency.hash.js';
import { IDEMPOTENCY_HEADER, idempotencyKeySchema } from '../idempotency/idempotency.schema.js';
import { runIdempotently } from '../idempotency/idempotency.service.js';
import { confirmParamsSchema } from './booking.schema.js';
import { confirmHoldInTransaction } from './booking.service.js';

interface FieldError {
  field: string;
  message: string;
}

interface BookingResponseBody {
  bookingId: string;
  bookingReference: string;
  eventId: string;
  holdId: string;
  status: string;
  seatCount: number;
  totalAmount: string;
  currency: string;
  createdAt: string;
}

function toFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Required, not optional.
 *
 * Confirmation is the least replayable operation in the system: a client that
 * loses the response to a network blip has no way to tell whether it bought
 * tickets. Making the key mandatory means the retry it will inevitably send is
 * answered with the original booking instead of a second one.
 */
function readIdempotencyKey(req: Request): string {
  const raw = req.headers[IDEMPOTENCY_HEADER];

  if (raw === undefined) {
    throw new BadRequestError(`${IDEMPOTENCY_HEADER} header is required`);
  }
  if (Array.isArray(raw)) {
    throw new BadRequestError(`${IDEMPOTENCY_HEADER} header must be sent exactly once`);
  }

  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid ${IDEMPOTENCY_HEADER} header`,
      toFieldErrors(parsed.error.issues),
    );
  }

  return parsed.data;
}

/**
 * HTTP concerns only. The owner of the booking is the authenticated principal
 * and cannot be anything else: there is no request body here at all, so there
 * is nothing a client could put in one.
 */
export async function confirmHoldHandler(req: Request, res: Response): Promise<void> {
  const params = confirmParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid event or hold id', toFieldErrors(params.error.issues));
  }

  const idempotencyKey = readIdempotencyKey(req);
  const { id: userId } = requireUser(req);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const input = {
    userId,
    eventId: params.data.eventId,
    holdId: params.data.holdId,
  };

  const outcome = await runIdempotently<BookingResponseBody>(
    {
      userId,
      key: idempotencyKey,
      requestHash: hashConfirmRequest(input),
      successStatus: 201,
    },
    async (client) => {
      const result = await confirmHoldInTransaction(client, input, requestId);

      return {
        bookingId: result.booking.id,
        bookingReference: result.booking.bookingReference,
        eventId: result.booking.eventId,
        holdId: result.booking.holdId,
        status: result.booking.status,
        seatCount: result.seatCount,
        totalAmount: result.booking.totalAmount,
        currency: result.booking.currency,
        createdAt: result.booking.createdAt.toISOString(),
      };
    },
  );

  res.status(outcome.statusCode).json(outcome.body);
}
