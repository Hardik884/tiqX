import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query, withTransaction } from '../src/db/pool.js';
import { createEvent, publishEvent } from '../src/modules/events/event.service.js';
import { createHold } from '../src/modules/reservations/reservation.service.js';
import { expireHold } from '../src/modules/expiration/expiration.service.js';
import {
  claimPendingAllocations,
  markAllocationProcessed,
} from '../src/modules/waitlist/waitlist-outbox.repository.js';
import { runAllocationPass } from '../src/modules/waitlist/waitlist.service.js';
import { accessTokenForUser } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace } from './helpers/redis.js';
import { cleanupSeedData, seedCustomer, seedOrganiser, seedVenue } from './helpers/seed.js';

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
  offerId?: string;
  eventId?: string;
  status?: string;
  bookingId?: string;
  bookingReference?: string;
  error?: { code: string; message: string; details?: { reason?: string } };
}

interface Reply {
  status: number;
  json: Body;
  raw: string;
}

async function post(
  path: string,
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
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers });
  const raw = await response.text();
  return { status: response.status, json: raw ? (JSON.parse(raw) as Body) : {}, raw };
}

async function join(eventId: string, userId: string, seatCategory = 'standard'): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/waitlist`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessTokenForUser(userId)}`,
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ seatCategory }),
  });
  const json = (await response.json()) as { waitlistEntryId?: string };
  assert.equal(response.status, 201, 'setup: joining must succeed');
  return json.waitlistEntryId!;
}

async function accept(offerId: string, options: { userId?: string | null; key?: string | null } = {}): Promise<Reply> {
  return post(`/api/v1/waitlist/offers/${offerId}/accept`, options);
}

interface Show {
  eventId: string;
  seatIds: string[];
}

async function seedPublishedShow(seatCount: number): Promise<Show> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(seatCount, 'A', 12, null, 'standard');
  const { event } = await createEvent({
    organiserId,
    venueId,
    title: `Offer ${randomUUID()}`,
    eventType: 'concert',
    startsAt: new Date('2030-01-01T18:00:00.000Z'),
    endsAt: new Date('2030-01-01T20:00:00.000Z'),
    pricing: { standard: '150.00' },
  });
  await publishEvent({ eventId: event.id, userId: organiserId, userRole: 'organiser' }, undefined);
  const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1 ORDER BY id', [
    event.id,
  ]);
  return { eventId: event.id, seatIds: seats.rows.map((row) => row.id) };
}

async function book(eventId: string, userId: string, showSeatId: string): Promise<string> {
  const hold = await createHold({ eventId, userId, showSeatIds: [showSeatId], ttlSeconds: 600 });
  const reply = await post(`/api/v1/events/${eventId}/holds/${hold.holdId}/confirm`, { userId });
  assert.equal(reply.status, 201, 'setup: booking must confirm');
  return reply.json.bookingId!;
}

async function cancelBooking(bookingId: string, userId: string): Promise<void> {
  const reply = await post(`/api/v1/bookings/${bookingId}/cancel`, { userId });
  assert.equal(reply.status, 200, 'setup: cancellation must succeed');
}

async function processAllocationOutbox(): Promise<void> {
  await withTransaction(async (client) => {
    const rows = await claimPendingAllocations(client, 100);
    for (const row of rows) {
      await runAllocationPass(client, row.eventId, row.seatCategory, undefined);
      await markAllocationProcessed(client, row.id);
    }
  });
}

interface OfferRow {
  id: string;
  hold_id: string;
  status: string;
  show_seat_id: string;
}

/** Books a seat, cancels it, allocates it to `waiter`, and returns the offer row. */
async function seedOffer(): Promise<{ eventId: string; seatId: string; waiter: string; offer: OfferRow }> {
  const { eventId, seatIds } = await seedPublishedShow(1);
  const owner = await seedCustomer();
  const bookingId = await book(eventId, owner, seatIds[0]!);
  const waiter = await seedCustomer();
  await join(eventId, waiter);

  await cancelBooking(bookingId, owner);
  await processAllocationOutbox();

  const offers = await query<OfferRow>('SELECT * FROM waitlist_offers WHERE show_seat_id = $1', [
    seatIds[0],
  ]);
  return { eventId, seatId: seatIds[0]!, waiter, offer: offers.rows[0]! };
}

