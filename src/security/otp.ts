import { Buffer } from 'node:buffer';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

export function generateOtp(length: number): string {
  let code = '';
  for (let i = 0; i < length; i += 1)
    code += String(randomInt(0, 10));

  return code;
}

export function hashOtp(code: string, identifier: string): string {
  return createHash('sha256').update(`${code}:${identifier}`).digest('hex');
}

export function otpMatches(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
