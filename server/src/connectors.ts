import { createHmac } from 'node:crypto';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { sql } from './db.js';
import { config } from './config.js';
import type { Actor } from './auth.js';
import { decrypt, encrypt } from './crypto.js';
import { badRequest, HttpError, notFound } from './errors.js';
import { orgRole, requireAgentAdmin, resolveOrg, resolveProject } from './domain.js';

/**
 * MCP connectors: remote MCP servers that agents Tasks runs can use. Defined for the org or a project (then
 * each agent switches on the ones it uses) or for one agent. Each can limit which of the server's tools
 * agents see. Auth: none, a header (e.g. a bearer API key), or OAuth.
 */

export type Scope = { org: string; project?: string; agent?: string };
type Row = Record<string, any>;

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const CALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 20_000;

async function requireScope(actor: Actor, s: Scope) {
  if (s.agent) {
    const agent = await requireAgentAdmin(actor, s.agent);
    return { orgId: agent.orgId as string, projectId: null, agentId: agent.id as string };
  }
  if (s.project) {
    const project = await resolveProject(actor, `${s.org}/${s.project}`);
    if (!['owner', 'admin'].includes((await orgRole(actor.id, project.orgId)) ?? '')) throw new HttpError(403, 'Requires an org admin');
    return { orgId: project.orgId as string, projectId: project.id as string, agentId: null };
  }
  const org = await resolveOrg(actor, s.org, true);
  return { orgId: org.id as string, projectId: null, agentId: null };
}

async function requireConnector(actor: Actor, id: string) {
  const [c] = await sql`select * from connectors where id = ${id}`;
  if (!c) throw notFound('Connector');
  if (c.agentId) await requireAgentAdmin(actor, c.agentId);
  else if (!['owner', 'admin'].includes((await orgRole(actor.id, c.orgId)) ?? '')) throw new HttpError(403, 'Requires an org admin');
  return c;
}

const view = (c: Row) => ({
  id: c.id,
  name: c.name,
  url: c.url,
  auth: c.auth,
  headerName: c.headerName,
  hasHeaderValue: !!c.headerValueEnc,
  oauthConnected: !!c.oauthTokensEnc,
  allowedTools: c.allowedTools,
  scope: c.agentId ? 'agent' : c.projectId ? 'project' : 'org',
  projectKey: c.projectKey ?? null,
  agentName: c.agentName ?? null,
  createdAt: c.createdAt,
});

const withNames = sql`
  select c.*, p.key as project_key, a.name as agent_name from connectors c
  left join projects p on p.id = c.project_id left join accounts a on a.id = c.agent_id`;

/**
 * A level's own connectors. For a project, also the org's (which its agents may switch on). For an agent,
 * the org's and every project's, each with whether the agent uses it.
 */
export async function listConnectors(actor: Actor, s: Scope) {
  const { orgId, projectId, agentId } = await requireScope(actor, s);
  const rows = await sql`
    ${withNames}
    where c.org_id = ${orgId}
    order by c.project_id nulls first, c.name`;
  const own = rows.filter((c) => (agentId ? c.agentId === agentId : projectId ? c.projectId === projectId : !c.projectId && !c.agentId));
  if (agentId) {
    const on = new Set((await sql`select connector_id from agent_connectors where agent_id = ${agentId}`).map((r) => r.connectorId));
    const available = rows.filter((c) => !c.agentId).map((c) => ({ ...view(c), enabled: on.has(c.id) }));
    return { connectors: own.map(view), available, inherited: [] };
  }
  const inherited = projectId ? rows.filter((c) => !c.projectId && !c.agentId) : [];
  return { connectors: own.map(view), inherited: inherited.map(view) };
}

/** Switch an org or project connector on or off for an agent. */
export async function setAgentConnector(actor: Actor, agentId: string, connectorId: string, enabled: boolean) {
  const agent = await requireAgentAdmin(actor, agentId);
  const [c] = await sql`select id from connectors where id = ${connectorId} and org_id = ${agent.orgId} and agent_id is null`;
  if (!c) throw notFound('Connector');
  if (enabled) await sql`insert into agent_connectors (agent_id, connector_id) values (${agentId}, ${connectorId}) on conflict do nothing`;
  else await sql`delete from agent_connectors where agent_id = ${agentId} and connector_id = ${connectorId}`;
  return { enabled };
}

function checkUrl(url: string) {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw badRequest('The URL isn’t valid');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !config.production)) throw badRequest('Connectors need an https:// URL');
  return u.toString();
}

