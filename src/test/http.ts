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
  memberships: { tenantId: string; roleId: string }[];
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
