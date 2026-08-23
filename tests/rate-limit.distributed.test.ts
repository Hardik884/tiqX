import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { config } from '../src/config/index.js';
import { closePool } from '../src/db/pool.js';
import { getRedis } from '../src/redis/client.js';
import { identifierDigest, rateLimitKey } from '../src/redis/keys.js';
import { closeTestRedis, connectTestRedis, flushTestNamespace, uniqueClientIp } from './helpers/redis.js';

/**
 * Two real API processes, one Redis.
 *
 * This is the test that actually earns the word "distributed". Everything else
 * in the suite runs inside one process, where a counter kept in a module-level
 * Map would pass just as happily as one kept in Redis. Only separate operating
 * system processes can tell those two apart - so the servers here are spawned,
 * not imported.
 */
interface Instance {
  child: ChildProcess;
  baseUrl: string;
  /** Everything the server has written, for diagnosing a failure. */
  output: string[];
}

const instances: Instance[] = [];

/** Boots `src/server.ts` on its own port and waits for it to report listening. */
async function startInstance(port: number): Promise<Instance> {
  // Node directly with tsx as a loader, rather than through `npx`. npx inserts
  // an npm wrapper and a shell between here and the server, which means
  // child.kill() reaches the wrapper and leaves the real server orphaned, and
  // the server's output arrives second-hand. One process is both killable and
  // observable.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Kept so a later failure can say what the server actually reported, instead
  // of surfacing an opaque "fetch failed".
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  const instance: Instance = { child, baseUrl: `http://127.0.0.1:${port}`, output };
  instances.push(instance);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`instance on ${port} did not start in time:\n${output.join('')}`)),
      30_000,
    );

    const settleOnListening = (chunk: Buffer): void => {
      if (chunk.toString().includes('Server listening')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', settleOnListening);

    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`instance on ${port} exited with code ${code}:\n${output.join('')}`));
    });
  });

  return instance;
}

/** Fails loudly with the server's own output if an instance has died. */
function assertAlive(instance: Instance, label: string): void {
  assert.equal(
    instance.child.exitCode,
    null,
    `${label} exited with code ${instance.child.exitCode}:\n${instance.output.join('')}`,
  );
}

async function stopInstances(): Promise<void> {
  await Promise.all(
    instances.map(
      (instance) =>
        new Promise<void>((resolve) => {
          if (instance.child.exitCode !== null) {
            resolve();
            return;
          }
          instance.child.once('exit', () => resolve());
          instance.child.kill('SIGTERM');
          setTimeout(() => {
            instance.child.kill('SIGKILL');
            resolve();
          }, 5_000).unref();
        }),
    ),
  );
  instances.length = 0;
}

async function login(instance: Instance, email: string, ip: string): Promise<number> {
  const response = await fetch(`${instance.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password: 'wrong-password-for-limit-test' }),
  });
  return response.status;
}

let serverA: Instance;
let serverB: Instance;

before(async () => {
  await connectTestRedis();
  await flushTestNamespace();
  // Sequential boot: two tsx processes compiling at once is slow enough to
  // trip the readiness timeout on a loaded machine.
  serverA = await startInstance(4801);
  serverB = await startInstance(4802);
});

after(async () => {
  await stopInstances();
  await flushTestNamespace();
  await closeTestRedis();
  await closePool();
});

describe('rate limiting across multiple application instances', () => {
  it('starts two independent processes sharing one Redis', async () => {
    assert.notEqual(serverA.child.pid, serverB.child.pid);
    assert.ok(serverA.child.pid, 'server A has a pid');
    assert.ok(serverB.child.pid, 'server B has a pid');

    // Both are separately reachable and both report themselves ready, which
    // means each independently reached PostgreSQL and Redis.
    for (const instance of [serverA, serverB]) {
      const response = await fetch(`${instance.baseUrl}/health/ready`);
      const body = (await response.json()) as { dependencies: { database: string; redis: string } };
      assert.equal(response.status, 200);
      assert.deepEqual(body.dependencies, { database: 'up', redis: 'up' });
    }
  });

  it('shares one counter when requests alternate between the two', async () => {
    assertAlive(serverA, 'server A');
    assertAlive(serverB, 'server B');
    const email = `dist-${randomUUID()}@ratelimit.test`;
    const ip = uniqueClientIp();
    const limit = config.rateLimit.login.max;

    // Alternate A, B, A, B... If each process kept its own counter, each would
    // allow `limit` attempts and nothing would be refused until 2x the limit.
    const statuses: number[] = [];
    for (let i = 0; i < limit + 4; i += 1) {
      const target = i % 2 === 0 ? serverA : serverB;
      statuses.push(await login(target, email, ip));
    }

    const reachedHandler = statuses.filter((s) => s === 401).length;
    const limited = statuses.filter((s) => s === 429).length;

    assert.equal(
      reachedHandler,
      limit,
      `the two processes must share one budget of ${limit}, but ${reachedHandler} attempts got through`,
    );
    assert.equal(limited, 4);

    // The counter is a single Redis key, and it counted every attempt from
    // both processes.
    const counter = await getRedis().get(rateLimitKey('login', identifierDigest(email, ip)));
    assert.equal(counter, String(limit + 4));
  });

  it('refuses on the instance that never saw the earlier traffic', async () => {
    assertAlive(serverA, 'server A');
    assertAlive(serverB, 'server B');
    const email = `crossover-${randomUUID()}@ratelimit.test`;
    const ip = uniqueClientIp();
    const limit = config.rateLimit.login.max;

    // Spend the entire budget on A only.
    for (let i = 0; i < limit; i += 1) {
      assert.equal(await login(serverA, email, ip), 401);
    }

    // B has served none of those requests. Process-local state would let this
    // through; shared state refuses it.
    assert.equal(
      await login(serverB, email, ip),
      429,
      'server B must honour a budget spent entirely on server A',
    );
  });

  it('holds under concurrent traffic split across both instances', async () => {
    assertAlive(serverA, 'server A');
    assertAlive(serverB, 'server B');
    const email = `concurrent-${randomUUID()}@ratelimit.test`;
    const ip = uniqueClientIp();
    const limit = config.rateLimit.login.max;
    const ATTEMPTS = 40;

    // All in flight at once, half to each process.
    const statuses = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_unused, i) =>
        login(i % 2 === 0 ? serverA : serverB, email, ip),
      ),
    );

    const reachedHandler = statuses.filter((s) => s === 401).length;
    assert.equal(
      reachedHandler,
      limit,
      `exactly ${limit} may pass across both processes, got ${reachedHandler}`,
    );
    assert.equal(statuses.filter((s) => s === 429).length, ATTEMPTS - limit);
  });
});
