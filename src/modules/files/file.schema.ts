import type { Static } from 'typebox';
import { Type } from 'typebox';
import { FILE_STATUSES, FILE_VISIBILITIES } from '@/constants/media';
import { STORAGE_FOLDERS } from '@/services/storage/storage.types';
import { StringEnum } from '@/types/typebox';

export const FileResponse = Type.Object({
  id: Type.String({ format: 'uuid', description: 'The user-file id — what every other endpoint takes' }),
  originalName: Type.String(),
  contentType: Type.String(),
  sizeBytes: Type.Union([Type.Integer(), Type.Null()]),
  status: StringEnum(FILE_STATUSES),
  visibility: StringEnum(FILE_VISIBILITIES),
  url: Type.Union([Type.String(), Type.Null()], { description: 'A signed URL, valid until `urlExpiresAt`' }),
  urlExpiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  deduplicated: Type.Boolean({ description: 'True when these exact bytes were already stored' }),
  createdAt: Type.String({ format: 'date-time' }),
});

export const UploadQuery = Type.Object({
  folder: Type.Optional(StringEnum(STORAGE_FOLDERS)),
  visibility: Type.Optional(StringEnum(FILE_VISIBILITIES)),
});

export const DownloadResponse = Type.Object({
  url: Type.String(),
  expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()], {
    description: 'Null for a public file — its URL is durable and does not expire.',
  }),
});

export const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export type UploadQuery = Static<typeof UploadQuery>;
