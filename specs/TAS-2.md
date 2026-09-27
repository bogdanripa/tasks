# TAS-2: Image support in task descriptions and comments

## Goal

Let a human paste or upload an image into an issue/task description or a comment, on the
web app, and have it show up inline wherever that text is rendered. Give agents the same
capability through the REST API and the MCP server, so an agent can attach a screenshot or
diagram to an issue, task or comment it creates or edits — not just humans in the browser.

Descriptions and comments are already rendered as Markdown (`react-markdown` + `remark-gfm`)
on the web app. This feature adds the ability to get an image *into* that Markdown, plus
somewhere to store the image and a URL to serve it back from.

## User-facing behaviour

**Web app** (description editor on an issue/task, and the comment box on an item page):

- Pasting an image from the clipboard (e.g. a screenshot copied with Cmd/Ctrl+Shift+4 or a
  browser "copy image") into the description or comment text area uploads it and inserts a
  Markdown image reference (`![](<url>)`) at the cursor.
- Choosing a file with a file picker (an "add image" control near the text area) does the
  same for a file already on disk.
- Dragging an image file onto the text area does the same.
- While an image is uploading, the editor shows it as pending (e.g. a placeholder or disabled
  submit) rather than letting the surrounding text be submitted with a broken reference.
- Once submitted, the description or comment renders the image inline, sized to fit the
  content column (not at native resolution if that's huge), wherever that Markdown is shown
  (item page, any other place descriptions/comments are rendered).
- Multiple images in one description or comment are supported (paste/upload more than once).
- A rejected upload (wrong type, too large) shows an inline error and does not insert anything.

**API / MCP** (agents):

- An agent can upload an image (as part of, or immediately before, creating/updating an issue
  or task, or posting a comment) and get back a URL it can put in the Markdown body itself
  (`![](<url>)`), the same reference form the web app inserts.
- The MCP tool list gains a way to do this (an upload tool, or an existing tool accepting
  inline image data) — a human user and an agent end up producing the same kind of body text.
- Existing `create_issue`, `create_task`, `update_item` and `comment` calls are unaffected if
  the body has no image reference in it; this is additive.

**Everyone** (viewing):

- Anyone who can already see an item's description or its comments (i.e. anyone who could see
  the Markdown text today) can see the images embedded in it. No new, separate permission
  model for "can this account see this image" — visibility follows the item, the same as the
  rest of its body text.
- An image URL is not guessable/enumerable in a way that lets someone without access to the
  item retrieve the image (e.g. a random/opaque id, and access checked the same way other
  authenticated Tasks resources are).

## Acceptance criteria

1. Pasting an image from the clipboard into the description editor of an issue or task
   uploads it and the resulting saved description renders that image inline on the item page.
2. Pasting an image from the clipboard into a comment box does the same for that comment.
3. A file picker and drag-and-drop both work as alternatives to paste, for both descriptions
   and comments.
4. An image inserted this way survives a page reload and appears for a different signed-in
   user who has access to the same item (i.e. it's stored server-side, not a local-only
   preview).
5. Multiple images can be added to a single description or comment.
6. A non-image file, or an image over the configured size limit, is rejected with a visible
   error and does not corrupt the body text.
7. An agent can, via at least one REST endpoint and at least one MCP tool, upload an image and
   obtain a URL that — once placed in an item's or comment's body — renders inline exactly like
   a pasted image does.
8. `GET /api/help` documents the new REST endpoint(s) (existing convention: every route is
   self-documenting).
9. Fetching an image's URL without the right access (not signed in, or signed in as an account
   that can't see the owning item) is refused the same way other protected Tasks resources are.
10. Existing descriptions, comments, API calls and MCP tool calls that don't touch images
    continue to work unchanged.

## Out of scope

- Editing, cropping, or annotating an image after it's uploaded.
- Image galleries, thumbnails grids, or a dedicated "attachments" list separate from inline
  Markdown images.
- Video, audio, or non-image file attachments of any kind.
- Virus/malware scanning of uploaded content.
- Removing/replacing an individual embedded image other than by editing the Markdown body
  text (no separate "delete this image" UI).
- Any change to how existing (non-image) Markdown rendering works.

## Design

### Environments

