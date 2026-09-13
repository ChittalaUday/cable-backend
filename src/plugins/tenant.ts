import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { TENANT_HEADER } from '@/config/constants';
import { ERROR_CODES } from '@/shared/errors';
import { forbidden } from '@/shared/errors/domain-error';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Opt OUT of authentication. Sign-in routes, health and docs only.
     *
     * The default is protected: a route that forgets to say anything is
     * authenticated, rather than open. Getting that default the wrong way round
     * is how an endpoint ships without a guard.
     */
    public?: boolean;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The tenant this request acts in (§4.4). Present on every authenticated
     * request whose caller belongs to exactly one tenant, or that sent
     * `X-Tenant-Id`; `undefined` otherwise, and `requirePermission` refuses it.
     */
    tenantId: string | undefined;
  }
}

/**
 * Authentication and active tenant, applied to EVERY route (AGENTS.md §4.4).
 *
 * One `onRequest` hook rather than a pair of hooks repeated on every route:
 * a guard you have to remember is a guard someone will forget, and the failure
 * is silent — the endpoint just works, for everyone.
 *
 * Routes opt out with `config: { public: true }`.
 */
export default fp(async (app) => {
  app.decorateRequest('tenantId');

  app.addHook('onRequest', async (request: FastifyRequest) => {
    // Swagger UI registers its own routes inside its plugin, so it never sees
    // the `public` flag — its prefix is checked by hand instead.
    if (request.routeOptions.config.public === true || request.url.startsWith('/docs'))
      return;

    await app.authenticate(request);

    const header = request.headers[TENANT_HEADER];
    const asked = Array.isArray(header) ? header[0] : header;
    const memberships = request.session.memberships;

    if (asked !== undefined && asked !== '') {
      // Validated against the signed token, never the database: the claim was
      // written at sign-in and the client cannot edit it.
      if (!memberships.some(m => m.t === asked))
        throw forbidden(ERROR_CODES.TENANT_NOT_A_MEMBER, 'You are not a member of this tenant');

      request.tenantId = asked;
    }
    else if (memberships.length === 1) {
      // One membership is not ambiguous, so the header is noise. Most callers
      // are staff of a single operator and never send it.
      request.tenantId = memberships[0]!.t;
    }

    request.log = request.log.child({ tenantId: request.tenantId });
  });
}, { name: 'tenant', dependencies: ['auth'] });
