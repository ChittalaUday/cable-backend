/**
 * Converts Flipper-IRDB `.ir` dumps into the seed library JSON.
 *
 * Usage: pnpm tsx scripts/import-flipper-irdb.ts [path-to-Flipper-IRDB-clone]
 *   git clone --depth 1 https://github.com/Lucaslhm/Flipper-IRDB.git
 *
 * Scope: television handsets for the brands actually sold in India, plus the
 * universal handsets. Anything using a protocol the emitter cannot speak
 * (Kaseikyo, RCA, Pioneer, NEC42) is dropped button by button.
 */
import type { IrCommand, RemoteButton } from '@/types/remotes';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Check } from 'typebox/value';
import { RemoteButtonSchema } from '@/types/remotes';

/** Repo folder → brand shown in the picker. */
const BRANDS: Record<string, string> = {
  Samsung: 'Samsung',
  LG: 'LG',
  Sony: 'Sony',
  Xiaomi: 'Xiaomi (Mi)',
  TCL: 'TCL',
  Ffalcon: 'iFFALCON',
  Panasonic: 'Panasonic',
  Hisense: 'Hisense',
  Haier: 'Haier',
  Philips: 'Philips',
  Toshiba: 'Toshiba',
  Thomson: 'Thomson',
  Hitachi: 'Hitachi',
  Amazon: 'Amazon Fire TV',
  Android: 'Android TV',
};

/** Flipper button name (lowercased) → our remote key. */
const KEYS: Record<string, string> = {
  'power': 'power',
  'power_on': 'power',
  'power_off': 'power',
  'power_toggle': 'power',
  'pwr': 'power',
  'tv_pwr': 'power',
  'tv_power': 'power',
  'tv_on_off': 'power',
  'on_off': 'power',
  'powa': 'power',
  'mute': 'mute',
  'vol_up': 'volume_up',
  'vol+': 'volume_up',
  'volume_up': 'volume_up',
  'vol_dn': 'volume_down',
  'vol_dwn': 'volume_down',
  'vol_down': 'volume_down',
  'vol-': 'volume_down',
  'volume_down': 'volume_down',
  'ch_next': 'channel_up',
  'ch_up': 'channel_up',
  'ch+': 'channel_up',
  'chanel_up': 'channel_up',
  'ch_prev': 'channel_down',
  'ch_dwn': 'channel_down',
  'ch_down': 'channel_down',
  'chanel_down': 'channel_down',
  'ch-': 'channel_down',
  'up': 'up',
  'arrow_up': 'up',
  'down': 'down',
  'arrow_down': 'down',
  'left': 'left',
  'arrow_left': 'left',
  'right': 'right',
  'arrow_right': 'right',
  'ok': 'ok',
  'enter': 'ok',
  'enter_middle': 'ok',
  'select': 'ok',
  'menu': 'menu',
  'home': 'home',
  'exit': 'exit',
  'back': 'back',
  'return': 'back',
  'return_back': 'back',
  'info': 'info',
  'info_i': 'info',
  'display': 'info',
  'display_info': 'info',
  'guide': 'guide',
  'epg': 'guide',
  'source': 'input',
  'sources': 'input',
  'input': 'input',
  'av': 'input',
  'av_mode': 'input',
  'tv_av': 'input',
  'hdmi': 'input',
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
  'play': 'play',
  'pause': 'pause',
  'play_pause': 'play',
  'stop': 'stop',
  'rewind': 'rewind',
  'rew': 'rewind',
  'rwd': 'rewind',
  'backward': 'rewind',
  'rev': 'rewind',
  'reverse': 'rewind',
  'fast_forward': 'forward',
  'fastforward': 'forward',
  'fast_fwd': 'forward',
  'forward': 'forward',
  'ff': 'forward',
  'ffw': 'forward',
  'fwd': 'forward',
  'rec': 'record',
  'record': 'record',
  // Samsung and most Indian handsets print the colour keys as A/B/C/D.
  'red': 'red',
  'red_a': 'red',
  'a_red': 'red',
  'a': 'red',
  'green': 'green',
  'green_b': 'green',
  'b_green': 'green',
  'b': 'green',
  'yellow': 'yellow',
  'yellow_c': 'yellow',
  'c_yellow': 'yellow',
  'c': 'yellow',
  'blue': 'blue',
  'blue_d': 'blue',
  'd_blue': 'blue',
  'd': 'blue',
  // Extras: not on the moulded pad, rendered in the extras grid.
  'netflix': 'netflix',
  'youtube': 'youtube',
  'prime_video': 'prime_video',
  'prime': 'prime_video',
  'settings': 'settings',
  'sleep': 'sleep',
  'subtitle': 'subtitle',
  'subtitles': 'subtitle',
  'sttl': 'subtitle',
  'text': 'text',
  'txt': 'text',
  'ttx': 'text',
  'teletext': 'text',
  'list': 'list',
  'ch_list': 'list',
  'apps': 'apps',
  'search': 'search',
  'fav': 'fav',
  'favorite': 'fav',
  'favorites': 'fav',
  'favourites': 'fav',
  'audio': 'audio',
  'picture': 'picture',
  'smart_hub': 'smart_hub',
  'next': 'next',
  'prev': 'prev',
  'previous': 'prev',
  'options': 'options',
  'option': 'options',
  'tools': 'tools',
  'cc': 'subtitle',
  'pre_ch': 'prev_channel',
  'prev_ch': 'prev_channel',
  'pre-ch': 'prev_channel',
  'last': 'prev_channel',
  'last_view': 'prev_channel',
  'flashback': 'prev_channel',
  'help': 'help',
};

