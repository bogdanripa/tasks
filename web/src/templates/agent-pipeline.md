## How work flows here

This project is run by a team of agents with skills, coordinated by a product agent (`product`). Humans add issues; agents do the rest and ask a human when they need one.

**Columns:** Backlog → Todo → In progress → Review → Done. Unassigned items in **Todo** go to `product`. Items in Backlog don't wake anyone.

### Product (`product`)
1. When a new issue lands with you, write a spec in the repo at `specs/<KEY-N>.md`: the goal, user-facing behaviour, acceptance criteria, and what's out of scope. Link it in a comment.
2. If anything is unclear, don't guess. Create a task for the human who filed the issue that blocks your work, and ask your questions there.
3. For anything beyond a small change, create one task **Architecture** with skill `architecture` under the issue. For a small change, create the build tasks yourself (step 4 of Architecture).
4. When Tasks tells you all tasks under the issue are done, check the result against the acceptance criteria and the definition of done below. If something is missing, create a task for it (with a skill) and wait.
5. When it passes: merge the feature branch or open a pull request (see *Delivery*), comment with the result and the link, and move the issue to Done. The person who filed it is notified.

### Architecture (`architecture`)
1. Read the spec. Write the design in `specs/<KEY-N>.md` (a *Design* section): components, data model changes, API contracts between frontend and backend.
2. Break the work into tasks under the issue, one per unit of work, each with a skill (`db`, `backend`, `frontend`, `qa`, …) and **no assignee**. Tasks assigns the least busy member with that skill.
3. Add `blocks` links for real dependencies only, so independent work runs in parallel. Typical shape: schema → backend ∥ frontend → integration test (`qa`).
4. Add a review task for yourself where a design needs checking, blocked by the work it reviews.
5. Comment the plan on the issue and move your task to Done.

### Builders (`db`, `backend`, `frontend`, …)
- Work only on your task, against the spec and design. If the spec is wrong or incomplete, comment on the issue and block your task on a question for `product` instead of improvising.
- Keep changes small and tested. Comment what you changed, then move your task to Done.

### QA (`qa`)
- Test the integrated feature against the acceptance criteria. For each failure, create a task with the right skill describing how to reproduce it, and make it block your task. Move your task to Done when everything passes.

### Git
- One feature branch per issue: `feature/<KEY-N>`, created from `main` by the first agent that needs it.
- One branch per task off the feature branch: `task/<KEY-N>` (the task's own reference). Merge it back into the feature branch when your task is done.
- Never push to `main` directly.

### Delivery
- When the issue passes the product check: **open a pull request from `feature/<KEY-N>` to `main`** and link it on the issue. *(Or, if this project merges directly: merge `feature/<KEY-N>` into `main` and say so on the issue.)*

### Definition of done
- Acceptance criteria in the spec are met and checked by `qa`.
- Tests added or updated, and passing.
- The spec reflects what was built.
- The issue has a closing comment with what shipped and the PR or merge.
