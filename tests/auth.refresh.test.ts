import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/db/pool.js';
import { hashRefreshToken } from '../src/modules/auth/token.service.js';
import { cleanupAuthedUsers } from './helpers/auth.js';

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
  await query("DELETE FROM users WHERE email LIKE '%@authtest.test'");
  await cleanupAuthedUsers();
  await closePool();
});

interface TokenJson {
  accessToken?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  error?: { code: string; message: string };
}

async function post(path: string, body: unknown): Promise<{ status: number; json: TokenJson }> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as TokenJson) : {} };
}

/** Registers and logs in, returning a live token pair. */
async function freshSession(): Promise<{ email: string; tokens: TokenJson }> {
  const email = `refresh-${randomUUID()}@authtest.test`;
  const password = 'a-sufficiently-long-password';
  await post('/auth/register', { email, password });
  const { json } = await post('/auth/login', { email, password });
  return { email, tokens: json };
}

async function tokenRow(raw: string): Promise<{
  id: string;
  revoked_at: Date | null;
  rotated_from: string | null;
} | null> {
  const result = await query<{ id: string; revoked_at: Date | null; rotated_from: string | null }>(
    'SELECT id, revoked_at, rotated_from FROM refresh_tokens WHERE token_hash = $1',
    [hashRefreshToken(raw)],
  );
  return result.rows[0] ?? null;
}

describe('POST /api/v1/auth/refresh', () => {
  it('rotates: issues a new pair and revokes the presented token', async () => {
    const { tokens } = await freshSession();
    const oldRefresh = tokens.refreshToken!;

    const { status, json } = await post('/auth/refresh', { refreshToken: oldRefresh });

    assert.equal(status, 200);
    assert.ok(json.accessToken);
    assert.ok(json.refreshToken);
    assert.notEqual(json.refreshToken, oldRefresh, 'a new refresh token must be issued');

    const oldRow = await tokenRow(oldRefresh);
    const newRow = await tokenRow(json.refreshToken!);

    assert.ok(oldRow?.revoked_at instanceof Date, 'the old token must be revoked');
    assert.equal(newRow?.revoked_at, null, 'the new token must be live');
    assert.equal(newRow?.rotated_from, oldRow?.id, 'the chain records what it replaced');
  });

  it('refuses to use the same refresh token twice', async () => {
    const { tokens } = await freshSession();
    const oldRefresh = tokens.refreshToken!;

    const first = await post('/auth/refresh', { refreshToken: oldRefresh });
    assert.equal(first.status, 200);

    const replay = await post('/auth/refresh', { refreshToken: oldRefresh });
    assert.equal(replay.status, 401);
    assert.equal(replay.json.error?.code, 'REFRESH_TOKEN_REUSED');
  });

  it('revokes the whole session when a used token is replayed', async () => {
    const { tokens } = await freshSession();
    const first = await post('/auth/refresh', { refreshToken: tokens.refreshToken! });
    const liveToken = first.json.refreshToken!;

    // Replaying the consumed token is treated as a possible leak.
    await post('/auth/refresh', { refreshToken: tokens.refreshToken! });

    // The successor is collateral damage, deliberately: the session is over.
    const replayAfter = await post('/auth/refresh', { refreshToken: liveToken });
    assert.equal(replayAfter.status, 401);

    const row = await tokenRow(liveToken);
    assert.ok(row?.revoked_at instanceof Date, 'every live token for the user is revoked');
  });

  it('rejects an unknown refresh token', async () => {
    const { status, json } = await post('/auth/refresh', { refreshToken: randomUUID() });
    assert.equal(status, 401);
    assert.equal(json.error?.code, 'INVALID_CREDENTIALS');
  });

  it('rejects an expired refresh token', async () => {
    const { tokens } = await freshSession();
    const raw = tokens.refreshToken!;

    await query(
      "UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
      [hashRefreshToken(raw)],
    );

    const { status, json } = await post('/auth/refresh', { refreshToken: raw });
    assert.equal(status, 401);
    assert.equal(json.error?.code, 'INVALID_CREDENTIALS');
  });

  it('lets exactly one of two simultaneous refreshes of the same token win', async () => {
    const { tokens } = await freshSession();
    const raw = tokens.refreshToken!;

    // Genuinely concurrent: the FOR UPDATE lock is what has to serialise these.
    const [a, b] = await Promise.all([
      post('/auth/refresh', { refreshToken: raw }),
      post('/auth/refresh', { refreshToken: raw }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 401], 'one rotation succeeds, one is refused');

    // Exactly one successor exists; no two live tokens were minted from one.
    const row = await tokenRow(raw);
    const successors = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM refresh_tokens WHERE rotated_from = $1',
      [row!.id],
    );
    assert.equal(successors.rows[0]!.count, '1', 'a token yields at most one successor');
  });

  it('rolls back entirely if the rotation cannot complete', async () => {
    const { tokens } = await freshSession();
    const raw = tokens.refreshToken!;

    // Fault injection: make the replacement INSERT fail.
    await query(
      'ALTER TABLE refresh_tokens ADD CONSTRAINT tmp_force_failure CHECK (false) NOT VALID',
    );

    try {
      const { status } = await post('/auth/refresh', { refreshToken: raw });
      assert.equal(status, 500);

      // The old token must still be usable: a failed rotation must not leave
      // the caller with nothing.
      const row = await tokenRow(raw);
      assert.equal(row?.revoked_at, null, 'the revoke rolled back with the insert');
    } finally {
      await query('ALTER TABLE refresh_tokens DROP CONSTRAINT tmp_force_failure');
    }

    const retry = await post('/auth/refresh', { refreshToken: raw });
    assert.equal(retry.status, 200, 'the original token still works after the rollback');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the presented refresh token', async () => {
    const { tokens } = await freshSession();
    const raw = tokens.refreshToken!;

    const { status } = await post('/auth/logout', { refreshToken: raw });
    assert.equal(status, 204);

    const row = await tokenRow(raw);
    assert.ok(row?.revoked_at instanceof Date);
  });

  it('is safe to call repeatedly', async () => {
    const { tokens } = await freshSession();
    const raw = tokens.refreshToken!;

    const first = await post('/auth/logout', { refreshToken: raw });
    const revokedAt = (await tokenRow(raw))!.revoked_at;

    const second = await post('/auth/logout', { refreshToken: raw });
    const third = await post('/auth/logout', { refreshToken: randomUUID() });

    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
    assert.equal(third.status, 204, 'an unknown token is not an error, and reveals nothing');

    // The original revocation timestamp is preserved.
    assert.deepEqual((await tokenRow(raw))!.revoked_at, revokedAt);
  });

  it('stops the revoked token from refreshing', async () => {
    const { tokens } = await freshSession();
    const raw = tokens.refreshToken!;

    await post('/auth/logout', { refreshToken: raw });

    const { status } = await post('/auth/refresh', { refreshToken: raw });
    assert.equal(status, 401);
  });
});
