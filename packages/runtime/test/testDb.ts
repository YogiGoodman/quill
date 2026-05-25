import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase, type QuillConnection } from '../src/db.js';

/**
 * Open a fresh in-memory database with the schema migrated in. Each test gets
 * an isolated database; close it via the returned connection.
 */
export function freshTestDb(): QuillConnection {
  const conn = openDatabase(':memory:');
  migrate(conn.db, { migrationsFolder: 'drizzle' });
  return conn;
}
