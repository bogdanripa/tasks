# TAS-74: a review run holds an agent for hours (GEP-35 stuck)

## What happened (observed, 2026-10-11)
- GEP-35 (gepetel) went to Review at 07:25:31Z and was handed to Lead.
- Lead's routine run `7906177b…` was fired at 07:29:08Z. It is still `status=fired`, `finished_at=null`,
  with no steps and no comment, status change or merge on GEP-35 in the 1.5h since. GEP-35 shows as "being worked on".
- gepetel PR #6 (task/GEP-29-a → main) is `mergeable_state: dirty`: GEP-36 (PR #7) was merged into main at 07:29:06Z,
  one second before this run started, and conflicts with it.
- The run's token activity is unknown to the PM (agent admin endpoints need an org admin).

## Why it stays stuck
`sweepStaleRuns` (server/src/routine.ts) only releases a run whose token was never used after
`RUN_CHECKIN_MINUTES` (10) or whose token went unused for `RUN_IDLE_MINUTES` (120). A session that checked in once
(first API call) and then hangs (waiting on a prompt, crashed tool, dead session) therefore holds the agent
and its item for two full hours, and while it does the agent's other work queues behind it. Nothing tells a human.

## Goal
A hung run is detected and released much sooner, and the item and its people are told.

## Acceptance criteria
1. Idle threshold: a run whose token has not been used for 30 minutes is released (make the value a named constant;
   long builds are fine because agents call the API when they comment/move status, and the run prompt should say to
   comment progress for work expected to take longer than 30 minutes).
2. When a run is released as idle, the item gets a comment ("Run released after N minutes without activity; re-queued")
   and the item's work is re-fired for the same agent if it is still assigned to that agent and still in a column that
   wakes it (e.g. Review for a reviewer), so a released review is retried instead of left waiting for a human nudge.
3. Retries are capped (e.g. 2 automatic re-fires per item+agent per day) to avoid loops; after the cap the item gets a
   comment asking a human to look.
4. Existing hourly per-item loop guard and the "never reached Mustered" path keep working; add unit tests for the sweep
   (idle released, active kept, retry fired, cap reached).

## Out of scope
- Resolving the PR #6 merge conflict (handled on GEP-35 itself once the run is released).
- Changing the 10-minute check-in rule.
