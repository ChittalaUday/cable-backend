import type { BuiltApp } from '@/app';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';

let app: BuiltApp;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('http cache layer', () => {
  it('sends an etag and answers a revalidation with 304', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toBeDefined();
    expect(first.headers['cache-control']).toBe('no-store');

    const second = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'if-none-match': first.headers.etag as string },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
  });

  it('compresses a response above the threshold', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/docs/json',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect([response.rawPayload[0], response.rawPayload[1]]).toEqual([0x1F, 0x8B]);
  });
});
