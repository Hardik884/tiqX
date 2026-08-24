import { Router } from 'express';

import { authRouter } from '../modules/auth/auth.routes.js';
import { bookingRouter } from '../modules/bookings/booking.routes.js';
import { eventRouter, organiserEventsRouter } from '../modules/events/event.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';
import { ticketRouter } from '../modules/tickets/ticket.routes.js';
import { waitlistOfferRouter } from '../modules/waitlist/waitlist-offer.routes.js';

const v1Router = Router();

v1Router.use('/auth', authRouter);
v1Router.use('/events', eventRouter);
v1Router.use('/organiser/events', organiserEventsRouter);
v1Router.use('/bookings', bookingRouter);
v1Router.use('/tickets', ticketRouter);
v1Router.use('/waitlist/offers', waitlistOfferRouter);

/**
 * Root router. Operational endpoints stay unversioned; feature modules are
 * mounted under `/api/v1`.
 */
export const rootRouter = Router();

rootRouter.use('/health', healthRouter);
rootRouter.use('/api/v1', v1Router);
