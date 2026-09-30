# TAS-59: Settings > Email checkboxes stack and center-align

## Goal
The Email section of the profile settings (`web/src/pages/Settings.tsx`) lays out each checkbox above its label, centered,
and the per-project list does not scale: every new project adds another awkward stacked block.

## Cause
Each option is `<label className="row-gap" style={{alignItems:'center'}}>`. The global `label` rule is `flex-direction: column`
and `.row-gap` does not reset it, so the checkbox sits above its text, centered. The global `input { width: 100% }` also applies.

## User-facing behaviour
- Each checkbox sits inline, to the left of its label text, left-aligned (like `.check-row`, used elsewhere in the app).
- Per-project checkboxes are indented under "Daily project changes" and form a tidy left-aligned list that stays readable with many projects
  (wrapping long names, no horizontal overflow at ~360px).
- Layout uses a shared class (reuse `.check-row`) instead of inline styles.

## Acceptance criteria
1. Checkbox and label text are on one line, left-aligned, for "Daily summary…", "Daily project changes (06:00)" and every project row.
2. Project rows are indented and disabled state still greys them.
3. With 15+ projects the list stays aligned and does not overflow at desktop or ~360px width.
4. Behaviour (saving, disabled states) unchanged; no console errors.

## Out of scope
Other settings sections, email content or scheduling.
