import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { env } from '@/config/env';
import * as controller from './auth.controller';
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

const routes: FastifyPluginAsyncTypebox = async (app) => {
  const errorRef = { $ref: 'ErrorResponse#' };

  const signInLimit = {
    config: {
      rateLimit: { max: env.SIGN_IN_RATE_LIMIT_MAX, timeWindow: '1 minute' },
      cache: false as const,
      public: true,
    },
  };

  app.post('/auth/otp/request', {
    ...signInLimit,
    schema: {
      tags: ['auth'],
      summary: 'Send a one-time code to a phone number',
      description: 'Always answers 202, registered or not — a different answer would be a user-enumeration oracle.',
      body: RequestOtpBody,
      response: { 202: RequestOtpResponse, 400: errorRef, 429: errorRef, 502: errorRef, 503: errorRef },
      security: [],
    },
  }, controller.requestOtp);

  app.post('/auth/otp/verify', {
    ...signInLimit,
    schema: {
      tags: ['auth'],
      summary: 'Exchange a one-time code for tokens',
      headers: DeviceHeaders,
      body: VerifyOtpBody,
      response: { 200: SessionResponse, 400: errorRef, 401: errorRef, 403: errorRef, 429: errorRef },
      security: [],
    },
  }, controller.verifyOtp);

  app.post('/auth/login', {
    ...signInLimit,
    schema: {
      tags: ['auth'],
      summary: 'Sign in with email or phone and a password',
      headers: DeviceHeaders,
      body: LoginBody,
      response: { 200: SessionResponse, 400: errorRef, 401: errorRef, 403: errorRef, 429: errorRef },
      security: [],
    },
  }, controller.login);

  app.post('/auth/refresh', {
    ...signInLimit,
    schema: {
      tags: ['auth'],
      summary: 'Rotate a refresh token',
      description: 'Replaying a rotated token revokes the session (AGENTS.md §4.6).',
      body: RefreshBody,
      response: { 200: TokensResponse, 400: errorRef, 401: errorRef, 429: errorRef },
      security: [],
    },
  }, controller.refresh);

  app.post('/auth/logout', {
    config: { cache: false },
    schema: {
      tags: ['auth'],
      summary: 'Sign out of this session only',
      description: 'Other accounts signed in on the same device are untouched.',
      response: { 200: LogoutResponse, 401: errorRef },
    },
  }, controller.logout);

  app.post('/auth/logout-all', {
    config: { cache: false },
    schema: {
      tags: ['auth'],
      summary: 'Sign out of every session for this user, on every device',
      response: { 200: LogoutResponse, 401: errorRef },
    },
  }, controller.logoutEverywhere);

  app.get('/auth/me', {
    config: { cache: false },
    schema: {
      tags: ['auth'],
      summary: 'The signed-in user, session and memberships',
      response: { 200: MeResponse, 401: errorRef },
    },
  }, controller.me);
};

export default routes;
