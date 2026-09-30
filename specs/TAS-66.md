# TAS-66: Explain each pill on hover

## Goal
Every pill/chip on a task or issue (board cards, the table view, the item page header) says what it means when hovered,
and says what clicking it does when it is clickable. Example: the clock + countdown reads
"Starting in 0:42 — an agent will start on this after a short quiet period. Click to start now."

## Current state (dev, verified in code)
- `StartsSoon` (`web/src/ui.tsx`) already has a descriptive `title`; `queued` / `starting…` have short titles.
- `Working` has a title; the "tasks done" pill says only "Tasks done"; "links" says only "Links";
  "blocked" says "Waiting on X" (good); `SkillChip` and the table view (`ItemTable.tsx`) pills are inconsistent.

## User-facing behaviour
Hover (native `title`, also `aria-label` where the pill is a button/link) on each pill gives a full sentence:
- Countdown (clock + `0:42` / `42s`): "Starting in 0:42 — … Click to start now." (keep existing behaviour; confirm it shows on every place the pill renders: board card, table, item page).
- `queued`: "Queued — the agent is finishing other work and will start on this next."
- `starting…`: unchanged.
- `working`: "An agent is working on this right now. Click to watch." (when it links to a run).
- `☑ 2/5`: "2 of 5 tasks done".
- `⇄ 3`: "3 linked items".
- `⏸ blocked`: "Blocked — waiting on TAS-12, TAS-14 to finish".
- Skill chip: "Needs the <skill> skill — will be assigned to the least busy member with it" (missing-assignee variant).
- Assignee: unchanged.
Wording may be tightened; the point is that no pill is unlabeled or a bare noun.

## Acceptance criteria
1. Hovering each pill listed above, on the board and in the table view, shows a sentence-level tooltip as specified.
2. Clickable pills say what the click does; non-clickable ones don't imply they are.
3. Existing behaviour (click to start now, watch run, opening the card) unchanged; no console errors.
4. Buttons/links keep an accurate `aria-label`.

## Out of scope
Custom-styled (non-native) tooltips, touch/long-press support, other UI text, backend changes.
