import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl });
}

/**
 * Applies migrations/*.sql in filename order. Files are idempotent
 * (create ... if not exists), so re-running is safe; the table records
 * what ran for operator visibility.
 */
export async function migrate(db: Db, migrationsDir: string): Promise<void> {
  await db.query(
    `create table if not exists schema_migration (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  // Session-level advisory lock so concurrently booting instances don't race
  // each other through the migration list.
  const lockClient = await db.connect();
  try {
    await lockClient.query('select pg_advisory_lock(812736450)');
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rowCount } = await db.query('select 1 from schema_migration where name = $1', [
        file,
      ]);
      if (rowCount) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      const client = await db.connect();
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migration (name) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    await lockClient.query('select pg_advisory_unlock(812736450)').catch(() => undefined);
    lockClient.release();
  }
}

export async function withTransaction<T>(
  db: Db,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
