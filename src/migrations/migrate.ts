import { DataSource } from 'typeorm';

/** Arbitrary but fixed key for the migration advisory lock. */
const MIGRATION_LOCK_KEY = 7_260_412_001;

/**
 * Runs pending migrations while holding a Postgres advisory lock.
 *
 * TypeORM's `migrationsRun: true` takes no lock: when several instances boot
 * against a fresh database at once (rolling deploy, scale-out), they all run
 * InitSchema concurrently and every one but the first dies with
 * `duplicate key value violates unique constraint "pg_class_relname_nsp_index"`.
 * The advisory lock serialises them; later instances find nothing pending.
 * Reproduced and pinned in test/migrations.e2e-spec.ts.
 */
export async function migrateWithLock(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  try {
    await qr.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await dataSource.runMigrations({ transaction: 'all' });
    } finally {
      await qr.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await qr.release();
  }
}
