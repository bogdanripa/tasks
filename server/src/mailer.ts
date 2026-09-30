import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';

export type Email = { to: string; subject: string; text: string; html?: string; headers?: Record<string, string> };

// A transport delivers one fully-formed email (From already set) and throws on failure.
export interface Transport {
  send(e: Email & { from: string }): Promise<void>;
}

// Default: write the whole email to the log. Lets features be verified before credentials exist.
export class LogTransport implements Transport {
  async send(e: Email & { from: string }): Promise<void> {
    console.log('mail (log transport)', JSON.stringify(e, null, 2));
  }
}

export class SmtpTransport implements Transport {
  private tx: Transporter | null = null;
  async send(e: Email & { from: string }): Promise<void> {
    if (!config.email.smtpUrl) throw new Error('EMAIL_TRANSPORT=smtp requires SMTP_URL');
    this.tx ??= nodemailer.createTransport(config.email.smtpUrl);
    await this.tx.sendMail(e);
  }
}

let override: Transport | null = null;
/** Test hook: capture or fail emails without touching config. Pass null to restore. */
export function setTransportForTests(t: Transport | null) { override = t; }

function transport(): Transport {
  if (override) return override;
  switch (config.email.transport) {
    case 'log': return new LogTransport();
    case 'smtp': return smtp ??= new SmtpTransport();
    default: throw new Error(`Unknown EMAIL_TRANSPORT "${config.email.transport}" (use "log" or "smtp")`);
  }
}
let smtp: SmtpTransport | null = null;

/**
 * Send one email through the configured transport, adding From. Misconfiguration surfaces here, at
 * send time, so the server always boots without credentials. `unsubscribeUrl` (callers build it from
 * their token; the mailer doesn't guess the topic) adds List-Unsubscribe and RFC 8058 one-click headers.
 */
export async function sendEmail(e: Email & { unsubscribeUrl?: string }): Promise<void> {
  const { unsubscribeUrl, ...email } = e;
  const from = config.email.from;
  if (!override && config.email.transport === 'smtp' && !from) throw new Error('EMAIL_TRANSPORT=smtp requires EMAIL_FROM');
  const headers = { ...email.headers };
  if (unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  await transport().send({ ...email, headers, from: from || 'Mustered <noreply@localhost>' });
}
