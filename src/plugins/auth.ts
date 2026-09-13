import type { FastifyRequest } from 'fastify';
import type { AccessTokenClaims } from '@/shared/security/tokens';
import fp from 'fastify-plugin';
import { env } from '@/config/env';
import { AuthService, RevocationCache, SessionsService } from '@/modules/auth';
import { ERROR_CODES } from '@/shared/errors';
import { unauthorized } from '@/shared/errors/domain-error';
import { createTokenSigner } from '@/shared/security/tokens';

declare module 'fastify' {
  interface FastifyInstance {
    auth: AuthService;
    sessions: SessionsService;
    revocations: RevocationCache;
    /** onRequest hook: verifies the token and populates `request.session`. */
    authenticate: (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    /** Present only after `authenticate`. Identity comes from the signed token, never a header. */
    session: AccessTokenClaims;
  }
}

/** The one place a bearer token is turned into an identity (AGENTS.md §4.6). */
export default fp(async (app) => {
  const tokens = createTokenSigner({
    secret: env.JWT_SECRET,
    accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  });

  const revocations = new RevocationCache(app.db, app.pool, env.ACCESS_TOKEN_TTL_SECONDS * 1000);
  await revocations.start();

  const sessions = new SessionsService(
    app.db,
    {
      refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
      maxSessionsPerDevice: env.MAX_SESSIONS_PER_DEVICE,
    },
    async sessionId => revocations.publish(sessionId),
  );

  app.decorate('sessions', sessions);
  app.decorate('revocations', revocations);
  app.decorate('auth', new AuthService(app.db, sessions, {
    messaging: app.messaging,
    tokens,
    config: {
      otpLength: env.OTP_LENGTH,
      otpTtlSeconds: env.OTP_TTL_SECONDS,
      otpMaxAttempts: env.OTP_MAX_ATTEMPTS,
      otpResendCooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
      defaultCountryCode: env.DEFAULT_COUNTRY_CODE,
    },
  }));

  // Declared without a value: Fastify only needs the property to exist on the
  // prototype, and a shared default object would be mutated across requests.
  app.decorateRequest('session');

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const header = request.headers.authorization;

    if (header === undefined || !header.startsWith('Bearer '))
      throw unauthorized(ERROR_CODES.AUTH_HEADER_MISSING, 'Authorization header is missing');

    let claims: AccessTokenClaims;
    try {
      claims = await tokens.verify(header.slice('Bearer '.length));
    }
    catch (error) {
      // Expired is the ONE 401 that means "refresh and retry" rather than
      // "sign out", so the client must be able to tell it apart (§7.1).
      const expired = (error as { code?: string }).code === 'ERR_JWT_EXPIRED';
      throw unauthorized(
        expired ? ERROR_CODES.AUTH_TOKEN_EXPIRED : ERROR_CODES.AUTH_TOKEN_INVALID,
        expired ? 'Access token has expired' : 'Access token is not valid',
      );
    }

    if (app.revocations.has(claims.sid))
      throw unauthorized(ERROR_CODES.AUTH_SESSION_REVOKED, 'This session was signed out');

    request.session = claims;

    // Every log line for this request now names who made it (§4.6).
    request.log = request.log.child({
      userId: claims.sub,
      sessionId: claims.sid,
      deviceId: claims.did,
    });
  });

  app.addHook('onClose', async () => {
    await revocations.stop();
  });
}, { name: 'auth', dependencies: ['database', 'messaging'] });
