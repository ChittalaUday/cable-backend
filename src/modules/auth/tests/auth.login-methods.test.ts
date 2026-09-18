import type { BuiltApp } from '@/app';
import type { SeededAuthData } from '@/test/fixtures';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { users } from '@/db/schema';
import { systemAuditContext } from '@/modules/audit/audit.types';
import { createTokenSigner } from '@/security/tokens';
import { MessagingService } from '@/services/messaging/messaging.service';
import { createLogProvider } from '@/services/messaging/providers/log.provider';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniquePhone } from '@/test/fixtures';
import { bodyOf } from '@/test/http';
import { AuthService } from '../services/auth.service';
import { SessionsService } from '../services/sessions.service';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;

const device = { clientDeviceId: uniqueDeviceId(), platform: 'ios' as const };
const context = systemAuditContext('login-methods-test');

/**
 * `env` is read when `@/config/env` is first imported, which is before any hook
 * in this file can run — so EMAIL_OTP_ENABLED cannot be flipped for the built
 * app without flipping it for the whole suite. The flag lives in the service's
 * config, so the flow is exercised on a service built with it set.
 */
const messages = createLogProvider(() => {});

function serviceWith(emailOtpEnabled: boolean, providers = [messages]) {
  return new AuthService(
    db,
    new SessionsService(db, { refreshTtlDays: 30, maxSessionsPerDevice: 5, refreshGraceSeconds: 60 }),
    {
      messaging: new MessagingService({
        providers,
        defaultChannel: 'whatsapp',
        defaultCountryCode: '91',
      }),
      tokens: createTokenSigner({ secret: 'a'.repeat(48), accessTtlSeconds: 900 }),
      config: {
        otpLength: 6,
        otpTtlSeconds: 300,
        otpMaxAttempts: 5,
        otpResendCooldownSeconds: 60,
        defaultCountryCode: '91',
        emailOtpEnabled,
        challengeTtlSeconds: 300,
        googleClientIds: [],
      },
    },
  );
}

/** The code as it was actually delivered, read off the log provider. */
function lastCodeSentTo(identifier: string): string {
  const message = [...messages.sent].reverse().find(sent => sent.to === identifier);
  expect(message, `nothing was sent to ${identifier}`).toBeDefined();

  const code = /\b(\d{6})\b/.exec(message!.text)?.[1];
  expect(code, `no code in ${message!.text}`).toBeDefined();
  return code!;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);
});

afterAll(async () => {
  await data.cleanup();
  await app.close();
  await close();
});

describe('the login config a client reads before drawing its screen', () => {
  it('names the methods on offer and the channels answering right now', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/config' });

    expect(response.statusCode).toBe(200);

    const config = bodyOf<{
      password: boolean;
      passwordNeedsEmailOtp: boolean;
      phoneOtp: boolean;
      phoneOtpChannels: string[];
      defaultPhoneOtpChannel: string | null;
      google: boolean;
    }>(response);

    expect(config.password).toBe(true);
    expect(config.phoneOtp).toBe(true);

    // MESSAGING_DEFAULT_CHANNEL leads, and SMS is listed as somewhere to fall
    // back to — which is what lets the app offer a choice at all.
    expect(config.defaultPhoneOtpChannel).toBe('whatsapp');
    expect(config.phoneOtpChannels[0]).toBe('whatsapp');
    expect(config.phoneOtpChannels).toContain('sms');

    // Neither is configured in test, so the app must not offer either.
    expect(config.google).toBe(false);
    expect(config.passwordNeedsEmailOtp).toBe(false);
  });

  it('reports a channel out of rotation, so the app stops offering it', () => {
    const service = serviceWith(false);

    expect(service.loginConfig().phoneOtpChannels).toContain('whatsapp');

    // With nothing answering, there is no channel for a client to pick.
    const offline = serviceWith(true, []);

    expect(offline.loginConfig().phoneOtp).toBe(false);
    expect(offline.loginConfig().phoneOtpChannels).toEqual([]);
    expect(offline.loginConfig().defaultPhoneOtpChannel).toBeNull();

    // The flag alone is not enough: there has to be a sender configured.
    expect(offline.loginConfig().passwordNeedsEmailOtp).toBe(false);
  });
});

