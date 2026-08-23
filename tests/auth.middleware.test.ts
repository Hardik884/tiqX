import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { SignJWT } from 'jose';

import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { closePool, query } from '../src/db/pool.js';
import { signAccessToken } from '../src/modules/auth/token.service.js';
import { cleanupAuthedUsers, seedAuthedUser } from './helpers/auth.js';
import { cleanupSeedData, seedVenue } from './helpers/seed.js';

let server: Server;
let baseUrl: string;

const key = new TextEncoder().encode(config.auth.jwtSecret);

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
  await cleanupAuthedUsers();
  await closePool();
});

interface Json {
  user?: { id: string; role: string };
  error?: { code: string; message: string };
  event?: { id: string };
}

async function get(path: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  json: Json;
}> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, { headers });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Json) : {} };
}

/** Signs a token with the real key but arbitrary claims, for negative cases. */
async function forgeToken(claims: Record<string, unknown>, overrides: {
  issuer?: string;
  audience?: string;
  expiresIn?: string;
} = {}): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(overrides.issuer ?? config.auth.jwtIssuer)
    .setAudience(overrides.audience ?? config.auth.jwtAudience)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '15m')
    .sign(key);
}

describe('authentication middleware', () => {
  it('attaches the principal to an authenticated request', async () => {
    const user = await seedAuthedUser('customer');

    const { status, json } = await get('/auth/me', user.authHeader);

    assert.equal(status, 200);
    assert.deepEqual(json.user, { id: user.id, role: 'customer' });
  });

  it('rejects a request with no Authorization header', async () => {
    const { status, json } = await get('/auth/me');
    assert.equal(status, 401);
    assert.equal(json.error?.code, 'UNAUTHORIZED');
  });

  it('rejects malformed Authorization headers', async () => {
    const user = await seedAuthedUser();

    const malformed = [
      user.token, // no scheme
      `Basic ${user.token}`, // wrong scheme
      'Bearer', // no token
      'Bearer ', // empty token
      'bearer ' + user.token, // wrong case: the scheme is case-sensitive here
      'Bearer not.a.jwt',
      'Bearer ' + user.token + '.extra',
    ];

    for (const authorization of malformed) {
      const { status } = await get('/auth/me', { authorization });
      assert.equal(status, 401, `should reject ${JSON.stringify(authorization.slice(0, 24))}`);
    }
  });

  it('rejects a token whose payload was edited without re-signing', async () => {
    const victim = await seedAuthedUser('customer');
    const target = await seedAuthedUser('admin');

    const [header, , signature] = victim.token.split('.');

    // Swap in a different subject and a higher role, keep the old signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({
        sub: target.id,
        role: 'admin',
        iss: config.auth.jwtIssuer,
        aud: config.auth.jwtAudience,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString('base64url');

    const { status } = await get('/auth/me', {
      authorization: `Bearer ${header}.${forgedPayload}.${signature}`,
    });
    assert.equal(status, 401, 'an edited payload must not authenticate');
  });

  it('rejects an alg=none token', async () => {
    const user = await seedAuthedUser();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: user.id, role: 'admin', iss: config.auth.jwtIssuer, aud: config.auth.jwtAudience }),
    ).toString('base64url');

    const { status } = await get('/auth/me', { authorization: `Bearer ${header}.${payload}.` });
    assert.equal(status, 401);
  });

  it('rejects a token signed with the wrong key', async () => {
    const user = await seedAuthedUser();
    const wrongKey = new TextEncoder().encode('an-entirely-different-secret-value-32ch');

    const token = await new SignJWT({ role: user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(config.auth.jwtIssuer)
      .setAudience(config.auth.jwtAudience)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(wrongKey);

    const { status } = await get('/auth/me', { authorization: `Bearer ${token}` });
    assert.equal(status, 401);
  });

  it('rejects an expired token', async () => {
    const user = await seedAuthedUser();
    const expired = await forgeToken({ sub: user.id, role: user.role }, { expiresIn: '-1s' });

    const { status } = await get('/auth/me', { authorization: `Bearer ${expired}` });
    assert.equal(status, 401);
  });

  it('rejects a token with the wrong issuer or audience', async () => {
    const user = await seedAuthedUser();

    const wrongIssuer = await forgeToken({ sub: user.id, role: user.role }, { issuer: 'someone-else' });
    const wrongAudience = await forgeToken({ sub: user.id, role: user.role }, { audience: 'another-app' });

    assert.equal((await get('/auth/me', { authorization: `Bearer ${wrongIssuer}` })).status, 401);
    assert.equal((await get('/auth/me', { authorization: `Bearer ${wrongAudience}` })).status, 401);
  });

  it('rejects a validly signed token whose user no longer exists', async () => {
    const user = await seedAuthedUser();
    const token = user.token;

    await query('DELETE FROM users WHERE id = $1', [user.id]);

    // The token is still signed, unexpired and well formed. It stops working
    // because the middleware re-reads the user rather than trusting the claim.
    const { status } = await get('/auth/me', { authorization: `Bearer ${token}` });
    assert.equal(status, 401);
  });

  it('uses the current database role, not the role baked into the token', async () => {
    const user = await seedAuthedUser('customer');
    // A token minted while they were an admin...
    const staleToken = (await signAccessToken({ id: user.id, role: 'admin' })).token;

    const { status, json } = await get('/auth/me', { authorization: `Bearer ${staleToken}` });

    assert.equal(status, 200);
    assert.equal(json.user?.role, 'customer', 'the database is the authority on role');
  });
});

describe('authorization middleware', () => {
  async function postEvent(token: string | null, venueId: string): Promise<number> {
    const response = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        venueId,
        title: `Authz ${randomUUID()}`,
        eventType: 'concert',
        startsAt: '2030-05-01T18:00:00.000Z',
        endsAt: '2030-05-01T20:00:00.000Z',
      }),
    });
    return response.status;
  }

  it('refuses an unauthenticated caller with 401, before any role check', async () => {
    const { venueId } = await seedVenue(2);
    assert.equal(await postEvent(null, venueId), 401);
  });

  it('refuses a customer with 403', async () => {
    const { venueId } = await seedVenue(2);
    const customer = await seedAuthedUser('customer');

    const status = await postEvent(customer.token, venueId);
    assert.equal(status, 403, 'authenticated but not permitted');
  });

  it('allows an organiser', async () => {
    const { venueId } = await seedVenue(2);
    const organiser = await seedAuthedUser('organiser');

    assert.equal(await postEvent(organiser.token, venueId), 201);
  });

  it('allows an admin', async () => {
    const { venueId } = await seedVenue(2);
    const admin = await seedAuthedUser('admin');

    assert.equal(await postEvent(admin.token, venueId), 201);
  });

  it('says what is required without echoing the caller\'s own role', async () => {
    const { venueId } = await seedVenue(2);
    const customer = await seedAuthedUser('customer');

    const response = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${customer.token}` },
      body: JSON.stringify({
        venueId,
        title: 'Nope',
        eventType: 'concert',
        startsAt: '2030-05-01T18:00:00.000Z',
        endsAt: '2030-05-01T20:00:00.000Z',
      }),
    });
    const json = (await response.json()) as Json;

    assert.equal(json.error?.code, 'FORBIDDEN');
    assert.match(json.error!.message, /organiser/);
  });
});
