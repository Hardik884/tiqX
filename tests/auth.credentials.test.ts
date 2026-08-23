import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { cleanupAuthedUsers } from './helpers/auth.js';
import { closeTestRedis, connectTestRedis, uniqueClientIp } from './helpers/redis.js';

let server: Server;
let baseUrl: string;

const PASSWORD = 'a-sufficiently-long-password';

before(async () => {
  await connectTestRedis();
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await query("DELETE FROM users WHERE email LIKE '%@authtest.test'");
  await cleanupAuthedUsers();
  await closeTestRedis();
  await closePool();
});

interface AuthResponse {
  user?: { id: string; email: string; name: string; role: string; createdAt: string };
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  error?: { code: string; message: string; details?: unknown };
  [key: string]: unknown;
}

/**
 * Each call presents a distinct client address, so these tests never share a
 * rate-limit bucket with each other. See tests/helpers/redis.ts.
 */
async function post(path: string, body: unknown): Promise<{ status: number; json: AuthResponse }> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': uniqueClientIp() },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as AuthResponse) : {} };
}

function freshEmail(): string {
  return `user-${randomUUID()}@authtest.test`;
}

describe('POST /api/v1/auth/register', () => {
  it('creates an account and returns the public user only', async () => {
    const email = freshEmail();
    const { status, json } = await post('/auth/register', { email, password: PASSWORD });

    assert.equal(status, 201);
    assert.equal(json.user?.email, email);
    assert.equal(json.user?.role, 'customer');
    assert.ok(json.user?.id);

    // Nothing credential-shaped anywhere in the response.
    const serialized = JSON.stringify(json);
    assert.ok(!serialized.includes(PASSWORD), 'plaintext password must not be returned');
    assert.ok(!/password_?[Hh]ash/.test(serialized), 'password hash must not be returned');
    assert.ok(!serialized.includes('argon2'), 'no digest material in the response');
  });

  it('stores an Argon2id digest and never the plaintext', async () => {
    const email = freshEmail();
    await post('/auth/register', { email, password: PASSWORD });

    const stored = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = $1',
      [email],
    );
    const digest = stored.rows[0]!.password_hash;

    assert.ok(digest.startsWith('$argon2id$'), `expected argon2id digest, got ${digest.slice(0, 12)}`);
    assert.ok(!digest.includes(PASSWORD));

    // And the plaintext appears nowhere in the row at all.
    const wholeRow = await query<{ row: string }>(
      'SELECT users::text AS row FROM users WHERE email = $1',
      [email],
    );
    assert.ok(!wholeRow.rows[0]!.row.includes(PASSWORD));
  });

  it('salts: the same password yields different digests', async () => {
    const first = freshEmail();
    const second = freshEmail();
    await post('/auth/register', { email: first, password: PASSWORD });
    await post('/auth/register', { email: second, password: PASSWORD });

    const digests = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = ANY($1::text[])',
      [[first, second]],
    );
    assert.equal(digests.rowCount, 2);
    assert.notEqual(digests.rows[0]!.password_hash, digests.rows[1]!.password_hash);
  });

  it('rejects a duplicate email, case-insensitively', async () => {
    const email = freshEmail();
    assert.equal((await post('/auth/register', { email, password: PASSWORD })).status, 201);

    const same = await post('/auth/register', { email, password: PASSWORD });
    assert.equal(same.status, 409);
    assert.equal(same.json.error?.code, 'CONFLICT');

    // Differing only by case is the same account, per users_email_lower_key.
    const upper = await post('/auth/register', { email: email.toUpperCase(), password: PASSWORD });
    assert.equal(upper.status, 409);
  });

  it('normalizes email to lower case on the way in', async () => {
    const email = freshEmail();
    const mixed = email.replace('user-', 'User-').toUpperCase();

    const { status, json } = await post('/auth/register', { email: mixed, password: PASSWORD });
    assert.equal(status, 201);
    assert.equal(json.user?.email, mixed.toLowerCase());

    const stored = await query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
      json.user!.id,
    ]);
    assert.equal(stored.rows[0]!.email, mixed.toLowerCase());
  });

  it('refuses a client-supplied role instead of honouring it', async () => {
    const email = freshEmail();
    const { status } = await post('/auth/register', {
      email,
      password: PASSWORD,
      role: 'admin',
    });

    // Strict schema: the attempt is rejected outright rather than ignored.
    assert.equal(status, 400);

    const rows = await query('SELECT id FROM users WHERE email = $1', [email]);
    assert.equal(rows.rowCount, 0, 'no account should have been created');
  });

  it('enforces the password policy and email shape', async () => {
    for (const body of [
      { email: freshEmail(), password: 'short' },
      { email: 'not-an-email', password: PASSWORD },
      { email: freshEmail(), password: 'x'.repeat(201) },
      { email: freshEmail() },
    ]) {
      const { status } = await post('/auth/register', body);
      assert.equal(status, 400, `should reject ${JSON.stringify(Object.keys(body))}`);
    }
  });
});