describe('email otp as the second half of a password sign-in', () => {
  it('answers a correct password with a challenge instead of tokens', async () => {
    const result = await serviceWith(true).login(
      { identifier: data.active.email, password: TEST_PASSWORD, device },
      context,
    );

    expect(result).toMatchObject({ status: 'otp_required', channel: 'email' });
    expect(result).not.toHaveProperty('accessToken');
    expect(lastCodeSentTo(data.active.email)).toMatch(/^\d{6}$/);
  });

  it('hands back tokens when the flag is off, unchanged', async () => {
    const result = await serviceWith(false).login(
      { identifier: data.active.email, password: TEST_PASSWORD, device },
      context,
    );

    expect(result).toHaveProperty('accessToken');
  });

  it('exchanges the challenge and the emailed code for a session', async () => {
    const service = serviceWith(true);

    const challenge = await service.login(
      { identifier: data.active.email, password: TEST_PASSWORD, device },
      context,
    ) as { challengeToken: string };

    const session = await service.verifyOtp(
      { challengeToken: challenge.challengeToken, code: lastCodeSentTo(data.active.email), device },
      context,
    );

    expect(session.user.email).toBe(data.active.email);
    expect(session.accessToken.length).toBeGreaterThan(20);
  });

  it('refuses the code without the challenge it was issued against', async () => {
    const service = serviceWith(true);

    await service.login({ identifier: data.active.email, password: TEST_PASSWORD, device }, context);
    const code = lastCodeSentTo(data.active.email);

    // Knowing the address and the code is not a way past the password: there is
    // no phone to present it against, and the email side needs the challenge.
    await expect(service.verifyOtp({ phone: uniquePhone(), code, device }, context)).rejects.toThrow();
  });

  it('refuses a challenge token that was not signed as one', async () => {
    const service = serviceWith(true);

    const session = await serviceWith(false).login(
      { identifier: data.active.email, password: TEST_PASSWORD, device },
      context,
    ) as { accessToken: string };

    // An access token is not proof of a password check for *this* sign-in.
    await expect(service.verifyOtp({ challengeToken: session.accessToken, code: '000000', device }, context))
      .rejects
      .toThrow(/expired|not valid/i);
  });

  it('reports the running cooldown rather than refusing a second sign-in', async () => {
    const service = serviceWith(true);

    const first = await service.login({ identifier: data.active.email, password: TEST_PASSWORD, device }, context);
    expect(first).toMatchObject({ status: 'otp_required' });

    /*
     * The resend ladder would refuse another code this soon. Refusing the
     * *login* for that would shut the account out of its own second factor, so
     * the code already sent stands and the wait is reported.
     */
    const second = await service.login({ identifier: data.active.email, password: TEST_PASSWORD, device }, context);

    expect(second).toMatchObject({ status: 'otp_required' });
    expect((second as { nextCooldownSeconds: number }).nextCooldownSeconds).toBeGreaterThan(0);
  });

  it('signs a phone-only account in on the password alone', async () => {
    // There is nowhere to email a code, so demanding one would lock them out.
    const phone = uniquePhone();
    await db.update(users).set({ phone, email: null }).where(eq(users.id, data.other.id));

    const result = await serviceWith(true).login({ identifier: phone, password: TEST_PASSWORD, device }, context);

    expect(result).toHaveProperty('accessToken');
  });
});

describe('google sign-in', () => {
  it('is refused outright when no client ids are configured', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
      payload: { idToken: 'x'.repeat(40) },
    });

    expect(response.statusCode).toBe(403);
    expect(bodyOf(response).code).toBe('AUTH_GOOGLE_TOKEN_INVALID');
  });

  it('refuses a token that is not a Google token', async () => {
    await expect(
      serviceWith(true).googleSignIn('not.a.jwt', device, context),
    ).rejects.toThrow(/not enabled|not valid/i);
  });
});
