import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../next.config';
import { authSecretCipher } from '../src/modules/platform-security/auth/secret-cipher';
import { pendingTotpQr } from '../src/modules/platform-security/service/totp-enrolment';
import { totpQrDataUrl } from '../src/modules/platform-security/domain/totp-qr';
import { totpQrForEnrolment } from '../src/modules/platform-security/ui/totp-qr-action';
import { authTestKit } from './auth-helpers';

// HIGH finding: `next dev` logged the otpauth URI (with the TOTP secret) because it was a server-action argument.
const kit = authTestKit();
afterAll(() => kit.close());
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-23T08:00:10Z') }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const decrypt = authSecretCipher(kit.env).decrypt;
const secretOfUri = (uri: string) => new URL(uri).searchParams.get('secret')!;

/** Everything the process writes while `run` executes: console.*, stdout/stderr and the auth logger. */
async function captureLogs(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const sink = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation(
      (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
    );
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(sink as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(sink as never);
  const before = kit.logLines.length;
  await run();
  return [...lines, ...kit.logLines.slice(before)].join('\n');
}

describe('TOTP enrolment QR', () => {
  it('first enrolment: the QR is built from the staged secret, which appears in no log', async () => {
    const user = await kit.newUser();
    const cookie = kit.cookieOf(
      await kit.call('/sign-in/email', { email: user.email, password: kit.password }),
    );
    let uri = '';
    let qr: string | null = null;
    const logs = await captureLogs(async () => {
      const enable = await kit.call('/two-factor/enable', { password: kit.password }, { cookie });
      uri = ((await enable.json()) as { totpURI: string }).totpURI;
      qr = await pendingTotpQr(kit.authPool, decrypt, {
        id: user.id,
        email: user.email,
        reenrolRequired: false,
      });
    });
    expect(qr).toBe(totpQrDataUrl(uri, user.email));
    expect(qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(logs).not.toContain(secretOfUri(uri));
    expect(logs).not.toContain('otpauth://');
  });

  it('re-enrolment: the QR comes from the staged secret, not the current one', async () => {
    const user = await kit.enrolledUser();
    vi.setSystemTime(Date.now() + 30_000);
    const pending = kit.cookieOf(
      await kit.call('/sign-in/email', { email: user.email, password: kit.password }),
    );
    const login = await kit.call(
      '/two-factor/verify-backup-code',
      { code: user.backupCodes[0] },
      { cookie: pending },
    );
    const cookie = kit.cookieOf(login);
    const enable = await kit.call('/two-factor/enable', { password: kit.password }, { cookie });
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const qr = await pendingTotpQr(kit.authPool, decrypt, {
      id: user.id,
      email: user.email,
      reenrolRequired: true,
    });
    expect(qr).toBe(totpQrDataUrl(totpURI, user.email));
  });

  it('returns nothing when no enrolment is staged', async () => {
    const user = await kit.enrolledUser();
    await expect(
      pendingTotpQr(kit.authPool, decrypt, { id: user.id, email: user.email, reenrolRequired: false }),
    ).resolves.toBeNull();
  });

  it('the server action takes no argument, and Next does not log server-function calls', () => {
    expect(totpQrForEnrolment.length).toBe(0);
    expect(nextConfig.logging).toMatchObject({ serverFunctions: false });
  });
});
