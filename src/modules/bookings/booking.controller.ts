import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import { requireUser } from '../../middleware/authenticate.js';
import { hashCancelRequest, hashConfirmRequest } from '../idempotency/idempotency.hash.js';
import { IDEMPOTENCY_HEADER, idempotencyKeySchema } from '../idempotency/idempotency.schema.js';
import { runIdempotently } from '../idempotency/idempotency.service.js';
import {
  bookingDetailParamsSchema,
  cancelParamsSchema,
  confirmParamsSchema,
  myBookingsQuerySchema,
} from './booking.schema.js';
import {
  cancelBookingInTransaction,
  confirmHoldInTransaction,
  getMyBookingDetail,
  listMyBookings,
} from './booking.service.js';

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

interface CancellationResponseBody {
  bookingId: string;
  bookingReference: string;
  eventId: string;
  status: string;
  releasedSeatCount: number;
  /** Unchanged by cancellation; echoed so the client can show what was paid. */
  totalAmount: string;
  currency: string;
  cancelledAt: string;
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

/**
 * HTTP concerns only. Like confirmation, there is no request body at all, so
 * the owner of the cancellation cannot be anything but the authenticated
 * principal.
 *
 * 200 rather than 201: cancelling changes a booking, it does not create a
 * resource. The Idempotency-Key is required for the same reason it is on
 * confirmation - a client that loses the response to a network blip will retry,
 * and that retry must not be answered as a fresh cancellation.
 */
export async function cancelBookingHandler(req: Request, res: Response): Promise<void> {
  const params = cancelParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid booking id', toFieldErrors(params.error.issues));
  }

  const idempotencyKey = readIdempotencyKey(req);
  const { id: userId } = requireUser(req);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const input = { userId, bookingId: params.data.bookingId };

  const outcome = await runIdempotently<CancellationResponseBody>(
    {
      userId,
      key: idempotencyKey,
      requestHash: hashCancelRequest(input),
      successStatus: 200,
    },
    async (client) => {
      const result = await cancelBookingInTransaction(client, input, requestId);

      return {
        bookingId: result.booking.id,
        bookingReference: result.booking.bookingReference,
        eventId: result.booking.eventId,
        status: result.booking.status,
        releasedSeatCount: result.releasedSeatCount,
        totalAmount: result.booking.totalAmount,
        currency: result.booking.currency,
        cancelledAt: result.booking.updatedAt.toISOString(),
      };
    },
  );

  res.status(outcome.statusCode).json(outcome.body);
}

/** GET /api/v1/bookings - the caller's own bookings. */
export async function listMyBookingsHandler(req: Request, res: Response): Promise<void> {
  const parsedQuery = myBookingsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    throw new BadRequestError('Invalid query parameters', toFieldErrors(parsedQuery.error.issues));
  }

  const { id: userId } = requireUser(req);
  const result = await listMyBookings(userId, parsedQuery.data);

  res.status(200).json({
    bookings: result.bookings.map((item) => ({
      bookingId: item.booking.id,
      bookingReference: item.booking.bookingReference,
      status: item.booking.status,
      totalAmount: item.booking.totalAmount,
      currency: item.booking.currency,
      createdAt: item.booking.createdAt.toISOString(),
      eventId: item.booking.eventId,
      eventTitle: item.eventTitle,
      eventStartsAt: item.eventStartsAt.toISOString(),
      venueName: item.venueName,
      seatCount: item.seatCount,
      ticketCount: item.ticketCount,
    })),
    page: result.page,
    limit: result.limit,
    total: result.total,
    totalPages: result.totalPages,
  });
}

/** GET /api/v1/bookings/:bookingId - full detail, scoped to the caller. */
export async function getMyBookingDetailHandler(req: Request, res: Response): Promise<void> {
  const params = bookingDetailParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid booking id', toFieldErrors(params.error.issues));
  }

  const { id: userId } = requireUser(req);
  const detail = await getMyBookingDetail(params.data.bookingId, userId);

  res.status(200).json({
    bookingId: detail.booking.id,
    bookingReference: detail.booking.bookingReference,
    status: detail.booking.status,
    totalAmount: detail.booking.totalAmount,
    currency: detail.booking.currency,
    createdAt: detail.booking.createdAt.toISOString(),
    eventId: detail.booking.eventId,
    eventTitle: detail.eventTitle,
    eventStartsAt: detail.eventStartsAt.toISOString(),
    eventEndsAt: detail.eventEndsAt.toISOString(),
    venueName: detail.venueName,
    venueCity: detail.venueCity,
    seats: detail.seats.map((seat) => ({
      showSeatId: seat.showSeatId,
      rowLabel: seat.rowLabel,
      seatNumber: seat.seatNumber,
      price: seat.price,
      cancelled: seat.cancelled,
    })),
    tickets: detail.tickets.map((ticket) => ({
      id: ticket.id,
      ticketReference: ticket.ticketReference,
      status: ticket.status,
      issuedAt: ticket.issuedAt.toISOString(),
      usedAt: ticket.usedAt ? ticket.usedAt.toISOString() : null,
    })),
  });
}
