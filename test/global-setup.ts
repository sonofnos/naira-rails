import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

/**
 * Real Postgres 16 and Redis 7 in throwaway containers (Testcontainers), so
 * the suite needs nothing pre-installed beyond Docker — same on a laptop and
 * on a fresh ubuntu-latest runner, no CI service containers.
 */
export default async function globalSetup(): Promise<void> {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('naira_rails')
      .withUsername('naira')
      .withPassword('naira')
      // Room for the concurrency tests' parallel connections.
      .withCommand(['postgres', '-c', 'max_connections=200'])
      .start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  (globalThis as any).__CONTAINERS__ = [pg, redis];

  Object.assign(process.env, {
    DB_HOST: pg.getHost(),
    DB_PORT: String(pg.getPort()),
    DB_USERNAME: 'naira',
    DB_PASSWORD: 'naira',
    DB_NAME: 'naira_rails',
    DB_POOL_MAX: '40',
    REDIS_URL: redis.getConnectionUrl(),
    API_KEY: 'test-api-key',
    BANK_WEBHOOK_SECRET: 'test-webhook-secret',
    CARD_FINGERPRINT_SECRET: 'test-fingerprint-secret',
    PAYOUT_REQUERY_BACKOFF_MS: '0',
    PAYOUT_INLINE_REQUERIES: '2',
    PAYOUT_SWEEP_INTERVAL_MS: '0',
    NIP_NOT_FOUND_GRACE_MS: '300000',
    NIP_MAX_REQUERIES: '4',
    PAYOUT_STALE_MS: '60000',
  });
}
