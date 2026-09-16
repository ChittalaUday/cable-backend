export const REMOTE_DEVICE_TYPES = ['tv', 'stb'] as const;
export type RemoteDeviceType = (typeof REMOTE_DEVICE_TYPES)[number];

export const REMOTE_SOURCES = ['library', 'learned'] as const;
export type RemoteSource = (typeof REMOTE_SOURCES)[number];

export const REMOTE_KEYS = [
  'power',
  'input',
  'menu',
  'home',
  'guide',
  'info',
  'back',
  'exit',

  'up',
  'down',
  'left',
  'right',
  'ok',

  'volume_up',
  'volume_down',
  'mute',
  'channel_up',
  'channel_down',

  'digit_0',
  'digit_1',
  'digit_2',
  'digit_3',
  'digit_4',
  'digit_5',
  'digit_6',
  'digit_7',
  'digit_8',
  'digit_9',

  'play',
  'pause',
  'stop',
  'rewind',
  'forward',
  'record',

  'red',
  'green',
  'yellow',
  'blue',
] as const;
export type RemoteKey = (typeof REMOTE_KEYS)[number];

export const REMOTE_KEY_PATTERN = '^[a-z0-9][a-z0-9_]{0,31}$';

export const REMOTE_DEVICE_TYPE = {
  TV: 'tv',
  STB: 'stb',
} as const satisfies Record<string, RemoteDeviceType>;

export const REMOTE_SOURCE = {
  LIBRARY: 'library',
  LEARNED: 'learned',
} as const satisfies Record<string, RemoteSource>;
