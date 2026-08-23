import { Router } from 'express';

import { authRouter } from '../modules/auth/auth.routes.js';
import { eventRouter } from '../modules/events/event.routes.js';
import { healthRouter } from '../modules/health/health.routes.js';

const v1Router = Router();

v1Router.use('/auth', authRouter);
v1Router.use('/events', eventRouter);

/**
 * Root router. Operational endpoints stay unversioned; feature modules are
 * mounted under `/api/v1`.
 */
export const rootRouter = Router();

rootRouter.use('/health', healthRouter);
rootRouter.use('/api/v1', v1Router);
