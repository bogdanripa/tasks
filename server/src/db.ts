import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

export const sql = postgres(config.databaseUrl, {
  transform: { column: { from: postgres.toCamel } },
  onnotice: () => {},
});

export type Db = postgres.Sql | postgres.TransactionSql;

// Fired after every committed mutation; wakes long-pollers and the webhook worker.
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export async function mutate<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = (await sql.begin(fn)) as T;
  bus.emit('pulse');
  return result;
}

export async function migrate() {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await sql`select name from schema_migrations`).map((r) => r.name));
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(dir + file, 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    console.log(`migrated ${file}`);
  }
}
