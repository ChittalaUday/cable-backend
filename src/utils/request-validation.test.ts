import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ListCustomersQuery } from '@/modules/customers/customer.schema';
import { CreateCatalogItemBody, InwardStockBody, UpdateCatalogItemBody } from '@/modules/inventory/inventory.schema';
import { UpdateLocationBody } from '@/modules/locations/location.schema';
import { ListPackagesQuery } from '@/modules/packages/package.schema';
import { PaginationQuerySchema } from '@/utils/pagination';
import { requestValidationOptions } from './request-validation';

async function request(schema: object, payload: unknown, method: 'POST' | 'PATCH' = 'POST') {
  const app = Fastify(requestValidationOptions);
  app.route({ method, url: '/', schema: { body: schema }, handler: req => req.body });
  try {
    return await app.inject({ method, url: '/', payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
  }
  finally { await app.close(); }
}

describe('request validation safety', () => {
  it('rejects undeclared fields before mass assignment', async () => {
    expect((await request(CreateCatalogItemBody, { name: 'Cable', tenantId: '11111111-1111-4111-8111-111111111111' })).statusCode).toBe(400);
  });
  it('rejects coercible JSON primitive types', async () => {
    expect((await request(CreateCatalogItemBody, { name: 'Cable', isBundle: 1 })).statusCode).toBe(400);
  });
  it('does not inject create defaults into PATCH', async () => {
    const result = await request(UpdateCatalogItemBody, { name: 'Renamed' }, 'PATCH');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ name: 'Renamed' });
  });
  it('preserves nullable coordinates', async () => {
    const result = await request(UpdateLocationBody, { latitude: null, longitude: null }, 'PATCH');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ latitude: null, longitude: null });
  });
  it('bounds stock allocations', async () => {
    expect((await request(InwardStockBody, { catalogId: '11111111-1111-4111-8111-111111111111', quantity: 4294967296 })).statusCode).toBe(400);
  });
  it.each(['abc', '1e100', '-1', '1.001', '10000000000'])('rejects invalid inventory money %s', async (value) => {
    expect((await request(CreateCatalogItemBody, { name: 'Cable', defaultSalePrice: value })).statusCode).toBe(400);
  });
  it('accepts valid intersected pagination and filters while rejecting extra fields', async () => {
    const app = Fastify(requestValidationOptions);
    app.get('/', { schema: { querystring: ListPackagesQuery } }, req => req.query);
    try {
      expect((await app.inject('/')).statusCode).toBe(200);
      expect((await app.inject('/?page=2&limit=5')).json()).toMatchObject({ page: 2, limit: 5 });
      expect((await app.inject('/?q=Basic')).statusCode).toBe(200);
      expect((await app.inject('/?__unexpected=true')).statusCode).toBe(400);
    }
    finally { await app.close(); }
  });
  it('rejects invalid date filters', async () => {
    const app = Fastify(requestValidationOptions);
    app.get('/', { schema: { querystring: ListCustomersQuery } }, () => ({}));
    try {
      expect((await app.inject('/?createdFrom=garbage')).statusCode).toBe(400);
    }
    finally { await app.close(); }
  });
  it('bounds pagination while retaining numeric query coercion', async () => {
    const app = Fastify(requestValidationOptions);
    app.get('/', { schema: { querystring: PaginationQuerySchema } }, req => req.query);
    try {
      expect((await app.inject('/?page=100000000000000000000')).statusCode).toBe(400);
      expect((await app.inject('/?page=2&limit=5')).json()).toEqual({ page: 2, limit: 5 });
    }
    finally { await app.close(); }
  });
});
