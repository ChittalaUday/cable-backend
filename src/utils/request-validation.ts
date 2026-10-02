import type { FastifySchemaCompiler, FastifyServerOptions } from 'fastify';
import AjvCompiler from '@fastify/ajv-compiler';

function intersectionKeys(schema: Record<string, unknown>, siblings: readonly string[]): string[] {
  const branches = schema.allOf as Record<string, unknown>[] | undefined;
  return [...new Set([...siblings, ...Object.keys(schema.properties ?? {}), ...(branches ?? []).flatMap(branch => Object.keys(branch.properties ?? {}))])];
}

function traverseKeywords(schema: Record<string, unknown>, result: Record<string, unknown>, patch: boolean, siblings: readonly string[], allowed: readonly string[]): void {
  // Traverse schema keywords only: defaults/examples are data, not schemas.
  for (const keyword of ['properties', 'patternProperties', '$defs', 'definitions']) {
    const entries = schema[keyword];
    if (entries !== null && typeof entries === 'object') {
      result[keyword] = Object.fromEntries(Object.entries(entries).map(([key, child]) => [key, hardenBodySchema(child, patch)]));
    }
  }
  for (const keyword of ['items', 'anyOf', 'oneOf', 'allOf', 'not', 'additionalProperties']) {
    if (typeof schema[keyword] === 'object')
      result[keyword] = hardenBodySchema(schema[keyword], patch, keyword === 'allOf' ? allowed : siblings);
  }
}

/** JSON bodies are typed data; only URL parameters need type coercion. */
export function hardenBodySchema(value: unknown, patch: boolean, siblings: readonly string[] = []): unknown {
  if (Array.isArray(value))
    return value.map(item => hardenBodySchema(item, patch, siblings));
  if (value === null || typeof value !== 'object')
    return value;
  const schema = value as Record<string, unknown>;
  const result: Record<string, unknown> = { ...schema };
  const allowed = intersectionKeys(schema, siblings);
  traverseKeywords(schema, result, patch, siblings, allowed);
  if (schema.properties !== undefined && schema.additionalProperties === undefined) {
    // An intersection must allow fields declared by its sibling branches.
    result.properties = { ...Object.fromEntries(siblings.map(key => [key, {}])), ...result.properties as Record<string, unknown> };
    result.additionalProperties = false;
  }
  if (patch)
    delete result.default;
  return result;
}

const factory = AjvCompiler();
export const requestValidationOptions: Pick<FastifyServerOptions, 'ajv' | 'schemaController'> = {
  ajv: { customOptions: { removeAdditional: false, allErrors: true } },
  schemaController: {
    compilersFactory: {
      buildValidator: ((externalSchemas: Parameters<typeof factory>[0], options: NonNullable<Parameters<typeof factory>[1]>) => {
        if (options.mode === 'JTD')
          throw new Error('Request validation requires JSON Schema');
        const regular = factory(externalSchemas, options) as unknown as FastifySchemaCompiler<unknown>;
        const body = factory(externalSchemas, {
          ...options,
          customOptions: { ...options.customOptions, coerceTypes: false },
        }) as unknown as FastifySchemaCompiler<unknown>;
        return (context: Parameters<FastifySchemaCompiler<unknown>>[0]) => {
          if (context.httpPart !== 'body')
            return regular({ ...context, schema: context.httpPart === 'headers' ? context.schema : hardenBodySchema(context.schema, false) });
          return body({ ...context, schema: hardenBodySchema(context.schema, context.method === 'PATCH') });
        };
      }) as unknown as typeof factory,
    },
  },
};
