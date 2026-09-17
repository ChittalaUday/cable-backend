import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { RemoteKey } from '@/constants/remotes';
import type * as schema from '@/db/schema';
import type { IrCommand, NewRemoteRecord, RemoteButton } from '@/db/schema';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { REMOTE_KEYS } from '@/constants/remotes';
import { remoteCaptures, remotes } from '@/db/schema';

const LABELS: Record<RemoteKey, string> = {
  power: 'Power',
  input: 'Input',
  menu: 'Menu',
  home: 'Home',
  guide: 'Guide',
  info: 'Info',
  back: 'Back',
  exit: 'Exit',

  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  ok: 'OK',

  volume_up: 'Volume +',
  volume_down: 'Volume −',
  mute: 'Mute',
  channel_up: 'Channel +',
  channel_down: 'Channel −',

  digit_0: '0',
  digit_1: '1',
  digit_2: '2',
  digit_3: '3',
  digit_4: '4',
  digit_5: '5',
  digit_6: '6',
  digit_7: '7',
  digit_8: '8',
  digit_9: '9',

  play: 'Play',
  pause: 'Pause',
  stop: 'Stop',
  rewind: 'Rewind',
  forward: 'Forward',
  record: 'Record',

  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
};

type CodeMap = Partial<Record<RemoteKey, number>>;

function buttonsFrom(codes: CodeMap, toCommand: (code: number) => IrCommand): RemoteButton[] {
  return REMOTE_KEYS
    .filter((key): key is RemoteKey => codes[key] !== undefined)
    .map(key => ({ key, label: LABELS[key], command: toCommand(codes[key]!) }));
}

function nec(address: number, code: number): IrCommand {
  return { protocol: 'nec', address, command: code };
}

function samsung(address: number, code: number): IrCommand {
  return { protocol: 'samsung', address, command: code };
}

function sirc(address: number, code: number): IrCommand {
  return { protocol: 'sony-sirc', bits: 12, data: (address << 7) | code, repeatCount: 2 };
}

function rc5(address: number, code: number): IrCommand {
  return { protocol: 'rc5', address, command: code, toggle: 0 };
}

const SAMSUNG_TV: CodeMap = {
  power: 0x02,
  input: 0x01,
  menu: 0x1A,
  guide: 0x4F,
  info: 0x1F,
  back: 0x58,
  exit: 0x2D,

  up: 0x60,
  down: 0x61,
  left: 0x65,
  right: 0x62,
  ok: 0x68,

  volume_up: 0x07,
  volume_down: 0x0B,
  mute: 0x0F,
  channel_up: 0x12,
  channel_down: 0x10,

  digit_1: 0x04,
  digit_2: 0x05,
  digit_3: 0x06,
  digit_4: 0x08,
  digit_5: 0x09,
  digit_6: 0x0A,
  digit_7: 0x0C,
  digit_8: 0x0D,
  digit_9: 0x0E,
  digit_0: 0x11,

  play: 0x47,
  pause: 0x4A,
  stop: 0x46,
  rewind: 0x45,
  forward: 0x48,

  red: 0x6C,
  green: 0x14,
  yellow: 0x15,
  blue: 0x16,
};

const LG_TV: CodeMap = {
  power: 0x08,
  input: 0x0B,
  menu: 0x43,
  guide: 0xAB,
  info: 0xAA,
  back: 0x28,
  exit: 0x5B,

  up: 0x40,
  down: 0x41,
  left: 0x07,
  right: 0x06,
  ok: 0x44,

  volume_up: 0x02,
  volume_down: 0x03,
  mute: 0x09,
  channel_up: 0x00,
  channel_down: 0x01,

  digit_0: 0x10,
  digit_1: 0x11,
  digit_2: 0x12,
  digit_3: 0x13,
  digit_4: 0x14,
  digit_5: 0x15,
  digit_6: 0x16,
  digit_7: 0x17,
  digit_8: 0x18,
  digit_9: 0x19,

  play: 0xB0,
  pause: 0xBA,
  stop: 0xB1,
  rewind: 0x8F,
  forward: 0x8E,

  red: 0x72,
  green: 0x71,
  yellow: 0x63,
  blue: 0x61,
};

const SONY_TV: CodeMap = {
  power: 0x15,
  input: 0x25,
  home: 0x60,
  info: 0x3A,
  back: 0x63,

  up: 0x74,
  down: 0x75,
  left: 0x34,
  right: 0x33,
  ok: 0x65,

  volume_up: 0x12,
  volume_down: 0x13,
  mute: 0x14,
  channel_up: 0x10,
  channel_down: 0x11,

  digit_1: 0x00,
  digit_2: 0x01,
  digit_3: 0x02,
  digit_4: 0x03,
  digit_5: 0x04,
  digit_6: 0x05,
  digit_7: 0x06,
  digit_8: 0x07,
  digit_9: 0x08,
  digit_0: 0x09,
};

