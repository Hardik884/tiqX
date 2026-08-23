import type { PoolClient } from 'pg';

import { PG_ERROR, pgErrorCode, pgErrorConstraint } from '../../db/pg-error.js';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError } from '../../errors/app-error.js';
import {
  claimIdempotencyKey,
  completeIdempotencyRecord,
  findIdempotencyRecord,
} from './idempotency.repository.js';
import type { IdempotentOutcome } from './idempotency.types.js';

export interface IdempotencyContext {
  /**
   * Scopes the key. Comes from the request body for now and becomes the
   * authenticated principal once authentication exists; either way a key is
   * only ever readable by the user it was stored for.
   */
  userId: string;
  key: string;
  requestHash: string;
  /** Status to report when the operation runs for real. */
  successStatus: number;
}

/**
 * Runs `operation` at most once per (user, key), replaying the stored response
 * on any later attempt.
 *
 * Everything happens in one transaction: the claim, the operation, and the
 * stored response commit together. That ordering is what makes a crash safe.
 * Claiming the key first and saving the result afterwards in a second
 * transaction would leave a window where the work is durable but the record is
 * not, and a retry would then repeat the work. Here there is no window - either
 * both are visible or neither is.
 *
 * Concurrent duplicates are resolved by `claimIdempotencyKey`, which blocks on
 * the unique index rather than returning early, so the second caller wakes up
 * once the first has finished and reacts to what actually happened:
 *
 *   first committed -> replay its response, run nothing
 *   first aborted   -> take the key over and run the operation
 *
 * FAILURE SEMANTICS. A failed operation leaves no record at all. The throw
 * propagates out of `withTransaction`, the ROLLBACK discards the claim along
 * with the hold, and the key is free again. So a retry after a failure is a
 * genuine new attempt rather than a replayed error, and - the invariant that
 * matters - a failure can never be stored as a success that never happened.
 *
 * The tradeoff is deliberate: a 409 is not replayed. Two honest options existed
 * and only one is safe here. Persisting the failure would mean committing the
 * record in a separate transaction from the rolled-back hold, which is exactly
 * the split this design exists to avoid. Re-evaluating is also the friendlier
 * behaviour: a seat that was taken a moment ago may since have been released,
 * and the retry should be allowed to get it.
 */
export async function runIdempotently<T>(
  context: IdempotencyContext,
  operation: (client: PoolClient) => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  return withTransaction(async (client) => {
    const claimedId = await claim(client, context);

    if (claimedId === null) {
      // Someone else owns this key and has already committed. By the time the
      // claim returned, their transaction was over, so this read sees their
      // final state.
      return replayExisting<T>(client, context);
    }

    const body = await operation(client);

    await completeIdempotencyRecord(client, claimedId, context.successStatus, body);

    return { replayed: false, statusCode: context.successStatus, body };
  });
}

/**
 * Claims the key, translating the one foreign key this table has into the
 * answer the caller expects.
 *
 * A key is stored against a user, so claiming it is the first thing that
 * touches `users` - earlier than any check the wrapped operation would make.
 * Left alone, an unknown userId would surface as a constraint violation and a
 * 500; it is really just a request naming a user that does not exist.
 */
async function claim(client: PoolClient, context: IdempotencyContext): Promise<string | null> {
  try {
    return await claimIdempotencyKey(client, context.userId, context.key, context.requestHash);
  } catch (error) {
    if (
      pgErrorCode(error) === PG_ERROR.FOREIGN_KEY_VIOLATION &&
      pgErrorConstraint(error) === 'idempotency_keys_user_id_fkey'
    ) {
      throw new NotFoundError('User not found');
    }
    throw error;
  }
}

async function replayExisting<T>(
  client: PoolClient,
  context: IdempotencyContext,
): Promise<IdempotentOutcome<T>> {
  const existing = await findIdempotencyRecord(client, context.userId, context.key);

  if (existing === null) {
    // The claim was refused but no record is visible. Nothing in this design
    // produces that, so refuse rather than guess - retrying is safe, and
    // inventing a result would not be.
    throw new ConflictError('Idempotency key is being used by another request, please retry', {
      reason: 'idempotency_key_in_flight',
    });
  }

  // The key is bound to the request it was first used for. A different
  // selection, ttl or event under the same key is a client bug, and answering
  // it with the old response would be worse than refusing it.
  if (existing.requestHash !== context.requestHash) {
    throw new ConflictError(
      'Idempotency-Key was already used for a different request',
      { reason: 'idempotency_key_reuse' },
    );
  }

  if (existing.status !== 'completed' || existing.responseStatus === null) {
    // A committed record should always be `completed`: the claim and the
    // completion share a transaction, so `processing` is only ever visible
    // inside the transaction that owns it. Reaching here means an attempt died
    // in a way this design does not produce, so say so instead of fabricating a
    // hold or creating a second one.
    throw new ConflictError('Idempotency key is being used by another request, please retry', {
      reason: 'idempotency_key_in_flight',
    });
  }

  return {
    replayed: true,
    statusCode: existing.responseStatus,
    body: existing.responseBody as T,
  };
}
