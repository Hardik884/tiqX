import type { Queryable } from '../../db/pool.js';
import type { CreateEventInput, EventRecord, EventStatus, EventType } from './event.types.js';

interface EventRow {
  id: string;
  organiser_id: string;
  venue_id: string;
  title: string;
  description: string | null;
  event_type: EventType;
  starts_at: Date;
  ends_at: Date;
  status: EventStatus;
  created_at: Date;
  updated_at: Date;
}

function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    organiserId: row.organiser_id,
    venueId: row.venue_id,
    title: row.title,
    description: row.description,
    eventType: row.event_type,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertEvent(db: Queryable, input: CreateEventInput): Promise<EventRecord> {
  const result = await db.query<EventRow>(
    `INSERT INTO events (organiser_id, venue_id, title, description, event_type, starts_at, ends_at, status, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'draft'), COALESCE($9, 'INR'))
     RETURNING *`,
    [
      input.organiserId,
      input.venueId,
      input.title,
      input.description ?? null,
      input.eventType,
      input.startsAt,
      input.endsAt,
      input.status ?? null,
      input.currency ?? null,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('INSERT INTO events returned no row');
  }

  return toEventRecord(row);
}
