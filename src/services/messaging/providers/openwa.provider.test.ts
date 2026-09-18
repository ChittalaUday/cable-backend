import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@/errors';
import { createOpenWaProvider } from './openwa.provider';

const config = {
  baseUrl: 'http://openwa.test',
  apiKey: 'owa_k1_test',
  sessionId: 'session-1',
  timeoutMs: 1000,
};

function stubFetch(response: Response | Error) {
  const spy = vi.fn(async () => {
    if (response instanceof Error)
      throw response;
    return response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openWA provider', () => {
  it('posts to the session send-text endpoint with the API key header', async () => {
    const fetchSpy = stubFetch(Response.json({ id: 'msg-1' }, { status: 201 }));
    const provider = createOpenWaProvider(config);

    const result = await provider.send({ to: '918309154716', text: 'code 123456', channel: 'whatsapp' });

    expect(result).toEqual({ providerMessageId: 'msg-1' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://openwa.test/api/sessions/session-1/messages/send-text');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('owa_k1_test');
    expect(JSON.parse(init.body as string)).toEqual({
      chatId: '918309154716@c.us',
      text: 'code 123456',
    });
  });

  it('falls back to messageId when the payload uses that key', async () => {
    stubFetch(Response.json({ messageId: 'msg-2' }, { status: 201 }));

    const result = await createOpenWaProvider(config).send({ to: '91830', text: 'x', channel: 'whatsapp' });

    expect(result.providerMessageId).toBe('msg-2');
  });

  it('reports null rather than failing when no id comes back', async () => {
    stubFetch(Response.json({}, { status: 201 }));

    const result = await createOpenWaProvider(config).send({ to: '91830', text: 'x', channel: 'whatsapp' });

    expect(result.providerMessageId).toBeNull();
  });

  it('fails loudly when the WhatsApp session is disconnected', async () => {
    stubFetch(Response.json(
      { message: 'Session \'session-1\' is not active. Start the session first.', error: 'Bad Request', statusCode: 400 },
      { status: 400 },
    ));

    const send = createOpenWaProvider(config).send({ to: '91830', text: 'x', channel: 'whatsapp' });

    await expect(send).rejects.toMatchObject({ code: ERROR_CODES.OTP_DELIVERY_FAILED, statusCode: 502 });
    await expect(send).rejects.toThrow(/is not active/);
  });

  it('fails loudly when the server is unreachable', async () => {
    stubFetch(new TypeError('fetch failed'));

    const send = createOpenWaProvider(config).send({ to: '91830', text: 'x', channel: 'whatsapp' });

    await expect(send).rejects.toMatchObject({ code: ERROR_CODES.OTP_DELIVERY_FAILED, statusCode: 502 });
    await expect(send).rejects.toThrow(/unreachable/);
  });

  it('never reports success on a non-2xx, whatever the body says', async () => {
    stubFetch(new Response('{"id":"msg-3"}', { status: 500 }));

    await expect(createOpenWaProvider(config).send({ to: '91830', text: 'x', channel: 'whatsapp' }))
      .rejects
      .toThrow(/OpenWA rejected/);
  });
});

function INACTIVE() {
  return Response.json(
    { message: `Session 'session-1' is not active. Start the session first.`, error: 'Bad Request', statusCode: 400 },
    { status: 400 },
  );
}

function scriptFetch(replies: ((url: string) => Response)[]) {
  let call = 0;
  const spy = vi.fn(async (url: string) => {
    const reply = replies[Math.min(call, replies.length - 1)]!;
    call += 1;
    return reply(url);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('openWA session recovery', () => {
  it('restarts a dormant session and sends the message it was holding', async () => {
    const fetchSpy = scriptFetch([
      INACTIVE,
      () => Response.json({ ok: true }),
      () => Response.json({ status: 'ready' }),
      () => Response.json({ id: 'msg-after-restart' }, { status: 201 }),
    ]);

    const provider = createOpenWaProvider(config);
    const result = await provider.send({ to: '918309154716', text: 'code', channel: 'whatsapp' });

    expect(result).toEqual({ providerMessageId: 'msg-after-restart' });

    const paths = fetchSpy.mock.calls.map(([url]) => String(url).replace('http://openwa.test/api/sessions/session-1', ''));
    expect(paths).toEqual(['/messages/send-text', '/start', '', '/messages/send-text']);
  });

  it('gives up at once when the session wants a QR scan, and says who to tell', async () => {
    const alerts: { status: string; reason: string }[] = [];
    scriptFetch([
      INACTIVE,
      () => Response.json({ ok: true }),
      () => Response.json({ status: 'qr_ready' }),
    ]);

    const provider = createOpenWaProvider({ ...config, onSessionUnrecoverable: d => alerts.push(d) });

    await expect(provider.send({ to: '918309154716', text: 'code', channel: 'whatsapp' }))
      .rejects
      .toMatchObject({ code: ERROR_CODES.OTP_DELIVERY_FAILED });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.status).toBe('qr_ready');
  });

  it('alerts when a restarted session never comes back', async () => {
    const alerts: { status: string; reason: string }[] = [];
    scriptFetch([
      INACTIVE,
      () => Response.json({ ok: true }),
      () => Response.json({ status: 'initializing' }),
    ]);

    const provider = createOpenWaProvider({
      ...config,
      recoveryTimeoutMs: 50,
      onSessionUnrecoverable: d => alerts.push(d),
    });

    await expect(provider.send({ to: '918309154716', text: 'code', channel: 'whatsapp' }))
      .rejects
      .toMatchObject({ code: ERROR_CODES.OTP_DELIVERY_FAILED });

    expect(alerts).toHaveLength(1);
  });

  it('leaves an unrelated rejection alone', async () => {
    const alerts: unknown[] = [];
    const fetchSpy = scriptFetch([() => Response.json({ message: 'bad number' }, { status: 400 })]);

    const provider = createOpenWaProvider({ ...config, onSessionUnrecoverable: d => alerts.push(d) });

    await expect(provider.send({ to: 'nonsense', text: 'code', channel: 'whatsapp' }))
      .rejects
      .toMatchObject({ code: ERROR_CODES.OTP_DELIVERY_FAILED });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual([]);
  });
});
