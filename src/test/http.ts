import { TEST_PASSWORD, uniqueDeviceId } from './fixtures';

export interface AuthBody {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  user: {
    id: string;
    email: string | null;
    phone: string | null;
    name: string | null;
  };
  memberships: { tenantId: string; tenantName: string; roleId: string }[];
  sessionId: string;
  deviceId: string;
  revokedSessions: number;
  status: string;
  version: string;
  channel: string;
  expiresInSeconds: number;
  code: string;
  message: string;
}

export function bodyOf<T = AuthBody>(response: { json: () => unknown }): T {
  return response.json() as T;
}

export async function signIn(
  app: { inject: (opts: Record<string, unknown>) => Promise<{ statusCode: number; body: string; json: () => unknown }> },
  identifier: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier, password },
  });

  if (response.statusCode !== 200)
    throw new Error(`Sign-in failed for ${identifier}: ${response.statusCode} ${response.body}`);

  return bodyOf(response).accessToken;
}

export function as(token: string, tenantId?: string): Record<string, string> {
  return tenantId === undefined
    ? { authorization: `Bearer ${token}` }
    : { 'authorization': `Bearer ${token}`, 'x-tenant-id': tenantId };
}
