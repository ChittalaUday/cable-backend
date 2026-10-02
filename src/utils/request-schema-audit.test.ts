import type { BuildCompilerFromPool } from '@fastify/ajv-compiler';
import type { FastifySchemaCompiler } from 'fastify';
import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '@/app';
import { requestValidationOptions } from '@/utils/request-validation';

type Context = Parameters<FastifySchemaCompiler<unknown>>[0];
type Schema = Record<string, unknown>;

function declaredTypes(schema: Schema): Set<string> {
  if (typeof schema.type === 'string')
    return new Set([schema.type === 'integer' ? 'number' : schema.type]);
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf))
    return new Set(((schema.anyOf ?? schema.oneOf) as Schema[]).flatMap(branch => [...declaredTypes(branch)]));
  return new Set();
}

function properties(schema: Schema, path = ''): [string, Schema][] {
  const result: [string, Schema][] = [];
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    const child = field as Schema;
    result.push([`${path}.${key}`, child], ...properties(child, `${path}.${key}`));
  }
  if (schema.items !== undefined && typeof schema.items === 'object')
    result.push(...properties(schema.items as Schema, `${path}[]`));
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    for (const branch of (schema[keyword] as Schema[] | undefined) ?? [])
      result.push(...properties(branch, path));
  }
  return result;
}

describe('all registered API request schemas', () => {
  it('compiles every route and checks body field types and request boundaries', async () => {
    const contexts: Context[] = [];
    const factory = requestValidationOptions.schemaController!.compilersFactory!;
    const original = factory.buildValidator! as BuildCompilerFromPool;
    let compile: FastifySchemaCompiler<unknown> | undefined;
    const spy = vi.spyOn(factory, 'buildValidator').mockImplementation(((external: Parameters<typeof original>[0], options: Parameters<typeof original>[1]) => {
      const compiler = original(external, options) as unknown as FastifySchemaCompiler<unknown>;
      compile = compiler;
      return ((context: Context) => {
        contexts.push(context);
        return compiler(context);
      }) as unknown as ReturnType<typeof original>;
    }) as typeof original);
    const app = await buildApp();
    try {
      await app.ready();
      spy.mockRestore();
      expect(contexts.length).toBeGreaterThan(100);
      const unique = [...new Map(contexts.map(context => [`${context.method} ${context.url} ${context.httpPart}`, context])).values()];
      const badTypes = [[null, 'null'], [1, 'number'], [true, 'boolean'], ['wrong-type', 'string'], [[], 'array'], [{}, 'object']] as const;
      let checked = 0;
      let fields = 0;
      const modules = new Set<string>();
      for (const context of unique) {
        modules.add(context.url.split('/')[3] ?? context.url);
        const schema = context.schema as Schema;
        checked += checkDefaultQuery(context, schema, compile!);
        for (const [path, field] of properties(schema)) {
          const validator = compile!({ ...context, schema: { type: 'object', properties: { value: field }, required: ['value'] } });
          fields++;
          if (context.httpPart === 'body') {
            const allowed = declaredTypes(field);
            if (allowed.size > 0) {
              for (const [value, kind] of badTypes) {
                if (!allowed.has(kind)) {
                  expect(validator({ value: structuredClone(value) }), `${context.method} ${context.url} ${path}: unexpected ${kind}`).toBe(false);
                  checked++;
                }
              }
            }
          }
          const badValues = invalidBoundaries(field);
          for (const value of badValues) {
            expect(validator({ value }), `${context.method} ${context.url} ${context.httpPart} ${path}: ${JSON.stringify(value).slice(0, 80)}`).toBe(false);
            checked++;
          }
        }
        if (context.httpPart !== 'headers') {
          const validator = compile!(context);
          expect(validator({ __unexpected: true }), `${context.url}: extra request field`).toBe(false);
          expect(validator.errors?.some(error => error.keyword === 'additionalProperties'), `${context.url}: extra field rejected explicitly`).toBe(true);
          checked++;
        }
      }
      process.stdout.write(`API schema audit: ${unique.length} registered request parts, ${modules.size} modules, ${fields} field occurrences, ${checked} invalid-value probes.\n`);
    }
    finally {
      spy.mockRestore();
      await app.close();
    }
  }, 60_000);
});

function invalidBoundaries(field: Schema): unknown[] {
  const badValues: unknown[] = [];
  if (typeof field.minimum === 'number')
    badValues.push(field.minimum - 1);
  if (typeof field.maximum === 'number')
    badValues.push(field.maximum + 1);
  if (field.type === 'integer')
    badValues.push(1.5);
  if (typeof field.minLength === 'number' && field.minLength > 0)
    badValues.push('');
  if (typeof field.maxLength === 'number')
    badValues.push('x'.repeat(field.maxLength + 1));
  if (typeof field.minItems === 'number' && field.minItems > 0)
    badValues.push([]);
  if (typeof field.maxItems === 'number')
    badValues.push(Array.from({ length: field.maxItems + 1 }).fill(null));
  if (typeof field.format === 'string')
    badValues.push('invalid-format');
  if (Array.isArray(field.enum))
    badValues.push('__invalid_enum__');
  return badValues;
}

function allowsEmpty(schema: Schema): boolean {
  const fields = schema.properties as Record<string, Schema> | undefined;
  const required = schema.required as string[] | undefined;
  if ((required ?? []).some(key => fields?.[key]?.default === undefined))
    return false;
  if (typeof schema.minProperties === 'number' && schema.minProperties > 0)
    return false;
  const intersections = schema.allOf as Schema[] | undefined;
  if (intersections !== undefined && !intersections.every(allowsEmpty))
    return false;
  const alternatives = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
  return alternatives === undefined || alternatives.some(allowsEmpty);
}

function checkDefaultQuery(context: Context, schema: Schema, compile: FastifySchemaCompiler<unknown>): number {
  if (context.httpPart !== 'querystring' || !allowsEmpty(schema))
    return 0;
  expect(compile(context)({}), `${context.url}: valid empty/default query`).toBe(true);
  return 1;
}
