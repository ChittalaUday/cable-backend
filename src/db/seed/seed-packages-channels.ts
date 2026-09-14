import type { BillingCycle, ChannelGenre, ChannelResolution, PackageType } from '@/shared/constants/crm';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import {
  channels,
  packageChannels,
  packages,
  serviceProviders,
  subscriptions,
  tenants,
} from '@/db/schema';

const DEFAULT_CSV_PATH = path.resolve(process.cwd(), 'data/act_C2602498_channels_detail_20260913_195426.csv');

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function inferBroadcaster(name: string): string | null {
  const upper = name.toUpperCase();
  if (upper.includes('ETV')) {
    return 'ETV Network';
  }
  if (upper.includes('GEMINI') || upper.includes('SUN ')) {
    return 'Sun Network';
  }
  if (upper.includes('MAA ') || upper.includes('STAR ') || upper.includes('DISNEY') || upper.includes('ASIANET') || upper.includes('VIJAY')) {
    return 'Disney Star';
  }
  if (upper.includes('ZEE') || upper.includes('&PICTURES') || upper.includes('&TV') || upper.includes('& PICTURES') || upper.includes('& TV') || upper.includes('ZING')) {
    return 'Zee Entertainment';
  }
  if (upper.includes('COLORS') || upper.includes('MTV') || upper.includes('NICK') || upper.includes('SONIC') || upper.includes('COMEDY CENTRAL') || upper.includes('VH1')) {
    return 'Viacom18';
  }
  if (upper.includes('SONY') || upper.includes('SET ') || upper === 'SET' || upper.includes('SAB') || upper.includes('WAH') || upper.includes('PAL') || upper.includes('MAX')) {
    return 'Sony Pictures Networks';
  }
  if (upper.startsWith('DD ') || upper === 'DD' || upper.includes('SANSAD') || upper.includes('DOORDARSHAN')) {
    return 'Prasar Bharati';
  }
  if (upper.includes('TIMES') || upper.includes('MIRROR') || upper.includes('ZOOM')) {
    return 'Times Network';
  }
  if (upper.includes('CNN') || upper.includes('CNBC') || upper.includes('NEWS18')) {
    return 'Network18';
  }
  if (upper.includes('TV9')) {
    return 'Associated Broadcasting';
  }
  if (upper.includes('NTV')) {
    return 'Rachana Television';
  }
  if (upper.includes('SAKSHI')) {
    return 'Indira Television';
  }
  if (upper.includes('ABN')) {
    return 'Amod Publications';
  }
  if (upper.includes('TV5')) {
    return 'Shreya Broadcasting';
  }
  if (upper.includes('10TV')) {
    return 'Spoorthi Communications';
  }
  if (upper.includes('DISCOVERY') || upper.includes('ANIMAL PLANET') || upper.includes('TLC') || upper.includes('CARTOON NETWORK') || upper.includes('POGO') || upper.includes('EUROSPORT')) {
    return 'Warner Bros. Discovery';
  }
  if (upper.includes('NDTV')) {
    return 'NDTV';
  }
  if (upper.includes('AAJ TAK') || upper.includes('INDIA TODAY') || upper.includes('TEZ')) {
    return 'TV Today Network';
  }
  if (upper.includes('B4U')) {
    return 'B4U Broadband';
  }
  return null;
}

export function mapGenre(category: string, channelName: string): ChannelGenre {
  const catLower = category.toLowerCase().trim();
  if (catLower === 'news') {
    return 'News';
  }
  if (catLower === 'entertainment') {
    return 'Entertainment';
  }
  if (catLower === 'movies') {
    return 'Movies';
  }
  if (catLower === 'music') {
    return 'Music';
  }
  if (catLower === 'kids') {
    return 'Kids';
  }
  if (catLower === 'sports') {
    return 'Sports';
  }
  if (catLower === 'knowledge' || catLower === 'lifestyle') {
    return 'Infotainment';
  }
  if (catLower === 'religious') {
    return 'Devotional';
  }

  const nameUpper = channelName.toUpperCase();
  if (nameUpper.includes('NEWS') || nameUpper.includes('TV9') || nameUpper.includes('NTV') || nameUpper.includes('ABN')) {
    return 'News';
  }
  if (nameUpper.includes('CINEMA') || nameUpper.includes('MOVIES') || nameUpper.includes('FILM') || nameUpper.includes('TALKIES')) {
    return 'Movies';
  }
  if (nameUpper.includes('MUSIC') || nameUpper.includes('BEATS')) {
    return 'Music';
  }
  if (nameUpper.includes('BHAKTI') || nameUpper.includes('DIVYA') || nameUpper.includes('PRARTHANA') || nameUpper.includes('SAI')) {
    return 'Devotional';
  }
  if (nameUpper.includes('SPORTS')) {
    return 'Sports';
  }

  return 'General';
}

