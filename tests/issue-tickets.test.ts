import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { cancelBookingInTransaction } from '../src/modules/bookings/booking.service.js';
import { withTransaction } from '../src/db/pool.js';
import { accessTokenForUser } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedConfirmedBooking, seedCustomer } from './helpers/seed.js';

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

interface IssuedTicket {
  ticketId: string;
  ticketReference: string;
  status: string;
  issuedAt: string;
  qrPayload: { v: number; ticketId: string; ticketReference: string };
}

interface Body {
  bookingId?: string;
  eventId?: string;
  ticketCount?: number;
  tickets?: IssuedTicket[];
  error?: { code: string; message: string; details?: { reason?: string } };
}

interface Reply {
  status: number;
  json: Body;
}

async function issue(
  bookingId: string,
  options: { userId?: string | null; key?: string | null } = {},
): Promise<Reply> {
  const key = options.key === undefined ? randomUUID() : options.key;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) {
    headers['idempotency-key'] = key;
  }
  if (options.userId != null) {
    headers.authorization = `Bearer ${await accessTokenForUser(options.userId)}`;
  }

  const response = await fetch(`${baseUrl}/api/v1/bookings/${bookingId}/tickets/issue`, {
    method: 'POST',
    headers,
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? (JSON.parse(raw) as Body) : {} };
}

describe('issuing tickets', () => {
  it('issues one ticket for a single-seat booking', async () => {
    const booking = await seedConfirmedBooking(1);

    const reply = await issue(booking.bookingId, { userId: booking.userId });

    assert.equal(reply.status, 201);
    assert.equal(reply.json.bookingId, booking.bookingId);
    assert.equal(reply.json.eventId, booking.eventId);
    assert.equal(reply.json.ticketCount, 1);
    assert.equal(reply.json.tickets?.length, 1);

    const ticket = reply.json.tickets![0]!;
    assert.equal(ticket.status, 'issued');
    assert.match(ticket.ticketReference, /^TKT-[0-9A-Z]{12}$/);
    assert.deepEqual(ticket.qrPayload, {
      v: 1,
      ticketId: ticket.ticketId,
      ticketReference: ticket.ticketReference,
    });
  });

  it('issues one ticket per seat for a multi-seat booking', async () => {
    const booking = await seedConfirmedBooking(4);

    const reply = await issue(booking.bookingId, { userId: booking.userId });

    assert.equal(reply.status, 201);
    assert.equal(reply.json.ticketCount, 4);
    assert.equal(reply.json.tickets?.length, 4);

    const references = new Set(reply.json.tickets!.map((t) => t.ticketReference));
    assert.equal(references.size, 4, 'every ticket gets a distinct reference');

    const rows = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1',
      [booking.bookingId],
    );
    assert.equal(rows.rows[0]!.count, '4');
  });

  it('enforces exactly one ticket per booking seat at the database level', async () => {
    const booking = await seedConfirmedBooking(2);
    await issue(booking.bookingId, { userId: booking.userId });

    const seatRow = await query<{ id: string }>(
      'SELECT id FROM booking_seats WHERE booking_id = $1 LIMIT 1',
      [booking.bookingId],
    );
    const bookingSeatId = seatRow.rows[0]!.id;

    await assert.rejects(
      query(
        `INSERT INTO tickets (booking_id, booking_seat_id, ticket_reference, status, issued_at)
         VALUES ($1, $2, 'TKT-DUPLICATETEST', 'issued', now())`,
        [booking.bookingId, bookingSeatId],
      ),
      /tickets_booking_seat_id_key/,
      'a second ticket for the same seat violates the unique constraint',
    );
  });

  it('rejects repeat issuance for a booking that already has tickets', async () => {
    const booking = await seedConfirmedBooking(1);
    const first = await issue(booking.bookingId, { userId: booking.userId });
    assert.equal(first.status, 201);

    const second = await issue(booking.bookingId, { userId: booking.userId });
    assert.equal(second.status, 409);
    assert.equal(second.json.error?.details?.reason, 'TICKETS_ALREADY_ISSUED');

    const rows = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1',
      [booking.bookingId],
    );
    assert.equal(rows.rows[0]!.count, '1', 'no duplicate ticket was created');
  });

  it('rejects issuance for a cancelled booking', async () => {
    const booking = await seedConfirmedBooking(1);
    await withTransaction((client) =>
      cancelBookingInTransaction(client, { userId: booking.userId, bookingId: booking.bookingId }, undefined),
    );

    const reply = await issue(booking.bookingId, { userId: booking.userId });

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'BOOKING_CANCELLED');

    const rows = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1',
      [booking.bookingId],
    );
    assert.equal(rows.rows[0]!.count, '0', 'a cancelled booking never receives tickets');
  });

  it('answers a missing booking with 404', async () => {
    const userId = await seedCustomer();
    const reply = await issue(randomUUID(), { userId });
    assert.equal(reply.status, 404);
    assert.equal(reply.json.error?.details?.reason, 'BOOKING_NOT_FOUND');
  });

  it('rejects a customer issuing tickets for someone else\'s booking', async () => {
    const booking = await seedConfirmedBooking(1);
    const stranger = await seedCustomer();

    const reply = await issue(booking.bookingId, { userId: stranger });

    // Same answer as a nonexistent booking - no oracle for "whose is this".
    assert.equal(reply.status, 404);
    assert.equal(reply.json.error?.details?.reason, 'BOOKING_NOT_FOUND');
  });

  it('lets the organiser of the event issue tickets on the booking owner\'s behalf', async () => {
    const booking = await seedConfirmedBooking(1);

    const reply = await issue(booking.bookingId, { userId: booking.organiserId });

    assert.equal(reply.status, 201);
    assert.equal(reply.json.ticketCount, 1);
  });

  it('lets an admin issue tickets for any booking', async () => {
    const booking = await seedConfirmedBooking(1);
    const admin = await seedCustomer(); // role fixed up below
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin]);

    const reply = await issue(booking.bookingId, { userId: admin });

    assert.equal(reply.status, 201);
    assert.equal(reply.json.ticketCount, 1);
  });

  it('requires authentication', async () => {
    const booking = await seedConfirmedBooking(1);
    const reply = await issue(booking.bookingId, { userId: null });
    assert.equal(reply.status, 401);
  });

  it('requires an Idempotency-Key', async () => {
    const booking = await seedConfirmedBooking(1);
    const reply = await issue(booking.bookingId, { userId: booking.userId, key: null });
    assert.equal(reply.status, 400);
  });

  it('replays the same tickets for a retried request with the same key', async () => {
    const booking = await seedConfirmedBooking(2);
    const key = randomUUID();

    const first = await issue(booking.bookingId, { userId: booking.userId, key });
    const second = await issue(booking.bookingId, { userId: booking.userId, key });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(
      first.json.tickets?.map((t) => t.ticketId).sort(),
      second.json.tickets?.map((t) => t.ticketId).sort(),
      'the retried request is answered with the exact tickets already issued',
    );

    const rows = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1',
      [booking.bookingId],
    );
    assert.equal(rows.rows[0]!.count, '2', 'replay creates nothing new');
  });

  it('rejects the same key reused for a different booking', async () => {
    const bookingA = await seedConfirmedBooking(1);
    const bookingB = await seedConfirmedBooking(1);
    const key = randomUUID();

    const first = await issue(bookingA.bookingId, { userId: bookingA.userId, key });
    assert.equal(first.status, 201);

    const second = await issue(bookingB.bookingId, { userId: bookingA.userId, key });
    assert.equal(second.status, 409);
    assert.equal(second.json.error?.details?.reason, 'idempotency_key_reuse');
  });
});
