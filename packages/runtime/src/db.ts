/**
 * Database handle and the sole sanctioned write path.
 *
 * Every WAL write goes through `immediateTransaction`, which wraps Drizzle's
 * `db.transaction(fn, { behavior: 'immediate' })`. `BEGIN IMMEDIATE` acquires
 * the write lock up front, so we never hit a surprise `SQLITE_BUSY` mid-write.
 * SQLite errors are thrown, never swallowed.
 */
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './walSchema.js';

export const DEFAULT_DB_PATH = 'quill.db';

export type QuillDatabase = BetterSQLite3Database<typeof schema>;

/** The transaction handle Drizzle passes to a `db.transaction` callback. */
export type QuillTransaction = Parameters<
  Parameters<QuillDatabase['transaction']>[0]
>[0];

export interface QuillConnection {
  db: QuillDatabase;
  sqlite: Database.Database;
}

/**
 * Open (or create) the WAL database with trading-grade durability settings.
 * `journal_mode = WAL` is sticky — it persists in the file header — so the
 * database stays in WAL mode for every later connection.
 */
export function openDatabase(path: string = DEFAULT_DB_PATH): QuillConnection {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` transaction. This is the only acceptable
 * way to write to the WAL.
 */
export function immediateTransaction<T>(
  db: QuillDatabase,
  fn: (tx: QuillTransaction) => T,
): T {
  return db.transaction(fn, { behavior: 'immediate' });
}