describe('POST /api/v1/auth/login', () => {
  async function registeredUser(): Promise<string> {
    const email = freshEmail();
    await post('/auth/register', { email, password: PASSWORD });
    return email;
  }

  it('returns a token pair for valid credentials', async () => {
    const email = await registeredUser();

    const { status, json } = await post('/auth/login', { email, password: PASSWORD });

    assert.equal(status, 200);
    assert.equal(json.tokenType, 'Bearer');
    assert.ok(json.accessToken);
    assert.ok(json.refreshToken);
    assert.equal(typeof json.expiresIn, 'number');
    assert.ok(json.expiresIn! <= 3600, 'access tokens must be short lived');
    assert.ok(!JSON.stringify(json).includes(PASSWORD));
  });

  it('accepts a differently cased email', async () => {
    const email = await registeredUser();
    const { status } = await post('/auth/login', { email: email.toUpperCase(), password: PASSWORD });
    assert.equal(status, 200);
  });

  it('gives the same generic failure for a wrong password and an unknown email', async () => {
    const email = await registeredUser();

    const wrongPassword = await post('/auth/login', { email, password: 'wrong-password-here' });
    const unknownEmail = await post('/auth/login', {
      email: freshEmail(),
      password: PASSWORD,
    });

    for (const attempt of [wrongPassword, unknownEmail]) {
      assert.equal(attempt.status, 401);
      assert.equal(attempt.json.error?.code, 'INVALID_CREDENTIALS');
      assert.equal(attempt.json.error?.message, 'Invalid credentials');
      assert.equal(attempt.json.error?.details, undefined);
    }

    // Byte-identical: nothing distinguishes which of the two happened.
    assert.deepEqual(
      { ...wrongPassword.json.error, requestId: undefined },
      { ...unknownEmail.json.error, requestId: undefined },
    );
  });

  it('puts only non-sensitive claims in the access token', async () => {
    const email = await registeredUser();
    const { json } = await post('/auth/login', { email, password: PASSWORD });

    const claims = JSON.parse(
      Buffer.from(json.accessToken!.split('.')[1]!, 'base64url').toString(),
    ) as Record<string, unknown>;

    assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'role', 'sub']);
    assert.equal(claims.role, 'customer');
    assert.equal(claims.iss, 'tiqx-api');
    assert.equal(claims.aud, 'tiqx-client');
    // The things that must never be in a signed-but-readable token.
    assert.equal(claims.email, undefined);
    assert.equal(claims.password, undefined);
    assert.equal(claims.password_hash, undefined);
    assert.equal(claims.name, undefined);

    const lifetimeSeconds = (claims.exp as number) - (claims.iat as number);
    assert.ok(lifetimeSeconds <= 3600, `access token lifetime ${lifetimeSeconds}s is too long`);
  });

  it('stores no raw refresh token in the database', async () => {
    const email = await registeredUser();
    const { json } = await post('/auth/login', { email, password: PASSWORD });
    const raw = json.refreshToken!;

    const anyRaw = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM refresh_tokens WHERE token_hash = $1',
      [raw],
    );
    assert.equal(anyRaw.rows[0]!.count, '0', 'the raw token must not be stored');

    // Its digest is, though - that is how lookup works.
    const { hashRefreshToken } = await import('../src/modules/auth/token.service.js');
    const digest = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM refresh_tokens WHERE token_hash = $1',
      [hashRefreshToken(raw)],
    );
    assert.equal(digest.rows[0]!.count, '1');
  });
});
