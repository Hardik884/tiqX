import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { accessTokenForUser } from './helpers/auth.js';
import { cleanupSeedData, seedConfirmedBooking, seedCustomer, seedShow } from './helpers/seed.js';

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
  json: Record<string, unknown>;
}

async function get(path: string, userId?: string | null): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (userId != null) {
    headers.authorization = `Bearer ${await accessTokenForUser(userId)}`;
  }
  const response = await fetch(`${baseUrl}/api/v1${path}`, { headers });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

describe('GET /api/v1/venues', () => {
  it('lists venues with seat counts for an organiser', async () => {
    const { organiserId, venueId } = await seedShow(3);

    const reply = await get('/venues', organiserId);

    assert.equal(reply.status, 200);
    const venues = reply.json.venues as { id: string; seatCount: number }[];
    const mine = venues.find((v) => v.id === venueId);
    assert.ok(mine);
    assert.equal(mine!.seatCount, 3);
  });

  it('refuses a customer', async () => {
    const customer = await seedCustomer();
    const reply = await get('/venues', customer);
    assert.equal(reply.status, 403);
  });

  it('refuses an anonymous caller', async () => {
    const reply = await get('/venues');
    assert.equal(reply.status, 401);
  });
});

describe('GET /api/v1/organiser/events/:eventId/summary', () => {
  it('reflects a confirmed booking in bookings/seats-sold/revenue', async () => {
    const booking = await seedConfirmedBooking(2, '100.00');

    const reply = await get(`/organiser/events/${booking.eventId}/summary`, booking.organiserId);

    assert.equal(reply.status, 200);
    assert.equal(reply.json.totalBookings, 1);
    assert.equal(reply.json.seatsSold, 2);
    assert.equal(reply.json.availableSeats, 0);
    assert.equal(reply.json.revenue, '200.00');
  });

  it('answers 404 for an organiser who does not own the event', async () => {
    const booking = await seedConfirmedBooking(1);
    const otherOrganiser = await seedCustomer();
    await query("UPDATE users SET role = 'organiser' WHERE id = $1", [otherOrganiser]);

    const reply = await get(`/organiser/events/${booking.eventId}/summary`, otherOrganiser);

    assert.equal(reply.status, 404);
  });

  it('allows an admin to read any event summary', async () => {
    const booking = await seedConfirmedBooking(1);
    const admin = await seedCustomer();
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [admin]);

    const reply = await get(`/organiser/events/${booking.eventId}/summary`, admin);

    assert.equal(reply.status, 200);
    assert.equal(reply.json.totalBookings, 1);
  });
});

describe('GET /api/v1/organiser/events/:eventId/bookings', () => {
  it('lists the event booking with customer identity and seat count', async () => {
    const booking = await seedConfirmedBooking(2, '50.00');

    const reply = await get(`/organiser/events/${booking.eventId}/bookings`, booking.organiserId);

    assert.equal(reply.status, 200);
    const bookings = reply.json.bookings as { id: string; seatCount: number; totalAmount: string }[];
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0]!.id, booking.bookingId);
    assert.equal(bookings[0]!.seatCount, 2);
    assert.equal(bookings[0]!.totalAmount, '100.00');
    assert.equal(reply.json.total, 1);
  });
});

describe('GET /api/v1/organiser/dashboard', () => {
  it("aggregates only the caller's own events by default", async () => {
    const booking = await seedConfirmedBooking(1, '75.00');
    const stranger = await seedShow(1);

    const reply = await get('/organiser/dashboard', booking.organiserId);

    assert.equal(reply.status, 200);
    assert.equal(reply.json.totalBookings, 1);
    assert.equal(reply.json.revenue, '75.00');
    void stranger;
  });
});
