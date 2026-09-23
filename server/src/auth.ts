import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { sql } from './db.js';
import { config } from './config.js';
import { HttpError } from './errors.js';

/** keyId is set when the request used an API key (run keys identify a routine run). */
export type Actor = { id: string; kind: 'human' | 'agent'; name: string; email: string | null; orgId: string | null; keyId?: string };

const SESSION_COOKIE = 'tasks_session';
const SESSION_DAYS = 30;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

export async function mintApiKey(accountId: string, name: string, expiresAt: Date | null = null) {
  const key = `tsk_${token(30)}`;
  const [row] = await sql`
    insert into api_keys (account_id, name, prefix, hash, expires_at)
    values (${accountId}, ${name}, ${key.slice(0, 10)}, ${sha256(key)}, ${expiresAt})
    returning id, name, prefix, created_at, expires_at`;
  return { ...(row as { id: string; name: string; prefix: string; createdAt: Date; expiresAt: Date | null }), key };
}

async function actorFromApiKey(key: string): Promise<Actor | null> {
  const [row] = await sql`
    update api_keys k set last_used_at = now()
    from accounts a
    where k.hash = ${sha256(key)} and k.revoked_at is null and (k.expires_at is null or k.expires_at > now())
      and a.id = k.account_id
    returning a.id, a.kind, a.name, a.email, a.org_id, k.id as key_id`;
  return (row as Actor) ?? null;
}

async function actorFromSession(tok: string): Promise<Actor | null> {
  const [row] = await sql`
    select a.id, a.kind, a.name, a.email, a.org_id
    from sessions s join accounts a on a.id = s.account_id
    where s.token_hash = ${sha256(tok)} and s.expires_at > now()`;
  return (row as Actor) ?? null;
}

export async function authenticate(req: FastifyRequest): Promise<Actor | null> {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return actorFromApiKey(header.slice(7).trim());
  const cookie = req.cookies[SESSION_COOKIE];
  if (cookie) return actorFromSession(cookie);
  return null;
}

export async function requireActor(req: FastifyRequest): Promise<Actor> {
  const actor = await authenticate(req);
  if (!actor) throw new HttpError(401, 'Not signed in');
  return actor;
}

async function startSession(reply: FastifyReply, accountId: string) {
  const tok = token();
  await sql`
    insert into sessions (token_hash, account_id, expires_at)
    values (${sha256(tok)}, ${accountId}, now() + ${SESSION_DAYS + ' days'}::interval)`;
  reply.setCookie(SESSION_COOKIE, tok, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.production,
    maxAge: SESSION_DAYS * 86400,
  });
}

// Upsert a human by Google identity and accept any pending invites for their email.
async function upsertHuman(p: { sub: string | null; email: string; name: string; picture?: string }) {
  return sql.begin(async (tx) => {
    const [account] = await tx`
      insert into accounts (kind, name, email, google_sub, avatar_url)
      values ('human', ${p.name}, ${p.email}, ${p.sub}, ${p.picture ?? null})
      on conflict (email) do update set
        google_sub = coalesce(accounts.google_sub, excluded.google_sub),
        avatar_url = coalesce(excluded.avatar_url, accounts.avatar_url)
      returning id`;
    await tx`
      insert into memberships (org_id, account_id, role)
      select org_id, ${account.id}, role from invites where email = ${p.email}
      on conflict do nothing`;
    await tx`delete from invites where email = ${p.email}`;
    return account.id as string;
  });
}

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function authRoutes(app: FastifyInstance) {
  const redirectUri = `${config.publicUrl}/auth/google/callback`;

  app.get('/auth/config', async () => ({ google: !!config.googleClientId, dev: config.devLogin }));

  app.get('/auth/google', async (_req, reply) => {
    if (!config.googleClientId) throw new HttpError(500, 'Google sign-in is not configured');
    const state = token(16);
    reply.setCookie('oauth_state', state, { path: '/auth', httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: 600 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string } }>('/auth/google/callback', async (req, reply) => {
    const { code, state } = req.query;
    if (!code || !state || state !== req.cookies.oauth_state) throw new HttpError(400, 'Invalid OAuth state');
    reply.clearCookie('oauth_state', { path: '/auth' });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) throw new HttpError(502, 'Google token exchange failed');
    const { id_token } = (await res.json()) as { id_token: string };
    const { payload } = await jwtVerify(id_token, googleJwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: config.googleClientId,
    });
    if (!payload.email || payload.email_verified !== true) throw new HttpError(403, 'Google email not verified');
    const id = await upsertHuman({
      sub: payload.sub!,
      email: String(payload.email).toLowerCase(),
      name: String(payload.name ?? payload.email),
      picture: payload.picture as string | undefined,
    });
    await startSession(reply, id);
    return reply.redirect('/');
  });

  if (config.devLogin) {
    app.post<{ Body: { email: string; name?: string } }>('/auth/dev', async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const id = await upsertHuman({ sub: null, email, name: req.body.name || email.split('@')[0] });
      await startSession(reply, id);
      return { ok: true };
    });
  }

  app.post('/auth/logout', async (req, reply) => {
    const tok = req.cookies[SESSION_COOKIE];
    if (tok) await sql`delete from sessions where token_hash = ${sha256(tok)}`;
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
