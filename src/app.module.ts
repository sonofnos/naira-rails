import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as pg from 'pg';
import { DataSource } from 'typeorm';
import { migrateWithLock } from './migrations/migrate';
import { CardsModule } from './cards/cards.module';
import { HealthController } from './health/health.controller';
import { LedgerModule } from './ledger/ledger.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { InitSchema1759363200000 } from './migrations/1759363200000-InitSchema';
import { NipModule } from './nip/nip.module';
import { OffRampModule } from './offramp/offramp.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { RedisModule } from './redis/redis.module';
import { VirtualAccountsModule } from './virtual-accounts/virtual-accounts.module';

// node-postgres turns a DATE column into a JS Date at *local* midnight. On a
// machine in Lagos (UTC+1) business_date 2026-10-02 came back as
// 2026-10-01T23:00:00.000Z — a reconciliation run labelled with the previous
// day once serialised. A calendar date has no time zone: keep it a string.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        // Explicit driver: under ts-jest TypeORM's dynamic require of 'pg'
        // can resolve pg's dual ESM/CJS export map wrongly (seen in the
        // owner's booking-engine repo); passing it directly sidesteps that.
        driver: pg,
        host: config.get('DB_HOST', 'localhost'),
        port: Number(config.get('DB_PORT', 5441)),
        username: config.get('DB_USERNAME', 'naira'),
        password: config.get('DB_PASSWORD', 'naira'),
        database: config.get('DB_NAME', 'naira_rails'),
        entities: [],
        migrations: [InitSchema1759363200000],
        // Run by migrateWithLock() in dataSourceFactory below, not by TypeORM.
        migrationsRun: false,
        synchronize: false,
        extra: { max: Number(config.get('DB_POOL_MAX', 30)) },
      }),
      dataSourceFactory: async (options) => {
        const dataSource = await new DataSource(options!).initialize();
        await migrateWithLock(dataSource);
        return dataSource;
      },
    }),
    RedisModule,
    LedgerModule,
    NipModule,
    PayoutsModule,
    VirtualAccountsModule,
    MarketplaceModule,
    CardsModule,
    OffRampModule,
    ReconciliationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
