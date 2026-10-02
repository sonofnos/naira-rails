import * as pg from 'pg';
import { DataSource } from 'typeorm';
import { InitSchema1759363200000 } from '../src/migrations/1759363200000-InitSchema';
import { migrateWithLock } from '../src/migrations/migrate';

/**
 * Three instances booting at once against a FRESH database (rolling deploy /
 * scale-out). With TypeORM's own `migrationsRun: true` two of the three died
 * with a pg_class duplicate-key error; migrateWithLock serialises them.
 */
describe('Migrations under concurrent boot', () => {
  const dbName = `boot_race_${Date.now()}`;
  const base = {
    type: 'postgres' as const,
    driver: pg,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  };
  let admin: DataSource;

  beforeAll(async () => {
    admin = await new DataSource({ ...base, database: process.env.DB_NAME }).initialize();
    await admin.query(`CREATE DATABASE ${dbName}`);
  });
  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.destroy();
  });

  it('three instances migrating simultaneously all start, and the schema is applied once', async () => {
    const instances = Array.from(
      { length: 3 },
      () => new DataSource({ ...base, database: dbName, migrations: [InitSchema1759363200000] }),
    );
    await Promise.all(instances.map((ds) => ds.initialize()));
    const results = await Promise.allSettled(instances.map((ds) => migrateWithLock(ds)));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);

    const [{ n }] = await instances[0].query(`SELECT count(*)::int AS n FROM migrations`);
    expect(n).toBe(1);
    const [{ sys }] = await instances[0].query(
      `SELECT count(*)::int AS sys FROM ledger_accounts WHERE code LIKE 'SYS:%'`,
    );
    expect(sys).toBe(6); // seed rows inserted exactly once
    await Promise.all(instances.map((ds) => ds.destroy()));
  });
});
