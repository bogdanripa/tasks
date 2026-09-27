import { useRef, useState, type RefObject } from 'react';
import { api } from './api';

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const IMAGE_ACCEPT = IMAGE_TYPES.join(',');

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

// Mirrors the server's limits (spec TAS-2) so a bad file is rejected before any upload starts.
function rejectionReason(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return `${file.name || 'That file'} isn’t a supported image type.`;
  if (file.size > IMAGE_MAX_BYTES) return `${file.name || 'That image'} is over the 8 MB limit.`;
  return null;
}

/**
 * Shared paste/drop/file-pick image upload for a markdown textarea, used identically by the item
 * description editor and the comment box. Uploads to POST /api/orgs/:org/images and splices
 * `![](url)` into the text at the cursor once the upload settles, so a fast typist's edits made
 * while it's in flight are never clobbered and a submit can never race an in-flight upload.
 * `org` is undefined where image upload isn't wanted (e.g. org/project guideline editors); every
 * handler below is then a no-op.
 */
export function useImageUpload(org: string | undefined, textareaRef: RefObject<HTMLTextAreaElement | null>, update: (fn: (prev: string) => string) => void) {
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Where the *next* insertion in the current batch should land. The DOM caret move after an
  // insert is deferred to rAF, which is too late for the next file in a multi-upload batch to
  // read via el.selectionStart — so this is updated synchronously inside insertAt instead.
  const nextInsertPos = useRef<number | null>(null);

  const insertAt = (markdown: string, start: number, end: number) => {
    update((prev) => {
      const s = Math.min(start, prev.length);
      const e = Math.min(end, prev.length);
      return prev.slice(0, s) + markdown + prev.slice(e);
    });
    const pos = start + markdown.length;
    nextInsertPos.current = pos;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const upload = async (file: File) => {
    const reason = rejectionReason(file);
    if (reason) { setError(reason); return; }
    const el = textareaRef.current;
    const start = nextInsertPos.current ?? el?.selectionStart ?? el?.value.length ?? 0;
    const end = nextInsertPos.current !== null ? start : (el?.selectionEnd ?? start);
    setError(null);
    setCount((n) => n + 1);
    try {
      const data = await readAsBase64(file);
      const { url } = await api('POST', `/api/orgs/${org}/images`, { data, mimeType: file.type }, { toast: false });
      insertAt(`![](${url})`, start, end);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCount((n) => n - 1);
    }
  };

  // Sequential: each insertion's cursor math is computed against the text left by the one before it.
  const uploadFiles = async (files: File[]) => {
    nextInsertPos.current = null;
    for (const file of files) await upload(file);
    nextInsertPos.current = null;
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!org) return;
    const item = Array.from(e.clipboardData?.items ?? []).find((it) => it.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (file) uploadFiles([file]);
  };

  const onDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    if (!org || !Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === 'file')) return;
    e.preventDefault();
    setDragActive(true);
  };

  const onDragLeave = () => setDragActive(false);

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    setDragActive(false);
    if (!org) return;
    // Don't pre-filter by type: a dropped non-image file is a rejection case (surfaced by
    // upload()'s own check), not something to silently swallow.
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    uploadFiles(files);
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) uploadFiles(files);
  };

  return {
    uploading: count > 0,
    error,
    dragActive,
    textareaProps: { onPaste, onDrop, onDragOver, onDragLeave },
    fileInputRef,
    onFilePick,
    pick: () => fileInputRef.current?.click(),
  };
}

/** The "add image" control + inline upload error, for use next to a textarea wired with `useImageUpload`. */
export function ImageUploadBar({ upload }: { upload: ReturnType<typeof useImageUpload> }) {
  return (
    <span className="image-upload grow-left">
      <input ref={upload.fileInputRef} type="file" accept={IMAGE_ACCEPT} multiple hidden onChange={upload.onFilePick} />
      <button
        type="button"
        className="link small"
        onClick={upload.pick}
        disabled={upload.uploading}
        title="You can also paste or drop an image into the text"
      >
        {upload.uploading ? 'Uploading…' : '+ image'}
      </button>
      {upload.error && <span className="error small">{upload.error}</span>}
    </span>
  );
}
