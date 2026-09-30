// Scheduler checks that need no database: npx tsx scripts/mailscheduler-smoke.ts
import assert from 'node:assert/strict';
import { localParts, registerDailyJob } from '../src/mailScheduler.js';

// Same instant, two zones: 05:00Z is 07:00 in Bucharest (summer, UTC+3) and 22:00 the day before in Los Angeles.
const t = new Date('2026-07-15T04:00:00Z');
assert.deepEqual(localParts(t, 'Europe/Bucharest'), { localDate: '2026-07-15', minutes: 7 * 60 });
assert.deepEqual(localParts(t, 'America/Los_Angeles'), { localDate: '2026-07-14', minutes: 21 * 60 });
// DST: Bucharest is UTC+2 in winter.
assert.deepEqual(localParts(new Date('2026-01-15T05:00:00Z'), 'Europe/Bucharest'), { localDate: '2026-01-15', minutes: 7 * 60 });
// Midnight renders as 00, not 24.
assert.equal(localParts(new Date('2026-07-15T21:00:00Z'), 'Europe/Bucharest').minutes, 0);
assert.throws(() => localParts(t, 'Not/AZone'));

const job = { topic: 't', hour: 7, defaultEnabled: true, build: async () => null };
registerDailyJob(job);
assert.throws(() => registerDailyJob(job), /already registered/);
console.log('✓ mail scheduler (local time across zones/DST, job registry)');