const LABELS: Record<string, string> = {
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
  netflix: 'Netflix',
  youtube: 'YouTube',
  prime_video: 'Prime Video',
  settings: 'Settings',
  sleep: 'Sleep',
  subtitle: 'Subtitle',
  text: 'Teletext',
  list: 'List',
  apps: 'Apps',
  search: 'Search',
  fav: 'Favourites',
  audio: 'Audio',
  picture: 'Picture',
  smart_hub: 'Smart Hub',
  next: 'Next',
  prev: 'Previous',
  options: 'Options',
  tools: 'Tools',
  prev_channel: 'Last channel',
  help: 'Help',
};

const MAX_VARIANTS_PER_BRAND = 4;
const MAX_RAW_PATTERN = 10_000;

type Signal = { name: string } & Record<string, string | undefined>;

/** Flipper stores multi-byte fields as little-endian space-separated hex. */
function bytes(field: string | undefined): number[] {
  return (field ?? '').trim().split(/\s+/).map(b => Number.parseInt(b, 16));
}

/** 16-bit little-endian field (NECext / Samsung / SIRC addresses). */
function word(field: string | undefined): number {
  const [b0 = Number.NaN, b1 = 0] = bytes(field);
  return Number.isNaN(b0) ? Number.NaN : b0 + (b1 << 8);
}

/**
 * 8-bit field. Flipper pads these to four bytes, with the inverse in byte 1
 * for the protocols that transmit one — anything else carries information we
 * cannot represent, so it fails rather than silently truncating.
 */
function byte(field: string | undefined): number {
  const [b0 = Number.NaN, b1 = 0, b2 = 0, b3 = 0] = bytes(field);
  if (Number.isNaN(b0) || b2 !== 0 || b3 !== 0)
    return Number.NaN;
  if (b1 !== 0 && b1 !== (b0 ^ 0xFF))
    return Number.NaN;
  return b0;
}

function toCommand(signal: Signal): IrCommand | null {
  if (signal.type === 'raw') {
    const pattern = (signal.data ?? '').trim().split(/\s+/).map(Number);
    const frequency = Number.parseInt(signal.frequency ?? '38000', 10);
    if (pattern.length === 0 || pattern.length > MAX_RAW_PATTERN)
      return null;
    if (pattern.some(v => !Number.isInteger(v) || v < 1))
      return null;
    if (!Number.isInteger(frequency) || frequency < 1)
      return null;
    return { protocol: 'raw', carrierFrequencyHz: frequency, pattern };
  }

  const command = byte(signal.command);
  if (Number.isNaN(command))
    return null;

  switch (signal.protocol) {
    case 'NEC': {
      const address = byte(signal.address);
      return address <= 0xFF ? { protocol: 'nec', address, command } : null;
    }
    case 'NECext': {
      const address = word(signal.address);
      return address <= 0xFFFF ? { protocol: 'nec-extended', address, command } : null;
    }
    case 'Samsung32': {
      // Samsung repeats the address byte; the emitter takes both bytes.
      const address = byte(signal.address);
      return Number.isNaN(address) ? null : { protocol: 'samsung', address: address * 0x0101, command };
    }
    case 'SIRC':
    case 'SIRC15':
    case 'SIRC20': {
      const address = word(signal.address);
      const bits = signal.protocol === 'SIRC' ? 12 : signal.protocol === 'SIRC15' ? 15 : 20;
      // SIRC is LSB first: seven command bits, then the address.
      const data = (address << 7) | command;
      if (Number.isNaN(address) || data >= 2 ** bits)
        return null;
      // Every SIRC receiver wants the frame at least three times.
      return { protocol: 'sony-sirc', bits, data, repeatCount: 2 };
    }
    case 'RC5':
    case 'RC5X': {
      const address = byte(signal.address);
      return address <= 0x1F && command <= 0x7F ? { protocol: 'rc5', address, command, toggle: 0 } : null;
    }
    case 'RC6': {
      const address = byte(signal.address);
      return address <= 0xFF ? { protocol: 'rc6', address, command, toggle: 0 } : null;
    }
    // Kaseikyo, RCA, Pioneer, NEC42… the emitter has no encoder for these.
    case undefined:
    default:
      return null;
  }
}

function parseFile(file: string): Signal[] {
  const signals: Signal[] = [];
  let current: Signal | null = null;

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      if (current?.name !== undefined)
        signals.push(current);
      current = null;
      continue;
    }
    const match = trimmed.match(/^([a-z_]+):(.*)$/i);
    if (!match)
      continue;
    const [, field = '', raw = ''] = match;
    const value = raw.trim();
    if (field === 'name')
      current = { name: value };
    else if (current)
      current[field] = value;
  }
  if (current?.name !== undefined)
    signals.push(current);

  return signals;
}

