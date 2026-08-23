import type { NextFunction, Request, Response } from 'express';

import { config } from '../config/index.js';
import { AppError } from '../errors/app-error.js';
import { logger } from '../utils/logger.js';

interface HttpErrorLike {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
  code?: unknown;
}

interface NormalizedError {
  statusCode: number;
  code: string;
  message: string;
  details: unknown;
}

const GENERIC_MESSAGE = 'Internal server error';

/**
 * Errors raised by Express internals (for example a malformed JSON body) carry
 * an HTTP status and an `expose` flag telling us the message is client safe.
 */
function normalize(error: unknown): NormalizedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    const candidate = error as Error & HttpErrorLike;
    const status = candidate.status ?? candidate.statusCode;

    if (typeof status === 'number' && status >= 400 && status < 500 && candidate.expose === true) {
      return {
        statusCode: status,
        code: typeof candidate.code === 'string' ? candidate.code : 'BAD_REQUEST',
        message: error.message,
        details: undefined,
      };
    }
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: GENERIC_MESSAGE,
    details: undefined,
  };
}

/**
 * Centralized error handler. It is the only place that turns a thrown value
 * into an HTTP response, so response shape and logging stay consistent.
 *
 * Express 5 forwards rejected promises from route handlers here automatically.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const normalized = normalize(error);
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;

  const logMeta = {
    requestId,
    method: req.method,
    path: req.path,
    statusCode: normalized.statusCode,
    code: normalized.code,
    // Only unexpected failures carry a stack, for the same reason the response
    // omits one on an AppError: a deliberate rejection is fully described by
    // its code, and the trace turns a uniform error into an oracle. Two login
    // failures that must be indistinguishable differ by a line number in the
    // stack, and a log reader could tell "no such account" from "wrong
    // password" from that alone.
    //
    // Request bodies and headers are never logged here, so passwords, tokens
    // and Authorization values cannot reach the log through this path.
    stack: error instanceof AppError ? undefined : error instanceof Error ? error.stack : undefined,
  };

  if (normalized.statusCode >= 500) {
    logger.error('Request failed', logMeta);
  } else {
    logger.warn('Request rejected', logMeta);
  }

  res.status(normalized.statusCode).json({
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
      ...(requestId === undefined ? {} : { requestId }),
      // Stack traces are a debugging aid for *unexpected* failures only, and
      // never returned in production.
      //
      // An AppError never carries one, even in development. Its message is the
      // whole intended answer, so a stack adds nothing to debug - and for the
      // deliberately uniform errors it actively defeats them: two login
      // failures that must be indistinguishable differ by a line number in the
      // trace, which is enough to tell "no such account" from "wrong password".
      ...(config.isProduction || error instanceof AppError || !(error instanceof Error)
        ? {}
        : { stack: error.stack }),
    },
  });
}
