// Copies the static public site (web/site) to the root of dist, next to the app build in dist/app.
import { cp } from 'node:fs/promises';
await cp(new URL('../site/', import.meta.url), new URL('../dist/', import.meta.url), { recursive: true });
console.log('site copied to dist/');
