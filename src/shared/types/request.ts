import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyRequest, RawServerDefault, RouteGenericInterface } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { TSchema } from 'typebox';

/**
 * A request typed by the route's TypeBox schema (AGENTS.md §7).
 *
 * Fastify derives `params`/`body`/`querystring` from the schema through the type
 * provider, not from a hand-written generic — so a controller names the same
 * schema objects its route declares, and a field renamed in one place fails to
 * compile in the other.
 *
 * ```ts
 * export async function get(request: Req<{ params: typeof IdParams }>) { ... }
 * ```
 */
export type Req<S extends { params?: TSchema; body?: TSchema; querystring?: TSchema } = Record<string, TSchema>>
  = FastifyRequest<RouteGenericInterface, RawServerDefault, IncomingMessage, S, TypeBoxTypeProvider>;
