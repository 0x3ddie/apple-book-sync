import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins/magic-link';

export function createAuth(config, pool, { sendEmail } = {}) {
  const deliver = sendEmail ?? (async ({ email, url }) => {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.emailKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.emailFrom, to: [email], subject: 'Your Books sign-in link',
        text: `Sign in to your private Books library:\n\n${url}\n\nThis link expires in 10 minutes and can be used once. If you did not request it, ignore this email.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Sign-in email could not be sent.');
  });

  return betterAuth({
    appName: 'Books', baseURL: config.origin, basePath: '/api/auth',
    secret: config.secret, database: pool, trustedOrigins: [config.origin],
    emailAndPassword: { enabled: false },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: {
      useSecureCookies: true,
      // The Node adapter replaces this header using Vercel's trusted address header.
      ipAddress: { ipAddressHeaders: ['x-books-client-ip'] },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    plugins: [magicLink({
      expiresIn: 600, storeToken: 'hashed', rateLimit: { window: 60, max: 3 },
      sendMagicLink: deliver,
    })],
  });
}