export async function createConnector(
  actor: Actor,
  s: Scope,
  input: { name: string; url: string; auth: 'none' | 'header' | 'oauth'; headerName?: string; headerValue?: string; allowedTools?: string[] | null },
) {
  const { orgId, projectId, agentId } = await requireScope(actor, s);
  const name = input.name.trim().toLowerCase();
  if (!NAME.test(name)) throw badRequest('Name: lowercase letters, digits and hyphens, starting with a letter (it prefixes the tools, e.g. pironman__apps_list)');
  if (input.auth === 'header' && !input.headerValue?.trim()) throw badRequest('Give the header value (e.g. Bearer <key>)');
  const [dupe] = await sql`select 1 from connectors where org_id = ${orgId} and name = ${name}`;
  if (dupe) throw badRequest(`A connector named ${name} already exists in this organization`);
  const [c] = await sql`
    insert into connectors (org_id, project_id, agent_id, name, url, auth, header_name, header_value_enc, allowed_tools, created_by)
    values (${orgId}, ${projectId}, ${agentId}, ${name}, ${checkUrl(input.url)}, ${input.auth},
            ${input.auth === 'header' ? input.headerName?.trim() || 'Authorization' : null},
            ${input.auth === 'header' ? encrypt(input.headerValue!.trim()) : null}, ${input.allowedTools ?? null}, ${actor.id})
    returning *`;
  return view(c);
}

export async function updateConnector(actor: Actor, id: string, patch: { url?: string; headerName?: string; headerValue?: string; allowedTools?: string[] | null }) {
  const c = await requireConnector(actor, id);
  const [row] = await sql`
    update connectors set
      url = ${patch.url ? checkUrl(patch.url) : c.url},
      header_name = ${patch.headerName?.trim() || c.headerName},
      header_value_enc = ${patch.headerValue?.trim() ? encrypt(patch.headerValue.trim()) : c.headerValueEnc},
      allowed_tools = ${patch.allowedTools === undefined ? c.allowedTools : patch.allowedTools}
    where id = ${id} returning *`;
  return view(row);
}

export async function deleteConnector(actor: Actor, id: string) {
  await requireConnector(actor, id);
  await sql`delete from connectors where id = ${id}`;
}

// ---------- OAuth ----------

const REDIRECT = () => `${config.publicUrl}/api/connectors/oauth/callback`;
const sign = (v: string) => createHmac('sha256', config.secretsKey).update(`connector-oauth.${v}`).digest('base64url');

/** Stores a connector's OAuth client registration, PKCE verifier and tokens (encrypted) in its row. */
class DbOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  constructor(
    private c: Row,
    private stateValue?: string,
  ) {}
  get redirectUrl() {
    return REDIRECT();
  }
  get clientMetadata() {
    return { client_name: 'Tasks', redirect_uris: [REDIRECT()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state() {
    return this.stateValue ?? '';
  }
  clientInformation() {
    return this.c.oauthClientEnc ? JSON.parse(decrypt(this.c.oauthClientEnc)) : undefined;
  }
  async saveClientInformation(info: unknown) {
    this.c.oauthClientEnc = encrypt(JSON.stringify(info));
    await sql`update connectors set oauth_client_enc = ${this.c.oauthClientEnc} where id = ${this.c.id}`;
  }
  tokens() {
    return this.c.oauthTokensEnc ? JSON.parse(decrypt(this.c.oauthTokensEnc)) : undefined;
  }
  async saveTokens(tokens: unknown) {
    this.c.oauthTokensEnc = encrypt(JSON.stringify(tokens));
    await sql`update connectors set oauth_tokens_enc = ${this.c.oauthTokensEnc} where id = ${this.c.id}`;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  async saveCodeVerifier(v: string) {
    this.c.oauthVerifierEnc = encrypt(v);
    await sql`update connectors set oauth_verifier_enc = ${this.c.oauthVerifierEnc} where id = ${this.c.id}`;
  }
  codeVerifier() {
    if (!this.c.oauthVerifierEnc) throw new Error('No sign-in in progress');
    return decrypt(this.c.oauthVerifierEnc);
  }
}

/** Where to send an admin to sign the connector in (the server's OAuth flow). */
export async function oauthStart(actor: Actor, id: string) {
  const c = await requireConnector(actor, id);
  if (c.auth !== 'oauth') throw badRequest('This connector doesn’t use OAuth');
  const payload = `${c.id}.${actor.id}.${Date.now() + 15 * 60_000}`;
  const provider = new DbOAuthProvider(c, `${payload}.${sign(payload)}`);
  const result = await auth(provider, { serverUrl: c.url });
  if (result === 'AUTHORIZED') return { done: true, returnTo: await returnPath(c) };
  if (!provider.authorizationUrl) throw badRequest('The server didn’t offer a sign-in');
  return { url: provider.authorizationUrl.toString() };
}

export async function oauthCallback(actor: Actor, q: { code?: string; state?: string; error?: string }) {
  const [id, actorId, exp, sig] = (q.state ?? '').split('.');
  if (!sig || sign(`${id}.${actorId}.${exp}`) !== sig || actorId !== actor.id || Number(exp) < Date.now()) {
    throw badRequest('This sign-in link expired or was started by someone else. Try Connect again.');
  }
  const c = await requireConnector(actor, id);
  if (q.error || !q.code) throw badRequest(`The sign-in didn’t complete (${q.error ?? 'no code'})`);
  const result = await auth(new DbOAuthProvider(c), { serverUrl: c.url, authorizationCode: q.code });
  if (result !== 'AUTHORIZED') throw badRequest('The server didn’t accept the sign-in');
  return returnPath(c);
}

async function returnPath(c: Row) {
  const [o] = await sql`select slug from orgs where id = ${c.orgId}`;
  if (c.agentId) return `/app/agents/${c.agentId}?tab=connectors`;
  if (c.projectId) {
    const [p] = await sql`select key from projects where id = ${c.projectId}`;
    return `/app/${o.slug}/${p.key}/settings?tab=connectors`;
  }
  return `/app/${o.slug}/settings?tab=connectors`;
}

// ---------- connecting ----------

async function connect(c: Row) {
  const headers: Record<string, string> = {};
  if (c.auth === 'header' && c.headerValueEnc) headers[c.headerName || 'Authorization'] = decrypt(c.headerValueEnc);
  if (c.auth === 'oauth' && !c.oauthTokensEnc) throw new Error('not signed in yet (an admin needs to click Connect)');
  const authProvider = c.auth === 'oauth' ? new DbOAuthProvider(c) : undefined;
  const url = new URL(c.url);
  const attempt = async (transport: StreamableHTTPClientTransport | SSEClientTransport) => {
    const client = new Client({ name: 'tasks', version: '1.0.0' });
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out connecting')), 20_000)),
    ]);
    return client;
  };
  try {
    return await attempt(new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider }));
  } catch (e) {
    // Older servers only speak HTTP+SSE.
    try {
      return await attempt(new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as object), ...headers } }) }, authProvider }));
    } catch {
      throw e;
    }
  }
}

