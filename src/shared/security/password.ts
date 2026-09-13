import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters (AGENTS.md §2).
 *
 * OWASP's second recommended profile: 19 MiB, 2 iterations, 1 lane. Memory cost
 * is what makes GPU cracking expensive, so it is the number to raise first if
 * this ever needs hardening.
 */
const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

/**
 * Constant-time verification.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row must
 * read as "wrong password", never as a 500 that tells an attacker the account
 * exists and is broken.
 */
export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  try {
    return await verify(hashed, plain, OPTIONS);
  }
  catch {
    return false;
  }
}
