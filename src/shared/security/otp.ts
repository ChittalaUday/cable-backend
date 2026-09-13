import { Buffer } from 'node:buffer';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Generates a numeric code of the given length.
 *
 * `randomInt` is CSPRNG-backed and rejection-samples, so digits are uniform.
 * `Math.random()` here would be a predictable login.
 */
export function generateOtp(length: number): string {
  let code = '';
  for (let i = 0; i < length; i += 1)
    code += String(randomInt(0, 10));

  return code;
}

/**
 * Hashes a code, bound to the identifier it was issued for.
 *
 * Binding means a code minted for one phone cannot be replayed against another,
 * even if both rows are readable.
 *
 * A fast hash is the right choice here, unlike for passwords: the code lives for
 * minutes, is single-use, and is attempt-capped, so there is no offline attack
 * worth slowing down — while argon2 on every verify would put ~50ms of CPU on
 * an endpoint that is rate-limited precisely because it is cheap to call.
 */
export function hashOtp(code: string, identifier: string): string {
  return createHash('sha256').update(`${code}:${identifier}`).digest('hex');
}

/**
 * Constant-time comparison of two hashes.
 *
 * A plain `===` leaks how many leading characters matched, which over enough
 * attempts is a usable oracle.
 */
export function otpMatches(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
