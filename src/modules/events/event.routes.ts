import { Router } from 'express';

import { createEventHandler } from './event.controller.js';

export const eventRouter = Router();

eventRouter.post('/', createEventHandler);
