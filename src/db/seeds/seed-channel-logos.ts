import type { Database } from '@/db/client';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { Readable } from 'node:stream';
import { asc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import * as schema from '@/db/schema';
import { channels } from '@/db/schema';
import { createStorageProvider, createStorageService, publicUrlFor } from '@/services/storage/storage.service';

const REQUEST_TIMEOUT_MS = 15_000;

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/gif': '.gif',
};

const WIKIPEDIA_TITLE: Record<string, string> = {
  'etv-telugu': 'ETV (Telugu TV channel)',
  'gemini-tv': 'Gemini TV',
  'maa-tv': 'Star Maa',
  'maa-tv-hd': 'Star Maa',
  'zee-telugu': 'Zee Telugu',
  'tv9-telugu': 'TV9 Telugu',
  'ntv-telugu': 'NTV (Indian TV channel)',
  'sakshi-tv': 'Sakshi TV',
  '10tv-telugu': '10TV',
  'abn-telugu': 'ABN Andhrajyothi',
  'tv5-telugu': 'TV5 (Indian TV channel)',
  '99-tv': '99TV',
  'gemini-movies': 'Gemini Movies',
  'cnbc-awaaz': 'CNBC Awaaz',
  'colors': 'Colors TV',
  'colors-rishtey': 'Rishtey',
  'colors-cineplex': 'Colors Cineplex',
  'colors-cineplex-bollywood': 'Colors Cineplex',
  'colors-cineplex-superhits': 'Colors Cineplex',
  'mtv': 'MTV India',
  'sony-wah': 'Sony Wah',
  'sony-pal': 'Sony Pal',
  'sony-max-2': 'Sony Max 2',
  'set-hd': 'Sony Entertainment Television',
  'sony-sab-hd': 'Sony SAB',
  'zing': 'Zing (TV channel)',
  'history-channel': 'History (Indian TV channel)',
  'movies-now': 'Movies Now',
  'star-movies': 'Star Movies',
  'star-sports-1': 'Star Sports',
  'star-sports-2': 'Star Sports',
  'star-sports-2-hd': 'Star Sports',
  'star-sports-2-telugu': 'Star Sports',
  'sony-sports-ten-5': 'Sony Sports Network',
  'sony-sports-ten-4-telugu': 'Sony Sports Network',
  'sony-sports-ten-3-hd': 'Sony Sports Network',
};

interface RemoteImage {
  url: string;
  bytes: Buffer;
  contentType: string;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'user-agent': 'cable-backend-seeder/1.0 (channel logo seeding; contact: ops@satyacable.local)' },
  });

  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);

  return response.json();
}

const ABBREVIATION: Record<string, string> = {
  SS: 'Star Sports',
  COL: 'Colors',
  CNPLX: 'Cineplex',
  SET: 'Sony Entertainment Television',
  NAT: 'National',
  GEO: 'Geographic',
};

const QUALITY_TOKENS = new Set(['HD', 'SD', 'UHD', '4K', 'HD+']);

const WEAK_TOKENS = new Set(['TV', 'THE', 'CHANNEL', 'INDIA', 'INDIAN', 'NEWS', 'MOVIES', 'HD', 'SD']);

function searchTermFor(name: string): string {
  const tokens = name
    .toUpperCase()
    .replace(/[^\w\s&+]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const expanded = tokens
    .filter(token => !QUALITY_TOKENS.has(token))
    .map(token => ABBREVIATION[token] ?? token);

  return expanded.join(' ').trim();
}

function significantTokens(value: string): string[] {
  return value
    .toUpperCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3 && !WEAK_TOKENS.has(token));
}

function plausible(channelName: string, articleTitle: string): boolean {
  const wanted = significantTokens(channelName);
  if (wanted.length === 0)
    return true;

  const found = new Set(significantTokens(articleTitle));
  return wanted.some(token => found.has(token));
}

async function searchTitles(term: string): Promise<string[]> {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', `${term} television channel`);
  url.searchParams.set('srlimit', '4');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');

  const body = await getJson(url.toString()) as { query?: { search?: { title?: string }[] } };

  return (body.query?.search ?? [])
    .map(hit => hit.title)
    .filter((title): title is string => title !== undefined);
}

