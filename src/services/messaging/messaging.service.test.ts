import type { MessagingProvider } from './messaging.types';
import { describe, expect, it } from 'vitest';
import { MessagingService, normalisePhone } from './messaging.service';
import { createLogProvider } from './providers/log.provider';
import { createPlaceholderProvider } from './providers/placeholder.provider';

function serviceWith(providers: MessagingProvider[]) {
  return new MessagingService({ providers, defaultChannel: 'whatsapp', defaultCountryCode: '91' });
}

describe('normalisePhone', () => {
  it.each([
    ['+91 83091 54716', '918309154716'],
    ['918309154716', '918309154716'],
    ['8309154716', '918309154716'],
    ['08309154716', '918309154716'],
    ['+1 (555) 010-9999', '15550109999'],
  ])('normalises %j to %j', (raw, expected) => {
    expect(normalisePhone(raw, '91')).toBe(expected);
  });

  it('trusts an explicit + prefix over the default country code', () => {
    expect(normalisePhone('+15550109999', '91')).toBe('15550109999');
  });
});

describe('messagingService', () => {
  it('sends through the provider that claims the channel', async () => {
    const log = createLogProvider(() => {});
    const service = serviceWith([log]);

    await service.send({ to: '8309154716', text: 'code 123456' });

    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]).toMatchObject({ channel: 'whatsapp', to: '918309154716', text: 'code 123456' });
  });

  it('normalises the destination before handing it to a provider', async () => {
    const log = createLogProvider(() => {});
    const service = serviceWith([log]);

    await service.send({ to: '+91 83091 54716', text: 'hi' });

    expect(log.sent[0]?.to).toBe('918309154716');
  });

  it('routes to the first provider registered for a channel', async () => {
    const first = createLogProvider(() => {});
    const second = createLogProvider(() => {});
    const service = new MessagingService({
      providers: [{ ...first, channels: ['whatsapp'] }, second],
      defaultChannel: 'whatsapp',
      defaultCountryCode: '91',
    });

    await service.send({ to: '8309154716', text: 'x', channel: 'whatsapp' });

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
  });

  it('fails loudly when no provider serves the channel', async () => {
    const whatsappOnly = { ...createLogProvider(() => {}), channels: ['whatsapp'] as const };
    const service = new MessagingService({
      providers: [whatsappOnly],
      defaultChannel: 'whatsapp',
      defaultCountryCode: '91',
    });

    await expect(service.send({ to: '8309154716', text: 'x', channel: 'sms' }))
      .rejects
      .toThrow(/No provider configured for channel "sms"/);
  });

  it('reports channel support without sending', () => {
    const service = new MessagingService({
      providers: [{ ...createLogProvider(() => {}), channels: ['whatsapp'] }],
      defaultChannel: 'whatsapp',
      defaultCountryCode: '91',
    });

    expect(service.supports('whatsapp')).toBe(true);
    expect(service.supports('sms')).toBe(false);
  });
});

describe('channel routing', () => {
  it('does not treat a placeholder as support for a channel', () => {
    const service = new MessagingService({
      providers: [createPlaceholderProvider({ channel: 'email', requiredEnv: ['RESEND_API_KEY'] })],
      defaultChannel: 'whatsapp',
      defaultCountryCode: '91',
    });

    expect(service.knownChannels).toContain('email');
    expect(service.supports('email')).toBe(false);
  });

  it('prefers a configured provider over a placeholder, whatever the order', async () => {
    const real = createLogProvider(() => {});
    const service = new MessagingService({
      providers: [
        createPlaceholderProvider({ channel: 'whatsapp', requiredEnv: ['X'] }),
        { ...real, channels: ['whatsapp'] },
      ],
      defaultChannel: 'whatsapp',
      defaultCountryCode: '91',
    });

    expect(service.supports('whatsapp')).toBe(true);
    await service.send({ to: '8309154716', text: 'x' });
    expect(real.sent).toHaveLength(1);
  });

  it('leaves an email address and a push token untouched', async () => {
    const log = createLogProvider(() => {});
    const service = serviceWith([log]);

    await service.send({ to: 'uday@example.com', text: 'x', channel: 'email' });
    await service.send({ to: 'fcm-device-token-abc', text: 'x', channel: 'push' });

    expect(log.sent[0]?.to).toBe('uday@example.com');
    expect(log.sent[1]?.to).toBe('fcm-device-token-abc');
  });

  it('reports which provider serves a channel', () => {
    const service = serviceWith([createLogProvider(() => {})]);

    expect(service.providerFor('whatsapp')).toBe('log');
    expect(service.providerFor('sms')).toBe('log');
  });
});

