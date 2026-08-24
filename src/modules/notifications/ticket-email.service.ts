import { config } from '../../config/index.js';
import { withTransaction } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { getEmailProvider } from './email.provider.js';
import type { EmailProvider } from './email.provider.js';
import {
  claimPendingTicketEmails,
  countPendingTicketEmails,
  findTicketEmailContext,
  markTicketEmailProcessed,
  recordTicketEmailFailure,
} from './ticket-email.repository.js';
import type { SendPendingTicketEmailsResult } from './ticket-email.types.js';

export { countPendingTicketEmails };

/**
 * Sends pending ticket emails, claiming a batch from the outbox.
 *
 * Mirrors `publishPendingExpirations` in the expiration module exactly: the
 * claim, the provider call and the bookkeeping share one transaction, so the
 * row stays locked for the whole attempt and no second worker can duplicate
 * the send in flight. That does hold a PostgreSQL transaction open across a
 * network call - normally worth avoiding, accepted here for the same reason
 * it is accepted there: the alternative (commit a claim, send, commit again)
 * widens the window in which a crash loses track of the row, and `fetch` is
 * not configured to hang indefinitely.
 *
 * `provider` defaults to whatever `EMAIL_PROVIDER` configures. Tests pass
 * their own `MockEmailProvider` instance instead, so an assertion reads a
 * private, per-test log rather than a process-wide singleton.
 *
 * DELIVERY IS AT-LEAST-ONCE. A worker can send the email and die before
 * recording that it did, after which the row is claimed again and the email
 * sent twice. That is a real, accepted property of this design - the same
 * one `publishPendingExpirations` already has for Redis - and is judged
 * acceptable because a duplicate ticket email is a minor inconvenience, not
 * a correctness failure: nothing about a booking's or a ticket's state
 * depends on how many times its email was sent.
 */
export async function sendPendingTicketEmails(
  provider: EmailProvider = getEmailProvider(),
): Promise<SendPendingTicketEmailsResult> {
  return withTransaction(async (client) => {
    const rows = await claimPendingTicketEmails(client, config.notifications.outboxBatchSize);
    const result: SendPendingTicketEmailsResult = { claimed: rows.length, sent: 0, failed: 0 };

    for (const row of rows) {
      try {
        const context = await findTicketEmailContext(client, row.bookingId);

        if (context === null) {
          // Unreachable while tickets.booking_id and booking_seats.show_seat_id
          // are both ON DELETE RESTRICT: nothing can remove the rows this join
          // needs out from under a booking that still exists. Marked processed
          // rather than retried forever, on the same "refuse rather than spin"
          // reasoning the rest of this codebase applies to should-be-impossible
          // states.
          logger.error('Ticket email outbox row has no ticket context, giving up on it', {
            outboxId: row.id,
            bookingId: row.bookingId,
          });
          await markTicketEmailProcessed(client, row.id);
          continue;
        }

        await provider.sendTicketEmail({
          to: context.to,
          bookingReference: context.bookingReference,
          eventTitle: context.eventTitle,
          venueName: context.venueName,
          startsAt: context.startsAt,
          tickets: context.tickets.map((ticket) => ({
            ticketReference: ticket.ticketReference,
            seatLabel: ticket.seatLabel,
            qrPayload: JSON.stringify(ticket.qrPayload),
          })),
        });

        await markTicketEmailProcessed(client, row.id);
        result.sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // The row is not marked processed, so it will be retried. Only the
        // provider's error message is recorded - never the Resend API key,
        // which this function never even holds (see email.provider.ts).
        await recordTicketEmailFailure(
          client,
          row.id,
          message,
          config.notifications.outboxRetryBaseMs,
          config.notifications.outboxRetryMaxMs,
        );
        result.failed += 1;

        logger.warn('Failed to send ticket email, will retry', {
          outboxId: row.id,
          bookingId: row.bookingId,
          attempts: row.attempts + 1,
          error: message,
        });
      }
    }

    if (result.sent > 0 || result.failed > 0) {
      logger.info('Processed ticket email outbox', { sent: result.sent, failed: result.failed });
    }

    return result;
  });
}
