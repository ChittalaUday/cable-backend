/**
 * Give every channel a logo the app can actually render.
 *
 * Each logo is fetched once from Wikipedia, pushed into OUR object store through
 * the same `StorageService` the API uses, and the channel row is pointed at the
 * resulting public URL. Nothing ends up hotlinking someone else's server: the
 * upstream address is used once, at seed time, and never again.
 *
 *   pnpm db:seed:channel-logos           # only channels with no logo yet
 *   pnpm db:seed:channel-logos --force   # re-fetch every channel
 *
 * Network work is best-effort per channel. One broadcaster Wikipedia has never
 * heard of must not take the other thirty-seven down with it, so every failure
 * is counted and reported at the end rather than thrown.
 */
import type { Database } from '@/plugins/database';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { Readable } from 'node:stream';
import { asc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import * as schema from '@/db/schema';
import { channels } from '@/db/schema';
import { createStorageProvider, createStorageService, publicUrlFor } from '@/modules/storage/storage.service';

/** Wikipedia is slow often enough that an unbounded wait would hang the seed. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Logos are small. Anything this big is a photograph we have matched by mistake. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/gif': '.gif',
};

/**
 * The Wikipedia article a channel's logo lives on.
 *
 * Searching by channel name alone lands on the wrong article often enough to be
 * useless — "Colors", "MTV" and "99 TV" are all ambiguous — so the mapping is
 * explicit. A channel that is absent here is looked up by name and reported if
 * that misses, which is the honest outcome: better a missing logo than the wrong
 * broadcaster's.
 */
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
    // Wikimedia blocks unidentified clients, and asks that tools say who they
    // are: https://meta.wikimedia.org/wiki/User-Agent_policy
    headers: { 'user-agent': 'cable-backend-seeder/1.0 (channel logo seeding; contact: ops@satyacable.local)' },
  });

  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);

  return response.json();
}

/**
 * Shorthand the MSO's lineup export uses, which no encyclopedia indexes.
 *
 * Whole tokens only: `SS 1 HD HINDI` is Star Sports 1, but a channel with "ss"
 * inside a word is not.
 */
const ABBREVIATION: Record<string, string> = {
  SS: 'Star Sports',
  COL: 'Colors',
  CNPLX: 'Cineplex',
  SET: 'Sony Entertainment Television',
  NAT: 'National',
  GEO: 'Geographic',
};

/** Carried on the row to say what a feed is, never part of the channel's name. */
const QUALITY_TOKENS = new Set(['HD', 'SD', 'UHD', '4K', 'HD+']);

/** Too generic to prove a search result is the right article. */
const WEAK_TOKENS = new Set(['TV', 'THE', 'CHANNEL', 'INDIA', 'INDIAN', 'NEWS', 'MOVIES', 'HD', 'SD']);

/**
 * The lineup name turned into something worth searching for.
 *
 * The export is upper-case and abbreviated — `COL CNPLX SUPERHITS`, `SS 1 HD
 * HINDI` — which matches nothing as written.
 */
function searchTermFor(name: string): string {
  const tokens = name
    .toUpperCase()
    .replace(/[^\w\s&+]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const expanded = tokens
    .filter(token => !QUALITY_TOKENS.has(token))
    .map(token => ABBREVIATION[token] ?? token);

  // Everything after the last quality token is usually a language feed
  // ("SS 1 HD HINDI"), which the article does not carry either way.
  return expanded.join(' ').trim();
}

function significantTokens(value: string): string[] {
  return value
    .toUpperCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3 && !WEAK_TOKENS.has(token));
}

/**
 * Is this search hit actually the channel, or the first thing Wikipedia had?
 *
 * A wrong logo is worse than none — it is wrong in a way nobody notices until a
 * subscriber does — so a hit has to share a real word with the channel name.
 * Names made only of weak or short tokens have nothing to prove, and are let
 * through on the search engine's judgement.
 */
function plausible(channelName: string, articleTitle: string): boolean {
  const wanted = significantTokens(channelName);
  if (wanted.length === 0)
    return true;

  const found = new Set(significantTokens(articleTitle));
  return wanted.some(token => found.has(token));
}

/**
 * Article titles that might be this channel, best first.
 *
 * Search rather than an exact title lookup: the lineup export is upper-case and
 * inconsistently spelled, and `titles=` is case-sensitive past the first letter,
 * so `STAR GOLD HD` resolves to nothing at all.
 */
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

/**
 * The lead image of an article, via the REST summary endpoint.
 *
 * NOT `prop=pageimages`, which is the obvious choice and the wrong one: it skips
 * non-free files, and a broadcaster's logo is almost always uploaded locally
 * under fair use rather than to Commons. `pageimages` reports no image at all
 * for Aaj Tak, Star Gold and most of this lineup, while the summary endpoint
 * returns the logo for every one of them.
 */
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