export function inferBillingCycle(name: string): BillingCycle {
  const upper = name.toUpperCase();
  if (upper.includes('_03_') || upper.includes('03 MONTHS') || upper.includes('3 MONTHS') || upper.includes('03_MONTHS')) {
    return 'quarterly';
  }
  if (upper.includes('_06_') || upper.includes('_06+') || upper.includes('06 MONTHS') || upper.includes('6 MONTHS') || upper.includes('06_MONTHS')) {
    return 'semi_annual';
  }
  if (upper.includes('_12_') || upper.includes('_12+') || upper.includes('12 MONTHS') || upper.includes('12_MONTHS')) {
    return 'annual';
  }
  return 'monthly';
}

export function normalizeLanguages(language: string, category: string): string[] {
  const rawLang = language.trim();
  const langs = new Set<string>();

  if (rawLang.toLowerCase() === 'multilanguage') {
    langs.add('MultiLanguage');
  }
  else if (rawLang.toLowerCase() === 'bangla') {
    langs.add('Bengali');
  }
  else if (rawLang.toLowerCase() === 'gujarathi') {
    langs.add('Gujarati');
  }
  else if (rawLang.length > 0) {
    langs.add(rawLang);
  }

  const langCategories = ['Telugu', 'Tamil', 'Kannada', 'Bengali', 'Marathi', 'Malayalam', 'Punjabi', 'Kashmiri'];
  for (const lc of langCategories) {
    if (category.trim().toLowerCase() === lc.toLowerCase()) {
      langs.add(lc);
    }
  }

  if (langs.size === 0) {
    langs.add('Telugu');
  }

  return Array.from(langs);
}

interface ParsedRow {
  accountNumber: string;
  section: string;
  packageId: string;
  packageName: string;
  price: string;
  channelName: string;
  language: string;
  category: string;
  type: string;
}

interface ParsedChannel {
  name: string;
  slug: string;
  genre: ChannelGenre;
  languages: string[];
  resolution: ChannelResolution;
  isFta: boolean;
  broadcaster: string | null;
  price: string;
  category: string;
  type: string;
}

interface ParsedPackage {
  msoPackageId: string;
  name: string;
  slug: string;
  section: string;
  price: string;
  packageType: PackageType;
  billingCycle: BillingCycle;
  channelSlugs: Set<string>;
}

