import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import { createEventSchema } from './event.schema.js';
import { createEvent } from './event.service.js';

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
 * organiserId is taken from the request body for now; it will come from the
 * authenticated user once authentication exists.
 */
export async function createEventHandler(req: Request, res: Response): Promise<void> {
  const parsed = createEventSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new BadRequestError('Invalid event payload', toFieldErrors(parsed.error.issues));
  }

  const body = parsed.data;

  const result = await createEvent({
    organiserId: body.organiserId,
    venueId: body.venueId,
    title: body.title,
    description: body.description,
    eventType: body.eventType,
    startsAt: new Date(body.startsAt),
    endsAt: new Date(body.endsAt),
    status: body.status,
  });

  res.status(201).json({
    event: result.event,
    seatInventoryCount: result.seatInventoryCount,
  });
}

