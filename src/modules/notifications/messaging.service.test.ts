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
    // A US number must not be mangled into an Indian one.
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

    // An OTP that was never sent must never look like a success (§1 rule 3).
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

    // The channel is routed, but it cannot deliver — those are different answers.
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

    // A stale placeholder registration must never disable a working gateway.
    expect(service.supports('whatsapp')).toBe(true);
    await service.send({ to: '8309154716', text: 'x' });
    expect(real.sent).toHaveLength(1);
  });

  it('leaves an email address and a push token untouched', async () => {
    const log = createLogProvider(() => {});
    const service = serviceWith([log]);

    await service.send({ to: 'uday@example.com', text: 'x', channel: 'email' });
    await service.send({ to: 'fcm-device-token-abc', text: 'x', channel: 'push' });

    // Phone normalisation would destroy both.
    expect(log.sent[0]?.to).toBe('uday@example.com');
    expect(log.sent[1]?.to).toBe('fcm-device-token-abc');
  });

  it('reports which provider serves a channel', () => {
    const service = serviceWith([createLogProvider(() => {})]);

    expect(service.providerFor('whatsapp')).toBe('log');
    expect(service.providerFor('sms')).toBe('log');
  });
});
