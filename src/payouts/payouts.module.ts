import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { NipModule } from '../nip/nip.module';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

@Module({
  imports: [LedgerModule, NipModule],
  providers: [PayoutsService],
  controllers: [PayoutsController],
  exports: [PayoutsService],
})
export class PayoutsModule {}
