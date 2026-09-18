import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { devices } from '@/db/schema';
import { createTestDb } from '@/test/db';
import { uniqueDeviceId } from '@/test/fixtures';
import { SessionsService } from './sessions.service';

const { db, close } = createTestDb();
const sessions = new SessionsService(db, { refreshTtlDays: 30, maxSessionsPerDevice: 5 });
const created: string[] = [];

afterAll(async () => {
  for (const id of created)
    await db.delete(devices).where(eq(devices.clientDeviceId, id));

  await close();
});

async function register(clientDeviceId: string, extra: Record<string, unknown> = {}) {
  created.push(clientDeviceId);
  return sessions.upsertDevice({
    clientDeviceId,
    platform: 'android',
    osVersion: '34',
    manufacturer: 'Google',
    model: 'Pixel 7',
    appVersion: '1.0.0',
    ramMb: 8192,
    screenResolution: '1080x2400',
    ...extra,
  });
}

describe('device fingerprint', () => {
  it('records every characteristic the client sends', async () => {
    const device = await register(uniqueDeviceId());

    expect(device).toMatchObject({
      platform: 'android',
      osVersion: '34',
      manufacturer: 'Google',
      model: 'Pixel 7',
      appVersion: '1.0.0',
      ramMb: 8192,
      screenResolution: '1080x2400',
    });
  });

  it('keeps what it already knows when a later call carries less', async () => {
    const clientDeviceId = uniqueDeviceId();
    await register(clientDeviceId);

    const again = await sessions.upsertDevice({
      clientDeviceId,
      platform: 'android',
    });

    expect(again).toMatchObject({
      model: 'Pixel 7',
      manufacturer: 'Google',
      ramMb: 8192,
      screenResolution: '1080x2400',
    });
  });

  it('updates a characteristic that genuinely changed', async () => {
    const clientDeviceId = uniqueDeviceId();
    await register(clientDeviceId);

    const upgraded = await register(clientDeviceId, { osVersion: '35', appVersion: '1.1.0' });

    expect(upgraded).toMatchObject({ osVersion: '35', appVersion: '1.1.0', model: 'Pixel 7' });
  });

  it('never invents a fingerprint for a device that sent none', async () => {
    const device = await sessions.upsertDevice({
      clientDeviceId: uniqueDeviceId(),
      platform: 'web',
    });
    created.push(device.clientDeviceId);

    expect(device).toMatchObject({ model: null, manufacturer: null, ramMb: null, screenResolution: null });
  });
});
