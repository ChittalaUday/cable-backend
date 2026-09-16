import type { Static, TSchema } from 'typebox';
import { Type } from 'typebox';
import { REMOTE_DEVICE_TYPES, REMOTE_KEY_PATTERN } from '@/constants/remotes';
import { StringEnum } from '@/types/typebox';

const INT_MAX = 2_147_483_647;

const Byte = Type.Integer({ minimum: 0, maximum: 0xFF });
const Word = Type.Integer({ minimum: 0, maximum: 0xFFFF });
const Toggle = Type.Union([Type.Literal(0), Type.Literal(1)]);

export const DeviceType = StringEnum(REMOTE_DEVICE_TYPES);

const CommonOptions = {
  carrierFrequencyHz: Type.Optional(Type.Integer({ minimum: 1, maximum: INT_MAX })),
  repeatCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
};

export const IrCommandSchema = Type.Union([
  Type.Object({
    protocol: Type.Literal('raw'),
    carrierFrequencyHz: Type.Integer({ minimum: 1, maximum: INT_MAX }),
    pattern: Type.Array(Type.Integer({ minimum: 1, maximum: INT_MAX }), { minItems: 1, maxItems: 10_000 }),
  }),
  Type.Object({ protocol: Type.Literal('nec'), address: Byte, command: Byte, ...CommonOptions }),
  Type.Object({ protocol: Type.Literal('nec-extended'), address: Word, command: Byte, ...CommonOptions }),
  Type.Object({ protocol: Type.Literal('samsung'), address: Word, command: Byte, ...CommonOptions }),
  Type.Object({
    protocol: Type.Literal('sony-sirc'),
    bits: Type.Union([Type.Literal(12), Type.Literal(15), Type.Literal(20)]),
    data: Type.Integer({ minimum: 0, maximum: 0xFFFFF }),
    ...CommonOptions,
  }),
  Type.Object({
    protocol: Type.Literal('rc5'),
    address: Type.Integer({ minimum: 0, maximum: 0x1F }),
    command: Type.Integer({ minimum: 0, maximum: 0x7F }),
    toggle: Toggle,
    ...CommonOptions,
  }),
  Type.Object({ protocol: Type.Literal('rc6'), address: Byte, command: Byte, toggle: Toggle, ...CommonOptions }),
]);

export const RemoteButtonSchema = Type.Object({
  key: Type.String({ pattern: REMOTE_KEY_PATTERN }),
  label: Type.String({ minLength: 1, maxLength: 40 }),
  command: IrCommandSchema,
});

export type IrCommand = Static<typeof IrCommandSchema>;
export type RemoteButton = Static<typeof RemoteButtonSchema>;

export type { TSchema };
