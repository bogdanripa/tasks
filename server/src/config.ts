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
};
