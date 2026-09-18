import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FileRecord, UserFileRecord } from '@/services/storage/storage.types';
import { ERROR_CODES } from '@/errors';
import { badRequest } from '@/errors/domain-error';
import { publicUrlFor } from '@/services/storage/storage.service';
import { ERRORS } from '@/types/typebox';
import {
  DownloadResponse,
  FileResponse,
  IdParams,
  UploadQuery,
} from './file.schema';

interface Presented {
  userFile: UserFileRecord;
  file: FileRecord;
  deduplicated: boolean;
  url?: string | null;
  urlExpiresAt?: Date | null;
}

function present({ userFile, file, deduplicated, url, urlExpiresAt }: Presented) {
  return {
    id: userFile.id,
    originalName: userFile.originalName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    visibility: userFile.visibility,
    url: url ?? null,
    urlExpiresAt: urlExpiresAt?.toISOString() ?? null,
    deduplicated,
    createdAt: userFile.createdAt.toISOString(),
  };
}

async function urlFor(
  storage: { downloadUrl: (id: string, tenantId: string | null) => Promise<{ url: string; expiresAt: Date }> },
  userFile: UserFileRecord,
  file: FileRecord,
  tenantId: string | null,
): Promise<{ url: string | null; expiresAt: Date | null }> {
  if (file.publicUrl !== null) {
    return { url: file.publicUrl, expiresAt: null };
  }

  if (userFile.visibility === 'public' && file.storageKey !== null) {
    const url = publicUrlFor(file.storageKey);
    if (url !== null)
      return { url, expiresAt: null };
  }

  const signed = await storage.downloadUrl(userFile.id, tenantId);
  return { url: signed.url, expiresAt: signed.expiresAt };
}

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.post('/files', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['files'],
      summary: 'Upload a file',
      description: 'A `multipart/form-data` body with one `file` part. Identical bytes already stored are reused rather than uploaded twice — the response says so with `deduplicated`. The signed `url` it returns is what a notification `imageUrl` expects.',
      querystring: UploadQuery,
      response: { 201: FileResponse, ...ERRORS, 413: ERRORS[400], 415: ERRORS[400] },
      consumes: ['multipart/form-data'],
    },
  }, async (request, reply) => {
    const part = await request.file();

    if (part === undefined)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Attach one file part named "file"');

    const result = await request.server.storage.uploadWithLocalStaging({
      tenantId: request.tenantId ?? null,
      uploadedBy: request.session.sub,
      originalName: part.filename,
      contentType: part.mimetype,
      stream: part.file,
      ...(request.query.folder === undefined ? {} : { folder: request.query.folder }),
      ...(request.query.visibility === undefined ? {} : { visibility: request.query.visibility }),
    });

    if (part.file.truncated) {
      await request.server.storage.remove(result.userFile.id, request.tenantId ?? null);
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'File is larger than the upload limit');
    }

    const { url, expiresAt } = await urlFor(
      request.server.storage,
      result.userFile,
      result.file,
      request.tenantId ?? null,
    );

    return reply.status(201).send(present({ ...result, url, urlExpiresAt: expiresAt }));
  });

  app.get('/files/:id', {
    schema: {
      tags: ['files'],
      summary: 'A fresh signed download URL for one file',
      description: 'Signed URLs expire, so fetch this each time rather than storing the URL.',
      params: IdParams,
      response: { 200: DownloadResponse, ...ERRORS },
    },
  }, async (request) => {
    const tenantId = request.tenantId ?? null;
    const { userFile, file } = await request.server.storage.findOwned(request.params.id, tenantId);
    const { url, expiresAt } = await urlFor(request.server.storage, userFile, file, tenantId);

    return { url: url ?? '', expiresAt: expiresAt?.toISOString() ?? null };
  });

  app.delete('/files/:id', {
    schema: {
      tags: ['files'],
      summary: 'Delete a file',
      description: 'Soft delete. The stored object is removed later by the storage cleanup job, once nothing else references those bytes.',
      params: IdParams,
      response: { 204: { type: 'null' }, ...ERRORS },
    },
  }, async (request, reply) => {
    await request.server.storage.remove(request.params.id, request.tenantId ?? null);
    return reply.status(204).send(null);
  });
};

export default routes;
