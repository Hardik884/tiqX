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
  auth: {
    jwtSecret: env.JWT_SECRET,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
  },
} as const;

export type Config = typeof config;
