import type { ChannelGenre, ChannelResolution, PackageType } from '@/constants/crm';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import {
  channels,
  customerEquipment,
  customers,
  equipment,
  itemCatalog,
  itemTypes,
  locationCategories,
  locations,
  packageChannels,
  packages,
  serviceProviders,
  services,
  stockMovements,
  subscriptions,
  tenantMemberships,
  tenants,
} from '@/db/schema';
import { FLOOR_NAMES, parseAddress } from './parse-address';
import { TIDCO_BUILDING, TIDCO_TOWN } from './seed-locations';
import { ensureSystemRoles } from './seed-roles';

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
const db = drizzle(pool);

const MSO_REPORT_PATH = path.resolve(process.cwd(), 'data/Customer_account_status_report_2026-09-08 14_09_35.xls');

interface ParsedCustomerRow {
  sNo: string;
  accountNo: string;
  lcoCustomerId: string;
  serialNumber: string;
  vcNumber: string;
  name: string;
  address: string;
  createdDate: string;
  mobileNo: string;
  packageStr: string;
  status: string;
  msoShareDue: string;
}

function parseMsoHtml(content: string): ParsedCustomerRow[] {
  const rowMatches = content.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  const list: ParsedCustomerRow[] = [];
  let isFirst = true;

  for (const match of rowMatches) {
    const rowHtml = match[1] ?? '';
    const colMatches = rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi);
    const cols: string[] = [];
    for (const colMatch of colMatches) {
      cols.push((colMatch[1] ?? '').replace(/<[^>]+>/g, '').trim());
    }

    if (cols.length >= 11) {
      if (isFirst) {
        isFirst = false;
        continue;
      }
      list.push({
        sNo: cols[0] ?? '',
        accountNo: cols[1]?.trim() ?? '',
        lcoCustomerId: cols[2]?.trim() ?? '',
        serialNumber: (cols[3] ?? '').replace(/^['"]/, '').trim(),
        vcNumber: (cols[4] ?? '').replace(/^['"]/, '').trim(),
        name: cols[5]?.trim() ?? 'Unknown Customer',
        address: cols[6]?.trim() ?? '',
        createdDate: cols[7]?.trim() ?? '',
        mobileNo: (cols[8] ?? '').replace(/^['"]/, '').trim(),
        packageStr: cols[9]?.trim() ?? '',
        status: (cols[10]?.trim().toLowerCase() === 'active') ? 'active' : 'inactive',
        msoShareDue: cols[11]?.trim() ?? '0.00',
      });
    }
  }
  return list;
}

function parseCreatedDate(dateStr: string): Date {
  if (dateStr.length === 0)
    return new Date();

  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const day = Number.parseInt(parts[0]!, 10);
    const month = Number.parseInt(parts[1]!, 10) - 1;
    const year = Number.parseInt(parts[2]!, 10);
    if (!Number.isNaN(day) && !Number.isNaN(month) && !Number.isNaN(year))
      return new Date(Date.UTC(year, month, day, 6, 0, 0));
  }
  return new Date();
}

function cleanPhone(rawPhone: string): string | null {
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length >= 10)
    return digits.slice(-10);
  return null;
}

async function buildLocationTree(tenantId: string, addresses: readonly string[]) {
  const cats = await db
    .select({ id: locationCategories.id, slug: locationCategories.slug })
    .from(locationCategories)
    .where(sql`${locationCategories.tenantId} = ${tenantId}`);

  const categoryId = new Map(cats.map(c => [c.slug, c.id]));

  const [town] = await db
    .select({ id: locations.id, schemaId: locations.schemaId })
    .from(locations)
    .where(sql`${locations.tenantId} = ${tenantId} AND ${locations.name} = ${TIDCO_TOWN} AND ${locations.parentId} IS NULL`)
    .limit(1);

  if (town === undefined)
    throw new Error(`Location "${TIDCO_TOWN}" not found — run \`pnpm db:seed\` before seeding MSO data`);

  const schemaId = town.schemaId;

  const cache = new Map<string, string>();

  async function node(input: { parentId: string; category: string; name: string; code?: string }): Promise<string> {
    const { parentId, name } = input;
    const key = `${parentId}/${name}`;
    const hit = cache.get(key);
    if (hit !== undefined)
      return hit;

    const [existing] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(sql`${locations.tenantId} = ${tenantId} AND ${locations.parentId} = ${parentId} AND ${locations.name} = ${name}`)
      .limit(1);

    const id = existing?.id ?? (await db
      .insert(locations)
      .values({
        tenantId,
        schemaId,
        categoryId: categoryId.get(input.category)!,
        parentId,
        name,
        code: input.code ?? null,
        source: 'import',
        status: 'approved',
        isActive: true,
      })
      .returning({ id: locations.id }))[0]!.id;

    cache.set(key, id);
    return id;
  }

  const buildingId = await node({ parentId: town.id, category: 'building', name: TIDCO_BUILDING, code: 'TIDCO' });

  const villageRows = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(sql`${locations.tenantId} = ${tenantId} AND ${locations.parentId} IS NULL`);

  const villageId = new Map(villageRows.map(row => [row.name, row.id]));

  const resolved = new Map<string, string>();
  const stats = { door: 0, apartment: 0, village: 0, building: 0 };

  for (const raw of addresses) {
    if (resolved.has(raw))
      continue;

    const parsed = parseAddress(raw);

    if (parsed.kind === 'village') {
      const id = villageId.get(parsed.name);
      if (id !== undefined) {
        resolved.set(raw, id);
        stats.village++;
        continue;
      }
    }

    if (parsed.kind === 'door' || parsed.kind === 'apartment') {
      const groupId = await node({ parentId: buildingId, category: 'group', name: `Group ${parsed.group}`, code: parsed.group });
      const apartmentId = await node({ parentId: groupId, category: 'apartment', name: parsed.apartment, code: parsed.apartment });

      if (parsed.kind === 'apartment') {
        resolved.set(raw, apartmentId);
        stats.apartment++;
        continue;
      }

      const floorId = await node({ parentId: apartmentId, category: 'floor', name: FLOOR_NAMES[parsed.floor], code: parsed.floor });
      const doorId = await node({ parentId: floorId, category: 'door', name: String(parsed.door), code: `${parsed.apartment}-${parsed.floor}${parsed.door}` });
      resolved.set(raw, doorId);
      stats.door++;
      continue;
    }

    resolved.set(raw, buildingId);
    stats.building++;
  }

  console.log(
    `📍 Mapped ${addresses.length} addresses onto ${cache.size} location nodes `
    + `(${stats.door} to a door, ${stats.apartment} to an apartment, ${stats.village} to a village, ${stats.building} to the complex)`,
  );

  return (raw: string): string => resolved.get(raw) ?? buildingId;
}

async function run() {
  console.log('🚀 Starting MSO Data Seeding...');

  // This seed can be the first thing to touch a database, and it creates the
  // tenant below. Roles are global and every membership references one, so they
  // have to exist before a tenant does anybody any good.
  await ensureSystemRoles(db);

  let [tenant] = await db.select().from(tenants).where(sql`${tenants.code} = 'SSCN'`).limit(1);
  if (!tenant) {
    const [inserted] = await db
      .insert(tenants)
      .values({ code: 'SSCN', name: 'Sri Satya Cable Network', customerSeq: 0 })
      .returning();
    tenant = inserted!;
  }
  console.log(`✅ Tenant resolved: ${tenant.name} (${tenant.code}) - ID: ${tenant.id}`);

  const servicesToSeed = [
    {
      tenantId: tenant.id,
      name: 'Cable TV',
      slug: 'cable-tv',
      icon: 'tv',
      description: 'Digital cable television',
      status: 'active' as const,
      metadata: {
        mso: 'ACT Digital',
        operatorId: 'ACTMDPLCOMDLURB0000002144',
        network: 'SRI SATYA CABLE NETWORK',
        location: 'TIDCO APTS, Mandapeta',
      },
    },
    {
      tenantId: tenant.id,
      name: 'Broadband',
      slug: 'broadband',
      icon: 'wifi',
      description: 'FTTH fibre internet',
      status: 'active' as const,
      metadata: {
        tech: 'FTTH',
        fiberSpeedTiers: [50, 100, 200, 300],
        ontProvided: true,
      },
    },
    {
      tenantId: tenant.id,
      name: 'IPTV',
      slug: 'iptv',
      icon: 'satellite',
      description: 'Interactive IPTV streaming with an OTT bundle',
      status: 'active' as const,
      metadata: {
        ottApps: ['Hotstar', 'Zee5', 'SonyLIV', 'Aha'],
        catchupDays: 7,
      },
    },
  ];

  const serviceMap = new Map<string, string>();
  for (const s of servicesToSeed) {
    const [existing] = await db
      .select()
      .from(services)
      .where(sql`${services.tenantId} = ${s.tenantId} AND ${services.slug} = ${s.slug}`)
      .limit(1);

    if (existing) {
      serviceMap.set(s.slug, existing.id);
    }
    else {
      const [created] = await db.insert(services).values(s).returning();
      serviceMap.set(s.slug, created!.id);
    }
  }
  console.log(`✅ Seeded ${servicesToSeed.length} Services (Cable, Broadband, IPTV)`);

  const cableServiceId = serviceMap.get('cable-tv')!;
  const broadbandServiceId = serviceMap.get('broadband')!;
  const iptvServiceId = serviceMap.get('iptv')!;

  const providersToSeed = [
    {
      tenantId: tenant.id,
      serviceId: cableServiceId,
      name: 'ACT Digital',
      slug: 'act-digital',
      code: 'ACTMDPLCOMDLURB0000002144',
      description: 'ACT Digital MSO feed, 250+ SD/HD channels',
      isDefault: true,
      metadata: { network: 'SRI SATYA CABLE NETWORK', headend: 'TIDCO APTS, Mandapeta' },
    },
    {
      tenantId: tenant.id,
      serviceId: broadbandServiceId,
      name: 'Satya Fiber',
      slug: 'satya-fiber',
      description: 'Own FTTH network',
      isDefault: true,
      metadata: { tech: 'FTTH', fiberSpeedTiers: [50, 100, 200, 300], ontProvided: true },
    },
    {
      tenantId: tenant.id,
      serviceId: iptvServiceId,
      name: 'Satya IPTV',
      slug: 'satya-iptv',
      description: 'Own IPTV platform with an OTT bundle',
      isDefault: true,
      metadata: { ottApps: ['Hotstar', 'Zee5', 'SonyLIV', 'Aha'], catchupDays: 7 },
    },
  ];

  const providerMap = new Map<string, string>();
  for (const sp of providersToSeed) {
    const [existing] = await db
      .select()
      .from(serviceProviders)
      .where(sql`${serviceProviders.serviceId} = ${sp.serviceId} AND ${serviceProviders.slug} = ${sp.slug}`)
      .limit(1);

    if (existing) {
      providerMap.set(sp.slug, existing.id);
    }
    else {
      const [created] = await db.insert(serviceProviders).values(sp).returning();
      providerMap.set(sp.slug, created!.id);
    }
  }
  console.log(`✅ Seeded ${providersToSeed.length} Service providers (ACT Digital, Satya Fiber, Satya IPTV)`);

  const cableProviderId = providerMap.get('act-digital')!;
  const broadbandProviderId = providerMap.get('satya-fiber')!;
  const iptvProviderId = providerMap.get('satya-iptv')!;

  const channelsList: Array<{
    name: string;
    slug: string;
    channelNumber: number;
    genre: ChannelGenre;
    languages: string[];
    resolution: ChannelResolution;
    isFta: boolean;
    broadcaster: string;
  }> = [
    { name: 'ETV Telugu', slug: 'etv-telugu', channelNumber: 101, genre: 'Entertainment', languages: ['Telugu'], resolution: 'SD', isFta: false, broadcaster: 'ETV Network' },
    { name: 'Gemini TV', slug: 'gemini-tv', channelNumber: 102, genre: 'Entertainment', languages: ['Telugu'], resolution: 'SD', isFta: false, broadcaster: 'Sun Network' },
    { name: 'Maa TV', slug: 'maa-tv', channelNumber: 103, genre: 'Entertainment', languages: ['Telugu'], resolution: 'SD', isFta: false, broadcaster: 'Disney Star' },
    { name: 'Maa TV HD', slug: 'maa-tv-hd', channelNumber: 104, genre: 'Entertainment', languages: ['Telugu'], resolution: 'HD', isFta: false, broadcaster: 'Disney Star' },
    { name: 'Zee Telugu', slug: 'zee-telugu', channelNumber: 105, genre: 'Entertainment', languages: ['Telugu'], resolution: 'SD', isFta: false, broadcaster: 'Zee Entertainment' },
    { name: 'TV9 Telugu', slug: 'tv9-telugu', channelNumber: 110, genre: 'News', languages: ['Telugu'], resolution: 'SD', isFta: true, broadcaster: 'Associated Broadcasting' },
    { name: 'NTV Telugu', slug: 'ntv-telugu', channelNumber: 111, genre: 'News', languages: ['Telugu'], resolution: 'SD', isFta: true, broadcaster: 'Rachana Television' },
    { name: 'Sakshi TV', slug: 'sakshi-tv', channelNumber: 112, genre: 'News', languages: ['Telugu'], resolution: 'SD', isFta: true, broadcaster: 'Indira Television' },
    { name: '10TV Telugu', slug: '10tv-telugu', channelNumber: 113, genre: 'News', languages: ['Telugu'], resolution: 'SD', isFta: true, broadcaster: 'Spoorthi Communications' },
    { name: 'ABN Andhra Jyothi', slug: 'abn-telugu', channelNumber: 114, genre: 'News', languages: ['Telugu'], resolution: 'SD', isFta: true, broadcaster: 'Amod Publications' },
    { name: 'TV5 Telugu', slug: 'tv5-telugu', channelNumber: 115, genre: 'News', languages: ['Telugu'], resolution: 'SD', isFta: true, broadcaster: 'Shreya Broadcasting' },
    { name: '99 TV', slug: '99-tv', channelNumber: 116, genre: 'News', languages: ['Telugu'], resolution: 'SD', isFta: true, broadcaster: 'New Waves Digital' },
    { name: 'Gemini Movies', slug: 'gemini-movies', channelNumber: 120, genre: 'Movies', languages: ['Telugu'], resolution: 'SD', isFta: false, broadcaster: 'Sun Network' },
    { name: 'CNBC Awaaz', slug: 'cnbc-awaaz', channelNumber: 130, genre: 'News', languages: ['Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Network18' },
    { name: 'Colors', slug: 'colors', channelNumber: 140, genre: 'Entertainment', languages: ['Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Viacom18' },
    { name: 'Colors Rishtey', slug: 'colors-rishtey', channelNumber: 141, genre: 'Entertainment', languages: ['Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Viacom18' },
    { name: 'Colors Cineplex', slug: 'colors-cineplex', channelNumber: 142, genre: 'Movies', languages: ['Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Viacom18' },
    { name: 'Colors Cineplex Bollywood', slug: 'colors-cineplex-bollywood', channelNumber: 143, genre: 'Movies', languages: ['Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Viacom18' },
    { name: 'Colors Cineplex Superhits', slug: 'colors-cineplex-superhits', channelNumber: 144, genre: 'Movies', languages: ['Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Viacom18' },
    { name: 'MTV', slug: 'mtv', channelNumber: 150, genre: 'Music', languages: ['Hindi', 'English'], resolution: 'SD', isFta: false, broadcaster: 'Viacom18' },
    { name: 'Sony Wah', slug: 'sony-wah', channelNumber: 160, genre: 'Movies', languages: ['Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Sony Pictures Networks' },
    { name: 'Sony Pal', slug: 'sony-pal', channelNumber: 161, genre: 'Entertainment', languages: ['Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Sony Pictures Networks' },
    { name: 'Sony Max 2', slug: 'sony-max-2', channelNumber: 162, genre: 'Movies', languages: ['Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Sony Pictures Networks' },
    { name: 'Sony Entertainment Television HD', slug: 'set-hd', channelNumber: 163, genre: 'Entertainment', languages: ['Hindi'], resolution: 'HD', isFta: false, broadcaster: 'Sony Pictures Networks' },
    { name: 'Sony SAB HD', slug: 'sony-sab-hd', channelNumber: 164, genre: 'Entertainment', languages: ['Hindi'], resolution: 'HD', isFta: false, broadcaster: 'Sony Pictures Networks' },
    { name: 'Zing', slug: 'zing', channelNumber: 170, genre: 'Music', languages: ['Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Zee Entertainment' },
    { name: 'The History Channel', slug: 'history-channel', channelNumber: 180, genre: 'Infotainment', languages: ['English', 'Hindi', 'Telugu'], resolution: 'SD', isFta: false, broadcaster: 'A+E Networks' },
    { name: 'Movies Now', slug: 'movies-now', channelNumber: 181, genre: 'Movies', languages: ['English'], resolution: 'SD', isFta: false, broadcaster: 'Times Network' },
    { name: 'Star Movies', slug: 'star-movies', channelNumber: 182, genre: 'Movies', languages: ['English'], resolution: 'SD', isFta: false, broadcaster: 'Disney Star' },
    { name: 'Star Sports 1', slug: 'star-sports-1', channelNumber: 200, genre: 'Sports', languages: ['English'], resolution: 'SD', isFta: false, broadcaster: 'Disney Star' },
    { name: 'Sony Sports Ten 5', slug: 'sony-sports-ten-5', channelNumber: 201, genre: 'Sports', languages: ['English', 'Hindi'], resolution: 'SD', isFta: false, broadcaster: 'Sony Pictures Networks' },
    { name: 'Sony Sports Ten 4 Telugu', slug: 'sony-sports-ten-4-telugu', channelNumber: 202, genre: 'Sports', languages: ['Telugu', 'Tamil'], resolution: 'SD', isFta: false, broadcaster: 'Sony Pictures Networks' },
    { name: 'Sony Sports Ten 3 HD', slug: 'sony-sports-ten-3-hd', channelNumber: 203, genre: 'Sports', languages: ['Hindi'], resolution: 'HD', isFta: false, broadcaster: 'Sony Pictures Networks' },
    { name: 'Star Sports 2', slug: 'star-sports-2', channelNumber: 204, genre: 'Sports', languages: ['English'], resolution: 'SD', isFta: false, broadcaster: 'Disney Star' },
    { name: 'Star Sports 2 HD', slug: 'star-sports-2-hd', channelNumber: 205, genre: 'Sports', languages: ['English'], resolution: 'HD', isFta: false, broadcaster: 'Disney Star' },
    { name: 'Star Sports 2 Telugu', slug: 'star-sports-2-telugu', channelNumber: 206, genre: 'Sports', languages: ['Telugu'], resolution: 'SD', isFta: false, broadcaster: 'Disney Star' },
    { name: 'Unite8 Sports 1', slug: 'unite8-sports-1', channelNumber: 207, genre: 'Sports', languages: ['English'], resolution: 'SD', isFta: false, broadcaster: 'Unite8 Network' },
    { name: 'Unite8 Sports 1 HD', slug: 'unite8-sports-1-hd', channelNumber: 208, genre: 'Sports', languages: ['English'], resolution: 'HD', isFta: false, broadcaster: 'Unite8 Network' },
  ];

  const channelMap = new Map<string, string>();
  for (const c of channelsList) {
    const [existing] = await db
      .select()
      .from(channels)
      .where(sql`${channels.serviceProviderId} = ${cableProviderId} AND ${channels.slug} = ${c.slug}`)
      .limit(1);

    if (existing) {
      channelMap.set(c.slug, existing.id);
    }
    else {
      const [created] = await db
        .insert(channels)
        .values({
          tenantId: tenant.id,
          serviceProviderId: cableProviderId,
          channelNumber: c.channelNumber,
          name: c.name,
          slug: c.slug,
          genre: c.genre,
          languages: c.languages,
          resolution: c.resolution,
          isFta: c.isFta,
          broadcaster: c.broadcaster,
          price: '0.00',
          status: 'active',
          metadata: {
            resolution: c.resolution,
            audioPid: 1000 + c.channelNumber,
            videoPid: 2000 + c.channelNumber,
            providerLcn: c.channelNumber,
          },
        })
        .onConflictDoUpdate({
          target: [channels.serviceProviderId, channels.channelNumber],
          set: {
            name: c.name,
            genre: c.genre,
            languages: c.languages,
            resolution: c.resolution,
            isFta: c.isFta,
            broadcaster: c.broadcaster,
            metadata: {
              resolution: c.resolution,
              audioPid: 1000 + c.channelNumber,
              videoPid: 2000 + c.channelNumber,
              providerLcn: c.channelNumber,
            },
          },
        })
        .returning();
      channelMap.set(c.slug, created!.id);
    }
  }
  console.log(`✅ Seeded ${channelsList.length} Channels with LCN and Languages`);

  const packagesList: Array<{
    serviceProviderId: string;
    name: string;
    slug: string;
    packageType: PackageType;
    price: string;
    discount: string;
    msoShare: string;
    description: string;
    metadata: Record<string, unknown>;
  }> = [
    {
      serviceProviderId: cableProviderId,
      name: 'ACT Ultimate Pre Viz',
      slug: 'act-ultimate-pre-viz',
      packageType: 'base',
      price: '164.01',
      discount: '0.00',
      msoShare: '117.99',
      description: 'ACT Ultimate Telugu Standard Pack with all primary entertainment and news channels',
      metadata: { totalChannels: 220, hdChannels: 5, ncfFee: 46.02, msoPackFee: 117.99 },
    },
    {
      serviceProviderId: cableProviderId,
      name: 'ACT BST Bronze Viz',
      slug: 'act-bst-bronze-viz',
      packageType: 'base',
      price: '130.00',
      discount: '0.00',
      msoShare: '90.00',
      description: 'Basic Service Tier Bronze pack with Free-to-Air Telugu channels',
      metadata: { totalChannels: 150, ncfFee: 46.02 },
    },
    {
      serviceProviderId: cableProviderId,
      name: 'ACT Smart HD Pre Viz',
      slug: 'act-smart-hd-pre-viz',
      packageType: 'base',
      price: '280.00',
      discount: '10.00',
      msoShare: '180.00',
      description: 'High Definition Telugu and Sports combo with premium audio',
      metadata: { totalChannels: 260, hdChannels: 35 },
    },
    {
      serviceProviderId: cableProviderId,
      name: 'ETV Family Pack',
      slug: 'etv-family-pack',
      packageType: 'bouquet',
      price: '35.00',
      discount: '0.00',
      msoShare: '28.00',
      description: 'ETV Telugu bouquet with entertainment, cinema, plus and news',
      metadata: { channelsCount: 6 },
    },
    {
      serviceProviderId: cableProviderId,
      name: 'Zee Prime Pack Telugu SD',
      slug: 'zee-prime-pack-telugu-sd',
      packageType: 'bouquet',
      price: '40.00',
      discount: '0.00',
      msoShare: '32.00',
      description: 'Zee Telugu bouquet with Zee Telugu, Zee Cinemalu, Zee Action',
      metadata: { channelsCount: 8 },
    },
    {
      serviceProviderId: cableProviderId,
      name: 'Sun SD Bouquet 02 Telugu Basic',
      slug: 'sun-sd-bouquet-02-telugu-basic',
      packageType: 'bouquet',
      price: '45.00',
      discount: '0.00',
      msoShare: '36.00',
      description: 'Sun Network Telugu basic bouquet including Gemini TV, Movies, Music, Comedy',
      metadata: { channelsCount: 7 },
    },
    {
      serviceProviderId: broadbandProviderId,
      name: 'Fiber 50 Mbps Unlimited',
      slug: 'fiber-50-mbps-unlimited',
      packageType: 'base',
      price: '499.00',
      discount: '0.00',
      msoShare: '0.00',
      description: '50 Mbps symmetric FTTH fiber internet with unlimited data',
      metadata: {
        downloadSpeedMbps: 50,
        uploadSpeedMbps: 50,
        dataLimit: 'Unlimited',
        fupLimitGb: 3300,
        fupPostSpeedMbps: 2,
        routerIncluded: true,
      },
    },
    {
      serviceProviderId: broadbandProviderId,
      name: 'Fiber 100 Mbps Unlimited',
      slug: 'fiber-100-mbps-unlimited',
      packageType: 'base',
      price: '699.00',
      discount: '50.00',
      msoShare: '0.00',
      description: '100 Mbps ultra-fast fiber internet with free Dual-Band WiFi router & OTT',
      metadata: {
        downloadSpeedMbps: 100,
        uploadSpeedMbps: 100,
        dataLimit: 'Unlimited',
        fupLimitGb: 3300,
        fupPostSpeedMbps: 4,
        ottApps: ['Disney+ Hotstar'],
        routerIncluded: true,
      },
    },
    {
      serviceProviderId: broadbandProviderId,
      name: 'Fiber 200 Mbps Pro',
      slug: 'fiber-200-mbps-pro',
      packageType: 'base',
      price: '999.00',
      discount: '100.00',
      msoShare: '0.00',
      description: '200 Mbps gigabit fiber for streaming and gaming with premium OTT bundle',
      metadata: {
        downloadSpeedMbps: 200,
        uploadSpeedMbps: 200,
        dataLimit: 'Unlimited',
        fupLimitGb: 3300,
        fupPostSpeedMbps: 10,
        ottApps: ['Disney+ Hotstar', 'Zee5', 'SonyLIV'],
        routerIncluded: true,
      },
    },
    {
      serviceProviderId: iptvProviderId,
      name: 'IPTV Smart Telugu Plus',
      slug: 'iptv-smart-telugu-plus',
      packageType: 'combo',
      price: '349.00',
      discount: '0.00',
      msoShare: '0.00',
      description: 'IPTV digital streaming with live channels + 4K STB + Catchup TV',
      metadata: {
        liveChannels: 250,
        ottApps: ['Aha', 'Zee5'],
        catchupDays: 7,
      },
    },
  ];

  const packageMap = new Map<string, string>();
  for (const p of packagesList) {
    const [existing] = await db
      .select()
      .from(packages)
      .where(sql`${packages.serviceProviderId} = ${p.serviceProviderId} AND ${packages.slug} = ${p.slug}`)
      .limit(1);

    if (existing) {
      packageMap.set(p.slug, existing.id);
    }
    else {
      const [created] = await db
        .insert(packages)
        .values({
          tenantId: tenant.id,
          ...p,
          status: 'active',
        })
        .returning();
      packageMap.set(p.slug, created!.id);
    }
  }
  console.log(`✅ Seeded ${packagesList.length} Packages (Cable + Fiber Broadband + IPTV)`);

  const primaryCablePkgId = packageMap.get('act-ultimate-pre-viz')!;
  const bstBronzePkgId = packageMap.get('act-bst-bronze-viz');
  const smartHdPkgId = packageMap.get('act-smart-hd-pre-viz');
  const etvBouquetPkgId = packageMap.get('etv-family-pack');
  const zeeBouquetPkgId = packageMap.get('zee-prime-pack-telugu-sd');
  const sunBouquetPkgId = packageMap.get('sun-sd-bouquet-02-telugu-basic');

  let packageChannelCount = 0;
  for (const c of channelsList) {
    const channelId = channelMap.get(c.slug);
    if (channelId === undefined)
      continue;

    await db
      .insert(packageChannels)
      .values({
        packageId: primaryCablePkgId,
        channelId,
        isMandatory: true,
      })
      .onConflictDoNothing({ target: [packageChannels.packageId, packageChannels.channelId] });
    packageChannelCount++;

    if (bstBronzePkgId !== undefined && c.isFta) {
      await db
        .insert(packageChannels)
        .values({
          packageId: bstBronzePkgId,
          channelId,
          isMandatory: true,
        })
        .onConflictDoNothing({ target: [packageChannels.packageId, packageChannels.channelId] });
      packageChannelCount++;
    }

    if (smartHdPkgId !== undefined) {
      await db
        .insert(packageChannels)
        .values({
          packageId: smartHdPkgId,
          channelId,
          isMandatory: true,
        })
        .onConflictDoNothing({ target: [packageChannels.packageId, packageChannels.channelId] });
      packageChannelCount++;
    }

    if (etvBouquetPkgId !== undefined && c.broadcaster === 'ETV Network') {
      await db
        .insert(packageChannels)
        .values({
          packageId: etvBouquetPkgId,
          channelId,
          isMandatory: true,
        })
        .onConflictDoNothing({ target: [packageChannels.packageId, packageChannels.channelId] });
      packageChannelCount++;
    }

    if (zeeBouquetPkgId !== undefined && c.broadcaster === 'Zee Entertainment') {
      await db
        .insert(packageChannels)
        .values({
          packageId: zeeBouquetPkgId,
          channelId,
          isMandatory: true,
        })
        .onConflictDoNothing({ target: [packageChannels.packageId, packageChannels.channelId] });
      packageChannelCount++;
    }

    if (sunBouquetPkgId !== undefined && c.broadcaster === 'Sun Network') {
      await db
        .insert(packageChannels)
        .values({
          packageId: sunBouquetPkgId,
          channelId,
          isMandatory: true,
        })
        .onConflictDoNothing({ target: [packageChannels.packageId, packageChannels.channelId] });
      packageChannelCount++;
    }
  }
  console.log(`✅ Seeded ${packageChannelCount} Package-Channel mappings`);

  if (!fs.existsSync(MSO_REPORT_PATH))
    throw new Error(`Customer report file not found at ${MSO_REPORT_PATH}`);

  const htmlContent = fs.readFileSync(MSO_REPORT_PATH, 'utf8');
  const parsedCustomers = parseMsoHtml(htmlContent);
  console.log(`📋 Parsed ${parsedCustomers.length} customer records from MSO report`);

  const resolveLocation = await buildLocationTree(tenant.id, parsedCustomers.map(row => row.address));

  await db
    .update(customers)
    .set({ userId: null })
    .where(sql`${customers.tenantId} = ${tenant.id}`);

  await db
    .delete(tenantMemberships)
    .where(sql`${tenantMemberships.tenantId} = ${tenant.id} AND ${tenantMemberships.roleId} = 'customer'`);

  await db.execute(sql`
    DELETE FROM auth.users
    WHERE id NOT IN (SELECT user_id FROM tenancy.tenant_memberships)
      AND id NOT IN (SELECT user_id FROM auth.sessions)
  `);

  const existingSubs = await db
    .select({ id: subscriptions.id, customerId: subscriptions.customerId, acc: subscriptions.serviceAccountNumber })
    .from(subscriptions)
    .where(sql`${subscriptions.tenantId} = ${tenant.id}`);

  const subByAccount = new Map<string, { id: string; customerId: string }>();
  for (const s of existingSubs)
    subByAccount.set(s.acc, { id: s.id, customerId: s.customerId });

  // Movement history pins the equipment it describes (ON DELETE restrict), so the
  // ledger goes before the units it points at. Matched by equipment too: a
  // movement filed under another tenant can still point at this tenant's units.
  await db.delete(stockMovements).where(sql`${stockMovements.tenantId} = ${tenant.id}
    OR ${stockMovements.equipmentId} IN (SELECT id FROM ${equipment} WHERE ${equipment.tenantId} = ${tenant.id})`);
  await db.delete(equipment).where(sql`${equipment.tenantId} = ${tenant.id}`);

  const typeDefs = [
    { code: 'stb', name: 'Set Top Box', icon: 'tv-01', isSerialized: true, isReturnable: true },
    { code: 'remote', name: 'Remote Control', icon: 'remote-controller-01', isSerialized: false, isReturnable: true },
    { code: 'power_adapter', name: 'Power Adapter', icon: 'plug-socket', isSerialized: false, isReturnable: true },
    { code: 'user_manual', name: 'User Manual & Packaging', icon: 'book-02', isSerialized: false, isReturnable: false },
    { code: 'fiber_node', name: 'Fiber to Coax Mini Node', icon: 'cpu', isSerialized: true, isReturnable: true },
    { code: 'patch_cable', name: 'Fiber Patch Cord', icon: 'cable-01', isSerialized: false, isReturnable: false },
  ];

  const typeMap = new Map<string, string>();
  for (const t of typeDefs) {
    const [row] = await db
      .insert(itemTypes)
      .values({
        tenantId: tenant.id,
        code: t.code,
        name: t.name,
        icon: t.icon,
        isSerialized: t.isSerialized,
        isReturnable: t.isReturnable,
      })
      .onConflictDoUpdate({
        target: [itemTypes.tenantId, itemTypes.code],
        set: { name: t.name, icon: t.icon, isSerialized: t.isSerialized, isReturnable: t.isReturnable },
      })
      .returning();
    typeMap.set(t.code, row!.id);
  }

  const catalogDefs = [
    {
      code: 'ACT-STB-HD',
      name: 'ACT HD Set Top Box',
      brand: 'ACT',
      model: 'HD-100',
      icon: 'tv-01',
      trackingType: 'serialized' as const,
      isBundle: false,
      itemTypeId: typeMap.get('stb')!,
      defaultOwnership: 'tenant_provided' as const,
      defaultDepositAmount: '1000.00',
    },
    {
      code: 'ACT-REMOTE-01',
      name: 'ACT Smart Remote',
      brand: 'ACT',
      model: 'RC-20',
      icon: 'remote-controller-01',
      trackingType: 'quantity' as const,
      isBundle: false,
      itemTypeId: typeMap.get('remote')!,
      defaultOwnership: 'tenant_provided' as const,
      defaultSalePrice: '250.00',
    },
    {
      code: 'ACT-PWR-12V',
      name: '12V 1.5A Power Adapter',
      brand: 'ACT',
      model: 'PWR-12V-1.5A',
      icon: 'plug-socket',
      trackingType: 'quantity' as const,
      isBundle: false,
      itemTypeId: typeMap.get('power_adapter')!,
      defaultOwnership: 'tenant_provided' as const,
      defaultSalePrice: '300.00',
    },
    {
      code: 'ACT-MAN-01',
      name: 'ACT User Manual & Pack',
      brand: 'ACT',
      model: 'v1.0',
      icon: 'book-02',
      trackingType: 'quantity' as const,
      isBundle: false,
      itemTypeId: typeMap.get('user_manual')!,
      defaultOwnership: 'tenant_provided' as const,
      defaultSalePrice: '0.00',
      isReturnable: false,
    },
    {
      code: 'ACT-KIT-HD',
      name: 'ACT HD Installation Kit',
      brand: 'ACT',
      model: 'KIT-100',
      icon: 'package',
      trackingType: 'serialized' as const,
      isBundle: true,
      defaultOwnership: 'tenant_provided' as const,
      defaultDepositAmount: '1000.00',
    },
    {
      code: 'OPT-NODE-01',
      name: 'Optical Mini Receiver (Fiber to Coax)',
      brand: 'OptiLink',
      model: 'OL-MINI-RF',
      icon: 'cpu',
      trackingType: 'serialized' as const,
      isBundle: false,
      itemTypeId: typeMap.get('fiber_node')!,
      defaultOwnership: 'tenant_provided' as const,
      defaultDepositAmount: '500.00',
    },
    {
      code: 'FIN-PATCH-3M',
      name: 'SC-APC Fiber Patch Cord 3m',
      brand: 'Finolex',
      model: 'SC-3M',
      icon: 'cable-01',
      trackingType: 'quantity' as const,
      isBundle: false,
      itemTypeId: typeMap.get('patch_cable')!,
      defaultOwnership: 'customer_owned' as const,
      defaultSalePrice: '150.00',
      isReturnable: false,
    },
  ];

  const catMap = new Map<string, string>();
  for (const c of catalogDefs) {
    const { trackingType: _, ...itemData } = c;
    const [existing] = await db
      .select({ id: itemCatalog.id })
      .from(itemCatalog)
      .where(and(eq(itemCatalog.tenantId, tenant.id), eq(itemCatalog.code, itemData.code)));

    if (existing) {
      await db
        .update(itemCatalog)
        .set({ ...itemData, updatedAt: new Date() })
        .where(eq(itemCatalog.id, existing.id));
      catMap.set(itemData.code, existing.id);
    }
    else {
      const [row] = await db
        .insert(itemCatalog)
        .values({
          tenantId: tenant.id,
          ...itemData,
        })
        .returning();
      catMap.set(itemData.code, row!.id);
    }
  }

  let insertedCustomers = 0;
  let insertedSubs = 0;
  let insertedEquipment = 0;

  for (const custRow of parsedCustomers) {
    const existingSub = subByAccount.get(custRow.accountNo);
    let customerId: string;
    let subscriptionId: string;

    const createdAtDate = parseCreatedDate(custRow.createdDate);
    const cleanedPhone = cleanPhone(custRow.mobileNo);

    const customerInfo = {
      name: custRow.name,
      mobileNo: custRow.mobileNo,
      cleanedPhone,
      accountNo: custRow.accountNo,
      lcoCustomerId: custRow.lcoCustomerId,
      serialNumber: custRow.serialNumber,
      vcNumber: custRow.vcNumber,
      packageStr: custRow.packageStr,
      status: custRow.status,
      msoShareDue: custRow.msoShareDue,
      address: custRow.address,
      createdDate: custRow.createdDate,
      importedFrom: 'Customer_account_status_report_2026-09-08 14_09_35.xls',
    };

    const locationId = resolveLocation(custRow.address);
    const addressText = custRow.address.length > 0 ? custRow.address : null;

    if (existingSub) {
      customerId = existingSub.customerId;
      subscriptionId = existingSub.id;

      await db
        .update(customers)
        .set({
          userId: null,
          name: custRow.name || null,
          phone: cleanedPhone,
          address: addressText,
          notes: 'Imported from ACT Digital MSO status report',
          metadata: customerInfo,
        })
        .where(sql`${customers.id} = ${customerId}`);

      await db
        .update(subscriptions)
        .set({ installationLocationId: locationId, installationAddress: addressText })
        .where(sql`${subscriptions.id} = ${subscriptionId}`);
    }
    else {
      const codeRes = await db.execute<{ code: string }>(
        sql`SELECT crm.next_customer_code(${tenant.id}) AS code`,
      );
      const generatedCode = codeRes.rows[0]?.code ?? `SSCN-${Date.now()}`;

      const [newCust] = await db
        .insert(customers)
        .values({
          tenantId: tenant.id,
          customerCode: generatedCode,
          userId: null,
          name: custRow.name || null,
          phone: cleanedPhone,
          address: addressText,
          status: custRow.status as 'active' | 'inactive',
          outstandingBalance: '0.00',
          notes: 'Imported from ACT Digital MSO status report',
          metadata: customerInfo,
          createdAt: createdAtDate,
          updatedAt: new Date(),
        })
        .returning();

      customerId = newCust!.id;
      insertedCustomers++;

      const [newSub] = await db
        .insert(subscriptions)
        .values({
          tenantId: tenant.id,
          customerId,
          serviceProviderId: cableProviderId,
          packageId: primaryCablePkgId,
          serviceAccountNumber: custRow.accountNo,
          status: custRow.status as 'active' | 'inactive',
          startDate: createdAtDate,
          price: '164.01',
          installationLocationId: locationId,
          installationAddress: addressText,
          metadata: {
            msoShareDue: custRow.msoShareDue,
            lcoCustomerId: custRow.lcoCustomerId,
            rawPackageString: custRow.packageStr,
          },
          createdAt: createdAtDate,
          updatedAt: new Date(),
        })
        .returning();

      subscriptionId = newSub!.id;
      subByAccount.set(custRow.accountNo, { id: subscriptionId, customerId });
      insertedSubs++;
    }

    const assetStatus = custRow.status === 'active' ? 'active' as const : 'returned' as const;

    if (custRow.serialNumber.length > 0) {
      const [kitAsset] = await db
        .insert(equipment)
        .values({
          tenantId: tenant.id,
          catalogId: catMap.get('ACT-KIT-HD')!,
          serialNumber: custRow.serialNumber,
          vcNumber: custRow.vcNumber.length > 0 ? custRow.vcNumber : null,
          locationId,
          isReturnable: true,
          ownershipType: 'tenant_provided',
          depositAmount: '1000.00',
          inventoryStatus: custRow.status === 'active' ? 'allocated' : 'available',
          createdAt: createdAtDate,
        })
        .returning();

      await db.insert(customerEquipment).values({
        tenantId: tenant.id,
        equipmentId: kitAsset!.id,
        customerId,
        subscriptionId,
        status: assetStatus,
        ownershipType: 'tenant_provided',
        assignedAt: createdAtDate,
      });
      insertedEquipment++;
    }
  }

  console.log(`✅ Customers Processed: ${parsedCustomers.length} records (${insertedCustomers} new customers), ${insertedSubs} new subscriptions, ${insertedEquipment} equipment assets`);

  console.log('🎉 Seeding completed successfully!');
}

run()
  .catch((err) => {
    console.error('❌ Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
