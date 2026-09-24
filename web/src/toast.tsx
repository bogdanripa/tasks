import { useEffect, useState } from 'react';

/**
 * Small notifications at the top right. Each one fades out on its own after a few seconds, so several
 * saves in a row stack up and disappear one by one.
 */
type Toast = { id: number; text: string; kind: 'ok' | 'error' };

let next = 1;
let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();
const emit = () => listeners.forEach((l) => l([...toasts]));

export function toast(text: string, kind: Toast['kind'] = 'ok') {
  const t = { id: next++, text, kind };
  toasts = [...toasts, t].slice(-5);
  emit();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    emit();
  }, kind === 'error' ? 6000 : 3200);
}

export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return (
    <div className="toaster" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          <span className="toast-icon" aria-hidden>{t.kind === 'ok' ? '✓' : '!'}</span>
          {t.text}
        </div>
      ))}
    </div>
  );
}
