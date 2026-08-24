import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { createEvent } from '../src/modules/events/event.service.js';
import type { EventCategory, EventType } from '../src/modules/events/event.types.js';
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

interface PublicItem {
  id: string;
  title: string;
  description: string | null;
  category: string;
  eventType: string;
  status: string;
  startsAt: string;
  endsAt: string;
  venue: { id: string; name: string; city: string | null };
  currency: string;
  availableSeats: number;
  startingPrice: string | null;
}

interface ListReply {
  status: number;
  json: {
    items?: PublicItem[];
    pagination?: { limit: number; nextCursor: string | null; hasMore: boolean };
    error?: { code: string; message: string; details?: unknown };
  };
}

// A fresh IP per call: this file's own request volume, combined with every
// other search test file sharing one Node process under `npm test`, would
// otherwise exhaust the search rate limit's shared 127.0.0.1 bucket and turn
// unrelated assertions into 429s - see event-search-injection.test.ts, which
// tests the limiter itself under its own dedicated identifiers.
async function list(qs: string): Promise<ListReply> {
  const response = await fetch(`${baseUrl}/api/v1/events${qs ? `?${qs}` : ''}`, {
    headers: { 'x-forwarded-for': uniqueClientIp() },
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

/** Seeds one venue and one organiser once, then several published events over it. */
async function seedCatalog() {
  const organiserId = await seedOrganiser();
  const { venueId } = await seedVenue(2, 'A', 1, 'Vellore');
  const { venueId: venueId2 } = await seedVenue(2, 'A', 1, 'Chennai');

  async function seedEvent(opts: {
    title: string;
    description?: string;
    category?: EventCategory;
    eventType?: EventType;
    venue?: string;
    startsAt: string;
    price?: string;
  }) {
    const { event } = await createEvent({
      organiserId,
      venueId: opts.venue ?? venueId,
      title: opts.title,
      description: opts.description,
      category: opts.category,
      eventType: opts.eventType ?? 'concert',
      startsAt: new Date(opts.startsAt),
      endsAt: new Date(new Date(opts.startsAt).getTime() + 2 * 60 * 60 * 1000),
      status: 'published',
      pricing: opts.price === undefined ? undefined : { standard: opts.price },
    });
    trackEvent(event.id);
    return event;
  }

  return { organiserId, venueId, venueId2, seedEvent };
}

describe('GET /api/v1/events - visibility', () => {
  it('returns published events to an anonymous caller', async () => {
    const { seedEvent } = await seedCatalog();
    const event = await seedEvent({ title: `Published Show ${randomUUID()}`, startsAt: '2031-01-01T18:00:00.000Z' });

    const reply = await list(`q=${encodeURIComponent(event.title)}`);

    assert.equal(reply.status, 200);
    const found = reply.json.items!.find((item) => item.id === event.id);
    assert.ok(found, 'the published event appears');
    assert.equal(found!.venue.city, 'Vellore');
    assert.equal(found!.status, 'published');
  });

  it('excludes a draft event', async () => {
    const organiserId = await seedOrganiser();
    const { venueId } = await seedVenue(2);
    const title = `Draft Hidden ${randomUUID()}`;
    const { event } = await createEvent({
      organiserId,
      venueId,
      title,
      eventType: 'concert',
      startsAt: new Date('2031-01-01T18:00:00.000Z'),
      endsAt: new Date('2031-01-01T20:00:00.000Z'),
      // status omitted -> defaults to 'draft'
    });
    trackEvent(event.id);

    const reply = await list(`q=${encodeURIComponent(title)}`);
    assert.equal(reply.status, 200);
    assert.ok(!reply.json.items!.some((item) => item.id === event.id), 'a draft never appears in public search');
  });

  it('includes cancelled and completed events, consistent with the existing single-event visibility rule', async () => {
    const { seedEvent } = await seedCatalog();
    const cancelled = await seedEvent({ title: `Cancelled Listed ${randomUUID()}`, startsAt: '2031-02-01T18:00:00.000Z' });
    const completed = await seedEvent({ title: `Completed Listed ${randomUUID()}`, startsAt: '2031-02-02T18:00:00.000Z' });
    await query("UPDATE events SET status = 'cancelled' WHERE id = $1", [cancelled.id]);
    await query("UPDATE events SET status = 'completed' WHERE id = $1", [completed.id]);

    const cancelledReply = await list(`q=${encodeURIComponent(cancelled.title)}`);
    const completedReply = await list(`q=${encodeURIComponent(completed.title)}`);

    assert.ok(cancelledReply.json.items!.some((item) => item.id === cancelled.id));
    assert.ok(completedReply.json.items!.some((item) => item.id === completed.id));
  });

  it('never exposes organiser id, hold data or booking data in the public DTO', async () => {
    const { seedEvent } = await seedCatalog();
    const event = await seedEvent({ title: `Shape Check ${randomUUID()}`, startsAt: '2031-01-03T18:00:00.000Z' });

    const reply = await list(`q=${encodeURIComponent(event.title)}`);
    const found = reply.json.items!.find((item) => item.id === event.id)!;

    const raw = found as unknown as Record<string, unknown>;
    assert.equal(raw.organiserId, undefined);
    assert.equal(raw.createdAt, undefined);
    assert.equal(raw.updatedAt, undefined);
    assert.equal(raw.holdId, undefined);
    assert.equal(raw.bookingId, undefined);
  });
});

describe('GET /api/v1/events - search (q)', () => {
  it('matches by title, case-insensitively', async () => {
    const { seedEvent } = await seedCatalog();
    const unique = randomUUID().slice(0, 8);
    const event = await seedEvent({ title: `Rock Concert ${unique}`, startsAt: '2031-03-01T18:00:00.000Z' });

    const lower = await list(`q=${encodeURIComponent(`rock ${unique}`)}`);
    const upper = await list(`q=${encodeURIComponent(`ROCK ${unique}`)}`);

    assert.ok(lower.json.items!.some((i) => i.id === event.id));
    assert.ok(upper.json.items!.some((i) => i.id === event.id));
  });

  it('matches by description', async () => {
    const { seedEvent } = await seedCatalog();
    const unique = randomUUID().slice(0, 8);
    const event = await seedEvent({
      title: `Untitled ${randomUUID()}`,
      description: `A spectacular jazz evening ${unique}`,
      startsAt: '2031-03-02T18:00:00.000Z',
    });

    const reply = await list(`q=${encodeURIComponent(`jazz ${unique}`)}`);
    assert.ok(reply.json.items!.some((i) => i.id === event.id));
  });

  it('matches multi-word queries regardless of word order (AND semantics, not phrase)', async () => {
    const { seedEvent } = await seedCatalog();
    const unique = randomUUID().slice(0, 8);
    const event = await seedEvent({ title: `${unique} Concert Night`, startsAt: '2031-03-03T18:00:00.000Z' });

    const reply = await list(`q=${encodeURIComponent(`night concert ${unique}`)}`);
    assert.ok(reply.json.items!.some((i) => i.id === event.id), 'word order does not matter for a plain multi-word query');
  });

  it('applies English stemming (e.g. "rocking" matches "rock")', async () => {
    const { seedEvent } = await seedCatalog();
    const unique = randomUUID().slice(0, 8);
    const event = await seedEvent({ title: `Rock Night ${unique}`, startsAt: '2031-03-04T18:00:00.000Z' });

    const reply = await list(`q=${encodeURIComponent(`rocking ${unique}`)}`);
    assert.ok(reply.json.items!.some((i) => i.id === event.id), 'the English stemmer reduces "rocking" to "rock"');
  });

  it('matches an incomplete (prefix) word, not just a complete one', async () => {
    const { seedEvent } = await seedCatalog();
    const unique = randomUUID().slice(0, 8);
    const event = await seedEvent({ title: `Interstellar ${unique} Live`, startsAt: '2031-03-06T18:00:00.000Z' });

    // "inter" is a real prefix of "interstellar" but not itself a lexeme
    // `websearch_to_tsquery` would ever match against it - see
    // event.repository.ts::findPublicEventsPage for why plain
    // `websearch_to_tsquery` alone cannot do this.
    const prefixOfFirstWord = await list(`q=${encodeURIComponent(`inter ${unique}`)}`);
    assert.ok(
      prefixOfFirstWord.json.items!.some((i) => i.id === event.id),
      'a prefix of the title\'s first word should match',
    );

    const partialUnique = await list(`q=${encodeURIComponent(unique.slice(0, 4))}`);
    assert.ok(
      partialUnique.json.items!.some((i) => i.id === event.id),
      'a prefix of a later word should also match',
    );
  });

  it('does not treat a prefix match as a substring match anywhere in the word', async () => {
    const { seedEvent } = await seedCatalog();
    const unique = randomUUID().slice(0, 8);
    const event = await seedEvent({ title: `Interstellar ${unique}`, startsAt: '2031-03-07T18:00:00.000Z' });

    // "stellar" is a real substring of "interstellar" but not a prefix of it,
    // so it must not match - this is prefix search, not substring search.
    const reply = await list(`q=${encodeURIComponent(`stellar ${unique}`)}`);
    assert.ok(!reply.json.items!.some((i) => i.id === event.id));
  });

  it('matches by venue name even though venue name is not in the tsvector', async () => {
    const organiserId = await seedOrganiser();
    const uniqueVenueName = `Grand Arena ${randomUUID()}`;
    const { venueId } = await seedVenue(1, 'A', 1, 'Testville');
    await query('UPDATE venues SET name = $2 WHERE id = $1', [venueId, uniqueVenueName]);

    const { event } = await createEvent({
      organiserId,
      venueId,
      title: `Some Show ${randomUUID()}`,
      eventType: 'concert',
      startsAt: new Date('2031-03-05T18:00:00.000Z'),
      endsAt: new Date('2031-03-05T20:00:00.000Z'),
      status: 'published',
    });
    trackEvent(event.id);

    const reply = await list(`q=${encodeURIComponent(uniqueVenueName)}`);
    assert.ok(reply.json.items!.some((i) => i.id === event.id));
  });

  it('finds nothing for a query that matches nothing', async () => {
    const reply = await list(`q=${encodeURIComponent(`zzz-no-such-term-${randomUUID()}`)}`);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json.items, []);
  });
});

describe('GET /api/v1/events - filters', () => {
  it('filters by category', async () => {
    const { seedEvent } = await seedCatalog();
    const music = await seedEvent({ title: `Music Filter ${randomUUID()}`, category: 'music', startsAt: '2031-04-01T18:00:00.000Z' });
    const comedy = await seedEvent({ title: `Comedy Filter ${randomUUID()}`, category: 'comedy', startsAt: '2031-04-01T18:00:00.000Z' });

    const reply = await list('category=music&limit=100');
    const ids = reply.json.items!.map((i) => i.id);
    assert.ok(ids.includes(music.id));
    assert.ok(!ids.includes(comedy.id));
  });

  it('rejects an unsupported category', async () => {
    const reply = await list('category=not-a-real-category');
    assert.equal(reply.status, 400);
  });

  it('filters by eventType', async () => {
    const { seedEvent } = await seedCatalog();
    const movie = await seedEvent({ title: `Movie Filter ${randomUUID()}`, eventType: 'movie', startsAt: '2031-04-02T18:00:00.000Z' });
    const concert = await seedEvent({ title: `Concert Filter ${randomUUID()}`, eventType: 'concert', startsAt: '2031-04-02T18:00:00.000Z' });

    const reply = await list('eventType=movie&limit=100');
    const ids = reply.json.items!.map((i) => i.id);
    assert.ok(ids.includes(movie.id));
    assert.ok(!ids.includes(concert.id));
  });

  it('filters by city, case-insensitively, exact match', async () => {
    const { seedEvent, venueId2 } = await seedCatalog();
    const inCity = await seedEvent({ title: `City Filter A ${randomUUID()}`, startsAt: '2031-04-03T18:00:00.000Z' });
    const otherCity = await seedEvent({ title: `City Filter B ${randomUUID()}`, venue: venueId2, startsAt: '2031-04-03T18:00:00.000Z' });

    const reply = await list(`city=${encodeURIComponent('vellore')}&limit=100`);
    const ids = reply.json.items!.map((i) => i.id);
    assert.ok(ids.includes(inCity.id));
    assert.ok(!ids.includes(otherCity.id));
  });

  it('filters by venueId', async () => {
    const { seedEvent, venueId, venueId2 } = await seedCatalog();
    const a = await seedEvent({ title: `Venue Filter A ${randomUUID()}`, startsAt: '2031-04-04T18:00:00.000Z' });
    const b = await seedEvent({ title: `Venue Filter B ${randomUUID()}`, venue: venueId2, startsAt: '2031-04-04T18:00:00.000Z' });

    const reply = await list(`venueId=${venueId}&limit=100`);
    const ids = reply.json.items!.map((i) => i.id);
    assert.ok(ids.includes(a.id));
    assert.ok(!ids.includes(b.id));
  });

  it('filters by startFrom and startTo', async () => {
    const { seedEvent } = await seedCatalog();
    const early = await seedEvent({ title: `Range Early ${randomUUID()}`, startsAt: '2031-05-01T10:00:00.000Z' });
    const mid = await seedEvent({ title: `Range Mid ${randomUUID()}`, startsAt: '2031-05-10T10:00:00.000Z' });
    const late = await seedEvent({ title: `Range Late ${randomUUID()}`, startsAt: '2031-05-20T10:00:00.000Z' });

    const reply = await list('startFrom=2031-05-05T00:00:00.000Z&startTo=2031-05-15T00:00:00.000Z&limit=100');
    const ids = reply.json.items!.map((i) => i.id);
    assert.ok(!ids.includes(early.id));
    assert.ok(ids.includes(mid.id));
    assert.ok(!ids.includes(late.id));
  });

  it('includes an event exactly at the startFrom/startTo boundary (inclusive)', async () => {
    const { seedEvent } = await seedCatalog();
    const onBoundary = await seedEvent({ title: `Boundary Exact ${randomUUID()}`, startsAt: '2031-06-01T00:00:00.000Z' });

    const reply = await list('startFrom=2031-06-01T00:00:00.000Z&startTo=2031-06-01T00:00:00.000Z&limit=100');
    assert.ok(reply.json.items!.some((i) => i.id === onBoundary.id));
  });

  it('handles startFrom == startTo as a single-instant window', async () => {
    const { seedEvent } = await seedCatalog();
    const at = await seedEvent({ title: `Instant Window ${randomUUID()}`, startsAt: '2031-06-02T12:00:00.000Z' });
    const before = await seedEvent({ title: `Instant Before ${randomUUID()}`, startsAt: '2031-06-02T11:59:59.000Z' });

    const reply = await list('startFrom=2031-06-02T12:00:00.000Z&startTo=2031-06-02T12:00:00.000Z&limit=100');
    const ids = reply.json.items!.map((i) => i.id);
    assert.ok(ids.includes(at.id));
    assert.ok(!ids.includes(before.id));
  });

  it('rejects startFrom after startTo', async () => {
    const reply = await list('startFrom=2031-06-10T00:00:00.000Z&startTo=2031-06-01T00:00:00.000Z');
    assert.equal(reply.status, 400);
  });

  it('combines q, category, city and a date range together', async () => {
    const { seedEvent } = await seedCatalog();
    const unique = randomUUID().slice(0, 8);
    const match = await seedEvent({
      title: `Combined ${unique}`,
      category: 'music',
      startsAt: '2031-07-15T18:00:00.000Z',
    });
    const wrongCategory = await seedEvent({
      title: `Combined ${unique}`,
      category: 'comedy',
      startsAt: '2031-07-15T18:00:00.000Z',
    });

    const reply = await list(
      `q=${encodeURIComponent(unique)}&category=music&city=${encodeURIComponent('vellore')}` +
        '&startFrom=2031-07-01T00:00:00.000Z&startTo=2031-07-31T00:00:00.000Z&limit=100',
    );
    const ids = reply.json.items!.map((i) => i.id);
    assert.ok(ids.includes(match.id));
    assert.ok(!ids.includes(wrongCategory.id));
  });
});

describe('GET /api/v1/events - availability and price', () => {
  it('reports availableSeats from show_seats only, and startingPrice as a NUMERIC string', async () => {
    const { seedEvent } = await seedCatalog();
    const event = await seedEvent({
      title: `Priced Event ${randomUUID()}`,
      startsAt: '2031-08-01T18:00:00.000Z',
      price: '450.10',
    });

    const reply = await list(`q=${encodeURIComponent(event.title)}`);
    const found = reply.json.items!.find((i) => i.id === event.id)!;

    assert.equal(found.availableSeats, 2);
    assert.equal(found.startingPrice, '450.10');
    assert.equal(found.currency, 'INR');
  });

  it('handles a non-terminating decimal-looking price exactly (333.33)', async () => {
    const { seedEvent } = await seedCatalog();
    const event = await seedEvent({
      title: `Precise Price ${randomUUID()}`,
      startsAt: '2031-08-02T18:00:00.000Z',
      price: '333.33',
    });

    const reply = await list(`q=${encodeURIComponent(event.title)}`);
    const found = reply.json.items!.find((i) => i.id === event.id)!;
    assert.equal(found.startingPrice, '333.33');
  });

  it('does not count held or booked seats as available', async () => {
    const { seedEvent } = await seedCatalog();
    const event = await seedEvent({ title: `Availability Check ${randomUUID()}`, startsAt: '2031-08-03T18:00:00.000Z' });

    const seats = await query<{ id: string }>('SELECT id FROM show_seats WHERE event_id = $1', [event.id]);
    await query("UPDATE show_seats SET status = 'held' WHERE id = $1", [seats.rows[0]!.id]);

    const reply = await list(`q=${encodeURIComponent(event.title)}`);
    const found = reply.json.items!.find((i) => i.id === event.id)!;
    assert.equal(found.availableSeats, 1, 'the held seat is excluded');
  });
});
