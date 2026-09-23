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
  secretsKey: process.env.SECRETS_KEY ?? (process.env.NODE_ENV === 'production' ? '' : 'dev-only-insecure-secrets-key'),
};
if (!config.secretsKey) throw new Error('SECRETS_KEY is required in production');
