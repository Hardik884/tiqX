import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query, withTransaction } from '../src/db/pool.js';
import { accessTokenForUser } from './helpers/auth.js';
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
  await cleanupSeedData();
  await closePool();
});

interface Reply {
  status: number;
  json: { event?: { status?: string }; error?: { details?: { reason?: string } } };
}

async function publishRequest(eventId: string, organiserId: string): Promise<() => Promise<Reply>> {
  const authorization = `Bearer ${await accessTokenForUser(organiserId)}`;
  return async () => {
    const response = await fetch(`${baseUrl}/api/v1/events/${eventId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
    });
    const raw = await response.text();
    return { status: response.status, json: raw ? JSON.parse(raw) : {} };
  };
}

async function patchRequest(eventId: string, organiserId: string, body: unknown) {
  const response = await fetch(`${baseUrl}/api/v1/events/${eventId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await accessTokenForUser(organiserId)}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status };
}

async function deleteRequest(eventId: string, organiserId: string) {
  const response = await fetch(`${baseUrl}/api/v1/events/${eventId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${await accessTokenForUser(organiserId)}` },
  });
  return { status: response.status };
}

describe('50 concurrent publish requests on the same draft event', () => {
  it('produces exactly one transition and 49 stable conflicts', async () => {
    const ATTEMPTS = 50;
    const { eventId, organiserId } = await seedShow(2);

    const requests = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => publishRequest(eventId, organiserId)),
    );
    const replies = await Promise.all(requests.map((send) => send()));

    const succeeded = replies.filter((r) => r.status === 200);
    const conflicted = replies.filter((r) => r.status === 409);

    assert.equal(succeeded.length, 1, 'exactly one publish succeeds');
    assert.equal(conflicted.length, ATTEMPTS - 1);
    assert.equal(succeeded.length + conflicted.length, ATTEMPTS, 'no other status codes');
    assert.ok(
      conflicted.every((r) => r.json.error?.details?.reason === 'EVENT_ALREADY_PUBLISHED'),
      'every loser is told why, and it is the same reason every time',
    );

    const row = await query<{ status: string }>('SELECT status FROM events WHERE id = $1', [eventId]);
    assert.equal(row.rows[0]!.status, 'published', 'exactly one state transition, nothing left ambiguous');
  });
});

describe('negative control: publish concurrency is sensitive to the guard', () => {
  it('reproduces a double transition when both the row lock and the guarded WHERE are bypassed', async () => {
    // Isolates what actually protects concurrent publish, the same way the
    // ticket module's negative control does: `publishEventInTransaction`
    // takes a `FOR UPDATE` lock via `lockEventForOwnership` *before* the
    // guarded `UPDATE ... WHERE status = 'draft'` ever runs, so removing only
    // one of the two would not by itself prove much - the other still
    // serialises every caller. This drives the same race through neither
    // protection at all: an unlocked read, a delay to widen the window, then
    // an unconditional write.
    const ATTEMPTS = 50;
    const { eventId } = await seedShow(1);

    async function unsafePublish(): Promise<boolean> {
      return withTransaction(async (client) => {
        const current = await client.query<{ status: string }>(
          'SELECT status FROM events WHERE id = $1',
          [eventId],
        );
        if (current.rows[0]?.status !== 'draft') {
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        await client.query(`UPDATE events SET status = 'published' WHERE id = $1`, [eventId]);
        return true;
      });
    }

    const results = await Promise.all(Array.from({ length: ATTEMPTS }, () => unsafePublish()));
    const believedTheyPublished = results.filter(Boolean).length;

    assert.ok(
      believedTheyPublished > 1,
      `negative control did not reproduce a double transition (got ${believedTheyPublished}) - ` +
        'the 50-way test above would not have caught a missing guard',
    );
  });
});

describe('concurrent update vs publish', () => {
  it('never leaves the event in a state that is neither fully updated nor fully published', async () => {
    const ROUNDS = 8;
    for (let round = 0; round < ROUNDS; round += 1) {
      const { eventId, organiserId } = await seedShow(1);

      const send = await publishRequest(eventId, organiserId);
      const [publishResult, patchResult] = await Promise.allSettled([
        send(),
        patchRequest(eventId, organiserId, { title: `Concurrent ${round}` }),
      ]);

      assert.equal(publishResult.status, 'fulfilled', `round ${round}: publish must not error`);
      assert.equal(patchResult.status, 'fulfilled', `round ${round}: patch must not error`);

      const row = await query<{ status: string; title: string }>(
        'SELECT status, title FROM events WHERE id = $1',
        [eventId],
      );
      // Both operations lock the same row and run one after the other -
      // whichever order, both effects are visible: the title changed and the
      // event is published. Neither can partially apply.
      assert.equal(row.rows[0]!.title, `Concurrent ${round}`);
      assert.equal(row.rows[0]!.status, 'published');
    }
  });
});

describe('concurrent publish vs delete', () => {
  it('never lets both win: either it publishes, or it is deleted, never both', async () => {
    const ROUNDS = 8;
    let publishWins = 0;
    let deleteWins = 0;

    for (let round = 0; round < ROUNDS; round += 1) {
      const { eventId, organiserId } = await seedShow(1);

      const send = await publishRequest(eventId, organiserId);
      const [publishResult, deleteResult] = await Promise.allSettled([
        send(),
        deleteRequest(eventId, organiserId),
      ]);

      assert.equal(publishResult.status, 'fulfilled', `round ${round}`);
      assert.equal(deleteResult.status, 'fulfilled', `round ${round}`);

      const row = await query('SELECT id FROM events WHERE id = $1', [eventId]);
      const stillExists = row.rowCount === 1;

      if (publishResult.value.status === 200) {
        publishWins += 1;
        // Delete only ever removes a draft (see deleteEventInTransaction) -
        // once publish has committed, delete finds the row no longer draft
        // and refuses, whichever order the two actually ran in under the
        // shared row lock.
        assert.ok(stillExists, `round ${round}: a published event was never deleted`);
        assert.equal(
          deleteResult.status === 'fulfilled' ? deleteResult.value.status : null,
          409,
          `round ${round}: delete is refused once the event is no longer draft`,
        );
      } else {
        deleteWins += 1;
        assert.ok(!stillExists, `round ${round}: delete won, the row is gone`);
        assert.equal(
          publishResult.status === 'fulfilled' ? publishResult.value.status : null,
          404,
          `round ${round}: publish finds nothing left to publish`,
        );
      }
    }

    assert.equal(publishWins + deleteWins, ROUNDS);
  });
});
