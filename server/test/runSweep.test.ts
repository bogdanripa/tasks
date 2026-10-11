import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRun, planIdleRetry, MAX_IDLE_RETRIES_PER_DAY, RUN_IDLE_MINUTES, RUN_CHECKIN_MINUTES } from '../src/runSweep.ts';

const now = new Date('2026-10-11T12:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

test('idle threshold is 30 minutes', () => assert.equal(RUN_IDLE_MINUTES, 30));
test('a run quiet past the idle threshold is released as idle', () => {
  assert.equal(classifyRun({ createdAt: ago(300), lastUsedAt: ago(RUN_IDLE_MINUTES + 1) }, now), 'idle');
});
test('an active run is kept', () => {
  assert.equal(classifyRun({ createdAt: ago(300), lastUsedAt: ago(RUN_IDLE_MINUTES - 1) }, now), 'keep');
});
test('a run that never reached Mustered keeps working until the check-in window passes', () => {
  assert.equal(classifyRun({ createdAt: ago(RUN_CHECKIN_MINUTES - 1), lastUsedAt: null }, now), 'keep');
  assert.equal(classifyRun({ createdAt: ago(RUN_CHECKIN_MINUTES + 1), lastUsedAt: null }, now), 'never_reached');
});
test('an idle release is retried while the item is still the agent’s and under the cap', () => {
  assert.equal(planIdleRetry({ stillAssigned: true, retriesToday: 0, alreadyCapped: false }), 'retry');
  assert.equal(planIdleRetry({ stillAssigned: true, retriesToday: MAX_IDLE_RETRIES_PER_DAY - 1, alreadyCapped: false }), 'retry');
});
test('no retry when the item was reassigned', () => {
  assert.equal(planIdleRetry({ stillAssigned: false, retriesToday: 0, alreadyCapped: false }), 'none');
});
test('at the cap a human is asked once, then nothing', () => {
  assert.equal(planIdleRetry({ stillAssigned: true, retriesToday: MAX_IDLE_RETRIES_PER_DAY, alreadyCapped: false }), 'capped');
  assert.equal(planIdleRetry({ stillAssigned: true, retriesToday: MAX_IDLE_RETRIES_PER_DAY, alreadyCapped: true }), 'none');
});
