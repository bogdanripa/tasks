import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import { migrate, sql } from './db.js';
import { HttpError } from './errors.js';
import { authRoutes } from './auth.js';
import { apiRoutes } from './routes.js';
import { mcpRoutes } from './mcp.js';
import { startDeliveryWorker } from './delivery.js';
import { collectRoutes } from './apidoc.js';
import { startScheduler } from './schedules.js';
import { recoverInterruptedRuns } from './runtime.js';

const app = Fastify({ logger: { level: config.production ? 'info' : 'warn' }, trustProxy: true });
await app.register(cookie);
// Keep the raw JSON text too: GitHub webhook signatures are computed over it.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as { rawBody?: string }).rawBody = body as string;
  try {
    done(null, body ? JSON.parse(body as string) : {});
  } catch {
    done(new HttpError(400, 'Invalid JSON body'), undefined);
  }
});
collectRoutes(app); // before any route, so /api/help sees them all

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
  req.log.error(err);
  return reply.code(500).send({ error: 'Internal error' });
});

app.get('/healthz', { logLevel: 'warn' }, async () => {
  await sql`select 1`;
  return { ok: true };
});

authRoutes(app);
apiRoutes(app);
mcpRoutes(app);

// Built web output: the public site at the root (/, /docs/) and the app under /app. In production the
// CDN serves these same files first; this is the fallback and what local builds use.
const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fstatic, { root: webDist, redirect: true });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    if (req.method !== 'GET' || /^\/(api|auth|mcp)(\/|$)/.test(path)) return reply.code(404).send({ error: 'Not found' });
    if (/\.[a-z0-9]+$/i.test(path)) return reply.code(404).send('Not found'); // a missing file, not a page
    if (path === '/app' || path.startsWith('/app/')) return reply.sendFile('app/index.html'); // client-side routes
    // Links from before the app moved under /app (e.g. /demo/WEB, /i/demo/WEB-12) keep working.
    return reply.redirect(`/app${req.url}`, 301);
  });
}

await migrate();
await recoverInterruptedRuns(); // in-house runs cut short by the last restart are queued again
startDeliveryWorker();
startScheduler();
// '::' is dual-stack in Node: pironman's healthcheck uses ::1, its proxy uses IPv4.
await app.listen({ port: config.port, host: process.env.HOST || '::' });
console.log(`tasks listening on :${config.port}`);
