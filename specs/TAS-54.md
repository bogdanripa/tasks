# TAS-54: "starting in …" pill wraps onto two lines

## Goal
The `starting in 0:42` / `queued` / `starting…` pill (`StartsSoon` in `web/src/ui.tsx`, styled by `.starting`)
must stay on a single line on board cards and table rows, even where horizontal space is tight.

## User-facing behaviour
- The pill shows a clock icon plus the countdown only (e.g. `🕒 0:42`, or `<60s` as `42s`), instead of the words "starting in".
- `queued` and `starting…` states also render as compact single-line pills (icon + short text).
- The full wording is kept in the `title`/`aria-label` (e.g. "Starting in 0:42 — click to start now"), so meaning isn't lost.
- Still clickable to start now, and keeps the existing hover style.

## Acceptance criteria
1. On a board card and in the table view, the pill never wraps to two lines (`white-space: nowrap`), at desktop and narrow (~360px) widths.
2. Countdown pill shows a clock icon and the time only; no "starting in" text.
3. Tooltip and accessible name still say "starting in …".
4. No console errors; existing behaviour (click to start now, queued state) unchanged.

## Out of scope
Other pills/chips, changes to when the pill appears, or countdown logic.
