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
