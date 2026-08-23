/**
 * An error that is safe to surface to API clients.
 *
 * Anything thrown that is not an `AppError` is treated as an unexpected
 * failure by the error handler and reported as a generic 500.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, statusCode: number, code: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, new.target);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details?: unknown) {
    super(message, 404, 'NOT_FOUND', details);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Invalid request', details?: unknown) {
    super(message, 400, 'BAD_REQUEST', details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicting resource state', details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

/**
 * 401. The request has no usable identity.
 *
 * `code` is overridable so the login endpoint can answer with one deliberately
 * uninformative code for every kind of credential failure.
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED', details?: unknown) {
    super(message, 401, code, details);
  }
}

/** 403. The caller is known, but not permitted to do this. */
export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions', details?: unknown) {
    super(message, 403, 'FORBIDDEN', details);
  }
}
