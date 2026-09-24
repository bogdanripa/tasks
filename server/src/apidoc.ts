import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * API reference generated from the routes the server actually registers. Each route declares its
 * summary and Zod schemas next to its handler; the same schemas validate requests and document them,
 * so /api/help and the routine payload can't drift from the code.
 */
export type Doc = {
  section: string;
  summary: string;
  body?: z.ZodObject;
  query?: z.ZodObject;
  /** Name for a trailing wildcard segment (e.g. items/* → {ref}). */
  wildcard?: string;
  /** Included in the compact reference that routine runs get. */
  agent?: boolean;
};

type Registered = { method: string; url: string; doc?: Doc };
const registry: Registered[] = [];

const PARAMS: Record<string, string> = {
  org: 'organization slug',
  key: 'project key, e.g. WEB',
  ref: 'item reference org/KEY-N (or KEY-N when unambiguous)',
  id: 'id',
  email: 'email address',
};

/** Must run before routes are added. Records every /api route, documented or not. */
export function collectRoutes(app: FastifyInstance) {
  app.addHook('onRoute', (r) => {
    if (!r.url.startsWith('/api')) return;
    for (const method of [r.method].flat()) {
      if (method === 'HEAD') continue;
      registry.push({ method, url: r.url, doc: (r.config as { doc?: Doc } | undefined)?.doc });
    }
  });
}

type Input<D extends Doc> = {
  body: D['body'] extends z.ZodObject ? z.infer<D['body']> : undefined;
  query: D['query'] extends z.ZodObject ? z.infer<D['query']> : undefined;
};

/** Register a documented route; the handler receives the validated body and query. */
export function route<D extends Doc>(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  doc: D,
  handler: (req: FastifyRequest<{ Params: Record<string, string> }>, input: Input<D>, reply: FastifyReply) => Promise<unknown>,
) {
  app.route<{ Params: Record<string, string> }>({
    method,
    url,
    config: { doc },
    handler: (req, reply) =>
      handler(req, { body: doc.body?.parse(req.body ?? {}), query: doc.query?.parse(req.query ?? {}) } as Input<D>, reply),
  });
}

const displayPath = (r: Registered) => r.url.replace(/:(\w+)/g, '{$1}').replace(/\*$/, `{${r.doc?.wildcard ?? 'path'}}`);

type JsonSchema = { type?: string | string[]; enum?: unknown[]; const?: unknown; anyOf?: JsonSchema[]; items?: JsonSchema; format?: string;
  maxLength?: number; minLength?: number; maxItems?: number; default?: unknown; description?: string };

function typeOf(s: JsonSchema): string {
  if (s.anyOf) return s.anyOf.map(typeOf).join(' | ');
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.type === 'array') return `${typeOf(s.items ?? {})}[]`;
  return [s.type ?? 'any'].flat().join(' | ') + (s.format ? ` (${s.format})` : '');
}

function fields(schema: z.ZodObject) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as { properties?: Record<string, JsonSchema>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({
    name,
    required: json.required?.includes(name) ?? false,
    type: typeOf(s),
    notes: [s.maxLength && `max ${s.maxLength} chars`, s.maxItems && `max ${s.maxItems}`, s.default !== undefined && `default ${JSON.stringify(s.default)}`, s.description]
      .filter(Boolean)
      .join('; '),
  }));
}

/** Grouped by section in registration order; undocumented routes last. */
function routes() {
  const order = [...new Set(registry.map((r) => r.doc?.section ?? 'Other'))].filter((x) => x !== 'Other').concat('Other');
  return [...registry].sort((a, b) => order.indexOf(a.doc?.section ?? 'Other') - order.indexOf(b.doc?.section ?? 'Other'));
}

/** Detailed, human- and agent-readable reference (GET /api/help). */
export function fullReference(baseUrl: string) {
  const out = [
    'Tasks REST API (generated from the running server)',
    '',
    `Base URL: ${baseUrl}`,
    'Auth: Authorization: Bearer <API key or run token>. The web app uses a session cookie instead.',
    'Bodies are JSON (content-type: application/json). Errors return {"error": "..."} with a 4xx/5xx status.',
    'An item is referenced as org/KEY-N (e.g. demo/WEB-12), or KEY-N when unambiguous. A project is org/KEY.',
    'An issue is a need; tasks are the assignable work under an issue. The last board column means done.',
  ];
  let section = '';
  for (const r of routes()) {
    if ((r.doc?.section ?? 'Other') !== section) {
      section = r.doc?.section ?? 'Other';
      out.push('', `## ${section}`);
    }
    out.push('', `${r.method} ${displayPath(r)}`, `  ${r.doc?.summary ?? '(undocumented)'}`);
    const params = [...displayPath(r).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (params.length) out.push(`  path: ${params.map((p) => `{${p}} ${PARAMS[p] ?? ''}`.trim()).join(', ')}`);
    for (const [label, schema] of [['query', r.doc?.query], ['body', r.doc?.body]] as const) {
      if (!schema) continue;
      out.push(`  ${label}:`);
      for (const f of fields(schema)) out.push(`    ${f.name}${f.required ? '' : '?'}: ${f.type}${f.notes ? `  (${f.notes})` : ''}`);
    }
  }
  return out.join('\n') + '\n';
}

/** Minimal reference for routine payloads: agent-relevant routes, one line each. */
export function compactReference() {
  return routes()
    .filter((r) => r.doc?.agent)
    .map((r) => {
      // Enums are shown inline (kind:triggered|blocks|relates); everything else by name only.
      const field = (f: ReturnType<typeof fields>[number]) =>
        f.name + (f.required ? '' : '?') + (/^"[^"]*"( \| "[^"]*")+$/.test(f.type) ? `:${f.type.replace(/"/g, '').replace(/ \| /g, '|')}` : '');
      const body = r.doc?.body ? ` {${fields(r.doc.body).map(field).join(',')}}` : '';
      const query = r.doc?.query ? `?${fields(r.doc.query).map((f) => f.name).join('&')}` : '';
      return `${r.method} ${displayPath(r)}${query}${body} — ${r.doc!.summary}`;
    })
    .join('\n');
}
