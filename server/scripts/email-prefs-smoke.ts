// Token checks that need no server or database: npx tsx scripts/email-prefs-smoke.ts
import assert from 'node:assert/strict';
import { readToken, unsubscribeToken, unsubscribeUrl, validTimezone } from '../src/emailPrefs.js';

const id = '11111111-1111-1111-1111-111111111111';
const t = unsubscribeToken(id, 'assigned_summary');
assert.deepEqual(readToken(t), { accountId: id, topic: 'assigned_summary', scope: '' });
assert.deepEqual(readToken(unsubscribeToken(id, 'project_digest', 'p1')), { accountId: id, topic: 'project_digest', scope: 'p1' });
assert.equal(unsubscribeToken(id, 'assigned_summary'), t, 'deterministic, so reading it twice is idempotent');

// Tamper: flip the signature, swap the payload, truncate, junk, unknown topic.
const [p, s] = t.split('.');
assert.equal(readToken(`${p}.${s.slice(0, -2)}AA`), null);
const other = unsubscribeToken('22222222-2222-2222-2222-222222222222', 'assigned_summary').split('.')[0];
assert.equal(readToken(`${other}.${s}`), null);
assert.equal(readToken(p), null);
assert.equal(readToken(`${p}.`), null);
assert.equal(readToken(''), null);
assert.equal(readToken(undefined), null);
assert.equal(readToken(`${t}.x`), null);
assert.equal(readToken(unsubscribeToken(id, 'nonsense')), null);
assert.ok(unsubscribeUrl(t).includes('/api/email/unsubscribe?t='));
assert.ok(validTimezone('Europe/Bucharest') && !validTimezone('Mars/Base'));
console.log('✓ unsubscribe tokens (roundtrip, tamper rejected, url) and timezone validation');

// Through the real route() wrapper — the pure checks above can't catch a handler-signature mistake
// (TAS-48: handlers took (req, reply) while route() passes (req, input, reply), so every call was a 500).
// Invalid-token paths need no database; valid-token paths are covered on staging.
const { default: Fastify } = await import('fastify');
const { emailRoutes } = await import('../src/emailPrefs.js');
const app = Fastify();
emailRoutes(app);
for (const [method, url] of [['GET', '/api/email/unsubscribe'], ['POST', '/api/email/unsubscribe'], ['POST', '/api/email/resubscribe']] as const) {
  for (const q of ['', '?t=abc.def']) {
    const res = await app.inject({ method, url: url + q });
    assert.equal(res.statusCode, 400, `${method} ${url}${q}`);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.match(res.body, /Invalid link/);
  }
}
await app.close();
console.log('✓ email routes reject invalid tokens with 400 through route()');
