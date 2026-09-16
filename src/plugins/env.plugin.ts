import type { FastifyPluginAsync } from 'fastify';
import type { BuiltApp } from '@/app';
import type { Env } from '@/config/env';
import type { PreflightResult } from '@/config/preflight';
import fastifyEnv from '@fastify/env';
import fp from 'fastify-plugin';
import { env, EnvSchema } from '@/config/env';
import { runPreflight } from '@/config/preflight';

declare module 'fastify' {
  interface FastifyInstance {
    config: Env;
    runPreflight: () => Promise<PreflightResult>;
  }
}

const envPlugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyEnv, {
    schema: EnvSchema,
    data: env,
    confKey: 'config',
  });

  app.decorate('runPreflight', async () => runPreflight(app as unknown as BuiltApp));
};

export default fp(envPlugin, {
  name: 'env',
});
