import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import { hashHoldRequest } from '../idempotency/idempotency.hash.js';
import { IDEMPOTENCY_HEADER, idempotencyKeySchema } from '../idempotency/idempotency.schema.js';
import { runIdempotently } from '../idempotency/idempotency.service.js';
import { createHoldSchema, holdParamsSchema } from './reservation.schema.js';
import { createHoldInTransaction } from './reservation.service.js';

interface FieldError {
  field: string;
  message: string;
}

interface HoldResponseBody {
  holdId: string;
  eventId: string;
  showSeatIds: string[];
  status: string;
  expiresAt: string;
}

function toFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Reads and validates the Idempotency-Key header.
 *
 * The key is required and never generated on the client's behalf: a key the
 * server invented would be different on every retry, which is precisely the
 * thing it is supposed to prevent. A repeated header arrives as an array and is
 * rejected as malformed rather than silently resolved to one of the values.
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
 * HTTP concerns only: validate the URL, header and body, then hand the
 * reservation to the idempotency wrapper, which owns the transaction that the
 * hold and the stored response both commit in.
 *
 * userId comes from the body for now and will come from the authenticated
 * principal once authentication exists. It already scopes the idempotency key,
 * so that change will not alter the storage model.
 */
export async function createHoldHandler(req: Request, res: Response): Promise<void> {
  const params = holdParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid event id', toFieldErrors(params.error.issues));
  }

  // Validated before the body so a client missing the header learns that first,
  // whatever else is wrong with the request.
  const idempotencyKey = readIdempotencyKey(req);

  const body = createHoldSchema.safeParse(req.body);
  if (!body.success) {
    throw new BadRequestError('Invalid hold payload', toFieldErrors(body.error.issues));
  }

  const input = {
    eventId: params.data.eventId,
    userId: body.data.userId,
    showSeatIds: body.data.showSeatIds,
    ttlSeconds: body.data.ttlSeconds,
  };

  const outcome = await runIdempotently<HoldResponseBody>(
    {
      userId: input.userId,
      key: idempotencyKey,
      requestHash: hashHoldRequest(input),
      successStatus: 201,
    },
    async (client) => {
      const result = await createHoldInTransaction(client, input);

      // Built here so the object stored for replay is byte-for-byte the one the
      // first caller received.
      return {
        holdId: result.holdId,
        eventId: result.eventId,
        showSeatIds: result.showSeatIds,
        status: result.status,
        expiresAt: result.expiresAt.toISOString(),
      };
    },
  );

  res.status(outcome.statusCode).json(outcome.body);
}
