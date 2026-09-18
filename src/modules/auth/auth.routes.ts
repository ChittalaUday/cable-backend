import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DeviceInfo } from './services/sessions.service';
import { env } from '@/config/env';
import { perIdentifier } from './auth.ratelimit';
import {
  DeviceHeaders,
  LoginBody,
  LogoutResponse,
  MeResponse,
  RefreshBody,
  RequestOtpBody,
  RequestOtpResponse,
  SessionResponse,
  TokensResponse,
  VerifyOtpBody,
} from './auth.schema';

function deviceFrom(headers: DeviceHeaders): DeviceInfo {
  const ramMb = Number(headers['x-device-ram-mb']);

  return {
    clientDeviceId: headers['x-device-id'],
    platform: headers['x-platform'],
    appVersion: headers['x-app-version'] ?? null,
    osVersion: headers['x-os-version'] ?? null,
    manufacturer: headers['x-device-manufacturer'] ?? null,
    model: headers['x-device-model'] ?? null,
    ramMb: Number.isFinite(ramMb) && ramMb > 0 ? ramMb : null,
    screenResolution: headers['x-screen-resolution'] ?? null,
  };
}

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };

  const ipLimit = {
    config: {
      rateLimit: { max: env.SIGN_IN_RATE_LIMIT_MAX, timeWindow: '1 minute' },
      public: true,
    },
  };

  const otpWindowMs = env.OTP_RESEND_COOLDOWN_SECONDS * 1000;

  const otpRequestLimit = {
    ...ipLimit,
    preValidation: perIdentifier(app, {
      prefix: 'otp-request',
      field: 'phone',
      max: env.OTP_REQUEST_RATE_LIMIT_MAX,
      timeWindow: otpWindowMs,
      message: 'Too many OTP requests.',
    }),
  };

  const otpVerifyLimit = {
    ...ipLimit,
    preValidation: perIdentifier(app, {
      prefix: 'otp-verify',
      field: 'phone',
      max: env.OTP_VERIFY_RATE_LIMIT_MAX,
      timeWindow: otpWindowMs,
      message: 'Too many OTP verification attempts.',
    }),
  };

  const loginLimit = {
    ...ipLimit,
    preValidation: perIdentifier(app, {
      prefix: 'login',
      field: 'identifier',
      max: env.LOGIN_RATE_LIMIT_MAX,
      timeWindow: '1 minute',
      message: 'Too many login attempts.',
    }),
  };

  const refreshLimit = ipLimit;

  app.post('/auth/otp/request', {
    ...otpRequestLimit,
    schema: {
      tags: ['auth'],
      summary: 'Send a one-time code to a phone number',
      description: 'Always answers 202, registered or not — a different answer would be a user-enumeration oracle.',
      body: RequestOtpBody,
      response: { 202: RequestOtpResponse, 400: errorRef, 429: errorRef, 502: errorRef, 503: errorRef },
      security: [],
    },
  }, async (request, reply) => {
    const { channel, nextCooldownSeconds } = await request.server.auth.requestOtp(request.body, request.auditContext);
    return reply.status(202).send({
      status: 'accepted' as const,
      channel,
      expiresInSeconds: request.server.auth.otpTtlSeconds,
      nextCooldownSeconds,
    });
  });

  app.post('/auth/otp/verify', {
    ...otpVerifyLimit,
    schema: {
      tags: ['auth'],
      summary: 'Exchange a one-time code for tokens',
      headers: DeviceHeaders,
      body: VerifyOtpBody,
      response: { 200: SessionResponse, 400: errorRef, 401: errorRef, 403: errorRef, 429: errorRef },
      security: [],
    },
  }, async (request, reply) => {
    const result = await request.server.auth.verifyOtp({
      ...request.body,
      device: deviceFrom(request.headers),
    }, request.auditContext);

    return reply.status(200).send({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      tokenType: 'Bearer' as const,
      user: result.user,
      memberships: result.memberships,
    });
  });

  app.post('/auth/login', {
    ...loginLimit,
    schema: {
      tags: ['auth'],
      summary: 'Sign in with email or phone and a password',
      headers: DeviceHeaders,
      body: LoginBody,
      response: { 200: SessionResponse, 400: errorRef, 401: errorRef, 403: errorRef, 429: errorRef },
      security: [],
    },
  }, async (request, reply) => {
    const result = await request.server.auth.login({
      ...request.body,
      device: deviceFrom(request.headers),
    }, request.auditContext);

    return reply.status(200).send({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      tokenType: 'Bearer' as const,
      user: result.user,
      memberships: result.memberships,
    });
  });

  app.post('/auth/refresh', {
    ...refreshLimit,
    schema: {
      tags: ['auth'],
      summary: 'Rotate a refresh token',
      description: 'Replaying a rotated token revokes the session (AGENTS.md §4.6).',
      body: RefreshBody,
      response: { 200: TokensResponse, 400: errorRef, 401: errorRef, 429: errorRef },
      security: [],
    },
  }, async (request, reply) => {
    const tokens = await request.server.auth.refresh(request.body.refreshToken, request.auditContext);
    return reply.status(200).send({ ...tokens, tokenType: 'Bearer' as const });
  });

  app.post('/auth/logout', {
    schema: {
      tags: ['auth'],
      summary: 'Sign out of this session only',
      description: 'Other accounts signed in on the same device are untouched.',
      response: { 200: LogoutResponse, 401: errorRef },
    },
  }, async (request, reply) => {
    await request.server.auth.logout(request.session.sid, request.auditContext);
    return reply.status(200).send({ revokedSessions: 1 });
  });

  app.post('/auth/logout-all', {
    schema: {
      tags: ['auth'],
      summary: 'Sign out of every session for this user, on every device',
      response: { 200: LogoutResponse, 401: errorRef },
    },
  }, async (request, reply) => {
    const revoked = await request.server.auth.logoutEverywhere(request.session.sub, request.auditContext);
    return reply.status(200).send({ revokedSessions: revoked });
  });

  app.get('/auth/me', {
    schema: {
      tags: ['auth'],
      summary: 'The signed-in user, session and memberships',
      response: { 200: MeResponse, 401: errorRef },
    },
  }, async (request, reply) => {
    const user = await request.server.auth.userById(request.session.sub);
    const memberships = await request.server.auth.membershipsFor(request.session.sub);

    const customer = request.tenantId === undefined
      ? null
      : await request.server.customers.profileFor(request.tenantId, request.session.sub);

    return reply.status(200).send({
      user,
      sessionId: request.session.sid,
      deviceId: request.session.did,
      memberships,
      customer,
    });
  });
};

export default routes;
