import { pgSchema } from 'drizzle-orm/pg-core';

export const tenancy = pgSchema('tenancy');

export const auth = pgSchema('auth');

export const iam = pgSchema('iam');

export const crm = pgSchema('crm');

export const geo = pgSchema('geo');

export const notify = pgSchema('notify');

export const media = pgSchema('media');

export const analytics = pgSchema('analytics');

export const audit = pgSchema('audit');
