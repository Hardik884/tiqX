import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Assigns a request id (reusing an upstream one when present) so log lines and
 * error responses can be correlated.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming && incoming.length <= 128 ? incoming : randomUUID();

  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}
