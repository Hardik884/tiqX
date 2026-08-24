import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import { requireUser } from '../../middleware/authenticate.js';
import {
  createEventSchema,
  eventIdParamsSchema,
  organiserEventListQuerySchema,
  updateEventSchema,
} from './event.schema.js';
import {
  createEvent,
  deleteEvent,
  getEventById,
  listOrganiserEvents,
  publishEvent,
  updateEvent,
} from './event.service.js';

interface FieldError {
  field: string;
  message: string;
}

function toFieldErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Parses and validates the request, then hands off to the service. All domain
 * rules and transaction handling live in the service, not here.
 *
 * The organiser is the authenticated principal. The route already restricts
 * this to organiser and admin roles, so reaching here means the caller may
 * create events; whose name they appear under is not theirs to choose.
 */
export async function createEventHandler(req: Request, res: Response): Promise<void> {
  const parsed = createEventSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new BadRequestError('Invalid event payload', toFieldErrors(parsed.error.issues));
  }

  const body = parsed.data;
  const { id: organiserId } = requireUser(req);

  const result = await createEvent({
    organiserId,
    venueId: body.venueId,
    title: body.title,
    description: body.description,
    eventType: body.eventType,
    startsAt: new Date(body.startsAt),
    endsAt: new Date(body.endsAt),
    status: body.status,
    pricing: body.pricing,
    currency: body.currency,
  });

  res.status(201).json({
    event: result.event,
    seatInventoryCount: result.seatInventoryCount,
  });
}

function parseEventId(req: Request): string {
  const params = eventIdParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid event id', toFieldErrors(params.error.issues));
  }
  return params.data.eventId;
}

/**
 * Public for an anonymous or customer caller, private for the event's own
 * organiser or an admin - see `getEventById` for how that split is decided.
 * `req.user` is optional here on purpose: this route runs behind
 * `optionalAuth`, not `requireAuth`, so browsing events never requires
 * signing in.
 */
export async function getEventHandler(req: Request, res: Response): Promise<void> {
  const eventId = parseEventId(req);

  const view = await getEventById(
    eventId,
    req.user === undefined ? undefined : { userId: req.user.id, userRole: req.user.role },
  );

  res.status(200).json(view);
}

/**
 * HTTP concerns only. Ownership is resolved inside `updateEvent`, under the
 * event's row lock - see the service for why that, and not a check here, is
 * the actual security boundary.
 */
export async function updateEventHandler(req: Request, res: Response): Promise<void> {
  const eventId = parseEventId(req);

  const body = updateEventSchema.safeParse(req.body);
  if (!body.success) {
    throw new BadRequestError('Invalid event payload', toFieldErrors(body.error.issues));
  }

  const { id: userId, role: userRole } = requireUser(req);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const event = await updateEvent(
    {
      eventId,
      userId,
      userRole,
      title: body.data.title,
      description: body.data.description,
      startsAt: body.data.startsAt === undefined ? undefined : new Date(body.data.startsAt),
      endsAt: body.data.endsAt === undefined ? undefined : new Date(body.data.endsAt),
    },
    requestId,
  );

  res.status(200).json({ event });
}

/** No request body: publishing is a state transition, not a field update. */
export async function publishEventHandler(req: Request, res: Response): Promise<void> {
  const eventId = parseEventId(req);
  const { id: userId, role: userRole } = requireUser(req);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const event = await publishEvent({ eventId, userId, userRole }, requestId);

  res.status(200).json({ event });
}

/** 204: nothing to return once the event is gone. */
export async function deleteEventHandler(req: Request, res: Response): Promise<void> {
  const eventId = parseEventId(req);
  const { id: userId, role: userRole } = requireUser(req);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  await deleteEvent({ eventId, userId, userRole }, requestId);

  res.status(204).end();
}

/**
 * GET /api/v1/organiser/events - "my events", database-paginated. See
 * `listOrganiserEvents` for the admin `all=true` escape hatch.
 */
export async function listOrganiserEventsHandler(req: Request, res: Response): Promise<void> {
  const parsedQuery = organiserEventListQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    throw new BadRequestError('Invalid query parameters', toFieldErrors(parsedQuery.error.issues));
  }

  const { id: userId, role: userRole } = requireUser(req);

  const result = await listOrganiserEvents({
    userId,
    userRole,
    page: parsedQuery.data.page,
    limit: parsedQuery.data.limit,
    all: parsedQuery.data.all,
  });

  res.status(200).json(result);
}

