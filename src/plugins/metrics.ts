import type { RouteOptions } from 'fastify';
import metrics from 'fastify-metrics';
import fp from 'fastify-plugin';
import { isTest } from '@/config/env';

export default fp(async (app) => {
  await app.register(metrics, {
    endpoint: {
      url: '/metrics',
      config: { public: true, disableMetrics: true },
    } as RouteOptions,
    clearRegisterOnInit: isTest,
    routeMetrics: {
      enabled: { histogram: true, summary: false },
      registeredRoutesOnly: true,
      routeBlacklist: ['/metrics'],
      overrides: {
        labels: {
          getRouteLabel: request => request.routeOptions.url ?? '__unknown__',
        },
        histogram: {
          buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        },
      },
    },
  });
}, { name: 'metrics' });
