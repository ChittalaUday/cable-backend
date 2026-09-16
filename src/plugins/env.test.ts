import { describe, expect, it } from 'vitest';
import { buildApp } from '@/app';

describe('env plugin (@fastify/env)', () => {
  it('decorates app with validated config matching env schema', async () => {
    const app = await buildApp();

    expect(app.config).toBeDefined();
    expect(typeof app.config.PORT).toBe('number');
    expect(typeof app.config.APP_ENV).toBe('string');
    expect(typeof app.config.DATABASE_URL).toBe('string');
    expect(typeof app.runPreflight).toBe('function');

    await app.close();
  });
});
