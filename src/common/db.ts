import { DataSource, EntityManager } from 'typeorm';

/**
 * Runs raw SQL and always returns the row array.
 *
 * TypeORM's `manager.query()` returns `raw.rows` for SELECT/INSERT but
 * `[rows, rowCount]` for UPDATE/DELETE on Postgres, so
 * `(await m.query('UPDATE ... RETURNING id')).length` is 2 whether or not a
 * row matched — a compare-and-set that "wins" every time. `EntityManager`
 * doesn't expose the structured-result flag, so this goes through the
 * QueryRunner (`useStructuredResult = true`) and reads `.records`, which is
 * the row array for every command type. test/ledger.e2e-spec.ts pins
 * both behaviours against a real Postgres.
 */
export async function rows<T = Record<string, any>>(
  m: EntityManager | DataSource,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const manager = m instanceof DataSource ? m.manager : m;
  const owned = !manager.queryRunner;
  const qr = manager.queryRunner ?? manager.connection.createQueryRunner();
  try {
    const result = await qr.query(sql, params, true);
    return (result.records ?? []) as T[];
  } finally {
    if (owned) await qr.release();
  }
}

export async function one<T = Record<string, any>>(
  m: EntityManager | DataSource,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const r = await rows<T>(m, sql, params);
  return r[0];
}

const RETRYABLE = new Set(['40P01', '40001']);

/**
 * Postgres reports deadlock (40P01) / serialization failure (40001) as
 * "abort and retry this transaction". Bounded retry with jitter.
 */
export async function withTxRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const code = err?.code ?? err?.driverError?.code;
      if (!RETRYABLE.has(code) || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 25 * i));
    }
  }
}
