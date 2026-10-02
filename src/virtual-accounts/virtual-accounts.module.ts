import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { BankWebhookController, VirtualAccountsController } from './virtual-accounts.controller';
import { VirtualAccountsService } from './virtual-accounts.service';

@Module({
  imports: [LedgerModule],
  providers: [VirtualAccountsService],
  controllers: [VirtualAccountsController, BankWebhookController],
  exports: [VirtualAccountsService],
})
export class VirtualAccountsModule {}
