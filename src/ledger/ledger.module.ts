import { Controller, Get, Module, Param, ParseIntPipe, Query, UseGuards, DefaultValuePipe } from '@nestjs/common';
import { ApiKeyGuard } from '../common/api-key.guard';
import { ValidationError } from '../common/errors';
import { OWNER_TYPES, OwnerType } from './chart-of-accounts';
import { LedgerService } from './ledger.service';

@Controller('ledger')
@UseGuards(ApiKeyGuard)
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('wallets/:ownerType/:ownerId')
  async wallet(
    @Param('ownerType') ownerType: string,
    @Param('ownerId') ownerId: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    if (!OWNER_TYPES.includes(ownerType as OwnerType)) throw new ValidationError('Unknown owner type');
    const id = await this.ledger.findWallet(ownerType as OwnerType, ownerId);
    if (!id) return { ownerType, ownerId, balanceMinor: '0', entries: [] };
    return {
      ownerType,
      ownerId,
      balanceMinor: (await this.ledger.balanceOf(id)).toString(),
      entries: await this.ledger.statement(id, Math.min(limit, 500)),
    };
  }

  @Get('trial-balance')
  trialBalance() {
    return this.ledger.trialBalance();
  }
}

@Module({
  providers: [LedgerService],
  controllers: [LedgerController],
  exports: [LedgerService],
})
export class LedgerModule {}
