import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@/errors';
import { createPlaceholderProvider } from '../placeholder.provider';

describe('placeholder provider', () => {
  it('reports itself as unconfigured so callers can check before trying', () => {
    const provider = createPlaceholderProvider({ channel: 'sms', requiredEnv: ['SMS_API_KEY'] });

    expect(provider.configured).toBe(false);
    expect(provider.channels).toEqual(['sms']);
    expect(provider.name).toBe('placeholder:sms');
  });

  it('names the missing environment variables in the failure', async () => {
    const provider = createPlaceholderProvider({
      channel: 'email',
      requiredEnv: ['RESEND_API_KEY'],
      plannedProvider: 'Resend',
    });

    const send = provider.send({ to: 'a@b.test', text: 'hi', channel: 'email' });

    await expect(send).rejects.toMatchObject({
      code: ERROR_CODES.OTP_CHANNEL_UNAVAILABLE,
      statusCode: 503,
    });
    await expect(send).rejects.toThrow(/Set RESEND_API_KEY/);
    await expect(send).rejects.toThrow(/planned: Resend/);
  });

  it('omits the planned-provider note when none is decided', async () => {
    const provider = createPlaceholderProvider({ channel: 'sms', requiredEnv: ['SMS_API_KEY'] });

    await expect(provider.send({ to: '91830', text: 'x', channel: 'sms' })).rejects.toThrow(
      /^Channel "sms" has no provider configured\./,
    );
  });

  it('never silently succeeds', async () => {
    const provider = createPlaceholderProvider({ channel: 'push', requiredEnv: [] });

    await expect(provider.send({ to: 'token', text: 'x', channel: 'push' })).rejects.toThrow();
  });
});
