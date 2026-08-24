import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import { requireUser } from '../../middleware/authenticate.js';
import { hashAcceptOfferRequest, hashJoinWaitlistRequest } from '../idempotency/idempotency.hash.js';
import { IDEMPOTENCY_HEADER, idempotencyKeySchema } from '../idempotency/idempotency.schema.js';
import { runIdempotently } from '../idempotency/idempotency.service.js';
import {
  acceptOfferParamsSchema,
  joinBodySchema,
  joinParamsSchema,
  leaveParamsSchema,
} from './waitlist.schema.js';
import {
  acceptWaitlistOfferInTransaction,
  joinWaitlistInTransaction,
  leaveWaitlist,
} from './waitlist.service.js';

interface FieldError {
  field: string;
  message: string;
}

interface JoinResponseBody {
  waitlistEntryId: string;
  eventId: string;
  seatCategory: string;
  status: string;
}

interface LeaveResponseBody {
  waitlistEntryId: string;
  status: string;
}

interface AcceptOfferResponseBody {
  offerId: string;
  eventId: string;
  status: string;
  bookingId: string;
  bookingReference: string;
}

function toFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Required on every state-changing waitlist request, for the same reason it
 * is required on hold creation, confirmation and cancellation: each of these
 * is a write a client may retry blind after a network failure, and a required
 * key is what turns that retry into a replay instead of a duplicate.
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
 * HTTP concerns only. The owner is always the authenticated principal; the
 * body carries only what the customer is actually choosing - which category -
 * never who they are.
 */
export async function joinWaitlistHandler(req: Request, res: Response): Promise<void> {
  const params = joinParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid event id', toFieldErrors(params.error.issues));
  }

  const body = joinBodySchema.safeParse(req.body);
  if (!body.success) {
    throw new BadRequestError('Invalid waitlist join request', toFieldErrors(body.error.issues));
  }

  const idempotencyKey = readIdempotencyKey(req);
  const { id: userId } = requireUser(req);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const input = { userId, eventId: params.data.eventId, seatCategory: body.data.seatCategory };

  const outcome = await runIdempotently<JoinResponseBody>(
    {
      userId,
      key: idempotencyKey,
      requestHash: hashJoinWaitlistRequest(input),
      successStatus: 201,
    },
    async (client) => {
      const result = await joinWaitlistInTransaction(client, input, requestId);
      return {
        waitlistEntryId: result.entry.id,
        eventId: result.entry.eventId,
        seatCategory: result.entry.seatCategory,
        status: result.entry.status,
      };
    },
  );

  res.status(outcome.statusCode).json(outcome.body);
}

/**
 * HTTP concerns only. No idempotency key: leaving is naturally idempotent
 * through its own guarded state transition - a second call finds the entry
 * already `cancelled` and answers with the same 409 an outright reuse would -
 * matching the reasoning `verifyTicketHandler` already documents for the same
 * choice.
 */
export async function leaveWaitlistHandler(req: Request, res: Response): Promise<void> {
  const params = leaveParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid event or entry id', toFieldErrors(params.error.issues));
  }

  const { id: userId } = requireUser(req);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const result = await leaveWaitlist({ userId, entryId: params.data.entryId }, requestId);

  const body: LeaveResponseBody = { waitlistEntryId: result.id, status: result.status };
  res.status(200).json(body);
}

/**
 * HTTP concerns only. The offer id and the authenticated caller are the
 * entire authorization mechanism - see waitlist.service.ts and the report's
 * note on why a bare offer id is not, by itself, a credential.
 */
export async function acceptWaitlistOfferHandler(req: Request, res: Response): Promise<void> {
  const params = acceptOfferParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid offer id', toFieldErrors(params.error.issues));
  }

  const idempotencyKey = readIdempotencyKey(req);
  const { id: userId } = requireUser(req);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const input = { userId, offerId: params.data.offerId };

  const outcome = await runIdempotently<AcceptOfferResponseBody>(
    {
      userId,
      key: idempotencyKey,
      requestHash: hashAcceptOfferRequest(input),
      successStatus: 200,
    },
    async (client) => {
      const result = await acceptWaitlistOfferInTransaction(client, input, requestId);
      return {
        offerId: result.offer.id,
        eventId: result.eventId,
        status: result.offer.status,
        bookingId: result.bookingId,
        bookingReference: result.bookingReference,
      };
    },
  );

  res.status(outcome.statusCode).json(outcome.body);
}
