import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { cleanupAuthedUsers } from './helpers/auth.js';

let server: Server;
let baseUrl: string;

const PASSWORD = 'a-very-recognisable-password-9f3ac1';

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await query("DELETE FROM users WHERE email LIKE '%@logtest.test'");
  await cleanupAuthedUsers();
  await closePool();
});

/**
 * Captures everything written to stdout and stderr while `fn` runs.
 *
 * The logger writes JSON lines straight to the streams, so intercepting the
 * streams catches whatever would reach a real log aggregator - including
 * anything a future change starts logging by accident.
 */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);

  const intercept =
    (original: typeof originalOut) =>
    (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    };

  process.stdout.write = intercept(originalOut) as typeof process.stdout.write;
  process.stderr.write = intercept(originalErr) as typeof process.stderr.write;

  try {
    await fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }

  return chunks.join('');
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, string>) : {} };
}

describe('credentials never reach the logs', () => {
  it('logs nothing sensitive across register, login, refresh, logout and failures', async () => {
    const email = `logging-${randomUUID()}@logtest.test`;
    let accessToken = '';
    let refreshToken = '';
    let passwordHash = '';

    const output = await captureLogs(async () => {
      await post('/auth/register', { email, password: PASSWORD });

      const login = await post('/auth/login', { email, password: PASSWORD });
      accessToken = login.json.accessToken!;
      refreshToken = login.json.refreshToken!;

      // Failure paths log the most, so exercise them too.
      await post('/auth/login', { email, password: 'the-wrong-password-entirely' });
      await post('/auth/login', { email: `absent-${randomUUID()}@logtest.test`, password: PASSWORD });
      await post('/auth/refresh', { refreshToken: 'not-a-real-token' });
      await post('/auth/register', { email, password: PASSWORD }); // duplicate -> 409

      const rotated = await post('/auth/refresh', { refreshToken });
      await post('/auth/logout', { refreshToken: rotated.json.refreshToken! });

      // An authenticated request, so the Authorization header is in play.
      await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    });

    const stored = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = $1',
      [email],
    );
    passwordHash = stored.rows[0]!.password_hash;

    const forbidden: [string, string][] = [
      ['plaintext password', PASSWORD],
      ['password hash', passwordHash],
      ['access token', accessToken],
      ['refresh token', refreshToken],
      ['argon2 digest prefix', '$argon2id$'],
      ['authorization header value', `Bearer ${accessToken}`],
    ];

    for (const [what, secret] of forbidden) {
      assert.ok(secret.length > 0, `${what} should have been captured by the test`);
      assert.ok(!output.includes(secret), `${what} must never appear in logs`);
    }

    // The request id is logged, and is what correlation should rely on instead.
    if (output.length > 0) {
      assert.match(output, /"requestId":"[0-9a-f-]{36}"/);
    }
  });

  it('logs a failed login without recording which check failed', async () => {
    const email = `oracle-${randomUUID()}@logtest.test`;
    await post('/auth/register', { email, password: PASSWORD });

    const wrongPassword = await captureLogs(async () => {
      await post('/auth/login', { email, password: 'wrong-password-value' });
    });
    const unknownEmail = await captureLogs(async () => {
      await post('/auth/login', { email: `nobody-${randomUUID()}@logtest.test`, password: PASSWORD });
    });

    // Strip the varying parts; what remains must be identical, so the logs are
    // not an account-enumeration oracle either.
    const normalize = (line: string): string =>
      line
        .replace(/"timestamp":"[^"]+"/g, '"timestamp":"T"')
        .replace(/"requestId":"[^"]+"/g, '"requestId":"R"');

    assert.equal(normalize(wrongPassword), normalize(unknownEmail));
  });
});
