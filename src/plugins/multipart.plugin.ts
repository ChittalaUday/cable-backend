import multipart from '@fastify/multipart';
import fp from 'fastify-plugin';
import { env } from '@/config/env';

// One file per request, capped at the same limit the storage service enforces,
// so an oversized body is refused at the connection rather than after it has
// been streamed to disk.
export default fp(async (app) => {
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_BYTES,
      files: 1,
      fields: 8,
    },
  });
}, { name: 'multipart' });