async function entryStatusForOffer(offerId: string): Promise<string> {
  const result = await query<{ status: string }>(
    `SELECT we.status FROM waitlist_entries we
     JOIN waitlist_offers wo ON wo.waitlist_entry_id = we.id
     WHERE wo.id = $1`,
    [offerId],
  );
  return result.rows[0]!.status;
}

describe('accepting a waitlist offer', () => {
  it('converts the offer into a real booking', async () => {
    const { eventId, seatId, waiter, offer } = await seedOffer();

    const reply = await accept(offer.id, { userId: waiter });

    assert.equal(reply.status, 200);
    assert.equal(reply.json.status, 'accepted');
    assert.equal(reply.json.eventId, eventId);
    assert.ok(reply.json.bookingId);
    assert.ok(reply.json.bookingReference);

    const offerRow = await query<{ status: string; accepted_at: Date | null }>(
      'SELECT status, accepted_at FROM waitlist_offers WHERE id = $1',
      [offer.id],
    );
    assert.equal(offerRow.rows[0]!.status, 'accepted');
    assert.ok(offerRow.rows[0]!.accepted_at);

    assert.equal(await entryStatusForOffer(offer.id), 'accepted');

    const hold = await query<{ status: string }>('SELECT status FROM reservation_holds WHERE id = $1', [
      offer.hold_id,
    ]);
    assert.equal(hold.rows[0]!.status, 'converted');

    const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [seatId]);
    assert.equal(seat.rows[0]!.status, 'booked');

    const booking = await query<{ user_id: string; status: string }>(
      'SELECT user_id, status FROM bookings WHERE id = $1',
      [reply.json.bookingId],
    );
    assert.equal(booking.rows[0]!.user_id, waiter);
    assert.equal(booking.rows[0]!.status, 'confirmed');
  });
});

describe('acceptance is refused when it should be', () => {
  it('requires authentication', async () => {
    const { offer } = await seedOffer();
    const reply = await accept(offer.id, { userId: null });
    assert.equal(reply.status, 401);
  });

  it('requires an Idempotency-Key', async () => {
    const { waiter, offer } = await seedOffer();
    const reply = await accept(offer.id, { userId: waiter, key: null });
    assert.equal(reply.status, 400);
  });

  it("refuses another user's offer without revealing that it exists", async () => {
    const { offer } = await seedOffer();
    const attacker = await seedCustomer();

    const stolen = await accept(offer.id, { userId: attacker });

    assert.equal(stolen.status, 404);
    assert.equal(stolen.json.error?.details?.reason, 'WAITLIST_OFFER_NOT_FOUND');

    const imaginary = await accept(randomUUID(), { userId: attacker });
    assert.equal(imaginary.status, stolen.status);
    assert.equal(imaginary.json.error?.code, stolen.json.error?.code);
    assert.equal(imaginary.json.error?.message, stolen.json.error?.message);
  });

  it('refuses a second acceptance under a different key', async () => {
    const { waiter, offer } = await seedOffer();
    assert.equal((await accept(offer.id, { userId: waiter })).status, 200);

    const second = await accept(offer.id, { userId: waiter });

    assert.equal(second.status, 409);
    assert.equal(second.json.error?.details?.reason, 'OFFER_ALREADY_ACCEPTED');
  });

  it('refuses an expired offer', async () => {
    const { waiter, offer } = await seedOffer();

    await query("UPDATE reservation_holds SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      offer.hold_id,
    ]);
    assert.equal(await expireHold(offer.hold_id), 'expired');

    const reply = await accept(offer.id, { userId: waiter });

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'OFFER_EXPIRED');
  });

  it('leaks no database detail on any rejection', async () => {
    const { offer } = await seedOffer();
    const attacker = await seedCustomer();

    const reply = await accept(offer.id, { userId: attacker });

    for (const leak of ['reservation_holds', 'show_seats', 'waitlist_offers', 'SELECT', 'FOR UPDATE', 'stack']) {
      assert.ok(!reply.raw.includes(leak), `the response must not mention ${leak}`);
    }
  });
});

