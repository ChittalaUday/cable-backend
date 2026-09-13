/**
 * `inject`'s `json()` is `any`, which turns every assertion into an unchecked
 * member access. One permissive shape keeps the tests readable and still lets
 * the compiler catch a misspelt field.
 */
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
    isSuperAdmin: boolean;
  };
  memberships: { tenantId: string; roleId: string }[];
  sessionId: string;
  deviceId: string;
  revokedSessions: number;
  status: string;
  version: string;
  channel: string;
  expiresInSeconds: number;
  /** Error responses (§7.1). */
  code: string;
  message: string;
}

export function bodyOf<T = AuthBody>(response: { json: () => unknown }): T {
  return response.json() as T;
}
