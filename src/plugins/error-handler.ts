import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import fp from 'fastify-plugin';
import { isProduction } from '@/config/env';
import { DomainError, ERROR_CODES } from '@/shared/errors';

/**
 * The one error shape the API emits (AGENTS.md §6, §7.1).
 *
 * `code` is what clients branch on; `message` is human text that may be
 * reworded or translated at any time and must never be parsed.
 */
export const ErrorResponse = Type.Object({
  statusCode: Type.Integer(),
  error: Type.String(),
  code: Type.String(),
  message: Type.String(),
  requestId: Type.String(),
  details: Type.Optional(Type.Array(Type.Object({
    field: Type.String(),
    issue: Type.String(),
  }))),
}, { $id: 'ErrorResponse' });

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** Turn Fastify's validation output into per-field details a form can use. */
function validationDetails(error: FastifyError): { field: string; issue: string }[] {
  return (error.validation ?? []).map(issue => ({
    field: issue.instancePath.replace(/^\//, '') || String(issue.params.missingProperty ?? ''),
    issue: issue.message ?? 'invalid',
  }));
}

export default fp(async (app) => {
  app.addSchema(ErrorResponse);

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // Services throw DomainError; they never know about HTTP (§3).
    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: STATUS_TEXT[error.statusCode] ?? 'Error',
        code: error.code,
        message: error.message,
        requestId: request.id,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Request validation failed',
        requestId: request.id,
        details: validationDetails(error),
      });
    }

    const status = error.statusCode ?? 500;

    if (status === 429) {
      return reply.status(429).send({
        statusCode: 429,
        error: 'Too Many Requests',
        code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
        message: 'Rate limit exceeded',
        requestId: request.id,
      });
    }

    if (status === 503) {
      return reply.status(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        code: ERROR_CODES.SERVER_UNAVAILABLE,
        message: 'Service temporarily unavailable',
        requestId: request.id,
      });
    }

    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        code: ERROR_CODES.SERVER_ERROR,
        // A 5xx never leaks a stack trace or a driver message (§7).
        message: isProduction ? 'Internal server error' : error.message,
        requestId: request.id,
      });
    }

    // A 4xx raised by a plugin rather than a service.
    return reply.status(status).send({
      statusCode: status,
      error: STATUS_TEXT[status] ?? 'Error',
      code: error.code,
      message: error.message,
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    });
  });
}, { name: 'error-handler' });
