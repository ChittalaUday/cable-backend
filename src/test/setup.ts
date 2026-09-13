import process from 'node:process';

// Env is validated at import (config/env.ts), so the test defaults must exist
// before any module that reads it is loaded.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL ??= process.env.DATABASE_URL_TEST ?? 'postgres://cable:cable@localhost:5432/cable_test';
