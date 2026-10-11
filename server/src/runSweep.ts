// Pure decisions for sweepStaleRuns, kept free of I/O so they can be unit-tested without a database.

/** A run that never calls Mustered within this long is released (usually the routine's network allowlist). */
export const RUN_CHECKIN_MINUTES = 10;
/**
 * A run with no API activity for this long is released (crashed, hung or waiting on a prompt). Agents call the
 * API whenever they comment or move status, so the run prompt tells them to comment progress on long work.
 */
export const RUN_IDLE_MINUTES = 30;
/** Automatic re-fires of an item's work for the same agent, per rolling day, after idle releases. */
export const MAX_IDLE_RETRIES_PER_DAY = 2;

export type OpenRun = { createdAt: Date; lastUsedAt: Date | null };

/** What the sweep should do with an unfinished routine run. */
export function classifyRun(run: OpenRun, now: Date): 'keep' | 'never_reached' | 'idle' {
  const minutes = (since: Date) => (now.getTime() - since.getTime()) / 60_000;
  if (!run.lastUsedAt) return minutes(run.createdAt) > RUN_CHECKIN_MINUTES ? 'never_reached' : 'keep';
  return minutes(run.lastUsedAt) > RUN_IDLE_MINUTES ? 'idle' : 'keep';
}

/**
 * After an idle release: retry the item's work, tell a human the retries ran out, or do nothing.
 * 'capped' is returned once per cap hit (`alreadyCapped` suppresses repeats).
 */
export function planIdleRetry(o: { stillAssigned: boolean; retriesToday: number; alreadyCapped: boolean }): 'retry' | 'capped' | 'none' {
  if (!o.stillAssigned) return 'none';
  if (o.retriesToday < MAX_IDLE_RETRIES_PER_DAY) return 'retry';
  return o.alreadyCapped ? 'none' : 'capped';
}
