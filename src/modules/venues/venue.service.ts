import { pool } from '../../db/pool.js';
import { listVenues as listVenuesRow } from './venue.repository.js';
import type { VenueSummary } from './venue.types.js';

export async function listVenues(): Promise<VenueSummary[]> {
  return listVenuesRow(pool);
}
