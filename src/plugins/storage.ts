import type { StorageProvider } from '@/modules/storage';
import fp from 'fastify-plugin';
import { csv, env } from '@/config/env';
import { createR2Provider, createUnconfiguredStorage, StorageService } from '@/modules/storage';

declare module 'fastify' {
  interface FastifyInstance {
    storage: StorageService;
  }
}

/**
 * Wires object storage (AGENTS.md §8.4).
 *
 * Missing credentials leave the unconfigured provider in place rather than
 * failing boot: the API is useful without file uploads, and a call that needs
 * them says exactly which variables are missing.
 */
export default fp(async (app) => {
  const hasR2 = env.R2_ACCOUNT_ID !== ''
    && env.R2_ACCESS_KEY_ID !== ''
    && env.R2_SECRET_ACCESS_KEY !== ''
    && env.R2_BUCKET !== '';

  const provider: StorageProvider = hasR2
    ? createR2Provider({
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
        ...(env.R2_PUBLIC_BASE_URL === '' ? {} : { publicBaseUrl: env.R2_PUBLIC_BASE_URL }),
      })
    : createUnconfiguredStorage();

  if (!provider.configured)
    app.log.warn('Object storage is not configured — file endpoints will return 503.');

  app.decorate('storage', new StorageService(app.db, {
    provider,
    uploadUrlTtlSeconds: env.UPLOAD_URL_TTL_SECONDS,
    downloadUrlTtlSeconds: env.DOWNLOAD_URL_TTL_SECONDS,
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    allowedContentTypes: csv(env.ALLOWED_UPLOAD_TYPES),
  }));
}, { name: 'storage', dependencies: ['database'] });
