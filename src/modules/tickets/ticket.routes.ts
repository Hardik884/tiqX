import { Router } from 'express';

import { config } from '../../config/index.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { requireRole } from '../../middleware/authorize.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { verifyTicketHandler } from './ticket.controller.js';

/**
 * Mounted at /api/v1/tickets.
 *
 * SECURITY DECISION: verification is a role-gated operation, not something a
 * ticket holder does to their own ticket. Anyone who has ever seen a QR code
 * or overheard a ticket reference could otherwise "verify" it - the reference
 * alone must never be an authorisation mechanism, only an identifier. This
 * project has no dedicated "gate staff" role, so `organiser` and `admin` -
 * the roles that already exist for running an event - stand in for venue
 * entry staff. Restricting further, to only the organiser of the specific
 * event a ticket belongs to, is deferred: see the final report.
 *
 * Rate limited per authenticated user rather than per IP - see rate-limit.ts
 * for why - with its own policy (`config.rateLimit.ticketVerify`) rather than
 * reusing login's, because the traffic shape and the abuse it defends against
 * are both different from a credential-stuffing attempt.
 */
export const ticketRouter = Router();

// POST /api/v1/tickets/:ticketId/verify
ticketRouter.post(
  '/:ticketId/verify',
  requireAuth,
  requireRole('organiser', 'admin'),
  rateLimit(config.rateLimit.ticketVerify, 'user'),
  verifyTicketHandler,
);
