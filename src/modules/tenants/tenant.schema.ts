import type { Static } from 'typebox';
import { Type } from 'typebox';
import { StringEnum } from '@/types/typebox';

const Uuid = Type.String({ format: 'uuid' });
const Nullable = <T extends ReturnType<typeof Type.String>>(inner: T) => Type.Union([inner, Type.Null()]);

/**
 * A Virtual Payment Address: `name@bank`.
 *
 * Deliberately not a strict NPCI grammar — handles vary by PSP and a rule that
 * is nearly right rejects a real customer's money. Length, one `@`, and no
 * whitespace is the part every handle agrees on.
 */
const Vpa = Type.String({
  minLength: 3,
  maxLength: 120,
  pattern: '^[^@\\s]{2,}@[^@\\s]{2,}$',
  description: 'UPI handle, e.g. "satyacable@okhdfc"',
});

export const UpiAccountResponse = Type.Object({
  id: Uuid,
  upiId: Vpa,
  payeeName: Type.String(),
  label: Nullable(Type.String()),
  isDefault: Type.Boolean(),
  status: StringEnum(['active', 'inactive']),
  createdAt: Type.String({ format: 'date-time' }),
});

export const CreateUpiAccountBody = Type.Object({
  upiId: Vpa,
  payeeName: Type.String({ minLength: 1, maxLength: 120 }),
  label: Type.Optional(Type.String({ maxLength: 60 })),
  /** Makes this the one the collector is shown first; the previous default steps down. */
  isDefault: Type.Optional(Type.Boolean()),
});

export const UpdateUpiAccountBody = Type.Object({
  upiId: Type.Optional(Vpa),
  payeeName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  label: Type.Optional(Nullable(Type.String({ maxLength: 60 }))),
  isDefault: Type.Optional(Type.Boolean()),
  status: Type.Optional(StringEnum(['active', 'inactive'])),
});

export const UpiAccountIdParams = Type.Object({ upiAccountId: Uuid });

export type UpiAccount = Static<typeof UpiAccountResponse>;
export type CreateUpiAccountBody = Static<typeof CreateUpiAccountBody>;
export type UpdateUpiAccountBody = Static<typeof UpdateUpiAccountBody>;
