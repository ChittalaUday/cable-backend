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
