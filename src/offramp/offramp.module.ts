import { Body, Controller, Module, Post, Res, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { Response } from 'express';
import { ApiKeyGuard } from '../common/api-key.guard';
import { LedgerModule } from '../ledger/ledger.module';
import { OWNER_TYPES, OwnerType } from '../ledger/chart-of-accounts';
import { Asset, FakeOffRampClient, Network, OFFRAMP_CLIENT } from './offramp-client';
import { OffRampService, offRampView } from './offramp.service';

export class QuoteDto {
  @IsIn(['USDT', 'USDC']) asset: Asset;
  /** Token base units as an integer string (USDT has 6 decimals: "25000000" = 25 USDT). */
  @Matches(/^\d{1,30}$/) amountUnits: string;
}

export class OffRampCreditDto {
  @IsIn(['tron', 'ethereum', 'bsc', 'solana']) network: Network;
  @IsString() @IsNotEmpty() @MaxLength(100) txHash: string;
  @IsString() @IsNotEmpty() @MaxLength(100) quoteId: string;
  @IsIn(OWNER_TYPES) ownerType: OwnerType;
  @IsString() @IsNotEmpty() @MaxLength(64) ownerId: string;
}

@Controller('offramp')
@UseGuards(ApiKeyGuard)
export class OffRampController {
  constructor(private readonly service: OffRampService) {}

  @Post('quotes')
  async quote(@Body() dto: QuoteDto) {
    const q = await this.service.createQuote(dto.asset, BigInt(dto.amountUnits));
    return { ...q, amountUnits: q.amountUnits.toString(), rateKoboPerUnit: q.rateKoboPerUnit.toString() };
  }

  @Post('credits')
  async credit(@Body() dto: OffRampCreditDto, @Res({ passthrough: true }) res: Response) {
    const { credit, replayed } = await this.service.credit(dto);
    res.status(replayed ? 200 : 201);
    return { ...offRampView(credit), replayed };
  }
}

@Module({
  imports: [LedgerModule],
  providers: [OffRampService, { provide: OFFRAMP_CLIENT, useClass: FakeOffRampClient }],
  controllers: [OffRampController],
})
export class OffRampModule {}
