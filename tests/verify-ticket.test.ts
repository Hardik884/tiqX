import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query, withTransaction } from '../src/db/pool.js';
import { cancelBookingInTransaction } from '../src/modules/bookings/booking.service.js';
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

interface Body {
  ticketReference?: string;
  status?: string;
  usedAt?: string;
  eventId?: string;
  seatId?: string;
  verifiedAt?: string;
  error?: { code: string; message: string; details?: { reason?: string } };
}

interface Reply {
  status: number;
  json: Body;
}

async function verify(ticketId: string, userId?: string | null): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (userId != null) {
    headers.authorization = `Bearer ${await accessTokenForUser(userId)}`;
  }
  const response = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}/verify`, {
    method: 'POST',
    headers,
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? (JSON.parse(raw) as Body) : {} };
}

async function issueOne(bookingId: string, userId: string): Promise<{ ticketId: string }> {
  const response = await fetch(`${baseUrl}/api/v1/bookings/${bookingId}/tickets/issue`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessTokenForUser(userId)}`,
      'idempotency-key': randomUUID(),
    },
  });
  const body = (await response.json()) as { tickets: { ticketId: string }[] };
  return { ticketId: body.tickets[0]!.ticketId };
}

describe('verifying a ticket', () => {
  it('accepts an issued ticket and marks it used', async () => {
    const booking = await seedConfirmedBooking(1);
    const { ticketId } = await issueOne(booking.bookingId, booking.userId);

    const reply = await verify(ticketId, booking.organiserId);

    assert.equal(reply.status, 200);
    assert.equal(reply.json.status, 'used');
    assert.equal(reply.json.eventId, booking.eventId);
    assert.ok(reply.json.seatId);
    assert.ok(reply.json.usedAt);
    assert.ok(reply.json.verifiedAt);

    const row = await query<{ status: string; used_at: Date | null }>(
      'SELECT status, used_at FROM tickets WHERE id = $1',
      [ticketId],
    );
    assert.equal(row.rows[0]!.status, 'used');
    assert.ok(row.rows[0]!.used_at);
  });

  it('rejects an already-used ticket', async () => {
    const booking = await seedConfirmedBooking(1);
    const { ticketId } = await issueOne(booking.bookingId, booking.userId);

    const first = await verify(ticketId, booking.organiserId);
    assert.equal(first.status, 200);

    const second = await verify(ticketId, booking.organiserId);
    assert.equal(second.status, 409);
    assert.equal(second.json.error?.details?.reason, 'TICKET_ALREADY_USED');

    const row = await query<{ used_at: Date }>('SELECT used_at FROM tickets WHERE id = $1', [ticketId]);
    const usedAt = row.rows[0]!.used_at;

    // Verifying twice must not move the timestamp.
    assert.equal(first.json.usedAt, new Date(usedAt).toISOString());
  });

  it('rejects a void ticket', async () => {
    const booking = await seedConfirmedBooking(1);
    const { ticketId } = await issueOne(booking.bookingId, booking.userId);
    await query("UPDATE tickets SET status = 'void' WHERE id = $1", [ticketId]);

    const reply = await verify(ticketId, booking.organiserId);

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'TICKET_VOID');
  });

  it('rejects a ticket belonging to a cancelled booking, even though the ticket itself is still issued', async () => {
    const booking = await seedConfirmedBooking(1);
    const { ticketId } = await issueOne(booking.bookingId, booking.userId);

    await withTransaction((client) =>
      cancelBookingInTransaction(client, { userId: booking.userId, bookingId: booking.bookingId }, undefined),
    );

    const reply = await verify(ticketId, booking.organiserId);

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'BOOKING_CANCELLED');

    const row = await query<{ status: string }>('SELECT status FROM tickets WHERE id = $1', [ticketId]);
    assert.equal(row.rows[0]!.status, 'issued', 'the booking, not the ticket row, carries the rejection');
  });

  it('answers a nonexistent ticket with 404', async () => {
    const organiser = await seedConfirmedBooking(1);
    const reply = await verify(randomUUID(), organiser.organiserId);
    assert.equal(reply.status, 404);
    assert.equal(reply.json.error?.details?.reason, 'TICKET_NOT_FOUND');
  });

  it('requires authentication', async () => {
    const reply = await verify(randomUUID(), null);
    assert.equal(reply.status, 401);
  });

  it('rejects a customer - even the ticket owner - from verifying', async () => {
    const booking = await seedConfirmedBooking(1);
    const { ticketId } = await issueOne(booking.bookingId, booking.userId);

    const reply = await verify(ticketId, booking.userId);

    assert.equal(reply.status, 403);

    const row = await query<{ status: string }>('SELECT status FROM tickets WHERE id = $1', [ticketId]);
    assert.equal(row.rows[0]!.status, 'issued');
  });

  it('lets any organiser verify, not only the event\'s own - scoping is deferred, see ticket.routes.ts', async () => {
    const booking = await seedConfirmedBooking(1);
    const { ticketId } = await issueOne(booking.bookingId, booking.userId);
    const otherOrganiser = await seedCustomer();
    await query("UPDATE users SET role = 'organiser' WHERE id = $1", [otherOrganiser]);

    // Documents the current, deliberately coarse role gate: it is a role
    // check, not an ownership check, so an organiser unrelated to this event
    // can still verify its tickets today.
    const reply = await verify(ticketId, otherOrganiser);
    assert.equal(reply.status, 200);
  });
});
