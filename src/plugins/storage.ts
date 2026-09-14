import type { StorageService } from '@/modules/storage/storage.service';
import fp from 'fastify-plugin';
import { createStorageProvider, createStorageService } from '@/modules/storage/storage.service';

declare module 'fastify' {
  interface FastifyInstance {
    storage: StorageService;
  }
}

export default fp(async (app) => {
  const provider = createStorageProvider();

  if (!provider.configured)
    app.log.warn('Object storage is not configured — file endpoints will return 503.');

  app.decorate('storage', createStorageService(app.db, provider));
}, { name: 'storage', dependencies: ['database'] });
