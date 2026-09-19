import type { App } from 'firebase-admin/app';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { env } from '@/config/env';

/**
 * The one Firebase app, or null when no service account is configured.
 *
 * Both messaging (FCM) and sign-in read from it, and `initializeApp` throws on
 * a second call with the default name — so the lookup lives here rather than
 * being repeated at each call site.
 */
export function firebaseApp(): App | null {
  if (env.FIREBASE_SERVICE_ACCOUNT_PATH === '')
    return null;

  return getApps()[0] ?? initializeApp({ credential: cert(env.FIREBASE_SERVICE_ACCOUNT_PATH) });
}
