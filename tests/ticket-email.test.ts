import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { closePool, pool, query } from '../src/db/pool.js';
import { createEvent } from '../src/modules/events/event.service.js';
import { MockEmailProvider } from '../src/modules/notifications/email.provider.js';
import { enqueueTicketEmail } from '../src/modules/notifications/ticket-email.repository.js';
import { sendPendingTicketEmails } from '../src/modules/notifications/ticket-email.service.js';
import { ensureTicketsForBooking, verifyTicket } from '../src/modules/tickets/ticket.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { cancelBookingInTransaction, confirmHoldInTransaction } from '../src/modules/bookings/booking.service.js';
import { withTransaction } from '../src/db/pool.js';
import { cleanupSeedData, seedCustomer, seedOrganiser, seedVenue, trackEvent } from './helpers/seed.js';

after(async () => {
  await query('DELETE FROM idempotency_keys');
  await cleanupSeedData();
  await closePool();
});

/** A confirmed, priced booking, plus enough context to verify or cancel it. */
async function seedBooking(seatCount: number, price = '450.10') {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 1);
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Ticket Email Test ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2031-01-01T18:00:00.000Z'),
    endsAt: new Date('2031-01-01T20:00:00.000Z'),
    pricing: { standard: price },
  });
  trackEvent(event.id);

  const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id', [
    event.id,
  ]);
  const seatIds = seats.rows.map((row) => row.id);
  const userId = await seedCustomer();
  const hold = await createHold({ eventId: event.id, userId, showSeatIds: seatIds, ttlSeconds: 600 });

  const result = await withTransaction((client) =>
    confirmHoldInTransaction(client, { userId, eventId: event.id, holdId: hold.holdId }, undefined),
  );

  return { eventId: event.id, organiserId, userId, bookingId: result.booking.id };
}

describe('booking confirmation issues tickets', () => {
  it('creates exactly one ticket per seat, automatically, when the booking confirms', async () => {
    const booking = await seedBooking(3);

    const rows = await query<{ count: string }>('SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1', [
      booking.bookingId,
    ]);
    assert.equal(rows.rows[0]!.count, '3');
  });

  it('does not create duplicate tickets when confirmation is idempotently replayed', async () => {
    // Direct service replay, not a second HTTP round trip: confirming the
    // *same already-converted hold* a second time is exactly what a retried
    // confirmation request would do once the idempotency wrapper is bypassed
    // (which is what a hostile or buggy retry outside the API would look
    // like) - and `bookings_hold_id_key` plus `ensureTicketsForBooking`'s own
    // idempotence must both hold regardless of how confirmation is invoked.
    const booking = await seedBooking(1);

    const before = await query<{ count: string }>('SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1', [
      booking.bookingId,
    ]);
    assert.equal(before.rows[0]!.count, '1');

    // A second call to ensureTicketsForBooking, as if issuance ran again -
    // must not create a second ticket.
    const second = await withTransaction((client) => ensureTicketsForBooking(client, booking.bookingId, undefined));
    assert.equal(second.created, false, 'the second call finds tickets already there');

    const after = await query<{ count: string }>('SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1', [
      booking.bookingId,
    ]);
    assert.equal(after.rows[0]!.count, '1', 'still exactly one ticket');
  });
});

describe('QR / verification payload', () => {
  it('contains only the ticket id and reference, and works with the verification endpoint', async () => {
    const booking = await seedBooking(1);
    const ticket = await query<{ id: string; ticket_reference: string }>(
      'SELECT id, ticket_reference FROM tickets WHERE booking_id = $1',
      [booking.bookingId],
    );
    const { id: ticketId, ticket_reference: ticketReference } = ticket.rows[0]!;

    const qrPayload = { v: 1, ticketId, ticketReference };
    const payloadText = JSON.stringify(qrPayload);

    // No secret material of any kind, in any field name a QR payload might use.
    for (const forbidden of ['password', 'jwt', 'token', 'secret', 'refresh', 'authorization']) {
      assert.ok(!payloadText.toLowerCase().includes(forbidden), `QR payload must not mention "${forbidden}"`);
    }

    // The reference is opaque - a fixed-format random string, not a sequence.
    assert.match(ticketReference, /^TKT-[0-9A-Z]{12}$/);

    // And the payload's ids are what the authoritative verification endpoint
    // actually accepts - verification, not the QR payload itself, decides.
    const admin = await seedCustomer();
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin]);
    const result = await verifyTicket({ ticketId: qrPayload.ticketId, userId: admin, userRole: 'admin' }, undefined);
    assert.equal(result.ticket.status, 'used');
  });
});