export async function parseChannelsDetailCsv(csvPath: string = DEFAULT_CSV_PATH) {
  const fileStream = fs.createReadStream(csvPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const channelsBySlug = new Map<string, ParsedChannel>();
  const packagesById = new Map<string, ParsedPackage>();
  const alacartePrices = new Map<string, string>();
  const packageChannelPairs: Array<{ msoPackageId: string; channelSlug: string }> = [];

  let lineCount = 0;
  for await (const line of rl) {
    lineCount++;
    if (lineCount === 1) {
      continue;
    }
    const parts = line.split(',');
    if (parts.length < 9) {
      continue;
    }

    const row: ParsedRow = {
      accountNumber: parts[0]!.trim(),
      section: parts[1]!.trim(),
      packageId: parts[2]!.trim(),
      packageName: parts[3]!.trim(),
      price: parts[4]!.trim(),
      channelName: parts[5]!.trim(),
      language: parts[6]!.trim(),
      category: parts[7]!.trim(),
      type: parts[8]!.trim(),
    };

    const cSlug = slugify(row.channelName);
    const pSlug = slugify(row.packageName);

    if (row.section === 'Alacarte') {
      alacartePrices.set(cSlug, row.price);
    }

    if (!channelsBySlug.has(cSlug)) {
      const isHd = /\bHD\b|\bHD\+/i.test(row.channelName);
      const is4k = /\b4K\b/i.test(row.channelName);
      const resolution: ChannelResolution = is4k ? '4K' : isHd ? 'HD' : 'SD';

      channelsBySlug.set(cSlug, {
        name: row.channelName,
        slug: cSlug,
        genre: mapGenre(row.category, row.channelName),
        languages: normalizeLanguages(row.language, row.category),
        resolution,
        isFta: row.type.toUpperCase() === 'FTA',
        broadcaster: inferBroadcaster(row.channelName),
        price: '0.00',
        category: row.category,
        type: row.type,
      });
    }

    if (!packagesById.has(row.packageId)) {
      let packageType: PackageType = 'base';
      if (row.section === 'Base Package') {
        packageType = 'base';
      }
      else if (row.section === 'Alacarte') {
        packageType = 'ala_carte';
      }
      else if (row.section === 'Addons') {
        packageType = 'bouquet';
      }

      packagesById.set(row.packageId, {
        msoPackageId: row.packageId,
        name: row.packageName,
        slug: pSlug,
        section: row.section,
        price: row.price,
        packageType,
        billingCycle: inferBillingCycle(row.packageName),
        channelSlugs: new Set(),
      });
    }

    packagesById.get(row.packageId)!.channelSlugs.add(cSlug);
    packageChannelPairs.push({ msoPackageId: row.packageId, channelSlug: cSlug });
  }

  for (const [cSlug, ch] of channelsBySlug.entries()) {
    if (alacartePrices.has(cSlug)) {
      ch.price = alacartePrices.get(cSlug)!;
    }
  }

  return {
    channels: Array.from(channelsBySlug.values()),
    packages: Array.from(packagesById.values()),
    packageChannelPairs,
  };
}

export interface SeedOptions {
  db: ReturnType<typeof drizzle>;
  tenantId: string;
  cableProviderId: string;
  csvPath?: string;
}

export async function seedPackagesAndChannels({
  db,
  tenantId,
  cableProviderId,
  csvPath = DEFAULT_CSV_PATH,
}: SeedOptions) {
  console.log(`\n📦 Parsing CSV data from ${csvPath}...`);
  const { channels: parsedChannels, packages: parsedPackages, packageChannelPairs } = await parseChannelsDetailCsv(csvPath);

  console.log(`Found ${parsedChannels.length} unique channels and ${parsedPackages.length} unique packages in CSV.`);

  // ─── 1. Seed / Update Channels (No Duplicates) ─────────────────────────────
  console.log('🔄 Checking existing channels in database...');
  const existingDbChannels = await db
    .select()
    .from(channels)
    .where(eq(channels.serviceProviderId, cableProviderId));

  const existingBySlug = new Map(existingDbChannels.map(c => [c.slug, c]));
  const usedChannelNumbers = new Set(existingDbChannels.map(c => c.channelNumber));

  const channelMap = new Map<string, string>();
  let updatedChannelsCount = 0;
  let insertedChannelsCount = 0;

  let nextChannelNum = 209;
  const getNextAvailableNumber = () => {
    while (usedChannelNumbers.has(nextChannelNum)) {
      nextChannelNum++;
    }
    usedChannelNumbers.add(nextChannelNum);
    return nextChannelNum;
  };

  for (const pc of parsedChannels) {
    const existing = existingBySlug.get(pc.slug);
    if (existing) {
      channelMap.set(pc.slug, existing.id);
      await db
        .update(channels)
        .set({
          name: pc.name,
          genre: pc.genre,
          languages: pc.languages,
          resolution: pc.resolution,
          isFta: pc.isFta,
          broadcaster: pc.broadcaster ?? existing.broadcaster,
          price: pc.price !== '0.00' ? pc.price : existing.price,
          status: 'active',
          metadata: {
            msoCategory: pc.category,
            msoType: pc.type,
            providerLcn: existing.channelNumber,
          },
          updatedAt: new Date(),
        })
        .where(eq(channels.id, existing.id));
      updatedChannelsCount++;
    }
  }

  const newChannelsToInsert = parsedChannels.filter(pc => !existingBySlug.has(pc.slug));
  const channelInsertRows = newChannelsToInsert.map((pc) => {
    const chNum = getNextAvailableNumber();
    return {
      tenantId,
      serviceProviderId: cableProviderId,
      channelNumber: chNum,
      name: pc.name,
      slug: pc.slug,
      genre: pc.genre,
      languages: pc.languages,
      resolution: pc.resolution,
      isFta: pc.isFta,
      broadcaster: pc.broadcaster,
      price: pc.price,
      status: 'active' as const,
      metadata: {
        msoCategory: pc.category,
        msoType: pc.type,
        providerLcn: chNum,
      },
    };
  });

  const CHUNK_SIZE = 100;
  for (let i = 0; i < channelInsertRows.length; i += CHUNK_SIZE) {
    const chunk = channelInsertRows.slice(i, i + CHUNK_SIZE);
    const inserted = await db
      .insert(channels)
      .values(chunk)
      .onConflictDoUpdate({
        target: [channels.serviceProviderId, channels.slug],
        set: {
          name: sql`excluded.name`,
          genre: sql`excluded.genre`,
          languages: sql`excluded.languages`,
          resolution: sql`excluded.resolution`,
          isFta: sql`excluded.is_fta`,
          broadcaster: sql`excluded.broadcaster`,
          price: sql`excluded.price`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: channels.id, slug: channels.slug });

    for (const row of inserted) {
      channelMap.set(row.slug, row.id);
      insertedChannelsCount++;
    }
  }

  console.log(`✅ Channels: ${updatedChannelsCount} updated, ${insertedChannelsCount} inserted (Total: ${channelMap.size})`);

  // ─── 2. Seed / Update Packages (No Duplicates) ─────────────────────────────
  console.log('🔄 Checking existing packages in database...');
  const existingDbPackages = await db
    .select()
    .from(packages)
    .where(eq(packages.serviceProviderId, cableProviderId));

  const existingPkgBySlug = new Map(existingDbPackages.map(p => [p.slug, p]));
  const packageMap = new Map<string, string>();

  let updatedPackagesCount = 0;
  let insertedPackagesCount = 0;

  for (const pkg of parsedPackages) {
    const existing = existingPkgBySlug.get(pkg.slug);
    if (existing) {
      packageMap.set(pkg.msoPackageId, existing.id);
      await db
        .update(packages)
        .set({
          name: pkg.name,
          packageType: pkg.packageType,
          price: pkg.price,
          msoShare: pkg.price,
          billingCycle: pkg.billingCycle,
          description: `ACT Digital ${pkg.section} (${pkg.name}) with ${pkg.channelSlugs.size} channels`,
          metadata: {
            msoPackageId: pkg.msoPackageId,
            section: pkg.section,
            originalName: pkg.name,
            totalChannels: pkg.channelSlugs.size,
          },
          updatedAt: new Date(),
        })
        .where(eq(packages.id, existing.id));
      updatedPackagesCount++;
    }
  }

  const newPackagesToInsert = parsedPackages.filter(pkg => !existingPkgBySlug.has(pkg.slug));
  const packageInsertRows = newPackagesToInsert.map(pkg => ({
    tenantId,
    serviceProviderId: cableProviderId,
    name: pkg.name,
    slug: pkg.slug,
    packageType: pkg.packageType,
    price: pkg.price,
    discount: '0.00',
    msoShare: pkg.price,
    taxRate: '18.00',
    billingCycle: pkg.billingCycle,
    description: `ACT Digital ${pkg.section} (${pkg.name}) with ${pkg.channelSlugs.size} channels`,
    metadata: {
      msoPackageId: pkg.msoPackageId,
      section: pkg.section,
      originalName: pkg.name,
      totalChannels: pkg.channelSlugs.size,
    },
    status: 'active' as const,
  }));

  for (let i = 0; i < packageInsertRows.length; i += CHUNK_SIZE) {
    const chunk = packageInsertRows.slice(i, i + CHUNK_SIZE);
    const inserted = await db
      .insert(packages)
      .values(chunk)
      .onConflictDoUpdate({
        target: [packages.serviceProviderId, packages.slug],
        set: {
          name: sql`excluded.name`,
          price: sql`excluded.price`,
          msoShare: sql`excluded.mso_share`,
          billingCycle: sql`excluded.billing_cycle`,
          packageType: sql`excluded.package_type`,
          metadata: sql`excluded.metadata`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: packages.id, slug: packages.slug, metadata: packages.metadata });

    for (const row of inserted) {
      const meta = row.metadata as { msoPackageId?: string } | null;
      if (meta?.msoPackageId !== undefined) {
        packageMap.set(meta.msoPackageId, row.id);
      }
      insertedPackagesCount++;
    }
  }

  console.log(`✅ Packages: ${updatedPackagesCount} updated, ${insertedPackagesCount} inserted (Total: ${packageMap.size})`);

  // ─── 3. Seed Package Channels (No Duplicates) ──────────────────────────────
  console.log('🔄 Seeding package-channel mappings...');
  const seenPairKeys = new Set<string>();
  const packageChannelRows: Array<{ packageId: string; channelId: string; isMandatory: boolean }> = [];

  for (const pair of packageChannelPairs) {
    const pkgId = packageMap.get(pair.msoPackageId);
    const chId = channelMap.get(pair.channelSlug);

    if (pkgId === undefined || chId === undefined) {
      continue;
    }

    const key = `${pkgId}:::${chId}`;
    if (seenPairKeys.has(key)) {
      continue;
    }
    seenPairKeys.add(key);

    packageChannelRows.push({
      packageId: pkgId,
      channelId: chId,
      isMandatory: true,
    });
  }

  let mappedCount = 0;
  const PC_CHUNK_SIZE = 500;
  for (let i = 0; i < packageChannelRows.length; i += PC_CHUNK_SIZE) {
    const chunk = packageChannelRows.slice(i, i + PC_CHUNK_SIZE);
    await db
      .insert(packageChannels)
      .values(chunk)
      .onConflictDoNothing({ target: [packageChannels.packageId, packageChannels.channelId] });
    mappedCount += chunk.length;
  }

  console.log(`✅ Seeded ${mappedCount} unique package-channel links without duplicates.`);

  // ─── 4. Synchronize Subscriptions with Real Packages ─────────────────────────
  console.log('🔄 Synchronizing customer subscriptions with real packages...');
  const csvPkgSlugs = new Set(parsedPackages.map(p => p.slug));
  const currentDbPackages = await db
    .select()
    .from(packages)
    .where(and(
      eq(packages.serviceProviderId, cableProviderId),
      inArray(packages.slug, Array.from(csvPkgSlugs)),
    ));

  const pkgsBySlug = new Map(currentDbPackages.map(p => [p.slug, p]));
  const pkgsByName = new Map(currentDbPackages.map(p => [p.name.toLowerCase().trim(), p]));
  const defaultBasePkg = pkgsBySlug.get('act-bst-pre-viz') ?? pkgsBySlug.get('act-ultimate-pre-viz') ?? currentDbPackages[0]!;

  const resolvePkgForRawString = (rawString: string) => {
    if (rawString.length === 0) {
      return defaultBasePkg;
    }
    const parts = rawString.split(',').map(s => s.trim()).filter(s => s.length > 0);

    // Look for Base Packages
    for (const part of parts) {
      const p = pkgsByName.get(part.toLowerCase()) ?? pkgsBySlug.get(slugify(part));
      if (p !== undefined && p.packageType === 'base') {
        return p;
      }
    }

    // Look for BST or Bronze alias
    for (const part of parts) {
      if (/bst|bronze/i.test(part)) {
        return defaultBasePkg;
      }
    }

    // Look for Ultimate or Smart HD
    for (const part of parts) {
      if (/ultimate/i.test(part)) {
        const p = pkgsBySlug.get('act-ultimate-pre-viz');
        if (p !== undefined) {
          return p;
        }
      }
      if (/smart.*hd/i.test(part)) {
        const p = pkgsBySlug.get('act-smart-hd-pre-viz');
        if (p !== undefined) {
          return p;
        }
      }
    }

    // Look for any bouquet / alacarte mentioned
    for (const part of parts) {
      const p = pkgsByName.get(part.toLowerCase()) ?? pkgsBySlug.get(slugify(part));
      if (p !== undefined) {
        return p;
      }
    }

    return defaultBasePkg;
  };

  const cableSubs = await db
    .select({ id: subscriptions.id, metadata: subscriptions.metadata })
    .from(subscriptions)
    .where(eq(subscriptions.serviceProviderId, cableProviderId));

  let updatedSubsCount = 0;
  for (const sub of cableSubs) {
    const raw = ((sub.metadata as { rawPackageString?: string } | null)?.rawPackageString ?? '').trim();
    const resolved = resolvePkgForRawString(raw);

    await db
      .update(subscriptions)
      .set({
        packageId: resolved.id,
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, sub.id));
    updatedSubsCount++;
  }
  console.log(`✅ Synchronized ${updatedSubsCount} subscriptions to point to verified packages.`);

  // ─── 5. Delete Old / Obsolete Data not present in CSV ────────────────────────
  console.log('🧹 Cleaning up old obsolete mock packages and channels...');
  const csvChSlugs = new Set(parsedChannels.map(c => c.slug));

  const allProviderChannels = await db
    .select({ id: channels.id, slug: channels.slug })
    .from(channels)
    .where(eq(channels.serviceProviderId, cableProviderId));

  const channelsToDelete = allProviderChannels.filter(c => !csvChSlugs.has(c.slug));
  if (channelsToDelete.length > 0) {
    const deleteIds = channelsToDelete.map(c => c.id);
    await db.delete(channels).where(inArray(channels.id, deleteIds));
    console.log(`🗑️  Deleted ${channelsToDelete.length} obsolete mock channels (${channelsToDelete.map(c => c.slug).join(', ')})`);
  }

  const allProviderPackages = await db
    .select({ id: packages.id, slug: packages.slug })
    .from(packages)
    .where(eq(packages.serviceProviderId, cableProviderId));

  const packagesToDelete = allProviderPackages.filter(p => !csvPkgSlugs.has(p.slug));
  if (packagesToDelete.length > 0) {
    const deleteIds = packagesToDelete.map(p => p.id);
    await db.delete(packages).where(inArray(packages.id, deleteIds));
    console.log(`🗑️  Deleted ${packagesToDelete.length} obsolete mock packages (${packagesToDelete.map(p => p.slug).join(', ')})`);
  }

  return {
    channelsCount: channelMap.size,
    packagesCount: packageMap.size,
    packageChannelsCount: mappedCount,
    updatedSubscriptionsCount: updatedSubsCount,
    deletedOldChannelsCount: channelsToDelete.length,
    deletedOldPackagesCount: packagesToDelete.length,
  };
}

async function main() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  const db = drizzle(pool);

  try {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.code, 'SSCN'));
    if (tenant === undefined) {
      throw new Error('Tenant SSCN not found! Run pnpm db:seed first.');
    }

    const [cableProvider] = await db
      .select()
      .from(serviceProviders)
      .where(and(eq(serviceProviders.tenantId, tenant.id), eq(serviceProviders.slug, 'act-digital')));

    if (cableProvider === undefined) {
      throw new Error('ACT Digital service provider not found! Run pnpm db:seed:mso first.');
    }

    const result = await seedPackagesAndChannels({ db, tenantId: tenant.id, cableProviderId: cableProvider.id });
    console.log('\n🎉 Successfully finished seeding packages and channels!');
    console.log(JSON.stringify(result, null, 2));
  }
  finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('seed-packages-channels.ts') === true) {
  main().catch((err) => {
    console.error('❌ Failed to seed packages and channels:', err);
    process.exit(1);
  });
}
