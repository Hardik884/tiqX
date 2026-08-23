import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';

import { config } from './config/index.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { requestId } from './middleware/request-id.js';
import { rootRouter } from './routes/index.js';

/**
 * Builds the Express application. Kept free of side effects (no listening, no
 * database calls) so it can be exercised directly in tests.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  // First, so every response - including body-parser failures - is correlated.
  app.use(requestId);

  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use(rootRouter);

  // Order matters: unmatched routes become a 404 error, and the error handler
  // is the last middleware so every failure funnels through it.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
