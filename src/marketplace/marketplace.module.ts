import { Body, Controller, Get, Module, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator';
import { Response } from 'express';
import { ApiKeyGuard } from '../common/api-key.guard';
import { LedgerModule } from '../ledger/ledger.module';
import { MarketplaceService, settlementView } from './marketplace.service';

export class SettleOrderDto {
  @IsString() @IsNotEmpty() @MaxLength(64) customerId: string;
  @IsString() @IsNotEmpty() @MaxLength(64) merchantId: string;
  @IsString() @IsNotEmpty() @MaxLength(64) riderId: string;
  @Type(() => Number) @IsInt() @Min(0) foodSubtotalMinor: number;
  @Type(() => Number) @IsInt() @Min(0) deliveryFeeMinor: number;
  @Type(() => Number) @IsInt() @Min(0) serviceFeeMinor: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(10_000) commissionBps: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(10_000) riderShareBps: number;
}

@Controller('orders')
@UseGuards(ApiKeyGuard)
export class MarketplaceController {
  constructor(private readonly service: MarketplaceService) {}

  /** The order id itself is the idempotency key for a split. */
  @Post(':orderId/settlement')
  async settle(
    @Param('orderId') orderId: string,
    @Body() dto: SettleOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { settlement, replayed } = await this.service.settle({
      orderId,
      customerId: dto.customerId,
      merchantId: dto.merchantId,
      riderId: dto.riderId,
      foodSubtotalMinor: BigInt(dto.foodSubtotalMinor),
      deliveryFeeMinor: BigInt(dto.deliveryFeeMinor),
      serviceFeeMinor: BigInt(dto.serviceFeeMinor),
      commissionBps: dto.commissionBps,
      riderShareBps: dto.riderShareBps,
    });
    res.status(replayed ? 200 : 201);
    return { ...settlementView(settlement), replayed };
  }

  @Get(':orderId/settlement')
  async get(@Param('orderId') orderId: string) {
    return settlementView(await this.service.getOrThrow(orderId));
  }
}

@Module({
  imports: [LedgerModule],
  providers: [MarketplaceService],
  controllers: [MarketplaceController],
})
export class MarketplaceModule {}
