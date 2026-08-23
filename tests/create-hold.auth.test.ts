import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { cleanupAuthedUsers, seedAuthedUser } from './helpers/auth.js';
import { cleanupSeedData, seedShow } from './helpers/seed.js';

let server: Server;
let baseUrl: string;

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await query('DELETE FROM idempotency_keys');
  await cleanupSeedData();
  await cleanupAuthedUsers();
  await closePool();
});

interface HoldResponse {
  holdId?: string;
  showSeatIds?: string[];
  error?: { code: string; message: string; details?: { reason?: string } };
}

async function postHold(
  eventId: string,
  body: unknown,
  options: { token?: string | null; idempotencyKey?: string } = {},
): Promise<{ status: number; json: HoldResponse }> {
  const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/holds`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': options.idempotencyKey ?? randomUUID(),
      ...(options.token == null ? {} : { authorization: `Bearer ${options.token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as HoldResponse };
}

async function holdOwner(holdId: string): Promise<string> {
  const result = await query<{ user_id: string }>(
    'SELECT user_id FROM reservation_holds WHERE id = $1',
    [holdId],
  );
  return result.rows[0]!.user_id;
}

describe('hold endpoint requires authentication', () => {
  it('rejects an unauthenticated hold request', async () => {
    const { eventId, seats } = await seedShow(2);

    const { status, json } = await postHold(eventId, { showSeatIds: [seats[0]!.id] });

    assert.equal(status, 401);
    assert.equal(json.error?.code, 'UNAUTHORIZED');

    const holds = await query('SELECT id FROM reservation_holds WHERE event_id = $1', [eventId]);
    assert.equal(holds.rowCount, 0, 'no hold may be created without an identity');
  });

  it('creates a hold owned by the authenticated user', async () => {
    const { eventId, seats } = await seedShow(2);
    const customer = await seedAuthedUser('customer');

    const { status, json } = await postHold(
      eventId,
      { showSeatIds: [seats[0]!.id] },
      { token: customer.token },
    );

    assert.equal(status, 201);
    assert.equal(await holdOwner(json.holdId!), customer.id);
  });
});

describe('the removed userId field cannot be used to impersonate', () => {
  it('rejects a body carrying userId, and creates nothing', async () => {
    const { eventId, seats } = await seedShow(2);
    const attacker = await seedAuthedUser('customer');
    const victim = await seedAuthedUser('customer');

    // The exact attack the change exists to stop: authenticate as A, ask for
    // the hold to belong to B.
    const { status, json } = await postHold(
      eventId,
      { userId: victim.id, showSeatIds: [seats[0]!.id] },
      { token: attacker.token },
    );

    assert.equal(status, 400, 'the strict schema rejects the obsolete field');
    assert.equal(json.error?.code, 'BAD_REQUEST');

    // Nothing was created for anyone.
    const holds = await query<{ user_id: string }>(
      'SELECT user_id FROM reservation_holds WHERE event_id = $1',
      [eventId],
    );
    assert.equal(holds.rowCount, 0);

    const seatStatus = await query<{ status: string }>(
      'SELECT status FROM show_seats WHERE id = $1',
      [seats[0]!.id],
    );
    assert.equal(seatStatus.rows[0]!.status, 'available');
  });

  it('never attributes a hold to anyone but the bearer, whatever the body says', async () => {
    const { eventId, seats } = await seedShow(4);
    const attacker = await seedAuthedUser('customer');
    const victim = await seedAuthedUser('customer');

    // Every spelling a client might try to smuggle an identity through.
    const smuggleAttempts: Record<string, unknown>[] = [
      { userId: victim.id },
      { user_id: victim.id },
      { sub: victim.id },
      { owner: victim.id },
      { user: { id: victim.id } },
    ];

    for (const [index, extra] of smuggleAttempts.entries()) {
      const { status, json } = await postHold(
        eventId,
        { ...extra, showSeatIds: [seats[index % seats.length]!.id] },
        { token: attacker.token },
      );

      // Whatever the outcome, it must never be a hold belonging to the victim.
      if (status === 201) {
        assert.equal(
          await holdOwner(json.holdId!),
          attacker.id,
          `attempt ${JSON.stringify(extra)} produced a hold for the wrong user`,
        );
      } else {
        assert.equal(status, 400, `attempt ${JSON.stringify(extra)} should be a 400`);
      }
    }

    const victimHolds = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reservation_holds WHERE user_id = $1',
      [victim.id],
    );
    assert.equal(victimHolds.rows[0]!.count, '0', 'the victim must own no holds at all');
  });

  it('binds a hold to the bearer even when another user is authenticated elsewhere', async () => {
    const { eventId, seats } = await seedShow(2);
    const first = await seedAuthedUser('customer');
    const second = await seedAuthedUser('customer');

    const a = await postHold(eventId, { showSeatIds: [seats[0]!.id] }, { token: first.token });
    const b = await postHold(eventId, { showSeatIds: [seats[1]!.id] }, { token: second.token });

    assert.equal(await holdOwner(a.json.holdId!), first.id);
    assert.equal(await holdOwner(b.json.holdId!), second.id);
  });
});

describe('idempotency is scoped to the authenticated user', () => {
  it('replays only for the user who created the key', async () => {
    const { eventId, seats } = await seedShow(3);
    const owner = await seedAuthedUser('customer');
    const other = await seedAuthedUser('customer');
    const sharedKey = `shared-${randomUUID()}`;

    const first = await postHold(
      eventId,
      { showSeatIds: [seats[0]!.id] },
      { token: owner.token, idempotencyKey: sharedKey },
    );
    assert.equal(first.status, 201);

    // Same user, same key: a replay.
    const replay = await postHold(
      eventId,
      { showSeatIds: [seats[0]!.id] },
      { token: owner.token, idempotencyKey: sharedKey },
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.json.holdId, first.json.holdId);

    // Different user, same key string, same seat: not a replay. It is a fresh
    // request that must contend for the seat on its own merits - and lose,
    // because the seat is held.
    const stranger = await postHold(
      eventId,
      { showSeatIds: [seats[0]!.id] },
      { token: other.token, idempotencyKey: sharedKey },
    );
    assert.equal(stranger.status, 409);
    assert.ok(
      !JSON.stringify(stranger.json).includes(first.json.holdId!),
      "another user's hold id must not leak through a shared key",
    );
  });

  it('keys the same string separately per user', async () => {
    const { eventId, seats } = await seedShow(3);
    const one = await seedAuthedUser('customer');
    const two = await seedAuthedUser('customer');
    const sharedKey = `shared-${randomUUID()}`;

    const a = await postHold(
      eventId,
      { showSeatIds: [seats[0]!.id] },
      { token: one.token, idempotencyKey: sharedKey },
    );
    const b = await postHold(
      eventId,
      { showSeatIds: [seats[1]!.id] },
      { token: two.token, idempotencyKey: sharedKey },
    );

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.json.holdId, b.json.holdId);
    assert.equal(await holdOwner(a.json.holdId!), one.id);
    assert.equal(await holdOwner(b.json.holdId!), two.id);

    // Two records, one per user, both under the same key string.
    const records = await query<{ user_id: string }>(
      'SELECT user_id FROM idempotency_keys WHERE key = $1 ORDER BY user_id',
      [sharedKey],
    );
    assert.equal(records.rowCount, 2);
    assert.deepEqual(records.rows.map((r) => r.user_id).sort(), [one.id, two.id].sort());
  });
});
