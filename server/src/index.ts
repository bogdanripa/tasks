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

const app = Fastify({ logger: { level: config.production ? 'info' : 'warn' }, trustProxy: true });
await app.register(cookie);
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

// Serve the built SPA; any unknown non-API path falls back to index.html.
const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fstatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || /^\/(api|auth|mcp)(\/|$)/.test(req.url)) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

await migrate();
startDeliveryWorker();
// '::' is dual-stack in Node: pironman's healthcheck uses ::1, its proxy uses IPv4.
await app.listen({ port: config.port, host: process.env.HOST || '::' });
console.log(`tasks listening on :${config.port}`);
