import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import { requireUser } from '../../middleware/authenticate.js';
import { hashIssueTicketsRequest } from '../idempotency/idempotency.hash.js';
import { IDEMPOTENCY_HEADER, idempotencyKeySchema } from '../idempotency/idempotency.schema.js';
import { runIdempotently } from '../idempotency/idempotency.service.js';
import { issueTicketsParamsSchema, verifyTicketParamsSchema } from './ticket.schema.js';
import { issueTicketsInTransaction, verifyTicket } from './ticket.service.js';
import type { TicketQrPayload, TicketRecord } from './ticket.types.js';

interface FieldError {
  field: string;
  message: string;
}

interface IssuedTicketBody {
  ticketId: string;
  ticketReference: string;
  status: string;
  issuedAt: string;
  /** The payload a future QR code encodes - see ticket.types.ts. */
  qrPayload: TicketQrPayload;
}

interface IssueTicketsResponseBody {
  bookingId: string;
  eventId: string;
  ticketCount: number;
  tickets: IssuedTicketBody[];
}

interface VerifyTicketResponseBody {
  ticketReference: string;
  status: string;
  usedAt: string;
  eventId: string;
  seatId: string;
  verifiedAt: string;
}

function toFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Required, not optional - the same reasoning as `readIdempotencyKey` in
 * booking.controller.ts. Issuing tickets is not something a client can safely
 * retry blind: a lost response must replay the tickets already cut, not mint
 * a second, constraint-violating set.
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

function toIssuedTicketBody(ticket: TicketRecord): IssuedTicketBody {
  return {
    ticketId: ticket.id,
    ticketReference: ticket.ticketReference,
    status: ticket.status,
    issuedAt: ticket.issuedAt.toISOString(),
    qrPayload: { v: 1, ticketId: ticket.id, ticketReference: ticket.ticketReference },
  };
}

/**
 * HTTP concerns only. The caller cannot name whose booking to issue for -
 * that comes entirely from the URL - and cannot name themselves as anyone but
 * `req.user.id`; there is no request body for either to hide in.
 */
export async function issueTicketsHandler(req: Request, res: Response): Promise<void> {
  const params = issueTicketsParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid booking id', toFieldErrors(params.error.issues));
  }

  const idempotencyKey = readIdempotencyKey(req);
  const { id: userId, role: userRole } = requireUser(req);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const input = { userId, userRole, bookingId: params.data.bookingId };

  const outcome = await runIdempotently<IssueTicketsResponseBody>(
    {
      userId,
      key: idempotencyKey,
      requestHash: hashIssueTicketsRequest(input),
      successStatus: 201,
    },
    async (client) => {
      const result = await issueTicketsInTransaction(client, input, requestId);

      return {
        bookingId: result.bookingId,
        eventId: result.eventId,
        ticketCount: result.tickets.length,
        tickets: result.tickets.map(toIssuedTicketBody),
      };
    },
  );

  res.status(outcome.statusCode).json(outcome.body);
}

/**
 * HTTP concerns only. No Idempotency-Key: see the doc comment on
 * `verifyTicketInTransaction` for why a retried scan is answered by the
 * state machine itself rather than replayed.
 */
export async function verifyTicketHandler(req: Request, res: Response): Promise<void> {
  const params = verifyTicketParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid ticket id', toFieldErrors(params.error.issues));
  }

  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const result = await verifyTicket({ ticketId: params.data.ticketId }, requestId);

  const body: VerifyTicketResponseBody = {
    ticketReference: result.ticket.ticketReference,
    status: result.ticket.status,
    // Guaranteed non-null: `markTicketUsed` only ever returns a ticket it
    // just set to `used`, and the schema requires `used_at` whenever it does.
    usedAt: result.ticket.usedAt!.toISOString(),
    eventId: result.eventId,
    seatId: result.showSeatId,
    verifiedAt: new Date().toISOString(),
  };

  res.status(200).json(body);
}
