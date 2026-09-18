import type { RemoteDetail, RemoteSummary } from './remote.schema';
import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { remoteCaptures } from '@/db/schema';
import { seedRemotes } from '@/db/seeds/seed-remotes';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let auth: Record<string, string>;

function necButton(key: string) {
  return {
    key,
    label: key.toUpperCase(),
    command: { protocol: 'nec' as const, address: 0x12, command: 0x34 },
  };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);
  await seedRemotes(db);

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: data.active.email, password: TEST_PASSWORD },
  });
  auth = { 'authorization': `Bearer ${bodyOf(login).accessToken}`, 'x-tenant-id': data.tenantA.id };
});

afterAll(async () => {
  await app.close();
  await close();
});

async function list(query = ''): Promise<RemoteSummary[]> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/remotes${query}`, headers: auth });
  expect(response.statusCode).toBe(200);
  return bodyOf<RemoteSummary[]>(response);
}

describe('the seeded library', () => {
  it('is visible to a tenant that does not own it', async () => {
    const remotes = await list();

    expect(remotes.length).toBeGreaterThanOrEqual(5);
    expect(remotes.every(remote => !remote.isTenantOwned)).toBe(true);
  });

  it('files every handset under a television or a set-top box', async () => {
    const remotes = await list();

    expect(new Set(remotes.map(r => r.deviceType))).toEqual(new Set(['tv', 'stb']));
    expect((await list('?deviceType=tv')).every(r => r.deviceType === 'tv')).toBe(true);
    expect((await list('?deviceType=stb')).every(r => r.deviceType === 'stb')).toBe(true);
  });

  it('marks only the hand-checked handsets verified', async () => {
    const remotes = await list();

    expect(remotes.filter(r => r.deviceType === 'stb').every(r => !r.verified)).toBe(true);
    expect(remotes.filter(r => r.verified).map(r => r.brand).sort()).toEqual(['LG', 'Samsung', 'Sony']);
  });

  it('leaves code sets out of the list and returns them on selecting one', async () => {
    const [summary] = await list('?deviceType=tv&brand=Sony');
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('buttons');
    expect(summary!.buttonCount).toBeGreaterThan(0);

    const response = await app.inject({ method: 'GET', url: `/api/v1/remotes/${summary!.id}`, headers: auth });
    expect(response.statusCode).toBe(200);
    const detail = bodyOf<RemoteDetail>(response);

    expect(detail.buttons).toHaveLength(summary!.buttonCount);

    const power = detail.buttons.find(button => button.key === 'power');
    expect(power?.command).toEqual({ protocol: 'sony-sirc', bits: 12, data: (1 << 7) | 0x15, repeatCount: 2 });
  });

  it('searches across brand and model', async () => {
    const found = await list('?search=bravia');
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found.map(r => r.brand))).toEqual(new Set(['Sony']));
  });

  it('seeds the ACT remote with 35 captured buttons and stores raw captures', async () => {
    const [act] = await list('?deviceType=stb&brand=ACT');
    expect(act).toBeDefined();
    expect(act?.model).toBe('ACT Remote');
    expect(act?.buttonCount).toBe(35);

    const response = await app.inject({ method: 'GET', url: `/api/v1/remotes/${act!.id}`, headers: auth });
    expect(response.statusCode).toBe(200);
    const detail = bodyOf<RemoteDetail>(response);
    expect(detail.buttons).toHaveLength(35);

    const power = detail.buttons.find(b => b.key === 'power');
    expect(power?.command).toEqual({ protocol: 'nec', address: 0x00, command: 0x1C });

    const captures = await db.select().from(remoteCaptures).where(eq(remoteCaptures.remoteId, act!.id));
    expect(captures).toHaveLength(35);
    const powerCapture = captures.find(c => c.buttonName === 'power');
    expect(powerCapture?.command).toBe('0x1C');
    expect(powerCapture?.commandNumber).toBe(28);
    expect(powerCapture?.bits).toBe(32);
    expect(powerCapture?.rawTimings.length).toBeGreaterThan(0);

    expect(detail.captures).toHaveLength(35);

    const capturesRes = await app.inject({ method: 'GET', url: `/api/v1/remotes/${act!.id}/captures`, headers: auth });
    expect(capturesRes.statusCode).toBe(200);
    const fetchedCaptures = bodyOf<unknown[]>(capturesRes);
    expect(fetchedCaptures).toHaveLength(35);
  });

  it('refuses unauthenticated requests to list, detail, and captures', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/remotes' });
    expect(listRes.statusCode).toBe(401);

    const detailRes = await app.inject({ method: 'GET', url: '/api/v1/remotes/00000000-0000-0000-0000-000000000000' });
    expect(detailRes.statusCode).toBe(401);

    const capturesRes = await app.inject({ method: 'GET', url: '/api/v1/remotes/00000000-0000-0000-0000-000000000000/captures' });
    expect(capturesRes.statusCode).toBe(401);
  });
});

describe('capturing a handset', () => {
  it('stores it against the capturing tenant as learned, not into the shared library', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/remotes',
      headers: auth,
      payload: {
        deviceType: 'stb',
        brand: 'Hathway',
        model: 'HD-2000',
        buttons: [necButton('power'), necButton('channel_up')],
      },
    });

    expect(response.statusCode).toBe(201);
    const created = bodyOf<RemoteDetail>(response);
    expect(created).toMatchObject({ source: 'learned', isTenantOwned: true, verified: false });
    expect(created.buttons).toHaveLength(2);

    expect((await list('?search=Hathway')).map(r => r.id)).toEqual([created.id]);
  });

  it('refuses a second capture of the same model', async () => {
    const payload = {
      deviceType: 'tv' as const,
      brand: 'Onida',
      model: 'LEO32',
      buttons: [necButton('power')],
    };

    expect((await app.inject({ method: 'POST', url: '/api/v1/remotes', headers: auth, payload })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/v1/remotes', headers: auth, payload })).statusCode).toBe(409);
  });
});

describe('codes the emitter could not send', () => {
  async function reject(buttons: unknown[]): Promise<number> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/remotes',
      headers: auth,
      payload: { deviceType: 'tv', brand: 'Bad', model: `M${Math.random()}`, buttons },
    });
    return response.statusCode;
  }

  it('rejects a payload too wide for the declared SIRC frame', async () => {
    expect(await reject([{
      key: 'power',
      label: 'Power',
      command: { protocol: 'sony-sirc', bits: 12, data: 0x5000 },
    }])).toBe(400);
  });

  it('rejects a raw burst of two seconds or longer', async () => {
    expect(await reject([{
      key: 'power',
      label: 'Power',
      command: { protocol: 'raw', carrierFrequencyHz: 38_000, pattern: [1_000_000, 1_000_000] },
    }])).toBe(400);
  });

  it('rejects an address wider than its protocol', async () => {
    expect(await reject([{
      key: 'power',
      label: 'Power',
      command: { protocol: 'nec', address: 0x100, command: 0x01 },
    }])).toBe(400);
  });

  it('rejects two buttons claiming the same key', async () => {
    expect(await reject([necButton('power'), necButton('power')])).toBe(400);
  });
});
