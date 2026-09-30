// Mailer checks that need no server or database: npx tsx scripts/mailer-smoke.ts
import assert from 'node:assert/strict';
import { sendEmail, setTransportForTests, type Email } from '../src/mailer.js';

// Default config (no env): log transport, no credentials, succeeds and writes to the log.
const logged: string[] = [];
const orig = console.log;
console.log = (...a) => { logged.push(a.join(' ')); };
await sendEmail({ to: 'a@example.com', subject: 'Hi', text: 'body', unsubscribeUrl: 'https://x/u?t=1' });
console.log = orig;
assert.ok(logged[0].includes('a@example.com') && logged[0].includes('List-Unsubscribe-Post'));

// Headers and From reach the transport; failures propagate.
let got: any;
setTransportForTests({ send: async (e: Email & { from: string }) => { got = e; } });
await sendEmail({ to: 'b@example.com', subject: 'S', text: 'T', unsubscribeUrl: 'https://x/u?t=2' });
assert.equal(got.headers['List-Unsubscribe'], '<https://x/u?t=2>');
assert.equal(got.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
assert.ok(got.from);
setTransportForTests({ send: async () => { throw new Error('boom'); } });
await assert.rejects(sendEmail({ to: 'c@example.com', subject: 'S', text: 'T' }), /boom/);
setTransportForTests(null);
console.log('✓ mailer (log default, headers, failure propagates)');
