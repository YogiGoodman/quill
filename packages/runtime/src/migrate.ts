/**
 * Apply Drizzle migrations to the WAL database. Run via `pnpm db:migrate`.
 *
 * Migrations are applied through `openDatabase`, so the database is created in
 * WAL mode rather than the default rollback journal.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type QuillConnection } from './db.js';

export function runMigrations(path?: string): void {
  const conn: QuillConnection = openDatabase(path);
  migrate(conn.db, { migrationsFolder: 'drizzle' });
  const mode = conn.sqlite.pragma('journal_mode', { simple: true });
  conn.sqlite.close();
  console.log(`migrations applied; journal_mode=${String(mode)}`);
}

// This module is an executable script (pnpm db:migrate → tsx src/migrate.ts).
runMigrations();