describe('waitlist offer idempotency', () => {
  it('replays the original response for a repeated key', async () => {
    const { waiter, offer } = await seedOffer();
    const key = randomUUID();

    const first = await accept(offer.id, { userId: waiter, key });
    const retry = await accept(offer.id, { userId: waiter, key });

    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.json, first.json);
  });

  it('does not collide with a join using the same key', async () => {
    const { eventId, waiter, offer } = await seedOffer();
    const key = randomUUID();

    // The waiter joins a second, unrelated event with the same key first.
    const other = await seedPublishedShow(1);
    const joinReply = await fetch(`${baseUrl}/api/v1/events/${other.eventId}/waitlist`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await accessTokenForUser(waiter)}`,
        'idempotency-key': key,
      },
      body: JSON.stringify({ seatCategory: 'standard' }),
    });
    assert.equal(joinReply.status, 201);

    const reply = await accept(offer.id, { userId: waiter, key });

    assert.equal(reply.status, 409);
    assert.equal(reply.json.error?.details?.reason, 'idempotency_key_reuse');
    assert.equal(await entryStatusForOffer(offer.id), 'offered', 'untouched');
    void eventId;
  });
});

describe('offer expiration', () => {
  it('lapses to expired and frees the seat', async () => {
    const { seatId, offer } = await seedOffer();

    await query("UPDATE reservation_holds SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      offer.hold_id,
    ]);
    const outcome = await expireHold(offer.hold_id);

    assert.equal(outcome, 'expired');

    const offerRow = await query<{ status: string; expired_at: Date | null }>(
      'SELECT status, expired_at FROM waitlist_offers WHERE id = $1',
      [offer.id],
    );
    assert.equal(offerRow.rows[0]!.status, 'expired');
    assert.ok(offerRow.rows[0]!.expired_at);

    assert.equal(await entryStatusForOffer(offer.id), 'expired');

    const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [seatId]);
    assert.equal(seat.rows[0]!.status, 'available');

    const notifications = await query<{ type: string }>(
      'SELECT type FROM waitlist_notification_outbox WHERE offer_id = $1 ORDER BY created_at',
      [offer.id],
    );
    assert.deepEqual(
      notifications.rows.map((row) => row.type),
      ['WAITLIST_OFFER_CREATED', 'WAITLIST_OFFER_EXPIRED'],
    );
  });

  it('offers the seat to the next candidate after expiry', async () => {
    const { eventId, seatId, offer } = await seedOffer();
    const second = await seedCustomer();
    await join(eventId, second);

    await query("UPDATE reservation_holds SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      offer.hold_id,
    ]);
    await expireHold(offer.hold_id);
    await processAllocationOutbox();

    const secondOffer = await query<{ status: string }>(
      `SELECT wo.status FROM waitlist_offers wo
       JOIN waitlist_entries we ON we.id = wo.waitlist_entry_id
       WHERE we.user_id = $1`,
      [second],
    );
    assert.equal(secondOffer.rows[0]!.status, 'offered');

    const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [seatId]);
    assert.equal(seat.rows[0]!.status, 'held');
  });

  it('never lets an expired offer be accepted', async () => {
    const { waiter, offer } = await seedOffer();

    await query("UPDATE reservation_holds SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      offer.hold_id,
    ]);
    await expireHold(offer.hold_id);

    const reply = await accept(offer.id, { userId: waiter });

    assert.equal(reply.status, 409);
    assert.notEqual(reply.json.status, 'accepted');
  });

  it('never lets an accepted offer expire', async () => {
    const { waiter, offer } = await seedOffer();
    assert.equal((await accept(offer.id, { userId: waiter })).status, 200);

    await query("UPDATE reservation_holds SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      offer.hold_id,
    ]);
    const outcome = await expireHold(offer.hold_id);

    assert.equal(outcome, 'noop', 'a converted hold is terminal');

    const offerRow = await query<{ status: string }>('SELECT status FROM waitlist_offers WHERE id = $1', [
      offer.id,
    ]);
    assert.equal(offerRow.rows[0]!.status, 'accepted', 'accepted stays accepted');
  });
});

describe('the core waitlist-then-cancellation scenario', () => {
  it('B is offered, lets it lapse, C accepts, D stays waiting', async () => {
    const { eventId, seatIds } = await seedPublishedShow(1);
    const a = await seedCustomer();
    const bookingId = await book(eventId, a, seatIds[0]!);

    const b = await seedCustomer();
    const c = await seedCustomer();
    const d = await seedCustomer();
    const entryB = await join(eventId, b);
    const entryC = await join(eventId, c);
    const entryD = await join(eventId, d);

    // A cancels; B is offered the seat.
    await cancelBooking(bookingId, a);
    await processAllocationOutbox();

    const offerB = await query<OfferRow>('SELECT * FROM waitlist_offers WHERE waitlist_entry_id = $1', [
      entryB,
    ]);
    assert.equal(offerB.rows[0]!.status, 'offered');

    // B's offer lapses.
    await query("UPDATE reservation_holds SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      offerB.rows[0]!.hold_id,
    ]);
    await expireHold(offerB.rows[0]!.hold_id);
    await processAllocationOutbox();

    const entryBRow = await query<{ status: string }>('SELECT status FROM waitlist_entries WHERE id = $1', [
      entryB,
    ]);
    assert.equal(entryBRow.rows[0]!.status, 'expired', 'B does not get a second chance');

    // C is offered next, and accepts.
    const offerC = await query<OfferRow>('SELECT * FROM waitlist_offers WHERE waitlist_entry_id = $1', [
      entryC,
    ]);
    assert.equal(offerC.rows[0]!.status, 'offered');

    const acceptReply = await accept(offerC.rows[0]!.id, { userId: c });
    assert.equal(acceptReply.status, 200);

    // D never got an offer at all - only one seat ever existed.
    const entryDRow = await query<{ status: string }>('SELECT status FROM waitlist_entries WHERE id = $1', [
      entryD,
    ]);
    assert.equal(entryDRow.rows[0]!.status, 'waiting');

    const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [
      seatIds[0],
    ]);
    assert.equal(seat.rows[0]!.status, 'booked');

    const booking = await query<{ user_id: string }>('SELECT user_id FROM bookings WHERE id = $1', [
      acceptReply.json.bookingId,
    ]);
    assert.equal(booking.rows[0]!.user_id, c);
  });
});

describe('failure injection rolls the whole acceptance back', () => {
  it('leaves the offer intact when the booking cannot be created', async () => {
    const { waiter, offer, seatId } = await seedOffer();

    await query(`ALTER TABLE bookings ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID`);
    let reply: Reply;
    try {
      reply = await accept(offer.id, { userId: waiter });
    } finally {
      await query(`ALTER TABLE bookings DROP CONSTRAINT tmp_force_failure`);
    }

    assert.equal(reply.status, 500);

    const offerRow = await query<{ status: string }>('SELECT status FROM waitlist_offers WHERE id = $1', [
      offer.id,
    ]);
    assert.equal(offerRow.rows[0]!.status, 'offered', 'the offer is untouched');
    assert.equal(await entryStatusForOffer(offer.id), 'offered');

    const hold = await query<{ status: string }>('SELECT status FROM reservation_holds WHERE id = $1', [
      offer.hold_id,
    ]);
    assert.equal(hold.rows[0]!.status, 'active', 'the backing hold was never converted');

    const seat = await query<{ status: string }>('SELECT status FROM show_seats WHERE id = $1', [seatId]);
    assert.equal(seat.rows[0]!.status, 'held', 'still held for this offer, not booked or freed');

    // A clean retry now succeeds.
    assert.equal((await accept(offer.id, { userId: waiter })).status, 200);
  });

  it('leaves the offer intact when the seat update fails', async () => {
    const { waiter, offer, seatId } = await seedOffer();

    await query(`ALTER TABLE show_seats ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID`);
    let reply: Reply;
    try {
      reply = await accept(offer.id, { userId: waiter });
    } finally {
      await query(`ALTER TABLE show_seats DROP CONSTRAINT tmp_force_failure`);
    }

    assert.equal(reply.status, 500);

    const offerRow = await query<{ status: string }>('SELECT status FROM waitlist_offers WHERE id = $1', [
      offer.id,
    ]);
    assert.equal(offerRow.rows[0]!.status, 'offered');
    assert.equal((await query('SELECT status FROM show_seats WHERE id = $1', [seatId])).rows[0]!.status, 'held');
  });
});
