import type { Request, Response } from 'express';

import { BadRequestError } from '../../errors/app-error.js';
import {
  addVenueSeatsSchema,
  createVenueSchema,
  updateVenueSchema,
  updateVenueSeatSchema,
  venueIdParamsSchema,
  venueSeatParamsSchema,
} from './venue.schema.js';
import {
  addVenueSeats,
  createVenue,
  getVenue,
  listVenues,
  listVenueSeats,
  removeVenueSeat,
  setVenueSeatCategory,
  updateVenue,
} from './venue.service.js';

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

function parseVenueId(req: Request): string {
  const parsed = venueIdParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    throw new BadRequestError('Invalid venue id', toFieldErrors(parsed.error.issues));
  }
  return parsed.data.venueId;
}

/** GET /api/v1/venues - organiser/admin, for the event create/edit form. */
export async function listVenuesHandler(_req: Request, res: Response): Promise<void> {
  const venues = await listVenues();
  res.status(200).json({ venues });
}

/** GET /api/v1/venues/:venueId */
export async function getVenueHandler(req: Request, res: Response): Promise<void> {
  const venue = await getVenue(parseVenueId(req));
  res.status(200).json({ venue });
}

/** POST /api/v1/venues - admin only. */
export async function createVenueHandler(req: Request, res: Response): Promise<void> {
  const parsed = createVenueSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError('Invalid venue payload', toFieldErrors(parsed.error.issues));
  }

  const venue = await createVenue(parsed.data);
  res.status(201).json({ venue });
}

/** PATCH /api/v1/venues/:venueId - admin only. */
export async function updateVenueHandler(req: Request, res: Response): Promise<void> {
  const venueId = parseVenueId(req);

  const parsed = updateVenueSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError('Invalid venue payload', toFieldErrors(parsed.error.issues));
  }

  const venue = await updateVenue({ venueId, ...parsed.data });
  res.status(200).json({ venue });
}

/** GET /api/v1/venues/:venueId/seats - the physical layout, not any event's inventory. */
export async function listVenueSeatsHandler(req: Request, res: Response): Promise<void> {
  const seats = await listVenueSeats(parseVenueId(req));
  res.status(200).json({ seats });
}

/** POST /api/v1/venues/:venueId/seats - admin only. */
export async function addVenueSeatsHandler(req: Request, res: Response): Promise<void> {
  const venueId = parseVenueId(req);

  const parsed = addVenueSeatsSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError('Invalid seat layout payload', toFieldErrors(parsed.error.issues));
  }

  const result = await addVenueSeats(venueId, parsed.data.rows);
  res.status(201).json(result);
}

function parseSeatParams(req: Request): { venueId: string; seatId: string } {
  const parsed = venueSeatParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    throw new BadRequestError('Invalid seat id', toFieldErrors(parsed.error.issues));
  }
  return parsed.data;
}

/** PATCH /api/v1/venues/:venueId/seats/:seatId - admin only. */
export async function updateVenueSeatHandler(req: Request, res: Response): Promise<void> {
  const { venueId, seatId } = parseSeatParams(req);

  const parsed = updateVenueSeatSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError('Invalid seat payload', toFieldErrors(parsed.error.issues));
  }

  const seats = await setVenueSeatCategory(venueId, seatId, parsed.data.category);
  res.status(200).json({ seats });
}

/** DELETE /api/v1/venues/:venueId/seats/:seatId - admin only. */
export async function deleteVenueSeatHandler(req: Request, res: Response): Promise<void> {
  const { venueId, seatId } = parseSeatParams(req);
  const seats = await removeVenueSeat(venueId, seatId);
  res.status(200).json({ seats });
}