const GENERIC_NEC_STB: CodeMap = {
  power: 0x45,
  menu: 0x47,
  guide: 0x44,
  info: 0x43,
  back: 0x40,
  exit: 0x4A,

  up: 0x46,
  down: 0x15,
  left: 0x44,
  right: 0x43,
  ok: 0x40,

  volume_up: 0x07,
  volume_down: 0x15,
  mute: 0x09,
  channel_up: 0x19,
  channel_down: 0x0D,

  digit_1: 0x16,
  digit_2: 0x0C,
  digit_3: 0x18,
  digit_4: 0x5E,
  digit_5: 0x08,
  digit_6: 0x1C,
  digit_7: 0x5A,
  digit_8: 0x42,
  digit_9: 0x52,
  digit_0: 0x4A,
};

const GENERIC_RC5_STB: CodeMap = {
  power: 0x0C,
  menu: 0x12,
  guide: 0x53,
  info: 0x0F,
  back: 0x22,
  exit: 0x23,

  up: 0x10,
  down: 0x11,
  left: 0x15,
  right: 0x16,
  ok: 0x17,

  volume_up: 0x10,
  volume_down: 0x11,
  mute: 0x0D,
  channel_up: 0x20,
  channel_down: 0x21,

  digit_0: 0x00,
  digit_1: 0x01,
  digit_2: 0x02,
  digit_3: 0x03,
  digit_4: 0x04,
  digit_5: 0x05,
  digit_6: 0x06,
  digit_7: 0x07,
  digit_8: 0x08,
  digit_9: 0x09,
};

const ACT_STB_BUTTONS: RemoteButton[] = [
  { key: 'power', label: 'Power', command: nec(0x00, 0x1C) },
  { key: 'mute', label: 'Mute', command: nec(0x00, 0x14) },
  { key: 'volume_up', label: 'Volume +', command: nec(0x00, 0x1A) },
  { key: 'volume_down', label: 'Volume −', command: nec(0x00, 0x0E) },
  { key: 'channel_up', label: 'Channel +', command: nec(0x00, 0x03) },
  { key: 'channel_down', label: 'Channel −', command: nec(0x00, 0x02) },
  { key: 'menu', label: 'Menu', command: nec(0x00, 0x05) },
  { key: 'back', label: 'Back', command: nec(0x00, 0x16) },
  { key: 'ok', label: 'OK', command: nec(0x00, 0x07) },
  { key: 'exit', label: 'Exit', command: nec(0x00, 0x18) },
  { key: 'info', label: 'Info', command: nec(0x00, 0x04) },
  { key: 'guide', label: 'EPG', command: nec(0x00, 0x00) },
  { key: 'digit_0', label: '0', command: nec(0x00, 0x12) },
  { key: 'digit_1', label: '1', command: nec(0x00, 0x09) },
  { key: 'digit_2', label: '2', command: nec(0x00, 0x1D) },
  { key: 'digit_3', label: '3', command: nec(0x00, 0x1F) },
  { key: 'digit_4', label: '4', command: nec(0x00, 0x0D) },
  { key: 'digit_5', label: '5', command: nec(0x00, 0x19) },
  { key: 'digit_6', label: '6', command: nec(0x00, 0x1B) },
  { key: 'digit_7', label: '7', command: nec(0x00, 0x11) },
  { key: 'digit_8', label: '8', command: nec(0x00, 0x15) },
  { key: 'digit_9', label: '9', command: nec(0x00, 0x17) },
  { key: 'rewind', label: 'Rewind', command: nec(0x00, 0x5B) },
  { key: 'forward', label: 'Forward', command: nec(0x00, 0x4B) },
  { key: 'stop', label: 'Stop', command: nec(0x00, 0x82) },
  { key: 'record', label: 'Record', command: nec(0x00, 0xB2) },
  { key: 'next', label: 'Next', command: nec(0x00, 0x10) },
  { key: 'page_up', label: 'Page +', command: nec(0x00, 0x4F) },
  { key: 'page_down', label: 'Page −', command: nec(0x00, 0x57) },
  { key: 'fav', label: 'FAV', command: nec(0x00, 0x13) },
  { key: 'audio', label: 'Audio', command: nec(0x00, 0x0B) },
  { key: 'mail', label: 'Mail', command: nec(0x00, 0x53) },
  { key: 'media', label: 'Media', command: nec(0x00, 0x22) },
  { key: 'music', label: 'Music', command: nec(0x00, 0x01) },
  { key: 'reminder', label: 'Reminder', command: nec(0x00, 0x06) },
];

