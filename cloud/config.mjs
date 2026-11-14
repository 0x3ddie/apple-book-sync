const required = ['BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'DATABASE_URL', 'RESEND_API_KEY', 'EMAIL_FROM'];

export function configuration(env = process.env) {
  const missing = required.filter((key) => !env[key]?.trim());
  let origin;
  try {
    const url = new URL(env.BETTER_AUTH_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Expected the public HTTPS origin');
    }
    origin = url.origin;
  } catch {
    if (!missing.includes('BETTER_AUTH_URL')) missing.push('BETTER_AUTH_URL');
  }
  if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length < 32) missing.push('BETTER_AUTH_SECRET');
  return {
    ready: missing.length === 0, missing: [...new Set(missing)], origin,
    secret: env.BETTER_AUTH_SECRET, databaseURL: env.DATABASE_URL,
    emailKey: env.RESEND_API_KEY, emailFrom: env.EMAIL_FROM,
  };
}
