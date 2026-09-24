function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL', 'postgres://tasks:tasks@localhost:5434/tasks'),
  publicUrl: env('PUBLIC_URL', 'http://localhost:5180').replace(/\/$/, ''),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  // Local-only shortcut: sign in as any email without Google. Never set in production.
  devLogin: process.env.DEV_LOGIN === '1',
  production: process.env.NODE_ENV === 'production',
  // Overridable so tests can point routine runs at a fake server.
  routineApiBase: (process.env.ROUTINE_API_BASE ?? 'https://api.anthropic.com').replace(/\/$/, ''),
  // Agents are pinged only after an item has been quiet this long, so a human can finish editing first.
  agentQuietSeconds: Number(process.env.AGENT_QUIET_SECONDS ?? 120),
  // GitHub App (one per deployment). The key may be given as PEM or base64 of the PEM.
  github: {
    appId: process.env.GITHUB_APP_ID ?? '',
    appSlug: process.env.GITHUB_APP_SLUG ?? '',
    clientId: process.env.GITHUB_CLIENT_ID ?? '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
    privateKey: process.env.GITHUB_PRIVATE_KEY ?? (process.env.GITHUB_PRIVATE_KEY_B64 ? Buffer.from(process.env.GITHUB_PRIVATE_KEY_B64, 'base64').toString('utf8') : ''),
    // Overridable so tests can use a fake GitHub.
    apiBase: (process.env.GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/$/, ''),
    webBase: (process.env.GITHUB_WEB_BASE ?? 'https://github.com').replace(/\/$/, ''),
  },
  secretsKey: process.env.SECRETS_KEY ?? (process.env.NODE_ENV === 'production' ? '' : 'dev-only-insecure-secrets-key'),
};
if (!config.secretsKey) throw new Error('SECRETS_KEY is required in production');
