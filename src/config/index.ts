import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

/**
 * Values that must never be accepted as a signing key. These are the strings a
 * deployment inherits by copying .env.example and forgetting to change it.
 */
const UNSAFE_JWT_SECRETS = new Set([
  'change-me',
  'changeme',
  'secret',
  'development-secret-change-me-in-production',
  'replace-this-with-a-long-random-value-min-32-chars',
]);

/**
 * Accepts only URLs a Redis client can actually dial, so a typo fails at boot
 * with a clear message instead of as a connection error minutes later.
 */
function isRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'redis:' || url.protocol === 'rediss:';
  } catch {
    return false;
  }
}

/** Env vars arrive as strings; accept the usual truthy spellings. */
const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(4000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ORIGIN: z.string().min(1).default('*'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: booleanFromEnv.default(false),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------
  // No default, and a length floor: a signing key is the one secret whose
  // absence must stop the process rather than fall back to something guessable.
  // 32 characters is the practical minimum for HS256; the sample values shipped
  // in .env.example are rejected outright so a deployment cannot inherit one.
  JWT_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters')
    .refine((value) => !UNSAFE_JWT_SECRETS.has(value.trim().toLowerCase()), {
      message: 'must not be a placeholder or example value',
    }),
  JWT_ISSUER: z.string().min(1).default('tiqx-api'),
  JWT_AUDIENCE: z.string().min(1).default('tiqx-client'),
  // Short by design: an access token cannot be revoked, so its lifetime is the
  // window an attacker gets. Capped at an hour to keep that window small.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  // Long-lived but revocable, because every one is backed by a database row.
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3_600)
    .max(60 * 60 * 24 * 90)
    .default(60 * 60 * 24 * 30),

  // ---------------------------------------------------------------------------
  // Redis
  // ---------------------------------------------------------------------------
  // Required, like JWT_SECRET: Redis is a hard dependency of this deployment,
  // and the rate limiter fails closed without it. Starting without a URL would
  // mean starting an API that cannot protect its own auth endpoints.
  REDIS_URL: z
    .string()
    .min(1)
    .refine((value) => isRedisUrl(value), {
      message: 'must be a redis:// or rediss:// URL',
    }),
  // Prefixes every key. Distinct values give two deployments - or two test runs
  // - an isolated keyspace on one Redis server.
  REDIS_NAMESPACE: z.string().min(1).max(32).regex(/^[a-z0-9-]+$/, 'must be lower-case alphanumeric').default('tiqx'),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------
  // Trust X-Forwarded-For when resolving the client IP.
  //
  // Off by default, and only ever safe behind a proxy that overwrites the
  // header. Enabled where it should not be, any client can spoof its own IP and
  // walk straight past an IP-keyed limit. Behind a load balancer the opposite
  // is true: without it every request looks like it came from the balancer and
  // all callers share one bucket.
  TRUST_PROXY: booleanFromEnv.default(false),

  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_REGISTER_WINDOW_SECONDS: z.coerce.number().int().positive().default(3_600),
  RATE_LIMIT_REFRESH_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_REFRESH_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),

  // ---------------------------------------------------------------------------
  // Hold expiration worker
  // ---------------------------------------------------------------------------
  // Publishing the Redis signal for newly created holds.
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(100),
  // Backoff base for a failed publish: delay is base * 2^(attempts-1), capped.
  OUTBOX_RETRY_BASE_MS: z.coerce.number().int().min(100).default(1_000),
  OUTBOX_RETRY_MAX_MS: z.coerce.number().int().min(1_000).default(60_000),

  // Sweeping holds whose time is up. This is the authoritative path: it reads
  // PostgreSQL, not Redis.
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
  EXPIRY_SWEEP_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(100),

  // Restoring Redis keys that were lost after their outbox row was processed.
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(100).default(30_000),
  RECONCILE_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(200),
  // How far ahead to look for active holds needing a key.
  RECONCILE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Fail fast and loudly: the process cannot do anything useful without config.
  // Only variable names are printed, never their values.
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  corsOrigin: env.CORS_ORIGIN,
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  database: {
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    poolMax: env.DATABASE_POOL_MAX,
    idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS,
    connectionTimeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
  },
  trustProxy: env.TRUST_PROXY,
  redis: {
    url: env.REDIS_URL,
    namespace: env.REDIS_NAMESPACE,
    connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
  },
  rateLimit: {
    login: {
      name: 'login',
      max: env.RATE_LIMIT_LOGIN_MAX,
      windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW_SECONDS,
    },
    register: {
      name: 'register',
      max: env.RATE_LIMIT_REGISTER_MAX,
      windowSeconds: env.RATE_LIMIT_REGISTER_WINDOW_SECONDS,
    },
    refresh: {
      name: 'refresh',
      max: env.RATE_LIMIT_REFRESH_MAX,
      windowSeconds: env.RATE_LIMIT_REFRESH_WINDOW_SECONDS,
    },
  },
  expiration: {
    outboxPollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    outboxBatchSize: env.OUTBOX_BATCH_SIZE,
    outboxRetryBaseMs: env.OUTBOX_RETRY_BASE_MS,
    outboxRetryMaxMs: env.OUTBOX_RETRY_MAX_MS,
    sweepIntervalMs: env.EXPIRY_SWEEP_INTERVAL_MS,
    sweepBatchSize: env.EXPIRY_SWEEP_BATCH_SIZE,
    reconcileIntervalMs: env.RECONCILE_INTERVAL_MS,
    reconcileBatchSize: env.RECONCILE_BATCH_SIZE,
    reconcileWindowSeconds: env.RECONCILE_WINDOW_SECONDS,
  },
  auth: {
    jwtSecret: env.JWT_SECRET,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
  },
} as const;

export type Config = typeof config;
