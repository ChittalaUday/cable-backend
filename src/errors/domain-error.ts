import type { ErrorCode } from './codes';
import { ERROR_CODES } from './codes';

export interface ValidationDetail { field: string; issue: string }

export interface DomainErrorInit {
  code: ErrorCode;
  statusCode: number;
  message: string;
  details?: ValidationDetail[];
}

export class DomainError extends Error {
  override readonly name = 'DomainError';
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ValidationDetail[] | undefined;

  constructor(init: DomainErrorInit) {
    super(init.message);
    this.code = init.code;
    this.statusCode = init.statusCode;
    this.details = init.details;
  }
}

export function notFound(what = 'Resource'): DomainError {
  return new DomainError({ code: ERROR_CODES.RESOURCE_NOT_FOUND, statusCode: 404, message: `${what} not found` });
}

export function conflict(message: string, code: ErrorCode = ERROR_CODES.RESOURCE_CONFLICT): DomainError {
  return new DomainError({ code, statusCode: 409, message });
}

export function inUse(message: string): DomainError {
  return new DomainError({ code: ERROR_CODES.RESOURCE_IN_USE, statusCode: 409, message });
}

export function forbidden(code: ErrorCode, message: string): DomainError {
  return new DomainError({ code, statusCode: 403, message });
}

export function unauthorized(code: ErrorCode, message: string): DomainError {
  return new DomainError({ code, statusCode: 401, message });
}

export function tooManyRequests(message: string): DomainError {
  return new DomainError({ code: ERROR_CODES.RATE_LIMIT_EXCEEDED, statusCode: 429, message });
}

export function badRequest(code: ErrorCode, message: string, details?: ValidationDetail[]): DomainError {
  return new DomainError(
    details ? { code, statusCode: 400, message, details } : { code, statusCode: 400, message },
  );
}

// Repositories signal "no row" with null; Drizzle's destructured `[row]` gives
// undefined. Both mean the same 404, so this accepts either.
export function orNotFound<T>(row: T | null | undefined, what: string): T {
  if (row === null || row === undefined)
    throw notFound(what);

  return row;
}
