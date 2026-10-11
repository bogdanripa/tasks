// Run-prompt wording that must stay true however the prompt is assembled. Pure so it is unit-testable (routine.ts pulls in the DB).

/** Step 5: a final chat message does not end a run; only a status change or runs/end does. */
export const FINISH_RULE =
  'Your run is only finished when you change the status or call `runs/end`. Ending your turn without one leaves the item marked as being worked on. Always make one of those calls last.';

/** The third review outcome: the reviewer can neither approve nor request changes. */
export function reviewBlockedRule(sendBackColumn: string, endRun: string) {
  return `If you can't conclude (e.g. the pull request has a merge conflict, or you're missing something), comment exactly what is needed and who must act: move it back to "${sendBackColumn}" or create a task for the person who can help. If the status stays as it is, finish with ${endRun}.`;
}
