export const FILE_KINDS = ['upload', 'generated'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_VISIBILITIES = ['private', 'public'] as const;
export type FileVisibility = (typeof FILE_VISIBILITIES)[number];

export const FILE_STATUSES = ['pending', 'ready', 'failed', 'deleted'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const CHECKSUM_ALGORITHMS = ['md5', 'sha1', 'sha256', 'crc32c'] as const;
export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number];

export const FILE_STATUS = {
  PENDING: 'pending',
  READY: 'ready',
  FAILED: 'failed',
  DELETED: 'deleted',
} as const satisfies Record<string, FileStatus>;

export const FILE_KIND = {
  UPLOAD: 'upload',
  GENERATED: 'generated',
} as const satisfies Record<string, FileKind>;

export const FILE_VISIBILITY = {
  PRIVATE: 'private',
  PUBLIC: 'public',
} as const satisfies Record<string, FileVisibility>;
