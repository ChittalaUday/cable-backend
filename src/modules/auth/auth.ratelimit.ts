import type { FastifyInstance, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import { tooManyRequests } from '@/errors';

export interface IdentifierLimit {
  /** Keeps one endpoint's counter off another's: `otp-verify:9990000001`. */
  prefix: string;
  /** The body field naming the account being attacked. */
  field: 'phone' | 'identifier';
  max: number;
  timeWindow: number | string;
  /** Leading sentence of the 429, e.g. 'Too many OTP verification attempts.' */
  message: string;
}

/**
 * The account under attack, or the caller's IP when the body names none — a
 * request that fails validation still has to count against something.
 */
export function identifierKey(limit: Pick<IdentifierLimit, 'prefix' | 'field'>) {
  return (request: FastifyRequest): string => {
    const value = (request.body as Record<string, unknown> | undefined)?.[limit.field];

    return typeof value === 'string' && value.trim() !== ''
      ? `${limit.prefix}:${value.trim().toLowerCase()}`
      : `${limit.prefix}:${request.ip}`;
  };
}

/**
 * A per-account ceiling that runs *on top of* the route's per-IP one.
 *
 * It cannot be expressed as the route's own `config.rateLimit`: @fastify/rate-limit
 * flags a request the first time any of its hooks runs and skips every later one,
 * so declaring a keyGenerator on the route swaps the IP ceiling out instead of
 * adding to it — and an attacker rotating phone numbers from one host would face
 * no ceiling at all. `createRateLimit` is the same limiter without that guard.
 */
export function perIdentifier(app: FastifyInstance, limit: IdentifierLimit): preValidationAsyncHookHandler {
  const check = app.createRateLimit({
    max: limit.max,
    timeWindow: limit.timeWindow,
    keyGenerator: identifierKey(limit),
  });

  return async (request) => {
    const result = await check(request);

    if (result.isAllowed || !result.isExceeded)
      return;

    throw tooManyRequests(`${limit.message} Try again in ${result.ttlInSeconds} seconds.`);
  };
}
