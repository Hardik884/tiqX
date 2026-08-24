import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace, uniqueClientIp } from './helpers/redis.js';
import { cleanupSeedData } from './helpers/seed.js';

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

interface Reply {
  status: number;
  json: { items?: unknown[]; error?: { code: string; message: string } };
}

/**
 * A fresh IP per call: this suite fires far more requests than the search
 * rate limit allows per window, and it is testing injection resistance, not
 * the limiter (that has its own suite) - sharing one bucket would fail these
 * tests on 429 instead of exercising the validation path at all.
 */
async function list(qs: string): Promise<Reply> {
  const response = await fetch(`${baseUrl}/api/v1/events?${qs}`, {
    headers: { 'x-forwarded-for': uniqueClientIp() },
  });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

async function eventsTableIntact(): Promise<boolean> {
  const result = await query<{ to_regclass: string | null }>("SELECT to_regclass('public.events')::text");
  return result.rows[0]!.to_regclass !== null;
}

const MALICIOUS_STRINGS = [
  `'`,
  `"`,
  `;`,
  `--`,
  `' OR 1=1 --`,
  `' OR '1'='1`,
  `1 DESC`,
  `starts_at; DROP TABLE events;`,
  `'; DROP TABLE events; --`,
  `\\'; DROP TABLE events; --`,
  `<script>alert(1)</script>`,
  `%00`,
];

describe('oversized input', () => {
  it('rejects an absurdly long q and city with a clean 400, not a 500 or a slow query', async () => {
    const huge = 'a'.repeat(5000);
    const qReply = await list(`q=${encodeURIComponent(huge)}`);
    assert.equal(qReply.status, 400, 'q has a documented max length');

    const cityReply = await list(`city=${encodeURIComponent(huge)}`);
    assert.equal(cityReply.status, 400, 'city has a documented max length');

    assert.ok(await eventsTableIntact());
  });
});

describe('SQL injection resistance', () => {
  it('treats every malicious value for q as a literal search term, never as SQL', async () => {
    for (const payload of MALICIOUS_STRINGS) {
      const reply = await list(`q=${encodeURIComponent(payload)}`);
      assert.equal(reply.status, 200, `q=${payload}`);
      assert.deepEqual(reply.json.items, []);
    }
    assert.ok(await eventsTableIntact(), 'events table survives every payload');
  });

  it('rejects every malicious value for category as an invalid enum, never executes it', async () => {
    for (const payload of MALICIOUS_STRINGS) {
      const reply = await list(`category=${encodeURIComponent(payload)}`);
      assert.equal(reply.status, 400, `category=${payload}`);
    }
    assert.ok(await eventsTableIntact());
  });

  it('treats every malicious value for city as a literal filter value', async () => {
    for (const payload of MALICIOUS_STRINGS) {
      const reply = await list(`city=${encodeURIComponent(payload)}`);
      assert.equal(reply.status, 200, `city=${payload}`);
      assert.deepEqual(reply.json.items, []);
    }
    assert.ok(await eventsTableIntact());
  });

  it('rejects every malicious value for venueId as an invalid uuid', async () => {
    for (const payload of MALICIOUS_STRINGS) {
      const reply = await list(`venueId=${encodeURIComponent(payload)}`);
      assert.equal(reply.status, 400, `venueId=${payload}`);
    }
    assert.ok(await eventsTableIntact());
  });

  it('rejects every malicious value for sort - it is never interpolated into ORDER BY', async () => {
    for (const payload of MALICIOUS_STRINGS) {
      const reply = await list(`sort=${encodeURIComponent(payload)}`);
      assert.equal(reply.status, 400, `sort=${payload}`);
    }
    assert.ok(await eventsTableIntact(), 'ORDER BY can never carry raw input regardless');
  });

  it('rejects non-numeric or out-of-range limit values', async () => {
    for (const payload of [...MALICIOUS_STRINGS, '-1', '0', 'Infinity', 'NaN']) {
      const reply = await list(`limit=${encodeURIComponent(payload)}`);
      assert.equal(reply.status, 400, `limit=${payload}`);
    }
  });

  it('rejects every malicious value for cursor as a stable 400, never a 500', async () => {
    for (const payload of MALICIOUS_STRINGS) {
      const reply = await list(`cursor=${encodeURIComponent(payload)}`);
      assert.equal(reply.status, 400, `cursor=${payload}`);
    }
    assert.ok(await eventsTableIntact());
  });

  it('rejects malicious values for eventType as an invalid enum', async () => {
    for (const payload of MALICIOUS_STRINGS) {
      const reply = await list(`eventType=${encodeURIComponent(payload)}`);
      assert.equal(reply.status, 400, `eventType=${payload}`);
    }
  });

  it('survives a combined payload across every field in one request', async () => {
    const reply = await list(
      `q=${encodeURIComponent("' OR 1=1 --")}&city=${encodeURIComponent('x; DROP TABLE events;')}` +
        `&venueId=${encodeURIComponent('not-a-uuid')}`,
    );
    // venueId alone is enough to make this 400 (invalid uuid) - the point is
    // that it is a clean validation error, not a 500 or a corrupted table.
    assert.equal(reply.status, 400);
    assert.ok(await eventsTableIntact());
  });

  it('never returns a raw PostgreSQL error, SQL text or stack trace for any payload', async () => {
    for (const payload of MALICIOUS_STRINGS) {
      const reply = await list(`q=${encodeURIComponent(payload)}&sort=${encodeURIComponent(payload)}`);
      const text = JSON.stringify(reply.json);
      assert.ok(!text.includes('SELECT'), `leaked SQL for payload ${payload}`);
      assert.ok(!text.toLowerCase().includes('syntax error'), `leaked a PG error for payload ${payload}`);
      assert.ok(!text.includes('at Object'), `leaked a stack frame for payload ${payload}`);
    }
  });
});

describe('idempotency-adjacent: repeated malicious requests cause no side effects', () => {
  it('never creates, modifies or deletes any row', async () => {
    const before = await query<{ count: string }>('SELECT count(*)::text AS count FROM events');

    for (let i = 0; i < 5; i += 1) {
      await list(`q=${encodeURIComponent("'; DROP TABLE events; --")}`);
    }

    const after = await query<{ count: string }>('SELECT count(*)::text AS count FROM events');
    assert.equal(after.rows[0]!.count, before.rows[0]!.count);
  });
});