/** The one file whose "buttons" are brands, not keys. */
function powerOffKey(name: string) {
  return `power_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 32);
}

/** `Play/Pause`, `P.Size` and `Fast Forward` are all the same shape underneath. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[()./ ]+/g, '_').replace(/^_+|_+$/g, '');
}

function buttonsFrom(signals: Signal[], keyFor: (name: string) => string | undefined): RemoteButton[] {
  const byKey = new Map<string, RemoteButton>();

  for (const signal of signals) {
    const name = signal.name.trim();
    const key = keyFor(name);
    if (key === undefined)
      continue;
    const command = toCommand(signal);
    if (command === null)
      continue;

    // A parsed frame beats a raw recording of the same button.
    const existing = byKey.get(key);
    if (existing && !(existing.command.protocol === 'raw' && command.protocol !== 'raw'))
      continue;

    const button = { key, label: LABELS[key] ?? name, command };
    // The API rejects anything off-schema, so the seed never carries it.
    if (Check(RemoteButtonSchema, button))
      byKey.set(key, button);
  }

  return [...byKey.values()];
}

/** Two files describing the same code set collapse into one entry. */
function codeSetSignature(buttons: RemoteButton[]): string {
  const anchor = buttons.find(b => b.key === 'power') ?? buttons.find(b => b.key === 'volume_up') ?? buttons[0];
  return anchor ? JSON.stringify(anchor.command) : '';
}

function modelName(file: string, brandDir: string): string {
  const base = path.basename(file, '.ir');
  const stripped = base.replace(new RegExp(`^${brandDir}[_-]?`, 'i'), '') || base;
  return stripped.replace(/_/g, ' ').trim();
}

const root = path.resolve(process.argv[2] ?? '../Flipper-IRDB');
if (!fs.existsSync(path.join(root, 'TVs'))) {
  console.error(`❌ Not a Flipper-IRDB clone: ${root}`);
  process.exit(1);
}

interface Entry {
  deviceType: 'tv';
  brand: string;
  model: string;
  verified: boolean;
  notes: string;
  buttons: RemoteButton[];
}

const library: Entry[] = [];

for (const [dir, brand] of Object.entries(BRANDS)) {
  const brandDir = path.join(root, 'TVs', dir);
  if (!fs.existsSync(brandDir)) {
    console.warn(`⚠️  ${dir} missing from the clone, skipped`);
    continue;
  }

  const candidates = fs
    .readdirSync(brandDir)
    .filter(f => f.endsWith('.ir'))
    .map(f => ({ file: f, buttons: buttonsFrom(parseFile(path.join(brandDir, f)), name => KEYS[normalise(name)]) }))
    .filter(c => c.buttons.length >= 5 && c.buttons.some(b => b.key === 'power'))
    .sort((a, b) => b.buttons.length - a.buttons.length);

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (library.filter(e => e.brand === brand).length >= MAX_VARIANTS_PER_BRAND)
      break;
    const signature = codeSetSignature(candidate.buttons);
    if (signature === '' || seen.has(signature))
      continue;
    seen.add(signature);
    library.push({
      deviceType: 'tv',
      brand,
      model: modelName(candidate.file, dir),
      verified: false,
      notes: `Community codes from Flipper-IRDB (TVs/${dir}/${candidate.file}). Unverified — confirm on the set before relying on it.`,
      buttons: candidate.buttons,
    });
  }
}

// Universal handsets: one entry per file, plus the brand-blaster power file.
const universalRoot = path.join(root, 'Universal_TV_Remotes');
const universalFiles = fs
  .readdirSync(universalRoot, { recursive: true, encoding: 'utf8' })
  .filter(f => f.endsWith('.ir'))
  .sort();

for (const relative of universalFiles) {
  const file = path.join(universalRoot, relative);
  const isPowerOff = path.basename(file) === 'UNIVERSAL_POWER_OFF_DEVICES.ir';
  const buttons = buttonsFrom(
    parseFile(file),
    isPowerOff ? powerOffKey : name => KEYS[normalise(name)],
  );
  if (buttons.length < 3)
    continue;

  library.push({
    deviceType: 'tv',
    brand: 'Universal',
    model: isPowerOff ? 'Power off blaster (all brands)' : path.basename(file, '.ir').replace(/_/g, ' '),
    verified: false,
    notes: isPowerOff
      ? 'One power code per major brand, from Flipper-IRDB. Try them in order when the brand is unknown.'
      : `Universal handset codes from Flipper-IRDB (Universal_TV_Remotes/${relative}).`,
    buttons,
  });
}

const out = path.resolve('src/db/seeds/data/tv-remotes.json');
fs.writeFileSync(out, `${JSON.stringify(library, null, 2)}\n`);

const byBrand = new Map<string, number>();
for (const entry of library)
  byBrand.set(entry.brand, (byBrand.get(entry.brand) ?? 0) + 1);

console.log(`✅ ${library.length} remotes → ${out}`);
for (const [brand, count] of byBrand)
  console.log(`   ${brand}: ${count}`);
