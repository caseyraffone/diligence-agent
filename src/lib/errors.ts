/** Typed application errors. Each maps to a specific HTTP status at the edge. */

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /** Safe to show a user. Internal detail stays in `message`. */
    readonly publicMessage: string = message,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHENTICATED', 'You must sign in to continue.');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not permitted') {
    // Deliberately identical public text to NotFound so a probing caller cannot
    // distinguish "exists but forbidden" from "does not exist".
    super(message, 404, 'FORBIDDEN', 'Not found.');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND', 'Not found.');
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    readonly details: unknown = undefined,
  ) {
    super(message, 422, 'VALIDATION_FAILED', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT', message);
  }
}

export class RateLimitedError extends AppError {
  constructor(
    message = 'Too many requests',
    readonly retryAfterSeconds = 60,
  ) {
    super(message, 429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
  }
}

/**
 * Raised when an operation requiring documented applicant consent is attempted
 * before that consent exists. This is a hard gate, not a warning.
 */
export class ConsentRequiredError extends AppError {
  constructor(scope: string) {
    super(
      `Documented applicant consent for ${scope} is required before this action.`,
      403,
      'CONSENT_REQUIRED',
      `Documented applicant consent for ${scope} is required before this action.`,
    );
  }
}

/** Raised when a workflow transition is not legal from the current state. */
export class InvalidTransitionError extends AppError {
  constructor(message: string) {
    super(message, 409, 'INVALID_TRANSITION', message);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