async function articleImage(title: string): Promise<string | null> {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;

  const body = await getJson(url) as {
    thumbnail?: { source?: string };
    originalimage?: { source?: string };
  };

  return body.thumbnail?.source ?? body.originalimage?.source ?? null;
}

async function findLogo(channelName: string, term: string): Promise<{ url: string; title: string } | null> {
  for (const title of await searchTitles(term)) {
    if (!plausible(channelName, title))
      continue;

    const source = await articleImage(title).catch(() => null);
    if (source !== null)
      return { url: source, title };
  }

  return null;
}

async function download(url: string): Promise<RemoteImage> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'user-agent': 'cable-backend-seeder/1.0 (channel logo seeding; contact: ops@satyacable.local)' },
  });

  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
  if (!contentType.startsWith('image/'))
    throw new Error(`not an image (${contentType || 'no content-type'})`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0)
    throw new Error('empty response');
  if (bytes.length > MAX_LOGO_BYTES)
    throw new Error(`${bytes.length} bytes is larger than a logo should be`);

  return { url, bytes, contentType };
}

async function seedChannelLogos(db: Database, force: boolean): Promise<void> {
  const provider = createStorageProvider();
  if (!provider.configured)
    throw new Error('Object storage is not configured — set R2_* in .env before seeding logos.');

  if (publicUrlFor('probe') === null)
    throw new Error('R2_PUBLIC_BASE_URL is empty. Without it there is no durable URL to store on a channel (signed URLs expire in minutes).');

  const storage = createStorageService(db, provider);

  const rows = await db.select({
    id: channels.id,
    tenantId: channels.tenantId,
    name: channels.name,
    slug: channels.slug,
  })
    .from(channels)
    .where(force ? undefined : isNull(channels.logoUrl))
    .orderBy(asc(channels.channelNumber));

  if (rows.length === 0) {
    console.log('ℹ️ Every channel already has a logo. Re-run with --force to replace them.');
    return;
  }

  console.log(`🔎 ${rows.length} channel(s) to fetch logos for`);

  let uploaded = 0;
  let reused = 0;
  const missed: string[] = [];

  for (const channel of rows) {
    const term = WIKIPEDIA_TITLE[channel.slug] ?? searchTermFor(channel.name);

    try {
      const found = await findLogo(channel.name, term);
      if (found === null) {
        missed.push(`${channel.name} — nothing on Wikipedia for "${term}"`);
        continue;
      }

      const image = await download(found.url);
      const extension = CONTENT_TYPE_EXTENSION[image.contentType] ?? '.png';

      const result = await storage.uploadWithLocalStaging({
        tenantId: channel.tenantId,
        uploadedBy: null,
        originalName: `${channel.slug}-logo${extension}`,
        contentType: image.contentType,
        folder: 'logos',
        kind: 'upload',
        visibility: 'public',
        metadata: { channelId: channel.id, channelSlug: channel.slug, sourceUrl: image.url, wikipediaTitle: found.title },
        stream: Readable.from(image.bytes),
      });

      const logoUrl = publicUrlFor(result.file.storageKey)!;
      await db.update(channels).set({ logoUrl, updatedAt: new Date() }).where(eq(channels.id, channel.id));

      if (result.deduplicated)
        reused += 1;
      else
        uploaded += 1;

      console.log(`  ✔ ${channel.name}  ←  ${found.title}${result.deduplicated ? ' (reused an identical file)' : ''}`);
    }
    catch (error) {
      missed.push(`${channel.name} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n✅ ${uploaded} uploaded, ${reused} deduplicated, ${missed.length} without a logo`);

  if (missed.length > 0) {
    console.log('\n⚠️ No logo for:');
    for (const line of missed)
      console.log(`  - ${line}`);
    console.log('\nAdd the right article to WIKIPEDIA_TITLE in this file and re-run.');
  }
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
const db = drizzle(pool, { schema });

seedChannelLogos(db, process.argv.includes('--force'))
  .catch((error) => {
    console.error('❌ Channel logo seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
