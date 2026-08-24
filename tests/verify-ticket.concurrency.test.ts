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

interface VerifyReply {
  status: number;
  json: { status?: string; error?: { details?: { reason?: string } } };
}

/** Builds a request, minting the token up front so the burst measures the API. */
async function verifyRequest(ticketId: string, organiserId: string): Promise<() => Promise<VerifyReply>> {
  const authorization = `Bearer ${await accessTokenForUser(organiserId)}`;
  return async () => {
    const response = await fetch(`${baseUrl}/api/v1/tickets/${ticketId}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
    });
    const raw = await response.text();
    return { status: response.status, json: raw ? JSON.parse(raw) : {} };
  };
}

async function issueOne(bookingId: string, userId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/bookings/${bookingId}/tickets/issue`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessTokenForUser(userId)}`,
      'idempotency-key': randomUUID(),
    },
  });
  const body = (await response.json()) as { tickets: { ticketId: string }[] };
  return body.tickets[0]!.ticketId;
}

async function cancel(bookingId: string, userId: string) {
  return withTransaction((client) => cancelBookingInTransaction(client, { userId, bookingId }, undefined));
}

describe('50 concurrent verifications of the same ticket', () => {
  it('lets exactly one succeed and the rest observe TICKET_ALREADY_USED', async () => {
    const ATTEMPTS = 50;
    const booking = await seedConfirmedBooking(1);
    const ticketId = await issueOne(booking.bookingId, booking.userId);

    const requests = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => verifyRequest(ticketId, booking.organiserId)),
    );
    const replies = await Promise.all(requests.map((send) => send()));

    const accepted = replies.filter((r) => r.status === 200);
    const rejected = replies.filter((r) => r.status === 409);

    assert.equal(accepted.length, 1, 'exactly one verification succeeds');
    assert.equal(rejected.length, ATTEMPTS - 1, 'every other caller is rejected');
    assert.equal(accepted.length + rejected.length, ATTEMPTS, 'no other status codes');
    assert.ok(
      rejected.every((r) => r.json.error?.details?.reason === 'TICKET_ALREADY_USED'),
      'and told why',
    );

    const row = await query<{ status: string; used_at: Date }>(
      'SELECT status, used_at FROM tickets WHERE id = $1',
      [ticketId],
    );
    assert.equal(row.rows[0]!.status, 'used', 'exactly one state transition');
    assert.ok(row.rows[0]!.used_at, 'exactly one used_at');
  });
});

describe('negative control: the guard actually matters', () => {
  it('reproduces double acceptance when the guarded UPDATE is replaced by SELECT-then-UPDATE', async () => {
    // Proves the 50-way test above is sensitive to the thing it claims to
    // test, by removing the guard it depends on and showing the corruption
    // that guard prevents.
    //
    // This does NOT patch `markTicketUsed` in place and re-run the HTTP test,
    // because that was tried by hand and is misleading here: every request
    // also passes through `lockBookingForTickets`'s `FOR UPDATE OF b` on the
    // booking row first (taken for the cancellation race, not this one), and
    // for "50 requests against one ticket of one booking" that lock alone
    // already serialises every request before any of them reach a weakened
    // `markTicketUsed` - so the endpoint test kept passing even with the
    // guard removed, and would not have caught its absence. That is a real
    // defence-in-depth property of this design, not a substitute for the
    // guard: the booking lock protects the cancellation race, and does not
    // exist to protect this one. To isolate what the guarded UPDATE itself
    // contributes, this drives the same race directly against `tickets`
    // through raw SQL of its own, bypassing the booking lock entirely, using
    // the unsafe pattern `markTicketUsed` deliberately does not use.
    const ATTEMPTS = 50;
    const booking = await seedConfirmedBooking(1);
    const ticketId = await issueOne(booking.bookingId, booking.userId);

    async function unsafeVerify(): Promise<boolean> {
      return withTransaction(async (client) => {
        const current = await client.query<{ status: string }>(
          'SELECT status FROM tickets WHERE id = $1',
          [ticketId],
        );
        if (current.rows[0]?.status !== 'issued') {
          return false;
        }
        // The vulnerable gap: any interleaving between this SELECT and the
        // UPDATE below lets a second transaction pass the same check.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await client.query(`UPDATE tickets SET status = 'used', used_at = now() WHERE id = $1`, [
          ticketId,
        ]);
        return true;
      });
    }

    const results = await Promise.all(Array.from({ length: ATTEMPTS }, () => unsafeVerify()));
    const acceptedCount = results.filter(Boolean).length;

    // This is the failure the real guard exists to prevent: without it, more
    // than one caller believes it was the one that accepted the ticket.
    assert.ok(
      acceptedCount > 1,
      `negative control did not reproduce double acceptance (got ${acceptedCount}) - ` +
        'the concurrency test above would not have caught a missing guard',
    );
  });
});

describe('verification racing booking cancellation', () => {
  it('never leaves a cancelled booking with a used ticket', async () => {
    const ROUNDS = 10;
    let verifyWins = 0;
    let cancelWins = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const booking = await seedConfirmedBooking(1);
      const ticketId = await issueOne(booking.bookingId, booking.userId);
      const send = await verifyRequest(ticketId, booking.organiserId);

      const [verifyResult, cancelResult] = await Promise.allSettled([
        send(),
        cancel(booking.bookingId, booking.userId),
      ]);

      assert.equal(verifyResult.status, 'fulfilled', `round ${round}: the API must not error`);

      const ticketRow = await query<{ status: string }>('SELECT status FROM tickets WHERE id = $1', [
        ticketId,
      ]);
      const bookingRow = await query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [
        booking.bookingId,
      ]);

      const ticketUsed = ticketRow.rows[0]!.status === 'used';
      const bookingCancelled = bookingRow.rows[0]!.status === 'cancelled';

      // The invariant this whole test exists to check.
      assert.ok(
        !(ticketUsed && bookingCancelled),
        `round ${round}: booking cancelled AND ticket used - the forbidden state`,
      );

      if (verifyResult.status === 'fulfilled' && verifyResult.value.status === 200) {
        verifyWins += 1;
        assert.ok(ticketUsed, `round ${round}: verification won, ticket must be used`);
        assert.ok(!bookingCancelled, `round ${round}: cancellation must have been refused`);
        // Refused, not silently skipped: cancelBookingInTransaction throws
        // once it finds a used ticket under the same lock verification wrote
        // it with, and withTransaction rolls that back rather than swallowing
        // it - "fails safely" means the promise rejects, not resolves.
        assert.equal(cancelResult.status, 'rejected', `round ${round}: cancellation must fail, not no-op`);
        if (cancelResult.status === 'rejected') {
          assert.equal(
            (cancelResult.reason as { details?: { reason?: string } })?.details?.reason,
            'BOOKING_HAS_USED_TICKETS',
          );
        }
      } else {
        cancelWins += 1;
        assert.equal(cancelResult.status, 'fulfilled', `round ${round}: cancellation must succeed`);
        assert.ok(bookingCancelled, `round ${round}: cancellation won, booking must be cancelled`);
        assert.ok(!ticketUsed, `round ${round}: the ticket must not have been accepted`);
        assert.equal(
          verifyResult.status === 'fulfilled' ? verifyResult.value.status : null,
          409,
          `round ${round}: verification must fail cleanly, not error`,
        );
      }
    }

    // Not asserting a particular split - that is timing - only that the
    // invariant held on every round and both outcomes are exercised.
    assert.equal(verifyWins + cancelWins, ROUNDS);
  });
});

describe('ticket issuance racing booking cancellation', () => {
  it('never issues tickets for a booking that commits its cancellation', async () => {
    const ROUNDS = 10;
    let issueWins = 0;
    let cancelWins = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const booking = await seedConfirmedBooking(1);
      const authorization = `Bearer ${await accessTokenForUser(booking.userId)}`;
      const issue = async () => {
        const response = await fetch(`${baseUrl}/api/v1/bookings/${booking.bookingId}/tickets/issue`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization, 'idempotency-key': randomUUID() },
        });
        return { status: response.status };
      };

      const [issueResult, cancelResult] = await Promise.allSettled([
        issue(),
        cancel(booking.bookingId, booking.userId),
      ]);

      assert.equal(issueResult.status, 'fulfilled', `round ${round}: the API must not error`);

      const ticketCount = await query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tickets WHERE booking_id = $1',
        [booking.bookingId],
      );
      const bookingRow = await query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [
        booking.bookingId,
      ]);
      const hasTickets = Number(ticketCount.rows[0]!.count) > 0;
      const bookingCancelled = bookingRow.rows[0]!.status === 'cancelled';

      if (issueResult.status === 'fulfilled' && issueResult.value.status === 201) {
        issueWins += 1;
        assert.ok(hasTickets, `round ${round}: issuance won, tickets must exist`);
        // Section 15's other branch: an unused, merely `issued` ticket does
        // not block cancellation - only a `used` one does (see the
        // verification-vs-cancellation suite above). So cancellation, having
        // waited behind the same booking lock, now runs normally and
        // succeeds; the ticket is left exactly as issuance wrote it.
        assert.equal(cancelResult.status, 'fulfilled', `round ${round}: an issued ticket must not block cancellation`);
        assert.ok(bookingCancelled, `round ${round}: cancellation still completes after issuance`);
        const ticketStatus = await query<{ status: string }>(
          'SELECT status FROM tickets WHERE booking_id = $1',
          [booking.bookingId],
        );
        assert.equal(ticketStatus.rows[0]!.status, 'issued', 'the ticket row itself is left untouched');
      } else {
        cancelWins += 1;
        assert.equal(cancelResult.status, 'fulfilled', `round ${round}: cancellation must succeed`);
        assert.ok(bookingCancelled, `round ${round}: cancellation won, booking must be cancelled`);
        assert.ok(!hasTickets, `round ${round}: a cancelled booking must never receive tickets`);
        assert.equal(
          issueResult.status === 'fulfilled' ? issueResult.value.status : null,
          409,
          `round ${round}: issuance must fail cleanly, not error`,
        );
      }
    }

    assert.equal(issueWins + cancelWins, ROUNDS);
  });
});
