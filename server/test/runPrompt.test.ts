import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINISH_RULE, reviewBlockedRule } from '../src/runPrompt.ts';

test('finish rule says only a status change or runs/end finishes the run', () => {
  assert.match(FINISH_RULE, /only finished when you change the status or call `runs\/end`/);
  assert.match(FINISH_RULE, /Always make one of those calls last/);
});
test('review covers the blocked outcome and ends the run when status stays', () => {
  const t = reviewBlockedRule('In progress', 'end_run');
  assert.match(t, /merge conflict/);
  assert.match(t, /In progress/);
  assert.match(t, /finish with end_run/);
});
