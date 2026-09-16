import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { RemoteKey } from '@/constants/remotes';
import type * as schema from '@/db/schema';
import type { IrCommand, NewRemoteRecord, RemoteButton } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { REMOTE_KEYS } from '@/constants/remotes';
import { remotes } from '@/db/schema';

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
];

export async function seedRemotes(db: NodePgDatabase<typeof schema>): Promise<number> {
  await db
    .insert(remotes)
    .values(LIBRARY)
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

  return LIBRARY.length;
}
