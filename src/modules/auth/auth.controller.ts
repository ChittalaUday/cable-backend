import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceHeaders, LoginBody, RefreshBody, RequestOtpBody, VerifyOtpBody } from './auth.schema';
import type { DeviceInfo } from './sessions.service';

/**
 * The only layer that touches `request`/`reply` (AGENTS.md §3).
 *
 * Unwraps the request, calls one service method, maps the result to a status
 * code. No business branching, no database access.
 */

function deviceFrom(headers: DeviceHeaders): DeviceInfo {
  return {
    clientDeviceId: headers['x-device-id'],
    platform: headers['x-platform'],
    appVersion: headers['x-app-version'] ?? null,
    osVersion: headers['x-os-version'] ?? null,
    model: headers['x-device-model'] ?? null,
  };
}

export async function requestOtp(
  request: FastifyRequest<{ Body: RequestOtpBody }>,
  reply: FastifyReply,
) {
  const { channel } = await request.server.auth.requestOtp(request.body);

  // Always 202, whether or not the number is known (§4.3.1).
  return reply.status(202).send({
    status: 'accepted' as const,
    channel,
    expiresInSeconds: request.server.auth.otpTtlSeconds,
  });
}

export async function verifyOtp(
  request: FastifyRequest<{ Body: VerifyOtpBody; Headers: DeviceHeaders }>,
  reply: FastifyReply,
) {
  const result = await request.server.auth.verifyOtp({
    ...request.body,
    device: deviceFrom(request.headers),
  });

  return reply.status(200).send({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    tokenType: 'Bearer' as const,
    user: result.user,
  });
}

export async function login(
  request: FastifyRequest<{ Body: LoginBody; Headers: DeviceHeaders }>,
  reply: FastifyReply,
) {
  const result = await request.server.auth.login({
    ...request.body,
    device: deviceFrom(request.headers),
  });

  return reply.status(200).send({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    tokenType: 'Bearer' as const,
    user: result.user,
  });
}

export async function refresh(
  request: FastifyRequest<{ Body: RefreshBody }>,
  reply: FastifyReply,
) {
  const tokens = await request.server.auth.refresh(request.body.refreshToken);

  return reply.status(200).send({ ...tokens, tokenType: 'Bearer' as const });
}

export async function logout(request: FastifyRequest, reply: FastifyReply) {
  await request.server.auth.logout(request.session.sid);
  return reply.status(200).send({ revokedSessions: 1 });
}

export async function logoutEverywhere(request: FastifyRequest, reply: FastifyReply) {
  const revoked = await request.server.auth.logoutEverywhere(request.session.sub);
  return reply.status(200).send({ revokedSessions: revoked });
}

export async function me(request: FastifyRequest, reply: FastifyReply) {
  const user = await request.server.auth.userById(request.session.sub);

  return reply.status(200).send({
    user,
    sessionId: request.session.sid,
    deviceId: request.session.did,
    memberships: request.session.memberships.map(m => ({ tenantId: m.t, roleId: m.r })),
  });
}
