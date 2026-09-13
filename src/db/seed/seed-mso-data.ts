/**
 * Seeding script for MSO (ACT Digital) Cable TV customer, package, equipment & ledger data.
 *
 * Populates:
 * 1. Tenant: Sri Satya Cable Network (SSCN)
 * 2. Services: Cable TV (ACT), Broadband Internet (Satya Fiber), IPTV
 * 3. Channels: TV / IPTV channels with Logical Channel Numbers (LCN)
 * 4. Packages: Cable TV packs + Broadband tiers with JSON metadata
 * 5. Customers: 764 customer records with customer codes and complete raw/parsed JSON metadata (userId kept null)
 * 6. Customer Details: Extended flat/door, landmark, and KYC metadata
 * 7. Subscriptions: Linked to ACT Cable TV with serviceAccountNumber (C2602498, ...)
 * 8. Equipment: STB, Smart Card / VC, Remote, Adapter assets & customer mappings
 * 9. Account Transactions: 5,097 historical ledger entries from LCO deposit report
 */

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
  customerAddresses,
  customerEquipment,
  customers,
  equipment,
  packageChannels,
  packages,
  services,
  subscriptions,
  tenantMemberships,
  tenants,
} from '@/db/schema';

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
const db = drizzle(pool);

const MSO_REPORT_PATH = path.resolve(process.cwd(), 'Customer_account_status_report_2026-09-08 14_09_35.xls');
const LEDGER_REPORT_PATH = path.resolve(process.cwd(), 'LCODepositLedgerReport_2026-09-0814:09:51-0-1000000.csv');

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

