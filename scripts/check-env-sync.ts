/**
 * Every knob the code reads should be documented, and every key an env file
 * sets should be one the code actually reads.
 *
 * Both directions have drifted before: keys were added to EnvSchema and never
 * written down, and `.env` fell fourteen behind `.env.example`. Reading the
 * schema is the only way to tell — a missing key with a default fails silently,
 * as the default, months later and somewhere else.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.join(import.meta.dirname, '..');
const ENV_FILES = ['.env', '.env.example', '.env.staging', '.env.test'] as const;

/** Keys on EnvSchema, and whether each one has a default to fall back on. */
function schemaKeys(): Map<string, boolean> {
  const source = readFileSync(path.join(ROOT, 'src/config/env.ts'), 'utf8');
  const body = source.slice(source.indexOf('export const EnvSchema'));
  const keys = new Map<string, boolean>();

  for (const match of body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):\s*Type\./gm)) {
    const start = body.indexOf('Type.', match.index);

    // Walk to the balanced close paren: a multi-line Type.Union hides its
    // default well past the end of the line the key is on.
    let depth = 0;
    let end = start;
    for (; end < body.length; end += 1) {
      if ('([{'.includes(body[end]!))
        depth += 1;
      else if (')]}'.includes(body[end]!) && --depth === 0)
        break;
    }

    keys.set(match[1]!, body.slice(start, end + 1).includes('default:'));
  }

  return keys;
}

function fileKeys(name: string): Set<string> {
  let contents: string;
  try {
    contents = readFileSync(path.join(ROOT, name), 'utf8');
  }
  catch {
    return new Set();
  }

  return new Set(
    contents.split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#') && line.includes('='))
      .map(line => line.slice(0, line.indexOf('=')).trim()),
  );
}

const schema = schemaKeys();
const documented = fileKeys('.env.example');
const problems: string[] = [];

for (const key of schema.keys()) {
  if (!documented.has(key))
    problems.push(`.env.example does not document ${key}`);
}

for (const name of ENV_FILES) {
  for (const key of fileKeys(name)) {
    if (!schema.has(key))
      problems.push(`${name} sets ${key}, which EnvSchema does not declare`);
  }
}

// `.env.test` is deliberately sparse; src/test/setup.ts supplies the rest.
const setup = readFileSync(path.join(ROOT, 'src/test/setup.ts'), 'utf8');
const fromSetup = new Set([...setup.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(m => m[1]!));

for (const [key, hasDefault] of schema) {
  if (hasDefault)
    continue;

  for (const name of ENV_FILES) {
    const keys = fileKeys(name);
    if (keys.size > 0 && !keys.has(key) && !(name === '.env.test' && fromSetup.has(key)))
      problems.push(`${name} is missing ${key}, which has no default`);
  }
}

if (problems.length > 0) {
  console.error(`Environment keys are out of sync:\n${problems.map(line => `  - ${line}`).join('\n')}`);
  process.exit(1);
}

console.warn(`✓ ${schema.size} schema keys, all documented; no env file sets anything unknown.`);
