import type { ChannelGenre, ChannelResolution, PackageType, TransactionType } from '@/shared/constants/crm';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import {
  accountTransactions,
  channels,
  customerEquipment,
  customers,
  equipment,
  locationCategories,
  locations,
  packageChannels,
  packages,
  serviceProviders,
  services,
  subscriptions,
  tenantMemberships,
  tenants,
} from '@/db/schema';
import { FLOOR_NAMES, parseAddress } from './parse-address';
import { TIDCO_BUILDING, TIDCO_TOWN } from './seed-locations';

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
const db = drizzle(pool);

const MSO_REPORT_PATH = path.resolve(process.cwd(), 'data/Customer_account_status_report_2026-09-08 14_09_35.xls');
const LEDGER_REPORT_PATH = path.resolve(process.cwd(), 'data/LCODepositLedgerReport_2026-09-0814:09:51-0-1000000.csv');

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

interface ParsedLedgerRow {
  sNo: string;
  businessName: string;
  dateStr: string;
  transactionNo: string;
  remarks: string;
  accountNumber: string;
  credit: string;
  debit: string;
  closingBalance: string;
}

function parseLedgerCsv(content: string): ParsedLedgerRow[] {
  const lines = content.split(/\r?\n/);
  const rows: ParsedLedgerRow[] = [];

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === undefined || line.length === 0)
      continue;

    const cols: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') {
        inQuotes = !inQuotes;
      }
      else if (char === ',' && !inQuotes) {
        cols.push(cur.trim());
        cur = '';
      }
      else {
        cur += char;
      }
    }
    cols.push(cur.trim());

    if (cols.length >= 9) {
      const creditVal = cols[6]?.replace(/^"|"$/g, '');
      const debitVal = cols[7]?.replace(/^"|"$/g, '');
      const closingVal = cols[8]?.replace(/^"|"$/g, '');

      rows.push({
        sNo: cols[0]?.replace(/^"|"$/g, '') ?? '',
        businessName: cols[1]?.replace(/^"|"$/g, '') ?? '',
        dateStr: cols[2]?.replace(/^['"]|['"]$/g, '') ?? '',
        transactionNo: cols[3]?.replace(/^"|"$/g, '') ?? '',
        remarks: cols[4]?.replace(/^"|"$/g, '') ?? '',
        accountNumber: cols[5]?.replace(/^"|"$/g, '') ?? '',
        credit: creditVal !== undefined && creditVal.length > 0 ? creditVal : '0',
        debit: debitVal !== undefined && debitVal.length > 0 ? debitVal : '0',
        closingBalance: closingVal !== undefined && closingVal.length > 0 ? closingVal : '0',
      });
    }
  }
  return rows;
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

function parseTxDate(dateStr: string): Date {
  if (dateStr.length === 0)
    return new Date();

  const cleaned = dateStr.replace(/^'/, '').trim();
  const d = new Date(cleaned);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function resolveTxType(remarks: string): TransactionType {
  const r = remarks.toLowerCase();
  if (r.includes('deduction'))
    return 'deduction';
  if (r.includes('deposit reversal'))
    return 'reversal';
  if (r.includes('normal deposit') || r.includes('amount deposited'))
    return 'deposit';
  if (r.includes('adjustment'))
    return 'adjustment';
  return 'other';
}

function cleanPhone(rawPhone: string): string | null {
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length >= 10)
    return digits.slice(-10);
  return null;
}

/**
 * The TIDCO tree, built from the addresses in the report rather than invented.
 *
 * Returns a lookup that answers "where does this address live" with the
 * deepest node the address actually supports — a door for the 89% that parse
 * in full, the apartment or the village for the rest, and the complex itself
 * for a row that says nothing but `TIDCO`. Never null: `location_id` is
 * required on a subscription, so the fallback chain has to bottom out at the
 * town.
 *
 * Only the nodes the data mentions are created. Group A has 62 apartments in
 * the file, not a round 80, and generating the missing ones would put flats in
 * the tree that nobody has ever billed.
 */
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

  // Cached by parent+name, so 764 addresses cost one upsert per distinct node
  // rather than one per row.
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

  // The villages already exist as street-address areas; a row that names one
  // resolves to that area rather than to anything under the complex.
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

    // `TIDCO`, `Mandapeta`, `Devi center` — inside the book, but no more than that.
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

  // ─── Service providers ──────────────────────────────────────────────────────
  // The supplier behind each service. This is where the brand lives now: the
  // service is "Cable TV", ACT Digital is one MSO that delivers it, and a second
  // MSO is another row here rather than a duplicate service
  // (docs/services-providers-packages.md).
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

  // Rebuilt from scratch every run rather than topped up. Every asset below is
  // derived from the report, so a re-run has to be able to change their shape —
  // a guard that skipped lines already holding kit would pin the database to
  // whatever the first import happened to produce. `customer_equipment`
  // cascades off `equipment`, so the assignments go with them.
  await db.delete(equipment).where(sql`${equipment.tenantId} = ${tenant.id}`);

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

      // Deliberately still `userId: null`. These are subscriber records, not
      // logins — accounts get created through the real signup flow, so that
      // an imported row never becomes a credential nobody issued.
      await db
        .update(customers)
        .set({
          userId: null,
          locationId,
          address: addressText,
          notes: 'Imported from ACT Digital MSO status report',
          metadata: customerInfo,
        })
        .where(sql`${customers.id} = ${customerId}`);

      await db
        .update(subscriptions)
        .set({ locationId, installationAddress: addressText })
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
          locationId,
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
          locationId,
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

    // Three per connection. The box is the only one the report identifies: its
    // serial number and its viewing card number both belong to it, which is why
    // the card is not a fourth asset of its own — a VC number is a property of
    // the STB it is paired to, not a separate thing the operator can move.
    //
    // The remote and the adapter ship with every box but appear in no file, so
    // they are marked as assumed rather than passed off as scanned hardware.
    const kit = [
      custRow.serialNumber.length > 0 && {
        equipmentType: 'stb' as const,
        serialNumber: custRow.serialNumber,
        vcNumber: custRow.vcNumber.length > 0 ? custRow.vcNumber : null,
      },
      { equipmentType: 'remote' as const, metadata: { assumed: true } },
      { equipmentType: 'power_adapter' as const, metadata: { assumed: true } },
    ].filter(item => item !== false);

    for (const asset of kit) {
      const [created] = await db
        .insert(equipment)
        .values({
          tenantId: tenant.id,
          isReturnable: true,
          ownershipType: 'tenant_provided',
          inventoryStatus: 'allocated',
          createdAt: createdAtDate,
          ...asset,
        })
        .returning();

      await db.insert(customerEquipment).values({
        tenantId: tenant.id,
        equipmentId: created!.id,
        customerId,
        subscriptionId,
        status: assetStatus,
        assignedAt: createdAtDate,
      });
      insertedEquipment++;
    }
  }

  console.log(`✅ Customers Processed: ${parsedCustomers.length} records (${insertedCustomers} new customers), ${insertedSubs} new subscriptions, ${insertedEquipment} equipment assets`);

  if (fs.existsSync(LEDGER_REPORT_PATH)) {
    const csvContent = fs.readFileSync(LEDGER_REPORT_PATH, 'utf8');
    const ledgerRows = parseLedgerCsv(csvContent);
    console.log(`📋 Parsed ${ledgerRows.length} transactions from ledger report`);

    const allSubs = await db
      .select({ id: subscriptions.id, customerId: subscriptions.customerId, acc: subscriptions.serviceAccountNumber })
      .from(subscriptions)
      .where(sql`${subscriptions.tenantId} = ${tenant.id}`);

    const subAccMap = new Map<string, { id: string; customerId: string }>();
    for (const s of allSubs)
      subAccMap.set(s.acc, { id: s.id, customerId: s.customerId });

    let insertedTxs = 0;
    const batchSize = 500;
    const txRecords: Array<typeof accountTransactions.$inferInsert> = [];

    const existingTxCount = await db
      .select({ count: sql<string>`count(*)` })
      .from(accountTransactions)
      .where(sql`${accountTransactions.tenantId} = ${tenant.id}`);

    if (Number(existingTxCount[0]?.count ?? 0) === 0) {
      for (const row of ledgerRows) {
        const matched = subAccMap.get(row.accountNumber);
        txRecords.push({
          tenantId: tenant.id,
          serviceId: cableServiceId,
          customerId: matched !== undefined ? matched.customerId : null,
          subscriptionId: matched !== undefined ? matched.id : null,
          serviceAccountNumber: row.accountNumber.length > 0 ? row.accountNumber : 'SYSTEM',
          transactionNo: row.transactionNo,
          transactionDate: parseTxDate(row.dateStr),
          transactionType: resolveTxType(row.remarks),
          remarks: row.remarks,
          debit: row.debit,
          credit: row.credit,
          closingBalance: row.closingBalance,
          createdAt: parseTxDate(row.dateStr),
        });

        if (txRecords.length >= batchSize) {
          await db.insert(accountTransactions).values(txRecords);
          insertedTxs += txRecords.length;
          txRecords.length = 0;
        }
      }

      if (txRecords.length > 0) {
        await db.insert(accountTransactions).values(txRecords);
        insertedTxs += txRecords.length;
      }
      console.log(`✅ Seeded ${insertedTxs} Account Transactions`);
    }
    else {
      console.log(`ℹ️ Account transactions already present (${existingTxCount[0]?.count} rows) — skipping insert`);
    }
  }

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
