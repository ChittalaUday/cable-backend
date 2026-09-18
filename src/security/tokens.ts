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

/*
 * Both token kinds are signed with the same secret, so the audience is what
 * keeps them apart — and it is checked on the way in, not just set on the way
 * out. Without that, a half-authenticated challenge token would satisfy
 * `verify` and arrive at the route guard as a session with no `sid`.
 */
const ACCESS_AUDIENCE = 'cable:access';
const CHALLENGE_AUDIENCE = 'cable:email-otp';

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
        .setAudience(ACCESS_AUDIENCE)
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
        audience: ACCESS_AUDIENCE,
      });

      return payload as unknown as AccessTokenClaims;
    },

    /**
     * Proof that a password was just accepted, and nothing more.
     *
     * It carries no session, so it cannot reach an authenticated route: its only
     * use is asking for and verifying the emailed code that finishes the sign-in.
     */
    async signChallenge(userId: string, ttlSeconds: number): Promise<{ token: string; expiresIn: number }> {
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: ALGORITHM })
        .setIssuer(ISSUER)
        .setAudience(CHALLENGE_AUDIENCE)
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(key);

      return { token, expiresIn: ttlSeconds };
    },

    /** The user id the challenge was issued for. */
    async verifyChallenge(token: string): Promise<string> {
      const { payload } = await jwtVerify(token, key, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: CHALLENGE_AUDIENCE,
      });

      if (typeof payload.sub !== 'string' || payload.sub === '')
        throw new TypeError('Challenge token carries no subject');

      return payload.sub;
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
