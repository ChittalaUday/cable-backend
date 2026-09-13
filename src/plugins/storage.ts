import type { StorageProvider } from '@/modules/storage/storage.types';
import fp from 'fastify-plugin';
import { csv, env } from '@/config/env';
import { createR2Provider } from '@/modules/storage/providers/r2.provider';
import { createUnconfiguredStorage } from '@/modules/storage/providers/unconfigured.provider';
import { StorageService } from '@/modules/storage/storage.service';

declare module 'fastify' {
  interface FastifyInstance {
    storage: StorageService;
  }
}

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
        ...(env.R2_ENDPOINT === '' ? {} : { endpoint: env.R2_ENDPOINT }),
        ...(env.R2_JURISDICTION === '' ? {} : { jurisdiction: env.R2_JURISDICTION }),
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
