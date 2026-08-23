import { Router } from 'express';

import { healthRouter } from '../modules/health/health.routes.js';

/**
 * Root router. Operational endpoints stay unversioned; feature modules will be
 * mounted under `/api/v1` as they are built.
 */
export const rootRouter = Router();

rootRouter.use('/health', healthRouter);
