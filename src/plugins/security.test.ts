import { describe, expect, it } from 'vitest';
import { buildApp } from '@/app';

describe('security plugin', () => {
  it('decorates responses with hardened security headers', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    expect(response.statusCode).toBe(200);

    // Helmet headers
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');

    // Permissions policy
    expect(response.headers['permissions-policy']).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), vr=()',
    );

    // Rate limit headers (draft spec)
    expect(response.headers['ratelimit-limit']).toBeDefined();
    expect(response.headers['ratelimit-remaining']).toBeDefined();
    expect(response.headers['ratelimit-reset']).toBeDefined();

    await app.close();
  });

  it('handles CORS preflight requests correctly', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/health',
      headers: {
        'origin': 'http://localhost:8081',
        'access-control-request-method': 'GET',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(response.headers['access-control-allow-credentials']).toBe('true');

    await app.close();
  });
});
