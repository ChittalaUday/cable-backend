import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyRequest, RawServerDefault, RouteGenericInterface } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { TSchema } from 'typebox';

export type Req<S extends { params?: TSchema; body?: TSchema; querystring?: TSchema } = Record<string, TSchema>>
  = FastifyRequest<RouteGenericInterface, RawServerDefault, IncomingMessage, S, TypeBoxTypeProvider>;
