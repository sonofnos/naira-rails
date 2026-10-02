/**
 * Domain errors. They are plain classes (not Nest HttpExceptions) so the
 * services stay transport-agnostic; DomainExceptionFilter maps them to HTTP.
 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(accountCode: string) {
    super(`Insufficient funds in ${accountCode}`, 422, 'insufficient_funds');
  }
}

/** Same idempotency key replayed with a different request body. */
export class IdempotencyConflictError extends DomainError {
  constructor(key: string) {
    super(`Idempotency key "${key}" was already used with a different request`, 409, 'idempotency_key_reused');
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super(`${what} not found`, 404, 'not_found');
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 400, 'validation_failed');
  }
}

export class UnprocessableError extends DomainError {
  constructor(message: string, code = 'unprocessable') {
    super(message, 422, code);
  }
}

export class InvalidStateError extends DomainError {
  constructor(message: string) {
    super(message, 409, 'invalid_state');
  }
}