/**
 * Television handsets imported from Flipper-IRDB, regenerated with
 * `pnpm tsx scripts/import-flipper-irdb.ts <clone>`. Community data, so every
 * entry lands unverified.
 */
function flipperTvRemotes(): NewRemoteRecord[] {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'data/tv-remotes.json');
  if (!fs.existsSync(file))
    return [];

  const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<
    Pick<NewRemoteRecord, 'brand' | 'buttons' | 'deviceType' | 'model' | 'notes' | 'verified'>
  >;
  return entries.map(entry => ({ ...entry, tenantId: null, source: 'library' as const }));
}

const LIBRARY: NewRemoteRecord[] = [
  {
    tenantId: null,
    deviceType: 'tv',
    brand: 'Samsung',
    model: 'Standard TV (BN59 series)',
    source: 'library',
    verified: true,
    notes: 'Samsung 32-bit frame, device address 0x0707. Covers the BN59 handsets shipped with most Samsung televisions.',
    buttons: buttonsFrom(SAMSUNG_TV, code => samsung(0x0707, code)),
  },
  {
    tenantId: null,
    deviceType: 'tv',
    brand: 'LG',
    model: 'Standard TV (AKB series)',
    source: 'library',
    verified: true,
    notes: 'NEC frame, device address 0x04. Covers the AKB handsets shipped with most LG televisions.',
    buttons: buttonsFrom(LG_TV, code => nec(0x04, code)),
  },
  {
    tenantId: null,
    deviceType: 'tv',
    brand: 'Sony',
    model: 'Bravia (RM-ED series)',
    source: 'library',
    verified: true,
    notes: 'Sony SIRC 12-bit, device 1. Every button sends three frames, which is the minimum a SIRC receiver accepts.',
    buttons: buttonsFrom(SONY_TV, code => sirc(1, code)),
  },
  {
    tenantId: null,
    deviceType: 'stb',
    brand: 'Generic',
    model: 'NEC set-top box (reference layout)',
    source: 'library',
    verified: false,
    notes: 'UNVERIFIED reference-design defaults, seeded for the key layout rather than the codes. Capture the real handset before relying on it.',
    buttons: buttonsFrom(GENERIC_NEC_STB, code => nec(0x00, code)),
  },
  {
    tenantId: null,
    deviceType: 'stb',
    brand: 'Generic',
    model: 'RC5 set-top box (reference layout)',
    source: 'library',
    verified: false,
    notes: 'UNVERIFIED reference-design defaults, seeded for the key layout rather than the codes. Capture the real handset before relying on it.',
    buttons: buttonsFrom(GENERIC_RC5_STB, code => rc5(0x00, code)),
  },
  {
    tenantId: null,
    deviceType: 'stb',
    brand: 'ACT',
    model: 'ACT Remote',
    source: 'library',
    verified: false,
    notes: 'ACT Digital TV set-top box remote (NEC protocol, 35 captured buttons).',
    buttons: ACT_STB_BUTTONS,
  },
];

const BUTTON_KEY_BY_NAME: Record<string, string> = {
  '0': 'digit_0',
  '1': 'digit_1',
  '2': 'digit_2',
  '3': 'digit_3',
  '4': 'digit_4',
  '5': 'digit_5',
  '6': 'digit_6',
  '7': 'digit_7',
  '8': 'digit_8',
  '9': 'digit_9',
  'power': 'power',
  'mute': 'mute',
  'vol': 'volume_up',
  'vol-': 'volume_down',
  'ch': 'channel_up',
  'ch-': 'channel_down',
  'menu': 'menu',
  're': 'back',
  'ok': 'ok',
  'exit': 'exit',
  'info': 'info',
  'epg': 'guide',
  'backward': 'rewind',
  'farword': 'forward',
  'stop': 'stop',
  'rec': 'record',
  'next': 'next',
  'p': 'page_up',
  'p-': 'page_down',
  'fav': 'fav',
  'audio': 'audio',
  'mail': 'mail',
  'media': 'media',
  'music': 'music',
  'reminder': 'reminder',
};

