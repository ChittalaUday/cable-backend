import multipart from '@fastify/multipart';
import fp from 'fastify-plugin';
import { env } from '@/config/env';

export default fp(async (app) => {
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_BYTES,
      files: 1,
      fields: 8,
    },
  });
}, { name: 'multipart' });