async function listTools(client: Client) {
  const tools: { name: string; description?: string; inputSchema: any }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** Connect and list the server's tools (whether each is allowed), to check a connector and pick tools. */
export async function testConnector(actor: Actor, id: string) {
  const c = await requireConnector(actor, id);
  let client: Client;
  try {
    client = await connect(c);
  } catch (e) {
    throw badRequest(`Couldn’t connect: ${(e as Error).message}`);
  }
  try {
    const tools = await listTools(client);
    return tools.map((t) => ({ name: t.name, description: (t.description ?? '').split('\n')[0].slice(0, 200), allowed: !c.allowedTools || c.allowedTools.includes(t.name) }));
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Connectors a run gets: the agent's own, plus the org and project connectors switched on for it (a project's
 * only on that project's items).
 */
export async function runConnectors(orgId: string, projectId: string | null, agentId: string) {
  return sql`
    select c.* from connectors c where c.org_id = ${orgId}
      and (c.agent_id = ${agentId}
        or (c.agent_id is null and (c.project_id is null or c.project_id = ${projectId})
            and exists (select 1 from agent_connectors ac where ac.agent_id = ${agentId} and ac.connector_id = c.id)))
    order by c.name`;
}

const toolName = (connector: string, tool: string) => `${connector}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

function resultText(res: any) {
  const parts: string[] = [];
  for (const c of res.content ?? []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'resource') parts.push(c.resource?.text ?? `[resource ${c.resource?.uri}]`);
    else if (c.type === 'resource_link') parts.push(`[resource ${c.uri}]`);
    else parts.push(`[${c.type} content]`);
  }
  if (!parts.length && res.structuredContent) parts.push(JSON.stringify(res.structuredContent));
  let out = parts.join('\n');
  if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT)}… (truncated)`;
  return res.isError ? `Error: ${out}` : out;
}

/**
 * Open a run's connectors and turn their (allowed) tools into model tools, prefixed with the connector's
 * name. A connector that can't connect is left out, with a note for the agent. Close when the run ends.
 */
export async function openConnectors(orgId: string, projectId: string | null, agentId: string) {
  const rows = await runConnectors(orgId, projectId, agentId);
  const tools: ToolSet = {};
  const clients: Client[] = [];
  const notes: string[] = [];
  const available: string[] = [];
  for (const c of rows) {
    try {
      const client = await connect(c);
      clients.push(client);
      const offered = (await listTools(client)).filter((t) => !c.allowedTools || c.allowedTools.includes(t.name));
      for (const t of offered) {
        tools[toolName(c.name, t.name)] = tool({
          description: `[${c.name}] ${t.description ?? t.name}`.slice(0, 1024),
          inputSchema: jsonSchema(t.inputSchema ?? { type: 'object', properties: {} }),
          execute: async (args: any) => {
            try {
              const res = await client.callTool({ name: t.name, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS });
              return resultText(res);
            } catch (e) {
              return `Error: ${(e as Error).message}`;
            }
          },
        });
      }
      available.push(`${c.name} (${offered.length} tools)`);
    } catch (e) {
      notes.push(`Connector "${c.name}" is unavailable in this run: ${(e as Error).message}. If you need it, ask a human.`);
    }
  }
  return {
    tools,
    notes,
    available,
    close: async () => {
      await Promise.all(clients.map((cl) => cl.close().catch(() => {})));
    },
  };
}
