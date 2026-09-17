/**
 * Adds every route the API publishes and the Postman collection is missing,
 * built from the live OpenAPI document, and reports the ones the collection
 * still has that the API no longer serves.
 *
 *   pnpm dev            # in another terminal — the spec comes off the server
 *   pnpm postman:sync
 *   pnpm postman:sync --dry
 *
 * It only ever appends. Existing requests — their bodies, descriptions, scripts
 * and hand-picked examples — are left exactly as they are, so this can be run
 * after any route change without losing the parts a generator cannot write.
 * A route that was renamed shows up as one stale and one missing entry; fix
 * those by hand, because only you know they are the same route.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { env } from '@/config/env';
import { arg, flag } from './stress/shared';

const SPEC_URL = arg('spec', `http://localhost:${env.PORT}/docs/json`);
const FILE = path.resolve(process.cwd(), arg('collection', 'postman/cable-backend.postman_collection.json'));
const ENV_FILE = path.resolve(process.cwd(), arg('env', 'postman/cable-backend.local.postman_environment.json'));

// ─── the shapes either side ───────────────────────────────────────────────────

type Json = Record<string, unknown>;

interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Json; description?: string }>;
  requestBody?: { content?: { 'application/json'?: { schema?: Json } } };
}

interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Json> };
}

interface PostmanItem {
  name: string;
  item?: PostmanItem[];
  request?: {
    method: string;
    header?: Array<{ key: string; value: string }>;
    url: { raw: string; host: string[]; path: string[]; query?: Array<{ key: string; value: string; disabled?: boolean; description?: string }> };
    description?: string;
    body?: Json;
  };
  event?: Json[];
}

interface Collection { info: Json; item: PostmanItem[]; variable?: Array<{ key: string }> }

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// ─── naming ───────────────────────────────────────────────────────────────────

const camel = (s: string) => s.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase());

/**
 * `/api/v1/service-providers/{id}/coverage` → `serviceProviderId`: the segment
 * in front of the placeholder, de-pluralised. It lands on the names the
 * collection already uses, so new requests share variables with the old ones.
 */
function variableFor(route: string): string {
  const owner = route.slice(0, route.indexOf('/{id}')).split('/').pop() ?? 'record';
  const singular = owner.endsWith('ies') ? `${owner.slice(0, -3)}y` : owner.replace(/s$/, '');
  return `${camel(singular)}Id`;
}

function titleFor(method: string, route: string, op: Operation): string {
  if (op.summary !== undefined && op.summary !== '')
    return op.summary;

  return `${method.toUpperCase()} ${route.replace('/api/v1/', '')}`;
}

// ─── example bodies ───────────────────────────────────────────────────────────

/**
 * A value the route will actually accept. Every pattern in this API is one of
 * four shapes, and a sample that fails validation is worse than no sample.
 */
function matching(pattern: string, name: string): string {
  const fixedDigits = /^\^\[0-9\]\{(\d+)\}\$$/.exec(pattern);
  if (fixedDigits !== null)
    return '9876543210'.repeat(3).slice(0, Number(fixedDigits[1]));

  // `^-?[0-9]{1,10}(\.[0-9]{1,2})?$` — money and rates cross the wire as strings.
  if (pattern.includes('\\.'))
    return '0.00';

  if (pattern.includes('[0-9]+'))
    return '1';

  // `^[a-z0-9]+(?:[-_][a-z0-9]+)*$` — a slug.
  if (pattern.includes('[a-z0-9]'))
    return name === '' ? 'example' : name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

  return name === '' ? 'string' : name;
}

function resolve(schema: Json, spec: Spec): Json {
  const ref = schema.$ref;
  if (typeof ref !== 'string')
    return schema;

  return (spec.components?.schemas?.[ref.replace('#/components/schemas/', '')] ?? {});
}

/**
 * A body you can send, not a body you have to look up: every property the route
 * accepts, filled with something of the right shape. Ids reuse the collection's
 * variables so a POST works after the GET that saved them.
 */
function sampleOf(raw: Json, spec: Spec, name = '', depth = 0): unknown {
  const schema = resolve(raw, spec);

  if (schema.default !== undefined)
    return schema.default;
  if (Array.isArray(schema.enum))
    return schema.enum[0];
  if (Array.isArray(schema.anyOf))
    return sampleOf(schema.anyOf.find(s => (s as Json).type !== 'null') as Json ?? {}, spec, name, depth);

  if (depth > 6)
    return null;

  switch (schema.type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Json>;
      return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, sampleOf(value, spec, key, depth + 1)]));
    }
    case 'array':
      // `locationIds` holds a `locationId`, which is a variable the collection
      // already carries — the plural would match nothing.
      return [sampleOf((schema.items ?? {}) as Json, spec, name.replace(/Ids$/, 'Id'), depth + 1)];
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return false;
    case 'string':
      if (schema.format === 'uuid')
        return name.endsWith('Id') ? `{{${name}}}` : '00000000-0000-0000-0000-000000000000';
      if (schema.format === 'date-time')
        return new Date().toISOString();
      if (schema.format === 'email')
        return 'someone@example.com';
      return typeof schema.pattern === 'string' ? matching(schema.pattern, name) : (name === '' ? 'string' : name);
    default:
      return null;
  }
}

// ─── building an item ─────────────────────────────────────────────────────────

