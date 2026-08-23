/** PostgreSQL SQLSTATE codes this codebase reacts to. */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
} as const;

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
}

/** Returns the SQLSTATE of a driver error, or undefined for anything else. */
export function pgErrorCode(error: unknown): string | undefined {
  const code = (error as PgErrorLike | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Returns the constraint that a driver error violated, when it reports one. */
export function pgErrorConstraint(error: unknown): string | undefined {
  const constraint = (error as PgErrorLike | null)?.constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}
