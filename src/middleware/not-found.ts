import type { NextFunction, Request, Response } from 'express';

import { NotFoundError } from '../errors/app-error.js';

/** Terminal 404 handler: converts unmatched routes into a normal AppError. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route not found: ${req.method} ${req.path}`));
}
