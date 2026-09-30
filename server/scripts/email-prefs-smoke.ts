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
