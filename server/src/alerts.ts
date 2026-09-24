import { sql } from './db.js';
import { config } from './config.js';
import type { Actor } from './auth.js';
import { decrypt, encrypt } from './crypto.js';
import { badRequest, fetchError } from './errors.js';

/**
 * Alerts reach a person outside the inbox, on their own Telegram bot and chat, for what needs them: the
 * watchdog giving up on stalled work, and questions or tasks an agent hands them (including out-of-credits
 * top-ups). Everything else stays in the inbox.
 */
export const ALERT_REASONS = new Set(['stalled', 'assigned', 'needs_reviewer']);
export const isAlert = (reason: string, actor: { kind: string }) => ALERT_REASONS.has(reason) && (reason === 'stalled' || actor.kind === 'agent');

// Overridable so tests can use a fake Telegram.
const TELEGRAM = (process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').replace(/\/$/, '');

async function telegram(token: string, method: string, body: unknown) {
  let res: Response;
  try {
    res = await fetch(`${TELEGRAM}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`Telegram unreachable: ${fetchError(e)}`);
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!json.ok) throw new Error(`Telegram: ${json.description ?? `HTTP ${res.status}`}`);
  return json;
}

export async function getAlerts(actor: Actor) {
  const [a] = await sql`select telegram_chat_id, telegram_bot_token_enc is not null as has_token from accounts where id = ${actor.id}`;
  return { telegram: a?.telegramChatId && a.hasToken ? { chatId: a.telegramChatId } : null };
}

export async function setTelegram(actor: Actor, input: { botToken: string; chatId: string } | null) {
  if (actor.kind !== 'human') throw badRequest('Alerts are for people');
  if (!input) {
    await sql`update accounts set telegram_bot_token_enc = null, telegram_chat_id = null where id = ${actor.id}`;
    return { telegram: null };
  }
  const token = input.botToken.trim();
  const chatId = input.chatId.trim();
  try {
    await telegram(token, 'sendMessage', { chat_id: chatId, text: 'Tasks will send you alerts here: stalled work, and questions or tasks agents hand you.' });
  } catch (e) {
    throw badRequest(`Couldn’t send a test message: ${(e as Error).message}`);
  }
  await sql`update accounts set telegram_bot_token_enc = ${encrypt(token)}, telegram_chat_id = ${chatId} where id = ${actor.id}`;
  return { telegram: { chatId } };
}

/** Deliver one alert notification. Returns an error message, or null when sent. */
export async function sendAlert(n: {
  telegramBotTokenEnc: string; telegramChatId: string; reason: string; eventType: string; eventData: any;
  actorName: string; itemRef: string | null; itemTitle: string | null;
}): Promise<string | null> {
  const d = n.eventData ?? {};
  const link = n.itemRef ? `${config.publicUrl}/app/i/${n.itemRef}` : config.publicUrl;
  const what = n.itemRef ? `${n.itemRef} “${n.itemTitle ?? ''}”` : 'an item';
  const text =
    n.reason === 'stalled'
      ? `⚠️ Needs you: ${what} is stuck in ${d.status} (${d.idleMinutes} min, ${d.why ?? 'stalled'}).\n${link}`
      : n.reason === 'needs_reviewer'
        ? `👀 ${what} needs a reviewer.\n${link}`
        : `🙋 ${n.actorName} handed you ${what}.\n${link}`;
  try {
    await telegram(decrypt(n.telegramBotTokenEnc), 'sendMessage', { chat_id: n.telegramChatId, text, disable_web_page_preview: true });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
