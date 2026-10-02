import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS } from '../redis/redis.module';

@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Postgres is required (no money moves without it). Redis is reported but
   * not required: it only caches name enquiries.
   */
  @Get()
  async check() {
    const db = await this.dataSource
      .query('SELECT 1')
      .then(() => 'up')
      .catch(() => 'down');
    const redis = await Promise.race([
      this.redis.ping().then(() => 'up'),
      new Promise<string>((r) => setTimeout(() => r('down'), 500)),
    ]).catch(() => 'down');
    const body = { status: db === 'up' ? 'ok' : 'degraded', postgres: db, redis };
    if (db !== 'up') throw new ServiceUnavailableException(body);
    return body;
  }
}
