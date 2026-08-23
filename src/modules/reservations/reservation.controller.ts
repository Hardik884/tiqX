import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import { createHoldSchema, holdParamsSchema } from './reservation.schema.js';
import { createHold } from './reservation.service.js';

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
 * HTTP concerns only: validate the URL and body, call the service, shape the
 * response. Every seat rule, lock and transaction lives in the service.
 *
 * userId comes from the body for now and will come from the authenticated
 * principal once authentication exists.
 */
export async function createHoldHandler(req: Request, res: Response): Promise<void> {
  const params = holdParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw new BadRequestError('Invalid event id', toFieldErrors(params.error.issues));
  }

  const body = createHoldSchema.safeParse(req.body);
  if (!body.success) {
    throw new BadRequestError('Invalid hold payload', toFieldErrors(body.error.issues));
  }

  const result = await createHold({
    eventId: params.data.eventId,
    userId: body.data.userId,
    showSeatIds: body.data.showSeatIds,
    ttlSeconds: body.data.ttlSeconds,
  });

  res.status(201).json({
    holdId: result.holdId,
    eventId: result.eventId,
    showSeatIds: result.showSeatIds,
    status: result.status,
    expiresAt: result.expiresAt.toISOString(),
  });
}
