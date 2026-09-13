import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

/**
 * Access tokens (AGENTS.md §4.3).
 *
 * Framework-free on purpose: services may not import Fastify (§3), and the
 * worker will need to mint tokens too. `jose` rather than a hand-rolled HMAC —
 * JWT's sharp edges (algorithm confusion, `exp` handling) are not worth
 * reimplementing.
 */

export interface MembershipClaim {
  /** Tenant id. */
  t: string;
  /** Role id within that tenant. */
  r: string;
}

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Session id — this is what makes a request attributable (§4.6). */
  sid: string;
  /** Device id. */
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

    /**
     * Verifies and decodes. Throws on anything wrong, including a token signed
     * with a different algorithm — `algorithms` is pinned so `alg: none` and
     * RS256-confusion attacks cannot get through.
     */
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

/**
 * Refresh tokens are opaque random bytes, not JWTs.
 *
 * Nothing needs to read them, and an opaque token cannot leak claims if it is
 * logged or pasted into a bug report.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only the hash is ever stored (§4.6). */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time hash comparison, so a partial match leaks nothing. */
export function refreshTokenMatches(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
