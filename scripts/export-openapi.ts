import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { buildApp } from '@/app';

const destination = process.argv[2];
if (destination === undefined)
  throw new Error('Usage: tsx scripts/export-openapi.ts <destination.json>');

const app = await buildApp();
try {
  await app.ready();
  await writeFile(destination, `${JSON.stringify(app.swagger(), null, 2)}\n`);
}
finally {
  await app.close();
}
