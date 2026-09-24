import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
import { sql } from './db.js';
import type { Actor } from './auth.js';
import { decrypt, encrypt } from './crypto.js';
import { badRequest, fetchError, notFound } from './errors.js';
import { resolveOrg } from './domain.js';

export const PROVIDERS = ['openai', 'anthropic', 'google', 'xai', 'openai-compatible'] as const;
export type ProviderKind = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  xai: 'xAI Grok',
  'openai-compatible': 'OpenAI-compatible',
};

type ProviderRow = { id: string; orgId: string; provider: ProviderKind; label: string; apiKeyEnc: string; baseUrl: string | null };

/** A language model for one of an org's providers. */
export function languageModel(p: ProviderRow, model: string): LanguageModel {
  const apiKey = decrypt(p.apiKeyEnc);
  switch (p.provider) {
    case 'openai':
      return createOpenAI({ apiKey })(model);
    case 'anthropic':
      return createAnthropic({ apiKey })(model);
    case 'google':
      return createGoogle({ apiKey })(model);
    case 'xai':
      return createXai({ apiKey })(model);
    case 'openai-compatible':
      return createOpenAI({ apiKey, baseURL: p.baseUrl ?? undefined }).chat(model);
  }
}

/** Models the key can use, straight from the provider. Doubles as the key test. */
export async function listModels(p: { provider: ProviderKind; apiKey: string; baseUrl?: string | null }): Promise<string[]> {
  const get = async (url: string, headers: Record<string, string>) => {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw badRequest(`Couldn't reach the provider: ${fetchError(e)}`);
    }
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw badRequest(`The provider refused the key (HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''})`);
    return body;
  };
  const bearer = { authorization: `Bearer ${p.apiKey}` };
  let ids: string[];
  switch (p.provider) {
    case 'openai':
      ids = (await get('https://api.openai.com/v1/models', bearer)).data.map((m: any) => m.id).filter((id: string) => /^(gpt|o\d|chatgpt)/.test(id));
      break;
    case 'anthropic':
      ids = (await get('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' })).data.map((m: any) => m.id);
      break;
    case 'google':
      ids = (await get(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(p.apiKey)}`, {})).models
        .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m: any) => String(m.name).replace(/^models\//, ''));
      break;
    case 'xai':
      ids = (await get('https://api.x.ai/v1/models', bearer)).data.map((m: any) => m.id);
      break;
    case 'openai-compatible':
      if (!p.baseUrl) throw badRequest('An OpenAI-compatible provider needs a base URL');
      ids = (await get(`${p.baseUrl.replace(/\/$/, '')}/models`, bearer)).data.map((m: any) => m.id);
      break;
  }
  return [...new Set(ids)].sort();
}

export async function providerFor(orgId: string, id: string) {
  const [p] = await sql`select * from ai_providers where id = ${id} and org_id = ${orgId}`;
  return (p as ProviderRow) ?? null;
}

export async function listProviders(actor: Actor, slug: string) {
  const org = await resolveOrg(actor, slug);
  return sql`
    select p.id, p.provider, p.label, p.base_url, p.created_at,
           (select count(*)::int from accounts a where a.runtime_provider_id = p.id and a.deactivated_at is null) as agents
    from ai_providers p where p.org_id = ${org.id} order by p.created_at`;
}

/** Admins add a key; it's checked against the provider first, stored encrypted, and never returned. */
export async function addProvider(actor: Actor, slug: string, input: { provider: ProviderKind; apiKey: string; label?: string; baseUrl?: string | null }) {
  const org = await resolveOrg(actor, slug, true);
  const baseUrl = input.provider === 'openai-compatible' ? input.baseUrl?.trim() || null : null;
  const models = await listModels({ provider: input.provider, apiKey: input.apiKey.trim(), baseUrl });
  const [row] = await sql`
    insert into ai_providers (org_id, provider, label, api_key_enc, base_url, created_by)
    values (${org.id}, ${input.provider}, ${input.label?.trim() || PROVIDER_LABELS[input.provider]}, ${encrypt(input.apiKey.trim())}, ${baseUrl}, ${actor.id})
    returning id, provider, label, base_url, created_at`;
  return { ...row, models };
}

export async function providerModels(actor: Actor, slug: string, id: string) {
  const org = await resolveOrg(actor, slug);
  const p = await providerFor(org.id, id);
  if (!p) throw notFound('Provider');
  return listModels({ provider: p.provider, apiKey: decrypt(p.apiKeyEnc), baseUrl: p.baseUrl });
}

export async function deleteProvider(actor: Actor, slug: string, id: string) {
  const org = await resolveOrg(actor, slug, true);
  const [row] = await sql`delete from ai_providers where id = ${id} and org_id = ${org.id} returning id`;
  if (!row) throw notFound('Provider');
}
