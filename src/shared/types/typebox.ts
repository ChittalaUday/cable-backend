import type { TSchema } from 'typebox';
import { Type } from 'typebox';

export function StringEnum<T extends string>(values: readonly T[]) {
  return Type.Unsafe<T>(Type.String({ enum: values as unknown as string[] }));
}

export function StringEnumWithDefault<T extends string>(values: readonly T[], defaultValue: T) {
  return Type.Unsafe<T>(Type.String({ enum: values as unknown as string[], default: defaultValue }));
}

export const Uuid = Type.String({ format: 'uuid' });

export function Nullable<T extends TSchema>(schema: T) {
  return Type.Union([schema, Type.Null()]);
}

const errorRef = { $ref: 'ErrorResponse#' };

export const ERRORS = {
  400: errorRef,
  401: errorRef,
  403: errorRef,
  404: errorRef,
  409: errorRef,
} as const;
