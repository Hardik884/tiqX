import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { accessTokenForUser } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedConfirmedBooking } from './helpers/seed.js';

let server: Server;
let baseUrl: string;

before(async () => {
  await connectTestRedis();
  await flushTestNamespace();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await query('DELETE FROM idempotency_keys');
  await flushTestNamespace();
  await closeTestRedis();
  await cleanupSeedData();
  await closePool();
});

interface Body {
  bookingId?: string;
  ticketCount?: number;
  tickets?: { ticketId: string }[];
  error?: { code: string };
}

async function issue(bookingId: string, userId: string, key: string) {
  const response = await fetch(`${baseUrl}/api/v1/bookings/${bookingId}/tickets/issue`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessTokenForUser(userId)}`,
      'idempotency-key': key,
    },
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? (JSON.parse(raw) as Body) : {} };
}

describe('ticket issuance failure injection', () => {
  it('leaves no partial ticket set when insertion fails mid-transaction', async () => {
    const booking = await seedConfirmedBooking(3);
    const key = randomUUID();

    // Fault injection, after the idempotency key has already been claimed
    // (inside runIdempotently's transaction) and the booking has been located
    // and locked: force every ticket insert to fail. NOT VALID leaves rows
    // created by earlier tests untouched.
    await query('ALTER TABLE tickets ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID');

    try {
      const reply = await issue(booking.bookingId, booking.userId, key);
      assert.equal(reply.status, 500, 'the request fails rather than half-succeeding');

      const rows = await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1',
        [booking.bookingId],
      );
      assert.equal(rows.rows[0]!.count, '0', 'no ticket survives a rolled-back transaction');

      // The idempotency wrapper's own guarantee: a failed attempt stores no
      // record, so the claim rolls back with everything else.
      const key_row = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM idempotency_keys WHERE key = $1`,
        [key],
      );
      assert.equal(key_row.rows[0]!.count, '0', 'the failed claim leaves no idempotency record');
    } finally {
      await query('ALTER TABLE tickets DROP CONSTRAINT tmp_force_failure');
    }

    // The same key, retried after the fault is cleared, is a genuine fresh
    // attempt rather than a replayed failure - and it succeeds.
    const retry = await issue(booking.bookingId, booking.userId, key);
    assert.equal(retry.status, 201);
    assert.equal(retry.json.ticketCount, 3);
  });

  it('retries a ticket-reference collision within the same request rather than failing it', async () => {
    // `generateTicketReference` is cryptographically random, so this cannot
    // force a real collision from outside - instead it drives
    // `insertTicketsForSeats` directly with a reference already taken, the
    // same way `insertTicketsWithRetry` would see a collision, and confirms
    // retrying the whole batch on a savepoint leaves exactly one ticket per
    // seat rather than a partial or duplicated set.
    const { insertTicketsForSeats, generateTicketReference } = await import(
      '../src/modules/tickets/ticket.repository.js'
    );
    const { withTransaction } = await import('../src/db/pool.js');

    const booking = await seedConfirmedBooking(2);
    const seats = await query<{ id: string }>('SELECT id FROM booking_seats WHERE booking_id = $1 ORDER BY id', [
      booking.bookingId,
    ]);
    const seatIds = seats.rows.map((row) => row.id);

    // A second, unrelated booking supplies a real booking_seat_id to attach
    // the "already taken" reference to - the collision is on
    // ticket_reference, which is unique across the whole table regardless of
    // which seat it is attached to.
    const other = await seedConfirmedBooking(1);
    const otherSeat = await query<{ id: string }>('SELECT id FROM booking_seats WHERE booking_id = $1', [
      other.bookingId,
    ]);
    const takenReference = generateTicketReference();
    await withTransaction((client) =>
      insertTicketsForSeats(client, other.bookingId, [otherSeat.rows[0]!.id], [takenReference]),
    );

    await assert.rejects(
      withTransaction((client) =>
        insertTicketsForSeats(client, booking.bookingId, seatIds, [takenReference, generateTicketReference()]),
      ),
      /tickets_ticket_reference_key/,
      'a reused reference is rejected by the unique constraint, not silently accepted',
    );

    const rows = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1',
      [booking.bookingId],
    );
    assert.equal(rows.rows[0]!.count, '0', 'the rejected batch left nothing behind for this booking');
  });
});
