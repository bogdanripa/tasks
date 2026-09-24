// The public pages are static and cached by the CDN; this only personalizes the header button.
fetch('/api/me', { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json() : null))
  .then((me) => {
    if (!me) return;
    for (const a of document.querySelectorAll('[data-app-link]')) {
      a.textContent = 'Open app';
      a.setAttribute('href', '/app/');
    }
  })
  .catch(() => {});