function loadActCaptures(remoteId: string): (typeof remoteCaptures.$inferInsert)[] {
  const dir = path.resolve(process.cwd(), 'data/captures');
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).sort();
    return files.map((file) => {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      const button = content.match(/Button:\s*(.+)/)?.[1]?.trim() ?? path.basename(file, '.txt');
      const capturedStr = content.match(/Captured:\s*(.+)/)?.[1]?.trim();
      const protocol = content.match(/Protocol:\s*(.+)/)?.[1]?.trim() ?? 'NEC';
      const address = content.match(/Address:\s*(.+)/)?.[1]?.trim() ?? '0x0';
      const command = content.match(/Command:\s*(.+)/)?.[1]?.trim() ?? '0x0';
      const commandNumber = Number.parseInt(command, 16);
      const rawData = content.match(/RawData:\s*(.+)/)?.[1]?.trim() ?? '';
      const bits = Number.parseInt(content.match(/Bits:\s*(.+)/)?.[1]?.trim() ?? '32', 10);
      const bitOrder = content.match(/BitOrder:\s*(.+)/)?.[1]?.trim() ?? 'LSB first';
      const repeat = content.match(/Repeat:\s*(.+)/)?.[1]?.trim() === 'true';

      const timingsMatch = content.match(/rawTimingsUs:\s*\[([\s\S]*?)\]/);
      const timingsStr = timingsMatch?.[1];
      const rawTimings = timingsStr !== undefined && timingsStr.length > 0
        ? timingsStr
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => Number.parseInt(s, 10))
        : [];

      const buttonKey = BUTTON_KEY_BY_NAME[button] ?? button;

      return {
        remoteId,
        buttonName: button,
        buttonKey,
        protocol,
        address,
        command,
        commandNumber,
        rawData,
        bits,
        bitOrder,
        repeat,
        rawTimings,
        capturedAt: capturedStr !== undefined && capturedStr.length > 0 ? new Date(capturedStr) : null,
      };
    });
  }

  const jsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'data/act-remote-captures.json');
  if (fs.existsSync(jsonPath)) {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Array<{
      buttonName: string;
      buttonKey: string;
      protocol: string;
      address: string;
      command: string;
      commandNumber: number;
      rawData: string;
      bits: number;
      bitOrder: string;
      repeat: boolean;
      rawTimings: number[];
      capturedAt: string | null;
    }>;

    return raw.map(item => ({
      ...item,
      remoteId,
      capturedAt: item.capturedAt !== null && item.capturedAt.length > 0 ? new Date(item.capturedAt) : null,
    }));
  }

  return [];
}

export async function seedRemotes(db: NodePgDatabase<typeof schema>): Promise<number> {
  const library = [...LIBRARY, ...flipperTvRemotes()];

  await db
    .insert(remotes)
    .values(library)
    .onConflictDoUpdate({
      target: [remotes.tenantId, remotes.deviceType, remotes.brand, remotes.model],
      set: {
        buttons: sql`excluded.buttons`,
        notes: sql`excluded.notes`,
        verified: sql`excluded.verified`,
        source: sql`excluded.source`,
        updatedAt: new Date(),
      },
    });

  // The shared library is owned by this file, so a handset dropped from it here
  // goes from the database too. Tenant handsets are learned, never library.
  await db
    .delete(remotes)
    .where(and(
      isNull(remotes.tenantId),
      eq(remotes.source, 'library'),
      notInArray(
        sql`${remotes.deviceType} || '|' || ${remotes.brand} || '|' || ${remotes.model}`,
        library.map(remote => `${remote.deviceType}|${remote.brand}|${remote.model}`),
      ),
    ));

  const [actRemote] = await db
    .select({ id: remotes.id })
    .from(remotes)
    .where(and(isNull(remotes.tenantId), eq(remotes.brand, 'ACT'), eq(remotes.model, 'ACT Remote')))
    .limit(1);

  if (actRemote) {
    const captures = loadActCaptures(actRemote.id);
    if (captures.length > 0) {
      await db
        .insert(remoteCaptures)
        .values(captures)
        .onConflictDoUpdate({
          target: [remoteCaptures.remoteId, remoteCaptures.buttonName],
          set: {
            buttonKey: sql`excluded.button_key`,
            protocol: sql`excluded.protocol`,
            address: sql`excluded.address`,
            command: sql`excluded.command`,
            commandNumber: sql`excluded.command_number`,
            rawData: sql`excluded.raw_data`,
            bits: sql`excluded.bits`,
            bitOrder: sql`excluded.bit_order`,
            repeat: sql`excluded.repeat`,
            rawTimings: sql`excluded.raw_timings`,
            capturedAt: sql`excluded.captured_at`,
            updatedAt: new Date(),
          },
        });
    }
  }

  return library.length;
}
