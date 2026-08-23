import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PROJECT_ROOT = process.cwd();
const CONFIG_ENTRY = path.join(PROJECT_ROOT, 'src/config/index.js');

/**
 * A directory with no .env, inside the project so module resolution still
 * finds node_modules.
 *
 * Needed because the config module loads .env from its working directory, and
 * dotenv would put back any variable the test removed from the environment -
 * so "REDIS_URL is missing" cannot be tested from the project root at all.
 */
let envFreeDir: string | undefined;

async function envFreeCwd(): Promise<string> {
  envFreeDir ??= await mkdtemp(path.join(PROJECT_ROOT, '.config-test-'));
  return envFreeDir;
}

after(async () => {
  if (envFreeDir !== undefined) {
    await rm(envFreeDir, { recursive: true, force: true });
  }
});

/**
 * Loads the config module in a fresh process with a given environment and
 * reports what happened.
 *
 * A child process is the only honest way to test fail-fast configuration: the
 * module validates once at import and calls `process.exit(1)` on a bad
 * environment, so it cannot be re-imported with different values inside a
 * running test.
 */
async function loadConfig(
  overrides: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  let removedAny = false;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
      removedAny = true;
    } else {
      env[key] = value;
    }
  }

  // Removing a variable only means anything where .env cannot restore it.
  const cwd = removedAny ? await envFreeCwd() : PROJECT_ROOT;

  try {
    const { stdout, stderr } = await run(
      'npx',
      [
        'tsx',
        '-e',
        `import(${JSON.stringify(CONFIG_ENTRY)}).then(() => console.log('CONFIG_OK'))`,
      ],
      { cwd, env },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('Redis configuration validation', () => {
  it('accepts the current environment', async () => {
    const result = await loadConfig({});
    assert.equal(result.code, 0);
    assert.match(result.stdout, /CONFIG_OK/);
  });

  it('refuses to start with REDIS_URL missing', async () => {
    // Redis is required for this deployment: the auth endpoints fail closed
    // without it, so booting without a URL would mean serving traffic that
    // cannot be protected.
    const result = await loadConfig({ REDIS_URL: undefined });

    assert.notEqual(result.code, 0, 'the process must exit non-zero');
    assert.match(result.stderr + result.stdout, /REDIS_URL/);
  });

  it('rejects a malformed Redis URL with a clear message', async () => {
    for (const bad of ['not-a-url', 'http://localhost:6379', 'localhost:6379', 'postgres://x/y']) {
      const result = await loadConfig({ REDIS_URL: bad });

      assert.notEqual(result.code, 0, `${bad} should be rejected`);
      const output = result.stderr + result.stdout;
      assert.match(output, /REDIS_URL/);
      assert.match(output, /redis:\/\/ or rediss:\/\//);
    }
  });

  it('accepts both redis:// and rediss:// schemes', async () => {
    for (const good of ['redis://127.0.0.1:6379', 'rediss://cache.example.com:6380/2']) {
      const result = await loadConfig({ REDIS_URL: good });
      assert.equal(result.code, 0, `${good} should be accepted`);
    }
  });

  it('rejects a namespace that could break key structure', async () => {
    // A namespace containing the separator would make key parsing ambiguous.
    for (const bad of ['has:colon', 'UPPER', 'has space', '']) {
      const result = await loadConfig({ REDIS_NAMESPACE: bad });
      assert.notEqual(result.code, 0, `namespace ${JSON.stringify(bad)} should be rejected`);
    }
  });

  it('never prints the Redis URL or any secret when configuration fails', async () => {
    const secretUrl = 'redis://admin:sup3r-s3cret-passw0rd@cache.internal:6379';
    // Fail on a *different* variable, so the Redis URL is present and valid
    // while the process reports an error.
    const result = await loadConfig({ REDIS_URL: secretUrl, JWT_SECRET: 'too-short' });

    assert.notEqual(result.code, 0);
    const output = result.stderr + result.stdout;

    // The validator names variables, never values.
    assert.match(output, /JWT_SECRET/);
    assert.ok(!output.includes('sup3r-s3cret-passw0rd'), 'a password must never be printed');
    assert.ok(!output.includes(secretUrl), 'the Redis URL must never be printed');
    assert.ok(!output.includes('cache.internal'), 'the Redis host must never be printed');
  });

  it('rejects nonsensical rate-limit settings', async () => {
    for (const overrides of [
      { RATE_LIMIT_LOGIN_MAX: '0' },
      { RATE_LIMIT_LOGIN_MAX: '-5' },
      { RATE_LIMIT_REGISTER_WINDOW_SECONDS: 'soon' },
    ]) {
      const result = await loadConfig(overrides);
      assert.notEqual(result.code, 0, `${JSON.stringify(overrides)} should be rejected`);
    }
  });

  it('allows a test deployment to point at an isolated namespace', async () => {
    const result = await loadConfig({ REDIS_NAMESPACE: 'tiqx-isolated' });
    assert.equal(result.code, 0);
  });
});

describe('server startup when Redis is unreachable', () => {
  /** Boots the real server and returns how it went, without leaving it running. */
  async function bootServer(
    overrides: Record<string, string>,
  ): Promise<{ code: number; output: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...overrides, PORT: '4899' };

    try {
      const { stdout, stderr } = await run(
        process.execPath,
        ['--import', 'tsx', 'src/server.ts'],
        { cwd: PROJECT_ROOT, env, timeout: 45_000 },
      );
      return { code: 0, output: stdout + stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, output: (failure.stdout ?? '') + (failure.stderr ?? '') };
    }
  }

  it('refuses to start, rather than running without rate-limit protection', async () => {
    // A valid URL pointing at nothing. Configuration passes; the connection
    // does not - which is the "required but temporarily unavailable" case, and
    // it must stop startup rather than yield an instance that 503s every login.
    const result = await bootServer({ REDIS_URL: 'redis://127.0.0.1:6399' });

    assert.notEqual(result.code, 0, 'startup must fail');
    assert.match(result.output, /Unable to reach Redis, aborting startup/);
  });

  it('never prints the Redis password while failing to connect', async () => {
    const password = 'tOp-s3cret-cache-passw0rd';
    const result = await bootServer({ REDIS_URL: `redis://default:${password}@127.0.0.1:6399` });

    assert.notEqual(result.code, 0);
    assert.ok(
      !result.output.includes(password),
      'a Redis password must never reach stdout or stderr',
    );
    assert.ok(!result.output.includes('default:'), 'no credential portion of the URL is printed');
  });
});