/** Fails its first `failFirst` sends, then works. */
function flaky(name: string, channels: MessagingProvider['channels'], failFirst: number) {
  let attempts = 0;

  const provider: MessagingProvider = {
    name,
    channels,
    configured: true,
    async send() {
      attempts += 1;
      if (attempts <= failFirst)
        throw new Error(`${name} is down`);

      return { providerMessageId: `${name}-${attempts}` };
    },
  };

  return { provider, attempts: () => attempts };
}

function breakered(providers: MessagingProvider[]) {
  return new MessagingService({
    providers,
    defaultChannel: 'whatsapp',
    defaultCountryCode: '91',
    breakerFailures: 2,
    breakerCooldownMs: 50,
  });
}

describe('falling back between the phone channels', () => {
  it('carries the message on the sibling channel when the chosen one fails', async () => {
    const result = await breakered([
      flaky('openwa', ['whatsapp'], 1).provider,
      flaky('twilio', ['sms'], 0).provider,
    ]).send({ to: '8309154716', text: 'x' });

    // The caller asked for WhatsApp and got SMS, and is told which — the user
    // has to know where to go looking for the code.
    expect(result.channel).toBe('sms');
  });

  it('raises for a channel with no provider rather than quietly using another', async () => {
    const service = breakered([flaky('openwa', ['whatsapp'], 0).provider]);

    await expect(service.send({ to: '8309154716', text: 'x', channel: 'sms' }))
      .rejects
      .toThrow(/No provider configured for channel "sms"/);
  });

  it('reports the failure when neither channel can send', async () => {
    const service = breakered([
      flaky('openwa', ['whatsapp'], 99).provider,
      flaky('twilio', ['sms'], 99).provider,
    ]);

    await expect(service.send({ to: '8309154716', text: 'x' })).rejects.toThrow(/is down/);
  });
});

describe('the breaker takes a dead channel out of rotation', () => {
  it('stops offering a channel that failed its limit', async () => {
    const wa = flaky('openwa', ['whatsapp'], 99);
    const service = breakered([wa.provider, flaky('twilio', ['sms'], 0).provider]);

    expect(service.available('whatsapp')).toBe(true);

    await service.send({ to: '8309154716', text: 'x' });
    await service.send({ to: '8309154716', text: 'x' });

    // This is what the login config endpoint reads, so the app stops offering it.
    expect(service.available('whatsapp')).toBe(false);
    expect(service.liveChannels).toEqual(['sms']);

    const attemptsBefore = wa.attempts();
    await service.send({ to: '8309154716', text: 'x' });
    expect(wa.attempts()).toBe(attemptsBefore);
  });

  it('lets the channel back in after the cooldown, and clears it on one success', async () => {
    const service = breakered([
      flaky('openwa', ['whatsapp'], 2).provider,
      flaky('twilio', ['sms'], 0).provider,
    ]);

    await service.send({ to: '8309154716', text: 'x' });
    await service.send({ to: '8309154716', text: 'x' });
    expect(service.available('whatsapp')).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 60));

    const result = await service.send({ to: '8309154716', text: 'x' });
    expect(result.channel).toBe('whatsapp');
    expect(service.available('whatsapp')).toBe(true);
  });

  it('still attempts a tripped channel that has no sibling', async () => {
    const service = breakered([flaky('resend', ['email'], 99).provider]);
    const send = async () => service.send({ to: 'a@b.test', text: 'x', channel: 'email' });

    await expect(send()).rejects.toThrow();
    await expect(send()).rejects.toThrow();
    expect(service.available('email')).toBe(false);

    // Refusing outright would only mean sending nothing at all.
    await expect(send()).rejects.toThrow(/resend is down/);
  });
});
