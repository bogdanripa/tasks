## How work flows here

This project is run by a team of agents with skills, coordinated by a product agent (`product`). Humans add issues; agents do the rest and ask a human when they need one.

**Columns:** Backlog → Todo → In progress → Review → Done. Unassigned items in **Todo** go to `product`. Tasks moved to **Review** are handed to a reviewer (`review`) and go back to their author if changes are requested. Items in Backlog don't wake anyone.

### Product (`product`)
0. Make sure the repository has the **production and development branches** named in the project's Repository settings (and in your assignment). Create any that are missing (the development branch from the production one).
1. When a new issue lands with you, write a spec in the repo at `specs/<KEY-N>.md`: the goal, user-facing behaviour, acceptance criteria, and what's out of scope. Link it in a comment.
2. If anything is unclear, don't guess. Create a task for the human who filed the issue that blocks your work, and ask your questions there.
3. For anything beyond a small change, create one task **Architecture** with skill `architecture` under the issue. For a small change, create the build tasks and the `qa` task yourself (steps 2–4 of Architecture), unless the environments don't exist yet (no `staging_url` or `production_url`): then create the Architecture task anyway, so they get set up. Leave the issue In progress and end your run (`POST /api/runs/end`); you'll be woken when all its tasks are done.
4. When Tasks tells you all tasks under the issue are done, do the **definition-of-done check** on **staging**: use the feature in the browser against the spec's acceptance criteria and the definition of done below. If something is missing, create a task for it (with a skill) and end your run.
5. When it passes, release it (see *Branches and environments*), check it on **production**, comment with what shipped and the production URL, and move the issue to Done. The person who filed it is notified.

### Architecture (`architecture`)
0. **Environments are yours.** If `staging_url` or `production_url` is missing, set them up before planning the build: with a hosting connector, create the production app and a staging sister app on the hosting platform, and wire deploys for both (the development branch to staging, the production branch to production). If deploys can't be automated, say in the plan who deploys and when (whoever merges). Save `staging_url`, `production_url` and the hosting app ids as project values. Without hosting access, ask a human.
1. Read the spec. Write the design in `specs/<KEY-N>.md` (a *Design* section): components, data model changes, API contracts between frontend and backend.
2. Break the work into tasks under the issue, one per unit of work, each with a skill (`db`, `backend`, `frontend`, `qa`, …) and **no assignee**. Tasks assigns the least busy member with that skill.
3. Add `blocks` links for real dependencies only, so independent work runs in parallel. Typical shape: schema → backend ∥ frontend → integration test (`qa`).
4. **Every issue that changes the app gets a `qa` task**, blocked by all the build tasks, so QA tests on staging once everything is merged.
5. Comment the plan on the issue and move your task to Done.

### Code review (`review`)
Every code change is reviewed by someone other than its author. When a builder moves a task to **Review**, Tasks hands it to you.
- Read the change on the task's branch against the spec, the design and these guidelines: correctness, tests, readability, security, scope.
- **Approve:** merge the task's pull request into the development branch, comment "approved" with anything noteworthy, and move the task to Done.
- **Request changes:** comment exactly what to change and why, and move the task back to In progress. It returns to its author.
- Never approve your own work.

### Builders (`db`, `backend`, `frontend`, …)
- Work only on your task, against the spec and design. If the spec is wrong or incomplete, comment on the issue and block your task on a question for `product` instead of improvising.
- Work on `task/<KEY-N>` (your task's reference) from the development branch, and open a pull request into it. Never commit to the development or production branch directly.
- Keep changes small and tested. Comment what you changed and link the pull request, then move your task to **Review** (not Done). A reviewer approves it or sends it back to you with comments.

### QA (`qa`)
- Test the feature on **staging**, in the browser, against the acceptance criteria: open the page, use it like a person would (click, type, press keys), take screenshots, and check the console for errors.
- Staging deploys take a few minutes after a merge. If the change isn't there yet, wait and reload before reporting a failure.
- For each failure, create a task with the right skill describing how to reproduce it (steps, what you expected, what happened, console errors), and make it block your task. Move your task to Done when everything passes, with a short test report as a comment.

### Branches and environments
- The **development branch** is what runs on **staging**, the **production branch** what runs on **production**. If the hosting platform doesn't deploy them on every push, whoever merges deploys (with a hosting connector) or asks a human to. Both branches are named in the project's Repository settings (and in every assignment). If they're the same branch, there's no staging and no release step: test on production after the merge.
  - Staging URL: the project value `staging_url`.
  - Production URL: the project value `production_url`.
- **Save what others will need as project values, as soon as you have it.** Whoever sets up an environment, or learns a URL (from a human or from the hosting platform), saves it right away (`staging_url`, `production_url`). The same goes for anything the next person would otherwise have to ask for: other environments, app ids on the hosting platform, where things live. Never secrets: everyone reads project values.
- If a URL you need is missing, set that environment up if you have the access (e.g. a hosting connector), or ask a human. Then save it.
- Every change reaches the development branch through a reviewed pull request from its task branch. Nobody commits to the development or production branch directly. (Specs and designs under `specs/` are the exception: commit them to the development branch.)
- QA and the product check test on staging. Release only what passed there.
- **Release:** after the product check passes, open a pull request from the development branch into the production branch and link it on the issue. *(Or, if this project releases without a human: merge it yourself.)* Then check the production URL.

### Definition of done
- Acceptance criteria in the spec are met and checked by `qa`.
- Every code change was reviewed and approved by someone other than its author.
- Tests added or updated, and passing.
- The spec reflects what was built.
- It works on staging, tested in the browser, and on production after the release.
- The issue has a closing comment with what shipped, the pull request, and the production URL.
