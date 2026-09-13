import type { ObjectHead, PutObject, SignedUrl, StorageProvider } from '../storage.types';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Explicit endpoint override (e.g. jurisdiction-specific endpoint). */
  endpoint?: string;
  /** Jurisdiction for jurisdiction-specific endpoints (e.g. 'eu', 'fedramp'). */
  jurisdiction?: string;
  /** Public base URL for a bucket served over a custom domain, if any. */
  publicBaseUrl?: string;
}

/**
 * Cloudflare R2 over the S3 API.
 *
 * R2 has no regions, so `region` is the required-but-ignored `auto`. Every
 * other S3-compatible store works through this same provider with a different
 * endpoint.
 */
export function createR2Provider(config: R2Config): StorageProvider {
  const endpoint = config.endpoint
    ?? (config.jurisdiction !== undefined && config.jurisdiction !== ''
      ? `https://${config.accountId}.${config.jurisdiction}.r2.cloudflarestorage.com`
      : `https://${config.accountId}.r2.cloudflarestorage.com`);

  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  // getSignedUrl's command parameter is wider than exactOptionalPropertyTypes
  // accepts from a concrete command, so each call site passes its own type.
  async function sign(
    command: PutObjectCommand | GetObjectCommand,
    expiresIn: number,
  ): Promise<SignedUrl> {
    const url = await getSignedUrl(client, command as Parameters<typeof getSignedUrl>[1], { expiresIn });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  return {
    name: 'cloudflare-r2',
    bucket: config.bucket,
    configured: true,

    createUploadUrl: async (key, contentType, expiresInSeconds) => sign(
      new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }),
      expiresInSeconds,
    ),

    createDownloadUrl: async (key, expiresInSeconds) => sign(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      expiresInSeconds,
    ),

    async head(key: string): Promise<ObjectHead | null> {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return {
          sizeBytes: result.ContentLength ?? 0,
          contentType: result.ContentType ?? null,
          // R2 returns the MD5 ETag; a sha-256 arrives as a checksum header.
          checksum: result.ChecksumSHA256 ?? null,
        };
      }
      catch (error) {
        // A missing object is an answer, not a failure — the caller asked whether
        // it exists. Anything else is a real storage problem and must surface.
        if (isNotFound(error))
          return null;
        throw error;
      }
    },

    async put({ key, body, contentType }: PutObject): Promise<void> {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }));
    },

    async remove(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },

    async ping(): Promise<void> {
      await client.send(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 }));
    },
  };
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}
