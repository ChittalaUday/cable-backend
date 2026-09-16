import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

export interface MembershipClaim {
  t: string;
  r: string;
}

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  did: string;
  memberships: MembershipClaim[];
}

const ALGORITHM = 'HS256';
const ISSUER = 'cable-backend';

export interface TokenConfig {
  secret: string;
  accessTtlSeconds: number;
}

export function createTokenSigner(config: TokenConfig) {
  const key = new TextEncoder().encode(config.secret);

  return {
    async sign(claims: AccessTokenClaims): Promise<{ token: string; expiresIn: number }> {
      const token = await new SignJWT({ ...claims })
        .setProtectedHeader({ alg: ALGORITHM })
        .setIssuer(ISSUER)
        .setSubject(claims.sub)
        .setIssuedAt()
        .setExpirationTime(`${config.accessTtlSeconds}s`)
        .sign(key);

      return { token, expiresIn: config.accessTtlSeconds };
    },

    async verify(token: string): Promise<AccessTokenClaims> {
      const { payload } = await jwtVerify(token, key, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
      });

      return payload as unknown as AccessTokenClaims;
    },
  };
}

export type TokenSigner = ReturnType<typeof createTokenSigner>;

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function refreshTokenMatches(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
