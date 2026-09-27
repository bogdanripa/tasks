# TAS-1: Fix design inconsistency (starting-soon badge)

## Goal

On a card's metadata row (the checklist count, the links count, the "blocked"
indicator), one badge looks like it belongs to a different app: the
"starting in Xs" / "queued" / "starting…" indicator (the `StartsSoon`
component) is a dashed, pill-shaped, coloured button, while every other badge
in the same row is a small flat grey rounded-square chip. Screenshot attached
to this issue shows it on the Todo card for PIR-1 on the board.

Make the starting-soon indicator visually match the rest of the row's badges,
without losing the thing that makes it different in kind: it's clickable
("start now"), the others aren't.

## User-facing behaviour

- Wherever a card or row shows its metadata badges — the Kanban board
  (`Board.tsx`) and the list view (`ItemTable.tsx`) — the starting-soon
  indicator uses the same chip shape, corner radius, sizing and flat
  background as the neighbouring `.pill` badges (tasks-done count, links
  count, "blocked"), in both light and dark theme.
- It keeps a visual cue that it's clickable (e.g. hover feedback, cursor),
  but that cue doesn't come from giving it an entirely different shape
  (dashed pill button) than its neighbours — a subtle affordance (hover
  state, small accent) is enough.
- Countdown text (`starting in 14s`, `starting in 1:04`), the `queued` /
  `starting…` states, the tooltip text, and the "click to start now"
  behaviour are unchanged — this is a visual-only fix.

## Acceptance criteria

1. On the board, a Todo/In-progress card with an upcoming agent start shows
   the "starting in Xs" badge in the same shape/background/corner-radius
   family as its neighbouring badges (tasks-done pill, links pill), not a
   dashed coloured pill-button that stands out from them.
2. The same holds for the `queued` and `starting…` states of the same
   component.
3. The same holds in the list view (`ItemTable.tsx`), which renders the same
   component.
4. The indicator is still clickable and still starts the item immediately
   when clicked (unchanged behaviour), with some hover/visual cue that it's
   interactive.
5. Checked in both light and dark theme.
6. No other badge on the card (tasks-done pill, links pill, blocked pill,
   skill chip, avatar) changes appearance.

## Out of scope

- Any other visual inconsistency in the app not related to this badge.
- Any change to the countdown timing/logic, the quiet-period behaviour, or
  what "click to start now" does.
- A broader redesign of the badge/pill/chip system beyond making this one
  indicator consistent with the existing `.pill` badges.

## Notes for implementation

Small, self-contained CSS/markup change:

- `web/src/ui.tsx` — `StartsSoon` renders `<span className="starting">` /
  `<button className="starting as-button">`.
- `web/src/styles.css` — `.starting`, `.starting::before`,
  `.starting.as-button` (currently: `border-radius: 10px`, `border: 1px
  dashed var(--agent)`, transparent background, `var(--agent)` text) vs.
  `.pill` (currently: `border-radius: 4px`, flat `var(--surface-2)`
  background, `var(--muted)` text) — bring the former in line with the
  latter's shape/background, keeping some minimal state (e.g. `.pill`-style
  base plus a hover background) to signal it's a button.
- Rendered from `web/src/pages/Board.tsx` and `web/src/pages/ItemTable.tsx`
  (both import and use `StartsSoon` unchanged).
