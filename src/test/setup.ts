import process from 'node:process';

process.env.NODE_ENV = 'test';
process.env.APP_ENV ??= 'local';
process.env.JWT_SECRET ??= 'test-secret-at-least-32-characters-long!!';
process.env.DATABASE_URL ??= process.env.DATABASE_URL_TEST ?? 'postgres://cable:cable@localhost:5432/cable_test';
