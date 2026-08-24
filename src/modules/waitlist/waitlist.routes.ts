import { Router } from 'express';

import { joinWaitlistHandler, leaveWaitlistHandler } from './waitlist.controller.js';

/**
 * Mounted at /api/v1/events/:eventId/waitlist, alongside how holds are
 * mounted under the same event - see event.routes.ts, which applies
 * `requireAuth` at the mount point rather than per route here, matching how
 * reservationRouter is mounted. `mergeParams` is required so the controller
 * can see `eventId`.
 *
 * Any authenticated user may join - waitlisting is what a customer account is
 * for, the same reasoning that keeps hold creation role-free.
 */
export const waitlistRouter = Router({ mergeParams: true });

waitlistRouter.post('/', joinWaitlistHandler);
waitlistRouter.post('/:entryId/leave', leaveWaitlistHandler);
