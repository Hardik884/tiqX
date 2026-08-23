import { Router } from 'express';

import { reservationRouter } from '../reservations/reservation.routes.js';
import { createEventHandler } from './event.controller.js';

export const eventRouter = Router();

eventRouter.post('/', createEventHandler);

// Holds are scoped to an event: POST /api/v1/events/:eventId/holds
eventRouter.use('/:eventId/holds', reservationRouter);
