import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Каталог SQL-миграций: рядом с исходниками (dev) или скопирован в dist (prod). */
function migrationsDir(): string {
  const candidates = [path.join(here, 'migrations'), path.join(here, '..', 'src', 'migrations')];
  const dir = candidates.find((d) => fs.existsSync(d));
  if (!dir) throw new Error('Не найден каталог миграций');
  return dir;
}

export async function migrate(sql: Sql, log: (m: string) => void = console.log): Promise<void> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const dir = migrationsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    log(`Миграция ${f}`);
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${f})`;
    });
  }
}
