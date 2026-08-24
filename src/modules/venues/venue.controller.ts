import type { Request, Response } from 'express';

import { listVenues } from './venue.service.js';

/** GET /api/v1/venues - organiser/admin only, for the event create/edit form. */
export async function listVenuesHandler(_req: Request, res: Response): Promise<void> {
  const venues = await listVenues();
  res.status(200).json({ venues });
}