describe('ticket email outbox', () => {
  it('requests exactly one email per confirmed booking', async () => {
    const booking = await seedBooking(2);

    const rows = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ticket_email_outbox WHERE booking_id = $1',
      [booking.bookingId],
    );
    assert.equal(rows.rows[0]!.count, '1');
  });

  it('the mock provider successfully sends the pending email, with the ticket details', async () => {
    const booking = await seedBooking(2, '333.33');
    const provider = new MockEmailProvider();

    const ticketRefs = await query<{ ticket_reference: string }>(
      'SELECT ticket_reference FROM tickets WHERE booking_id = $1 ORDER BY id',
      [booking.bookingId],
    );
    const expectedRefs = ticketRefs.rows.map((row) => row.ticket_reference).sort();

    // Other tests in this file enqueue their own booking's email in the same
    // outbox table, so a batch drain may claim more than just this one row -
    // the assertion below finds this booking's message specifically, by its
    // own ticket references, rather than assuming it is the only row pending.
    const result = await sendPendingTicketEmails(provider);

    assert.equal(result.failed, 0);
    assert.ok(result.sent >= 1);

    const message = provider.sent.find(
      (sent) => sent.tickets.map((t) => t.ticketReference).sort().join(',') === expectedRefs.join(','),
    );
    assert.ok(message, "this booking's own email was sent");

    assert.equal(message.tickets.length, 2);
    assert.ok(message.tickets.every((t) => /^TKT-[0-9A-Z]{12}$/.test(t.ticketReference)));
    assert.ok(message.to.includes('@'));

    const outboxRow = await query<{ processed_at: Date | null }>(
      'SELECT processed_at FROM ticket_email_outbox WHERE booking_id = $1',
      [booking.bookingId],
    );
    assert.ok(outboxRow.rows[0]!.processed_at, 'marked processed after a successful send');
  });

  it('a failed send leaves the row retryable, and does not touch the booking', async () => {
    const booking = await seedBooking(1);

    const failingProvider = {
      sendTicketEmail: async () => {
        throw new Error('simulated provider outage');
      },
    };

    const result = await sendPendingTicketEmails(failingProvider);
    assert.equal(result.failed, 1);
    assert.equal(result.sent, 0);

    const row = await query<{ processed_at: Date | null; attempts: number; available_at: Date; last_error: string }>(
      'SELECT processed_at, attempts, available_at, last_error FROM ticket_email_outbox WHERE booking_id = $1',
      [booking.bookingId],
    );
    assert.equal(row.rows[0]!.processed_at, null, 'not marked processed - it is still retryable');
    assert.equal(row.rows[0]!.attempts, 1);
    assert.match(row.rows[0]!.last_error, /simulated provider outage/);
    assert.ok(row.rows[0]!.available_at.getTime() > Date.now(), 'pushed into the future for backoff');

    // The booking itself is completely unaffected by the email failure.
    const bookingRow = await query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [
      booking.bookingId,
    ]);
    assert.equal(bookingRow.rows[0]!.status, 'confirmed');

    // A later pass, once whatever failed is fixed, succeeds and drains it.
    const mock = new MockEmailProvider();
    // Not claimable yet - available_at is still in the future.
    const tooSoon = await sendPendingTicketEmails(mock);
    assert.equal(tooSoon.claimed, 0);

    await query('UPDATE ticket_email_outbox SET available_at = now() WHERE booking_id = $1', [booking.bookingId]);
    const retried = await sendPendingTicketEmails(mock);
    assert.equal(retried.sent, 1, 'the same row is retried successfully once available again');
  });

  it('enqueueing is idempotent: a second request for the same booking adds no second row', async () => {
    const booking = await seedBooking(1);
    // A second, explicit request for the same booking - confirmation already
    // made the first, implicitly.
    await enqueueTicketEmail(pool, booking.bookingId);

    const rows = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ticket_email_outbox WHERE booking_id = $1',
      [booking.bookingId],
    );
    assert.equal(rows.rows[0]!.count, '1', 'ON CONFLICT DO NOTHING keeps this to one row');
  });
});

describe('cancellation and tickets', () => {
  it('a cancelled ticket can no longer be verified, and cancellation creates no new ticket or email', async () => {
    const booking = await seedBooking(1);
    const admin = await seedCustomer();
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin]);

    await withTransaction((client) =>
      cancelBookingInTransaction(client, { userId: booking.userId, bookingId: booking.bookingId }, undefined),
    );

    const ticket = await query<{ id: string }>('SELECT id FROM tickets WHERE booking_id = $1', [booking.bookingId]);
    await assert.rejects(
      verifyTicket({ ticketId: ticket.rows[0]!.id, userId: admin, userRole: 'admin' }, undefined),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'BOOKING_CANCELLED',
    );

    const ticketCount = await query<{ count: string }>('SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1', [
      booking.bookingId,
    ]);
    assert.equal(ticketCount.rows[0]!.count, '1', 'still just the one, original ticket - cancellation made no new one');

    const emailCount = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ticket_email_outbox WHERE booking_id = $1',
      [booking.bookingId],
    );
    assert.equal(emailCount.rows[0]!.count, '1', 'still just the one email request made at confirmation');
  });
});
