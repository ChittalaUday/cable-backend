import type { App } from 'firebase-admin/app';
import type { Auth } from 'firebase-admin/auth';
import type { Database } from 'firebase-admin/database';
import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import type { Storage } from 'firebase-admin/storage';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import fp from 'fastify-plugin';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getStorage } from 'firebase-admin/storage';
import { env } from '@/config/env';

export interface FirebaseServices {
  app: App;
  auth: Auth;
  database: Database | null;
  firestore: Firestore;
  messaging: Messaging;
  storage: Storage;
  projectId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    firebase: FirebaseServices | null;
  }
}

function findServiceAccountJson(): string | null {
  if (env.FIREBASE_SERVICE_ACCOUNT_PATH !== '') {
    const resolved = path.resolve(process.cwd(), env.FIREBASE_SERVICE_ACCOUNT_PATH);
    if (existsSync(resolved))
      return resolved;
  }

  const root = process.cwd();
  try {
    const files = readdirSync(root);
    const match = files.find(f => f.endsWith('.json') && (f.includes('-adminsdk-') || f.includes('service-account')));
    if (match !== undefined)
      return path.join(root, match);
  }
  catch {
    // Ignore error
  }

  return null;
}

function resolveCredential() {
  const jsonPath = findServiceAccountJson();
  if (jsonPath !== null) {
    const content = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      project_id?: string;
      client_email?: string;
      private_key?: string;
    };
    return {
      credential: cert(content as Parameters<typeof cert>[0]),
      projectId: content.project_id ?? 'unknown',
    };
  }

  if (env.FIREBASE_SERVICE_ACCOUNT_PATH !== '')
    throw new Error(`Firebase service account file not found at: ${env.FIREBASE_SERVICE_ACCOUNT_PATH}`);

  return null;
}

export default fp(async (server) => {
  const resolved = resolveCredential();

  if (!resolved) {
    server.decorate('firebase', null);
    return;
  }

  const app = getApps()[0] ?? initializeApp({
    credential: resolved.credential,
  });

  server.decorate('firebase', {
    app,
    auth: getAuth(app),
    database: null,
    firestore: getFirestore(app),
    messaging: getMessaging(app),
    storage: getStorage(app),
    projectId: resolved.projectId,
  });
}, { name: 'firebase' });
