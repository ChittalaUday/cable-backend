import type { FastifyInstance } from 'fastify';
import type { PermissionKey } from '@/shared/security/permissions';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { API_PREFIX, SYSTEM_ROLES } from '@/config/constants';
import { isProduction } from '@/config/env';
import { rolePermissions } from '@/db/schema';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function toSpecPath(url: string): string {
  const withoutPrefix = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url;
  return (withoutPrefix === '' ? '/' : withoutPrefix).replace(/:(\w+)/g, '{$1}');
}

function specForRole(
  spec: Record<string, unknown>,
  routes: readonly { method: string | string[]; url: string; permission: PermissionKey | undefined }[],
  granted: ReadonlySet<string>,
): Record<string, unknown> {
  const required = new Map<string, PermissionKey>();
  for (const route of routes) {
    if (route.permission === undefined)
      continue;

    for (const method of Array.isArray(route.method) ? route.method : [route.method])
      required.set(`${method.toLowerCase()} ${toSpecPath(route.url)}`, route.permission);
  }

  const paths = spec.paths as Record<string, Record<string, unknown>>;
  const kept: Record<string, Record<string, unknown>> = {};

  for (const [path, operations] of Object.entries(paths)) {
    const survivors: Record<string, unknown> = {};

    for (const method of METHODS) {
      if (operations[method] === undefined)
        continue;

      const key = required.get(`${method} ${path}`);
      if (key === undefined || granted.has(key))
        survivors[method] = operations[method];
    }

    if (Object.keys(survivors).length > 0)
      kept[path] = survivors;
  }

  return { ...spec, paths: kept };
}

function grantsOf(app: FastifyInstance, roleId: string): ReadonlySet<string> {
  const granted = new Set<string>();

  app.addHook('onReady', async () => {
    const rows = await app.db
      .select({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));

    for (const row of rows)
      granted.add(row.key);
  });

  return granted;
}

export default fp(async (app) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Satya Cable & Broadband API',
        description: 'Multi-tenant operations API. See AGENTS.md for the rules this service follows.',
        version: '1.0.0',
      },
      servers: [{ url: API_PREFIX }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  if (!isProduction) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });

    const customerGrants = grantsOf(app, SYSTEM_ROLES.CUSTOMER);

    app.get('/docs/customer.json', {
      config: { public: true, cache: false },
      schema: { hide: true },
    }, async () => specForRole(app.swagger() as Record<string, unknown>, app.routeTable, customerGrants));
  }
}, { name: 'swagger', dependencies: ['database'] });
