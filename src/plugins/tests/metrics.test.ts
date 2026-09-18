import Fastify from 'fastify';
import metricsPlugin from 'fastify-metrics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const app = Fastify();

beforeAll(async () => {
  await app.register(metricsPlugin, {
    endpoint: '/metrics',
    defaultMetrics: { enabled: false },
    routeMetrics: {
      enabled: true,
      registeredRoutesOnly: true,
    },
  });
  app.get('/customers/:id', async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => app.close());

describe('metrics', () => {
  it('labels requests with the normalized route, method, and status', async () => {
    await app.inject({ method: 'GET', url: '/customers/customer-123' });
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('http_request_duration_seconds_count{method="GET",route="/customers/:id",status_code="200"} 1');
    expect(response.body).not.toContain('customer-123');
  });
});
