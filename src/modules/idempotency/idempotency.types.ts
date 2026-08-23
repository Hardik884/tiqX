export const IDEMPOTENCY_STATUSES = ['processing', 'completed'] as const;

export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

export interface IdempotencyRecord {
  id: string;
  requestHash: string;
  status: IdempotencyStatus;
  responseStatus: number | null;
  responseBody: unknown;
}

/** What an idempotent operation produced, and whether it actually ran. */
export interface IdempotentOutcome<T> {
  /** True when the body came from a stored response instead of fresh work. */
  replayed: boolean;
  statusCode: number;
  body: T;
}
