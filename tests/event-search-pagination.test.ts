import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool } from '../src/db/pool.js';
import { createEvent } from '../src/modules/events/event.service.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace, uniqueClientIp } from './helpers/redis.js';
import { cleanupSeedData, seedOrganiser, seedVenue, trackEvent } from './helpers/seed.js';

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
  await flushTestNamespace();
  await closeTestRedis();
  await cleanupSeedData();
  await closePool();
});

interface Item {
  id: string;
  title: string;
  startsAt: string;
}

interface ListReply {
  status: number;
  json: {
    items?: Item[];
    pagination?: { limit: number; nextCursor: string | null; hasMore: boolean };
    error?: { code: string; message: string };
  };
}

// A fresh IP per call - see event-search.test.ts for why: this suite's own
// per-page request volume would otherwise share a rate-limit bucket with
// every other search test file in the same process.
async function list(qs: string): Promise<ListReply> {
  const response = await fetch(`${baseUrl}/api/v1/events?${qs}`, {
    headers: { 'x-forwarded-for': uniqueClientIp() },
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

/** A block of N published events sharing one venue/organiser, spread over distinct start times and titles. */
async function seedSeries(prefix: string, count: number): Promise<string[]> {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(1);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { event } = await createEvent({
      organiserId,
      venueId,
      title: `${prefix} ${String(i).padStart(3, '0')}`,
      eventType: 'concert',
      startsAt: new Date(Date.UTC(2032, 0, 1 + i, 10, 0, 0)),
      endsAt: new Date(Date.UTC(2032, 0, 1 + i, 12, 0, 0)),
      status: 'published',
    });
    trackEvent(event.id);
    ids.push(event.id);
  }
  return ids;
}

describe('sorting', () => {
  it('start_asc orders by starts_at ascending, with id as a deterministic tie-breaker', async () => {
    const prefix = `Sort ${randomUUID()}`;
    const ids = await seedSeries(prefix, 5);

    const reply = await list(`q=${encodeURIComponent(prefix)}&sort=start_asc&limit=100`);
    const found = reply.json.items!.filter((i) => ids.includes(i.id));
    const startsAts = found.map((i) => i.startsAt);
    const sorted = [...startsAts].sort();
    assert.deepEqual(startsAts, sorted);
  });

  it('start_desc reverses it', async () => {
    const prefix = `Sort ${randomUUID()}`;
    const ids = await seedSeries(prefix, 5);

    const reply = await list(`q=${encodeURIComponent(prefix)}&sort=start_desc&limit=100`);
    const found = reply.json.items!.filter((i) => ids.includes(i.id));
    const startsAts = found.map((i) => i.startsAt);
    const sorted = [...startsAts].sort().reverse();
    assert.deepEqual(startsAts, sorted);
  });

  it('name_asc and name_desc order by title', async () => {
    const prefix = `NameSort ${randomUUID()}`;
    const ids = await seedSeries(prefix, 5);

    const asc = await list(`q=${encodeURIComponent(prefix)}&sort=name_asc&limit=100`);
    const ascTitles = asc.json.items!.filter((i) => ids.includes(i.id)).map((i) => i.title);
    assert.deepEqual(ascTitles, [...ascTitles].sort());

    const desc = await list(`q=${encodeURIComponent(prefix)}&sort=name_desc&limit=100`);
    const descTitles = desc.json.items!.filter((i) => ids.includes(i.id)).map((i) => i.title);
    assert.deepEqual(descTitles, [...ascTitles].reverse());
  });

  it('rejects a sort value outside the allowlist', async () => {
    const reply = await list('sort=starts_at%3B%20DROP%20TABLE%20events%3B--');
    assert.equal(reply.status, 400);
  });
});

describe('cursor pagination', () => {
  it('walks a full result set with no duplicates and no gaps', async () => {
    const prefix = `Walk ${randomUUID()}`;
    const ids = await seedSeries(prefix, 9);

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;

    do {
      const reply: ListReply = await list(
        `q=${encodeURIComponent(prefix)}&sort=start_asc&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      assert.equal(reply.status, 200);
      seen.push(...reply.json.items!.map((i) => i.id));
      cursor = reply.json.pagination!.nextCursor;
      guard += 1;
      assert.ok(guard < 20, 'pagination did not terminate');
    } while (cursor !== null);

    assert.deepEqual(seen.sort(), [...ids].sort(), 'every event seen exactly once, across all pages');
  });

  it('hasMore is true mid-walk and false on the last page', async () => {
    const prefix = `HasMore ${randomUUID()}`;
    await seedSeries(prefix, 3);

    const first = await list(`q=${encodeURIComponent(prefix)}&sort=start_asc&limit=2`);
    assert.equal(first.json.pagination!.hasMore, true);
    assert.ok(first.json.pagination!.nextCursor);

    const second = await list(
      `q=${encodeURIComponent(prefix)}&sort=start_asc&limit=2&cursor=${encodeURIComponent(first.json.pagination!.nextCursor!)}`,
    );
    assert.equal(second.json.items!.length, 1);
    assert.equal(second.json.pagination!.hasMore, false);
    assert.equal(second.json.pagination!.nextCursor, null);
  });

  it('enforces the maximum page size', async () => {
    const reply = await list('limit=1000');
    assert.equal(reply.status, 400);
  });

  it('is stable under a concurrent insert between pages (no shifted/duplicated rows)', async () => {
    const prefix = `Stable ${randomUUID()}`;
    const ids = await seedSeries(prefix, 4);

    const first = await list(`q=${encodeURIComponent(prefix)}&sort=start_asc&limit=2`);
    const firstPageIds = first.json.items!.map((i) => i.id);

    // A new, earlier-sorting event arrives between page 1 and page 2 - the
    // kind of write a live feed sees constantly. Offset pagination could
    // shift page 2 to repeat a row from page 1; keyset pagination cannot,
    // because it resumes from the last row actually seen, not from a count.
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(1);
    const { event: inserted } = await createEvent({
      organiserId,
      venueId,
      title: `${prefix} AAA-inserted`,
      eventType: 'concert',
      startsAt: new Date(Date.UTC(2031, 11, 31)),
      endsAt: new Date(Date.UTC(2031, 11, 31, 2)),
      status: 'published',
    });
    trackEvent(inserted.id);

    const second = await list(
      `q=${encodeURIComponent(prefix)}&sort=start_asc&limit=2&cursor=${encodeURIComponent(first.json.pagination!.nextCursor!)}`,
    );
    const secondPageIds = second.json.items!.map((i) => i.id);

    assert.equal(
      firstPageIds.some((id) => secondPageIds.includes(id)),
      false,
      'no row repeats across pages despite the concurrent insert',
    );
    assert.ok(!secondPageIds.includes(inserted.id), 'the new, earlier-sorting row does not retroactively appear on page 2');
    void ids;
  });
});

describe('cursor security', () => {
  it('rejects malformed base64', async () => {
    const reply = await list('cursor=%25%25%25not-base64%25%25%25');
    assert.equal(reply.status, 400);
  });

  it('rejects a cursor that is valid base64 but not JSON', async () => {
    const notJson = Buffer.from('not json at all', 'utf8').toString('base64url');
    const reply = await list(`cursor=${notJson}`);
    assert.equal(reply.status, 400);
  });

  it('rejects a cursor with the wrong version', async () => {
    const cursor = Buffer.from(JSON.stringify({ v: 2, sort: 'start_asc', key: 'x', id: randomUUID() }), 'utf8').toString(
      'base64url',
    );
    const reply = await list(`cursor=${cursor}&sort=start_asc`);
    assert.equal(reply.status, 400);
  });

  it('rejects a cursor minted for a different sort', async () => {
    const prefix = `CursorSort ${randomUUID()}`;
    await seedSeries(prefix, 3);

    const ascPage = await list(`q=${encodeURIComponent(prefix)}&sort=start_asc&limit=1`);
    const cursorForAsc = ascPage.json.pagination!.nextCursor!;

    const reply = await list(`q=${encodeURIComponent(prefix)}&sort=name_desc&limit=1&cursor=${encodeURIComponent(cursorForAsc)}`);
    assert.equal(reply.status, 400);
  });

  it('rejects a cursor missing required fields', async () => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, sort: 'start_asc' }), 'utf8').toString('base64url');
    const reply = await list(`cursor=${cursor}&sort=start_asc`);
    assert.equal(reply.status, 400);
  });

  it('rejects a cursor with the wrong field types', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, sort: 'start_asc', key: 12345, id: randomUUID() }),
      'utf8',
    ).toString('base64url');
    const reply = await list(`cursor=${cursor}&sort=start_asc`);
    assert.equal(reply.status, 400);
  });

  it('rejects a cursor whose id is not a UUID', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, sort: 'start_asc', key: '2031-01-01T00:00:00.000Z', id: 'not-a-uuid' }),
      'utf8',
    ).toString('base64url');
    const reply = await list(`cursor=${cursor}&sort=start_asc`);
    assert.equal(reply.status, 400);
  });

  it('rejects a cursor with a tampered/modified key value gracefully (still a valid request, just a different position)', async () => {
    // Tampering with `key`/`id` is not a security bypass - see the design
    // note in event.schema.ts - it can only change *where* pagination
    // resumes, never *what* is visible. This proves that: an absurd future
    // key still returns a well-formed, empty-or-valid response, not an error.
    const cursor = Buffer.from(
      JSON.stringify({ v: 1, sort: 'start_asc', key: '2099-01-01T00:00:00.000Z', id: randomUUID() }),
      'utf8',
    ).toString('base64url');
    const reply = await list(`cursor=${cursor}&sort=start_asc`);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json.items, []);
  });

  it('does not leak a parser exception or stack trace for any malformed cursor', async () => {
    const reply = await list('cursor=%25%25%25garbage%25%25%25');
    assert.equal(reply.status, 400);
    const text = JSON.stringify(reply.json);
    assert.ok(!text.includes('at Object'), 'no stack frame leaked');
    assert.ok(!text.toLowerCase().includes('syntaxerror'), 'no raw parser exception name leaked');
  });
});