async function run() {
  console.log('🚀 Starting MSO Data Seeding...');

  // 1. Resolve tenant SSCN
  let [tenant] = await db.select().from(tenants).where(sql`${tenants.code} = 'SSCN'`).limit(1);
  if (!tenant) {
    const [inserted] = await db
      .insert(tenants)
      .values({ code: 'SSCN', name: 'Sri Satya Cable Network', customerSeq: 0 })
      .returning();
    tenant = inserted!;
  }
  console.log(`✅ Tenant resolved: ${tenant.name} (${tenant.code}) - ID: ${tenant.id}`);

  // 2. Seed Services (Cable TV, Broadband, IPTV)
  const servicesToSeed = [
    {
      tenantId: tenant.id,
      name: 'ACT Cable TV',
      slug: 'act-cable-tv',
      serviceType: 'cable' as const,
      providerName: 'ACT Digital',
      description: 'Digital Cable TV network with 250+ SD/HD Channels via ACT Digital MSO',
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
      name: 'Satya Fiber Broadband',
      slug: 'satya-fiber-broadband',
      serviceType: 'broadband' as const,
      providerName: 'Satya Fiber',
      description: 'High-speed FTTH Fiber Broadband internet with unlimited data',
      status: 'active' as const,
      metadata: {
        tech: 'FTTH',
        fiberSpeedTiers: [50, 100, 200, 300],
        ontProvided: true,
      },
    },
    {
      tenantId: tenant.id,
      name: 'Satya Smart IPTV',
      slug: 'satya-smart-iptv',
      serviceType: 'iptv' as const,
      providerName: 'Satya IPTV',
      description: 'Interactive IPTV streaming with 200+ live channels and OTT bundle',
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

  const cableServiceId = serviceMap.get('act-cable-tv')!;
  const broadbandServiceId = serviceMap.get('satya-fiber-broadband')!;
  const iptvServiceId = serviceMap.get('satya-smart-iptv')!;

  // 3. Seed Channels with Logical Channel Numbers (LCN) & Languages
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
      .where(sql`${channels.serviceId} = ${cableServiceId} AND ${channels.slug} = ${c.slug}`)
      .limit(1);

    if (existing) {
      channelMap.set(c.slug, existing.id);
    }
    else {
      const [created] = await db
        .insert(channels)
        .values({
          tenantId: tenant.id,
          serviceId: cableServiceId,
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
          target: [channels.serviceId, channels.channelNumber],
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

  // 4. Seed Packages
  const packagesList: Array<{
    serviceId: string;
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
      serviceId: cableServiceId,
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
      serviceId: cableServiceId,
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
      serviceId: cableServiceId,
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
      serviceId: cableServiceId,
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
      serviceId: cableServiceId,
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
      serviceId: cableServiceId,
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
      serviceId: broadbandServiceId,
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
      serviceId: broadbandServiceId,
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
      serviceId: broadbandServiceId,
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
      serviceId: iptvServiceId,
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
      .where(sql`${packages.tenantId} = ${tenant.id} AND ${packages.slug} = ${p.slug}`)
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

    // 1. Primary cable base package gets all channels
    await db
      .insert(packageChannels)
      .values({
        packageId: primaryCablePkgId,
        channelId,
        isMandatory: true,
      })
      .onConflictDoNothing({ target: [packageChannels.packageId, packageChannels.channelId] });
    packageChannelCount++;

    // 2. BST Bronze (Free-to-Air channels)
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

    // 3. Smart HD pack
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

    // 4. ETV Bouquet
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

    // 5. Zee Bouquet
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

    // 6. Sun Bouquet
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

  // 5. Parse Customer Report
  if (!fs.existsSync(MSO_REPORT_PATH))
    throw new Error(`Customer report file not found at ${MSO_REPORT_PATH}`);

  const htmlContent = fs.readFileSync(MSO_REPORT_PATH, 'utf8');
  const parsedCustomers = parseMsoHtml(htmlContent);
  console.log(`📋 Parsed ${parsedCustomers.length} customer records from MSO report`);

  // Disconnect existing customer user_id links and clean up previous bulk customer accounts
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

  // Cache existing subscriptions
  const existingSubs = await db
    .select({ id: subscriptions.id, customerId: subscriptions.customerId, acc: subscriptions.serviceAccountNumber })
    .from(subscriptions)
    .where(sql`${subscriptions.tenantId} = ${tenant.id}`);

  const subByAccount = new Map<string, { id: string; customerId: string }>();
  for (const s of existingSubs)
    subByAccount.set(s.acc, { id: s.id, customerId: s.customerId });

  let insertedCustomers = 0;
  let insertedSubs = 0;
  let insertedEquipment = 0;

  for (const custRow of parsedCustomers) {
    const existingSub = subByAccount.get(custRow.accountNo);
    let customerId: string;
    let subscriptionId: string;

    const createdAtDate = parseCreatedDate(custRow.createdDate);
    const cleanedPhone = cleanPhone(custRow.mobileNo);

    // Keep all customer raw & parsed info in JSON metadata for verification by admin
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

    if (existingSub) {
      customerId = existingSub.customerId;
      subscriptionId = existingSub.id;

      // Update customer with userId = null and complete metadata JSON
      await db
        .update(customers)
        .set({
          userId: null,
          notes: 'Imported from ACT Digital MSO status report',
          metadata: customerInfo,
        })
        .where(sql`${customers.id} = ${customerId}`);

      // Seed address if not already present
      const [existingAddr] = await db
        .select({ id: customerAddresses.id })
        .from(customerAddresses)
        .where(sql`${customerAddresses.customerId} = ${customerId}`)
        .limit(1);

      let resolvedAddrId = existingAddr?.id;
      if (resolvedAddrId === undefined) {
        const [newAddr] = await db
          .insert(customerAddresses)
          .values({
            tenantId: tenant.id,
            customerId,
            addressType: 'installation',
            flatOrDoorNo: custRow.address.length > 0 ? custRow.address : null,
            buildingOrApartment: 'TIDCO Apartments',
            landmark: 'TIDCO Housing Complex, Mandapeta',
            city: 'Mandapeta',
            state: 'Andhra Pradesh',
            pincode: '533308',
            isPrimary: true,
            createdAt: createdAtDate,
            updatedAt: new Date(),
          })
          .returning();
        resolvedAddrId = newAddr?.id;
      }

      if (resolvedAddrId !== undefined) {
        await db
          .update(subscriptions)
          .set({ installationAddressId: resolvedAddrId })
          .where(sql`${subscriptions.id} = ${subscriptionId} AND ${subscriptions.installationAddressId} IS NULL`);
      }
    }
    else {
      // Mint customerCode from crm.next_customer_code(tenantId)
      const codeRes = await db.execute<{ code: string }>(
        sql`SELECT crm.next_customer_code(${tenant.id}) AS code`,
      );
      const generatedCode = codeRes.rows[0]?.code ?? `SSCN-${Date.now()}`;

      // Insert customer with userId = null and full metadata JSON
      const [newCust] = await db
        .insert(customers)
        .values({
          tenantId: tenant.id,
          customerCode: generatedCode,
          userId: null,
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

      // Seed granular installation address
      const [addr] = await db
        .insert(customerAddresses)
        .values({
          tenantId: tenant.id,
          customerId,
          addressType: 'installation',
          flatOrDoorNo: custRow.address.length > 0 ? custRow.address : null,
          buildingOrApartment: 'TIDCO Apartments',
          landmark: 'TIDCO Housing Complex, Mandapeta',
          city: 'Mandapeta',
          state: 'Andhra Pradesh',
          pincode: '533308',
          isPrimary: true,
          createdAt: createdAtDate,
          updatedAt: new Date(),
        })
        .returning();

      // Create subscription for ACT Cable TV
      const [newSub] = await db
        .insert(subscriptions)
        .values({
          tenantId: tenant.id,
          customerId,
          serviceId: cableServiceId,
          packageId: primaryCablePkgId,
          serviceAccountNumber: custRow.accountNo,
          status: custRow.status as 'active' | 'inactive',
          startDate: createdAtDate,
          price: '164.01',
          installationAddressId: addr?.id ?? null,
          installationAddress: custRow.address.length > 0 ? custRow.address : null,
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

      // Create Equipment assets & customer_equipment mappings
      if (custRow.serialNumber.length > 0) {
        const [stbAsset] = await db
          .insert(equipment)
          .values({
            tenantId: tenant.id,
            equipmentType: 'stb',
            brand: 'Skyworth',
            model: 'HD-STB-100',
            serialNumber: custRow.serialNumber,
            isReturnable: true,
            ownershipType: 'tenant_provided',
            inventoryStatus: 'allocated',
            createdAt: createdAtDate,
          })
          .returning();

        await db.insert(customerEquipment).values({
          tenantId: tenant.id,
          equipmentId: stbAsset!.id,
          customerId,
          subscriptionId,
          status: custRow.status === 'active' ? 'active' : 'returned',
          assignedAt: createdAtDate,
        });
        insertedEquipment++;
      }

      if (custRow.vcNumber.length > 0) {
        const [vcAsset] = await db
          .insert(equipment)
          .values({
            tenantId: tenant.id,
            equipmentType: 'smart_card',
            brand: 'Conax / Irdeto',
            model: 'SmartCard-V2',
            vcNumber: custRow.vcNumber,
            isReturnable: true,
            ownershipType: 'tenant_provided',
            inventoryStatus: 'allocated',
            createdAt: createdAtDate,
          })
          .returning();

        await db.insert(customerEquipment).values({
          tenantId: tenant.id,
          equipmentId: vcAsset!.id,
          customerId,
          subscriptionId,
          status: custRow.status === 'active' ? 'active' : 'returned',
          assignedAt: createdAtDate,
        });
        insertedEquipment++;
      }

      const [remoteAsset] = await db
        .insert(equipment)
        .values({
          tenantId: tenant.id,
          equipmentType: 'remote',
          brand: 'Universal',
          model: 'ACT Universal Remote',
          isReturnable: true,
          ownershipType: 'tenant_provided',
          inventoryStatus: 'allocated',
          createdAt: createdAtDate,
        })
        .returning();

      await db.insert(customerEquipment).values({
        tenantId: tenant.id,
        equipmentId: remoteAsset!.id,
        customerId,
        subscriptionId,
        status: custRow.status === 'active' ? 'active' : 'returned',
        assignedAt: createdAtDate,
      });
      insertedEquipment++;

      const [adapterAsset] = await db
        .insert(equipment)
        .values({
          tenantId: tenant.id,
          equipmentType: 'power_adapter',
          brand: 'Huntkey',
          model: '12V 1.5A DC Adapter',
          isReturnable: true,
          ownershipType: 'tenant_provided',
          inventoryStatus: 'allocated',
          createdAt: createdAtDate,
        })
        .returning();

      await db.insert(customerEquipment).values({
        tenantId: tenant.id,
        equipmentId: adapterAsset!.id,
        customerId,
        subscriptionId,
        status: custRow.status === 'active' ? 'active' : 'returned',
        assignedAt: createdAtDate,
      });
      insertedEquipment++;
    }
  }

  console.log(`✅ Customers Processed: ${parsedCustomers.length} records (${insertedCustomers} new customers), ${insertedSubs} new subscriptions, ${insertedEquipment} equipment assets`);

  // 6. Parse and Seed Ledger Transactions
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

    // Check existing transaction count to avoid duplication
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