function itemFor(method: string, route: string, op: Operation, spec: Spec): PostmanItem {
  const segments = route.replace('/api/v1/', '').split('/').map(s => (s === '{id}' ? `{{${variableFor(route)}}}` : s));

  const query = (op.parameters ?? [])
    .filter(p => p.in === 'query')
    .map(p => ({
      key: p.name,
      value: String(sampleOf(p.schema ?? {}, spec, p.name) ?? ''),
      ...(p.required === true ? {} : { disabled: true }),
      ...(p.description === undefined ? {} : { description: p.description }),
    }));

  const enabled = query.filter(q => q.disabled !== true);
  const raw = `{{baseUrl}}/${segments.join('/')}${
    enabled.length === 0 ? '' : `?${enabled.map(q => `${q.key}=${q.value}`).join('&')}`}`;

  const bodySchema = op.requestBody?.content?.['application/json']?.schema;

  return {
    name: titleFor(method, route, op),
    request: {
      method: method.toUpperCase(),
      header: [
        ...(bodySchema === undefined ? [] : [{ key: 'content-type', value: 'application/json' }]),
        { key: 'x-tenant-id', value: '{{tenantId}}' },
      ],
      url: {
        raw,
        host: ['{{baseUrl}}'],
        path: segments,
        ...(query.length === 0 ? {} : { query }),
      },
      ...(op.description === undefined ? {} : { description: op.description }),
      ...(bodySchema === undefined
        ? {}
        : {
            body: {
              mode: 'raw',
              raw: JSON.stringify(sampleOf(bodySchema, spec), null, 2),
              options: { raw: { language: 'json' } },
            },
          }),
    },
  };
}

// ─── where it goes ────────────────────────────────────────────────────────────

const keyOf = (method: string, route: string) => `${method.toUpperCase()} ${route}`;

/** The collection's own URLs, back in the spec's shape, so the two can be compared. */
function routeOf(item: PostmanItem): string | null {
  const url = item.request?.url;
  if (url === undefined)
    return null;

  const bare = url.raw.split('?')[0]!;
  if (!bare.startsWith('{{baseUrl}}'))
    return null;

  return `/api/v1${bare.slice('{{baseUrl}}'.length)}`.replace(/\{\{\w+\}\}/g, '{id}');
}

function walk(items: PostmanItem[], visit: (item: PostmanItem, folder: PostmanItem[], trail: string[]) => void, trail: string[] = []): void {
  for (const item of items) {
    if (item.item === undefined)
      visit(item, items, trail);
    else
      walk(item.item, visit, [...trail, item.name]);
  }
}

function folderAt(collection: Collection, trail: string[]): PostmanItem[] {
  let level = collection.item;

  for (const name of trail) {
    let folder = level.find(i => i.name === name && i.item !== undefined);
    if (folder === undefined) {
      folder = { name, item: [] };
      level.push(folder);
    }

    level = folder.item!;
  }

  return level;
}

// ─── run ──────────────────────────────────────────────────────────────────────

const spec = await fetch(SPEC_URL).then(async (r) => {
  if (!r.ok)
    throw new Error(`${SPEC_URL} answered ${r.status}. Is the API running?`);

  return r.json() as Promise<Spec>;
});

const collection = JSON.parse(await fs.readFile(FILE, 'utf8')) as Collection;

const present = new Set<string>();
const folderOfSegment = new Map<string, string[]>();
walk(collection.item, (item, _folder, trail) => {
  const route = routeOf(item);
  if (route === null)
    return;

  present.add(keyOf(item.request!.method, route));

  const segment = route.split('/')[3] ?? '';
  if (segment !== '' && !folderOfSegment.has(segment))
    folderOfSegment.set(segment, trail);
});

const live = new Set<string>();
const added: string[] = [];

for (const [route, operations] of Object.entries(spec.paths)) {
  if (!route.startsWith('/api/v1/'))
    continue;

  for (const method of METHODS) {
    const op = operations[method];
    if (op === undefined)
      continue;

    const key = keyOf(method, route);
    live.add(key);
    if (present.has(key))
      continue;

    const segment = route.split('/')[3]!;
    const tag = op.tags?.[0] ?? segment;
    const trail = folderOfSegment.get(segment)
      ?? [tag.charAt(0).toUpperCase() + tag.slice(1)];

    folderAt(collection, trail).push(itemFor(method, route, op, spec));
    folderOfSegment.set(segment, trail);
    added.push(`${key}  →  ${trail.join(' / ')}`);
  }
}

const stale = [...present].filter(key => !live.has(key));

console.log(`${added.length} added, ${stale.length} stale, ${present.size} already in the collection\n`);
for (const line of added)
  console.log(`  + ${line}`);

if (stale.length > 0) {
  console.log('\nStill in the collection, no longer served — a rename needs fixing by hand:');
  for (const key of stale)
    console.log(`  ! ${key}`);
}

// Every {{variable}} the new requests lean on has to exist, or Postman sends
// the literal text and the route answers 400 on a malformed uuid.
const environment = JSON.parse(await fs.readFile(ENV_FILE, 'utf8')) as { values: Array<{ key: string; value: string; type: string; enabled?: boolean }> };
const known = new Set(environment.values.map(v => v.key));
const wanted = new Set<string>();
walk(collection.item, (item) => {
  for (const match of (item.request?.url.raw ?? '').matchAll(/\{\{(\w+)\}\}/g))
    wanted.add(match[1]!);
});

const missingVars = [...wanted].filter(key => !known.has(key)).sort();
for (const key of missingVars)
  environment.values.push({ key, value: '', type: 'default', enabled: true });

if (missingVars.length > 0)
  console.log(`\nAdded ${missingVars.length} empty environment variable(s): ${missingVars.join(', ')}`);

if (flag('dry')) {
  console.log('\n--dry: nothing written.');
}
else {
  await fs.writeFile(FILE, `${JSON.stringify(collection, null, 2)}\n`);
  if (missingVars.length > 0)
    await fs.writeFile(ENV_FILE, `${JSON.stringify(environment, null, 2)}\n`);

  console.log(`\nWrote ${path.relative(process.cwd(), FILE)}`);
}
