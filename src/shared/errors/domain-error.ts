import type { ErrorCode } from './codes';
import { ERROR_CODES } from './codes';

/** One field-level problem, so a client can attach it to the right input. */
export interface ValidationDetail { field: string; issue: string }

export interface DomainErrorInit {
  code: ErrorCode;
  statusCode: number;
  message: string;
  details?: ValidationDetail[];
}

/**
 * Thrown by services (AGENTS.md §3, §7).
 *
 * Services never throw HTTP errors — they throw this, and the single
 * `setErrorHandler` maps it to a status code and a response body. That is what
 * keeps a service testable without booting a server.
 */
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

/**
 * A record that is missing, or one that belongs to another tenant.
 *
 * These are deliberately the same error: a distinct code for the cross-tenant
 * case would confirm the row exists and leak across the boundary (§4.5).
 */
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

export function badRequest(code: ErrorCode, message: string, details?: ValidationDetail[]): DomainError {
  return new DomainError(
    details ? { code, statusCode: 400, message, details } : { code, statusCode: 400, message },
  );
}