- **Production:** the existing `tasks` app — https://tasks-coolify.bogdanripa.com — deploys from `main`. Unchanged.
- **Staging:** new `tasks-dev` app — https://tasks-dev-coolify.bogdanripa.com — deploys from `dev`. Its own Postgres database, environment and deploy key (`PAAS_KEY_DEV`), sharing nothing with production. `DEV_LOGIN=1` is set there so QA can sign in with just an email, rather than needing a second Google OAuth client registered for the staging hostname.
- `.github/workflows/deploy.yml` now builds and ships both from one workflow: `main` → `tasks` (`:latest`), `dev` → `tasks-dev` (`:dev`). Each push builds one arm64 image, tags it for whichever app the branch targets, and calls that app's own `/refresh` hook with that app's own deploy key. Releasing one never waits on or redeploys the other.

### Data model

New migration (`server/migrations/019_images.sql`):

```sql
create table images (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  uploaded_by uuid references members(id) on delete set null,
  mime_type text not null,
  byte_size integer not null,
  data bytea not null,
  created_at timestamptz not null default now()
);
create index images_org_id_idx on images(org_id);
```

- Images are stored as bytes in Postgres, not on the container filesystem: Pironman recreates the app's container on every deploy, so anything written to disk is lost the moment CI ships a new image. Postgres is already the durable store for everything else this app keeps.
- No foreign key to `items` or `comments`. An image is uploaded (on paste, drop, or file pick) before the description or comment that will reference it is saved — sometimes before the user finishes typing at all — and a rejected or abandoned upload must never corrupt the surrounding text. The only link between an image and the item that ends up showing it is the `![](url)` reference inside that item's or comment's Markdown body, exactly like any other Markdown content.
- Scoped to `org_id`, matching how visibility already works: any member of an org can see any item's or comment's text in that org's projects, and an image now follows the same rule (see Access below) — no separate per-image ACL to maintain.
- Size cap 8 MB; allowed types `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Enforced server-side as constants in `config.ts` (no new env var needed) and mirrored client-side so a rejection is immediate, before any upload starts.

### Backend (`server/src/routes.ts`, `server/src/domain.ts`)

- `POST /api/orgs/:org/images` (`agent: true`). Accepts `multipart/form-data` (one file field, for the browser) or a JSON body `{data: <base64>, mimeType}` (so the MCP tool and other callers don't need multipart). Requires the same auth as any other org-scoped write (session cookie or API key) and org membership. Validates size and MIME type, inserts one row, returns `201 {id, url}` where `url = ${PUBLIC_URL}/api/images/{id}`.
- `GET /api/images/:id` serves the bytes with the stored `Content-Type` and `Cache-Control: public, max-age=31536000, immutable` (an id is never reused or mutated once created). Requires auth and checks the requester is a member of the image's `org_id`. An unknown id and an id the requester can't see both answer a plain `404` — the response must not let a caller distinguish "doesn't exist" from "not yours to see" (no enumeration oracle), the same reasoning already applied to other protected Tasks resources.
- Both routes register through the existing `route()` helper, so `GET /api/help` documents them with no separate doc step (criterion 8).

### MCP (`server/src/mcp.ts`)

- New tool `upload_image(org, data: base64, mimeType)` → `{id, url}`, calling the same domain function as the REST route. `create_issue`, `create_task`, `update_item` and `comment` are untouched — an agent uploads first, then puts the returned URL in the body text it was already going to send.

### Frontend (`web/`)

- One shared piece (hook or small component) used by both the issue/task description editor and the comment box, since both need identical behaviour:
  - `onPaste`: read `clipboardData.items`; for an `image/*` item, upload it.
  - A small "add image" control opens a file picker (`<input type="file" accept="image/*">`) for the same upload path.
  - `onDrop` on the text area does the same for a dragged file.
  - While an upload is in flight: mark it pending and disable Submit, then splice in the real `![](url)` (or drop the placeholder on failure) when the request settles — so a submit can never race an in-flight upload, and multiple images can be added one after another.
  - A validation failure (wrong type, too large) or a server rejection shows an inline error and never touches the surrounding text.
- Rendering: the existing `react-markdown` + `remark-gfm` pipeline already turns `![](url)` into an `<img>`. Add a custom `img` renderer via the `components` prop that caps width at the content column (`max-width: 100%; height: auto`) instead of native size. No change to how any other Markdown renders.

### API contract

```
POST /api/orgs/{org}/images
  multipart/form-data: file=<binary>
  or application/json:  {"data": "<base64>", "mimeType": "image/png"}
  -> 201 {"id": "<uuid>", "url": "https://.../api/images/<uuid>"}
  -> 400 {"error": "..."}   (wrong type / too large)

GET /api/images/{id}
  -> 200 <bytes>, Content-Type: <stored mime>, Cache-Control: public, max-age=31536000, immutable
  -> 404                    (unknown id, or requester not a member of the owning org — same response either way)
```
